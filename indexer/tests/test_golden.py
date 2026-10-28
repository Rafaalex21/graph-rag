import importlib.util
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("validar_golden", RAIZ / "eval" / "validar_golden.py")
vg = importlib.util.module_from_spec(_spec)
sys.modules["validar_golden"] = vg
_spec.loader.exec_module(vg)

RECORTE = {1, 2, 3, 91, 92, 93}


def linha(**extra):
    base = {c: "" for c in vg.CAMPOS}
    base.update(
        id="X01", categoria="factual_textual", pergunta="Qual?", gabarito="Isto.", tipo_gabarito="texto",
        paginas="91", rota_esperada="buscar_trechos", no_recorte="sim", evidencia="isto",
    )  # fmt: skip
    base.update(extra)
    return base


def test_o_golden_real_tem_60_linhas_na_distribuicao_da_secao_13_1_e_estrutura_valida():
    linhas = vg.ler_csv(vg.CSV)
    assert vg.validar_estrutura(linhas, vg.paginas_do_recorte()) == []
    assert len(linhas) == 60 and {x["categoria"] for x in linhas} == set(vg.DISTRIBUICAO)


def test_recorte_versionado_tem_79_paginas_e_bate_com_o_mapa_local_quando_ele_existe():
    paginas = vg.paginas_do_recorte()
    assert len(paginas) == 79
    assert {1, 13, 80, 100, 405} <= paginas  # pontas das faixas entram
    assert not ({14, 79, 101, 110, 117, 406} & paginas)  # logo depois ou antes, não


def test_o_golden_real_cobre_o_que_a_f3_precisa():
    linhas = vg.ler_csv(vg.CSV)
    assert sum(x["no_recorte"] == "sim" for x in linhas) >= 50  # as métricas até a F5.8 valem para estas
    assert any(x["no_recorte"] == "nao" for x in linhas)  # há evidência fora do recorte, para a F9.1
    assert all(x["pontos_chave"] for x in linhas if x["categoria"] == "tematica_global")
    assert all(x["valor"] and x["unidade"] for x in linhas if x["tipo_gabarito"] == "valor")
    assert {x["rota_esperada"] for x in linhas} >= {
        "buscar_trechos",
        "buscar_tabelas",
        "fato_financeiro",
        "panorama",
    }


def test_validador_aceita_linha_boa_e_reprova_cada_defeito_de_estrutura():
    ok = [linha()]
    # só a distribuição/contagem falha numa lista de 1 linha
    erros = vg.validar_estrutura(ok, RECORTE)
    assert any("distribuição" in e for e in erros) and not any("X01:" in e for e in erros)
    assert any("rota" in e for e in vg.validar_estrutura([linha(rota_esperada="magica")], RECORTE))
    assert any("tipo" in e for e in vg.validar_estrutura([linha(tipo_gabarito="outro")], RECORTE))
    assert any("fora de 1 a" in e for e in vg.validar_estrutura([linha(paginas="500")], RECORTE))
    assert any("regex de evidência" in e for e in vg.validar_estrutura([linha(evidencia="")], RECORTE))
    assert any(
        "valor numérico inválido" in e
        for e in vg.validar_estrutura([linha(tipo_gabarito="valor", valor="abc", unidade="R$")], RECORTE)
    )
    assert any(
        "sem unidade" in e for e in vg.validar_estrutura([linha(tipo_gabarito="valor", valor="1")], RECORTE)
    )
    assert any(
        "no_recorte" in e for e in vg.validar_estrutura([linha(paginas="200", no_recorte="sim")], RECORTE)
    )
    assert any("ids repetidos" in e for e in vg.validar_estrutura([linha(), linha()], RECORTE))


def test_fora_do_escopo_nao_leva_pagina_e_exige_ausencia_exceto_a_saudacao():
    f = linha(
        id="F02",
        categoria="fora_do_escopo",
        tipo_gabarito="recusa",
        paginas="",
        evidencia="",
        rota_esperada="nenhuma",
    )
    assert any("ausência" in e for e in vg.validar_estrutura([f], RECORTE))
    f1 = {**f, "id": "F01"}
    assert not any("F01:" in e for e in vg.validar_estrutura([f1], RECORTE))
    assert any(
        "não leva página" in e
        for e in vg.validar_estrutura([{**f, "paginas": "91", "ausencia": "x"}], RECORTE)
    )


def test_validacao_contra_o_texto_confere_evidencia_ausencia_e_so_nas_paginas_citadas():
    texto = {91: "o caixa foi de 159.254 milhões", 92: "outra coisa", 93: "Itaú nunca aparece aqui? aparece"}
    boa = linha(evidencia=r"159\.254 && caixa", paginas="91")
    pagina_errada = linha(id="X02", evidencia=r"159\.254", paginas="92")
    ausente_ok = linha(id="F2", categoria="fora_do_escopo", paginas="", evidencia="", ausencia=r"Bradesco")
    ausente_violada = linha(id="F3", categoria="fora_do_escopo", paginas="", evidencia="", ausencia=r"Itaú")
    erros, detalhe = vg.validar_contra_o_pdf([boa, pagina_errada, ausente_ok, ausente_violada], texto)
    assert [e.split(":")[0] for e in erros] == ["X02", "F3"]
    assert [d["evidencia_ok"] and d["ausencia_ok"] for d in detalhe] == [True, False, True, False]


@pytest.mark.parametrize("bruto,esperado", [("a  \n b­c", "a bc"), ("x￾y", "xy")])
def test_normaliza_junta_espacos_e_tira_hifen_suave(bruto, esperado):
    assert vg.normaliza(bruto) == esperado
