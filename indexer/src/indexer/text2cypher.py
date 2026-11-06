"""Text2Cypher (F6.4, ARQUITETURA §7.3): pergunta → prompt → LLM → Cypher → execução somente leitura.

O prompt tem quatro seções (§7.3): o **esquema** do grafo, descoberto pela APOC (`apoc.meta.*`) e amostrado
(valores de exemplo das propriedades categóricas); o **mapeamento terminológico** PT↔EN das métricas
(`contracts/metricas.json`); **exemplos** *few-shot* (`api/prompts/cypher-examples.json`); e as **instruções
de formato** (somente Cypher, sem bloco de código, com `f.page AS pagina` para o resultado ser citável).

O que esta etapa garante (ADR-049): a consulta roda numa sessão de **leitura** (um Cypher de escrita falha
no servidor), com tempo limite e teto de linhas; falha do LLM, Cypher vazio ou erro de execução voltam como
`erro` no resultado, nunca como exceção; o que não tem página não é citado. Os guard-rails de F6.5 (cláusulas
proibidas, `EXPLAIN`, autocorreção) vêm depois e ficam por cima desta execução.

O que o grafo real obriga (ADR-049): o mesmo ano aparece como `2025-FY` ou `2025-12-31`; `OF_METRIC.dimension`
é ambíguo entre recortes; por isso o prompt manda filtrar pelo rótulo completo `f.metric` e pelo ano com
`STARTS WITH`.

Uso, a partir de `indexer/`, com o Neo4j e o llama-swap no ar:
    uv run python -m indexer.text2cypher perguntar "Quantos empregados atuam em Auditoria Interna?"
    uv run python -m indexer.text2cypher medir --nome f64-teste
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import time
import unicodedata
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.busca_local import rotulo_de_paginas
from indexer.guarda_cypher import avisos_do_plano, plano_com_escrita, preparar

RAIZ = Path(__file__).resolve().parents[3]
EXEMPLOS = RAIZ / "api" / "prompts" / "cypher-examples.json"
GOLDEN = RAIZ / "eval" / "golden_agregacao.csv"

CANDIDATOS_POR_PERGUNTA = 12
RECORTES_POR_METRICA = 5
MAX_CHARS_ROTULOS = 16000  # ~5 mil tokens; o prefixo do prompt é igual em toda pergunta e fica no cache
LIMITE_LINHAS = 50
TIMEOUT_S = 5  # §7.3; a F6.4 usava 10 s
MAX_DESPEJO = 5  # mais linhas que isso no resultado não prova que a resposta certa estava lá
# Propriedades que nunca vão ao prompt: vetores e textos longos estourariam o contexto sem ajudar a consulta.
OCULTAS = {
    "embedding",
    "evidence",
    "text",
    "texto",
    "summary",
    "definition",
    "markdown",
    "description",
    "content",
}
# Propriedades categóricas cujos valores de exemplo entram no esquema: (tipo, nome, propriedade, quantos).
AMOSTRAS = [
    ("rel", "OF_METRIC", "qualifier", 20),
    ("no", "Period", "id", 60),
    ("no", "FinancialFact", "unit", 10),
    ("no", "FinancialFact", "periodType", 10),
    ("no", "FinancialFact", "scale", 10),
    ("no", "Metric", "kind", 10),
    ("no", "RiskFactor", "category", 20),
]
# Rótulos de infraestrutura de recuperação: nenhuma pergunta de agregação passa por eles.
ROTULOS_IGNORADOS = {"__Entity__", "Child", "HypotheticalQuestion"}
TIPOS = {"String": "STRING", "Long": "INTEGER", "Double": "FLOAT", "Boolean": "BOOLEAN", "Date": "DATE"}

GeraCypher = Callable[[list[dict]], str]

INSTRUCOES = """Você traduz perguntas em português sobre o Formulário de Referência de uma companhia \
brasileira em consultas Cypher para o grafo descrito abaixo.

# Esquema do grafo
{esquema}

# Terminologia (termo da pergunta → nome no grafo)
{terminologia}

