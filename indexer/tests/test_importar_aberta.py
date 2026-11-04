"""A extração aberta (F5.3) entra no mesmo importador da dirigida: mesmos rótulos, mesmos ids, mesma fusão.

Cada teste nomeia uma forma de falhar que o aceite da F5.3 ("nenhum par duplicado entre camadas") ou a
idempotência da importação não toleram.
"""

import pytest

from indexer.importar import PASSOS, TIPO_DA_ENTIDADE, id_da_entidade, preparar

DOC = "doc-exemplo"
PEDIDOS = {"p1": "Trecho.", "p2": "Trecho.", "p3": "Trecho."}


def ent(nome, tipo="ORGANIZATION", desc="d"):
    return {"name": nome, "type": tipo, "description": desc}


def rel(a, b, desc="liga", forca=5):
    return {"source": a, "target": b, "description": desc, "strength": forca}


def aberta(id_="p1", entidades=(), relacoes=(), valida=True):
    resposta = {"entities": list(entidades), "relationships": list(relacoes)} if valida else None
    return {"id": id_, "valida": valida, "resposta": resposta, "gleaning": None}


def montar(abertas, resultados=(), **kw):
    return preparar([], list(resultados), PEDIDOS, DOC, abertas=abertas, **kw)


def test_os_onze_tipos_abertos_tem_rotulo_e_passo_de_importacao():
    from indexer.extracao_aberta import TIPOS_DE_ENTIDADE

    assert set(TIPO_DA_ENTIDADE.values()) == set(TIPOS_DE_ENTIDADE)
    rotulos_com_passo = {chave for chave, _ in PASSOS}
    assert set(TIPO_DA_ENTIDADE) <= rotulos_com_passo


def test_toda_entidade_aberta_ganha_rotulo_tipo_e_origem_no_pai():
    linhas = montar([aberta("p1", [ent("Lei 13.303", "REGULATION"), ent("Brasil", "LOCATION")])])
    (lei,) = linhas["Regulation"]
    (lugar,) = linhas["Location"]
    assert lei["props"]["type"] == "REGULATION" and lugar["props"]["type"] == "LOCATION"
    assert {"de": lei["id"], "para": "p1"} in linhas["mentioned_in_pai"]


def test_mesmo_tipo_e_mesmo_nome_da_dirigida_cai_no_mesmo_no():
    dirigida = {
        "id": "p1", "tipo": "pai", "paginas": [1, 1], "valida": True,
        "resposta": {"financial_facts": [], "organizations": [
            {"name": "Banco Alfa", "role": "issuer", "description": None, "cnpj": "00", "ticker": None}
        ], "people": [], "segments": [], "risk_factors": [], "events": [], "instruments": []},
    }  # fmt: skip
    linhas = montar([aberta("p2", [ent("BANCO ALFA", desc="Maior banco")])], [dirigida])
    (org,) = linhas["Organization"]
    assert org["props"]["cnpj"] == "00"  # o campo da dirigida sobrevive
    assert org["props"]["descriptions"] == ["Maior banco"]
    assert sorted(x["para"] for x in linhas["mentioned_in_pai"]) == ["p1", "p2"]


def test_o_no_registra_quais_camadas_o_extraíram():
    dirigida = {
        "id": "p1", "tipo": "pai", "paginas": [1, 1], "valida": True,
        "resposta": {"financial_facts": [], "organizations": [
            {"name": "Banco Alfa", "role": "issuer", "description": None, "cnpj": None, "ticker": None},
            {"name": "Só Dirigida", "role": "issuer", "description": None, "cnpj": None, "ticker": None},
        ], "people": [], "segments": [], "risk_factors": [], "events": [], "instruments": []},
    }  # fmt: skip
    linhas = montar([aberta("p2", [ent("Banco Alfa"), ent("Só Aberta")])], [dirigida])
    camadas = {x["props"]["name"]: x["props"]["layers"] for x in linhas["Organization"]}
    assert camadas == {
        "Banco Alfa": ["aberta", "dirigida"], "Só Dirigida": ["dirigida"], "Só Aberta": ["aberta"],
    }  # fmt: skip


def test_descricoes_de_varios_pais_viram_lista_sem_repeticao_e_em_ordem():
    abertas = [
        aberta("p2", [ent("Alfa", desc="b")]),
        aberta("p1", [ent("Alfa", desc="a")]),
        aberta("p3", [ent("Alfa", desc="a")]),
    ]
    (org,) = montar(abertas)["Organization"]
    assert org["props"]["descriptions"] == ["a", "b"]


def test_o_mesmo_nome_com_dois_tipos_sao_dois_nos():
    linhas = montar([aberta("p1", [ent("Pix", "PRODUCT_OR_SERVICE"), ent("Pix", "POLICY_OR_PROGRAM")])])
    assert len(linhas["Product"]) == 1 and len(linhas["Policy"]) == 1


