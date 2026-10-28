"""I-3 · Pais e Filhos (ARQUITETURA §5, tarefa F2.1).

Parte dos elementos normalizados (F1.4) e da árvore de seções (F1.5):

* **Pai**: texto corrido de UMA seção (o corpo que vai do título até o próximo título, de qualquer nível),
  nunca atravessa seção; alvo de ~1.200 tokens e máximo de 1.600. Uma seção que cabe no máximo vira um Pai só;
  as maiores são divididas em partes de tamanho parecido, em fronteira de parágrafo.
* **Filho**: pedaço de um Pai, de ~320 tokens contando o prefixo com o caminho da seção, com 12% de
  sobreposição, em fronteira de frase. Cada Filho sabe suas páginas originais.
* Tabelas e figuras não entram no texto dos Pais (a tabela é um nó atômico, §5 I-3); saem numa lista à parte,
  com a seção e as notas associadas.

Tokens vêm do `/tokenize` do llama-server (via llama-swap, rota `/upstream/<modelo>/tokenize`): o Pai é
contado com o modelo que o consome (LLM de extração) e o Filho com o modelo de embedding, porque os
vocabulários diferem.

Uso (a partir de indexer/, com o llama-swap no ar):
    uv run python -m indexer.chunks ../data/parsed/ARQUIVO.normalizado.json \\
        ../data/parsed/ARQUIVO.secoes.json --saida ../data/parsed
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import urllib.request
from collections.abc import Callable
from pathlib import Path

ALVO_PAI = 1200
MAXIMO_PAI = 1600
ALVO_FILHO = 320
SOBREPOSICAO = 0.12
SEPARADOR_DE_CAMINHO = " › "
TIPOS_DE_TEXTO = {"text", "list_item", "caption", "footnote"}
TIPOS_FORA_DO_TEXTO = {"table", "picture"}
# fim de frase seguido de espaço e de maiúscula, abre-parênteses ou aspas; não corta "n.º", "p. 87"
FIM_DE_FRASE = re.compile(r"(?<=[.!?;:])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ(\"“])")

Contador = Callable[[str], int]


def contador_llama(base: str, modelo: str) -> Contador:
    """Contador de tokens pelo `/tokenize` de `modelo` (com cache); `base` é o endereço do llama-swap."""
    cache: dict[str, int] = {}

    def conta(texto: str) -> int:
        if texto not in cache:
            req = urllib.request.Request(
                f"{base}/upstream/{modelo}/tokenize",
                data=json.dumps({"content": texto}).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                cache[texto] = len(json.load(r)["tokens"])
        return cache[texto]

    return conta


def _id(*partes: object) -> str:
    return hashlib.sha1("|".join(str(p) for p in partes).encode("utf-8")).hexdigest()[:16]


def frases(texto: str) -> list[str]:
    return [f.strip() for f in FIM_DE_FRASE.split(texto) if f.strip()]


def _paginas(bloco: dict) -> list[int]:
    return bloco.get("paginas_originais") or bloco.get("paginas_recorte") or []


def blocos_por_secao(elementos: list[dict], arvore: list[dict]) -> tuple[dict[str, list[dict]], list[dict]]:
    """Blocos de texto do corpo direto de cada seção (até o próximo título de qualquer nível) e a lista de
    tabelas/figuras com a seção em que caíram."""
    inicios = sorted((n["indice_inicio"], n["id"]) for n in arvore)
    corpo: dict[str, list[dict]] = {n["id"]: [] for n in arvore}
    fora: list[dict] = []
    for pos, (inicio, sid) in enumerate(inicios):
        fim = inicios[pos + 1][0] if pos + 1 < len(inicios) else len(elementos)
        for e in elementos[inicio + 1 : fim]:
            if e["tipo"] in TIPOS_DE_TEXTO and (e.get("texto") or "").strip():
                corpo[sid].append(e)
            elif e["tipo"] in TIPOS_FORA_DO_TEXTO:
                fora.append(
                    {
                        "id": e["id"],
                        "tipo": e["tipo"],
                        "secao_id": sid,
                        "paginas": _paginas(e),
                        "notas": [n.get("texto") for n in e.get("notas", [])],
                    }
                )
    return corpo, fora


def _cortar_em_palavras(texto: str, maximo: int, conta: Contador) -> list[str]:
    """Corta `texto` em pedaços de até `maximo` tokens, em fronteira de palavra (garante o término)."""
    if conta(texto) <= maximo:
        return [texto]
    palavras = texto.split()
    por_pedaco = max(1, int(len(palavras) * 0.9 * maximo / conta(texto)))
    saida: list[str] = []
    i = 0
    while i < len(palavras):
        n = por_pedaco
        while n > 1 and conta(" ".join(palavras[i : i + n])) > maximo:
            n = max(1, int(n * 0.8))
        saida.append(" ".join(palavras[i : i + n]))
        i += n
    return saida


def agrupar_blocos(blocos: list[dict], conta: Contador, alvo: int = ALVO_PAI, maximo: int = MAXIMO_PAI):
    """Divide os blocos de uma seção em grupos de tamanho parecido, sem passar de `maximo` tokens.
    Devolve [(blocos, texto, tokens)]. Um bloco maior que o máximo é cortado por frases."""
    pecas: list[dict] = []
    for b in blocos:
        texto = b["texto"].strip()
        if conta(texto) <= maximo:
            pecas.append({**b, "texto": texto})
            continue
        for f in frases(texto):  # parágrafo gigante: frase a frase
            for corte in _cortar_em_palavras(f, maximo, conta):  # frase gigante: último recurso
                pecas.append({**b, "texto": corte})

    def junta(grupo: list[dict]) -> str:
        return "\n\n".join(p["texto"] for p in grupo)

    if not pecas:
        return []
    tamanhos = [conta(p["texto"]) for p in pecas]
    total = sum(tamanhos) + len(pecas) - 1  # ~1 token por separador; a contagem real vem depois
    n = math.ceil(total / alvo) if total > maximo else 1
    while True:
        limite = min(maximo, 1.15 * total / n)
        grupos: list[list[dict]] = [[]]
        soma = 0
        for p, t in zip(pecas, tamanhos, strict=True):
            if grupos[-1] and soma + t + 1 > limite:
                grupos.append([])
                soma = 0
            grupos[-1].append(p)
            soma += t + 1
        medidas = [conta(junta(g)) for g in grupos]
        if max(medidas) <= maximo:
            return [(g, junta(g), t) for g, t in zip(grupos, medidas, strict=True)]
        if n >= len(pecas):  # cada peça já cabe sozinha (garantido acima): nada mais a dividir
            return [([p], p["texto"], t) for p, t in zip(pecas, tamanhos, strict=True)]
        n += 1  # raro: a estimativa estourou o máximo; tenta com mais grupos


def _cauda_para_sobreposicao(pedacos: list[dict], tokens_alvo: int, conta: Contador) -> list[dict]:
    """Últimos pedaços (frases, ou o fim da última cortado em palavras) que somam ~`tokens_alvo` tokens."""
    escolhidos: list[dict] = []
    soma = 0
    for p in reversed(pedacos):
        t = conta(p["texto"])
        if soma + t <= tokens_alvo:
            escolhidos.insert(0, p)
            soma += t
            continue
        if not escolhidos:  # a última frase sozinha já passa do alvo: ficam só as últimas palavras
            palavras = p["texto"].split()
            n = max(1, int(len(palavras) * tokens_alvo / max(t, 1)))
            escolhidos.insert(0, {**p, "texto": "… " + " ".join(palavras[-n:])})
        break
    return escolhidos


def dividir_em_filhos(
    pai_blocos: list[dict],
    prefixo: str,
    conta: Contador,
    alvo: int = ALVO_FILHO,
    sobreposicao: float = SOBREPOSICAO,
) -> list[dict]:
    """Filhos de um Pai: janelas de frases (prefixo + corpo ≈ `alvo` tokens) com `sobreposicao` do corpo
    repetida no começo da janela seguinte. Devolve [{corpo, paginas, tokens_sobrepostos}]."""
    cabeca = prefixo + "\n" if prefixo else ""
    orcamento = max(40, alvo - conta(cabeca))
    sobra = max(1, round(orcamento * sobreposicao))

    pedacos: list[dict] = []
    for b in pai_blocos:
        for f in frases(b["texto"]):
            pedacos.append({"texto": f, "paginas": _paginas(b)})

    def junta(ps: list[dict]) -> str:
        return " ".join(p["texto"] for p in ps)

    filhos: list[dict] = []
    atual: list[dict] = []
    herdados = 0  # pedaços do começo de `atual` que vieram da sobreposição
    for p in pedacos:
        if atual and len(atual) > herdados and conta(junta(atual + [p])) > orcamento:
            filhos.append({"pedacos": atual, "sobrepostos": herdados})
            cauda = _cauda_para_sobreposicao(atual, sobra, conta)
            atual, herdados = list(cauda), len(cauda)
        atual.append(p)
    if len(atual) > herdados:
        filhos.append({"pedacos": atual, "sobrepostos": herdados})

    saida = []
    for f in filhos:
        corpo = junta(f["pedacos"])
        paginas = sorted({pg for p in f["pedacos"] for pg in p["paginas"]})
        saida.append(
            {
                "corpo": corpo,
                "paginas": paginas,
                "tokens_sobrepostos": conta(junta(f["pedacos"][: f["sobrepostos"]]))
                if f["sobrepostos"]
                else 0,
            }
        )
    return saida


def segmentar(
    elementos: list[dict],
    arvore: list[dict],
    doc_id: str,
    conta_pai: Contador,
    conta_filho: Contador,
    alvo_pai: int = ALVO_PAI,
    maximo_pai: int = MAXIMO_PAI,
    alvo_filho: int = ALVO_FILHO,
    sobreposicao: float = SOBREPOSICAO,
) -> dict:
    corpo, fora = blocos_por_secao(elementos, arvore)
    pais: list[dict] = []
    filhos: list[dict] = []
    por_id = {n["id"]: n for n in arvore}

    for no in arvore:
        grupos = agrupar_blocos(corpo[no["id"]], conta_pai, alvo_pai, maximo_pai)
        prefixo = SEPARADOR_DE_CAMINHO.join(no["caminho"])
        for ordem, (blocos, texto, tokens) in enumerate(grupos, start=1):
            paginas = sorted({p for b in blocos for p in _paginas(b)})
            pai_id = _id(doc_id, "pai", no["id"], ordem, texto)
            pais.append(
                {
                    "id": pai_id,
                    "secao_id": no["id"],
                    "ordem": ordem,
                    "caminho": no["caminho"],
                    "texto": texto,
                    "tokens": tokens,
                    "pagina_inicio": paginas[0] if paginas else None,
                    "pagina_fim": paginas[-1] if paginas else None,
                    "elementos": [b["id"] for b in blocos],
                }
            )
            for n, f in enumerate(
                dividir_em_filhos(blocos, prefixo, conta_filho, alvo_filho, sobreposicao), start=1
            ):
                texto_filho = f"{prefixo}\n{f['corpo']}"
                filhos.append(
                    {
                        "id": _id(doc_id, "filho", pai_id, n, f["corpo"]),
                        "pai_id": pai_id,
                        "ordem": n,
                        "prefixo": prefixo,
                        "corpo": f["corpo"],
                        "texto": texto_filho,
                        "tokens": conta_filho(texto_filho),
                        "tokens_sobrepostos": f["tokens_sobrepostos"],
                        "pagina_inicio": f["paginas"][0] if f["paginas"] else pais[-1]["pagina_inicio"],
                        "pagina_fim": f["paginas"][-1] if f["paginas"] else pais[-1]["pagina_fim"],
                    }
                )
    return {
        "pais": pais,
        "filhos": filhos,
        "fora_do_texto": fora,
        "secoes_sem_texto": [n["id"] for n in arvore if not corpo[n["id"]]],
        "estatisticas": estatisticas(pais, filhos, fora, arvore, por_id, alvo_filho),
    }


def _resumo(valores: list[int]) -> dict:
    if not valores:
        return {}
    v = sorted(valores)
    return {
        "min": v[0],
        "p50": v[len(v) // 2],
        "p90": v[int(len(v) * 0.9)],
        "max": v[-1],
        "media": round(sum(v) / len(v), 1),
    }


def estatisticas(pais, filhos, fora, arvore, por_id, alvo_filho) -> dict:
    sobrepostos = [f["tokens_sobrepostos"] / f["tokens"] for f in filhos if f["tokens_sobrepostos"]]
    filhos_por_pai: dict[str, int] = {}
    for f in filhos:
        filhos_por_pai[f["pai_id"]] = filhos_por_pai.get(f["pai_id"], 0) + 1
    ids_pais = {p["id"] for p in pais}
    return {
        "secoes": len(arvore),
        "secoes_com_pai": len({p["secao_id"] for p in pais}),
        "pais": len(pais),
        "filhos": len(filhos),
        "tabelas_fora": sum(1 for x in fora if x["tipo"] == "table"),
        "figuras_fora": sum(1 for x in fora if x["tipo"] == "picture"),
        "tokens_pai": _resumo([p["tokens"] for p in pais]),
        "tokens_filho": _resumo([f["tokens"] for f in filhos]),
        "pais_acima_de_1600": sum(1 for p in pais if p["tokens"] > MAXIMO_PAI),
        "pais_abaixo_de_200": sum(1 for p in pais if p["tokens"] < 200),
        "filhos_acima_de_alvo_mais_25pct": sum(1 for f in filhos if f["tokens"] > alvo_filho * 1.25),
        "sobreposicao_media_dos_filhos_com_sobreposicao": (
            round(sum(sobrepostos) / len(sobrepostos), 4) if sobrepostos else None
        ),
        "filhos_orfaos": sum(1 for f in filhos if f["pai_id"] not in ids_pais),
        "pais_sem_filho": sum(1 for p in pais if p["id"] not in filhos_por_pai),
        "pais_que_cruzam_secao": sum(1 for p in pais if p["secao_id"] not in por_id),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("normalizado", type=Path)
    ap.add_argument("secoes", type=Path)
    ap.add_argument("--saida", type=Path, required=True)
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--modelo-pai", default="qwen36-35b-a3b")
    ap.add_argument("--modelo-filho", default="qwen3-embed-0.6b")
    a = ap.parse_args()

    elementos = json.loads(a.normalizado.read_text(encoding="utf-8"))["elementos"]
    arvore = json.loads(a.secoes.read_text(encoding="utf-8"))["arvore"]
    nome = a.normalizado.name.removesuffix(".normalizado.json")
    resultado = segmentar(
        elementos,
        arvore,
        nome,
        contador_llama(a.swap, a.modelo_pai),
        contador_llama(a.swap, a.modelo_filho),
    )
    resultado["parametros"] = {
        "alvo_pai": ALVO_PAI,
        "maximo_pai": MAXIMO_PAI,
        "alvo_filho": ALVO_FILHO,
        "sobreposicao": SOBREPOSICAO,
        "tokenizador_pai": a.modelo_pai,
        "tokenizador_filho": a.modelo_filho,
    }
    a.saida.mkdir(parents=True, exist_ok=True)
    (a.saida / f"{nome}.chunks.json").write_text(
        json.dumps(resultado, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(json.dumps(resultado["estatisticas"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
