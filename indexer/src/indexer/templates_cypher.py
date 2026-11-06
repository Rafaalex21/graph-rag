"""Templates Cypher (F6.3, ARQUITETURA §7.2): `fato_financeiro`, `serie_metrica`, `comparar_segmentos`,
`riscos`, `eventos` e `pessoas_cargos`.

Cada ferramenta recebe o texto do roteador ("lucro líquido", "4T25", "diretora presidente"), resolve-o para o
que o grafo guarda (métrica canônica, id de período, nome exato de entidade) e roda uma consulta **fixa**,
somente leitura e com `LIMIT`; o texto do usuário só entra como parâmetro. O resultado segue o contrato das
outras ferramentas: `evidencias[]` com `id`, `tipo`, `paginas`, `caminho`, `texto` e `score`, mais os campos
estruturados de cada ferramenta (`fatos`, `pontos`, `segmentos`, `pessoas`), `aviso`, `erro` e `sugestoes`.
Nada é inventado: sem resultado, a lista vem vazia e o `aviso` diz por quê; falha do grafo vira `erro`.

O que o grafo real obriga (ADR-048):
- fatos repetem o mesmo valor em escalas diferentes ("R$ 16,8 bilhões" e "R$ 16.782 milhões") e em páginas
  diferentes: são um só, com as duas páginas; valores que divergem de verdade ficam separados e marcados;
- o total é o fato sem recorte (`OF_METRIC.dimension` nulo) e o recorte é a `dimension`; é por ela que se
  compara segmento, porque `HAS_SEGMENT` não existe no grafo indexado;
- sem período, vale o mais recente **até o ano-base do documento** (há valores de 2026 que são projeção);
- a unidade tem de combinar com o tipo da métrica (ADR-037), senão um percentual de crescimento entra no
  saldo;
- a extração gravou alguns cargos como nome de pessoa; o resultado avisa (`nome_parece_cargo`).

Uso, a partir de `indexer/`, com o Neo4j no ar:
    uv run python -m indexer.templates_cypher fato "lucro líquido" --periodo 2025
    uv run python -m indexer.templates_cypher serie "carteira de crédito"
    uv run python -m indexer.templates_cypher comparar "carteira de crédito" --segmentos Rurais Imobiliário
    uv run python -m indexer.templates_cypher riscos --tema "risco de crédito"
    uv run python -m indexer.templates_cypher eventos --ano 2025
    uv run python -m indexer.templates_cypher pessoas --cargo "diretor presidente"
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import re
import time
import unicodedata
from pathlib import Path
from typing import Any

from indexer.busca_local import rotulo_de_paginas
from indexer.catalogo import ler_catalogo
from indexer.grafo import conectar
from indexer.importar import normalizar

QUALIFICADORES = ("nenhum", "variacao_percentual", "variacao_absoluta", "percentual_do_total")
TIPOS_DE_PERIODO = ("fiscal_year", "quarter", "point_in_time")
CATEGORIAS_DE_RISCO = (
    "market",
    "credit",
    "operational",
    "regulatory",
    "liquidity",
    "currency",
    "sem_categoria",
)
# A unidade que um fato deve ter, conforme o tipo da métrica (ADR-037)
UNIDADE_DO_TIPO = {
    "monetary": "currency",
    "price": "currency",
    "percent": "percent",
    "ratio": "percent",
    "count": "count",
}
LIMITE_FATOS = 500  # linhas lidas do grafo por consulta de fatos
TETO_DE_NOS = 1000  # linhas lidas por consulta de riscos, eventos e pessoas (o grafo tem ~350, ~240 e ~170)
LIMITES_PADRAO = {"fatos": 10, "pontos": 40, "segmentos": 15, "riscos": 10, "eventos": 10, "pessoas": 10}

CONSULTAS = {
    "emissor": "MATCH (d:Document) RETURN d.issuer AS emissor, d.fiscalYear AS ano_base LIMIT 1",
    "entidades_dos_fatos": (
        "MATCH (f:FinancialFact) WHERE f.entity IS NOT NULL "
        "RETURN f.entity AS entidade, count(*) AS n ORDER BY n DESC LIMIT 1000"
    ),
    "fatos": (
        "MATCH (f:FinancialFact)-[r:OF_METRIC]->(m:Metric {id: $metrica}) "
        "MATCH (f)-[:FOR_PERIOD]->(p:Period) "
        "WHERE f.entity IN $entidades AND r.qualifier = $qualificador AND f.unit = $unidade "
        "AND ($periodos IS NULL OR p.id IN $periodos) "
        "AND ($tipo_periodo IS NULL OR f.periodType = $tipo_periodo) "
        "AND (($modo = 'total' AND r.dimension IS NULL) OR ($modo = 'recortes' AND r.dimension IS NOT NULL)) "
        "RETURN f.id AS id, f.value AS valor, f.unit AS unidade, f.currency AS moeda, f.scale AS escala, "
        "p.id AS periodo, p.end AS fim, f.periodType AS tipo_periodo, f.entity AS entidade, "
        "r.qualifier AS qualificador, r.dimension AS dimensao, f.metric AS rotulo, "
        "f.page AS pagina, f.pageEnd AS pagina_fim "
        "ORDER BY p.end DESC, f.scale ASC, f.page ASC LIMIT $limite"
    ),
    "riscos": (
        "MATCH (r:RiskFactor) "
        "WHERE ($categoria IS NULL OR r.category = $categoria) "
        "AND ($sem_categoria = false OR r.category IS NULL) "
        "OPTIONAL MATCH (r)-[:DESCRIBED_IN]->(p:Parent) "
        "WITH r, collect(DISTINCT p.pageStart) AS ini, collect(DISTINCT p.pageEnd) AS fim "
        "RETURN r.id AS id, r.name AS nome, r.category AS categoria, r.summary AS resumo, "
        "r.aliasesText AS apelidos, r.layers AS camadas, ini, fim ORDER BY nome LIMIT $teto"
    ),
    "eventos": (
        "MATCH (e:Event) "
        "OPTIONAL MATCH (e)-[:DESCRIBED_IN|MENTIONED_IN]->(p:Parent) "
        "OPTIONAL MATCH (e)-[:INVOLVES]->(o) "
        "WITH e, collect(DISTINCT p.pageStart) AS paginas, collect(DISTINCT o.name) AS envolvidos "
        "RETURN e.id AS id, e.name AS nome, e.date AS data, e.eventType AS tipo, e.summary AS resumo, "
        "paginas, envolvidos ORDER BY nome LIMIT $teto"
    ),
    "pessoas": (
        "MATCH (p:Person) "
        "OPTIONAL MATCH (p)-[h:HOLDS_POSITION]->(o) "
        "OPTIONAL MATCH (p)-[:MENTIONED_IN]->(x:Parent) "
        "WITH p, h, o, collect(DISTINCT x.pageStart) AS paginas "
        "RETURN p.id AS id, p.name AS nome, p.position AS cargo_no_no, h.title AS cargo, "
        "o.name AS orgao, p.summary AS resumo, paginas ORDER BY nome LIMIT $teto"
    ),
}

# palavras que podem sobrar numa métrica pedida sem mudar o conceito ("o lucro líquido do exercício de 2025")
_SOBRAS_DE_METRICA = {
    "o",
    "a",
    "os",
    "as",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "em",
    "no",
    "na",
    "e",
    "para",
    "qual",
    "foi",
    "quanto",
    "valor",
    "total",
    "ifrs",
    "fy",
    "exercicio",
    "ano",
    "periodo",
}
_SOBRAS_DE_BUSCA = {
    "de",
    "da",
    "do",
    "das",
    "dos",
    "e",
    "o",
    "a",
    "os",
    "as",
    "em",
    "no",
    "na",
    "nos",
    "nas",
    "para",
    "por",
    "com",
    "que",
    "um",
    "uma",
    "sobre",
    "qual",
    "quais",
    "s",
    "sa",
    "ltda",
}
_PALAVRAS_DE_CARGO = {
    "diretor",
    "diretore",  # "Diretores" depois de _raiz
    "presidente",
    "vice",
    "gerente",
    "chefe",
    "membro",
    "conselheiro",
    "secretario",
    "representante",
    "coordenador",
    "superintendente",
    "ouvidor",
    "auditor",
    "diretoria",
    "conselho",
    "comite",
    "assessor",
}
_MESES = {
    "janeiro": 1,
    "fevereiro": 2,
    "marco": 3,
    "abril": 4,
    "maio": 5,
    "junho": 6,
    "julho": 7,
    "agosto": 8,
    "setembro": 9,
    "outubro": 10,
    "novembro": 11,
    "dezembro": 12,
}
_ESCALAS = {
    1_000: ("mil", "mil"),
    1_000_000: ("milhão", "milhões"),
    1_000_000_000: ("bilhão", "bilhões"),
    1_000_000_000_000: ("trilhão", "trilhões"),
}


# ---------- resolução do texto do roteador ----------


def _tokens(texto: str | None) -> list[str]:
    return normalizar(texto).split()


def _raiz(token: str) -> str:
    """Dobra plural e flexão de gênero dos cargos: "diretoras" e "diretor" → "diretor"."""
    if len(token) > 3 and token.endswith("s"):
        token = token[:-1]
    if token.endswith("ora"):
        return token[:-1]
    if token.endswith("eira"):
        return token[:-1] + "o"
    return token


def _raizes(texto: str | None) -> set[str]:
    return {_raiz(t) for t in _tokens(texto) if t not in _SOBRAS_DE_BUSCA}


def resolver_metrica(texto: str | None, catalogo: list[dict]) -> tuple[dict | None, list[str]]:
    """Métrica canônica de um texto livre (§7.3): termo igual ao do catálogo, ou o termo mais longo contido no
    texto quando o resto são só palavras de enchimento. Sem correspondência: `None` e nomes parecidos."""
    nt = _tokens(texto)
    if not nt:
        return None, []
    termos: list[tuple[str, dict]] = []
    for m in catalogo:
        for t in [m["name"], m["name_pt"], *m.get("aliases", [])]:
            termos.append((normalizar(t), m))
    for t, m in termos:
        if t == " ".join(nt):
            return m, []
    achados: list[tuple[int, dict]] = []
    for t, m in termos:
        tt = t.split()
        for i in range(len(nt) - len(tt) + 1):
            if nt[i : i + len(tt)] == tt:
                resto = nt[:i] + nt[i + len(tt) :]
                if all(x in _SOBRAS_DE_METRICA or x.isdigit() for x in resto):
                    achados.append((len(tt), m))
                break
    if achados:
        melhor = max(n for n, _ in achados)
        donos = {m["id"]: m for n, m in achados if n == melhor}
        if len(donos) == 1:
            return next(iter(donos.values())), []
    chave = {t for t in nt if len(t) >= 3 and t not in _SOBRAS_DE_METRICA}
    sugestoes = []
    for t, m in termos:
        if chave & set(t.split()) and m["name"] not in sugestoes:
            sugestoes.append(m["name"])
    return None, sugestoes[:5]


def resolver_entidade(
    texto: str | None, conhecidas: list[str], emissor: str | None
) -> tuple[str | None, list[str]]:
    """Nome exato (como está nos fatos) da entidade pedida. Sem texto: o emissor. Igual sem caixa nem acento;
    senão, o único nome que contém todas as palavras pedidas. Ambígua ou desconhecida: `None` e sugestões."""
    if not texto or not texto.strip():
        return emissor, []
    nomes = list(dict.fromkeys([*conhecidas, *([emissor] if emissor else [])]))
    alvo = normalizar(texto)
    for n in nomes:
        if normalizar(n) == alvo:
            return n, []
    pedidas = {t for t in alvo.split() if t not in _SOBRAS_DE_BUSCA}
    contem = [n for n in nomes if pedidas and pedidas <= set(_tokens(n))]
    if len(contem) == 1:
        return contem[0], []
    pontuadas = sorted(
        ((len(pedidas & set(_tokens(n))), n) for n in nomes if pedidas & set(_tokens(n))),
        key=lambda x: (-x[0], x[1]),
    )
    return None, [n for _, n in (pontuadas if not contem else [(0, c) for c in contem])][:5]


def normalizar_periodo(texto: str | None) -> str:
    """Id de período do grafo: "2025" → `2025-FY`, "4T25" → `2025-Q4`, "31/12/2025" → `2025-12-31`."""
    bruto = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode().lower().strip()
    bruto = re.sub(r"\s+", " ", bruto)

    def data(a: int, m: int, d: int) -> str:
        try:
            datetime.date(a, m, d)
        except ValueError:
            raise ValueError(f"data inválida: {texto!r}") from None
        return f"{a:04d}-{m:02d}-{d:02d}"

    def ano(txt: str) -> int:
        a = int(txt)
        return 2000 + a if a < 100 else a

    if m := re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", bruto):
        return data(int(m[1]), int(m[2]), int(m[3]))
    if m := re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", bruto):
        return data(int(m[3]), int(m[2]), int(m[1]))
    if m := re.fullmatch(r"(\d{1,2}) de ([a-z]+) de (\d{4})", bruto):
        if m[2] in _MESES:
            return data(int(m[3]), _MESES[m[2]], int(m[1]))
    if m := re.fullmatch(r"(\d{4})-q([1-4])", bruto):
        return f"{m[1]}-Q{m[2]}"
    if m := re.fullmatch(r"([1-4]) ?t ?(\d{4}|\d{2})", bruto):
        return f"{ano(m[2])}-Q{m[1]}"
    if m := re.fullmatch(r"([1-4]) ?o? ?trimestre(?: de)? (\d{4})", bruto):
        return f"{m[2]}-Q{m[1]}"
    if m := re.fullmatch(r"q([1-4]) ?(\d{4})", bruto):
        return f"{m[2]}-Q{m[1]}"
    if m := re.fullmatch(r"(?:fy ?|exercicio de |ano de )?(\d{4})(?:-fy)?", bruto):
        return f"{m[1]}-FY"
    raise ValueError(f"período não reconhecido: {texto!r}")


# ---------- valores em pt-BR ----------


def _pt(valor: float, max_casas: int = 2) -> str:
    s = f"{abs(valor):,.{max_casas}f}"
    inteiro, _, dec = s.partition(".")
    dec = dec.rstrip("0")
    texto = inteiro.replace(",", ".") + ("," + dec if dec else "")
    return ("-" if valor < 0 and texto.strip("0,.") else "") + texto


def formatar_valor(valor: float, unidade: str, escala: float | int | None, moeda: str | None = None) -> str:
    """ "R$ 16.782 milhões", "R$ 16,8 bilhões", "23,9%", "130": o número, a escala e a moeda explícitos."""
    if unidade == "percent":
        return f"{_pt(valor)}%"
    if unidade == "count":
        palavra = _ESCALAS.get(int(escala)) if escala and int(escala) in _ESCALAS else None
        return f"{_pt(valor, 3)} {palavra[1]}" if palavra else _pt(valor)
    prefixo = "R$ " if moeda in (None, "", "BRL") else f"{moeda} "
    palavra = _ESCALAS.get(int(escala)) if escala and int(escala) in _ESCALAS else None
    if palavra:
        nome = palavra[0] if abs(valor) < 2 and palavra[0] != "mil" else palavra[1]
        return f"{prefixo}{_pt(valor, 3)} {nome}"
    return f"{prefixo}{_pt(valor)}"


# ---------- consolidação dos fatos ----------


def _fim_da_escala(escala: float | None) -> float:
    return float(escala or 1)


def consolidar_fatos(linhas: list[dict]) -> list[dict]:
    """Une repetições do mesmo valor (mesma escala ou arredondado em escala maior) e marca divergências.

    O valor "16,8 bilhões" cobre 16,75 a 16,85 bilhões: se a diferença para "16.782 milhões" cabe em meia
    unidade da escala maior, é o mesmo fato e fica a escala mais fina. Valores que não cabem ficam separados
    e, no mesmo período e recorte, todos recebem `conflito`."""
    grupos: dict[tuple, list[dict]] = {}
    for r in linhas:
        escala = _fim_da_escala(r.get("escala"))
        absoluto = round(float(r["valor"]) * escala, 2)
        chave = (r["periodo"], r.get("qualificador"), normalizar(r.get("dimensao")), r.get("unidade"))
        grupos.setdefault(chave, []).append({**r, "escala": escala, "valor_absoluto": absoluto})
    saida: list[dict] = []
    for itens in grupos.values():
        itens.sort(key=lambda x: (x["escala"], x.get("pagina") or 0))
        clusters: list[dict] = []
        for it in itens:
            for c in clusters:
                if abs(it["valor_absoluto"] - c["valor_absoluto"]) <= 0.5 * max(it["escala"], c["escala"]):
                    c["paginas"] |= {p for p in (it.get("pagina"), it.get("pagina_fim")) if p is not None}
                    c["ids_equivalentes"].append(it["id"])
                    c["apoio"] += 1
                    break
            else:
                clusters.append(
                    {
                        **it,
                        "paginas": {p for p in (it.get("pagina"), it.get("pagina_fim")) if p is not None},
                        "ids_equivalentes": [],
                        "apoio": 1,
                    }
                )
        for c in clusters:
            c["paginas"] = sorted(c["paginas"])
            c["conflito"] = len(clusters) > 1
            c["texto_valor"] = formatar_valor(c["valor"], c["unidade"], c["escala"], c.get("moeda"))
        saida.extend(clusters)
    saida.sort(key=lambda c: (c["fim"] or "", c["apoio"], c["valor_absoluto"]), reverse=True)
    return saida


# ---------- infraestrutura comum ----------


def _envelope(ferramenta: str, **parametros: Any) -> dict:
    return {
        "ferramenta": ferramenta,
        "parametros": parametros,
        "evidencias": [],
        "aviso": None,
        "erro": None,
        "sugestoes": [],
        "omitido": {},
        "latencia_ms": 0.0,
    }


def _rodar(driver: Any, nome: str, parametros: dict, banco: str) -> list[dict]:
    try:
        from neo4j import RoutingControl

        roteamento: Any = RoutingControl.READ
    except ImportError:  # pragma: no cover - o neo4j está sempre instalado no projeto
        roteamento = "r"
    registros, _, _ = driver.execute_query(CONSULTAS[nome], parametros, database_=banco, routing_=roteamento)
    return [dict(r) for r in registros]


def _fechar(saida: dict, t0: float) -> dict:
    saida["latencia_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return saida


def _falhar(saida: dict, t0: float, codigo: str, **extra: Any) -> dict:
    saida["erro"] = codigo
    saida.update(extra)
    return _fechar(saida, t0)


def _evidencia(id_: str, tipo: str, paginas: list[int], caminho: str, texto: str, score: float = 1.0) -> dict:
    return {
        "id": id_,
        "tipo": tipo,
        "paginas": rotulo_de_paginas(paginas),
        "caminho": caminho,
        "texto": texto,
        "score": score,
    }


def _contexto_de_fatos(
    driver: Any,
    saida: dict,
    t0: float,
    metrica: str,
    entidade: str | None,
    periodo: str | None,
    qualificador: str,
    banco: str,
    catalogo: list[dict] | None,
) -> tuple[dict | None, dict | None]:
    """Resolve métrica, período e entidade. Devolve `(contexto, None)` ou `(None, resultado_com_erro)`."""
    if qualificador not in QUALIFICADORES:
        return None, _falhar(saida, t0, "qualificador_invalido", sugestoes=list(QUALIFICADORES))
    m, sugestoes = resolver_metrica(metrica, catalogo if catalogo is not None else ler_catalogo())
    if m is None:
        return None, _falhar(saida, t0, "metrica_desconhecida", sugestoes=sugestoes)
    periodos = None
    if periodo:
        try:
            periodos = [normalizar_periodo(periodo)]
        except ValueError as e:
            return None, _falhar(saida, t0, "periodo_invalido", aviso=str(e))
    doc = _rodar(driver, "emissor", {}, banco)
    if not doc:
        return None, _falhar(saida, t0, "grafo_sem_documento")
    emissor, ano_base = doc[0]["emissor"], doc[0]["ano_base"]
    conhecidas = [r["entidade"] for r in _rodar(driver, "entidades_dos_fatos", {}, banco)]
    nome, sugestoes = resolver_entidade(entidade, conhecidas, emissor)
    if nome is None:
        return None, _falhar(saida, t0, "entidade_desconhecida", sugestoes=sugestoes)
    saida["parametros"].update(
        metrica=m["name"], metrica_id=m["id"], entidade=nome, qualificador=qualificador
    )
    saida["parametros"]["periodo"] = periodos[0] if periodos else None
    return {"metrica": m, "periodos": periodos, "entidade": nome, "ano_base": ano_base}, None


def _ler_fatos(
    driver: Any, ctx: dict, qualificador: str, modo: str, tipo_periodo: str | None, banco: str
) -> list[dict]:
    parametros = {
        "metrica": "metric:" + ctx["metrica"]["id"],
        "entidades": [ctx["entidade"]],
        "qualificador": qualificador,
        "unidade": UNIDADE_DO_TIPO[ctx["metrica"]["kind"]],
        "periodos": ctx["periodos"],
        "tipo_periodo": tipo_periodo,
        "modo": modo,
        "limite": LIMITE_FATOS,
    }
    linhas = _rodar(driver, "fatos", parametros, banco)
    if ctx["periodos"]:  # o contrato vale mesmo que o grafo devolva mais
        linhas = [r for r in linhas if r["periodo"] in ctx["periodos"]]
    return linhas


def _ate_o_ano_base(linhas: list[dict], ano_base: int | None) -> list[dict]:
    if ano_base is None:
        return linhas
    return [r for r in linhas if (r.get("fim") or "") <= f"{ano_base}-12-31"]


def _casa_texto(pedido: str, candidato: str | None) -> bool:
    """O pedido casa o candidato quando todas as suas palavras (sem caixa nem acento) estão nele."""
    p = {t for t in _tokens(pedido) if t not in _SOBRAS_DE_BUSCA}
    return bool(p) and p <= set(_tokens(candidato))


def _evidencia_de_fato(f: dict, ferramenta: str) -> dict:
    recorte = f" · {f['dimensao']}" if f.get("dimensao") else ""
    aviso = " [valores divergentes no documento]" if f.get("conflito") else ""
    return _evidencia(
        f["id"],
        "fato",
        f["paginas"],
        f"{ferramenta}: {f['rotulo'] or ''}{recorte}",
        f"{f['rotulo'] or 'Valor'}: {f['texto_valor']} ({f['periodo']}{recorte}; {f['entidade']}){aviso}",
    )


def _publico(f: dict) -> dict:
    chaves = (
        "id",
        "ids_equivalentes",
        "valor",
        "unidade",
        "moeda",
        "escala",
        "valor_absoluto",
        "texto_valor",
        "periodo",
        "tipo_periodo",
        "entidade",
        "qualificador",
        "dimensao",
        "rotulo",
        "paginas",
        "conflito",
    )
    return {k: f.get(k) for k in chaves}


# ---------- fato_financeiro ----------


def fato_financeiro(
    driver: Any,
    metrica: str,
    entidade: str | None = None,
    periodo: str | None = None,
    qualificador: str = "nenhum",
    dimensao: str | None = None,
    banco: str = "neo4j",
    catalogo: list[dict] | None = None,
    limite: int = LIMITES_PADRAO["fatos"],
) -> dict:
    """O valor de uma métrica para uma entidade e um período: `{fatos, evidencias, periodo_assumido, ...}`.

    Sem `entidade`, o emissor; sem `periodo`, o mais recente até o ano-base; sem `dimensao`, o total."""
    t0 = time.perf_counter()
    saida = _envelope("fato_financeiro", dimensao=dimensao)
    saida.update(fatos=[], periodo_assumido=False, conflito=False)
    try:
        ctx, falha = _contexto_de_fatos(
            driver, saida, t0, metrica, entidade, periodo, qualificador, banco, catalogo
        )
        if falha:
            return falha
        linhas = _ler_fatos(driver, ctx, qualificador, "recortes" if dimensao else "total", None, banco)
        if dimensao:
            linhas = [r for r in linhas if _casa_texto(dimensao, r.get("dimensao"))]
        if not ctx["periodos"]:
            linhas = _ate_o_ano_base(linhas, ctx["ano_base"])
            if linhas:
                recente = max(r["fim"] or "" for r in linhas)
                linhas = [r for r in linhas if (r["fim"] or "") == recente]
                saida["periodo_assumido"] = True
                saida["parametros"]["periodo"] = linhas[0]["periodo"]
        fatos = consolidar_fatos(linhas)
    except Exception as e:  # o roteador recebe o erro, não a exceção
        return _falhar(saida, t0, f"falha no grafo: {e}")
    if not fatos:
        saida["aviso"] = (
            "Nenhum fato encontrado para esta métrica"
            + (f" com o recorte {dimensao!r}" if dimensao else " sem recorte (total)")
            + ". Se ela só aparece por recorte, use comparar_segmentos ou informe `dimensao`."
        )
        return _fechar(saida, t0)
    omitido = max(0, len(fatos) - limite)
    fatos = fatos[:limite]
    saida["fatos"] = [_publico(f) for f in fatos]
    saida["evidencias"] = [_evidencia_de_fato(f, "fato_financeiro") for f in fatos]
    saida["conflito"] = any(f["conflito"] for f in fatos)
    saida["omitido"] = {"fatos": omitido}
    if saida["conflito"]:
        saida["aviso"] = "O documento traz valores diferentes para este fato; confira as páginas de cada um."
    return _fechar(saida, t0)


# ---------- serie_metrica ----------


def _ordinal(periodo: str, tipo: str) -> int | None:
    if tipo == "fiscal_year":
        return int(periodo[:4])
    if tipo == "quarter":
        return int(periodo[:4]) * 4 + int(periodo[-1]) - 1
    return None


def _id_do_ordinal(n: int, tipo: str) -> str:
    return f"{n}-FY" if tipo == "fiscal_year" else f"{n // 4}-Q{n % 4 + 1}"


def serie_metrica(
    driver: Any,
    metrica: str,
    entidade: str | None = None,
    dimensao: str | None = None,
    tipo_periodo: str | None = "fiscal_year",
    qualificador: str = "nenhum",
    banco: str = "neo4j",
    catalogo: list[dict] | None = None,
    limite: int = LIMITES_PADRAO["pontos"],
) -> dict:
    """A métrica ao longo dos períodos, do mais antigo ao mais novo, sem preencher lacunas.

    `pontos[]` tem um valor por período (o mais sustentado, com `alternativas` quando o documento diverge) e
    `variacao_pct` só entre períodos vizinhos e sem divergência; `periodos_ausentes` lista os buracos."""
    t0 = time.perf_counter()
    saida = _envelope("serie_metrica", dimensao=dimensao, tipo_periodo=tipo_periodo)
    saida.update(pontos=[], periodos_ausentes=[])
    if tipo_periodo is not None and tipo_periodo not in TIPOS_DE_PERIODO:
        return _falhar(saida, t0, "tipo_periodo_invalido", sugestoes=list(TIPOS_DE_PERIODO))
    try:
        ctx, falha = _contexto_de_fatos(
            driver, saida, t0, metrica, entidade, None, qualificador, banco, catalogo
        )
        if falha:
            return falha
        linhas = _ler_fatos(
            driver, ctx, qualificador, "recortes" if dimensao else "total", tipo_periodo, banco
        )
        if dimensao:
            linhas = [r for r in linhas if _casa_texto(dimensao, r.get("dimensao"))]
        fatos = consolidar_fatos(linhas)
    except Exception as e:
        return _falhar(saida, t0, f"falha no grafo: {e}")
    if not fatos:
        saida["aviso"] = "Nenhum valor encontrado para esta métrica nos períodos do documento."
        return _fechar(saida, t0)
    por_periodo: dict[str, list[dict]] = {}
    for f in fatos:
        por_periodo.setdefault(f["periodo"], []).append(f)
    pontos: list[dict] = []
    for itens in por_periodo.values():
        itens.sort(key=lambda f: (-f["apoio"], f["escala"], f["paginas"][:1] or [0]))
        escolhido, outros = itens[0], itens[1:]
        pontos.append(
            {
                **_publico(escolhido),
                "fim": escolhido["fim"],
                "conflito": escolhido["conflito"],
                "alternativas": [
                    {"valor": o["valor"], "texto_valor": o["texto_valor"], "paginas": o["paginas"]}
                    for o in outros
                ],
                "variacao_pct": None,
            }
        )
    pontos.sort(key=lambda p: (p["fim"] or "", p["periodo"]))
    for ant, atual in zip(pontos, pontos[1:], strict=False):
        oa, ob = (
            _ordinal(ant["periodo"], ant["tipo_periodo"]),
            _ordinal(atual["periodo"], atual["tipo_periodo"]),
        )
        if (
            oa is not None
            and ob is not None
            and ob - oa == 1
            and ant["tipo_periodo"] == atual["tipo_periodo"]
            and ant["unidade"] == atual["unidade"]
            and not ant["conflito"]
            and not atual["conflito"]
            and ant["valor_absoluto"] != 0
        ):
            atual["variacao_pct"] = round(
                (atual["valor_absoluto"] - ant["valor_absoluto"]) / abs(ant["valor_absoluto"]) * 100, 1
            )
    tipos = {p["tipo_periodo"] for p in pontos}
    if len(tipos) == 1 and (tipo := next(iter(tipos))) in ("fiscal_year", "quarter"):
        ordinais = [_ordinal(p["periodo"], tipo) for p in pontos]
        ausentes = set(range(min(ordinais), max(ordinais) + 1)) - set(ordinais)
        saida["periodos_ausentes"] = [_id_do_ordinal(n, tipo) for n in sorted(ausentes)]
    saida["omitido"] = {"pontos": max(0, len(pontos) - limite)}
    pontos = pontos[-limite:]
    saida["pontos"] = pontos
    saida["evidencias"] = [
        _evidencia_de_fato({**p, "paginas": p["paginas"]}, "serie_metrica") for p in pontos
    ]
    avisos = []
    if saida["periodos_ausentes"]:
        avisos.append("Períodos sem valor no documento: " + ", ".join(saida["periodos_ausentes"]) + ".")
    if any(p["conflito"] for p in pontos):
        avisos.append("Há períodos com valores divergentes (veja `alternativas`).")
    saida["aviso"] = " ".join(avisos) or None
    return _fechar(saida, t0)


# ---------- comparar_segmentos ----------


def comparar_segmentos(
    driver: Any,
    metrica: str,
    segmentos: list[str] | None = None,
    periodo: str | None = None,
    entidade: str | None = None,
    qualificador: str = "nenhum",
    banco: str = "neo4j",
    catalogo: list[dict] | None = None,
    limite: int = LIMITES_PADRAO["segmentos"],
) -> dict:
    """A mesma métrica em vários recortes (`dimension`: Rurais, Pessoas Físicas...) num período, do maior ao
    menor.

    Com `segmentos`, só esses (os que não existem vêm em `nao_encontrados`); sem eles, os `limite` maiores."""
    t0 = time.perf_counter()
    saida = _envelope("comparar_segmentos", segmentos=segmentos)
    saida.update(segmentos=[], nao_encontrados=[], periodo=None, periodo_assumido=False)
    try:
        ctx, falha = _contexto_de_fatos(
            driver, saida, t0, metrica, entidade, periodo, qualificador, banco, catalogo
        )
        if falha:
            return falha
        linhas = _ler_fatos(driver, ctx, qualificador, "recortes", None, banco)
        if not ctx["periodos"]:
            linhas = _ate_o_ano_base(linhas, ctx["ano_base"])
            if linhas:
                recente = max(r["fim"] or "" for r in linhas)
                linhas = [r for r in linhas if (r["fim"] or "") == recente]
                saida["periodo_assumido"] = True
        fatos = consolidar_fatos(linhas)
    except Exception as e:
        return _falhar(saida, t0, f"falha no grafo: {e}")
    if fatos:
        saida["periodo"] = fatos[0]["periodo"]
    por_recorte: dict[str, list[dict]] = {}
    for f in fatos:
        por_recorte.setdefault(normalizar(f["dimensao"]), []).append(f)
    linhas_seg: list[dict] = []
    for itens in por_recorte.values():
        itens.sort(key=lambda f: (-f["apoio"], f["escala"]))
        linhas_seg.append(
            {
                "segmento": itens[0]["dimensao"],
                **_publico(itens[0]),
                "alternativas": [
                    {"valor": o["valor"], "texto_valor": o["texto_valor"], "paginas": o["paginas"]}
                    for o in itens[1:]
                ],
            }
        )
    if segmentos:
        escolhidos: list[dict] = []
        for pedido in segmentos:
            exatos = [s for s in linhas_seg if normalizar(s["segmento"]) == normalizar(pedido)]
            contidos = sorted(
                (s for s in linhas_seg if _casa_texto(pedido, s["segmento"])),
                key=lambda s: len(s["segmento"]),
            )
            achado = exatos or contidos[:1]
            if achado and achado[0] not in escolhidos:
                escolhidos.append(achado[0])
            elif not achado:
                saida["nao_encontrados"].append(pedido)
        linhas_seg = escolhidos
    linhas_seg.sort(key=lambda s: (-s["valor_absoluto"], s["segmento"]))
    if not segmentos:
        saida["omitido"] = {"segmentos": max(0, len(linhas_seg) - limite)}
        linhas_seg = linhas_seg[:limite]
    saida["segmentos"] = linhas_seg
    saida["evidencias"] = [_evidencia_de_fato(s, "comparar_segmentos") for s in linhas_seg]
    avisos = []
    if not linhas_seg:
        avisos.append("Nenhum recorte encontrado para esta métrica no período.")
    if saida["nao_encontrados"]:
        avisos.append("Segmentos sem valor no documento: " + ", ".join(saida["nao_encontrados"]) + ".")
    if any(s["conflito"] for s in linhas_seg):
        avisos.append("Há recortes com valores divergentes (veja `alternativas`).")
    saida["aviso"] = " ".join(avisos) or None
    return _fechar(saida, t0)


# ---------- busca por tema nos nós (riscos, eventos, pessoas) ----------


def _pontuar(tema: str | None, campos: list[tuple[str | None, int]]) -> int | None:
    """Pontos do tema nos campos (peso por campo); `None` quando menos da metade das palavras aparece."""
    pedidas = _raizes(tema)
    if not pedidas:
        return 0
    pontos, achadas = 0, set()
    for texto, peso in campos:
        presentes = pedidas & _raizes(texto)
        pontos += peso * len(presentes)
        achadas |= presentes
    return pontos if len(achadas) >= math.ceil(len(pedidas) / 2) else None


def riscos(
    driver: Any,
    tema: str | None = None,
    categoria: str | None = None,
    banco: str = "neo4j",
    limite: int = LIMITES_PADRAO["riscos"],
) -> dict:
    """Fatores de risco por categoria e/ou tema, com as páginas onde o documento os descreve.

    Sem tema, vêm primeiro os da extração dirigida e os que têm página. Sem resultado, lista vazia e aviso."""
    t0 = time.perf_counter()
    saida = _envelope("riscos", tema=tema, categoria=categoria)
    if categoria is not None and categoria not in CATEGORIAS_DE_RISCO:
        return _falhar(saida, t0, "categoria_invalida", sugestoes=list(CATEGORIAS_DE_RISCO))
    try:
        linhas = _rodar(
            driver,
            "riscos",
            {
                "categoria": None if categoria == "sem_categoria" else categoria,
                "sem_categoria": categoria == "sem_categoria",
                "teto": TETO_DE_NOS,
            },
            banco,
        )
    except Exception as e:
        return _falhar(saida, t0, f"falha no grafo: {e}")
    candidatos = []
    for r in linhas:
        paginas = sorted({p for p in [*(r.get("ini") or []), *(r.get("fim") or [])] if p is not None})
        r = {**r, "paginas": paginas}
        if tema:
            pontos = _pontuar(tema, [(r["nome"], 3), (r.get("apelidos"), 2), (r.get("resumo"), 1)])
            if pontos is None:
                continue
            r["_ordem"] = (-pontos, r["nome"])
        else:
            r["_ordem"] = ("dirigida" not in (r.get("camadas") or []), not paginas, r["nome"])
        candidatos.append(r)
    candidatos.sort(key=lambda r: r["_ordem"])
    saida["omitido"] = {"riscos": max(0, len(candidatos) - limite)}
    escolhidos = candidatos[:limite]
    saida["evidencias"] = [
        _evidencia(
            r["id"],
            "risco",
            r["paginas"],
            f"Risco ({r.get('categoria') or 'sem categoria'})",
            f"{r['nome']} [{r.get('categoria') or 'sem categoria'}]: {r.get('resumo') or ''}".strip(),
        )
        for r in escolhidos
    ]
    saida["riscos"] = [{k: v for k, v in r.items() if not k.startswith("_")} for r in escolhidos]
    if not escolhidos:
        saida["aviso"] = "Nenhum fator de risco encontrado" + (f" para o tema {tema!r}." if tema else ".")
    return _fechar(saida, t0)


def eventos(
    driver: Any,
    tema: str | None = None,
    ano: int | None = None,
    banco: str = "neo4j",
    limite: int = LIMITES_PADRAO["eventos"],
) -> dict:
    """Eventos do documento por tema e/ou ano da data. Só uns 7% têm data: com `ano`, os sem data ficam
    de fora e o resultado conta quantos foram (`omitido.sem_data`)."""
    t0 = time.perf_counter()
    saida = _envelope("eventos", tema=tema, ano=ano)
    if ano is not None and not (1900 <= int(ano) <= 2100):
        return _falhar(saida, t0, "ano_invalido")
    try:
        linhas = _rodar(driver, "eventos", {"teto": TETO_DE_NOS}, banco)
    except Exception as e:
        return _falhar(saida, t0, f"falha no grafo: {e}")
    sem_data = 0
    candidatos = []
    for e in linhas:
        if ano is not None:
            if not e.get("data"):
                sem_data += 1
                continue
            if not str(e["data"]).startswith(str(ano)):
                continue
        pontos = 0
        if tema:
            pontos = _pontuar(tema, [(e["nome"], 3), (e.get("resumo"), 1)])
            if pontos is None:
                continue
        candidatos.append((e, pontos))
    # relevância primeiro (só com tema), depois datados do mais recente, depois os sem data por nome
    candidatos.sort(key=lambda x: (-x[1], not x[0].get("data"), _inverter(x[0].get("data")), x[0]["nome"]))
    saida["omitido"] = {"eventos": max(0, len(candidatos) - limite), "sem_data": sem_data}
    escolhidos = [e for e, _ in candidatos[:limite]]
    saida["evidencias"] = [
        _evidencia(
            e["id"],
            "evento",
            [p for p in e.get("paginas") or [] if p is not None],
            "Evento",
            f"{e.get('data') or 's/ data'}: {e['nome']}" + (f" — {e['resumo']}" if e.get("resumo") else ""),
        )
        for e in escolhidos
    ]
    saida["eventos"] = escolhidos
    avisos = []
    if not escolhidos:
        avisos.append(
            "Nenhum evento encontrado"
            + (f" em {ano}" if ano else "")
            + (f" para o tema {tema!r}" if tema else "")
            + "."
        )
    if ano is not None and sem_data:
        avisos.append(f"{sem_data} evento(s) sem data no documento ficaram de fora do filtro por ano.")
    saida["aviso"] = " ".join(avisos) or None
    return _fechar(saida, t0)


def _inverter(data: str | None) -> tuple:
    """Chave de ordenação decrescente para datas ISO em texto (sem data fica para o fim)."""
    return tuple(-ord(c) for c in (data or ""))


def _parece_cargo(nome: str | None) -> bool:
    """O nome começa por palavra de cargo ("Diretoria Executiva", "A Presidente do BB"): defeito conhecido."""
    tokens = [t for t in _tokens(nome) if t not in ("a", "o", "as", "os")]
    return bool(tokens) and _raiz(tokens[0]) in _PALAVRAS_DE_CARGO


def _segmentos(texto: str | None, separadores: str = ";") -> list[str]:
    """Os títulos de um campo que junta vários ("Diretor Executivo; Vice-presidente de Riscos")."""
    return [t for t in re.split(separadores, texto or "") if t.strip()]


def pessoas_cargos(
    driver: Any,
    cargo: str | None = None,
    nome: str | None = None,
    orgao: str | None = None,
    banco: str = "neo4j",
    limite: int = LIMITES_PADRAO["pessoas"],
) -> dict:
    """Quem ocupa um cargo, em que órgão, e onde o documento diz. Exige um de `cargo`, `nome` ou `orgao`.

    A extração gravou alguns cargos como nome de pessoa ("Diretoria Executiva"): `nome_parece_cargo` os
    marca, e eles vêm depois das pessoas de nome próprio."""
    t0 = time.perf_counter()
    saida = _envelope("pessoas_cargos", cargo=cargo, nome=nome, orgao=orgao)
    saida["pessoas"] = []
    if not any((x or "").strip() for x in (cargo, nome, orgao)):
        return _falhar(saida, t0, "filtro_obrigatorio", aviso="Informe cargo, nome ou órgão.")
    try:
        linhas = _rodar(driver, "pessoas", {"teto": TETO_DE_NOS}, banco)
    except Exception as e:
        return _falhar(saida, t0, f"falha no grafo: {e}")
    unidas: dict[tuple, dict] = {}
    for r in linhas:
        parece_cargo = _parece_cargo(r.get("nome"))
        fonte = "cargo"
        if cargo:
            # cada título sozinho tem de conter o cargo (um título por vez)
            titulos = [*_segmentos(r.get("cargo")), *_segmentos(r.get("cargo_no_no"))]
            if not any(_raizes(cargo) <= _raizes(t) for t in titulos):
                # só o resumo diz o cargo: vale para pessoa de nome próprio, não para nó que é cargo
                if parece_cargo or not any(
                    _raizes(cargo) <= _raizes(t) for t in _segmentos(r.get("resumo"), "[.;]")
                ):
                    continue
                fonte = "resumo"
        if nome and not _raizes(nome) <= _raizes(r.get("nome")):
            continue
        if orgao and not _raizes(orgao) <= _raizes(r.get("orgao")):
            continue
        chave = (r["id"], r.get("cargo"), r.get("orgao")) if fonte == "cargo" else (r["id"], "resumo")
        if chave in unidas:
            unidas[chave]["paginas"] |= {p for p in r.get("paginas") or [] if p is not None}
        else:
            unidas[chave] = {
                "id": r["id"],
                "nome": r.get("nome"),
                "cargo": (r.get("cargo") or r.get("cargo_no_no")) if fonte == "cargo" else None,
                "orgao": r.get("orgao") if fonte == "cargo" else None,
                "paginas": {p for p in r.get("paginas") or [] if p is not None},
                "nome_parece_cargo": parece_cargo,
                "fonte": fonte,
                "resumo": r.get("resumo") if fonte == "resumo" else None,
            }
    pessoas = sorted(
        unidas.values(), key=lambda p: (p["fonte"] != "cargo", p["nome_parece_cargo"], p["nome"] or "")
    )
    saida["omitido"] = {"pessoas": max(0, len(pessoas) - limite)}
    pessoas = pessoas[:limite]
    vistos: dict[str, int] = {}
    evidencias = []
    for p in pessoas:
        p["paginas"] = sorted(p["paginas"])
        n = vistos[p["id"]] = vistos.get(p["id"], 0) + 1
        marca = "[nome registrado como cargo] " if p["nome_parece_cargo"] else ""
        evidencias.append(
            _evidencia(
                p["id"] if n == 1 else f"{p['id']}#{n}",
                "pessoa",
                p["paginas"],
                "Pessoa e cargo",
                f"{marca}{p['nome']} — "
                + (p["resumo"] if p["fonte"] == "resumo" else (p["cargo"] or "cargo não informado"))
                + (f" ({p['orgao']})" if p["orgao"] else ""),
            )
        )
    saida["pessoas"] = pessoas
    saida["evidencias"] = evidencias
    if not pessoas:
        saida["aviso"] = "Nenhuma pessoa encontrada para esses filtros."
    elif any(p["nome_parece_cargo"] for p in pessoas):
        saida["aviso"] = "Alguns nomes são cargos gravados como pessoa pela extração (nome_parece_cargo)."
    return _fechar(saida, t0)


# ---------- CLI ----------


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ferramenta", choices=["fato", "serie", "comparar", "riscos", "eventos", "pessoas"])
    ap.add_argument("consulta", nargs="?", help="a métrica (fato, serie, comparar)")
    ap.add_argument("--entidade")
    ap.add_argument("--periodo")
    ap.add_argument("--dimensao")
    ap.add_argument("--segmentos", nargs="*")
    ap.add_argument("--tipo-periodo", default="fiscal_year")
    ap.add_argument("--tema")
    ap.add_argument("--categoria")
    ap.add_argument("--ano", type=int)
    ap.add_argument("--cargo")
    ap.add_argument("--nome")
    ap.add_argument("--orgao")
    ap.add_argument("--raiz", type=Path, default=Path(__file__).resolve().parents[3])
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()
    driver = conectar(a.raiz)
    try:
        if a.ferramenta in ("fato", "serie", "comparar") and not a.consulta:
            ap.error("informe a métrica")
        if a.ferramenta == "fato":
            r = fato_financeiro(driver, a.consulta, a.entidade, a.periodo, dimensao=a.dimensao, banco=a.banco)
        elif a.ferramenta == "serie":
            r = serie_metrica(
                driver, a.consulta, a.entidade, a.dimensao, a.tipo_periodo or None, banco=a.banco
            )
        elif a.ferramenta == "comparar":
            r = comparar_segmentos(driver, a.consulta, a.segmentos, a.periodo, a.entidade, banco=a.banco)
        elif a.ferramenta == "riscos":
            r = riscos(driver, a.tema, a.categoria, banco=a.banco)
        elif a.ferramenta == "eventos":
            r = eventos(driver, a.tema, a.ano, banco=a.banco)
        else:
            r = pessoas_cargos(driver, a.cargo, a.nome, a.orgao, banco=a.banco)
        print(json.dumps(r, ensure_ascii=False, indent=2, default=str))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
