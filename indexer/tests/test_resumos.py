"""Resumos de entidades e relações (F5.4): cada teste nomeia uma forma de o resumo falhar."""

import json

import pytest

from indexer.resumos import (
    LOTE,
    MAX_CHARS_PEDIDO,
    TETO_DE_DESCRICOES,
    montar_pedido,
    ranquear,
    resumir_textos,
    resumo_sem_descricao,
)


def itens(*pares):
    return [{"texto": t, "secao": s} for t, s in pares]


def test_ranking_alterna_as_secoes_para_a_diversidade_vir_primeiro():
    r = ranquear(itens(("a1", "A"), ("a2", "A"), ("a3", "A"), ("b1", "B"), ("c1", "C")))
    assert r == ["a1", "b1", "c1", "a2", "a3"]


def test_ranking_com_secao_desconhecida_e_ordem_estavel():
    r = ranquear(itens(("x", None), ("y", None), ("a", "A")))
    assert r == ["x", "a", "y"]
    assert ranquear([]) == []
    assert ranquear(itens(("a", "A"), ("b", "A"))) == ["a", "b"]


class GeradorFalso:
    def __init__(self):
        self.pedidos: list[str] = []

    def __call__(self, mensagens):
        pedido = mensagens[-1]["content"]
        self.pedidos.append(pedido)
        return {"summary": f"resumo{len(self.pedidos)}", "tokens_prompt": len(pedido) // 3}


def textos(n, tamanho=300):
    return [f"descricao {i:04d} " + "x" * (tamanho - 15) for i in range(n)]


def test_uma_descricao_so_nao_chama_o_llm(tmp_path):
    g = GeradorFalso()
    r = resumir_textos("Alfa", "ORGANIZATION", ["Banco de varejo."], g, tmp_path)
    assert r["summary"] == "Banco de varejo." and r["chamadas"] == 0 and g.pedidos == []


def test_sem_descricao_nenhuma_nao_ha_o_que_resumir(tmp_path):
    assert resumir_textos("Alfa", "ORGANIZATION", [], GeradorFalso(), tmp_path) is None


def test_varias_descricoes_cabem_numa_chamada(tmp_path):
    g = GeradorFalso()
    r = resumir_textos("Alfa", "ORGANIZATION", textos(5), g, tmp_path)
    assert (r["chamadas"], r["niveis"], r["summary"]) == (1, 1, "resumo1")


def test_o_emissor_com_70_descricoes_e_resumido_em_dois_niveis(tmp_path):
    g = GeradorFalso()
    r = resumir_textos("Banco", "ORGANIZATION", textos(70), g, tmp_path)
    # 70 -> 3 lotes de até 30 -> 3 resumos parciais -> 1 resumo final
    assert (r["chamadas"], r["niveis"]) == (4, 2)
    assert all(len(p) <= MAX_CHARS_PEDIDO for p in g.pedidos)
    assert "resumo1" in g.pedidos[-1] and "resumo3" in g.pedidos[-1]


def test_nenhum_pedido_passa_do_limite_nem_com_descricoes_enormes(tmp_path):
    g = GeradorFalso()
    resumir_textos("Alfa", "ORGANIZATION", textos(40, tamanho=5000), g, tmp_path)
    assert g.pedidos and all(len(p) <= MAX_CHARS_PEDIDO for p in g.pedidos)


def test_o_teto_de_descricoes_corta_o_excesso_e_a_recursao_termina(tmp_path):
    g = GeradorFalso()
    r = resumir_textos("Banco", "ORGANIZATION", textos(5000), g, tmp_path)
    assert r["usadas"] == TETO_DE_DESCRICOES and r["descartadas"] == 5000 - TETO_DE_DESCRICOES
    assert r["niveis"] >= 2 and len(g.pedidos[-1]) <= MAX_CHARS_PEDIDO
    assert r["chamadas"] == len(g.pedidos) < 60


def test_lote_tem_no_maximo_o_tamanho_do_artigo(tmp_path):
    g = GeradorFalso()
    resumir_textos("Banco", "ORGANIZATION", textos(LOTE + 1, tamanho=40), g, tmp_path)
    assert len(g.pedidos) == 3  # 2 lotes + final


def test_a_segunda_rodada_vem_do_cache_e_da_o_mesmo_resumo(tmp_path):
    g1, g2 = GeradorFalso(), GeradorFalso()
    r1 = resumir_textos("Banco", "ORGANIZATION", textos(70), g1, tmp_path)
    r2 = resumir_textos("Banco", "ORGANIZATION", textos(70), g2, tmp_path)
    assert g2.pedidos == [] and r2["summary"] == r1["summary"] and r2["chamadas"] == 0


def test_resumo_vazio_do_llm_e_erro_depois_de_duas_tentativas(tmp_path):
    chamadas = []

    def vazio(mensagens):
        chamadas.append(1)
        return {"summary": "  ", "tokens_prompt": 10}

    with pytest.raises(ValueError, match="resumo vazio"):
        resumir_textos("Alfa", "ORGANIZATION", textos(3), vazio, tmp_path)
    assert len(chamadas) == 2


def test_o_pedido_leva_os_nomes_o_tipo_e_cada_descricao_numerada():
    p = montar_pedido("Alfa", "ORGANIZATION", ["um", "dois"])
    assert "Alfa" in p and "ORGANIZATION" in p and "1. um" in p and "2. dois" in p
    par = montar_pedido("Alfa -> Beta", "RELACAO", ["x"])
    assert "Alfa -> Beta" in par


def test_entidade_sem_descricao_ganha_um_resumo_marcado_como_vindo_do_nome():
    assert resumo_sem_descricao("Alfa", "ORGANIZATION") == "Alfa (organização)."
    assert resumo_sem_descricao("Beta", "TIPO_NOVO") == "Beta (tipo_novo)."


def test_o_cache_nao_mistura_entidades_com_os_mesmos_textos(tmp_path):
    g = GeradorFalso()
    resumir_textos("Alfa", "ORGANIZATION", textos(3), g, tmp_path)
    resumir_textos("Beta", "ORGANIZATION", textos(3), g, tmp_path)
    assert len(g.pedidos) == 2
    assert json.loads(next(tmp_path.glob("*.json")).read_text("utf-8"))["summary"].startswith("resumo")


def test_resumo_cortado_pela_gramatica_volta_a_ultima_frase_completa():
    from indexer.resumos import MAX_CHARS_RESUMO, aparar

    cortado = "Primeira frase completa. Segunda frase completa. " + "palavra " * 100
    cortado = cortado[:MAX_CHARS_RESUMO]
    assert aparar(cortado) == "Primeira frase completa. Segunda frase completa."
    assert aparar("Frase inteira.") == "Frase inteira."  # terminou sozinho: não mexe
    curto_sem_ponto = "sem ponto final mas curto"
    assert aparar(curto_sem_ponto) == curto_sem_ponto  # só aparar quando bateu no limite
    sem_frase = "x" * MAX_CHARS_RESUMO
    assert aparar(sem_frase) == sem_frase  # nenhuma frase completa: melhor cortado que vazio