# Regras do grafo
- Cada valor numérico do documento é um nó FinancialFact: `f.value` está na unidade `f.unit` e na escala \
`f.scale` (1, 1000, 1000000...); some só valores com a mesma unidade e a mesma escala.
- O período vem do nó Period ligado por FOR_PERIOD. O mesmo ano pode estar como `2025-FY` ou `2025-12-31`: \
para "em 2025" use `p.id STARTS WITH '2025'`.
- `f.metric` guarda o rótulo completo da linha da tabela (em português) e `Metric` é a métrica canônica. \
`OF_METRIC.dimension` é um recorte ambíguo (região, idade, órgão, gênero) e seus valores não estão listados: \
quando a pergunta citar um recorte (cor/raça, região, gênero, área, órgão), filtre `f.metric` com os \
rótulos da lista "Rótulos existentes em FinancialFact.metric" (`IN [...]` com o texto exato; `STARTS WITH` \
só para o prefixo de uma família). Se o recorte já está no rótulo de `f.metric`, não ligue `Metric` nem use \
`dimension`. Nunca invente um valor de `dimension` nem de `f.metric`.
- Rótulos de total (com "Total" ou "TOTAL" em qualquer posição, como "... - TOTAL DE X", e o rótulo curto \
da família) já somam as demais linhas: em máximo, mínimo ou ranking, exclua-os explicitamente (com `<>` ou \
`NOT ... CONTAINS`); ao somar partes, não os inclua.
- Rótulos quase iguais podem repetir o mesmo valor vindo de tabelas diferentes (por exemplo "Empregados X" e \
"TOTAL DE EMPREGADOS - X"): ao somar, use um só rótulo por item, o mais curto, para não contar duas vezes.
- Escolha o rótulo com todas as palavras da pergunta ("não-liderança" não é "liderança"; "pardo" sem recorte \
é o total do documento).
- Calcule somas, diferenças e contagens na própria consulta, com um único \
sum(CASE WHEN ... THEN f.value ELSE -f.value END); não use collect nem indexação de listas. \
"Quanto caiu/diminuiu" é anterior menos atual; "quanto cresceu/superou" é atual menos anterior; o resultado \
é positivo.

# Exemplos
{exemplos}

