"""Busca local do GraphRAG: a ferramenta `entidade` (ARQUITETURA §7.2 e cap. 7 do livro, tarefa F6.1).

Pergunta -> entidades parecidas (`entity_vec` + `entity_ft`, fundidos por RRF) -> para as primeiras:

* o resumo da entidade;
* os Pais (trechos) que a citam, ranqueados por quantas das entidades escolhidas os citam e por quanto
  se parecem com a pergunta (cosseno com o melhor Filho), fundidos por RRF;
* as relações resumidas (`SUMMARIZED_RELATIONSHIP`), as mais fortes primeiro;
* os relatórios das comunidades a que as entidades pertencem, a mais específica primeiro.

Tudo com teto (entidades, relações, Pais, comunidades e tokens), porque o emissor liga-se a milhares de nós
e sem teto o contexto vira o grafo inteiro. O que o teto corta é contado em `omitido`.

Cada evidência traz `id`, `tipo`, `paginas`, `caminho`, `texto` e `score` (o `evidence[]` da §7.2).
Só o Pai tem página do documento; entidade e relação mostram as páginas dos Pais de onde vieram, e o
relatório de comunidade, que é síntese, não tem página.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.busca_local criar-indice
    uv run python -m indexer.busca_local buscar "Quem é Tarciana Paula Gomes Medeiros?"
    uv run python -m indexer.busca_local medir --nome f61 [--juiz]
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

from indexer.busca import RRF_K, escapar_lucene, fundir_rrf
from indexer.embeddings import MODELO_CONSULTA, Embutidor, embutidor_llama
from indexer.grafo import conectar
from indexer.reranker import Reranqueador, reranqueador_llama

LIMITES_PADRAO: dict[str, int] = {
    "candidatas": 25,
    "ft": 2,  # entity_ft: 0 não usa, 1 usa a pergunta inteira, 2 só o que a pergunta cita pelo nome
    "entidades": 6,
    "relacoes": 10,
    "pais": 6,
    "comunidades": 2,
    "tokens": 6000,
}
CARACTERES_POR_TOKEN = 3  # o português do documento rende ~3,5; arredondar para baixo erra para o lado seguro
PAGINAS_POR_ENTIDADE = 5

CRIAR_INDICE_ENTIDADES = (
    "CREATE FULLTEXT INDEX entity_ft IF NOT EXISTS FOR (n:__Entity__) ON EACH [n.name, n.aliasesText] "
    "OPTIONS {indexConfig: {`fulltext.analyzer`: 'brazilian'}}"
)
CONSULTA_VETOR = (
    "CALL db.index.vector.queryNodes('entity_vec', $k, $v) YIELD node, score "
    "RETURN node.id AS id, score ORDER BY score DESC"
)
CONSULTA_TEXTO = (
    "CALL db.index.fulltext.queryNodes('entity_ft', $q, {limit: $k}) YIELD node, score "
    "RETURN node.id AS id, score, node.name AS nome, node.aliases AS apelidos ORDER BY score DESC"
)
DETALHES_ENTIDADES = (
    "UNWIND $ids AS id MATCH (e:__Entity__ {id: id}) OPTIONAL MATCH (e)-[:MENTIONED_IN]->(p:Parent) "
    "RETURN e.id AS id, e.name AS nome, e.type AS tipo, e.summary AS resumo, "
    "collect(DISTINCT p.pageStart) AS pages"
)
RELACOES = (
    "UNWIND $ids AS id MATCH (a:__Entity__ {id: id})-[r:SUMMARIZED_RELATIONSHIP]-(b:__Entity__) "
    "WITH DISTINCT r, startNode(r) AS x, endNode(r) AS y "
    "ORDER BY r.weight DESC, r.rank DESC, x.id, y.id LIMIT $k "
    "OPTIONAL MATCH (x)-[t:RELATED_TO]->(y) "
    "OPTIONAL MATCH (q:Parent) WHERE q.id IN coalesce(t.parents, []) "
    "RETURN x.id AS de, y.id AS para, x.name AS de_nome, y.name AS para_nome, r.summary AS resumo, "
    "r.weight AS peso, r.rank AS rank, collect(DISTINCT q.pageStart) AS pages"
)
MENCOES = (
    "UNWIND $ids AS id MATCH (e:__Entity__ {id: id})-[:MENTIONED_IN]->(p:Parent) "
    "RETURN e.id AS entidade, p.id AS pai"
)
SIMILARIDADE = (
    "UNWIND $ids AS id MATCH (p:Parent {id: id})-[:HAS_CHILD]->(c:Child) "
    "RETURN p.id AS pai, max(vector.similarity.cosine(c.embedding, $v)) AS sim"
)
DETALHES_PAIS = (
    "UNWIND $ids AS id MATCH (s:Section)-[:HAS_PARENT]->(p:Parent {id: id}) "
    "RETURN p.id AS id, p.text AS text, p.tokens AS tokens, p.pageStart AS pageStart, "
    "p.pageEnd AS pageEnd, s.path AS caminho"
)
COMUNIDADES = (
    "UNWIND $ids AS id MATCH (e:__Entity__ {id: id})-[:IN_COMMUNITY]->(c0:__Community__) "
    "MATCH (c0)-[:PARENT_COMMUNITY*0..]->(c:__Community__) "
    "RETURN DISTINCT e.id AS entidade, c.id AS id, c.title AS title, c.summary AS summary, "
    "c.level AS level, c.rank AS rank"
)


def _sem_acento(texto: str) -> str:
    base = unicodedata.normalize("NFD", texto.lower())
    return re.sub(r"\s+", " ", "".join(c for c in base if unicodedata.category(c) != "Mn")).strip()


def nome_na_pergunta(pergunta: str, nomes: list[str | None]) -> bool:
    """A pergunta cita ao menos um dos nomes (nome e apelidos) como palavra inteira, sem caixa nem acento."""
    alvo = _sem_acento(pergunta)
    for nome in nomes:
        n = _sem_acento(nome) if nome else ""
        if n and re.search(rf"(?<!\w){re.escape(n)}(?!\w)", alvo):
            return True
    return False


def texto_exato(acertos: list[dict], pergunta: str) -> list[tuple[str, float]]:
    """Do ranking do `entity_ft`, só o que a pergunta cita pelo nome ou apelido. Com a pergunta inteira como
    consulta o Lucene casa palavras soltas ("Banco", "Formulário") e enche o topo de entidades genéricas."""
    return [(a["id"], a["score"]) for a in acertos if nome_na_pergunta(pergunta, a.get("nomes") or [])]


def fundir_candidatas(
    vetor: list[tuple[str, float]], texto: list[tuple[str, float]], n: int
) -> list[tuple[str, float]]:
    """Entidades do vetor e do nome exato numa lista só (RRF): o que só uma das duas achou também entra."""
    return fundir_rrf(vetor, texto)[:n]


def _rrf(posicoes: list[dict[str, int]]) -> list[tuple[str, float]]:
    """RRF sobre rankings dados como `id -> posição`; ids com a mesma posição empatam de verdade."""
    pontos: dict[str, float] = defaultdict(float)
    for ranking in posicoes:
        for i, posicao in ranking.items():
            pontos[i] += 1.0 / (RRF_K + posicao)
    return sorted(pontos.items(), key=lambda x: (-round(x[1], 12), x[0]))


def _posicoes_densas(valor: dict[str, float]) -> dict[str, int]:
    """1 para o maior valor, 2 para o próximo valor distinto... (quem empata no valor empata na posição)."""
    distintos = sorted(set(valor.values()), reverse=True)
    posicao = {v: n for n, v in enumerate(distintos, start=1)}
    return {i: posicao[v] for i, v in valor.items()}


def ranquear_pais(mencoes: dict[str, list[str]], similaridade: dict[str, float], k: int) -> list[str]:
    """Top-k Pais: RRF de (a) quantas das entidades escolhidas o citam e (b) a similaridade com a pergunta.
    Quem cita o mesmo número de vezes empata na posição (senão o desempate por id empurraria o Pai mais
    parecido com a pergunta para o fim); o empate final é por id, então a ordem não muda entre execuções."""
    citacoes: dict[str, int] = defaultdict(int)
    for pais in mencoes.values():
        for p in set(pais):
            citacoes[p] += 1
    if not citacoes:
        return []
    por_citacao = _posicoes_densas({p: float(n) for p, n in citacoes.items()})
    por_similaridade = _posicoes_densas({p: similaridade[p] for p in citacoes if p in similaridade})
    return [p for p, _ in _rrf([por_citacao, por_similaridade])[:k]]


def ranquear_comunidades(membros: dict[str, list[str]], info: dict[str, dict], k: int) -> list[str]:
    """Mais entidades escolhidas dentro, depois o nível mais fino (mais específico), depois o `rank`."""
    ordem = sorted(
        membros,
        key=lambda c: (-len(set(membros[c])), info[c].get("level", 0), -(info[c].get("rank") or 0.0), c),
    )
    return ordem[:k]


def rotulo_de_paginas(paginas: list[int]) -> str:
    """`p. 6`, `p. 6-7` (páginas seguidas) ou `p. 6, 9, 12`; vazio quando não há página (nada é inventado)."""
    ordenadas = sorted({int(p) for p in paginas if p is not None})
    if not ordenadas:
        return ""
    faixas: list[list[int]] = [[ordenadas[0], ordenadas[0]]]
    for p in ordenadas[1:]:
        if p == faixas[-1][1] + 1:
            faixas[-1][1] = p
        else:
            faixas.append([p, p])
    return "p. " + ", ".join(str(a) if a == b else f"{a}-{b}" for a, b in faixas)


def estimar_tokens(texto: str) -> int:
    return max(1, len(texto) // CARACTERES_POR_TOKEN)


def montar_evidencias(
    entidades: list[dict], relacoes: list[dict], pais: list[dict], comunidades: list[dict], limites: dict
) -> tuple[list[dict], dict]:
    """Evidências na ordem entidade, Pai, relação, comunidade, com os tetos e o orçamento de tokens.

    O orçamento corta o que sobra das camadas de menor prioridade (a ordem acima é a prioridade); o que
    não cabe é pulado e contado em `por_orcamento`. A primeira entidade entra sempre."""
    vistas: set[frozenset] = set()
    unicas = []
    for r in sorted(
        relacoes, key=lambda r: (-(r.get("peso") or 0), -(r.get("rank") or 0), r["de"], r["para"])
    ):
        par = frozenset((r["de"], r["para"]))
        if par not in vistas:
            vistas.add(par)
            unicas.append(r)
    escolhidos = {
        "entidades": entidades[: limites["entidades"]],
        "pais": pais[: limites["pais"]],
        "relacoes": unicas[: limites["relacoes"]],
        "comunidades": comunidades[: limites["comunidades"]],
    }
    omitido = {
        "entidades": len(entidades) - len(escolhidos["entidades"]),
        "relacoes": len(unicas) - len(escolhidos["relacoes"]),
        "pais": len(pais) - len(escolhidos["pais"]),
        "comunidades": len(comunidades) - len(escolhidos["comunidades"]),
        "por_orcamento": 0,
    }
    candidatas: list[tuple[dict, int]] = []
    for e in escolhidos["entidades"]:
        texto = f"{e['nome']} ({e['tipo']}): {e.get('resumo') or ''}".strip()
        candidatas.append(
            (
                {
                    "id": e["id"],
                    "tipo": "entidade",
                    "paginas": rotulo_de_paginas(e.get("paginas", [])),
                    "caminho": "Entidade",
                    "texto": texto,
                    "score": e.get("score"),
                },
                estimar_tokens(texto),
            )
        )
    for p in escolhidos["pais"]:
        candidatas.append(
            (
                {
                    "id": p["id"],
                    "tipo": "pai",
                    "paginas": rotulo_de_paginas(list(range(p["pageStart"], p["pageEnd"] + 1))),
                    "caminho": p.get("caminho") or "",
                    "texto": p["text"],
                    "score": p.get("score"),
                },
                p.get("tokens") or estimar_tokens(p["text"]),
            )
        )
    for r in escolhidos["relacoes"]:
        texto = f"{r['de_nome']} → {r['para_nome']}: {r.get('resumo') or ''}".strip()
        candidatas.append(
            (
                {
                    "id": f"rel:{r['de']}:{r['para']}",
                    "tipo": "relacao",
                    "paginas": rotulo_de_paginas(r.get("paginas", [])),
                    "caminho": "Relação",
                    "texto": texto,
                    "score": r.get("peso", r.get("rank")),
                },
                estimar_tokens(texto),
            )
        )
    for c in escolhidos["comunidades"]:
        texto = f"{c['title']}\n{c.get('summary') or ''}".strip()
        candidatas.append(
            (
                {
                    "id": c["id"],
                    "tipo": "comunidade",
                    "paginas": "",
                    "caminho": f"Comunidade (nível {c.get('level', 0)})",
                    "texto": texto,
                    "score": c.get("rank"),
                },
                estimar_tokens(texto),
            )
        )
    saida: list[dict] = []
    gasto = 0
    for evidencia, tokens in candidatas:
        if gasto + tokens > limites["tokens"] and saida:
            omitido["por_orcamento"] += 1
            continue
        saida.append(evidencia)
        gasto += tokens
    return saida, omitido


def criar_indice(driver: Any, banco: str = "neo4j", espera: int = 300) -> dict:
    driver.execute_query(CRIAR_INDICE_ENTIDADES, database_=banco)
    driver.execute_query(f"CALL db.awaitIndexes({espera})", database_=banco)
    registros, _, _ = driver.execute_query(
        "SHOW INDEXES YIELD name, type, state, populationPercent, options WHERE name = 'entity_ft' "
        "RETURN name, type, state, populationPercent, options",
        database_=banco,
    )
    if not registros:
        return {"existe": False}
    r = registros[0]
    return {
        "existe": True,
        "tipo": r["type"],
        "estado": r["state"],
        "populado_pct": r["populationPercent"],
        "analisador": r["options"].get("indexConfig", {}).get("fulltext.analyzer"),
    }


def _vazio(latencia: dict) -> dict:
    return {"entidades": [], "evidencias": [], "omitido": {}, "rerank": "desligado", "latencia_ms": latencia}


def buscar(
    driver: Any,
    consulta: str,
    embute_consulta: Embutidor,
    limites: dict | None = None,
    banco: str = "neo4j",
    reranquear: Reranqueador | None = None,
) -> dict:
    """A busca local inteira: `{entidades, evidencias, omitido, rerank, latencia_ms}`.

    Com `reranquear`, as candidatas (até `candidatas`) são reordenadas pelo reranker sobre "nome: resumo" e
    as `entidades` melhores seguem; se ele falhar, a busca segue na ordem do RRF e `rerank` vale "falhou".
    Pergunta vazia ou sem nenhuma entidade parecida devolve tudo vazio, sem erro."""
    lim = {**LIMITES_PADRAO, **(limites or {})}
    t0 = time.perf_counter()
    if not consulta.strip():
        return _vazio({"total": 0.0, "embedding_da_consulta": 0.0})

    def q(cypher: str, **parametros: Any) -> list:
        registros, _, _ = driver.execute_query(cypher, parametros, database_=banco)
        return registros

    t = time.perf_counter()
    (vetor,) = embute_consulta([consulta])
    gasto_embedding = time.perf_counter() - t

    candidatas = [(r["id"], r["score"]) for r in q(CONSULTA_VETOR, k=lim["candidatas"], v=vetor)]
    termos = escapar_lucene(consulta)
    acertos = (
        [
            {"id": r["id"], "score": r["score"], "nomes": [r.get("nome"), *(r.get("apelidos") or [])]}
            for r in q(CONSULTA_TEXTO, q=termos, k=lim["candidatas"])
        ]
        if termos and lim["ft"]
        else []
    )
    texto = [(a["id"], a["score"]) for a in acertos] if lim["ft"] == 1 else texto_exato(acertos, consulta)
    fundidas = fundir_candidatas(candidatas, texto, lim["candidatas"])
    if not fundidas:
        return _vazio({"total": round((time.perf_counter() - t0) * 1000, 1), "embedding_da_consulta": 0.0})
    pontuacao = dict(fundidas)
    a_detalhar = [i for i, _ in (fundidas if reranquear else fundidas[: lim["entidades"]])]
    t_entidades = time.perf_counter()

    por_id = {
        r["id"]: {
            "id": r["id"],
            "nome": r["nome"],
            "tipo": r["tipo"],
            "resumo": r["resumo"],
            "paginas": sorted({p for p in r["pages"] if p is not None})[:PAGINAS_POR_ENTIDADE],
            "score": round(pontuacao[r["id"]], 6),
        }
        for r in q(DETALHES_ENTIDADES, ids=a_detalhar)
    }
    ordem = [i for i in a_detalhar if i in por_id]
    rerank = "desligado"
    if reranquear and ordem:
        try:
            notas = reranquear(
                consulta, [f"{por_id[i]['nome']}: {por_id[i]['resumo'] or ''}".strip() for i in ordem]
            )
            nota = dict(zip(ordem, notas, strict=True))
            for i in ordem:
                por_id[i]["score"] = round(nota[i], 6)
            ordem = sorted(ordem, key=lambda i: (-nota[i], i))
            rerank = "ok"
        except Exception:  # o reranker é um refinamento: sem ele a busca segue na ordem do RRF
            rerank = "falhou"
    ids = ordem[: lim["entidades"]]
    entidades = [por_id[i] for i in ids]

    relacoes = [
        {
            "de": r["de"],
            "para": r["para"],
            "de_nome": r["de_nome"],
            "para_nome": r["para_nome"],
            "resumo": r["resumo"],
            "peso": r.get("peso"),
            "rank": r["rank"],
            "paginas": [p for p in r["pages"] if p is not None],
        }
        for r in q(RELACOES, ids=ids, k=lim["relacoes"] * 2)
    ]

    mencoes: dict[str, list[str]] = {i: [] for i in ids}
    for r in q(MENCOES, ids=ids):
        mencoes[r["entidade"]].append(r["pai"])
    candidatos_pai = sorted({p for ps in mencoes.values() for p in ps})
    similaridade = (
        {r["pai"]: r["sim"] for r in q(SIMILARIDADE, ids=candidatos_pai, v=vetor)} if candidatos_pai else {}
    )
    escolhidos_pai = ranquear_pais(mencoes, similaridade, lim["pais"] + 1)  # +1: o excedente vira `omitido`
    pais_por_id = {r["id"]: r for r in q(DETALHES_PAIS, ids=escolhidos_pai)} if escolhidos_pai else {}
    pais = [
        {**dict(pais_por_id[i]), "score": round(similaridade.get(i, 0.0), 6)}
        for i in escolhidos_pai
        if i in pais_por_id
    ]

    membros: dict[str, list[str]] = defaultdict(list)
    info: dict[str, dict] = {}
    for r in q(COMUNIDADES, ids=ids):
        membros[r["id"]].append(r["entidade"])
        info[r["id"]] = {
            "id": r["id"],
            "title": r["title"],
            "summary": r["summary"],
            "level": r["level"],
            "rank": r["rank"],
        }
    comunidades = [info[c] for c in ranquear_comunidades(membros, info, lim["comunidades"] + 1)]

    evidencias, omitido = montar_evidencias(entidades, relacoes, pais, comunidades, lim)
    fim = time.perf_counter()
    return {
        "entidades": [{"id": e["id"], "nome": e["nome"], "score": e["score"]} for e in entidades],
        "evidencias": evidencias,
        "omitido": omitido,
        "rerank": rerank,
        "latencia_ms": {
            "total": round((fim - t0) * 1000, 1),
            "embedding_da_consulta": round(gasto_embedding * 1000, 1),
            "entidades": round((t_entidades - t0 - gasto_embedding) * 1000, 1),
            "contexto": round((fim - t_entidades) * 1000, 1),
        },
    }


def selecionar_casos_de_entidade(casos: list[dict]) -> list[dict]:
    """As perguntas do golden set que a busca local deve responder: rota `entidade` ou pergunta que começa
    com "Quem". Recusa (rota `nenhuma` ou gabarito `recusa`) não tem o que recuperar."""
    return [
        c
        for c in casos
        if c.get("rota_esperada") != "nenhuma"
        and c.get("tipo_gabarito") != "recusa"
        and (c.get("rota_esperada") == "entidade" or re.match(r"\s*quem\b", c["pergunta"], re.IGNORECASE))
    ]


def _normalizar(texto: str) -> str:
    return re.sub(r"\s+", " ", texto.replace("­", "").replace("￾", ""))


def recall_por_regex(caso: dict, contexto: list[dict]) -> float | None:
    """Recall mecânico, sem juiz: fração das partes da coluna `evidencia` (separadas por ` && `, regex sem
    distinção de caixa) que aparecem no texto do contexto. `None` na recusa ou sem `evidencia`."""
    partes = [p for p in (caso.get("evidencia") or "").split(" && ") if p]
    if caso.get("tipo_gabarito") == "recusa" or not partes:
        return None
    base = _normalizar(" ".join(c["texto"] for c in contexto))
    return sum(1 for p in partes if re.search(p, base, re.IGNORECASE)) / len(partes)


def sistema_busca_local(
    driver: Any,
    embute: Embutidor,
    limites: dict | None = None,
    banco: str = "neo4j",
    reranquear: Reranqueador | None = None,
):
    """O "sistema" que o avaliador (F3) roda nesta etapa: só a recuperação, sem resposta do LLM."""

    def responde(caso: dict) -> dict:
        r = buscar(driver, caso["pergunta"], embute, limites, banco, reranquear)
        return {
            "resposta": "",
            "citacoes": [],
            "contexto": [
                {"paginas": e["paginas"], "caminho": e["caminho"], "texto": e["texto"], "tipo": e["tipo"]}
                for e in r["evidencias"]
            ],
            "entidades": r["entidades"],
            "omitido": r["omitido"],
            "latencia_ms": r["latencia_ms"],
        }

    return responde


def medir(
    driver: Any,
    embute: Embutidor,
    casos: list[dict],
    pasta: Path,
    limites: dict | None = None,
    juiz: Any = None,
    banco: str = "neo4j",
    reranquear: Reranqueador | None = None,
) -> dict:
    """Roda a busca local nos casos e junta: recall por regex, page recall do contexto inteiro e dos Pais,
    latência e, se houver `juiz`, o recall de contexto do juiz local (o da F3.2)."""
    import statistics

    from indexer.avaliar import gerar, julgar
    from indexer.metricas import page_recall

    sistema = sistema_busca_local(driver, embute, limites, banco, reranquear)
    sistema(casos[0])  # aquece o modelo de embeddings e os índices
    respostas = gerar(casos, sistema, pasta)
    notas = julgar(casos, respostas, juiz, pasta, ("recall_contexto",)) if juiz else []
    juizo = {j["id"]: j["nota"] for j in notas}
    por_pergunta = {}
    for c, r in zip(casos, respostas, strict=True):
        ctx = r["contexto"]
        pais = [x for x in ctx if x.get("tipo") == "pai"]
        por_pergunta[c["id"]] = {
            "recall_regex": recall_por_regex(c, ctx),
            "page_recall_tudo": page_recall(c, ctx, (max(1, len(ctx)),))[max(1, len(ctx))]["recall"],
            "page_recall_pais": page_recall(c, pais, (max(1, len(pais)),))[max(1, len(pais))]["recall"],
            "recall_juiz": juizo.get(c["id"]),
            "evidencias": len(ctx),
            "segundos": r["segundos"],
            "erro": r["erro"],
        }

    def media(chave: str) -> dict:
        v = [x[chave] for x in por_pergunta.values() if x[chave] is not None]
        return {"n": len(v), "media": round(statistics.mean(v), 4) if v else None}

    segundos = sorted(x["segundos"] for x in por_pergunta.values())
    return {
        "perguntas": len(casos),
        "limites": {**LIMITES_PADRAO, **(limites or {})},
        "recall_regex": media("recall_regex"),
        "page_recall_tudo": media("page_recall_tudo"),
        "page_recall_pais": media("page_recall_pais"),
        "recall_juiz": media("recall_juiz"),
        "segundos_p50": segundos[len(segundos) // 2],
        "segundos_max": segundos[-1],
        "por_pergunta": por_pergunta,
    }


def main() -> None:  # pragma: no cover - orquestração de CLI; a lógica tem testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["criar-indice", "buscar", "medir"])
    ap.add_argument("consulta", nargs="?")
    ap.add_argument("--nome", help="medir: nome da execução (pasta em data/avaliacao)")
    ap.add_argument("--golden", type=Path, default=Path("../eval/golden.csv"))
    ap.add_argument(
        "--todas", action="store_true", help="medir: todas as perguntas com gabarito, não só as de entidade"
    )
    ap.add_argument(
        "--sem-rerank",
        action="store_true",
        help="não reranqueia as entidades candidatas (o padrão reranqueia)",
    )
    ap.add_argument("--juiz", action="store_true", help="medir: também o recall de contexto do juiz local")
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    for chave, valor in LIMITES_PADRAO.items():
        ap.add_argument(f"--{chave}", type=int, default=valor)
    a = ap.parse_args()
    driver = conectar(a.raiz)
    try:
        if a.acao == "criar-indice":
            print(json.dumps(criar_indice(driver, a.banco), ensure_ascii=False, indent=2))
            return
        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        limites = {k: getattr(a, k) for k in LIMITES_PADRAO}
        reranquear = None if a.sem_rerank else reranqueador_llama(a.swap)
        if a.acao == "buscar":
            if not a.consulta:
                ap.error("buscar precisa da consulta")
            r = buscar(driver, a.consulta, embute, limites, a.banco, reranquear)
            print(json.dumps(r, ensure_ascii=False, indent=2))
            return
        from indexer.avaliar import juiz_llama, ler_golden

        if not a.nome:
            ap.error("medir precisa de --nome")
        casos = ler_golden(a.golden)
        casos = (
            [c for c in casos if c["tipo_gabarito"] != "recusa" and c["rota_esperada"] != "nenhuma"]
            if a.todas
            else selecionar_casos_de_entidade(casos)
        )
        pasta = a.raiz / "data" / "avaliacao" / a.nome
        juiz = juiz_llama(a.swap) if a.juiz else None
        r = medir(driver, embute, casos, pasta, limites, juiz, a.banco, reranquear)
        destino = a.raiz / "eval" / "resultados" / f"{a.nome}.json"
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps({k: v for k, v in r.items() if k != "por_pergunta"}, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":  # pragma: no cover
    main()
