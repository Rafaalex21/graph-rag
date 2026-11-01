"""Catálogo de métricas canônicas e mapeamento terminológico PT↔EN (ARQUITETURA §6.2 e §7.3, tarefa F4.6).

`contracts/metricas.json` lista as métricas canônicas (nome em inglês, nome em português, tipo, definição e
aliases). Cada rótulo de métrica que a extração produziu ("Financiamentos Rurais", "Quantidade de empregados -
Feminino - Norte") é ligado a uma delas pelo vínculo `OF_METRIC`:

1. o rótulo igual a um termo do catálogo (nome, nome em português ou alias) dispensa o LLM;
2. os demais vão ao LLM, que escolhe uma métrica do catálogo (ou "nenhuma") por gramática JSON.

Recorte não é métrica: o componente, a região, a faixa de prazo ou o segmento de cliente vão em `dimensao`,
e a variação ou o percentual do total em `qualificador`. O total sem recorte tem `dimensao` nula e
`qualificador` "nenhum", que é o que `fato_financeiro` deve devolver por padrão (ADR-037).

Uso, a partir de `indexer/`:
    uv run python -m indexer.catalogo validar
    uv run python -m indexer.catalogo termo faturamento
    uv run python -m indexer.catalogo mapear ../data/parsed/bb_fre_2026_recorte     # LLM (perfil indexar)
    uv run python -m indexer.catalogo medir ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.importar import normalizar
from indexer.lastro import ACEITO, _pedidos

CATALOGO = Path(__file__).resolve().parents[3] / "contracts" / "metricas.json"
MODELO_LLM = "qwen36-35b-a3b"
# v1 (só rótulo e evidência) ligou 695 de 807 fatos; v2 acrescentou a seção e duas regras (757); v3, os
# rótulos vizinhos da mesma tabela (ADR-037)
VERSAO_DO_PROMPT = "v3"
MAX_IRMAS = 8
LIMITES_DE_TOKENS = (300, 1200)
NENHUMA = "nenhuma"
QUALIFICADORES = ("nenhum", "variacao_percentual", "variacao_absoluta", "percentual_do_total")
CAMPOS = ("id", "name", "name_pt", "kind", "definition", "aliases")

SISTEMA = """\
Você liga rótulos de métricas de um relatório financeiro em português a um catálogo de métricas canônicas.

Regras:
- Escolha em `metrica` o id do catálogo que o rótulo mede. Use "nenhuma" quando nenhuma métrica descreve o \
que o rótulo mede; não escolha a mais parecida quando o conceito é outro.
- Recorte não é métrica. Se o rótulo é um componente, subtipo ou recorte (por região, gênero, idade, prazo, \
produto, segmento de cliente, órgão), escolha a métrica do conceito medido e escreva o recorte em \
`dimensao`, curto, como aparece no rótulo. O total, sem recorte, tem `dimensao` nula.
- `qualificador`: "nenhum" para o valor em si; "variacao_percentual" para variação ou crescimento em %; \
"variacao_absoluta" para acréscimo ou variação em valor; "percentual_do_total" para a fatia em % de um total \
("% em relação ao passivo total"). Um rótulo que mede a métrica X como fatia ou variação continua sendo a \
métrica X, com o qualificador: "Patrimônio Líquido % em relação ao passivo total" é `equity` com \
"percentual_do_total".
- Quando o rótulo é só o nome de um produto, segmento, região ou linha ("Conta Corrente", "Agronegócios"), \
descubra a métrica pela seção do documento, pela evidência e pelos outros rótulos da mesma tabela: se os \
vizinhos são "Carteira de Crédito" e "Carteira Sustentável", o segmento é um recorte da carteira de crédito.
- Linhas de sensibilidade a fatores de risco de mercado (taxas de juros, câmbio, índices de preços) são \
`market_risk_sensitivity`, com o fator em `dimensao`; as parcelas de risco de crédito, de mercado e \
operacional dos ativos ponderados são `risk_weighted_assets`.
- `justificativa`: uma frase curta.

