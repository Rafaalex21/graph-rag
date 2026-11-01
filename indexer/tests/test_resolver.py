import json

import pytest

from indexer.importar import id_da_entidade, preparar
from indexer.resolver import (
    a_desfazer,
    candidatos,
    chaves_de_bloco,
    componentes,
    cosseno,
    iniciais,
    julgar,
    montar_pedido,
    nome_base,
    plano,
    relacao_forte,
    significativos,
    sobrevivente,
    trecho,
    valido,
)


def ent(id_, name, label="Organization", **kw):
    return {"id": id_, "name": name, "label": label, "fatos": 0, "mencoes": 1} | kw


def vetores(*nomes_e_vetores):
    return dict(nomes_e_vetores)


UM, DOIS = [1.0, 0.0], [0.0, 1.0]
PROXIMO = [0.9, 0.436]  # cosseno ~0,90 com UM
MEDIO = [0.75, 0.661]  # cosseno ~0,75 com UM


def test_nome_base_tira_sufixo_societario_e_pontuacao():
    assert nome_base("Banco Patagonia S.A.") == ("banco", "patagonia")
    assert nome_base("KPMG Auditores Independentes Ltda") == ("kpmg", "auditores", "independentes")
    assert nome_base("Acme Inc.") == ("acme",) == nome_base("ACME CORP")
    assert nome_base("Banco do Brasil") == ("banco", "do", "brasil")
    assert nome_base(None) == ()


def test_significativos_e_iniciais_ignoram_preposicoes():
    assert significativos("Banco Central do Brasil") == ("banco", "central", "brasil")
    assert iniciais("Banco Central do Brasil") == "bcb"
    assert iniciais("Cielo") == ""  # um token só não tem iniciais


def test_chaves_de_bloco_incluem_primeiro_token_iniciais_e_cada_parte():
    assert chaves_de_bloco("Banco Central do Brasil") == {"banco", "bcb"}
    assert chaves_de_bloco("BCB") == {"bcb"}
    assert chaves_de_bloco("CEF - Caixa Econômica Federal") >= {"cef", "caixa"}
    assert chaves_de_bloco("Caixa Econômica Federal") >= {"caixa", "cef"}
    assert chaves_de_bloco("BB-BI") & chaves_de_bloco("BB - Banco de Investimento S.A.")
    assert chaves_de_bloco("") == set()


@pytest.mark.parametrize(
    "a,b,esperado",
    [
        ({"cnpj": "00.394.460/0001-41"}, {"cnpj": "00394460000141"}, "forte"),
        ({"cnpj": "00.394.460/0001-41"}, {"cnpj": "33.000.167/0001-01"}, "veto"),
        ({"cnpj": "00.394.460/0001-41"}, {"cnpj": None}, None),
        ({"ticker": "bbas3"}, {"ticker": "BBAS3"}, "forte"),
        ({}, {}, None),
    ],
)
def test_chave_forte_e_veto(a, b, esperado):
    assert relacao_forte(a, b) == esperado


def test_cosseno():
    assert cosseno(UM, UM) == pytest.approx(1.0)
    assert cosseno(UM, DOIS) == pytest.approx(0.0)


def test_valido_exclui_nomes_de_lixo():
    assert not any(valido(ent("x", n)) for n in ("", "null", "N/A", "Desconhecido"))
    assert valido(ent("x", "Cielo"))


def razoes(a, b, va, vb):
    pares = candidatos([a, b], {a["id"]: va, b["id"]: vb})
    return pares[0]["razoes"] if pares else []


def test_nome_contido_no_mesmo_bloco_e_candidato_mesmo_com_embedding_distante():
    a, b = ent("a", "Cielo"), ent("b", "Cielo S.A. - Instituição de Pagamento")
    assert "nome_contido" in razoes(a, b, UM, DOIS)


def test_nome_contido_vale_mesmo_fora_do_bloco():
    a, b = ent("a", "investimentos", "Segment"), ent("b", "Segmento de investimentos", "Segment")
    assert not chaves_de_bloco(a["name"]) & chaves_de_bloco(b["name"])
    assert razoes(a, b, UM, DOIS) == ["nome_contido"]


def test_sigla_e_candidata_mesmo_com_embedding_distante():
    a, b = ent("a", "BCB"), ent("b", "Banco Central do Brasil")
    assert "sigla" in razoes(a, b, UM, DOIS)


