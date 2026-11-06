"""Guarda-corpos contra o grafo real (F6.5). Pulado sem o Neo4j no ar e o grafo da F5.8.

O aceite é "20 entradas maliciosas ou malformadas bloqueadas **sem escrita no banco**": aqui a contagem de
nós, relações e propriedades do grafo real é a mesma antes e depois de cada entrada. Além do texto
(`preparar`), confere as barreiras que só o servidor dá: o plano do `EXPLAIN` mostra o operador de escrita,
a sessão `READ` recusa a escrita, o tempo limite derruba a consulta lenta e os nomes que não existem viram
aviso.
"""

import socket
from pathlib import Path

import pytest

from indexer.guarda_cypher import preparar
from indexer.text2cypher import carregar_exemplos, executar, explicar, perguntar
from test_guarda_cypher import LEGITIMAS, MALICIOSAS  # a mesma lista do teste sem banco

RAIZ = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def grafo():
    try:
        socket.create_connection(("127.0.0.1", 7687), timeout=1).close()
        from indexer.grafo import conectar

        driver = conectar(RAIZ)
        registros, _, _ = driver.execute_query(
            "MATCH (f:FinancialFact) RETURN count(f) AS n", database_="neo4j"
        )
        if not registros[0]["n"]:
            pytest.skip("grafo sem fatos financeiros")
    except Exception as e:  # qualquer falha de ambiente pula o contrato
        pytest.skip(f"Neo4j indisponível: {e}")
    yield driver
    driver.close()


def estado(driver):
    """Nós, relações e uma soma de propriedades: qualquer escrita muda pelo menos um dos três."""
    n, _, _ = driver.execute_query("MATCH (n) RETURN count(n) AS n", database_="neo4j")
    r, _, _ = driver.execute_query("MATCH ()-[r]->() RETURN count(r) AS n", database_="neo4j")
    v, _, _ = driver.execute_query("MATCH (f:FinancialFact) RETURN sum(f.value) AS s", database_="neo4j")
    return n[0]["n"], r[0]["n"], v[0]["s"]


def llm_fixo(texto):
    return lambda mensagens: texto


@pytest.mark.parametrize("nome, cypher", MALICIOSAS, ids=[n for n, _ in MALICIOSAS])
def test_entrada_maliciosa_nao_escreve_no_grafo_real(grafo, nome, cypher):
    antes = estado(grafo)
    r = perguntar(
        grafo, "pergunta qualquer", llm_fixo(cypher), esquema_texto="E", terminologia_texto="T", exemplos=[]
    )
    # bloqueada, ou (só o caso do `;`) reduzida à primeira consulta, que é de leitura: nunca a escrita
    assert r["erro"] or "DELETE" not in (r["cypher"] or "").upper(), (nome, r["cypher"])
    assert r["erro"] or nome == "depois_de_ponto_e_virgula", nome
    assert estado(grafo) == antes


ESCRITAS = [
    "CREATE (:Intruso {x: 1})",
    "MERGE (:Intruso {x: 1})",
    "MATCH (n:Intruso) DETACH DELETE n",
    "MATCH (n:Intruso) SET n.x = 2",
    "MATCH (n:Intruso) REMOVE n.x",
    "FOREACH (i IN [1] | CREATE (:Intruso))",
    "CALL apoc.cypher.runWrite('CREATE (n:Intruso)', {}) YIELD value RETURN value",
]


@pytest.mark.parametrize("cypher", ESCRITAS)
def test_plano_do_servidor_denuncia_a_escrita_mesmo_sem_o_filtro_de_texto(grafo, cypher):
    antes = estado(grafo)
    assert explicar(grafo, cypher)["bloqueio"], cypher
    assert estado(grafo) == antes  # EXPLAIN não executa


@pytest.mark.parametrize("cypher", ESCRITAS[:6])
def test_sessao_de_leitura_recusa_a_escrita_se_tudo_o_mais_falhar(grafo, cypher):
    antes = estado(grafo)
    with pytest.raises(Exception, match="(?i)write|read"):
        executar(grafo, cypher)
    assert estado(grafo) == antes


def test_consulta_de_leitura_passa_no_plano_e_nome_inexistente_vira_aviso(grafo):
    ok = explicar(grafo, "MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1")
    assert ok["bloqueio"] is None and ok["desconhecidos"] == []
    ruim = explicar(grafo, "MATCH (f:FinancialFact) WHERE f.valorInexistente > 1 RETURN f.value AS v LIMIT 1")
    assert ruim["bloqueio"] is None and any("valorInexistente" in d for d in ruim["desconhecidos"])
    rotulo = explicar(grafo, "MATCH (n:RotuloQueNaoExiste) RETURN n LIMIT 1")
    assert rotulo["desconhecidos"]


def test_erro_de_sintaxe_levanta_no_explain(grafo):
    with pytest.raises(Exception, match="(?i)syntax|invalid"):
        explicar(grafo, "MATCH (n RETURN n LIMIT 1")


def test_tempo_limite_de_5_s_derruba_o_produto_cartesiano(grafo):
    cartesiano = "MATCH (a:FinancialFact), (b:FinancialFact), (c:FinancialFact) RETURN count(*) AS n"
    r = perguntar(
        grafo, "q?", llm_fixo(cartesiano), esquema_texto="E", terminologia_texto="T", exemplos=[],
        autocorrigir=False,
    )  # fmt: skip
    assert r["erro"].startswith("falha_na_execucao") and r["latencia_ms"]["total"] < 20000
    assert r["guarda"]["avisos"]  # o EXPLAIN já avisava do produto cartesiano


def test_consultas_legitimas_passam_pela_guarda_e_pelo_plano(grafo):
    for cypher in [*LEGITIMAS[:1], *[e["cypher"] for e in carregar_exemplos()]]:
        final, motivo = preparar(cypher)
        assert motivo is None, cypher
        assert explicar(grafo, final)["bloqueio"] is None


def test_exemplos_continuam_devolvendo_linhas_atraves_do_perguntar(grafo):
    for e in carregar_exemplos():
        r = perguntar(
            grafo, e["pergunta"], llm_fixo(e["cypher"]), esquema_texto="E", terminologia_texto="T",
            exemplos=[], autocorrigir=False,
        )  # fmt: skip
        assert r["erro"] is None and r["linhas"], (e["pergunta"], r["erro"])


def test_autocorrecao_no_grafo_real_conserta_sintaxe_e_nome_inexistente(grafo):
    respostas = iter(
        [
            "MATCH (f:FinancialFact RETURN f.value AS v",  # sintaxe: o EXPLAIN levanta
            "MATCH (f:FinancialFact) WHERE f.valorInexistente > 1 RETURN f.value AS v",  # nome inexistente
            "MATCH (f:FinancialFact) RETURN f.value AS v, f.page AS pagina",
        ]
    )
    chamadas: list = []

    def gera(mensagens):
        chamadas.append(mensagens)
        return next(respostas)

    r = perguntar(grafo, "q?", gera, esquema_texto="E", terminologia_texto="T", exemplos=[])
    # a 1ª resposta falha na sintaxe e é corrigida pela 2ª; a 2ª tem nome inexistente, mas a correção é
    # uma só: o resultado segue com o aviso do Neo4j e sem uma terceira chamada ao LLM
    assert len(chamadas) == 2 and r["guarda"]["corrigida"] and r["guarda"]["avisos"]
    assert "Invalid input" in chamadas[1][-1]["content"] or "syntax" in chamadas[1][-1]["content"].lower()
