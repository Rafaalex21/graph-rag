"""Métricas mecânicas da avaliação, sem juiz (ARQUITETURA §13.2, tarefa F3.3).

* **page recall@k**: das páginas físicas do gabarito (`paginas`), quantas aparecem nos `k` primeiros trechos
  entregues ao LLM (na ordem do rerank); `acerto@k` vale 1 se ao menos uma aparece;
* **página citada**: a resposta cita (`[p. N]`) ao menos uma página do gabarito;
* **acerto numérico**: nas perguntas de gabarito `valor`, a resposta traz um número que bate com o gabarito
  dentro de 0,5% (em módulo; "milhões", "bilhões" e "mil" são convertidos antes de comparar);
* **latência**: p50 e p95 do tempo de ponta a ponta do `ask` (busca, rerank e geração), em segundos.

Tudo é calculado a partir de `respostas.jsonl`: roda sem LLM e pode ser refeito sobre uma execução antiga.
"""

from __future__ import annotations

import math
import re
import statistics
from collections import defaultdict

from indexer.ask import extrair_citacoes, paginas_de

TOLERANCIA = 0.005
KS = (1, 3, 6)

_ESCALAS = {"mil": 1e3, "milhão": 1e6, "milhões": 1e6, "bilhão": 1e9, "bilhões": 1e9, "trilhão": 1e12,
            "trilhões": 1e12}  # fmt: skip
_PALAVRAS = {"dois": 2, "duas": 2, "três": 3, "tres": 3, "quatro": 4, "cinco": 5, "seis": 6, "sete": 7,
             "oito": 8, "nove": 9, "dez": 10}  # fmt: skip
_NUMERO = re.compile(
    r"(?<![\w.,])(?P<n>\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?:\s*(?P<e>milh(?:ão|ões)|bilh(?:ão|ões)"
    r"|trilh(?:ão|ões)|mil)\b)?|\b(?P<p>" + "|".join(_PALAVRAS) + r")\b",
    re.IGNORECASE,
)
_CITACAO = re.compile(r"\[p\.[^\]]*\]")


def paginas_do_gabarito(caso: dict) -> list[int]:
    return [int(p) for p in caso["paginas"].split("|") if p.strip()]


def paginas_dos_trechos(contexto: list[dict]) -> list[set[int]]:
    """Páginas de cada trecho entregue, na ordem (o rótulo é `p. 80` ou `p. 156-157`)."""
    return [set(paginas_de(c["paginas"].removeprefix("p.").strip())) for c in contexto]


def page_recall(caso: dict, contexto: list[dict], ks=KS) -> dict[int, dict]:
    """Por k: recall (páginas do gabarito cobertas / total) e acerto (alguma coberta)."""
    gold = set(paginas_do_gabarito(caso))
    por_trecho = paginas_dos_trechos(contexto)
    saida = {}
    for k in ks:
        vistas = set().union(*por_trecho[:k]) if por_trecho[:k] else set()
        achadas = gold & vistas
        saida[k] = {"recall": len(achadas) / len(gold), "acerto": 1.0 if achadas else 0.0}
    return saida


def pagina_citada(caso: dict, resposta: str) -> bool:
    gold = set(paginas_do_gabarito(caso))
    return any(gold & set(c["paginas"]) for c in extrair_citacoes(resposta))


def numeros_da_resposta(resposta: str) -> list[tuple[float, float, bool]]:
    """(como escrito, com a escala aplicada, tinha escala) de cada número da resposta, sem as citações."""
    saida = []
    for m in _NUMERO.finditer(_CITACAO.sub(" ", resposta)):
        if m.group("p"):
            n = float(_PALAVRAS[m.group("p").lower()])
            saida.append((n, n, False))
            continue
        n = float(m.group("n").replace(".", "").replace(",", "."))
        escala = _ESCALAS[m.group("e").lower()] if m.group("e") else 1.0
        saida.append((n, n * escala, bool(m.group("e"))))
    return saida


def escala_do_gabarito(unidade: str) -> float:
    """`R$ milhões` e `R$ bilhões` mudam a escala do `valor`; `mil funcionários` também."""
    u = unidade.lower().removeprefix("r$").strip()
    for palavra, escala in _ESCALAS.items():
        if u == palavra or u.startswith(palavra + " "):
            return escala
    return 1.0


def _perto(a: float, g: float) -> bool:
    return abs(abs(a) - abs(g)) <= TOLERANCIA * abs(g)