def test_embedding_alto_no_bloco_ou_muito_alto_fora_dele():
    a, b = ent("a", "Banco Alfa"), ent("b", "Banco Beta")
    assert razoes(a, b, UM, MEDIO) == ["embedding_no_bloco"]  # 0,75: vale no bloco, não fora dele
    assert razoes(a, b, UM, DOIS) == []
    c, d = ent("c", "Caixa Alfa"), ent("d", "Mercado Beta")
    assert razoes(c, d, UM, MEDIO) == []
    assert razoes(c, d, UM, PROXIMO) == ["embedding_global"]


def test_tipos_diferentes_nunca_formam_par():
    a, b = ent("a", "Alfa"), ent("b", "Alfa", label="Segment")
    assert candidatos([a, b], {"a": UM, "b": UM}) == []


def test_cnpj_igual_com_o_mesmo_nome_funde_sem_juiz_e_com_nome_diferente_vai_ao_juiz():
    cnpj = "00.394.460/0001-41"
    a = ent("a", "Ministério da Fazenda", cnpj=cnpj)
    assert razoes(a, ent("b", "MINISTERIO DA FAZENDA S.A.", cnpj=cnpj), UM, DOIS) == [
        "chave_forte",
        "nome_contido",
    ]
    orgao = ent("c", "Procuradoria Geral da Fazenda Nacional", cnpj=cnpj)
    assert "chave_forte" not in razoes(a, orgao, UM, DOIS)
    assert "mesmo_cnpj" in razoes(a, orgao, UM, DOIS)


def test_cnpj_diferente_veta_mesmo_com_nome_igual():
    c = ent("c", "Banco do Brasil S.A.", cnpj="00.000.000/0001-91")
    d = ent("d", "Banco do Brasil", cnpj="11.111.111/0001-11")
    assert razoes(c, d, UM, UM) == []


def test_nomes_invalidos_e_eventos_ficam_fora():
    assert candidatos([ent("a", "N/A"), ent("b", "null")], {"a": UM, "b": UM}) == []
    assert candidatos([ent("a", "x", "Event"), ent("b", "x", "Event")], {"a": UM, "b": UM}) == []


class JuizFalso:
    def __init__(self, respostas):
        self.respostas, self.chamadas = respostas, 0

    def __call__(self, mensagens):
        self.chamadas += 1
        nomes = mensagens[1]["content"]
        for trecho_do_nome, r in self.respostas.items():
            if trecho_do_nome in nomes:
                return {"mesma_entidade": r, "justificativa": "teste"}
        return {"mesma_entidade": False, "justificativa": "teste"}


def test_julgar_usa_cache_e_nao_chama_o_juiz_para_chave_forte(tmp_path):
    por_id = {
        "a": ent("a", "Banco Patagonia"),
        "b": ent("b", "Banco Patagonia S.A."),
        "c": ent("c", "Ministério", cnpj="1"),
        "d": ent("d", "Ministério da Fazenda", cnpj="1"),
    }
    pares = [
        {"a": "a", "b": "b", "similaridade": 0.9, "razoes": ["nome_contido"]},
        {"a": "c", "b": "d", "similaridade": 0.5, "razoes": ["chave_forte"]},
    ]
    juiz = JuizFalso({"Patagonia": True})
    cache = tmp_path / "cache"
    r1 = julgar(pares, por_id, juiz, cache)
    assert juiz.chamadas == 1  # só o par sem chave forte
    assert [(x["decisao"], x["por"]) for x in r1] == [(True, "llm"), (True, "chave_forte")]
    r2 = julgar(pares, por_id, juiz, cache)
    assert juiz.chamadas == 1 and r2 == r1  # a segunda rodada vem do cache


def test_o_pedido_leva_os_dois_registros_com_papeis_e_trecho():
    a = ent("a", "BCB", roles=["counterparty"], trecho="o BCB editou")
    b = ent("b", "Banco Central do Brasil", description="Autoridade monetária")
    p = montar_pedido(a, b)
    assert "BCB" in p and "counterparty" in p and "o BCB editou" in p
    assert "Autoridade monetária" in p and "não disponível" in p and "ORGANIZATION" in p


def decisao(a, b, sim):
    return {
        "a": a,
        "b": b,
        "decisao": sim,
        "por": "llm",
        "razoes": [],
        "similaridade": 0.9,
        "justificativa": "",
    }


