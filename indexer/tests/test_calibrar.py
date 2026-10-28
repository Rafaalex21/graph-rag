import pytest

from indexer.calibrar import ESTRATOS, amostrar, concordancia, planilha

CATEGORIAS = {
    "N": "numerica",
    "P": "tematica_global",
    "M": "multi_hop",
    "T": "factual_textual",
    "F": "fora_do_escopo",
    "G": "agregacao_filtro",
}


def _mundo():
    casos, respostas = [], []
    for letra, cat in CATEGORIAS.items():
        for k in range(1, 13):
            i = f"{letra}{k:02d}"
            tipo = "valor" if letra == "N" else "texto"
            casos.append(
                {"id": i, "categoria": cat, "pergunta": f"pergunta {i}", "gabarito": f"gab {i}",
                 "tipo_gabarito": tipo, "valor": "10", "unidade": "%"}
            )  # fmt: skip
            recusa = k % 3 == 0 or letra == "G"
            respostas.append(
                {"id": i, "resposta": "Não encontrei essa informação." if recusa else f"resp {i}"}
            )
    return casos, respostas


def test_amostra_tem_20_ids_distintos_e_e_deterministica():
    casos, respostas = _mundo()
    ids = amostrar(casos, respostas)
    assert len(ids) == len(set(ids)) == sum(n for _, n in ESTRATOS) == 20
    assert ids == amostrar(casos, respostas)
    assert ids != amostrar(casos, respostas, semente=1)


def test_amostra_respeita_os_estratos():
    casos, respostas = _mundo()
    ids = amostrar(casos, respostas)
    por_id = {r["id"]: r["resposta"] for r in respostas}
    assert sum(i.startswith("F") for i in ids) == 3
    assert sum(i[0] in "NPMT" and not por_id[i].startswith("Não") for i in ids) == 14
    assert sum(i[0] in "NPMTG" and por_id[i].startswith("Não") for i in ids) == 3


def test_planilha_e_cega_e_traz_valor_de_referencia():
    casos, respostas = _mundo()
    ids = amostrar(casos, respostas)
    texto = planilha(casos, respostas, ids)
    assert texto.count("**Pergunta:**") == 20 and texto.count("**Resposta do sistema:**") == 20
    assert (
        "veredito" not in texto.lower()
        and "juiz" not in texto.lower().split("## como rotular")[1].split("---")[1]
    )
    assert "Valor de referência" in texto


def test_concordancia_exata_binaria_e_kappa():
    rotulos = {"A": "c", "B": "c", "C": "i", "D": "p", "E": "i"}
    veredito = {"A": "correta", "B": "incorreta", "C": "incorreta", "D": "correta", "E": "incorreta"}
    notas = [{"id": i, "metrica": "correcao", "veredito": v} for i, v in veredito.items()]
    notas.append({"id": "A", "metrica": "fidelidade", "nota": 1.0})
    r = concordancia(rotulos, notas)
    assert r["n"] == 5 and r["concordancia"] == 0.6 and r["divergencias"] == ["B", "D"]
    assert r["concordancia_correta_x_nao"] == 0.6  # D: humano "parcial" e juiz "correta" divergem também aqui
    assert r["matriz_humano_x_juiz"]["correta"] == {"correta": 1, "parcial": 0, "incorreta": 1}
    assert r["kappa"] == pytest.approx((0.6 - 0.4) / 0.6, abs=1e-3)  # esperado por acaso: (2*2 + 2*3) / 25


def test_concordancia_total_e_itens_sem_veredito():
    rotulos = {"A": "c", "B": "i"}
    notas = [{"id": "A", "metrica": "correcao", "veredito": "correta"}]
    r = concordancia(rotulos, notas)
    assert r["n"] == 1 and r["sem_veredito_do_juiz"] == 1 and r["concordancia"] == 1.0
