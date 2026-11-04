"""Relatórios de comunidade (F5.6): cada teste nomeia uma forma de o relatório falhar."""

import pytest

from indexer.relatorios import (
    MAX_ACHADOS,
    RelatorioInvalido,
    gerar_relatorio,
    maximo_de_achados,
    minimo_de_achados,
    montar_contexto,
    texto_para_embutir,
    validar_relatorio,
)


def ents(n, tamanho=60):
    return [
        {
            "id": f"ent:{i}",
            "name": f"Entidade {i}",
            "type": "ORGANIZATION",
            "summary": "x" * tamanho,
            "rank": i,
        }
        for i in range(n)
    ]


def rels(pares, tamanho=60):
    return [{"de": f"ent:{a}", "para": f"ent:{b}", "summary": "r" * tamanho, "weight": 7, "rank": a + b}
            for a, b in pares]  # fmt: skip


def achado(resumo="Achado.", entidades=("E1",), relacoes=()):
    return {"summary": resumo, "explanation": "Porque sim.", "entities": list(entidades),
            "relationships": list(relacoes)}  # fmt: skip


def relatorio(achados=None, **kw):
    achados = achados if achados is not None else [achado()] * 5
    base = {"title": "Tema", "summary": "Resumo da comunidade.", "rating": 6.5,
            "rating_explanation": "Importa.", "findings": achados}  # fmt: skip
    return {**base, **kw}


# ---- contexto -------------------------------------------------------------------------------------------


def test_contexto_ordena_por_rank_e_da_uma_etiqueta_a_cada_entidade_e_relacao():
    c = montar_contexto(ents(3), rels([(0, 1), (1, 2)]))
    assert list(c["entidades"].values()) == ["ent:2", "ent:1", "ent:0"]  # rank maior primeiro
    assert list(c["entidades"]) == ["E1", "E2", "E3"]
    assert list(c["relacoes"]) == ["R1", "R2"] and c["relacoes"]["R1"] == (
        "ent:1",
        "ent:2",
    )  # rank 3 antes de 1
    assert "[E1] Entidade 2" in c["texto"] and "[R1] E" in c["texto"]


def test_contexto_nunca_passa_do_limite_e_corta_primeiro_as_relacoes_de_menor_rank():
    ents_ = ents(10, tamanho=300)
    pares = [(a, b) for a in range(10) for b in range(a + 1, 10)]
    c = montar_contexto(ents_, rels(pares, tamanho=300), limite=6000)
    assert len(c["texto"]) <= 6000
    assert c["omitidas"]["relacoes"] > 0
    assert c["omitidas"]["entidades"] == 0  # entidades primeiro: o que sobrar de espaço vai para relações


def test_contexto_apertado_corta_entidades_de_menor_rank_e_as_relacoes_que_ficaram_sem_ponta():
    c = montar_contexto(ents(40, tamanho=400), rels([(0, 39), (38, 39)]), limite=5000)
    assert len(c["texto"]) <= 5000 and c["omitidas"]["entidades"] > 0
    ids = set(c["entidades"].values())
    assert "ent:39" in ids and "ent:0" not in ids  # fica quem tem rank maior
    assert all(de in ids and para in ids for de, para in c["relacoes"].values())  # nenhuma relação sem ponta


def test_contexto_vazio_nao_quebra():
    c = montar_contexto([], [])
    assert c["entidades"] == {} and c["omitidas"] == {"entidades": 0, "relacoes": 0}


# ---- validação ------------------------------------------------------------------------------------------

CTX = {"entidades": {"E1": "ent:a", "E2": "ent:b"}, "relacoes": {"R1": ("ent:a", "ent:b")}}


def test_minimo_de_achados_nao_exige_cinco_de_comunidade_de_duas_entidades():
    assert [minimo_de_achados(n) for n in (0, 1, 2, 3, 5, 30)] == [1, 1, 2, 3, 5, 5]


def test_maximo_de_achados_cresce_com_a_comunidade_e_nunca_passa_de_dez():
    assert [maximo_de_achados(n) for n in (1, 2, 3, 5, 30)] == [2, 4, 6, 10, 10]
    assert all(maximo_de_achados(n) >= minimo_de_achados(n) for n in range(0, 40))


def test_achados_demais_para_o_tamanho_da_comunidade_sao_invalidos():
    with pytest.raises(RelatorioInvalido, match="achados"):
        validar_relatorio(relatorio([achado()] * 5), CTX, minimo=2, maximo=4)


@pytest.mark.parametrize(
    "onde", ["title", "summary", "rating_explanation", "achado.summary", "achado.explanation"]
)
def test_etiqueta_no_texto_e_invalida_porque_o_leitor_nao_ve_o_contexto(onde):
    if onde.startswith("achado."):
        campo = onde.split(".")[1]
        a = achado()
        a[campo] = "Conforme a relação R5, a entidade [E2] cresceu."
        resp = relatorio([a])
    else:
        resp = relatorio(**{onde: "A Selic (E2) subiu."})
    with pytest.raises(RelatorioInvalido, match="etiqueta"):
        validar_relatorio(resp, CTX, minimo=1)


def test_palavras_parecidas_com_etiqueta_nao_sao_barradas():
    ok = relatorio(title="Resolução BCB 6/2023 e a norma ISO 22301", summary="Ver anexo E e a sigla R.")
    assert validar_relatorio(ok, CTX, minimo=1)["title"].startswith("Resolução")


