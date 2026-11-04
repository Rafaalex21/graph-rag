"""Relatórios de comunidade em JSON e embeddings em `community_vec` (§5 I-9, F5.6).

Para cada comunidade da F5.5 o Qwen3.6 escreve um relatório (prompt do MS GraphRAG, adaptado ao português):
título, resumo, nota de impacto (0 a 10), explicação da nota e achados, cada um com as entidades e relações
do contexto que o sustentam. O contexto do pedido são os resumos das entidades (F5.4) e das relações entre
elas, ranqueados por grau; se passar do limite, saem primeiro as relações de menor rank e depois as entidades
de menor rank (com as relações que ficaram sem ponta), e a quantidade omitida fica registrada na comunidade.

- **Referências:** o modelo cita `E1`, `R2`..., etiquetas do contexto; uma etiqueta que não existe invalida o
  relatório, e as válidas viram os ids das entidades e os pares `[de, para]` das relações.
- **Validade:** o JSON sai por gramática, mas a gramática não impõe tudo (nota fora de 0 a 10, texto vazio,
  referência inventada). `validar_relatorio` confere, e uma resposta recusada é pedida de novo, uma vez, com o
  motivo no pedido. Duas recusas seguidas são o erro `RelatorioInvalido`; o relatório não é gravado.
- **Quantidade de achados:** de `min(5, entidades)` a 10. A §5 I-9 pede de 5 a 10; numa comunidade de 2 ou 3
  entidades isso obrigaria o modelo a inventar.
- **Cache e repetição:** o cache é por hash do pedido (e dos ids), não por comunidade. Os mesmos
  membros em níveis diferentes (a hierarquia repete boa parte delas) dividem um relatório só.
- **Grafo:** `__Community__.title|summary|rating|ratingExplanation|rank|report` (`report` é o JSON inteiro);
  `rank` = número de Pais que mencionam as entidades da comunidade. O embedding de `texto_para_embutir` vai em
  `embedding`, índice `community_vec`.

Precisa do Neo4j e do llama-swap (`gerar`: perfil `indexar`; `embutir`: `vetorizar`). A partir de `indexer/`:
    uv run python -m indexer.relatorios gerar ../data/parsed/bb_fre_2026_recorte
    uv run python -m indexer.relatorios embutir
    uv run python -m indexer.relatorios autoteste
    uv run python -m indexer.relatorios verificar
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.request
from collections import defaultdict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from indexer.embeddings import (
    DIMENSOES,
    MODELO_CONSULTA,
    MODELO_LOTE,
    em_lotes,
    embutidor_llama,
    formatar_consulta,
)
from indexer.extrair import MODELO_LLM

VERSAO_DO_PROMPT = "v2"
MIN_ACHADOS = 5
MAX_ACHADOS = 10
MAX_CHARS_CONTEXTO = 20000  # ≈ 7 mil tokens; metade do slot de 16 mil, como na F5.4
FRACAO_PARA_ENTIDADES = 0.7
MAX_CHARS_LINHA = 900
MAX_CHARS_EMBUTIDO = 12000  # ≈ 4 mil tokens, folga para o contexto de 8192 do embedder
MAX_TOKENS_SAIDA = 4000

Gerador = Callable[[list[dict], dict], dict]


class RelatorioInvalido(ValueError):
    """A resposta do modelo não passou na validação (nota, texto vazio, número de achados, referência)."""


SISTEMA = (
    "Você é um analista que escreve relatórios sobre comunidades de entidades de um documento financeiro em "
    "português (o Formulário de Referência de uma empresa). Uma comunidade é um grupo de entidades ligadas "
    "entre si. Receberá as entidades e as relações da comunidade, cada uma com uma etiqueta ([E1], [R1]). "
    "Escreva em português, usando somente o que o material diz; não acrescente fatos nem números.\n"
    "O relatório tem: title (nome curto e específico da comunidade, com os nomes das entidades principais); "
    "summary (visão geral da estrutura da comunidade: quem são as entidades, como se relacionam); rating "
    "(nota de impacto de 0 a 10: a importância da comunidade para entender o negócio, os riscos e a "
    "governança do emissor); rating_explanation (uma frase que justifica a nota); findings (os achados mais "
    "importantes). Cada achado tem summary (uma frase), explanation (um parágrafo curto) e as etiquetas "
    "que o sustentam, em entities (como E1) e relationships (como R1). Todo achado cita ao menos uma "
    "etiqueta que existe no material.\n"
    "Regras de escrita: (1) nunca escreva as etiquetas ([E1], R2) no title, no summary, na explanation "
    "nem na "
    "rating_explanation; escreva os nomes das entidades; as etiquetas só aparecem nos campos entities e "
    "relationships. (2) Não especule: afirme só o que o material diz e evite 'sugere', 'possivelmente', "
    "'pode indicar', 'provavelmente'. (3) Não crie siglas, nomes nem datas que não estejam no material. "
    "(4) Não repita o mesmo achado com outras palavras; se o material sustenta poucos achados, escreva só o "
    "mínimo pedido."
)
PEDIDO = """Comunidade com {n} entidades. Escreva o relatório com {minimo} a {maximo} achados.

