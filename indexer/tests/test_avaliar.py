import json
from pathlib import Path

from indexer.avaliar import (
    ESQ_CORRECAO,
    agregar,
    correcao,
    fidelidade,
    gerar,
    julgar,
    ler_golden,
    recall_de_contexto,
    texto_do_contexto,
)

CONTEXTO = [{"paginas": "p. 91", "caminho": "Fluxo de caixa", "texto": "O caixa foi de 159.254 milhões."}]


def caso(id_="T1", categoria="factual_textual", tipo="texto", **extra):
    base = {
        "id": id_, "categoria": categoria, "pergunta": "Qual o caixa?", "gabarito": "R$ 159.254 milhões.",
        "tipo_gabarito": tipo, "valor": "", "unidade": "", "pontos_chave": "", "no_recorte": "sim",
    }  # fmt: skip
    return {**base, **extra}


def resposta(texto="O caixa foi de R$ 159.254 milhões [p. 91].", contexto=CONTEXTO, erro=None):
    return {
        "id": "T1",
        "resposta": texto,
        "contexto": contexto,
        "citacoes": [],
        "citacoes_invalidas": 0,
        "erro": erro,
    }


def juiz_falso(sustentadas=(True, True), veredito="correta", vistos=None):
    def julga(mensagens, esquema, max_tokens):
        if vistos is not None:
            vistos.append(mensagens[-1]["content"])
        if "veredito" in esquema["properties"]:
            return {"veredito": veredito, "justificativa": "ok"}
        return {"afirmacoes": [{"afirmacao": f"a{i}", "sustentada": s} for i, s in enumerate(sustentadas)],
                "justificativa": "ok"}  # fmt: skip

    return julga


def test_recall_e_a_fracao_do_gabarito_sustentada_pelo_contexto_e_nao_se_aplica_a_recusa():
    vistos = []
    r = recall_de_contexto(
        juiz_falso((True, False, True, True), vistos=vistos), caso(pontos_chave="a|b"), resposta()
    )
    assert r["nota"] == 0.75 and "Pontos-chave: a; b" in vistos[0] and "159.254 milhões" in vistos[0]
    assert recall_de_contexto(juiz_falso(), caso(tipo="recusa"), resposta())["nota"] is None
    assert (
        recall_de_contexto(juiz_falso(()), caso(), resposta())["nota"] is None
    )  # gabarito sem afirmações: não conta


def test_fidelidade_e_a_fracao_das_afirmacoes_da_resposta_sustentadas_e_recusa_vale_um():
    r = fidelidade(juiz_falso((True, True, False)), caso(), resposta())
    assert round(r["nota"], 3) == 0.667 and not r["sem_afirmacoes"]
    vazia = fidelidade(
        juiz_falso(()), caso(), resposta("Não encontrei essa informação nos trechos recuperados.")
    )
    assert vazia["nota"] == 1.0 and vazia["sem_afirmacoes"] is True


def test_correcao_mapeia_o_veredito_e_leva_valor_e_instrucao_de_recusa_ao_prompt():
    vistos = []
    for veredito, nota in (("correta", 1.0), ("parcial", 0.5), ("incorreta", 0.0)):
        assert correcao(juiz_falso(veredito=veredito), caso(), resposta())["nota"] == nota
    correcao(juiz_falso(vistos=vistos), caso(tipo="valor", valor="159254", unidade="R$ milhões"), resposta())
    assert "Valor esperado: 159254 (R$ milhões)" in vistos[0] and "SEM resposta no documento" not in vistos[0]
    correcao(juiz_falso(vistos=vistos), caso(tipo="recusa"), resposta("Não encontrei."))
    assert "SEM resposta no documento" in vistos[1]
    assert set(ESQ_CORRECAO["properties"]["veredito"]["enum"]) == {"correta", "parcial", "incorreta"}


def test_texto_do_contexto_rotula_a_pagina_e_trata_vazio():
    assert texto_do_contexto(CONTEXTO).startswith("[p. 91] Fluxo de caixa\nO caixa foi")
    assert texto_do_contexto([]) == "(vazio)"