def test_relatorio_valido_troca_etiquetas_por_ids_e_aceita_colchetes_e_minusculas():
    resp = relatorio([achado(entidades=["[e1]", "E2", "E1"], relacoes=["R1"])] * 2)
    r = validar_relatorio(resp, CTX, minimo=2)
    f = r["findings"][0]
    assert f["entities"] == ["ent:a", "ent:b"]  # sem repetição, na ordem
    assert f["relationships"] == [["ent:a", "ent:b"]]
    assert r["rating"] == 6.5 and r["title"] == "Tema"


@pytest.mark.parametrize("nota", [-0.1, 10.5, "alto", None, True])
def test_nota_fora_de_zero_a_dez_ou_que_nao_e_numero_e_invalida(nota):
    with pytest.raises(RelatorioInvalido, match="rating"):
        validar_relatorio(relatorio(rating=nota), CTX, minimo=1)


def test_poucos_ou_demais_achados_sao_invalidos():
    with pytest.raises(RelatorioInvalido, match="achados"):
        validar_relatorio(relatorio([achado()] * 2), CTX, minimo=3)
    with pytest.raises(RelatorioInvalido, match="achados"):
        validar_relatorio(relatorio([achado()] * (MAX_ACHADOS + 1)), CTX, minimo=1)


@pytest.mark.parametrize("campo", ["title", "summary", "rating_explanation"])
def test_campos_de_texto_vazios_sao_invalidos(campo):
    with pytest.raises(RelatorioInvalido, match=campo):
        validar_relatorio(relatorio(**{campo: "   "}), CTX, minimo=1)


def test_referencia_inventada_e_achado_sem_referencia_sao_invalidos():
    with pytest.raises(RelatorioInvalido, match="referência"):
        validar_relatorio(relatorio([achado(entidades=["E9"])]), CTX, minimo=1)
    with pytest.raises(RelatorioInvalido, match="referência"):
        validar_relatorio(relatorio([achado(entidades=[], relacoes=[])]), CTX, minimo=1)
    with pytest.raises(RelatorioInvalido, match="referência"):
        validar_relatorio(relatorio([achado(relacoes=["R7"])]), CTX, minimo=1)


def test_achado_com_texto_vazio_e_invalido():
    with pytest.raises(RelatorioInvalido, match="achado"):
        validar_relatorio(relatorio([achado(resumo=" ")]), CTX, minimo=1)


def test_resposta_que_nao_e_objeto_e_invalida():
    with pytest.raises(RelatorioInvalido):
        validar_relatorio(["lista"], CTX, minimo=1)
    with pytest.raises(RelatorioInvalido):
        validar_relatorio({"title": "só isto"}, CTX, minimo=1)


# ---- geração, tentativas e cache ------------------------------------------------------------------------


class Gerador:
    def __init__(self, *respostas):
        self.respostas, self.pedidos = list(respostas), []

    def __call__(self, mensagens, esquema):
        self.pedidos.append(mensagens[-1]["content"])
        resp = self.respostas[min(len(self.pedidos), len(self.respostas)) - 1]
        return {"resposta": resp, "tokens_prompt": 123}


def valida():
    return relatorio([achado(entidades=["E1"])] * 2)


def membros():
    return {"id": "com:0:aaa", "nivel": 0}, ents(2), rels([(0, 1)])


def test_gera_um_relatorio_valido_numa_chamada(tmp_path):
    com, e, r = membros()
    g = Gerador(valida())
    out = gerar_relatorio(com, e, r, g, tmp_path)
    assert (
        out["chamadas"] == 1
        and out["relatorio"]["findings"][0]["entities"] == ["ent:1"]
        and out["tokens_prompt"] == 123
    )


def test_resposta_invalida_gera_uma_segunda_tentativa_e_duas_invalidas_sao_erro(tmp_path):
    com, e, r = membros()
    g = Gerador(relatorio(rating=99), valida())
    assert gerar_relatorio(com, e, r, g, tmp_path)["chamadas"] == 2
    g2 = Gerador(relatorio(rating=99))
    with pytest.raises(RelatorioInvalido):
        gerar_relatorio({"id": "com:0:bbb", "nivel": 0}, ents(3), rels([(0, 2)]), g2, tmp_path)
    assert len(g2.pedidos) == 2


def test_segunda_rodada_vem_do_cache_e_comunidades_iguais_em_niveis_diferentes_dividem_o_relatorio(tmp_path):
    com, e, r = membros()
    g = Gerador(valida())
    gerar_relatorio(com, e, r, g, tmp_path)
    de_novo = gerar_relatorio(
        {"id": "com:1:zzz", "nivel": 1}, e, r, g, tmp_path
    )  # mesmo conteúdo, outro nível
    assert len(g.pedidos) == 1 and de_novo["chamadas"] == 0


def test_o_pedido_leva_o_contexto_e_nao_o_id_da_comunidade(tmp_path):
    com, e, r = membros()
    g = Gerador(valida())
    gerar_relatorio(com, e, r, g, tmp_path)
    assert "Entidade 1" in g.pedidos[0] and "com:0:aaa" not in g.pedidos[0]


# ---- texto embutido -------------------------------------------------------------------------------------


def test_texto_para_embutir_leva_titulo_resumo_e_achados_e_tem_limite():
    r = validar_relatorio(relatorio([achado(resumo=f"Achado {i}.") for i in range(4)]), CTX, minimo=1)
    t = texto_para_embutir(r)
    assert t.startswith("Tema") and "Resumo da comunidade." in t and "Achado 3." in t
    r["findings"][0]["explanation"] = "y" * 50000
    assert len(texto_para_embutir(r)) <= 12000