def acerto_numerico(caso: dict, resposta: str) -> bool:
    """A resposta tem o valor do gabarito dentro de 0,5%. Sem escala escrita, o número vale na unidade do
    gabarito ("16.782" para "R$ milhões"); com escala ("16,8 bilhões"), compara-se o valor já convertido."""
    valor = float(caso["valor"])
    absoluto = valor * escala_do_gabarito(caso["unidade"])
    return any(
        _perto(escalado, absoluto) if tinha_escala else _perto(escrito, valor)
        for escrito, escalado, tinha_escala in numeros_da_resposta(resposta)
    )


def percentil(valores: list[float], p: float) -> float | None:
    """Percentil por interpolação linear (o mesmo de `numpy.percentile`)."""
    if not valores:
        return None
    v = sorted(valores)
    pos = (len(v) - 1) * p / 100
    a, b = math.floor(pos), math.ceil(pos)
    return v[a] + (v[b] - v[a]) * (pos - a)


def _media(v: list[float]) -> dict:
    return {"n": len(v), "media": round(statistics.mean(v), 4) if v else None}


def _latencia(v: list[float]) -> dict:
    return {
        "n": len(v),
        "p50": round(percentil(v, 50), 2) if v else None,
        "p95": round(percentil(v, 95), 2) if v else None,
        "maximo": round(max(v), 2) if v else None,
    }


def calcular(casos: list[dict], respostas: list[dict]) -> dict:
    """Todas as métricas mecânicas de uma execução; cada uma no geral, só no recorte e por categoria."""
    por_id = {r["id"]: r for r in respostas}
    pag = {c["id"]: c for c in casos if c["paginas"].strip()}  # fora do escopo não tem página
    num = {c["id"]: c for c in casos if c["tipo_gabarito"] == "valor"}
    por_pergunta: dict[str, dict] = {}
    for c in casos:
        r = por_id[c["id"]]
        linha: dict = {"segundos": r["segundos"] if not r["erro"] else None}
        if c["id"] in pag:
            linha["page_recall"] = {f"@{k}": v for k, v in page_recall(c, r["contexto"]).items()}
            linha["pagina_citada"] = pagina_citada(c, r["resposta"])
        if c["id"] in num:
            linha["acerto_numerico"] = acerto_numerico(c, r["resposta"])
        por_pergunta[c["id"]] = linha
    cat = {c["id"]: c["categoria"] for c in casos}
    rec = {c["id"]: c["no_recorte"] for c in casos}
    filtros = {"geral": lambda i: True, "so_no_recorte": lambda i: rec[i] == "sim"}
    filtros.update({f"categoria:{k}": (lambda i, k=k: cat[i] == k) for k in sorted(set(cat.values()))})

    def por_filtro(filtro) -> dict:
        ids = [i for i in por_pergunta if filtro(i)]
        com_pag = [por_pergunta[i] for i in ids if "page_recall" in por_pergunta[i]]
        com_num = [por_pergunta[i] for i in ids if "acerto_numerico" in por_pergunta[i]]
        seg = [por_pergunta[i]["segundos"] for i in ids if por_pergunta[i]["segundos"] is not None]
        return {
            "page_recall": {
                f"@{k}": _media([x["page_recall"][f"@{k}"]["recall"] for x in com_pag]) for k in KS
            },
            "acerto_pagina": {
                f"@{k}": _media([x["page_recall"][f"@{k}"]["acerto"] for x in com_pag]) for k in KS
            },
            "pagina_citada": _media([1.0 if x["pagina_citada"] else 0.0 for x in com_pag]),
            "acerto_numerico": _media([1.0 if x["acerto_numerico"] else 0.0 for x in com_num]),
            "latencia_s": _latencia(seg),
        }

    saida = {nome: por_filtro(f) for nome, f in filtros.items()}
    return {
        "mecanicas": {
            "geral": saida["geral"],
            "so_no_recorte": saida["so_no_recorte"],
            "por_categoria": {n.split(":", 1)[1]: v for n, v in saida.items() if n.startswith("categoria:")},
        },
        "por_pergunta_mecanicas": por_pergunta,
    }


def concordancia_numerica_com_o_juiz(casos: list[dict], mecanicas: dict, notas: list[dict]) -> dict:
    """Confere o acerto numérico (regra) com a correção do juiz nas perguntas de valor: onde divergem?"""
    nota = {j["id"]: j["nota"] for j in notas if j["metrica"] == "correcao" and j["nota"] is not None}
    pares = defaultdict(int)
    for c in casos:
        if c["tipo_gabarito"] != "valor" or c["id"] not in nota:
            continue
        regra = mecanicas[c["id"]]["acerto_numerico"]
        pares[f"regra={'certo' if regra else 'errado'}|juiz={nota[c['id']]}"] += 1
    return dict(pares)
