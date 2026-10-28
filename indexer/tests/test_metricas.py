from pathlib import Path

import pytest

from indexer.avaliar import ler_golden, montar_relatorio
from indexer.metricas import (
    acerto_numerico,
    calcular,
    concordancia_numerica_com_o_juiz,
    escala_do_gabarito,
    numeros_da_resposta,
    page_recall,
    pagina_citada,
    percentil,
)

GOLDEN = Path(__file__).resolve().parents[2] / "eval" / "golden.csv"


def caso(**kw):
    base = {"id": "X1", "categoria": "numerica", "paginas": "93", "tipo_gabarito": "valor", "valor": "16782",
            "unidade": "R$ milhões", "no_recorte": "sim"}  # fmt: skip
    return {**base, **kw}


def ctx(*rotulos):
    return [{"paginas": r, "caminho": "s", "texto": "t"} for r in rotulos]


def test_numeros_ignoram_citacoes_e_entendem_escalas():
    assert numeros_da_resposta("Foram R$ 16.782 milhões [p. 93].") == [(16782.0, 16782e6, True)]
    assert numeros_da_resposta("Cerca de 85,2 mil funcionários") == [(85.2, 85200.0, True)]
    assert numeros_da_resposta("R$ 2.341.685,44 e 54,9%") == [
        (2341685.44, 2341685.44, False),
        (54.9, 54.9, False),
    ]
    assert numeros_da_resposta("Três sociedades") == [(3.0, 3.0, False)]


@pytest.mark.parametrize(
    ("unidade", "escala"),
    [
        ("R$ milhões", 1e6),
        ("R$ bilhões", 1e9),
        ("mil funcionários", 1e3),
        ("R$", 1.0),
        ("%", 1.0),
        ("empregados", 1.0),
    ],
)
def test_escala_do_gabarito(unidade, escala):
    assert escala_do_gabarito(unidade) == escala


def test_acerto_numerico_tolerancia_de_meio_por_cento():
    c = caso()
    assert acerto_numerico(c, "O lucro foi de R$ 16.782 milhões [p. 93].")
    assert acerto_numerico(c, "R$ 16.850 milhões")  # +0,4%
    assert not acerto_numerico(c, "R$ 16.900 milhões")  # +0,7%
    assert acerto_numerico(c, "R$ 16,8 bilhões")  # outra escala, mesmo valor (+0,1%)
    assert not acerto_numerico(c, "Não encontrei essa informação nos trechos recuperados.")
    assert acerto_numerico(c, "Foram R$ 16.782 [p. 93]")  # sem escala, vale na unidade do gabarito
    assert not acerto_numerico(c, "R$ 16.782 bilhões")  # escala escrita errada: 1.000 vezes maior


def test_acerto_numerico_ignora_o_sinal_e_a_pagina_citada():
    c = caso(valor="-168393")
    assert acerto_numerico(c, "R$ 168.393 milhões aplicados")
    assert not acerto_numerico(caso(valor="3", unidade="sociedades"), "Veja [p. 3].")


def test_gabarito_em_texto_passa_no_proprio_acerto_numerico():
    for c in ler_golden(GOLDEN):
        if c["tipo_gabarito"] == "valor":
            assert acerto_numerico(c, c["gabarito"]), c["id"]


def test_page_recall_por_k_na_ordem_do_rerank():
    c = caso(paginas="93|94")
    r = page_recall(c, ctx("p. 6", "p. 93", "p. 94-95"))
    assert r[1] == {"recall": 0.0, "acerto": 0.0}
    assert r[3] == {"recall": 1.0, "acerto": 1.0}
    r = page_recall(c, ctx("p. 93"))
    assert r[6] == {"recall": 0.5, "acerto": 1.0}
    assert page_recall(c, [])[6] == {"recall": 0.0, "acerto": 0.0}


def test_pagina_citada():
    assert pagina_citada(caso(paginas="93|94"), "Sim [p. 94].")
    assert not pagina_citada(caso(paginas="93"), "Sim [p. 6].")
    assert not pagina_citada(caso(paginas="93"), "Não encontrei.")


def test_percentil_interpola_como_numpy():
    v = [1.0, 2.0, 3.0, 4.0, 10.0]
    assert percentil(v, 50) == 3.0
    assert percentil(v, 95) == pytest.approx(8.8)
    assert percentil([], 50) is None
    assert percentil([7.0], 95) == 7.0


def _execucao():
    casos = [
        caso(id="N1"),
        caso(id="T1", categoria="factual_textual", tipo_gabarito="texto", valor="", unidade="", paginas="6"),
        caso(id="F1", categoria="fora_do_escopo", tipo_gabarito="recusa", valor="", unidade="", paginas=""),
    ]

    def r(i, texto, rotulos, s, erro=None):
        return {"id": i, "resposta": texto, "contexto": ctx(*rotulos), "segundos": s, "erro": erro}

    respostas = [
        r("N1", "R$ 16.782 milhões [p. 93]", ["p. 93"], 4.0),
        r("T1", "A União [p. 7]", ["p. 7"], 10.0),
        r("F1", "Não encontrei.", [], 2.0),
    ]  # fmt: skip
    notas = [{"id": i, "metrica": "correcao", "nota": n, "falha_do_juiz": False}
             for i, n in (("N1", 1.0), ("T1", 0.0), ("F1", 1.0))]  # fmt: skip
    return casos, respostas, notas


def test_calcular_agrega_por_filtro_e_ignora_perguntas_sem_pagina():
    casos, respostas, _ = _execucao()
    m = calcular(casos, respostas)["mecanicas"]
    g = m["geral"]
    assert g["page_recall"]["@6"] == {"n": 2, "media": 0.5}
    assert g["pagina_citada"] == {"n": 2, "media": 0.5}
    assert g["acerto_numerico"] == {"n": 1, "media": 1.0}
    assert g["latencia_s"]["n"] == 3
    assert g["latencia_s"]["p50"] == 4.0
    assert m["por_categoria"]["fora_do_escopo"]["page_recall"]["@6"] == {"n": 0, "media": None}


def test_erro_do_sistema_fica_fora_da_latencia():
    casos, respostas, _ = _execucao()
    respostas[1]["erro"] = "Timeout"
    assert calcular(casos, respostas)["mecanicas"]["geral"]["latencia_s"]["n"] == 2


def test_relatorio_unico_junta_juiz_e_metricas_mecanicas():
    casos, respostas, notas = _execucao()
    rel = montar_relatorio("teste", casos, respostas, notas)
    assert rel["nome"] == "teste"
    assert rel["geral"]["correcao"]["media"] == pytest.approx(2 / 3, abs=1e-4)
    assert rel["mecanicas"]["geral"]["acerto_numerico"]["media"] == 1.0
    assert rel["por_pergunta"]["N1"]["correcao"] == 1.0
    assert rel["por_pergunta"]["N1"]["acerto_numerico"] is True
    assert rel["numerico_regra_x_juiz"] == {"regra=certo|juiz=1.0": 1}


def test_concordancia_marca_a_divergencia_regra_x_juiz():
    casos, respostas, notas = _execucao()
    notas[0]["nota"] = 0.0
    mec = calcular(casos, respostas)["por_pergunta_mecanicas"]
    assert concordancia_numerica_com_o_juiz(casos, mec, notas) == {"regra=certo|juiz=0.0": 1}
