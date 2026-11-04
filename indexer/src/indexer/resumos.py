"""Resumos de entidades e de relações (§5 I-8, F5.4).

A extração aberta deixa, por entidade, uma lista de descrições (uma por Pai) e, por par de entidades, uma
lista de descrições da relação `RELATED_TO`. Aqui cada lista com mais de um texto vira um resumo só, escrito
pelo Qwen3.6 com o prompt do MS GraphRAG adaptado ao português; com um texto só, o resumo é o próprio texto
(sem LLM) e uma entidade sem descrição nenhuma ganha uma frase com o nome e o tipo (`summarySource`).

- **Contexto:** cada pedido tem no máximo `MAX_CHARS_PEDIDO` caracteres (≈ 8 mil tokens, metade do slot de
  16 mil do llama-swap) e cada texto é cortado em `MAX_CHARS_TEXTO`. O `tokens_prompt` que o servidor devolve
  é guardado para conferir.
- **Supernó:** o emissor aparece em quase todo Pai. Suas descrições são ordenadas por diversidade de seção
  (uma de cada seção por vez), limitadas a `TETO_DE_DESCRICOES` e resumidas em níveis: lotes de `LOTE` textos
  viram resumos parciais, que viram lotes de novo até sobrar um. Vale para qualquer entidade com mais de um
  lote; o emissor ganha o rótulo `:Issuer` para a F5.5 tirá-lo da projeção.
- **Escrita:** `__Entity__.summary`, `summarySource` (`llm`, `descricao` ou `nome`) e, para cada `RELATED_TO`,
  `(:__Entity__)-[:SUMMARIZED_RELATIONSHIP {summary, weight, rank}]->(:__Entity__)` (peso = força, `rank` =
  soma dos graus dos dois extremos). As relações `SUMMARIZED_RELATIONSHIP` são derivadas: cada execução as
  refaz do zero. Os pedidos ficam em cache por hash em `data/parsed/resumos_cache/`.

Precisa do Neo4j e do llama-swap (perfil `indexar`). Uso, a partir de `indexer/`:
    uv run python -m indexer.resumos executar ../data/parsed/bb_fre_2026_recorte
    uv run python -m indexer.resumos verificar ../data/parsed/bb_fre_2026_recorte
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from indexer.extrair import MODELO_LLM
from indexer.importar import normalizar

VERSAO_DO_PROMPT = "v2"
LOTE = 30  # descrições por pedido (ARQUITETURA §5 I-8)
TETO_DE_DESCRICOES = 300  # por entidade; o excedente (já ranqueado por diversidade) é descartado e contado
MAX_CHARS_TEXTO = 2000  # uma descrição passa de 300; um resumo parcial, de 700; isto é só trava
MAX_CHARS_PEDIDO = 24000  # ≈ 8 mil tokens a 3 caracteres por token: metade do slot de 16 mil do llama-swap
MAX_CHARS_RESUMO = 700  # trava da gramática; o prompt pede menos para a frase não ser cortada
ALVO_DO_RESUMO = 550
MAX_TOKENS_SAIDA = 500

Gerador = Callable[[list[dict]], dict]

TIPOS_EM_PORTUGUES = {
    "ORGANIZATION": "organização",
    "PERSON": "pessoa",
    "SEGMENT": "segmento",
    "PRODUCT_OR_SERVICE": "produto ou serviço",
    "FINANCIAL_METRIC": "indicador financeiro",
    "RISK": "risco",
    "EVENT": "evento",
    "FINANCIAL_INSTRUMENT": "instrumento financeiro",
    "REGULATION": "norma",
    "POLICY_OR_PROGRAM": "política ou programa",
    "LOCATION": "local",
}
ESQUEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary"],
    "properties": {"summary": {"type": "string", "maxLength": MAX_CHARS_RESUMO}},
}
SISTEMA = (
    "Você escreve descrições abrangentes a partir de dados de um documento financeiro em português. "
    "Receberá o nome de uma entidade (ou de um par de entidades) e uma lista de descrições, todas sobre ela. "
    "Junte as descrições numa única descrição coerente, em terceira pessoa, citando o nome da entidade. "
    "Se as descrições se contradizem, resolva a contradição e escreva um resumo coerente. Use somente o que "
    "as descrições dizem; não acrescente fatos nem números. Responda só com o JSON pedido. O resumo tem "
    f"no máximo {ALVO_DO_RESUMO} caracteres e termina em frase completa; priorize o que é mais "
    "característico da entidade."
)
PEDIDO = """{alvo}