# Formato da resposta
- Responda SOMENTE CYPHER, SEM BLOCOS DE CÓDIGO, sem explicação, sem comentários e sem ponto e vírgula.
- A consulta é somente de leitura: use MATCH, WITH, WHERE, RETURN, ORDER BY e LIMIT.
- Dê alias a toda coluna do RETURN. Quando a consulta devolver fatos, inclua `f.page AS pagina` e \
`f.id AS id`; em agregações, agregue direto no RETURN (sem WITH antes) e devolva `min(f.page) AS pagina` \
ali mesmo.
- Termine sempre com LIMIT (no máximo 50)."""


# ---------- esquema ----------


def _tipo(tipos: list[str] | None) -> str:
    t = (tipos or ["String"])[0]
    return "LIST" if t.endswith("Array") else TIPOS.get(t, t.upper())


def _oculta(prop: str) -> bool:
    """Vetores, textos longos e metadados de indexação (embeddingHash...) não ajudam a consulta."""
    return prop in OCULTAS or prop.startswith(("embedding", "summary")) or prop.endswith(("Text", "Hash"))


def _amostrar(valores: list, quantos: int) -> list:
    """Até `quantos` valores, espalhados pela lista ordenada (não só os primeiros)."""
    valores = [v for v in valores if v is not None]
    if len(valores) <= quantos:
        return valores
    passo = len(valores) / quantos
    return [valores[int(i * passo)] for i in range(quantos)]


def descobrir_esquema(driver: Any, banco: str = "neo4j") -> tuple[dict, list[str]]:
    """Esquema do grafo pela APOC, mais valores de exemplo. Devolve (esquema, avisos); sem APOC, cai para
    `db.schema.*` (sem as propriedades das relações) e avisa, em vez de montar um prompt mudo."""
    avisos: list[str] = []
    nos: dict[str, dict[str, str]] = {}
    props_rel: dict[str, dict[str, str]] = {}

    def consulta(cypher: str) -> list[dict]:
        with driver.session(database=banco, default_access_mode="READ") as s:
            return [dict(r) for r in s.run(cypher)]

    try:
        for r in consulta(
            "CALL apoc.meta.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes "
            "RETURN nodeLabels, propertyName, propertyTypes"
        ):
            for rotulo in r["nodeLabels"]:
                nos.setdefault(rotulo, {})
                if r["propertyName"]:
                    nos[rotulo][r["propertyName"]] = _tipo(r["propertyTypes"])
        for r in consulta(
            "CALL apoc.meta.relTypeProperties() YIELD relType, propertyName, propertyTypes "
            "RETURN relType, propertyName, propertyTypes"
        ):
            tipo = r["relType"].strip(":`")
            props_rel.setdefault(tipo, {})
            if r["propertyName"]:
                props_rel[tipo][r["propertyName"]] = _tipo(r["propertyTypes"])
    except Exception as e:  # APOC ausente ou sem permissão: o prompt perde detalhe, e o aviso diz isso
        avisos.append(f"apoc_indisponivel: {str(e)[:120]}")
        nos = {}
        for r in consulta(
            "CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes "
            "RETURN nodeLabels, propertyName, propertyTypes"
        ):
            for rotulo in r["nodeLabels"]:
                nos.setdefault(rotulo, {})
                if r["propertyName"]:
                    nos[rotulo][r["propertyName"]] = _tipo(r["propertyTypes"])
    # `__Entity__` é o rótulo genérico das entidades; o específico (Person, Organization) é o que informa
    especifico = "[l IN labels({}) WHERE l <> '__Entity__'][0]"
    padroes = consulta(
        f"MATCH (a)-[r]->(b) RETURN DISTINCT {especifico.format('a')} AS origem, type(r) AS tipo, "
        f"{especifico.format('b')} AS destino"
    )
    relacoes = [
        (p["origem"], p["tipo"], p["destino"], props_rel.get(p["tipo"], {}))
        for p in padroes
        if not {p["origem"], p["destino"]} & ROTULOS_IGNORADOS
    ]
    entidades = sorted(
        r["rotulo"]
        for r in consulta(f"MATCH (e:__Entity__) RETURN DISTINCT {especifico.format('e')} AS rotulo")
        if r["rotulo"]
    )
    relacoes = agrupar_relacoes(relacoes, set(entidades))
    nos = {k: v for k, v in nos.items() if k not in ROTULOS_IGNORADOS}
    valores: dict[str, list] = {}
    for tipo, nome, prop, quantos in AMOSTRAS:
        padrao = f"()-[x:`{nome}`]->()" if tipo == "rel" else f"(x:`{nome}`)"
        try:
            lista = [r["v"] for r in consulta(f"MATCH {padrao} RETURN DISTINCT x.`{prop}` AS v ORDER BY v")]
        except Exception as e:
            avisos.append(f"amostra_falhou {nome}.{prop}: {str(e)[:80]}")
            continue
        if lista:
            valores[f"{nome}.{prop}"] = _amostrar(lista, quantos)
    try:
        rotulos = [
            r["v"]
            for r in consulta("MATCH (f:FinancialFact) RETURN DISTINCT f.metric AS v ORDER BY v")
            if r["v"]
        ]
    except Exception as e:
        avisos.append(f"rotulos_falhou: {str(e)[:80]}")
        rotulos = []
    try:
        recortes = {
            r["m"]: r["dims"]
            for r in consulta(
                "MATCH ()-[r:OF_METRIC]->(m:Metric) WHERE r.dimension IS NOT NULL "
                "RETURN m.name AS m, collect(DISTINCT r.dimension) AS dims ORDER BY size(dims) DESC"
            )
        }
    except Exception as e:
        avisos.append(f"recortes_falhou: {str(e)[:80]}")
        recortes = {}
    esquema = {"nos": nos, "relacoes": relacoes, "valores": valores, "entidades": entidades}
    esquema["rotulos"] = agrupar_rotulos(rotulos)
    esquema["rotulos_todos"] = rotulos  # para o ranking por pergunta; não vai inteiro ao prompt
    esquema["recortes"] = {m: _amostrar(sorted(d), RECORTES_POR_METRICA) for m, d in recortes.items()}
    return esquema, avisos


_SEM_VALOR = {
    "a", "o", "as", "os", "de", "do", "da", "dos", "das", "e", "em", "no", "na", "nos", "nas", "um", "uma",
    "que", "qual", "quais", "quanto", "quantos", "quantas", "ha", "mais", "menos", "entre",
    "para", "por", "com", "se", "ou", "somando", "soma", "somados", "diferenca", "total", "tem", "sao",
    "foi", "ser", "ao", "aos", "pelo", "pela", "maior", "menor", "ano", "anos",
}  # fmt: skip


def _radicais(texto: str) -> set[str]:
    """Palavras úteis, sem acento e sem plural simples: 'pardos' e 'Pardo' casam."""
    saida = set()
    for t in _norm(texto).split():
        if t in _SEM_VALOR or len(t) < 3:
            continue
        saida.add(t[:-2] if t.endswith(("es", "ns")) and len(t) > 5 else t.rstrip("s"))
    return saida


def rotulos_candidatos(pergunta: str, rotulos: list[str], k: int = CANDIDATOS_POR_PERGUNTA) -> list[str]:
    """Os `k` rótulos de `f.metric` mais parecidos com a pergunta (palavras em comum, as raras pesam mais).
    É a ligação entre a pergunta e o vocabulário do grafo; o LLM ainda escolhe, mas escolhe entre poucos."""
    if not rotulos:
        return []
    alvo = _radicais(pergunta)
    docs = [(r, _radicais(r)) for r in rotulos]
    freq: dict[str, int] = {}
    for _, rad in docs:
        for t in rad:
            freq[t] = freq.get(t, 0) + 1
    pontos = []
    for r, rad in docs:
        comuns = alvo & rad
        if comuns:
            peso = sum(1.0 + 1.0 / freq[t] for t in comuns)
            pontos.append((peso - 0.01 * len(rad - alvo), r))  # rótulo sem palavras sobrando empata melhor
    pontos.sort(key=lambda x: (-x[0], x[1]))
    return [r for _, r in pontos[:k]]


def agrupar_rotulos(
    rotulos: list[str], por_familia: int = 6, max_chars: int = MAX_CHARS_ROTULOS
) -> list[str]:
    """Rótulos distintos de `f.metric` (o vocabulário que o filtro precisa copiar). Famílias de rótulos quase
    iguais (as 40 faixas de provisão, os 20 programas de remuneração) entram com alguns exemplos e a contagem
    do resto; o total é cortado em `max_chars`."""
    familias: dict[str, list[str]] = {}
    for r in rotulos:
        familias.setdefault(" ".join(r.split()[:3]), []).append(r)
    saida: list[str] = []
    usados = 0
    for membros in familias.values():
        mostrados = membros[:por_familia]
        if len(membros) > por_familia:
            mostrados.append(f"(+{len(membros) - por_familia} rótulos semelhantes a '{membros[0][:40]}')")
        for r in mostrados:
            if usados + len(r) + 3 > max_chars:
                return saida
            saida.append(r)
            usados += len(r) + 3
    return saida


def agrupar_relacoes(relacoes: list[tuple], entidades: set[str], maximo: int = 4) -> list[tuple]:
    """Relações que ligam muitos pares de tipos de entidade (RELATED_TO, MENTIONED_IN...) viram uma linha só,
    com `Entidade` no lugar do rótulo; sem isso o esquema lista o produto cartesiano (20 mil caracteres)."""
    por_tipo: dict[str, int] = {}
    for _, tipo, _, _ in relacoes:
        por_tipo[tipo] = por_tipo.get(tipo, 0) + 1
    saida: dict[tuple, tuple] = {}
    for origem, tipo, destino, props in relacoes:
        if por_tipo[tipo] > maximo:
            origem = "Entidade" if origem in entidades else origem
            destino = "Entidade" if destino in entidades else destino
        saida[(origem, tipo, destino)] = (origem, tipo, destino, props)
    return sorted(saida.values(), key=lambda r: r[:3])


def formatar_esquema(esquema: dict) -> str:
    """Esquema em texto para o prompt. Vetores e textos longos ficam de fora."""
    linhas = ["Nós (rótulo e propriedades):"]
    for rotulo, props in sorted(esquema["nos"].items()):
        uteis = {p: t for p, t in props.items() if not _oculta(p) and t != "LIST"}
        corpo = ", ".join(f"{p}: {t}" for p, t in uteis.items())
        linhas.append(f"(:{rotulo}) {{{corpo}}}")
    linhas.append("Relações:")
    for origem, tipo, destino, props in esquema["relacoes"]:
        corpo = ", ".join(f"{p}: {t}" for p, t in props.items() if not _oculta(p) and t != "LIST")
        rel = f"[:{tipo} {{{corpo}}}]" if corpo else f"[:{tipo}]"
        linhas.append(f"(:{origem})-{rel}->(:{destino})")
    if esquema.get("entidades"):
        linhas.append("Entidade = qualquer um destes rótulos: " + ", ".join(esquema["entidades"]))
    if esquema.get("rotulos"):
        linhas.append(
            "Rótulos existentes em FinancialFact.metric (copie o texto exato ao filtrar por f.metric):"
        )
        linhas.append(" | ".join(esquema["rotulos"]))
    if esquema.get("recortes"):
        linhas.append(
            "Exemplos de recorte (OF_METRIC.dimension) por métrica; os rótulos de f.metric têm prioridade:"
        )
        for metrica, dims in esquema["recortes"].items():
            linhas.append(f"{metrica}: " + " | ".join(str(d)[:40] for d in dims))
    if esquema.get("valores"):
        linhas.append("Valores de exemplo:")
        for chave, lista in esquema["valores"].items():
            linhas.append(f"{chave}: " + " | ".join(str(v) for v in lista))
    return "\n".join(linhas)


def terminologia(catalogo: list[dict], max_apelidos: int = 6) -> str:
    """Uma linha por métrica: nome do grafo (EN), nome em português e sinônimos."""
    linhas = []
    for m in catalogo:
        apelidos = ", ".join((m.get("aliases") or [])[:max_apelidos])
        extra = f" (também: {apelidos})" if apelidos else ""
        linhas.append(f"- Metric.name = '{m['name']}' ← {m.get('name_pt', '')}{extra}")
    return "\n".join(linhas)


# ---------- exemplos e prompt ----------


def carregar_exemplos(caminho: Path | str | None = None) -> list[dict]:
    dados = json.loads(Path(caminho or EXEMPLOS).read_text(encoding="utf-8"))
    return [{"pergunta": e["pergunta"], "cypher": e["cypher"]} for e in dados]


def montar_prompt(
    pergunta: str,
    esquema_txt: str,
    terminologia_txt: str,
    exemplos: list[dict],
    candidatos: list[str] | None = None,
) -> list[dict]:
    """Mensagens do LLM. O sistema (esquema, termos, exemplos, formato) é igual em toda pergunta e fica no
    início, onde o cache de prefixo do llama.cpp o reaproveita; o que muda por pergunta vai na mensagem do
    usuário: os rótulos de `f.metric` mais parecidos e, por último, a pergunta."""
    blocos = (
        "\n\n".join(f"Pergunta: {e['pergunta']}\nCypher:\n{e['cypher']}" for e in exemplos)
        or "(sem exemplos)"
    )
    sistema = INSTRUCOES.format(esquema=esquema_txt, terminologia=terminologia_txt, exemplos=blocos)
    usuario = f"Pergunta: {pergunta.strip()}"
    if candidatos:
        lista = "\n".join(f"- {r}" for r in candidatos)
        cabecalho = "Rótulos de f.metric mais parecidos com a pergunta (confira todos antes de escolher):"
        usuario = f"{cabecalho}\n{lista}\n\n{usuario}"
    return [{"role": "system", "content": sistema}, {"role": "user", "content": usuario}]


def chat_cypher(base: str, modelo: str = "qwen36-35b-a3b", timeout: int = 120) -> GeraCypher:
    """Mensagens → texto pelo `/v1/chat/completions`: temperatura 0 (a mesma pergunta dá a mesma consulta),
    sem raciocínio, até 600 tokens (uma agregação com CASE cabe em ~250)."""
    import urllib.request

    def gera(mensagens: list[dict]) -> str:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.0,
            "max_tokens": 600,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)["choices"][0]["message"]["content"].strip()

    return gera


# ---------- do texto do LLM ao Cypher ----------

_INICIO = re.compile(
    r"^[ \t]*((?:MATCH|OPTIONAL\s+MATCH|UNWIND|CALL|WITH|RETURN)\b"
    # escrita e administração também iniciam consulta: chegam à guarda e são bloqueadas lá, em vez de
    # sumirem como "sem_cypher"
    r"|(?:CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD|FOREACH|USE|SHOW|EXPLAIN|PROFILE)\b"
    r"|(?i:match|optional\s+match|unwind|call|create|merge|delete|detach|drop|load|show)\b)",
    re.MULTILINE,
)


def extrair_cypher(texto: str) -> str:
    """A primeira consulta do texto: sem cerca ```, sem prosa antes, sem `Cypher:`, sem o que vem depois do
    primeiro `;` fora de aspas. `ValueError` quando não há Cypher."""
    t = (texto or "").strip()
    m = re.search(r"```[^\n`]*\n?(.*?)```", t, re.DOTALL)
    if m:
        t = m.group(1).strip()
    elif t.startswith("```"):
        t = t.strip("`").strip()
    t = re.sub(r"^\s*cypher\s*:\s*", "", t, flags=re.IGNORECASE)
    achado = _INICIO.search(t)
    if not achado:
        raise ValueError("sem_cypher")
    t = t[achado.start(1) :]
    aspas = ""
    for i, c in enumerate(t):
        if aspas:
            if c == aspas:
                aspas = ""
        elif c in "'\"`":
            aspas = c
        elif c == ";":
            t = t[:i]
            break
    t = t.strip().rstrip(";").strip()
    if not t:
        raise ValueError("sem_cypher")
    return t


def executar(
    driver: Any,
    cypher: str,
    banco: str = "neo4j",
    limite_linhas: int = LIMITE_LINHAS,
    timeout: float = TIMEOUT_S,
) -> tuple[list[dict], bool]:
    """Roda numa sessão de leitura, com tempo limite no servidor; devolve (linhas, truncado)."""
    from neo4j import Query

    linhas: list[dict] = []
    truncado = False
    with driver.session(database=banco, default_access_mode="READ") as sessao:
        for registro in sessao.run(Query(cypher, timeout=timeout)):
            if len(linhas) >= limite_linhas:
                truncado = True
                break
            linhas.append(dict(registro))
    return linhas, truncado


def explicar(driver: Any, cypher: str, banco: str = "neo4j", timeout: float = TIMEOUT_S) -> dict:
    """`EXPLAIN` numa sessão de leitura: o plano não executa nada. Devolve `bloqueio` (operador de escrita),
    `desconhecidos` (nomes que o grafo não tem) e `outros` avisos. Erro de sintaxe levanta."""
    from neo4j import Query

    with driver.session(database=banco, default_access_mode="READ") as sessao:
        resumo = sessao.run(Query("EXPLAIN " + cypher, timeout=timeout)).consume()
    with warnings.catch_warnings():  # `notifications` é o formato com código e descrição; o novo não os traz
        warnings.simplefilter("ignore", DeprecationWarning)
        notificacoes = resumo.notifications
    desconhecidos, outros = avisos_do_plano(notificacoes)
    return {"bloqueio": plano_com_escrita(resumo.plan), "desconhecidos": desconhecidos, "outros": outros}


def _texto_da_linha(linha: dict) -> str:
    return "; ".join(f"{k}={v}" for k, v in linha.items() if v is not None)


def _paginas(valor: Any) -> list[int]:
    if valor is None:
        return []
    itens = valor if isinstance(valor, (list, tuple)) else [valor]
    return [int(x) for x in itens if isinstance(x, (int, float)) and not isinstance(x, bool)]


def evidencias_de(linhas: list[dict]) -> list[dict]:
    """Uma evidência por linha, no contrato das outras ferramentas; a página só vem da coluna `pagina`."""
    return [
        {
            "id": str(linha.get("id") or f"consulta:{i}"),
            "tipo": "consulta",
            "paginas": rotulo_de_paginas(_paginas(linha.get("pagina"))),
            "caminho": "consulta ao grafo",
            "texto": _texto_da_linha(linha),
            "score": 1.0,
        }
        for i, linha in enumerate(linhas)
    ]


def perguntar(
    driver: Any,
    pergunta: str,
    gera: GeraCypher,
    esquema_texto: str | None = None,
    terminologia_texto: str | None = None,
    exemplos: list[dict] | None = None,
    banco: str = "neo4j",
    limite_linhas: int = LIMITE_LINHAS,
    timeout: float = TIMEOUT_S,
    rotulos: list[str] | None = None,
    autocorrigir: bool = True,
) -> dict:
    """Pergunta → Cypher → guarda → linhas. Nunca levanta: falhas voltam em `erro`. `rotulos` são todos os
    `f.metric` do grafo; deles saem os candidatos mais parecidos com a pergunta. A guarda (F6.5) valida o
    texto, olha o plano do `EXPLAIN` e só então executa; erro do banco ou nome inexistente tem uma
    autocorreção; violação da guarda não tem (`erro = "bloqueada_pela_guarda: ..."`)."""
    t0 = time.perf_counter()
    saida: dict = {
        "pergunta": pergunta, "cypher": None, "linhas": [], "evidencias": [], "truncado": False,
        "erro": None, "aviso": None, "latencia_ms": {},
    }  # fmt: skip
    if not (pergunta or "").strip():
        saida["erro"] = "pergunta_vazia"
        return saida
    if esquema_texto is None:
        esquema, saida["avisos_esquema"] = descobrir_esquema(driver, banco)
        esquema_texto = formatar_esquema(esquema)
        rotulos = esquema.get("rotulos_todos") if rotulos is None else rotulos
    if terminologia_texto is None:
        from indexer.catalogo import ler_catalogo

        terminologia_texto = terminologia(ler_catalogo())
    if exemplos is None:
        exemplos = carregar_exemplos()
    candidatos = rotulos_candidatos(pergunta, rotulos or [])
    mensagens = montar_prompt(pergunta, esquema_texto, terminologia_texto, exemplos, candidatos)
    t1 = time.perf_counter()
    try:
        bruto = gera(mensagens)
    except Exception as e:
        saida["erro"] = f"falha_no_llm: {type(e).__name__}: {str(e)[:150]}"
        return saida
    t2 = time.perf_counter()
    saida["resposta_bruta"] = bruto
    try:
        saida["cypher"] = extrair_cypher(bruto)
    except ValueError:
        saida["erro"] = "sem_cypher"
        saida["latencia_ms"] = {"llm": round((t2 - t1) * 1000)}
        return saida
    guarda: dict = {"corrigida": False, "avisos": [], "bloqueada": None}
    saida["guarda"] = guarda
    atual = saida["cypher"]
    for tentativa in range(2 if autocorrigir else 1):
        ultima = tentativa == (1 if autocorrigir else 0)
        pedido, saida["erro"] = None, None
        final, motivo = preparar(atual)  # barreira 1: o texto; nada vai ao banco se falhar
        if motivo:
            guarda["bloqueada"] = motivo
            saida["erro"] = f"bloqueada_pela_guarda: {motivo}"
            break
        saida["cypher"] = final
        try:
            plano = explicar(driver, final, banco, timeout)  # barreira 2: o plano, sem executar
            if plano["bloqueio"]:
                guarda["bloqueada"] = plano["bloqueio"]
                saida["erro"] = f"bloqueada_pela_guarda: {plano['bloqueio']} (plano)"
                break
            guarda["avisos"] = plano["outros"]
            if plano["desconhecidos"]:
                guarda["avisos"] = plano["desconhecidos"] + plano["outros"]
                if not ultima:
                    pedido = "O Neo4j avisou que estes nomes não existem no grafo: " + "; ".join(
                        plano["desconhecidos"]
                    )
            if pedido is None:
                saida["linhas"], saida["truncado"] = executar(driver, final, banco, limite_linhas, timeout)
        except Exception as e:
            saida["erro"] = f"falha_na_execucao: {str(e)[:200]}"
            pedido = f"A consulta falhou no Neo4j com este erro: {str(e)[:300]}"
        if pedido is None or ultima:
            break
        try:  # a única autocorreção: devolve ao LLM a consulta e o erro, e revalida o que ele responder
            nova = gera([
                *mensagens,
                {"role": "assistant", "content": final},
                {"role": "user", "content": f"{pedido}\nConsulta: {final}\nCorrija e responda "
                 "SOMENTE CYPHER, SEM BLOCOS DE CÓDIGO."},
            ])  # fmt: skip
            atual = extrair_cypher(nova)
        except ValueError:
            saida["erro"] = "sem_cypher"
            break
        except Exception as e:
            saida["erro"] = f"falha_no_llm: {type(e).__name__}: {str(e)[:150]}"
            break
        guarda["corrigida"] = True
        saida["linhas"], saida["truncado"] = [], False
    if saida["erro"]:
        saida["linhas"] = []
    t3 = time.perf_counter()
    saida["latencia_ms"] = {"llm": round((t2 - t1) * 1000), "banco": round((t3 - t2) * 1000),
                            "total": round((t3 - t0) * 1000)}  # fmt: skip
    if saida["erro"]:
        return saida
    if not saida["linhas"]:
        saida["aviso"] = "A consulta rodou e não devolveu linhas."
    else:
        saida["evidencias"] = evidencias_de(saida["linhas"])
        if not any(e["paginas"] for e in saida["evidencias"]):
            # soma de conjunto vazio dá 0 sem página: sem página não há como conferir no documento
            saida["aviso"] = "O resultado não cita página; não use como resposta sem conferir."
    return saida


# ---------- medida de acerto ----------


def _norm(texto: Any) -> str:
    sem_acento = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    return " ".join(re.findall(r"[a-z0-9]+", sem_acento.lower()))


def acerto(esperado: Any, tipo: str, linhas: list[dict]) -> bool:
    """Execução certa: o valor esperado aparece no resultado. Número com tolerância de centavo, texto sem
    acento/caixa/espaços. Mais de `MAX_DESPEJO` linhas contam como erro (despejo que acerta por acaso)."""
    if not linhas or len(linhas) > MAX_DESPEJO:
        return False
    valores = [v for linha in linhas for v in linha.values() if v is not None]
    if tipo == "numero":
        alvo = float(esperado)
        return any(
            isinstance(v, (int, float)) and not isinstance(v, bool) and abs(float(v) - alvo) <= 0.01
            for v in valores
        )
    alvo_txt = _norm(esperado)
    return any(alvo_txt and alvo_txt in _norm(v) for v in valores)


def ler_golden(caminho: Path = GOLDEN) -> list[dict]:
    with open(caminho, encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["grupo"] in ("ajuste", "teste")]


def medir(driver: Any, gera: GeraCypher, casos: list[dict], banco: str = "neo4j", **opcoes: Any) -> dict:
    """Acurácia de execução por grupo. `ajuste` serve para iterar o prompt; `teste` é o número do aceite."""
    esquema, avisos = descobrir_esquema(driver, banco)
    esquema_txt = formatar_esquema(esquema)
    from indexer.catalogo import ler_catalogo

    termos = terminologia(ler_catalogo())
    exemplos = carregar_exemplos()
    por_caso = []
    for c in casos:
        r = perguntar(
            driver, c["pergunta"], gera, esquema_txt, termos, exemplos, banco,
            rotulos=esquema["rotulos_todos"], **opcoes,
        )  # fmt: skip
        ok = r["erro"] is None and acerto(
            c["valor"] if c["tipo"] == "texto" else float(c["valor"]), c["tipo"], r["linhas"]
        )
        por_caso.append({
            "id": c["id"], "grupo": c["grupo"], "ok": ok, "erro": r["erro"], "linhas": len(r["linhas"]),
            "latencia_ms": r["latencia_ms"], "cypher": r["cypher"], "resultado": r["linhas"][:5],
            "bloqueada": r["guarda"]["bloqueada"], "corrigida": r["guarda"]["corrigida"],
        })  # fmt: skip

    def taxa(sel: list[dict]) -> dict:
        return {
            "n": len(sel),
            "acertos": sum(x["ok"] for x in sel),
            "acuracia": round(sum(x["ok"] for x in sel) / max(1, len(sel)), 3),
        }

    tempos = [x["latencia_ms"].get("total", 0) for x in por_caso]
    return {
        "teste": taxa([x for x in por_caso if x["grupo"] == "teste"]),
        "ajuste": taxa([x for x in por_caso if x["grupo"] == "ajuste"]),
        "geral": taxa(por_caso),
        "latencia_ms": {
            "mediana": round(statistics.median(tempos)) if tempos else 0,
            "maximo": max(tempos, default=0),
        },
        "avisos_esquema": avisos,
        "prompt_chars": len(esquema_txt) + len(termos),
        "casos": por_caso,
    }


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    from indexer.grafo import conectar

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    p = sub.add_parser("perguntar")
    p.add_argument("pergunta")
    p.add_argument("--mostrar-prompt", action="store_true")
    m = sub.add_parser("medir")
    m.add_argument("--nome", default="f64")
    m.add_argument("--grupo", choices=["ajuste", "teste"], help="só um grupo")
    for s in (p, m):
        s.add_argument("--swap", default="http://127.0.0.1:8080")
        s.add_argument("--llm", default="qwen36-35b-a3b")
        s.add_argument("--raiz", type=Path, default=RAIZ)
        s.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        chat = chat_cypher(a.swap, a.llm)
        if a.acao == "perguntar":
            if a.mostrar_prompt:
                esquema, _ = descobrir_esquema(driver, a.banco)
                from indexer.catalogo import ler_catalogo

                msgs = montar_prompt(
                    a.pergunta, formatar_esquema(esquema), terminologia(ler_catalogo()), carregar_exemplos()
                )
                print(msgs[0]["content"])
            r = perguntar(driver, a.pergunta, chat, banco=a.banco)
            print(json.dumps(r, ensure_ascii=False, indent=2, default=str))
            return
        casos = ler_golden(a.raiz / "eval" / "golden_agregacao.csv")
        if a.grupo:
            casos = [c for c in casos if c["grupo"] == a.grupo]
        r = medir(driver, chat, casos, a.banco)
        detalhes = a.raiz / "data" / "avaliacao"
        detalhes.mkdir(parents=True, exist_ok=True)
        (detalhes / f"{a.nome}-detalhes.json").write_text(
            json.dumps(r, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        # o arquivo versionado leva só os números: nada do documento (ADR-009)
        resumo = {
            k: r[k] for k in ("teste", "ajuste", "geral", "latencia_ms", "avisos_esquema", "prompt_chars")
        }
        resumo["casos"] = [
            {
                k: x[k]
                for k in ("id", "grupo", "ok", "erro", "linhas", "latencia_ms", "bloqueada", "corrigida")
            }
            for x in r["casos"]
        ]
        saida = a.raiz / "eval" / "resultados" / f"{a.nome}.json"
        saida.write_text(json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {k: resumo[k] for k in ("teste", "ajuste", "geral", "latencia_ms")}, ensure_ascii=False
            )
        )
        for x in r["casos"]:
            print(
                ("OK  " if x["ok"] else "ERRO"), x["id"], x["grupo"], x["erro"] or "", (x["cypher"] or "")[:0]
            )
    finally:
        driver.close()


if __name__ == "__main__":
    main()