def test_componentes_unem_por_transitividade_e_isolam_conflitos():
    limpos, conflitos = componentes(
        [decisao("a", "b", True), decisao("b", "c", True), decisao("x", "y", True)]
    )
    assert limpos == [["a", "b", "c"], ["x", "y"]] and conflitos == []
    # a=b, b=c, mas a≠c: o grupo é contraditório e não funde
    limpos, conflitos = componentes(
        [decisao("a", "b", True), decisao("b", "c", True), decisao("a", "c", False), decisao("x", "y", True)]
    )
    assert limpos == [["x", "y"]] and conflitos == [["a", "b", "c"]]
    assert componentes([decisao("a", "b", False)]) == ([], [])


def test_sobrevivente_e_o_mais_citado_depois_o_nome_mais_completo():
    por_id = {
        "a": ent("a", "Banco do Brasil", fatos=0, mencoes=1),
        "b": ent("b", "Banco do Brasil S.A.", fatos=730, mencoes=94),
        "c": ent("c", "BCB", mencoes=1),
        "d": ent("d", "Banco Central do Brasil", mencoes=1),
    }
    assert sobrevivente(["a", "b"], por_id) == "b"
    assert sobrevivente(["c", "d"], por_id) == "d"
    assert sobrevivente(["d", "c"], por_id) == "d"  # a ordem do grupo não importa


def test_plano_mapeia_absorvidos_para_o_sobrevivente_com_o_nome_canonico():
    por_id = {
        "a": ent("a", "Banco do Brasil", mencoes=1),
        "b": ent("b", "Banco do Brasil S.A.", fatos=5, mencoes=9),
    }
    p = plano([decisao("a", "b", True)], por_id)
    assert p["redirecionar"] == {"a": "b"} and p["nomes"] == {"b": "Banco do Brasil S.A."}
    assert p["fusoes"] == [{"fica": "b", "absorvidos": ["a"]}] and p["conflitos"] == []
    assert json.loads(json.dumps(p)) == p


def test_a_desfazer_so_pega_sobreviventes_cujo_conjunto_de_absorvidos_mudou():
    no_grafo = [
        {"id": "k1", "absorbedIds": ["a", "b"]},  # igual ao plano: fica
        {"id": "k2", "absorbedIds": ["c"]},  # o plano novo não funde mais c: refazer
        {"id": "k3", "absorbedIds": ["d"]},  # o plano novo absorve d e e: refazer
    ]
    plano_novo = {"a": "k1", "b": "k1", "d": "k3", "e": "k3"}
    assert a_desfazer(no_grafo, plano_novo) == ["k2", "k3"]
    assert a_desfazer(no_grafo, {}) == ["k1", "k2", "k3"]


def test_trecho_centra_no_nome_e_tolera_texto_vazio():
    texto = "x " * 200 + "o BCB editou a norma " + "y " * 200
    t = trecho(texto, "BCB", folga=20)
    assert "BCB" in t and len(t) < 80
    assert trecho("", "BCB") == "" and trecho("sem o nome aqui", "BCB").startswith("sem o nome")


def _unidade(id_, **listas):
    vazio = {"financial_facts": [], "organizations": [], "people": [], "segments": [],
             "risk_factors": [], "events": [], "instruments": []}  # fmt: skip
    return {"id": id_, "tipo": "pai", "paginas": [1, 1], "valida": True, "resposta": vazio | listas}


def _org(nome, **kw):
    return {"name": nome, "role": "subsidiary", "description": None, "cnpj": None, "ticker": None} | kw


def test_preparar_com_redirecionamento_une_as_grafias_no_sobrevivente_e_guarda_os_ids_absorvidos():
    resultados = [
        _unidade("p1", organizations=[_org("Banco Patagonia S.A.", cnpj="08")]),
        _unidade("p2", organizations=[_org("Banco Patagonia")]),
    ]
    fica = id_da_entidade("Organization", "Banco Patagonia S.A.")
    fora = id_da_entidade("Organization", "Banco Patagonia")
    sem = preparar([], resultados, {}, "d")
    assert {o["id"] for o in sem["Organization"]} == {fica, fora}
    com = preparar([], resultados, {}, "d", {fora: fica}, {fica: "Banco Patagonia S.A."})
    (org,) = com["Organization"]
    assert org["id"] == fica and org["props"]["name"] == "Banco Patagonia S.A."
    assert org["props"]["aliases"] == ["Banco Patagonia", "Banco Patagonia S.A."]
    assert org["props"]["absorbedIds"] == [fora] and org["props"]["cnpj"] == "08"
    assert sorted(x["para"] for x in com["mentioned_in_pai"]) == ["p1", "p2"]
    assert {x["de"] for x in com["mentioned_in_pai"]} == {fica}
