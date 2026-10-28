import json
import urllib.request
from io import BytesIO

import pytest

from indexer.reranker import (
    LIMITE_DE_CARACTERES,
    medir,
    recuperar_e_reranquear,
    reranqueador_llama,
    reranquear_pais,
    texto_do_pai,
)


def pai(i: str, texto: str = "corpo", caminho: str = "Seção") -> dict:
    return {"id": i, "text": texto, "caminho": caminho, "tokens": 10, "pageStart": 1, "pageEnd": 1}


def notas_por_palavra(pergunta: str, textos: list[str]) -> list[float]:
    """Reranker falso: 1 ponto por palavra da pergunta que aparece no texto."""
    palavras = set(pergunta.lower().split())
    return [float(sum(p in t.lower() for p in palavras)) for t in textos]


def test_texto_do_pai_junta_caminho_e_corta_no_limite():
    texto, cortado = texto_do_pai(pai("a", "x" * 10, "A › B"))
    assert texto == "A › B\n" + "x" * 10 and cortado is False
    texto, cortado = texto_do_pai(pai("a", "x" * (LIMITE_DE_CARACTERES + 50)))
    assert len(texto) == LIMITE_DE_CARACTERES and cortado is True


def test_reranquear_reordena_pelas_notas_e_guarda_a_posicao_anterior():
    pais = [pai("a", "nada a ver"), pai("b", "o lucro subiu"), pai("c", "lucro e dividendos")]
    r = reranquear_pais("lucro dividendos", pais, notas_por_palavra, top=2)
    assert [p["id"] for p in r["pais"]] == ["c", "b"]
    assert [p["posicao_antes"] for p in r["pais"]] == [3, 2]
    assert r["pais"][0]["nota_rerank"] == 2.0 and r["cortados"] == 0 and r["ms"] >= 0


def test_empate_mantem_a_ordem_da_recuperacao_e_lista_vazia_nao_chama_o_reranker():
    pais = [pai("a"), pai("b"), pai("c")]
    r = reranquear_pais("x", pais, lambda q, t: [1.0] * len(t), top=3)
    assert [p["id"] for p in r["pais"]] == ["a", "b", "c"]

    def nao_deve_ser_chamado(q, t):
        raise AssertionError("não deveria chamar")

    assert reranquear_pais("x", [], nao_deve_ser_chamado)["pais"] == []


def test_cortes_sao_contados():
    pais = [pai("a", "y" * (LIMITE_DE_CARACTERES + 1)), pai("b", "curto")]
    assert reranquear_pais("x", pais, lambda q, t: [0.0, 0.0])["cortados"] == 1


def test_reranqueador_llama_mapeia_index_para_nota_e_valida(monkeypatch):
    chamadas = []

    def falso(req, timeout):
        chamadas.append((req.full_url, json.loads(req.data)))
        resposta = {"results": [{"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]}
        return BytesIO(json.dumps(resposta).encode())

    monkeypatch.setattr(urllib.request, "urlopen", falso)
    notas = reranqueador_llama("http://x:8080", "modelo-r")
    assert notas("q", ["d0", "d1"]) == [0.1, 0.9]
    assert chamadas == [
        ("http://x:8080/v1/rerank", {"model": "modelo-r", "query": "q", "documents": ["d0", "d1"]})
    ]
    with pytest.raises(ValueError, match="notas"):
        notas("q", ["d0", "d1", "d2"])


class DriverFalso:
    def __init__(self, n_pais=10):
        self.n = n_pais

    def execute_query(self, cypher, parametros=None, database_=None):
        class R(dict):
            pass

        if "child_vec" in cypher:
            return [R(id=f"c{i}", score=1 - i / 100) for i in range(self.n)], None, None
        if "child_ft" in cypher:
            return [], None, None
        if "HAS_CHILD" in cypher and "RETURN c.id" in cypher:
            return [R(id=i, pai=f"p{i[1:]}") for i in parametros["ids"]], None, None
        if "HAS_PARENT" in cypher and "ORDER BY p.tokens" in cypher:
            return (
                [R(id=f"p{i}", text="texto " * 5, tokens=100 - i, caminho="S") for i in range(3)],
                None,
                None,
            )
        return (
            [
                R(id=i, text=f"texto {i}", tokens=5, pageStart=1, pageEnd=1, secaoId="s", caminho="S")
                for i in parametros["ids"]
            ],
            None,
            None,
        )


def embute_falso(textos):
    return [[1.0, 0.0] for _ in textos]


def test_pipeline_recupera_24_e_devolve_os_6_melhores_com_latencia_do_rerank():
    driver = DriverFalso(n_pais=10)
    r = recuperar_e_reranquear(
        driver, "texto p7", embute_falso, notas_por_palavra, modo="vetor", candidatos=24, top=3
    )
    assert r["candidatos"] == 10 and len(r["pais"]) == 3
    assert r["pais"][0]["id"] == "p7"  # o reranker puxa para cima o que casa com a pergunta
    assert {"rerank", "total", "embedding_da_consulta"} <= set(r["latencia_ms"])


def test_medir_separa_pais_reais_pior_caso_e_teto_sintetico():
    r = medir(DriverFalso(5), embute_falso, lambda q, t: [0.0] * len(t), ["q1", "q2"])
    assert set(r) >= {"pais_reais_24", "24_maiores_pais", "teto_sintetico_24_x_limite_de_caracteres"}
    assert r["dentro_do_limite"] is True and len(r["24_maiores_pais"]["ms"]) == 5