def test_relacao_resolve_os_extremos_por_nome_normalizado():
    linhas = montar(
        [aberta("p1", [ent("Banco Alfa"), ent("Açúcar S.A.")], [rel("BANCO ALFA", "acucar s a")])]
    )
    (r,) = linhas["related_to"]
    ids = {x["props"]["name"]: x["id"] for x in linhas["Organization"]}
    assert (r["de"], r["para"]) == (ids["Banco Alfa"], ids["Açúcar S.A."])


def test_a_mesma_relacao_em_dois_pais_acumula_descricoes_forca_maxima_e_origens():
    abertas = [
        aberta("p1", [ent("A"), ent("B")], [rel("A", "B", "x", 4)]),
        aberta("p2", [ent("A"), ent("B")], [rel("A", "B", "y", 8)]),
        aberta("p3", [ent("A"), ent("B")], [rel("A", "B", "x", 6)]),
    ]
    (r,) = montar(abertas)["related_to"]
    assert r["props"] == {"descriptions": ["x", "y"], "strength": 8, "parents": ["p1", "p2", "p3"]}


def test_relacao_em_sentido_contrario_e_outra_relacao():
    abertas = [aberta("p1", [ent("A"), ent("B")], [rel("A", "B"), rel("B", "A")])]
    assert len(montar(abertas)["related_to"]) == 2


def test_relacao_cujo_extremo_foi_absorvido_vai_para_quem_ficou():
    a, b, c = (id_da_entidade("Organization", n) for n in ("A", "B", "C"))
    abertas = [aberta("p1", [ent("A"), ent("B"), ent("C")], [rel("A", "C"), rel("B", "C")])]
    linhas = montar(abertas, redirecionar={b: a}, nomes={a: "A"})
    (r,) = linhas["related_to"]  # A->C e B->C viram a mesma relação
    assert (r["de"], r["para"]) == (a, c)
    assert r["props"]["descriptions"] == ["liga"] and r["props"]["parents"] == ["p1"]


def test_relacao_entre_dois_nos_que_se_fundem_nao_vira_laco():
    a, b = (id_da_entidade("Organization", n) for n in ("A", "B"))
    linhas = montar([aberta("p1", [ent("A"), ent("B")], [rel("A", "B")])], redirecionar={b: a})
    assert linhas["related_to"] == []


def test_fusao_entre_tipos_deixa_o_no_com_o_rotulo_e_o_tipo_do_sobrevivente():
    pessoa = id_da_entidade("Person", "Ministério da Fazenda")
    org = id_da_entidade("Organization", "Ministério da Fazenda")
    abertas = [aberta("p1", [ent("Ministério da Fazenda", "PERSON")]),
               aberta("p2", [ent("Ministério da Fazenda", "ORGANIZATION")])]  # fmt: skip
    for ordem in (abertas, list(reversed(abertas))):  # a ordem das menções não escolhe o rótulo
        linhas = montar(ordem, redirecionar={pessoa: org})
        assert linhas["Person"] == []
        (no,) = linhas["Organization"]
        assert no["id"] == org and no["props"]["type"] == "ORGANIZATION"
        assert no["props"]["absorbedIds"] == [pessoa]
        assert sorted(x["para"] for x in linhas["mentioned_in_pai"]) == ["p1", "p2"]


def test_resultado_invalido_nao_contribui_e_o_gleaning_valido_vence_a_primeira_passada():
    fundida = {"entities": [ent("A"), ent("B")], "relationships": [rel("A", "B")]}
    com_gleaning = aberta("p1", [ent("A")])
    com_gleaning["gleaning"] = {"valida": True, "resposta": fundida}
    linhas = montar([aberta("p9", valida=False), com_gleaning])
    assert len(linhas["Organization"]) == 2 and len(linhas["related_to"]) == 1


def test_evento_aberto_nao_se_funde_entre_pais():
    abertas = [aberta("p1", [ent("Pagamento de dividendos", "EVENT")]),
               aberta("p2", [ent("Pagamento de dividendos", "EVENT")])]  # fmt: skip
    assert len(montar(abertas)["Event"]) == 2


def test_importar_a_mesma_extracao_duas_vezes_gera_as_mesmas_linhas():
    abertas = [aberta("p2", [ent("B"), ent("A")], [rel("B", "A", "z")]), aberta("p1", [ent("A")])]
    assert montar(abertas) == montar(list(reversed(abertas)))


@pytest.mark.parametrize("tipo", ["CARGO", "", "organization"])
def test_tipo_fora_dos_onze_e_erro_e_nao_no_silencioso(tipo):
    with pytest.raises(ValueError, match="tipo"):
        montar([aberta("p1", [ent("X", tipo)])])


def test_sem_extracao_aberta_nada_muda():
    assert preparar([], [], PEDIDOS, DOC)["related_to"] == []
