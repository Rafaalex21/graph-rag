"""Contrato dos templates Cypher contra o grafo real (F6.3, aceite: "testes de contrato contra o grafo real").

Rodam só com o Neo4j no ar e o grafo da F5.8 carregado; sem ele (CI, máquina sem o banco) são pulados.
Os valores esperados vêm do golden set (N01, N02, T15), não do código: se o grafo mudar, o teste diz.

Formas de falhar (além das de `test_templates_cypher.py`, que usa um grafo falso):
 1. uma consulta tem erro de sintaxe ou usa propriedade que o grafo não tem (o falso não pega);
 2. a escala/unidade do fato real faz o lucro sair errado (N01) ou o valor trocar de página (N02);
 3. a resposta de qualquer ferramenta foge do contrato `evidencias[]` (campos, ids repetidos);
 4. um template escreve no grafo;
 5. a presidente não é achada pelo cargo (T15) ou o cargo gravado como nome some do aviso.
"""

import csv
import socket
from pathlib import Path

import pytest

from indexer.templates_cypher import (
    CONSULTAS,
    comparar_segmentos,
    eventos,
    fato_financeiro,
    pessoas_cargos,
    riscos,
    serie_metrica,
)

RAIZ = Path(__file__).resolve().parents[2]
CAMPOS = {"id", "tipo", "paginas", "caminho", "texto", "score"}


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


def contar(driver):
    r, _, _ = driver.execute_query("MATCH (n) RETURN count(n) AS n", database_="neo4j")
    s, _, _ = driver.execute_query("MATCH ()-[r]->() RETURN count(r) AS n", database_="neo4j")
    return r[0]["n"], s[0]["n"]


def golden(id_):
    with open(RAIZ / "eval" / "golden.csv", encoding="utf-8") as f:
        return next(r for r in csv.DictReader(f) if r["id"] == id_)


def confere_contrato(r):
    assert r["erro"] is None, r
    ids = [e["id"] for e in r["evidencias"]]
    assert len(ids) == len(set(ids))
    for e in r["evidencias"]:
        assert CAMPOS <= set(e) and e["texto"] and isinstance(e["score"], float)
        assert e["paginas"] == "" or e["paginas"].startswith("p. ")
    assert r["latencia_ms"] < 10_000


def test_toda_consulta_executa_no_explain(grafo):
    parametros = {
        "emissor": {},
        "entidades_dos_fatos": {},
        "fatos": {
            "metrica": "metric:net_income",
            "entidades": ["x"],
            "qualificador": "nenhum",
            "unidade": "currency",
            "periodos": None,
            "tipo_periodo": None,
            "modo": "total",
            "limite": 5,
        },  # fmt: skip
        "riscos": {"categoria": None, "sem_categoria": False, "teto": 5},
        "eventos": {"teto": 5},
        "pessoas": {"teto": 5},
    }
    assert set(parametros) == set(CONSULTAS)
    for nome, consulta in CONSULTAS.items():
        grafo.execute_query("EXPLAIN " + consulta, parametros[nome], database_="neo4j")


def test_n01_lucro_liquido_de_2025_bate_com_o_golden(grafo):
    g = golden("N01")
    r = fato_financeiro(grafo, "lucro líquido do exercício", periodo="2025")
    confere_contrato(r)
    assert len(r["fatos"]) == 1 and r["conflito"] is False
    f = r["fatos"][0]
    assert f["valor_absoluto"] == float(g["valor"]) * 1_000_000
    assert str(g["paginas"]) in {str(p) for p in f["paginas"]}
    assert "R$ 16.782 milhões" in r["evidencias"][0]["texto"]


def test_n02_receita_liquida_de_juros_de_2025_bate_com_o_golden(grafo):
    g = golden("N02")
    r = fato_financeiro(grafo, "receita líquida de juros", periodo="2025")
    confere_contrato(r)
    assert [f["valor_absoluto"] for f in r["fatos"]] == [float(g["valor"]) * 1_000_000]
    assert str(g["paginas"]) in {str(p) for p in r["fatos"][0]["paginas"]}


def test_sem_periodo_vale_o_ano_base_e_nao_a_projecao(grafo):
    r = fato_financeiro(grafo, "lucro")
    confere_contrato(r)
    assert r["periodo_assumido"] is True and {f["periodo"] for f in r["fatos"]} == {"2025-FY"}


