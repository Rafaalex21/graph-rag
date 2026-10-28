import math

import pytest

from indexer.busca import (
    CRIAR_INDICE_FT,
    MODOS,
    buscar,
    escapar_lucene,
    fundir_max,
    fundir_rrf,
    normalizar_pelo_maximo,
    palavras_raras,
)


class Registro(dict):
    pass


class DriverFalso:
    """Responde às três consultas de `buscar` com listas fixas e registra o que foi pedido."""

    def __init__(self, vetor, texto):
        self.vetor, self.texto = vetor, texto
        self.pedidos: list[tuple[str, dict]] = []

    def execute_query(self, cypher, parametros=None, database_=None):
        self.pedidos.append((cypher, parametros))
        if "child_vec" in cypher:
            return [Registro(id=i, score=s) for i, s in self.vetor], None, None
        if "child_ft" in cypher:
            return [Registro(id=i, score=s) for i, s in self.texto], None, None
        ids = parametros["ids"]
        return (
            [
                Registro(id=i, text=f"Seção\ntexto {i}", pageStart=3, pageEnd=4, parentId=f"p-{i}")
                for i in ids
            ],
            None,
            None,
        )


def embute_falso(textos):
    return [[1.0, 0.0] for _ in textos]


def test_normalizacao_pelo_maximo():
    assert normalizar_pelo_maximo([("a", 4.0), ("b", 2.0)]) == {"a": 1.0, "b": 0.5}
    assert normalizar_pelo_maximo([]) == {}
    assert normalizar_pelo_maximo([("a", 0.0)]) == {"a": 0.0}


def test_hibrido_max_soma_ponderada_e_o_que_falta_conta_zero():
    vetor = [("a", 0.9), ("b", 0.45)]  # normalizado: a=1, b=0,5
    texto = [("b", 10.0), ("c", 5.0)]  # normalizado: b=1, c=0,5
    r = dict(fundir_max(vetor, texto, alfa=0.5))
    assert math.isclose(r["a"], 0.5) and math.isclose(r["b"], 0.75) and math.isclose(r["c"], 0.25)
    assert [i for i, _ in fundir_max(vetor, texto, alfa=0.5)] == ["b", "a", "c"]
    # alfa = 1 reproduz só o vetor; alfa = 0, só o texto
    assert [i for i, _ in fundir_max(vetor, texto, alfa=1.0)][:2] == ["a", "b"]
    assert [i for i, _ in fundir_max(vetor, texto, alfa=0.0)][:2] == ["b", "c"]


def test_rrf_usa_so_a_posicao_e_nao_o_escore():
    vetor = [("a", 0.99), ("b", 0.10)]
    texto = [("b", 1000.0), ("a", 0.001)]
    r = dict(fundir_rrf(vetor, texto, k=60))
    esperado = 1 / 61 + 1 / 62
    assert math.isclose(r["a"], esperado) and math.isclose(r["b"], esperado)
    # item presente só numa lista recebe só a contribuição dela
    assert math.isclose(dict(fundir_rrf([("x", 1.0)], [], k=60))["x"], 1 / 61)


def test_rrf_e_max_discordam_quando_um_escore_e_muito_maior():
    vetor = [("a", 0.80), ("b", 0.79)]
    texto = [("b", 50.0), ("c", 49.0), ("a", 1.0)]
    assert fundir_max(vetor, texto)[0][0] == "b"
    assert fundir_rrf(vetor, texto)[0][0] == "b"
    texto2 = [("c", 50.0), ("a", 49.0)]
    assert fundir_rrf([("a", 0.9), ("c", 0.1)], texto2)[0][0] == "a"


def test_escapar_lucene_neutraliza_sintaxe_e_palavras_reservadas():
    assert escapar_lucene("Qual a receita (2025)?") == r"Qual a receita \(2025\)\?"
    assert escapar_lucene("lucro AND perda OR not x") == "lucro perda x"
    assert escapar_lucene("a/b: c*d") == r"a\/b\: c\*d"
    assert escapar_lucene("   ") == ""


def test_cada_modo_consulta_so_os_indices_necessarios():
    for modo, usa_vetor, usa_texto in (
        ("vetor", True, False),
        ("texto", False, True),
        ("hibrido-max", True, True),
        ("hibrido-rrf", True, True),
    ):
        driver = DriverFalso([("a", 0.9)], [("b", 3.0)])
        buscar(driver, "pergunta", embute_falso, k=2, modo=modo)
        cyphers = " ".join(c for c, _ in driver.pedidos)
        assert ("child_vec" in cyphers) is usa_vetor and ("child_ft" in cyphers) is usa_texto, modo


def test_buscar_devolve_top_k_com_paginas_pai_e_posicoes_nas_listas():
    driver = DriverFalso([("a", 0.9), ("b", 0.8), ("c", 0.7)], [("c", 9.0), ("a", 4.0)])
    r = buscar(driver, "pergunta", embute_falso, k=2, modo="hibrido-rrf")
    assert [x["id"] for x in r] == ["a", "c"]
    assert r[0]["posicao_vetor"] == 1 and r[0]["posicao_texto"] == 2 and r[0]["parentId"] == "p-a"
    assert (r[0]["pageStart"], r[0]["pageEnd"]) == (3, 4)
    vetor_so = buscar(driver, "pergunta", embute_falso, k=2, modo="vetor")
    assert [x["id"] for x in vetor_so] == ["a", "b"] and vetor_so[0]["posicao_texto"] is None


def test_candidatos_padrao_sao_k_vezes_4_e_a_consulta_do_vetor_leva_instrucao():
    capturado = {}

    def embute(textos):
        capturado["texto"] = textos[0]
        return [[1.0, 0.0]]

    driver = DriverFalso([("a", 0.9)], [])
    buscar(driver, "Qual o lucro?", embute, k=3, modo="vetor")
    assert driver.pedidos[0][1]["k"] == 12
    assert capturado["texto"].startswith("Instruct: ") and capturado["texto"].endswith("Query: Qual o lucro?")


def test_modo_invalido_e_pergunta_em_branco_no_modo_texto():
    with pytest.raises(ValueError, match="modo desconhecido"):
        buscar(DriverFalso([], []), "x", embute_falso, modo="magico")
    assert buscar(DriverFalso([], [("a", 1.0)]), "   ", embute_falso, modo="texto") == []
    assert set(MODOS) == {"vetor", "texto", "hibrido-max", "hibrido-rrf"}


def test_indice_fulltext_usa_o_analisador_brazilian():
    assert "child_ft" in CRIAR_INDICE_FT and "'brazilian'" in CRIAR_INDICE_FT and "n.text" in CRIAR_INDICE_FT


def test_palavras_raras_ordena_pela_menor_frequencia_de_documento():
    textos = {
        "1": "Seção\nbanco governança governança zebrafish",
        "2": "Seção\nbanco governança crédito",
        "3": "Seção\nbanco crédito crédito",
    }
    raras = palavras_raras(textos, por_filho=2)
    assert raras["1"][0] == "zebrafish" and "banco" not in raras["1"]
    assert raras["2"][0] in ("crédito", "governança")
