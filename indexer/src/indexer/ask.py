"""CLI `ask`: responde só com o contexto recuperado e cita as páginas (ARQUITETURA §7, tarefa F2.9).

Pipeline do degrau 3: pergunta -> (reescritas opcionais) -> k×4 Filhos -> até 24 Pais -> rerank -> 6 Pais ->
LLM, que só vê esses 6 trechos, cada um rotulado com a página original (física, a do pdf.js). A resposta
traz `[p. N]` (ou `[p. N-M]` quando o trecho cobre duas páginas); as citações são conferidas contra os trechos
entregues, e uma página que não esteja entre elas é marcada como inválida. Sem resposta no contexto, o modelo
deve dizer que não encontrou.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.ask "Qual foi o caixa líquido das atividades operacionais em 2025?"
    uv run python -m indexer.ask avaliar    # 5 perguntas de fumaça + negativos (eval/fumaca_f2_9.json)
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.busca import ALFA_PADRAO, MODOS
from indexer.embeddings import MODELO_CONSULTA, embutidor_llama
from indexer.grafo import conectar
from indexer.reescrita import MODELO_LLM, llm_llama, reescrever
from indexer.reranker import CANDIDATOS, TOP_PADRAO, recuperar_e_reranquear, reranqueador_llama

NAO_ENCONTREI = "Não encontrei essa informação nos trechos recuperados."
CITACAO = re.compile(r"\[\s*p\.?\s*([\d\s,;\-–a]+?)\s*\]", re.IGNORECASE)

SISTEMA = f"""Você responde perguntas sobre o Formulário de Referência de uma companhia brasileira usando \
SOMENTE os trechos fornecidos. Regras:
1. Use apenas informações presentes nos trechos; não use conhecimento externo nem estime valores.
2. Cada afirmação deve terminar com a citação da página do trecho de onde veio, exatamente no formato [p. N] \
(ou [p. N-M] se o rótulo do trecho for um intervalo), copiando o rótulo do trecho.
3. Se os trechos não contiverem a resposta, responda exatamente: {NAO_ENCONTREI}
4. Responda em português, de forma direta, com os números e as unidades como aparecem nos trechos."""

Chat = Callable[[list[dict]], str]


def chat_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 300) -> Chat:
    """Função mensagens -> texto, pelo `/v1/chat/completions`, sem raciocínio e com temperatura baixa."""

    def conversa(mensagens: list[dict]) -> str:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.2,
            "max_tokens": 700,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)["choices"][0]["message"]["content"].strip()

    return conversa


def rotulo_de_pagina(pai: dict) -> str:
    a, b = pai["pageStart"], pai["pageEnd"]
    return f"p. {a}" if a == b else f"p. {a}-{b}"


def formatar_contexto(pais: list[dict]) -> str:
    """Trechos rotulados, na ordem do rerank: `[p. 80] Seção: caminho` e o texto do Pai."""
    return "\n\n".join(f"[{rotulo_de_pagina(p)}] Seção: {p['caminho']}\n{p['text']}" for p in pais)


def paginas_de(texto: str) -> list[int]:
    """Páginas de um rótulo ('80', '156-157', '80, 91'): um intervalo conta só as pontas e o meio."""
    saida: list[int] = []
    for parte in re.split(r"[,;]| a ", texto):
        m = re.fullmatch(r"\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*", parte)
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        saida += list(range(a, max(a, b) + 1)) if b - a < 20 else [a, b]
    return saida


def extrair_citacoes(resposta: str) -> list[dict]:
    """Cada `[p. ...]` da resposta, com as páginas que ele nomeia."""
    return [
        {"texto": m.group(0), "paginas": paginas_de(m.group(1))}
        for m in CITACAO.finditer(resposta)
        if paginas_de(m.group(1))
    ]


def conferir_citacoes(citacoes: list[dict], pais: list[dict]) -> list[dict]:
    """Marca como válida a citação cujas páginas cabem numa mesma faixa de um trecho entregue ao LLM."""
    faixas = [(p["pageStart"], p["pageEnd"]) for p in pais]
    return [
        {**c, "valida": any(a <= min(c["paginas"]) and max(c["paginas"]) <= b for a, b in faixas)}
        for c in citacoes
    ]


def responder(
    driver: Any,
    pergunta: str,
    embute,
    notas,
    chat: Chat,
    modo: str = "hibrido-rrf",
    candidatos: int = CANDIDATOS,
    top: int = TOP_PADRAO,
    alfa: float = ALFA_PADRAO,
    banco: str = "neo4j",
    stepback: str | None = None,
    hyde: str | None = None,
) -> dict:
    """Recupera, reranqueia e responde. Devolve resposta, citações conferidas, fontes e latências."""
    r = recuperar_e_reranquear(
        driver, pergunta, embute, notas, modo, candidatos, top, alfa, banco, stepback=stepback, hyde=hyde
    )
    pais = r["pais"]
    t0 = time.perf_counter()
    if pais:
        mensagens = [
            {"role": "system", "content": SISTEMA},
            {"role": "user", "content": f"Trechos:\n\n{formatar_contexto(pais)}\n\nPergunta: {pergunta}"},
        ]
        resposta = chat(mensagens)
    else:
        resposta = NAO_ENCONTREI
    geracao_ms = (time.perf_counter() - t0) * 1000
    citacoes = conferir_citacoes(extrair_citacoes(resposta), pais)
    return {
        "pergunta": pergunta,
        "resposta": resposta,
        "sem_resposta": NAO_ENCONTREI.lower()[:30] in resposta.lower(),
        "citacoes": citacoes,
        "citacoes_invalidas": sum(1 for c in citacoes if not c["valida"]),
        "fontes": [
            {
                "paginas": rotulo_de_pagina(p),
                "caminho": p["caminho"],
                "nota_rerank": p["nota_rerank"],
                "posicao_antes_do_rerank": p["posicao_antes"],
            }
            for p in pais
        ],
        "latencia_ms": {**r["latencia_ms"], "geracao": round(geracao_ms, 1)},
    }


def pagina_correta(citacoes: list[dict], corretas: list[int]) -> bool:
    """Alguma citação nomeia (ou cobre, se for intervalo) uma das páginas corretas."""
    return any(any(p in corretas for p in c["paginas"]) for c in citacoes)


def avaliar(driver: Any, embute, notas, chat: Chat, casos: dict, **opcoes) -> dict:
    """Roda as perguntas de fumaça: página citada correta, fato presente, citações válidas; e os negativos."""
    linhas = []
    for c in casos["casos"]:
        r = responder(driver, c["pergunta"], embute, notas, chat, **opcoes)
        linhas.append(
            {
                "id": c["id"],
                "pagina_correta": pagina_correta(r["citacoes"], c["paginas_corretas"]),
                "fato_na_resposta": bool(re.search(c["fato"], r["resposta"], re.IGNORECASE)),
                "citacoes": [x["texto"] for x in r["citacoes"]],
                "citacoes_invalidas": r["citacoes_invalidas"],
                "paginas_dos_trechos": [f["paginas"] for f in r["fontes"]],
                "latencia_ms": r["latencia_ms"]["total"] + r["latencia_ms"]["geracao"],
                "resposta": r["resposta"],
            }
        )
    negativos = []
    for n in casos.get("negativos", []):
        r = responder(driver, n["pergunta"], embute, notas, chat, **opcoes)
        negativos.append({"id": n["id"], "recusou": r["sem_resposta"], "resposta": r["resposta"]})
    return {
        "casos": len(linhas),
        "pagina_correta": sum(x["pagina_correta"] for x in linhas),
        "fato_na_resposta": sum(x["fato_na_resposta"] for x in linhas),
        "citacoes_invalidas": sum(x["citacoes_invalidas"] for x in linhas),
        "negativos_recusados": f"{sum(x['recusou'] for x in negativos)} de {len(negativos)}",
        "detalhe": linhas,
        "negativos": negativos,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pergunta", help="a pergunta, ou 'avaliar' para rodar as perguntas de fumaça")
    ap.add_argument("--modo", choices=MODOS, default="hibrido-rrf")
    ap.add_argument("--k", type=int, default=CANDIDATOS, help="Pais enviados ao reranker")
    ap.add_argument("--top", type=int, default=TOP_PADRAO, help="Pais enviados ao LLM")
    ap.add_argument("--stepback", action="store_true")
    ap.add_argument("--hyde", action="store_true")
    ap.add_argument("--llm", default=MODELO_LLM)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--casos", type=Path, default=Path("../eval/fumaca_f2_9.json"))
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        notas = reranqueador_llama(a.swap)
        chat = chat_llama(a.swap, a.llm)
        if a.pergunta == "avaliar":
            casos = json.loads(a.casos.read_text(encoding="utf-8"))
            r = avaliar(
                driver, embute, notas, chat, casos, modo=a.modo, candidatos=a.k, top=a.top, banco=a.banco
            )
            print(json.dumps(r, ensure_ascii=False, indent=2))
            return
        rew = reescrever(a.pergunta, llm_llama(a.swap, a.llm), a.stepback, a.hyde)
        r = responder(
            driver, a.pergunta, embute, notas, chat, a.modo, a.k, a.top, banco=a.banco,
            stepback=rew["stepback"], hyde=rew["hyde"],
        )  # fmt: skip
        if a.json:
            print(json.dumps(r, ensure_ascii=False, indent=2))
            return
        print(r["resposta"])
        print("\nFontes (trechos entregues ao modelo, por relevância):")
        for f in r["fontes"]:
            print(f"  {f['paginas']:<12} {f['nota_rerank']:.3f}  {f['caminho'][:90]}")
        if r["citacoes_invalidas"]:
            print(f"\nATENÇÃO: {r['citacoes_invalidas']} citação(ões) fora dos trechos entregues.")
        print(f"\n{r['latencia_ms']}")
    finally:
        driver.close()


if __name__ == "__main__":
    main()
