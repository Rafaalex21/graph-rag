"""Contrato do Text2Cypher contra o grafo real (F6.4). Pulado sem o Neo4j no ar e o grafo da F5.8.

Formas de falhar (o grafo falso de `test_text2cypher.py` não as pega):
 1. um exemplo *few-shot* tem erro de sintaxe ou propriedade que o grafo não tem, e o LLM aprende o erro;
 2. o `cypher_gabarito` de uma pergunta do golden de agregação não devolve o valor do gabarito (o número do
    aceite mediria um gabarito errado);
 3. a APOC devolve um esquema sem os rótulos que as consultas usam, ou o esquema leva vetor/texto longo;
 4. a sessão de leitura deixa passar uma escrita (a defesa do servidor é a que vale);
 5. o tempo limite não vale (consulta lenta prende a API).
"""

import csv
import socket
from pathlib import Path

import pytest

from indexer.text2cypher import (
    acerto,
    carregar_exemplos,
    descobrir_esquema,
    executar,
    formatar_esquema,
)

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


def respondiveis():
    with open(RAIZ / "eval" / "golden_agregacao.csv", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["grupo"] in ("ajuste", "teste")]


@pytest.mark.parametrize("exemplo", carregar_exemplos(), ids=lambda e: e["pergunta"][:40])
def test_todo_exemplo_few_shot_executa_e_devolve_linhas(grafo, exemplo):
    linhas, _ = executar(grafo, exemplo["cypher"])
    assert linhas, f"exemplo sem resultado: {exemplo['pergunta']}"


@pytest.mark.parametrize("caso", respondiveis(), ids=lambda c: c["id"])
def test_cypher_de_gabarito_devolve_o_valor_do_golden(grafo, caso):
    linhas, _ = executar(grafo, caso["cypher_gabarito"])
    esperado = float(caso["valor"]) if caso["tipo"] == "numero" else caso["valor"]
    assert acerto(esperado, caso["tipo"], linhas), (caso["id"], linhas)


def test_esquema_da_apoc_tem_os_rotulos_e_as_relacoes_que_as_consultas_usam(grafo):
    esquema, avisos = descobrir_esquema(grafo)
    assert not avisos
    for rotulo in ("FinancialFact", "Metric", "Period", "RiskFactor", "Event", "Person"):
        assert rotulo in esquema["nos"]
    assert {"value", "scale", "unit", "metric", "page"} <= set(esquema["nos"]["FinancialFact"])
    assert any(r[:3] == ("FinancialFact", "OF_METRIC", "Metric") for r in esquema["relacoes"])
    assert "2025-FY" in esquema["valores"]["Period.id"]
    texto = formatar_esquema(esquema)
    assert "embedding" not in texto and "FinancialFact" in texto
    assert "Empregados Branco" in texto  # o vocabulário de f.metric está no esquema
    assert len(texto) < 30000  # ~8 mil tokens: cabe no contexto e fica no cache de prefixo


def test_sessao_de_leitura_recusa_escrita(grafo):
    antes, _, _ = grafo.execute_query("MATCH (n) RETURN count(n) AS n", database_="neo4j")
    with pytest.raises(Exception, match="(?i)write|read"):
        executar(grafo, "CREATE (:Intruso {x: 1}) RETURN 1 AS v")
    depois, _, _ = grafo.execute_query("MATCH (n) RETURN count(n) AS n", database_="neo4j")
    assert antes[0]["n"] == depois[0]["n"]


def test_tempo_limite_interrompe_consulta_lenta(grafo):
    with pytest.raises(Exception, match="(?i)timeout|terminated|transaction"):
        executar(grafo, "UNWIND range(1, 100000000) AS x RETURN sum(x * x) AS s", timeout=1)
