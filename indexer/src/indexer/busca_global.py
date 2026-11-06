"""Busca global *map-reduce* sobre os relatórios de comunidade: a ferramenta `panorama` (ARQUITETURA §7.2 e
cap. 7 do livro, tarefa F6.2).

Pergunta -> comunidades do nível escolhido com `rating` >= limiar, as mais parecidas com a pergunta primeiro
(`community_vec`) -> **mapa**: o Qwen3.6 lê lotes de relatórios e devolve pontos curtos com nota de 0 a 10
para a pergunta -> os melhores pontos, sem repetição, até um teto de itens e de tokens -> **reduce**: o LLM
escreve a síntese só com esses pontos. A síntese é opcional (o redator da F7.5 também pode ler os pontos).

Tempo (aceite: ≤ 90 s no perfil `consultar`, com progresso por comunidade): o custo é a geração (~35 tok/s),
então os lotes saem com poucos pontos, rodam em paralelo (2 slots) e há um orçamento de tempo: passado o
orçamento, os lotes que ainda não começaram são pulados (contados em `omitido`) e o reduce roda com o que
chegou. `progresso(evento)` recebe `selecao`, um `mapa` por lote concluído (com `comunidades_feitas` de
`comunidades_total`), `sintese` e `fim`.

Os pontos vêm de relatórios de comunidade, que são sínteses: não têm página do documento (`paginas` = "").

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.busca_global buscar "Quais os principais fatores de risco?"
    uv run python -m indexer.busca_global medir --nome f62 [--juiz]
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from indexer.embeddings import MODELO_CONSULTA, Embutidor, embutidor_llama
from indexer.extrair import MODELO_LLM
from indexer.grafo import conectar

LIMITES_PADRAO: dict[str, int] = {
    "nivel": 1,  # 0 a 3; os níveis 2 e 3 do documento inteiro são quase iguais (130 e 129 comunidades)
    "rating": 5,  # §5: limiar de rating da busca global, como no cap. 7
    "candidatas": 16,  # comunidades enviadas ao mapa, as mais parecidas com a pergunta
    "lote_chars": 14000,  # ≈ 4 mil tokens de relatórios por chamada do mapa
    "max_por_relatorio": 4500,
    "max_pontos_por_lote": 6,
    "paralelismo": 2,  # slots do perfil `consultar` (-np 2)
    "pontos": 12,  # pontos que seguem para o reduce e para o redator
    "nota_minima": 1,  # 0 = irrelevante
    "tokens": 5000,
    "orcamento_s": 45,  # depois disso, lotes que não começaram são pulados (um em curso leva até ~25 s)
}
VARREDURA = 1000  # vizinhos lidos no community_vec antes de filtrar por nível e rating
TENTATIVAS_POR_LOTE = 2
CARACTERES_POR_TOKEN = 3

Gerador = Callable[[list[dict], dict], dict]
Redator = Callable[[list[dict]], str]

SISTEMA_MAPA = (
    "Você ajuda a responder perguntas sobre o Formulário de Referência de uma companhia brasileira. "
    "Recebe relatórios de comunidades de um grafo de conhecimento, etiquetados C1, C2..., e uma pergunta. "
    "Para cada relatório que traga informação útil à pergunta, escreva pontos curtos (uma frase, até 30 "
    "palavras) usando SOMENTE o relatório: não invente, não complete com conhecimento externo, mantenha "
    "números, nomes e unidades como estão. Dê a cada ponto uma nota de 0 a 10 para a utilidade dele na "
    "resposta (0 = irrelevante). Relatório sem nada útil à pergunta: não escreva pontos para ele. "
    "Responda em português, em JSON."
)

SISTEMA_REDUCE = (
    "Responda à pergunta em português usando SOMENTE os pontos fornecidos; cada um vem de um relatório de "
    "comunidade de um grafo de conhecimento e tem uma nota de utilidade. Organize e agrupe os pontos, sem "
    "acrescentar nada que não esteja neles. Se os pontos não bastarem para responder, diga o que faltou. "
    "Seja conciso: no máximo 150 palavras. Os pontos não têm página do documento, então não cite páginas."
)


def escolher_comunidades(comunidades: list[dict], nivel: int | None, rating: float, k: int) -> list[dict]:
    """Comunidades do nível (qualquer, se `None`) com rating >= limiar, as mais parecidas antes, até `k`."""
    boas = [
        c for c in comunidades if (nivel is None or c["level"] == nivel) and (c.get("rating") or 0) >= rating
    ]
    return sorted(boas, key=lambda c: (-c["score"], c["id"]))[:k]


def texto_do_relatorio(c: dict) -> str:
    """Título, resumo e achados do relatório (o JSON de `report`); sem JSON válido, só título e resumo."""
    try:
        r = json.loads(c["report"])
        achados = [f"- {a['summary']} {a['explanation']}" for a in r.get("findings", [])]
        return "\n".join([r["title"], r["summary"], *achados])
    except (TypeError, ValueError, KeyError):
        return "\n".join(p for p in (c.get("title"), c.get("summary")) if p)


def montar_lotes(comunidades: list[dict], lote_chars: int, max_por_relatorio: int) -> list[list[dict]]:
    """Agrupa as comunidades, na ordem, em lotes de até `lote_chars` caracteres de relatório. Cada relatório
    conta no máximo `max_por_relatorio`; o gigante entra sozinho (e é cortado ao montar o pedido)."""
    lotes: list[list[dict]] = []
    atual: list[dict] = []
    gasto = 0
    for c in comunidades:
        tamanho = min(len(texto_do_relatorio(c)), max_por_relatorio)
        if atual and gasto + tamanho > lote_chars:
            lotes.append(atual)
            atual, gasto = [], 0
        atual.append(c)
        gasto += tamanho
    if atual:
        lotes.append(atual)
    return lotes


def montar_pedido(pergunta: str, lote: list[dict], lim: dict) -> tuple[list[dict], dict[str, dict], dict]:
    """Mensagens do mapa, a tabela etiqueta -> comunidade e o esquema JSON (a etiqueta é um enum do lote)."""
    etiquetas = {f"C{i}": c for i, c in enumerate(lote, start=1)}
    blocos = [
        f"[{e}] (nível {c['level']}) {texto_do_relatorio(c)[: lim['max_por_relatorio']]}"
        for e, c in etiquetas.items()
    ]
    pedido = f"Pergunta: {pergunta}\n\nRelatórios:\n\n" + "\n\n".join(blocos)
    esquema = {
        "type": "object",
        "properties": {
            "pontos": {
                "type": "array",
                "maxItems": min(lim["max_pontos_por_lote"], 3 * len(lote)),
                "items": {
                    "type": "object",
                    "properties": {
                        "comunidade": {"type": "string", "enum": list(etiquetas)},
                        "ponto": {"type": "string"},
                        "nota": {"type": "integer", "minimum": 0, "maximum": 10},
                    },
                    "required": ["comunidade", "ponto", "nota"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["pontos"],
        "additionalProperties": False,
    }
    mensagens = [{"role": "system", "content": SISTEMA_MAPA}, {"role": "user", "content": pedido}]
    return mensagens, etiquetas, esquema


def validar_pontos(resposta: Any, etiquetas: dict[str, dict]) -> tuple[list[dict], int]:
    """Pontos válidos da resposta do mapa e quantos foram descartados (etiqueta inexistente, texto vazio,
    nota que não é inteiro de 0 a 10). Resposta que não é `{"pontos": [...]}` é `ValueError`, e o lote é
    pedido de novo."""
    if not isinstance(resposta, dict) or not isinstance(resposta.get("pontos"), list):
        raise ValueError("resposta do mapa fora do esquema")
    validos, descartados = [], 0
    for p in resposta["pontos"]:
        c = etiquetas.get(p.get("comunidade")) if isinstance(p, dict) else None
        texto = p.get("ponto") if isinstance(p, dict) else None
        nota = p.get("nota") if isinstance(p, dict) else None
        inteira = isinstance(nota, (int, float)) and not isinstance(nota, bool) and nota == int(nota)
        if c is None or not isinstance(texto, str) or not texto.strip() or not inteira or not 0 <= nota <= 10:
            descartados += 1
            continue
        validos.append(
            {
                "comunidade": c["id"],
                "titulo": c["title"],
                "nivel": c["level"],
                "texto": texto.strip(),
                "nota": int(nota),
                "similaridade": c.get("score", 0.0),
            }
        )
    return validos, descartados


def _chave_do_texto(texto: str) -> str:
    base = unicodedata.normalize("NFD", texto.lower())
    sem_acento = "".join(ch for ch in base if unicodedata.category(ch) != "Mn")
    return re.sub(r"\W+", " ", sem_acento).strip()


def selecionar_pontos(pontos: list[dict], nota_minima: int, k: int, tokens: int) -> tuple[list[dict], dict]:
    """Tira os pontos abaixo da nota, os repetidos (fica o de maior nota) e o que passa do teto de itens ou
    do orçamento de tokens; ordena por nota e depois por similaridade da comunidade, sem depender da ordem
    de chegada. O melhor ponto entra mesmo que estoure o orçamento."""
    omitido = {"abaixo_da_nota": 0, "duplicados": 0, "acima_do_teto": 0, "por_orcamento": 0}
    boas = []
    for p in pontos:
        if p["nota"] < nota_minima:
            omitido["abaixo_da_nota"] += 1
        else:
            boas.append(p)
    melhor: dict[str, dict] = {}
    for p in sorted(boas, key=lambda p: (-p["nota"], -p["similaridade"], p["comunidade"], p["texto"])):
        chave = _chave_do_texto(p["texto"])
        if chave in melhor:
            omitido["duplicados"] += 1
        else:
            melhor[chave] = p
    ordenados = list(melhor.values())
    omitido["acima_do_teto"] = max(0, len(ordenados) - k)
    escolhidos, gasto = [], 0
    for p in ordenados[:k]:
        custo = max(1, len(p["texto"]) // CARACTERES_POR_TOKEN)
        if escolhidos and gasto + custo > tokens:
            omitido["por_orcamento"] += 1
            continue
        escolhidos.append(p)
        gasto += custo
    return escolhidos, omitido


CONSULTA = (
    "CALL db.index.vector.queryNodes('community_vec', $k, $v) YIELD node, score "
    "WHERE ($nivel IS NULL OR node.level = $nivel) AND node.rating >= $rating "
    "RETURN node.id AS id, node.title AS title, node.summary AS summary, node.report AS report, "
    "node.level AS level, node.rating AS rating, score ORDER BY score DESC LIMIT $limite"
)


def _vazio(motivo: str | None = None) -> dict:
    return {
        "pontos": [],
        "sintese": None,
        "reduce": "sem_pontos",
        "nivel": None,
        "comunidades": {"consideradas": 0, "lotes": 0, "lotes_falhos": 0},
        "omitido": {},
        "truncado_por_tempo": False,
        "erro": motivo,
        "latencia_ms": {"total": 0.0},
    }


def buscar(
    driver: Any,
    pergunta: str,
    embute_consulta: Embutidor,
    gera_mapa: Gerador,
    gera_reduce: Redator | None = None,
    limites: dict | None = None,
    progresso: Callable[[dict], None] | None = None,
    banco: str = "neo4j",
    agora: Callable[[], float] = time.monotonic,
) -> dict:
    """A busca global inteira. Ver o docstring do módulo. `gera_mapa(mensagens, esquema)` devolve o JSON já
    lido; `gera_reduce(mensagens)` devolve o texto. Uma falha de lote, do reduce ou do `progresso` não derruba
    a busca: vira contagem (`comunidades.lotes_falhos`, `reduce: falhou`) ou é ignorada."""
    lim = {**LIMITES_PADRAO, **(limites or {})}
    if not pergunta.strip():
        return _vazio()
    t0, inicio = time.perf_counter(), agora()

    def avisa(evento: dict) -> None:
        if progresso:
            try:
                progresso(evento)
            except Exception:  # um cliente que caiu não pode derrubar a busca
                pass

    t = time.perf_counter()
    (vetor,) = embute_consulta([pergunta])
    t_embedding = time.perf_counter() - t
    registros, _, _ = driver.execute_query(
        CONSULTA,
        {
            "k": VARREDURA,
            "v": vetor,
            "nivel": lim["nivel"],
            "rating": lim["rating"],
            "limite": lim["candidatas"],
        },
        database_=banco,
    )
    escolhidas = escolher_comunidades(
        [dict(r) for r in registros], lim["nivel"], lim["rating"], lim["candidatas"]
    )
    total = len(escolhidas)
    avisa({"fase": "selecao", "comunidades_total": total, "nivel": lim["nivel"]})
    if not escolhidas:
        return {**_vazio(), "nivel": lim["nivel"]}

    lotes = montar_lotes(escolhidas, lim["lote_chars"], lim["max_por_relatorio"])
    fim_do_prazo = inicio + lim["orcamento_s"]

    def um_lote(lote: list[dict]) -> dict:
        if agora() > fim_do_prazo:
            return {"lote": lote, "status": "tempo", "pontos": [], "descartados": 0}
        mensagens, etiquetas, esquema = montar_pedido(pergunta, lote, lim)
        erro = ""
        for _ in range(TENTATIVAS_POR_LOTE):
            try:
                pontos, descartados = validar_pontos(gera_mapa(mensagens, esquema), etiquetas)
                return {"lote": lote, "status": "ok", "pontos": pontos, "descartados": descartados}
            except Exception as e:  # HTTP, JSON e esquema: tenta de novo uma vez
                erro = f"{type(e).__name__}: {e}"[:200]
        return {"lote": lote, "status": "falhou", "pontos": [], "descartados": 0, "erro": erro}

    t_mapa = time.perf_counter()
    todos: list[dict] = []
    feitas = lotes_feitos = lotes_falhos = por_tempo = invalidos = 0
    with ThreadPoolExecutor(max_workers=max(1, lim["paralelismo"])) as pool:
        futuros = [pool.submit(um_lote, lote) for lote in lotes]
        for f in as_completed(futuros):
            r = f.result()
            feitas += len(r["lote"])
            lotes_feitos += 1
            invalidos += r["descartados"]
            if r["status"] == "falhou":
                lotes_falhos += 1
            elif r["status"] == "tempo":
                por_tempo += len(r["lote"])
            todos += r["pontos"]
            avisa(
                {
                    "fase": "mapa",
                    "comunidades_feitas": feitas,
                    "comunidades_total": total,
                    "lotes_feitos": lotes_feitos,
                    "lotes_total": len(lotes),
                    "status": r["status"],
                    "titulos": [c["title"] for c in r["lote"]],
                    "pontos": len(r["pontos"]),
                }
            )
    ms_mapa = round((time.perf_counter() - t_mapa) * 1000, 1)

    escolhidos, omitido = selecionar_pontos(todos, lim["nota_minima"], lim["pontos"], lim["tokens"])
    evidencias = [
        {
            "id": f"{p['comunidade']}#{i}",
            "tipo": "ponto",
            "paginas": "",
            "caminho": f"Comunidade (nível {p['nivel']}): {p['titulo']}",
            "texto": p["texto"],
            "score": p["nota"],
        }
        for i, p in enumerate(escolhidos, start=1)
    ]
    erro = "todos os lotes do mapa falharam" if lotes_falhos == len(lotes) else None

    sintese, reduce, ms_reduce = None, "desligado", 0.0
    if not evidencias:
        reduce = "sem_pontos"
    elif gera_reduce:
        avisa({"fase": "sintese", "pontos": len(evidencias)})
        t_reduce = time.perf_counter()
        lista = "\n".join(f"- ({p['nota']}/10) {p['texto']}" for p in escolhidos)
        try:
            sintese = gera_reduce(
                [
                    {"role": "system", "content": SISTEMA_REDUCE},
                    {"role": "user", "content": f"Pergunta: {pergunta}\n\nPontos:\n{lista}"},
                ]
            )
            reduce = "ok"
        except Exception:  # sem a síntese ainda há os pontos
            reduce = "falhou"
        ms_reduce = round((time.perf_counter() - t_reduce) * 1000, 1)

    avisa({"fase": "fim", "pontos": len(evidencias)})
    return {
        "pontos": evidencias,
        "sintese": sintese,
        "reduce": reduce,
        "nivel": lim["nivel"],
        "comunidades": {"consideradas": total, "lotes": len(lotes), "lotes_falhos": lotes_falhos},
        "omitido": {
            "comunidades_por_tempo": por_tempo,
            "pontos_invalidos": invalidos,
            **{f"pontos_{k}": v for k, v in omitido.items()},
        },
        "truncado_por_tempo": por_tempo > 0,
        "erro": erro,
        "latencia_ms": {
            "total": round((time.perf_counter() - t0) * 1000, 1),
            "embedding_da_consulta": round(t_embedding * 1000, 1),
            "mapa": ms_mapa,
            "reduce": ms_reduce,
        },
    }


def gerador_mapa_llama(
    base: str, modelo: str = MODELO_LLM, max_tokens: int = 900, timeout: int = 300
) -> Gerador:
    """Função (mensagens, esquema) -> JSON, pelo `/v1/chat/completions`, sem raciocínio e com a saída por
    gramática. Resposta que não é JSON vira `None` (o lote é pedido de novo na validação)."""

    def gera(mensagens: list[dict], esquema: dict) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "pontos", "strict": True, "schema": esquema},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            dados = json.load(r)
        try:
            return json.loads(dados["choices"][0]["message"]["content"])
        except (json.JSONDecodeError, KeyError):
            return None  # type: ignore[return-value]

    return gera


def selecionar_casos_globais(casos: list[dict]) -> list[dict]:
    """As perguntas temáticas/globais do golden set (rota `panorama`)."""
    return [c for c in casos if c.get("rota_esperada") == "panorama"]


def sistema_busca_global(
    driver: Any,
    embute: Embutidor,
    gera_mapa: Gerador,
    gera_reduce: Redator | None = None,
    limites: dict | None = None,
    banco: str = "neo4j",
):
    """O "sistema" do avaliador (F3): a recuperação e, se houver, a síntese; o contexto são os pontos."""

    def responde(caso: dict) -> dict:
        r = buscar(driver, caso["pergunta"], embute, gera_mapa, gera_reduce, limites, banco=banco)
        return {
            "resposta": r["sintese"] or "",
            "citacoes": [],
            "contexto": [
                {"paginas": p["paginas"], "caminho": p["caminho"], "texto": p["texto"]} for p in r["pontos"]
            ],
            "comunidades": r["comunidades"],
            "omitido": r["omitido"],
            "truncado_por_tempo": r["truncado_por_tempo"],
            "erro_da_busca": r["erro"],
            "latencia_ms": r["latencia_ms"],
        }

    return responde


def medir(
    driver: Any,
    embute: Embutidor,
    casos: list[dict],
    pasta: Path,
    gera_mapa: Gerador,
    gera_reduce: Redator | None,
    limites: dict | None = None,
    juiz: Any = None,
    banco: str = "neo4j",
) -> dict:
    """Roda a busca global nos casos: tempo de cada pergunta, recall por regex dos `pontos_chave` não existe
    (são temáticas), então a leitura é o recall de contexto do juiz local (F3.2) quando há `juiz`."""
    import statistics

    from indexer.avaliar import gerar, julgar

    sistema = sistema_busca_global(driver, embute, gera_mapa, gera_reduce, limites, banco)
    respostas = gerar(casos, sistema, pasta)
    notas = julgar(casos, respostas, juiz, pasta, ("recall_contexto",)) if juiz else []
    juizo = {j["id"]: j["nota"] for j in notas}
    por_pergunta = {
        c["id"]: {
            "segundos": r["segundos"],
            "recall_juiz": juizo.get(c["id"]),
            "pontos": len(r["contexto"]),
            "truncado_por_tempo": r.get("truncado_por_tempo"),
            "erro": r["erro"] or r.get("erro_da_busca"),
        }
        for c, r in zip(casos, respostas, strict=True)
    }
    segundos = sorted(x["segundos"] for x in por_pergunta.values())
    notas_validas = [x["recall_juiz"] for x in por_pergunta.values() if x["recall_juiz"] is not None]
    return {
        "perguntas": len(casos),
        "limites": {**LIMITES_PADRAO, **(limites or {})},
        "recall_juiz": {
            "n": len(notas_validas),
            "media": round(statistics.mean(notas_validas), 4) if notas_validas else None,
        },
        "segundos_p50": statistics.median(segundos),
        "segundos_max": segundos[-1],
        "dentro_de_90_s": segundos[-1] <= 90,
        "por_pergunta": por_pergunta,
    }


def main() -> None:  # pragma: no cover - orquestração de CLI; a lógica tem testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["buscar", "medir"])
    ap.add_argument("consulta", nargs="?")
    ap.add_argument("--nome", help="medir: nome da execução (pasta em data/avaliacao)")
    ap.add_argument("--golden", type=Path, default=Path("../eval/golden.csv"))
    ap.add_argument("--juiz", action="store_true", help="medir: também o recall de contexto do juiz local")
    ap.add_argument("--sem-reduce", action="store_true", help="só os pontos, sem a síntese")
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    for chave, valor in LIMITES_PADRAO.items():
        ap.add_argument(f"--{chave.replace('_', '-')}", dest=chave, type=int, default=valor)
    a = ap.parse_args()
    limites = {k: getattr(a, k) for k in LIMITES_PADRAO}
    driver = conectar(a.raiz)
    try:
        from indexer.ask import chat_llama

        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        gera_mapa = gerador_mapa_llama(a.swap)
        gera_reduce = None if a.sem_reduce else chat_llama(a.swap)
        if a.acao == "buscar":
            if not a.consulta:
                ap.error("buscar precisa da consulta")

            def mostra(e: dict) -> None:
                print(json.dumps(e, ensure_ascii=False), flush=True)

            r = buscar(driver, a.consulta, embute, gera_mapa, gera_reduce, limites, mostra, a.banco)
            print(json.dumps(r, ensure_ascii=False, indent=2))
            return
        from indexer.avaliar import juiz_llama, ler_golden

        if not a.nome:
            ap.error("medir precisa de --nome")
        casos = selecionar_casos_globais(ler_golden(a.golden))
        pasta = a.raiz / "data" / "avaliacao" / a.nome
        juiz = juiz_llama(a.swap) if a.juiz else None
        r = medir(driver, embute, casos, pasta, gera_mapa, gera_reduce, limites, juiz, a.banco)
        destino = a.raiz / "eval" / "resultados" / f"{a.nome}.json"
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps({k: v for k, v in r.items() if k != "por_pergunta"}, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":  # pragma: no cover
    main()