Descrições:
{lista}

Escreva a descrição única."""


def ranquear(itens: list[dict]) -> list[str]:
    """Textos em rodízio entre as seções, uma de cada por vez, na ordem de chegada de seções e de textos.

    A diversidade vem primeiro: se o teto cortar o excedente, o que fica cobre o maior número de seções.
    Texto sem seção conhecida (`None`) forma uma seção própria."""
    por_secao: dict[Any, list[str]] = {}
    for i in itens:
        por_secao.setdefault(i["secao"], []).append(i["texto"])
    filas = list(por_secao.values())
    saida = []
    for rodada in range(max((len(f) for f in filas), default=0)):
        saida += [f[rodada] for f in filas if rodada < len(f)]
    return saida


def montar_pedido(nome: str, tipo: str, textos: list[str]) -> str:
    if tipo == "RELACAO":
        alvo = f"Relação entre as entidades: {nome}"
    else:
        alvo = f"Entidade: {nome} (tipo: {tipo})"
    lista = "\n".join(f"{i}. {t[:MAX_CHARS_TEXTO]}" for i, t in enumerate(textos, 1))
    return PEDIDO.format(alvo=alvo, lista=lista)


def resumo_sem_descricao(nome: str, tipo: str) -> str:
    return f"{nome} ({TIPOS_EM_PORTUGUES.get(tipo, tipo.lower())})."


def aparar(resumo: str) -> str:
    """Se a gramática cortou o resumo no limite, volta ao fim da última frase completa; senão não mexe."""
    if len(resumo) < MAX_CHARS_RESUMO or resumo.rstrip()[-1] in ".!?":
        return resumo
    fim = max(resumo.rfind(c) for c in (". ", "! ", "? "))
    return resumo[: fim + 1] if fim > 0 else resumo


def _lotes(nome: str, tipo: str, textos: list[str]) -> list[list[str]]:
    """Quebra em lotes de até `LOTE` textos cujo pedido cabe em `MAX_CHARS_PEDIDO`."""
    lotes: list[list[str]] = []
    atual: list[str] = []
    for t in textos:
        if atual and (len(atual) >= LOTE or len(montar_pedido(nome, tipo, [*atual, t])) > MAX_CHARS_PEDIDO):
            lotes.append(atual)
            atual = []
        atual.append(t)
    if atual:
        lotes.append(atual)
    return lotes


def _chave(pedido: str, modelo: str) -> str:
    return hashlib.sha256(f"{VERSAO_DO_PROMPT}\x1f{modelo}\x1f{SISTEMA}\x1f{pedido}".encode()).hexdigest()[
        :20
    ]


def _um_pedido(nome: str, tipo: str, lote: list[str], gera: Gerador, cache: Path, modelo: str) -> dict:
    pedido = montar_pedido(nome, tipo, lote)
    arq = cache / f"{_chave(pedido, modelo)}.json"
    if arq.exists():
        dado = json.loads(arq.read_text(encoding="utf-8"))
        return {**dado, "summary": aparar(dado["summary"]), "chamou": False}
    for _ in range(2):
        r = gera([{"role": "system", "content": SISTEMA}, {"role": "user", "content": pedido}])
        resumo = aparar((r.get("summary") or "").strip())
        if resumo:
            dado = {"summary": resumo, "tokens_prompt": r.get("tokens_prompt", 0)}
            cache.mkdir(parents=True, exist_ok=True)
            arq.write_text(json.dumps(dado, ensure_ascii=False, indent=1), encoding="utf-8")
            return {**dado, "chamou": True}
    raise ValueError(f"resumo vazio para {nome!r} depois de duas tentativas")


def resumir_textos(
    nome: str, tipo: str, textos: list[str], gera: Gerador, cache: Path, modelo: str = MODELO_LLM
) -> dict | None:
    """Um resumo para a lista de descrições, em quantos níveis forem precisos; `None` se não há texto."""
    if not textos:
        return None
    if len(textos) == 1:
        return {"summary": textos[0], "chamadas": 0, "niveis": 0, "usadas": 1, "descartadas": 0,
                "max_tokens_prompt": 0}  # fmt: skip
    usadas = textos[:TETO_DE_DESCRICOES]
    atual, niveis, chamadas, maximo = [t[:MAX_CHARS_TEXTO] for t in usadas], 0, 0, 0
    while True:
        lotes = _lotes(nome, tipo, atual)
        parciais = []
        for lote in lotes:
            r = _um_pedido(nome, tipo, lote, gera, cache, modelo)
            chamadas += r["chamou"]
            maximo = max(maximo, r["tokens_prompt"])
            parciais.append(r["summary"])
        niveis += 1
        if len(lotes) == 1:
            return {"summary": parciais[0], "chamadas": chamadas, "niveis": niveis, "usadas": len(usadas),
                    "descartadas": len(textos) - len(usadas), "max_tokens_prompt": maximo}  # fmt: skip
        atual = parciais


def gerador_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 900) -> Gerador:
    def gera(mensagens: list[dict]) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.1,
            "max_tokens": MAX_TOKENS_SAIDA,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "resumo", "strict": True, "schema": ESQUEMA},
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
            resumo = json.loads(dados["choices"][0]["message"]["content"])["summary"]
        except (json.JSONDecodeError, KeyError):
            resumo = ""  # `_um_pedido` tenta de novo e, na segunda, levanta o erro
        return {"summary": resumo, "tokens_prompt": dados.get("usage", {}).get("prompt_tokens", 0)}

    return gera


# ---- Neo4j ----------------------------------------------------------------------------------------------


def ler_entidades(driver: Any, banco: str = "neo4j") -> list[dict]:
    """Entidades com as descrições na ordem do ranking (diversidade de seção)."""
    secoes, _, _ = driver.execute_query(
        "MATCH (s:Section)-[:HAS_PARENT]->(p:Parent) RETURN p.id AS pai, s.id AS secao, s.order AS ordem",
        database_=banco,
    )
    secao_de = {r["pai"]: (r["ordem"] if r["ordem"] is not None else 10**9, r["secao"]) for r in secoes}
    registros, _, _ = driver.execute_query(
        "MATCH (e:__Entity__) RETURN e.id AS id, e.name AS name, e.type AS type, e.aliases AS aliases, "
        "e.description AS description, coalesce(e.descriptions, []) AS descriptions, "
        "coalesce(e.descriptionParents, []) AS parents ORDER BY e.id",
        database_=banco,
    )
    saida = []
    for r in registros:
        e = dict(r)
        itens = [
            (secao_de.get(p, (10**9, None)), t) for t, p in zip(e["descriptions"], e["parents"], strict=True)
        ]
        itens.sort(key=lambda x: (x[0], x[1]))
        textos = ([e["description"]] if e["description"] else []) + ranquear(
            [{"texto": t, "secao": s[1]} for s, t in itens]
        )
        saida.append(
            {"id": e["id"], "name": e["name"], "type": e["type"], "aliases": e["aliases"], "textos": textos}
        )
    return saida


def ler_relacoes(driver: Any, banco: str = "neo4j") -> list[dict]:
    registros, _, _ = driver.execute_query(
        "MATCH (a:__Entity__)-[x:RELATED_TO]->(b:__Entity__) "
        "RETURN a.id AS de, b.id AS para, a.name AS a_nome, b.name AS b_nome, x.descriptions AS textos, "
        "x.strength AS peso, count { (a)-[:RELATED_TO]-() } + count { (b)-[:RELATED_TO]-() } AS rank "
        "ORDER BY de, para",
        database_=banco,
    )
    return [dict(r) for r in registros]


def achar_emissor(entidades: list[dict], emissor: str) -> str | None:
    """Id da organização cujo nome ou alias normalizado é o do emissor do documento."""
    alvo = normalizar(emissor)
    for e in entidades:
        if e["type"] == "ORGANIZATION" and alvo in {
            normalizar(n) for n in [e["name"], *(e["aliases"] or [])]
        }:
            return e["id"]
    return None


def gravar(
    driver: Any, entidades: list[dict], relacoes: list[dict], emissor_id: str | None, banco: str = "neo4j"
) -> None:
    driver.execute_query(
        "UNWIND $rows AS r MATCH (e:__Entity__ {id: r.id}) "
        "SET e.summary = r.summary, e.summarySource = r.fonte, e.summaryDescriptions = r.n",
        {
            "rows": [
                {"id": e["id"], "summary": e["summary"], "fonte": e["fonte"], "n": e["n"]} for e in entidades
            ]
        },
        database_=banco,
    )
    driver.execute_query("MATCH (e:Issuer) REMOVE e:Issuer", database_=banco)
    if emissor_id:
        driver.execute_query(
            "MATCH (e:__Entity__ {id: $id}) SET e:Issuer", {"id": emissor_id}, database_=banco
        )
    driver.execute_query("MATCH ()-[x:SUMMARIZED_RELATIONSHIP]->() DELETE x", database_=banco)
    driver.execute_query(
        "UNWIND $rows AS r MATCH (a:__Entity__ {id: r.de}), (b:__Entity__ {id: r.para}) "
        "MERGE (a)-[x:SUMMARIZED_RELATIONSHIP]->(b) "
        "SET x.summary = r.summary, x.weight = r.peso, x.rank = r.rank",
        {"rows": [{k: r[k] for k in ("de", "para", "summary", "peso", "rank")} for r in relacoes]},
        database_=banco,
    )


SANIDADE = {
    "entidades_sem_resumo": "MATCH (e:__Entity__) WHERE e.summary IS NULL RETURN count(e)",
    "relacoes_sem_resumo": (
        "MATCH (a)-[x:RELATED_TO]->(b) WHERE NOT (a)-[:SUMMARIZED_RELATIONSHIP]->(b) RETURN count(x)"
    ),
    "resumos_de_relacao_sem_relacao": (
        "MATCH (a)-[x:SUMMARIZED_RELATIONSHIP]->(b) WHERE NOT (a)-[:RELATED_TO]->(b) RETURN count(x)"
    ),
    "emissores": "MATCH (e:Issuer) RETURN count(e)",
}


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    from indexer.grafo import conectar

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("executar", "verificar"))
    ap.add_argument("prefixo", type=Path)
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    ap.add_argument("--paralelismo", type=int, default=2)
    a = ap.parse_args()
    cache = a.prefixo.parent / "resumos_cache"
    driver = conectar(a.raiz)
    try:
        if a.acao == "verificar":
            saida = {k: driver.execute_query(q, database_=a.banco)[0][0][0] for k, q in SANIDADE.items()}
            print(json.dumps(saida, ensure_ascii=False, indent=1))
            return
        emissor = driver.execute_query("MATCH (d:Document) RETURN d.issuer AS e LIMIT 1", database_=a.banco)[
            0
        ][0]["e"]
        entidades, relacoes = ler_entidades(driver, a.banco), ler_relacoes(driver, a.banco)
        gera = gerador_llama(a.swap)

        def resumir(item: dict, nome: str, tipo: str, textos: list[str]) -> None:
            r = resumir_textos(nome, tipo, textos, gera, cache)
            item["res"] = r

        with ThreadPoolExecutor(a.paralelismo) as pool:
            list(pool.map(lambda e: resumir(e, e["name"], e["type"], e["textos"]), entidades))
            list(pool.map(
                lambda r: resumir(r, f"{r['a_nome']} -> {r['b_nome']}", "RELACAO", r["textos"]), relacoes
            ))  # fmt: skip
        estat = {"entidades": {"llm": 0, "descricao": 0, "nome": 0}, "relacoes": {"llm": 0, "descricao": 0}}
        for e in entidades:
            r = e.pop("res")
            if r is None:
                e.update(summary=resumo_sem_descricao(e["name"], e["type"]), fonte="nome", n=0)
            else:
                e.update(summary=r["summary"], fonte="llm" if r["niveis"] else "descricao", n=r["usadas"])
            estat["entidades"][e["fonte"]] += 1
            e["_r"] = r
        for x in relacoes:
            r = x.pop("res")
            x["summary"] = r["summary"] if r else f"{x['a_nome']} e {x['b_nome']} estão relacionados."
            estat["relacoes"]["llm" if r and r["niveis"] else "descricao"] += 1
            x["_r"] = r
        todos = [i["_r"] for i in (*entidades, *relacoes) if i["_r"]]
        emissor_id = achar_emissor(entidades, emissor)
        gravar(driver, entidades, relacoes, emissor_id, a.banco)
        saida = {
            "emissor": emissor, "emissor_id": emissor_id, "resumos": estat,
            "chamadas_novas": sum(r["chamadas"] for r in todos),
            "max_tokens_prompt": max((r["max_tokens_prompt"] for r in todos), default=0),
            "niveis_maximos": max((r["niveis"] for r in todos), default=0),
            "descartadas_pelo_teto": sum(r["descartadas"] for r in todos),
            "emissor_niveis": next(
                (e["_r"]["niveis"] for e in entidades if e["id"] == emissor_id and e["_r"]), None
            ),
            "sanidade": {k: driver.execute_query(q, database_=a.banco)[0][0][0] for k, q in SANIDADE.items()},
        }  # fmt: skip
        print(json.dumps(saida, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