Catálogo (id | nome | nome em português | definição):
{catalogo}
"""

PEDIDO = """\
Rótulo da métrica: {rotulo}
Seção do documento: {secao}
Outros rótulos da mesma tabela ou trecho: {irmas}
Fatos com esse rótulo: {n}
Unidades vistas: {unidades}
Páginas: {paginas}
Entidade do primeiro fato: {entidade}
Evidências:
{evidencias}
"""


def ler_catalogo(caminho: Path = CATALOGO) -> list[dict]:
    return json.loads(caminho.read_text(encoding="utf-8"))["metricas"]


def tipos_do_catalogo(caminho: Path = CATALOGO) -> list[str]:
    return json.loads(caminho.read_text(encoding="utf-8"))["tipos"]


def termos(metrica: dict) -> list[str]:
    """Os sinônimos da métrica: o termo é o total dela."""
    return [metrica["name"], metrica["name_pt"], *metrica["aliases"]]


def componentes(metrica: dict) -> list[str]:
    """Termos que designam uma parte da métrica (campo opcional `componentes` do catálogo)."""
    return list(metrica.get("componentes", []))


def validar(catalogo: list[dict], tipos: list[str]) -> list[str]:
    """Problemas do catálogo; vazio quando está íntegro. Um termo não pode apontar para duas métricas."""
    problemas: list[str] = []
    ids, nomes, dono = set(), set(), {}
    for m in catalogo:
        falta = [c for c in CAMPOS if c not in m]
        if falta:
            problemas.append(f"{m.get('id', '?')}: faltam campos {falta}")
            continue
        if m["id"] in ids:
            problemas.append(f"id repetido: {m['id']}")
        if m["name"] in nomes:
            problemas.append(f"nome repetido: {m['name']}")
        ids.add(m["id"])
        nomes.add(m["name"])
        if m["kind"] not in tipos:
            problemas.append(f"{m['id']}: tipo {m['kind']!r} fora de {tipos}")
        if not m["definition"].strip():
            problemas.append(f"{m['id']}: definição vazia")
        for t in [*termos(m), *componentes(m)]:
            chave = normalizar(t)
            if not chave:
                problemas.append(f"{m['id']}: termo vazio ({t!r})")
            elif dono.setdefault(chave, m["id"]) != m["id"]:
                problemas.append(f"termo {t!r} aponta para {dono[chave]} e {m['id']}")
    return problemas


def indice_de_termos(catalogo: list[dict]) -> dict[str, str]:
    """Termo normalizado (nome, nome em português ou alias) → id da métrica."""
    saida: dict[str, str] = {}
    for m in catalogo:
        for t in termos(m):
            saida.setdefault(normalizar(t), m["id"])
    return saida


def indice_de_componentes(catalogo: list[dict]) -> dict[str, str]:
    """Termo de componente normalizado → id da métrica da qual ele é uma parte."""
    return {normalizar(t): m["id"] for m in catalogo for t in componentes(m)}


def buscar_termo(texto: str, indice: dict[str, str]) -> str | None:
    """Mapeamento terminológico da §7.3: "faturamento", "receita" e "revenue" → `net_revenue`."""
    return indice.get(normalizar(texto))


SEM_DIMENSAO = {"", "nenhuma", "nenhum", "null", "none", "n/a", "na", "-", "não se aplica", "não aplicável"}


def _dimensao(valor: str | None) -> str | None:
    """O modelo às vezes escreve "nenhuma" no campo em vez de deixá-lo nulo; isso não é um recorte."""
    texto = (valor or "").strip()
    return None if texto.lower() in SEM_DIMENSAO else texto


def _secao(pedido: str | None) -> str | None:
    """A linha `Seção: ...` do texto que a extração recebeu (o caminho do trecho no documento)."""
    for linha in (pedido or "").splitlines():
        if linha.startswith("Seção:"):
            return linha.removeprefix("Seção:").strip()
    return None


def rotulos(registros: list[dict], pedidos: dict[str, str] | None = None) -> dict[str, dict]:
    """Rótulos distintos dos fatos aceitos, com o contexto que o LLM precisa para decidir.

    `pedidos` é o texto enviado ao extrator por unidade; dele sai a seção do primeiro fato de cada rótulo.
    `irmas` são os outros rótulos da unidade (Pai ou Tabela) do primeiro fato, na ordem em que aparecem: o
    nome de um segmento ("Agronegócios") só diz a que se refere ao lado dos rótulos vizinhos.
    """
    saida: dict[str, dict] = {}
    da_unidade: dict[str, list[str]] = {}
    for r in registros:
        if r["motivo"] != ACEITO:
            continue
        f = r["fato"]
        c = saida.setdefault(
            f["metric"],
            {
                "n": 0,
                "unidades": Counter(),
                "paginas": set(),
                "evidencias": [],
                "entidade": None,
                "secao": None,
                "unidade_de_referencia": r["unidade"],
            },
        )
        rotulos_da_unidade = da_unidade.setdefault(r["unidade"], [])
        if f["metric"] not in rotulos_da_unidade:
            rotulos_da_unidade.append(f["metric"])
        c["n"] += 1
        c["secao"] = c["secao"] or _secao((pedidos or {}).get(r["unidade"]))
        c["unidades"][f["unit"]] += 1
        c["paginas"].add(r["paginas"][0])
        if len(c["evidencias"]) < 2 and f["evidence"] not in c["evidencias"]:
            c["evidencias"].append(f["evidence"])
        c["entidade"] = c["entidade"] or f.get("entity")
    for rotulo, c in saida.items():
        vizinhos = [x for x in da_unidade[c["unidade_de_referencia"]] if x != rotulo]
        c["irmas"] = vizinhos[:MAX_IRMAS]
    return saida


def _catalogo_no_prompt(catalogo: list[dict]) -> str:
    return "\n".join(f"{m['id']} | {m['name']} | {m['name_pt']} | {m['definition']}" for m in catalogo)


def montar_pedido(rotulo: str, ctx: dict) -> str:
    evidencias = "\n".join(f"- {e[:220]}" for e in ctx["evidencias"]) or "- não disponível"
    return PEDIDO.format(
        rotulo=rotulo,
        secao=ctx.get("secao") or "não informada",
        irmas="; ".join(ctx.get("irmas") or []) or "nenhum",
        n=ctx["n"],
        unidades=", ".join(f"{u} ({n})" for u, n in ctx["unidades"].most_common()),
        paginas=", ".join(str(p) for p in sorted(ctx["paginas"])[:6]),
        entidade=ctx["entidade"] or "não informada",
        evidencias=evidencias,
    )


def esquema_do_juiz(catalogo: list[dict]) -> dict:
    return {
        "type": "object",
        "properties": {
            "metrica": {"type": "string", "enum": [*(m["id"] for m in catalogo), NENHUMA]},
            "dimensao": {"type": ["string", "null"]},
            "qualificador": {"type": "string", "enum": list(QUALIFICADORES)},
            "justificativa": {"type": "string"},
        },
        "required": ["metrica", "dimensao", "qualificador", "justificativa"],
        "additionalProperties": False,
    }


Juiz = Callable[[list[dict]], dict]


def juiz_llama(base: str, catalogo: list[dict], modelo: str = MODELO_LLM, timeout: int = 300) -> Juiz:
    """Função mensagens -> {metrica, dimensao, qualificador, justificativa}; a gramática impõe o catálogo."""
    esquema = esquema_do_juiz(catalogo)

    def julga(mensagens: list[dict]) -> dict:
        # uma justificativa longa estoura o limite e o JSON vem cortado: tenta de novo com mais espaço
        for limite in LIMITES_DE_TOKENS:
            corpo = {
                "model": modelo,
                "messages": mensagens,
                "temperature": 0,
                "max_tokens": limite,
                "chat_template_kwargs": {"enable_thinking": False},
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "metrica_canonica", "strict": True, "schema": esquema},
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
            except json.JSONDecodeError:
                continue
        raise ValueError(f"resposta do LLM não é JSON mesmo com {LIMITES_DE_TOKENS[-1]} tokens")

    return julga


def _chave_de_cache(sistema: str, pedido: str, modelo: str) -> str:
    return hashlib.sha256(f"{VERSAO_DO_PROMPT}\x1f{modelo}\x1f{sistema}\x1f{pedido}".encode()).hexdigest()[
        :20
    ]


def mapear(
    contexto: dict[str, dict],
    catalogo: list[dict],
    juiz: Juiz,
    cache: Path,
    modelo: str = MODELO_LLM,
) -> dict[str, dict]:
    """Rótulo → {metrica, dimensao, qualificador, por}. Termo exato do catálogo não usa o LLM."""
    indice = indice_de_termos(catalogo)
    partes = indice_de_componentes(catalogo)
    ids = {m["id"] for m in catalogo}
    tipos = {m["id"]: m["kind"] for m in catalogo}
    sistema = SISTEMA.format(catalogo=_catalogo_no_prompt(catalogo))
    cache.mkdir(parents=True, exist_ok=True)
    saida: dict[str, dict] = {}
    for rotulo in sorted(contexto):
        exato = buscar_termo(rotulo, indice)
        if exato:
            saida[rotulo] = {"metrica": exato, "dimensao": None, "qualificador": "nenhum", "por": "termo"}
            continue
        parte = partes.get(normalizar(rotulo))
        if parte:
            saida[rotulo] = {"metrica": parte, "dimensao": rotulo, "qualificador": "nenhum", "por": "termo"}
            continue
        pedido = montar_pedido(rotulo, contexto[rotulo])
        arq = cache / f"{_chave_de_cache(sistema, pedido, modelo)}.json"
        if arq.exists():
            r = json.loads(arq.read_text(encoding="utf-8"))
        else:
            r = juiz([{"role": "system", "content": sistema}, {"role": "user", "content": pedido}])
            arq.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        metrica = r["metrica"] if r["metrica"] in ids else NENHUMA
        qualificador = r["qualificador"] if r["qualificador"] in QUALIFICADORES else "nenhum"
        dimensao = _dimensao(r.get("dimensao")) if metrica != NENHUMA else None
        if metrica != NENHUMA:
            if qualificador == "percentual_do_total" and tipos[metrica] == "percent":
                qualificador = "nenhum"  # a métrica já é um percentual: a fatia seria redundante
            if dimensao is None and qualificador == "nenhum":
                # o rótulo não é um termo do catálogo (esse caso nem chega aqui), então não é "o" total da
                # métrica; sem recorte declarado, o próprio rótulo fica como dimensão e `dimension` nula
                # passa a querer dizer "o termo do catálogo" (ADR-037)
                dimensao = rotulo
        saida[rotulo] = {
            "metrica": metrica,
            "dimensao": dimensao,
            "qualificador": qualificador,
            "por": "llm",
            "justificativa": r.get("justificativa", ""),
        }
    return saida


def id_do_no(metrica_id: str) -> str:
    return f"metric:{metrica_id}"


def linhas_de_metricas(catalogo: list[dict], mapa: dict[str, dict], fatos: dict[str, dict]) -> dict:
    """Linhas para o importador: um nó `Metric` por métrica do catálogo e um `OF_METRIC` por fato mapeado.

    `fatos` é o `{id: {"id", "props"}}` do importador; o vínculo vem do rótulo `props["metric"]`.
    """
    nos = [
        {
            "id": id_do_no(m["id"]),
            "props": {
                "id": id_do_no(m["id"]),
                "name": m["name"],
                "namePt": m["name_pt"],
                "kind": m["kind"],
                "definition": m["definition"],
                "aliases": sorted(set(m["aliases"])),
            },
        }
        for m in catalogo
    ]
    vinculos = []
    for fid in sorted(fatos):
        m = mapa.get(fatos[fid]["props"]["metric"])
        if m and m["metrica"] != NENHUMA:
            vinculos.append(
                {
                    "de": fid,
                    "para": id_do_no(m["metrica"]),
                    "qualifier": m["qualificador"],
                    "dimension": m["dimensao"],
                }
            )
    return {"metricas": nos, "of_metric": vinculos}


def resumo(mapa: dict[str, dict], contexto: dict[str, dict]) -> dict[str, Any]:
    """Quantos rótulos e quantos fatos foram ligados, por forma de decisão."""
    fatos_total = sum(c["n"] for c in contexto.values())
    ligados = sum(contexto[r]["n"] for r, m in mapa.items() if m["metrica"] != NENHUMA)
    por = Counter(m["por"] for m in mapa.values())
    return {
        "rotulos": len(mapa),
        "rotulos_ligados": sum(m["metrica"] != NENHUMA for m in mapa.values()),
        "fatos": fatos_total,
        "fatos_ligados": ligados,
        "fracao_de_fatos_ligados": round(ligados / fatos_total, 4) if fatos_total else 0.0,
        "por_termo": por.get("termo", 0),
        "por_llm": por.get("llm", 0),
        "com_dimensao": sum(bool(m["dimensao"]) for m in mapa.values()),
        "com_qualificador": sum(m["qualificador"] != "nenhum" for m in mapa.values()),
        "metricas_usadas": len({m["metrica"] for m in mapa.values() if m["metrica"] != NENHUMA}),
    }


def arquivo_do_mapa(prefixo: Path) -> Path:
    return Path(f"{prefixo}.metricas.json")


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("validar", "termo", "mapear", "medir"))
    ap.add_argument("alvo", nargs="?", help="termo (acao=termo) ou prefixo dos arquivos (mapear e medir)")
    ap.add_argument("--doc-id", default=None)
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    catalogo = ler_catalogo()
    if a.acao == "validar":
        problemas = validar(catalogo, tipos_do_catalogo())
        print(json.dumps({"metricas": len(catalogo), "problemas": problemas}, ensure_ascii=False, indent=1))
        raise SystemExit(1 if problemas else 0)
    if a.acao == "termo":
        achou = buscar_termo(a.alvo or "", indice_de_termos(catalogo))
        print(json.dumps({"termo": a.alvo, "metrica": achou}, ensure_ascii=False))
        return
    prefixo = Path(a.alvo)
    if a.acao == "mapear":
        registros = json.loads(Path(f"{prefixo}.fatos.json").read_text(encoding="utf-8"))
        contexto = rotulos(registros, _pedidos(prefixo))
        mapa = mapear(contexto, catalogo, juiz_llama(a.swap, catalogo), prefixo.parent / "metricas_cache")
        saida = {"versao_do_catalogo": 1, "mapa": mapa, "resumo": resumo(mapa, contexto)}
        arquivo_do_mapa(prefixo).write_text(json.dumps(saida, ensure_ascii=False, indent=1), "utf-8")
        print(json.dumps(saida["resumo"], ensure_ascii=False, indent=1))
        return
    from indexer.grafo import conectar

    driver = conectar(a.raiz)
    try:

        def um(cypher: str) -> int:
            return int(driver.execute_query(cypher, database_=a.banco)[0][0][0])

        fatos = um("MATCH (f:FinancialFact) RETURN count(f)")
        ligados = um("MATCH (f:FinancialFact)-[:OF_METRIC]->(:Metric) RETURN count(DISTINCT f)")
        print(json.dumps({"fatos": fatos, "fatos_ligados": ligados,
                          "fracao": round(ligados / fatos, 4) if fatos else 0.0}))  # fmt: skip
    finally:
        driver.close()


if __name__ == "__main__":
    main()
