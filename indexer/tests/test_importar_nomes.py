"""Nomes que são marcador de vazio ("N/A", "null"...) não viram entidade (achado da F5.7, ADR-044)."""

import pytest

from indexer.importar import nome_valido, preparar

PEDIDOS = {"p1": "Trecho.", "p2": "Trecho."}
DOC = "doc-exemplo"


@pytest.mark.parametrize(
    "nome",
    [
        *["", "   ", "N/A", "n/a", " N / A ", "null", "None", "NaN", "Desconhecido"],
        *["Não informado", "nao informado", "Não disponível", "-", "—", "?", "...", "UNKNOWN", "Sem nome"],
    ],
)
def test_marcadores_de_vazio_nao_sao_nome_de_entidade(nome):
    assert not nome_valido(nome)


@pytest.mark.parametrize(
    "nome",
    [
        "Banco do Brasil",
        "BB",
        "Nulla Participações S.A.",
        "Desconhecido Ltda.",
        "Nada Consta Seguros",
        "N",
        "NA S.A.",
    ],
)
def test_nome_que_so_contem_a_palavra_e_nome_de_verdade(nome):
    assert nome_valido(nome)  # o filtro compara o nome inteiro, não pedaços


def test_nome_ausente_nao_quebra():
    assert not nome_valido(None)


def dirigida(**listas):
    base = {"financial_facts": [], "organizations": [], "people": [], "segments": [], "risk_factors": [],
            "events": [], "instruments": []}  # fmt: skip
    return {"id": "p1", "tipo": "pai", "paginas": [1, 1], "valida": True, "resposta": {**base, **listas}}


def org(nome):
    return {"name": nome, "role": "issuer", "description": None, "cnpj": None, "ticker": None}


def pessoa(nome, organizacao="Banco Alfa"):
    return {"name": nome, "position": "Diretor", "organization": organizacao}


def nomes(linhas, rotulo):
    return sorted(x["props"]["name"] for x in linhas[rotulo])


def test_pessoa_com_nome_placeholder_nao_vira_no_nem_cargo():
    r = dirigida(organizations=[org("Banco Alfa")], people=[pessoa("N/A"), pessoa("Maria Souza"), pessoa("")])
    linhas = preparar([], [r], PEDIDOS, DOC)
    assert nomes(linhas, "Person") == ["Maria Souza"]
    assert len(linhas["holds_position"]) == 1  # só o cargo da pessoa de verdade
    assert all(
        x["de"] in {p["id"] for p in linhas["Person"]}
        for x in linhas["mentioned_in_pai"]
        if "person" in x["de"]
    )


def test_cada_tipo_da_dirigida_descarta_o_proprio_placeholder():
    r = dirigida(
        organizations=[org("null"), org("Banco Alfa")],
        segments=[{"name": "Desconhecido", "organization": None, "description": None}],
        risk_factors=[{"name": "N/A", "category": "market", "description": "d", "affected_entity": None}],
        events=[{"description": "N/A", "type": "other", "date": None, "organizations": []}],
        instruments=[{"name": "null", "type": "bond", "maturity": None, "description": None, "issuer": None}],
    )
    linhas = preparar([], [r], PEDIDOS, DOC)
    assert nomes(linhas, "Organization") == ["Banco Alfa"]
    for rotulo in ("Segment", "RiskFactor", "Event", "Instrument"):
        assert linhas[rotulo] == [], rotulo


def test_referencia_placeholder_a_uma_organizacao_nao_cria_a_organizacao():
    r = dirigida(
        organizations=[org("Banco Alfa")],
        risk_factors=[
            {"name": "Risco de crédito", "category": "credit", "description": "d", "affected_entity": "N/A"}
        ],
    )
    linhas = preparar([], [r], PEDIDOS, DOC)
    assert nomes(linhas, "Organization") == ["Banco Alfa"] and linhas["affects"] == []


def aberta(entidades, relacoes=()):
    return {"id": "p2", "valida": True, "gleaning": None,
            "resposta": {"entities": entidades, "relationships": list(relacoes)}}  # fmt: skip


def test_entidade_aberta_placeholder_sai_e_leva_as_relacoes_dela_junto():
    e = lambda n: {"name": n, "type": "ORGANIZATION", "description": "d"}  # noqa: E731
    rel = lambda a, b: {"source": a, "target": b, "description": "liga", "strength": 5}  # noqa: E731
    linhas = preparar([], [], PEDIDOS, DOC, abertas=[aberta([e("A"), e("null"), e("B")],
                                                            [rel("A", "null"), rel("A", "B")])])  # fmt: skip
    assert nomes(linhas, "Organization") == ["A", "B"]
    assert len(linhas["related_to"]) == 1  # sobrou só A -> B


def test_o_que_nao_e_placeholder_continua_igual():
    r = dirigida(organizations=[org("Banco Alfa")], people=[pessoa("Maria Souza")])
    antes = preparar([], [r], PEDIDOS, DOC)
    assert len(antes["Organization"]) == 1 and len(antes["Person"]) == 1