def test_entidade_do_grupo_e_entidade_desconhecida(grafo):
    sub = fato_financeiro(grafo, "lucro", entidade="bb consorcios", periodo="2025")
    confere_contrato(sub)
    assert sub["fatos"] and all(f["entidade"] == "BB Consórcios" for f in sub["fatos"])
    ruim = fato_financeiro(grafo, "lucro", entidade="Empresa Que Nao Existe", periodo="2025")
    assert ruim["erro"] == "entidade_desconhecida" and ruim["evidencias"] == []


def test_serie_nao_inventa_o_que_o_grafo_nao_tem(grafo):
    r = serie_metrica(grafo, "carteira de crédito")
    confere_contrato(r)
    anos = [p["periodo"] for p in r["pontos"]]
    assert anos == sorted(anos) and set(anos) >= {"2023-FY", "2024-FY", "2025-FY"}
    lucro = serie_metrica(grafo, "lucro líquido")
    confere_contrato(lucro)
    assert (
        len(lucro["pontos"]) < 3
    )  # o grafo só tem o lucro de 2025 do emissor: a série não completa 2023 e 2024


def test_comparar_segmentos_da_carteira_em_2025(grafo):
    r = comparar_segmentos(
        grafo, "carteira de crédito", ["Rurais", "Imobiliário", "Aeroespacial"], periodo="2025"
    )
    confere_contrato(r)
    assert {s["segmento"] for s in r["segmentos"]} == {"Rurais", "Imobiliário"}
    assert r["nao_encontrados"] == ["Aeroespacial"]
    valores = [s["valor_absoluto"] for s in r["segmentos"]]
    assert valores == sorted(valores, reverse=True)
    todos = comparar_segmentos(grafo, "carteira de crédito", periodo="2025", limite=5)
    assert len(todos["segmentos"]) == 5 and todos["omitido"]["segmentos"] > 0


def test_riscos_por_categoria_e_por_tema(grafo):
    r = riscos(grafo, categoria="credit", limite=5)
    confere_contrato(r)
    assert r["evidencias"] and all("[credit]" in e["texto"] for e in r["evidencias"])
    assert all(e["tipo"] == "risco" for e in r["evidencias"])
    t = riscos(grafo, tema="risco cibernético", limite=5)
    confere_contrato(t)
    assert t["evidencias"] and any("ciber" in e["texto"].lower() for e in t["evidencias"])
    assert riscos(grafo, tema="criptomoedas de gato")["evidencias"] == []


def test_eventos_de_2025_so_trazem_datas_de_2025_e_contam_os_sem_data(grafo):
    r = eventos(grafo, ano=2025)
    confere_contrato(r)
    assert r["evidencias"] and all(e["texto"].startswith("2025") for e in r["evidencias"])
    assert r["omitido"]["sem_data"] > 0 and "sem data" in r["aviso"]


def test_t15_a_diretora_presidente_e_achada_pelo_cargo(grafo):
    g = golden("T15")
    r = pessoas_cargos(grafo, cargo="diretora presidente")
    confere_contrato(r)
    esperado = g["gabarito"].rstrip(".")
    achadas = [p for p in r["pessoas"] if p["nome"] == esperado]
    assert achadas and achadas[0]["fonte"] == "resumo" and achadas[0]["paginas"]
    assert all(not p["nome_parece_cargo"] or p["fonte"] == "cargo" for p in r["pessoas"])


def test_cargo_gravado_como_nome_sai_marcado(grafo):
    r = pessoas_cargos(grafo, nome="Diretoria Executiva")
    confere_contrato(r)
    assert r["pessoas"] and all(p["nome_parece_cargo"] for p in r["pessoas"]) and r["aviso"]


def test_nenhum_template_escreveu_no_grafo(grafo):
    antes = contar(grafo)
    fato_financeiro(grafo, "lucro", periodo="2025")
    serie_metrica(grafo, "carteira de crédito")
    comparar_segmentos(grafo, "carteira de crédito", periodo="2025")
    riscos(grafo)
    eventos(grafo)
    pessoas_cargos(grafo, cargo="presidente")
    assert contar(grafo) == antes