{contexto}"""
PEDIDO_NOVAMENTE = "\n\nA resposta anterior foi recusada: {erro}. Corrija e responda de novo."


def minimo_de_achados(n_entidades: int) -> int:
    return max(1, min(MIN_ACHADOS, n_entidades))


def maximo_de_achados(n_entidades: int) -> int:
    """Duas vezes o número de entidades, no máximo 10: comunidade pequena não tem o que dizer dez vezes."""
    return min(MAX_ACHADOS, max(minimo_de_achados(n_entidades), 2 * n_entidades))


ETIQUETA = re.compile(r"\b[ER]\d{1,3}\b")


def esquema(minimo: int, maximo: int = MAX_ACHADOS) -> dict:
    texto = lambda n: {"type": "string", "maxLength": n}  # noqa: E731
    etiquetas = {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 8}}
    achado = {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary", "explanation", "entities", "relationships"],
        "properties": {
            "summary": texto(300),
            "explanation": texto(1000),
            "entities": etiquetas,
            "relationships": etiquetas,
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "summary", "rating", "rating_explanation", "findings"],
        "properties": {
            "title": texto(200),
            "summary": texto(1500),
            "rating": {"type": "number", "minimum": 0, "maximum": 10},
            "rating_explanation": texto(600),
            "findings": {"type": "array", "minItems": minimo, "maxItems": maximo, "items": achado},
        },
    }


def montar_contexto(entidades: list[dict], relacoes: list[dict], limite: int = MAX_CHARS_CONTEXTO) -> dict:
    """Texto do pedido com etiquetas; corta por rank se passar de `limite` e conta o que omitiu."""
    cab_e, cab_r = "Entidades:\n", "\n\nRelações:\n"
    ordem_e = sorted(entidades, key=lambda e: (-e["rank"], e["id"]))
    ordem_r = sorted(relacoes, key=lambda r: (-r["rank"], r["de"], r["para"]))
    orcamento_e = int((limite - len(cab_e) - len(cab_r)) * FRACAO_PARA_ENTIDADES)
    linhas_e, tag_de, usado = [], {}, 0
    for e in ordem_e:
        tag = f"E{len(linhas_e) + 1}"
        linha = f"[{tag}] {e['name']} ({e['type']}): {(e['summary'] or '')[:MAX_CHARS_LINHA]}"
        if usado + len(linha) + 1 > orcamento_e:
            break
        linhas_e.append(linha)
        tag_de[e["id"]] = tag
        usado += len(linha) + 1
    orcamento_r = limite - len(cab_e) - len(cab_r) - usado
    linhas_r, relacoes_tag, gasto = [], {}, 0
    for r in ordem_r:
        if r["de"] not in tag_de or r["para"] not in tag_de:
            continue
        tag = f"R{len(linhas_r) + 1}"
        linha = (
            f"[{tag}] {tag_de[r['de']]} -> {tag_de[r['para']]} (força {r['weight']}): "
            f"{(r['summary'] or '')[:MAX_CHARS_LINHA]}"
        )
        if gasto + len(linha) + 1 > orcamento_r:
            break
        linhas_r.append(linha)
        relacoes_tag[tag] = (r["de"], r["para"])
        gasto += len(linha) + 1
    return {
        "texto": cab_e + "\n".join(linhas_e) + cab_r + "\n".join(linhas_r),
        "entidades": {tag: id_ for id_, tag in tag_de.items()},
        "relacoes": relacoes_tag,
        "omitidas": {"entidades": len(entidades) - len(linhas_e), "relacoes": len(relacoes) - len(linhas_r)},
    }


def _etiqueta(bruta: Any) -> str:
    return re.sub(r"[\[\]\s]", "", str(bruta)).upper()


def validar_relatorio(resposta: Any, contexto: dict, minimo: int, maximo: int = MAX_ACHADOS) -> dict:
    """Relatório normalizado (etiquetas trocadas por ids) ou `RelatorioInvalido`."""
    if not isinstance(resposta, dict):
        raise RelatorioInvalido("a resposta não é um objeto")
    for campo in ("title", "summary", "rating_explanation"):
        valor = resposta.get(campo)
        if not isinstance(valor, str) or not valor.strip():
            raise RelatorioInvalido(f"{campo} vazio ou ausente")
    nota = resposta.get("rating")
    if isinstance(nota, bool) or not isinstance(nota, (int, float)) or not 0 <= nota <= 10:
        raise RelatorioInvalido(f"rating fora de 0 a 10: {nota!r}")
    achados = resposta.get("findings")
    if not isinstance(achados, list) or not minimo <= len(achados) <= maximo:
        n = len(achados) if isinstance(achados, list) else achados
        raise RelatorioInvalido(f"achados: {n}, esperado de {minimo} a {maximo}")
    textos = [resposta["title"], resposta["summary"], resposta["rating_explanation"]]
    textos += [str(a.get(c, "")) for a in achados if isinstance(a, dict) for c in ("summary", "explanation")]
    for t in textos:
        achou = ETIQUETA.search(t)
        if achou:
            raise RelatorioInvalido(f"etiqueta do contexto no texto: {achou.group()}")
    saida = []
    for i, a in enumerate(achados, 1):
        if (
            not isinstance(a, dict)
            or not str(a.get("summary", "")).strip()
            or not str(a.get("explanation", "")).strip()
        ):
            raise RelatorioInvalido(f"achado {i} sem summary ou explanation")
        ents, rels = [], []
        for bruta in a.get("entities") or []:
            tag = _etiqueta(bruta)
            if tag not in contexto["entidades"]:
                raise RelatorioInvalido(f"achado {i}: referência a entidade que não existe: {bruta!r}")
            if contexto["entidades"][tag] not in ents:
                ents.append(contexto["entidades"][tag])
        for bruta in a.get("relationships") or []:
            tag = _etiqueta(bruta)
            if tag not in contexto["relacoes"]:
                raise RelatorioInvalido(f"achado {i}: referência a relação que não existe: {bruta!r}")
            par = list(contexto["relacoes"][tag])
            if par not in rels:
                rels.append(par)
        if not ents and not rels:
            raise RelatorioInvalido(f"achado {i} sem nenhuma referência")
        saida.append(
            {
                "summary": a["summary"].strip(),
                "explanation": a["explanation"].strip(),
                "entities": ents,
                "relationships": rels,
            }  # fmt: skip
        )
    return {
        "title": resposta["title"].strip(),
        "summary": resposta["summary"].strip(),
        "rating": float(nota),
        "ratingExplanation": resposta["rating_explanation"].strip(),
        "findings": saida,
    }


def texto_para_embutir(relatorio: dict) -> str:
    partes = [relatorio["title"], relatorio["summary"]]
    partes += [f"- {a['summary']} {a['explanation']}" for a in relatorio["findings"]]
    return "\n".join(partes)[:MAX_CHARS_EMBUTIDO]


def _chave(pedido: str, ids: list[str], modelo: str) -> str:
    base = f"{VERSAO_DO_PROMPT}\x1f{modelo}\x1f{SISTEMA}\x1f{pedido}\x1f" + "\x1f".join(sorted(ids))
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:20]


def gerar_relatorio(
    comunidade: dict, entidades: list[dict], relacoes: list[dict], gera: Gerador, cache: Path,
    modelo: str = MODELO_LLM,
) -> dict:  # fmt: skip
    """Relatório validado da comunidade; do cache se o conteúdo já foi visto, senão até duas chamadas."""
    contexto = montar_contexto(entidades, relacoes)
    minimo = minimo_de_achados(len(contexto["entidades"]))
    maximo = maximo_de_achados(len(contexto["entidades"]))
    pedido = PEDIDO.format(n=len(entidades), minimo=minimo, maximo=maximo, contexto=contexto["texto"])
    arq = cache / f"{_chave(pedido, [e['id'] for e in entidades], modelo)}.json"
    if arq.exists():
        dado = json.loads(arq.read_text(encoding="utf-8"))
        return {
            **dado,
            "chamadas": 0,
            "omitidas": contexto["omitidas"],
            "chars_contexto": len(contexto["texto"]),
        }
    erro, chamadas = "", 0
    for _ in range(2):
        mensagens = [{"role": "system", "content": SISTEMA}, {"role": "user", "content": pedido}]
        if erro:
            mensagens[-1]["content"] += PEDIDO_NOVAMENTE.format(erro=erro)
        r = gera(mensagens, esquema(minimo, maximo))
        chamadas += 1
        try:
            relatorio = validar_relatorio(r["resposta"], contexto, minimo, maximo)
        except RelatorioInvalido as e:
            erro = str(e)
            continue
        dado = {"relatorio": relatorio, "tokens_prompt": r.get("tokens_prompt", 0)}
        cache.mkdir(parents=True, exist_ok=True)
        arq.write_text(json.dumps(dado, ensure_ascii=False, indent=1), encoding="utf-8")
        return {**dado, "chamadas": chamadas, "omitidas": contexto["omitidas"],
                "chars_contexto": len(contexto["texto"])}  # fmt: skip
    raise RelatorioInvalido(erro)


def gerador_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 1800) -> Gerador:
    def gera(mensagens: list[dict], schema: dict) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.1,
            "max_tokens": MAX_TOKENS_SAIDA,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "relatorio", "strict": True, "schema": schema},
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
            resposta = json.loads(dados["choices"][0]["message"]["content"])
        except (json.JSONDecodeError, KeyError):
            resposta = None  # vira RelatorioInvalido na validação
        return {"resposta": resposta, "tokens_prompt": dados.get("usage", {}).get("prompt_tokens", 0)}

    return gera


# ---- Neo4j ----------------------------------------------------------------------------------------------


def ler_comunidades(driver: Any, banco: str = "neo4j") -> list[dict]:
    """Cada comunidade com seus membros (as entidades do nível 0 que descem dela), entidades e relações."""

    def q(c: str) -> list[dict]:
        return [dict(r) for r in driver.execute_query(c, database_=banco)[0]]

    coms = q("MATCH (c:__Community__) RETURN c.id AS id, c.level AS nivel ORDER BY c.level, c.id")
    membros = q(
        "MATCH (e:__Entity__)-[:IN_COMMUNITY]->(:__Community__)-[:PARENT_COMMUNITY*0..]->(c:__Community__) "
        "RETURN c.id AS com, e.id AS ent"
    )
    dados = {
        r["id"]: r
        for r in q(
            "MATCH (e:__Entity__) RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary, "
            "count { (e)-[:SUMMARIZED_RELATIONSHIP]-() } AS rank"
        )
    }
    rels = q(
        "MATCH (a:__Entity__)-[x:SUMMARIZED_RELATIONSHIP]->(b:__Entity__) "
        "RETURN a.id AS de, b.id AS para, x.summary AS summary, x.weight AS weight, x.rank AS rank"
    )
    pais = defaultdict(set)
    for r in q(
        "MATCH (e:__Entity__)-[:MENTIONED_IN|DESCRIBED_IN]->(p:Parent) RETURN e.id AS ent, p.id AS pai"
    ):
        pais[r["ent"]].add(r["pai"])
    por_com = defaultdict(set)
    for r in membros:
        por_com[r["com"]].add(r["ent"])
    saida = []
    for c in coms:
        ids = por_com[c["id"]]
        saida.append(
            {
                **c,
                "entidades": [dados[i] for i in sorted(ids)],
                "relacoes": [r for r in rels if r["de"] in ids and r["para"] in ids],
                "rank": len(set().union(*(pais[i] for i in ids))) if ids else 0,
            }
        )
    return saida


GRAVAR = (
    "UNWIND $rows AS r MATCH (c:__Community__ {id: r.id}) "
    "SET c.title = r.title, c.summary = r.summary, c.rating = r.rating, c.ratingExplanation = r.explicacao, "
    "c.rank = r.rank, c.report = r.report, c.omittedEntities = r.omitidas_e, "
    "c.omittedRelationships = r.omitidas_r"
)
CRIAR_INDICE = (
    "CREATE VECTOR INDEX community_vec IF NOT EXISTS FOR (n:__Community__) ON n.embedding "
    f"OPTIONS {{indexConfig: {{`vector.dimensions`: {DIMENSOES}, `vector.similarity_function`: 'cosine'}}}}"
)
GRAVAR_VETOR = (
    "UNWIND $rows AS r MATCH (c:__Community__ {id: r.id}) "
    "CALL db.create.setNodeVectorProperty(c, 'embedding', r.vetor) "
    "SET c.embeddingModel = $modelo, c.embeddingDims = $dims"
)


def gerar(driver: Any, gera: Gerador, cache: Path, paralelismo: int = 2, banco: str = "neo4j") -> dict:
    comunidades = ler_comunidades(driver, banco)
    grupos: dict[tuple, list[dict]] = defaultdict(list)
    for c in comunidades:
        grupos[tuple(e["id"] for e in c["entidades"])].append(c)
    t0 = time.perf_counter()

    def um(grupo: list[dict]) -> tuple[list[dict], dict | Exception]:
        c = grupo[0]
        try:
            return grupo, gerar_relatorio(c, c["entidades"], c["relacoes"], gera, cache)
        except (RelatorioInvalido, OSError, ValueError) as e:
            return grupo, e

    with ThreadPoolExecutor(paralelismo) as pool:
        resultados = list(pool.map(um, grupos.values()))
    linhas, falhas, chamadas, tokens, omitidas = [], [], 0, 0, 0
    for grupo, r in resultados:
        if isinstance(r, Exception):
            falhas += [{"id": c["id"], "nivel": c["nivel"], "erro": str(r)} for c in grupo]
            continue
        chamadas += r["chamadas"]
        tokens = max(tokens, r["tokens_prompt"])
        omitidas += r["omitidas"]["entidades"] + r["omitidas"]["relacoes"]
        rel = r["relatorio"]
        for c in grupo:
            linhas.append(
                {
                    "id": c["id"],
                    "title": rel["title"],
                    "summary": rel["summary"],
                    "rating": rel["rating"],
                    "explicacao": rel["ratingExplanation"],
                    "rank": c["rank"],
                    "report": json.dumps(rel, ensure_ascii=False),
                    "omitidas_e": r["omitidas"]["entidades"],
                    "omitidas_r": r["omitidas"]["relacoes"],
                }  # fmt: skip
            )
    for lote in em_lotes(linhas, 200):
        driver.execute_query(GRAVAR, {"rows": lote}, database_=banco)
    nota = [json.loads(r["report"])["rating"] for r in linhas]
    return {
        "comunidades": len(comunidades),
        "conteudos_distintos": len(grupos),
        "relatorios_validos": len(linhas),
        "invalidos": falhas,
        "chamadas_novas": chamadas,
        "max_tokens_prompt": tokens,
        "entidades_ou_relacoes_omitidas": omitidas,
        "nota_media": round(sum(nota) / len(nota), 2) if nota else None,
        "segundos": round(time.perf_counter() - t0, 1),
    }


def textos_dos_relatorios(driver: Any, banco: str = "neo4j") -> dict[str, str]:
    regs = driver.execute_query(
        "MATCH (c:__Community__) WHERE c.report IS NOT NULL "
        "RETURN c.id AS id, c.report AS report ORDER BY c.id",
        database_=banco,
    )[0]
    return {r["id"]: texto_para_embutir(json.loads(r["report"])) for r in regs}


def embutir(driver: Any, embute: Callable, modelo: str, banco: str = "neo4j", lote: int = 16) -> dict:
    textos = textos_dos_relatorios(driver, banco)
    ids = list(textos)
    for grupo in em_lotes(ids, lote):
        vetores = embute([textos[i] for i in grupo])
        rows = [{"id": i, "vetor": v} for i, v in zip(grupo, vetores, strict=True)]
        driver.execute_query(
            GRAVAR_VETOR, {"rows": rows, "modelo": modelo, "dims": DIMENSOES}, database_=banco
        )
    driver.execute_query(CRIAR_INDICE, database_=banco)
    driver.execute_query("CALL db.awaitIndexes(300)", database_=banco)
    return {"embutidas": len(ids), **estado_do_indice(driver, banco)}


def estado_do_indice(driver: Any, banco: str = "neo4j") -> dict:
    regs = driver.execute_query(
        "SHOW INDEXES YIELD name, type, state, populationPercent, options WHERE name = 'community_vec' "
        "RETURN type, state, populationPercent, options",
        database_=banco,
    )[0]
    if not regs:
        return {"indice": False}
    r = regs[0]
    cfg = r["options"].get("indexConfig", {})
    return {
        "indice": True,
        "estado": r["state"],
        "populado_pct": r["populationPercent"],
        "dimensoes": cfg.get("vector.dimensions"),
        "similaridade": cfg.get("vector.similarity_function"),
    }


def autoteste(driver: Any, embute_consulta: Callable, banco: str = "neo4j") -> dict:
    """Recall@1 de cada relatório re-embutido pelo backend da CPU (empate com texto igual conta como acerto)
    e, só como informação, a busca pelo título com a instrução de consulta (top-3)."""
    textos = textos_dos_relatorios(driver, banco)
    regs = driver.execute_query(
        "MATCH (c:__Community__) WHERE c.title IS NOT NULL RETURN c.id AS id, c.title AS t", database_=banco
    )[0]
    titulos = {r["id"]: r["t"] for r in regs}

    def buscar(vetor: list[float], k: int) -> list[str]:
        regs = driver.execute_query(
            "CALL db.index.vector.queryNodes('community_vec', $k, $v) YIELD node RETURN node.id AS id",
            {"k": k, "v": vetor},
            database_=banco,
        )[0]
        return [r["id"] for r in regs]

    ids = list(textos)
    vetores = [v for g in em_lotes(ids, 16) for v in embute_consulta([textos[i] for i in g])]
    acertos = sum(textos[buscar(v, 1)[0]] == textos[i] for i, v in zip(ids, vetores, strict=True))
    sonda = 0
    for i in ids:
        v = embute_consulta([formatar_consulta(titulos[i])])[0]
        sonda += any(textos[x] == textos[i] for x in buscar(v, 3))
    return {"comunidades": len(ids), "recall_at_1": round(acertos / len(ids), 4),
            "sonda_titulo_top3": round(sonda / len(ids), 4)}  # fmt: skip


SANIDADE = {
    "comunidades_sem_relatorio": "MATCH (c:__Community__) WHERE c.report IS NULL RETURN count(c)",
    "comunidades_sem_embedding": "MATCH (c:__Community__) WHERE c.embedding IS NULL RETURN count(c)",
    "nota_fora_de_0_a_10": "MATCH (c:__Community__) WHERE c.rating < 0 OR c.rating > 10 RETURN count(c)",
    "comunidades_com_omissao_de_contexto": (
        "MATCH (c:__Community__) WHERE c.omittedEntities > 0 OR c.omittedRelationships > 0 RETURN count(c)"
    ),
}


def main() -> None:  # pragma: no cover - orquestração de CLI; a lógica tem testes
    from indexer.grafo import conectar

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("gerar", "embutir", "autoteste", "verificar"))
    ap.add_argument("prefixo", type=Path, nargs="?", default=Path("../data/parsed/bb_fre_2026_recorte"))
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    ap.add_argument("--paralelismo", type=int, default=2)
    a = ap.parse_args()
    driver = conectar(a.raiz)
    try:
        if a.acao == "gerar":
            r = gerar(
                driver, gerador_llama(a.swap), a.prefixo.parent / "relatorios_cache", a.paralelismo, a.banco
            )
        elif a.acao == "embutir":
            r = embutir(driver, embutidor_llama(a.swap, MODELO_LOTE), MODELO_LOTE, a.banco)
        elif a.acao == "autoteste":
            r = {
                **estado_do_indice(driver, a.banco),
                **autoteste(driver, embutidor_llama(a.swap, MODELO_CONSULTA), a.banco),
            }
        else:
            r = {k: driver.execute_query(c, database_=a.banco)[0][0][0] for k, c in SANIDADE.items()}
        print(json.dumps(r, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
