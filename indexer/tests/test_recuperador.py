import pytest

from indexer.recuperador import agrupar_por_pai, medir, percentil, recuperar


class Registro(dict):
    pass


class DriverFalso:
    """Vetor/texto devolvem listas fixas; os detalhes vêm de um mapa filho -> pai."""

    def __init__(self, vetor, texto, pai_de):
        self.vetor, self.texto, self.pai_de = vetor, texto, pai_de
        self.pedidos: list[tuple[str, dict | None]] = []

    def execute_query(self, cypher, parametros=None, database_=None):
        self.pedidos.append((cypher, parametros))
        if "child_vec" in cypher:
            return [Registro(id=i, score=s) for i, s in self.vetor], None, None
        if "child_ft" in cypher:
            return [Registro(id=i, score=s) for i, s in self.texto], None, None
        if "HAS_CHILD" in cypher:
            return [Registro(id=i, pai=self.pai_de[i]) for i in parametros["ids"]], None, None
        return (
            [
                Registro(
                    id=i, text=f"texto {i}", tokens=100, pageStart=5, pageEnd=6, secaoId="s1", caminho="A › B"
                )
                for i in parametros["ids"]
            ],
            None,
            None,
        )


def embute_falso(textos):
    return [[1.0, 0.0] for _ in textos]


def test_agrupar_por_pai_usa_o_melhor_filho_e_nao_repete_pai():
    filhos = [("c1", 0.9), ("c2", 0.8), ("c3", 0.7), ("c4", 0.6)]
    pai_de = {"c1": "pA", "c2": "pB", "c3": "pA", "c4": "pC"}
    r = agrupar_por_pai(filhos, pai_de, k=3)
    assert [p["id"] for p in r] == ["pA", "pB", "pC"]
    assert r[0] == {"id": "pA", "score": 0.9, "filhos": ["c1", "c3"]}
    assert [p["id"] for p in agrupar_por_pai(filhos, pai_de, k=2)] == ["pA", "pB"]
    assert agrupar_por_pai([("x", 1.0)], {}, k=3) == []  # filho sem pai é ignorado


def test_recuperar_deduplica_por_pai_e_pede_k_vezes_4_filhos():
    vetor = [(f"c{i}", 1 - i / 100) for i in range(8)]
    pai_de = {f"c{i}": f"p{i // 2}" for i in range(8)}  # 2 filhos por pai
    driver = DriverFalso(vetor, [], pai_de)
    r = recuperar(driver, "pergunta", embute_falso, k=2, modo="vetor")
    assert driver.pedidos[0][1]["k"] == 8  # k x 4
    assert [p["id"] for p in r["pais"]] == ["p0", "p1"] and r["filhos_considerados"] == 8
    assert r["pais"][0]["filhos"] == ["c0", "c1"] and r["pais"][0]["caminho"] == "A › B"
    assert (r["pais"][0]["pageStart"], r["pais"][0]["pageEnd"]) == (5, 6)
    ids = [p["id"] for p in r["pais"]]
    assert len(ids) == len(set(ids))


def test_recuperar_funciona_nos_quatro_modos_e_traz_a_latencia_por_etapa():
    vetor = [("c1", 0.9), ("c2", 0.8)]
    texto = [("c2", 5.0), ("c3", 4.0)]
    pai_de = {"c1": "pA", "c2": "pA", "c3": "pB"}
    for modo in ("vetor", "texto", "hibrido-max", "hibrido-rrf"):
        r = recuperar(DriverFalso(vetor, texto, pai_de), "pergunta", embute_falso, k=5, modo=modo)
        ids = [p["id"] for p in r["pais"]]
        assert len(ids) == len(set(ids)) and ids, modo
        assert set(r["latencia_ms"]) == {"total", "embedding_da_consulta", "busca_nos_indices", "pais"}
    r = recuperar(DriverFalso(vetor, texto, pai_de), "q", embute_falso, k=5, modo="hibrido-rrf")
    assert [p["id"] for p in r["pais"]] == ["pA", "pB"]  # c2 está nas duas listas e puxa o pai A


def test_sem_candidatos_devolve_lista_vazia_e_modo_invalido_falha():
    r = recuperar(DriverFalso([], [], {}), "pergunta", embute_falso, k=3, modo="vetor")
    assert r["pais"] == [] and r["filhos_considerados"] == 0
    with pytest.raises(ValueError, match="modo desconhecido"):
        recuperar(DriverFalso([], [], {}), "x", embute_falso, modo="magico")


def test_percentil_e_medir_conta_duplicatas_e_compara_com_o_limite():
    assert percentil([1, 2, 3, 4, 5], 0.5) == 3 and percentil([10], 0.95) == 10
    vetor = [(f"c{i}", 1 - i / 100) for i in range(8)]
    pai_de = {f"c{i}": f"p{i // 2}" for i in range(8)}
    driver = DriverFalso(vetor, [("c0", 3.0)], pai_de)
    r = medir(driver, embute_falso, ["q1", "q2"], k=2, repeticoes=2)
    assert r["perguntas"] == 2 and r["vetor"]["consultas"] == 4
    assert all(
        r[m]["pais_duplicados"] == 0 and r[m]["dentro_do_limite"]
        for m in ("vetor", "texto", "hibrido-max", "hibrido-rrf")
    )
    assert set(r["vetor"]["ms_medio_por_etapa"]) == {"embedding_da_consulta", "busca_nos_indices", "pais"}