def test_gerar_grava_jsonl_retoma_sem_repetir_e_registra_falha_do_sistema(tmp_path):
    chamadas = []

    def sistema(c):
        chamadas.append(c["id"])
        if c["id"] == "T2":
            raise ConnectionError("fora do ar")
        return {
            "resposta": "ok [p. 91]",
            "contexto": CONTEXTO,
            "citacoes": [{"texto": "[p. 91]"}],
            "citacoes_invalidas": 0,
        }

    casos = [caso("T1"), caso("T2")]
    r1 = gerar(casos, sistema, tmp_path)
    assert [x["id"] for x in r1] == ["T1", "T2"] and r1[0]["citacoes"] == ["[p. 91]"]
    assert "ConnectionError" in r1[1]["erro"] and r1[0]["erro"] is None
    gerar(casos, sistema, tmp_path)
    assert chamadas == ["T1", "T2"]  # a 2ª rodada não chamou o sistema de novo
    assert len((tmp_path / "respostas.jsonl").read_text(encoding="utf-8").splitlines()) == 2


def test_julgar_aplica_as_tres_metricas_retoma_marca_falha_do_juiz_e_zera_o_erro_do_sistema(tmp_path):
    casos = [caso("T1"), caso("T2", tipo="recusa")]
    respostas = [{**resposta(), "id": "T1"}, {**resposta("Não encontrei."), "id": "T2", "erro": "boom"}]
    n = []

    def juiz(m, e, t):
        n.append(1)
        return juiz_falso()(m, e, t)

    notas = julgar(casos, respostas, juiz, tmp_path)
    por = {(j["id"], j["metrica"]): j for j in notas}
    assert por[("T1", "correcao")]["nota"] == 1.0 and por[("T1", "recall_contexto")]["nota"] == 1.0
    assert (
        por[("T2", "correcao")]["nota"] == 0.0 and por[("T2", "fidelidade")]["nota"] is None
    )  # erro do sistema
    assert len(n) == 3  # só T1 chamou o juiz (3 métricas)
    julgar(casos, respostas, juiz, tmp_path)
    assert len(n) == 3  # retomada: nada refeito

    def quebrado(m, e, t):
        raise TimeoutError("juiz fora do ar")

    notas2 = julgar([caso("T3")], [{**resposta(), "id": "T3"}], quebrado, tmp_path / "outra")
    assert all(j["falha_do_juiz"] and j["nota"] is None for j in notas2) and len(notas2) == 3


def test_agregar_faz_media_por_metrica_categoria_e_recorte_ignorando_ausentes():
    casos = [caso("T1"), caso("N1", "numerica"), caso("F1", "fora_do_escopo", "recusa", no_recorte="nao")]
    notas = [
        {"id": "T1", "metrica": "correcao", "nota": 1.0, "falha_do_juiz": False},
        {"id": "N1", "metrica": "correcao", "nota": 0.5, "falha_do_juiz": False},
        {"id": "F1", "metrica": "correcao", "nota": 0.0, "falha_do_juiz": False},
        {"id": "T1", "metrica": "recall_contexto", "nota": 0.75, "falha_do_juiz": False},
        {"id": "F1", "metrica": "recall_contexto", "nota": None, "falha_do_juiz": False},
        {"id": "N1", "metrica": "fidelidade", "nota": None, "falha_do_juiz": True},
    ]
    a = agregar(casos, notas)
    assert a["geral"]["correcao"] == {"n": 3, "media": 0.5}
    assert a["so_no_recorte"]["correcao"] == {"n": 2, "media": 0.75}
    assert a["geral"]["recall_contexto"] == {"n": 1, "media": 0.75}
    assert a["geral"]["fidelidade"] == {"n": 0, "media": None} and a["falhas_do_juiz"] == 1
    assert a["por_categoria"]["numerica"]["correcao"]["media"] == 0.5


def test_ler_golden_le_as_60_perguntas_reais():
    casos = ler_golden(Path(__file__).resolve().parents[2] / "eval" / "golden.csv")
    assert len(casos) == 60 and {"pergunta", "gabarito", "tipo_gabarito", "no_recorte"} <= set(casos[0])
    assert json.dumps(casos[0], ensure_ascii=False)
