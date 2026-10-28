from decimal import Decimal

import pytest

from indexer.numeros import (
    detectar_escala,
    detectar_formato,
    estatisticas_de_celulas,
    parse_faixa,
    parse_valor,
    valores_no_texto,
)

D = Decimal


# --- pt-BR: formatos reais das tabelas auditadas (F1.6) -------------------------------------------------
@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        ("914.535", D("914535")),
        ("8,5", D("8.5")),
        ("1.045.338", D("1045338")),
        ("2.842.760.965", D("2842760965")),
        ("29.148.990,51", D("29148990.51")),
        ("0,00", D("0.00")),
        ("1,3", D("1.3")),
        ("160.000", D("160000")),
        ("0", D("0")),
        ("2025", D("2025")),
    ],
)
def test_pt_br_milhar_com_ponto_e_decimal_com_virgula(texto, esperado):
    v = parse_valor(texto, "pt")
    assert v.valor == esperado and v.formato == "pt" and not v.ambiguo


# --- negativos ------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("texto", "esperado", "por_parenteses"),
    [
        ("(101.806)", D("-101806"), True),
        ("(6,3)", D("-6.3"), True),
        ("(1.448.368)", D("-1448368"), True),
        ("-8,5", D("-8.5"), False),
        ("−8,5", D("-8.5"), False),  # sinal de menos Unicode
        ("–35,7", D("-35.7"), False),  # travessão curto colado ao número
    ],
)
def test_negativos_por_parenteses_e_por_sinal(texto, esperado, por_parenteses):
    v = parse_valor(texto, "pt")
    assert v.valor == esperado and v.negativo_por_parenteses is por_parenteses


# --- percentuais, pontos-base, pontos percentuais -------------------------------------------------------
@pytest.mark.parametrize(
    ("texto", "valor", "unidade"),
    [
        ("66,25%", D("66.25"), "percentual"),
        ("49,605%", D("49.605"), "percentual"),
        ("100%", D("100"), "percentual"),
        ("(1,5%)", D("-1.5"), "percentual"),
        ("12 %", D("12"), "percentual"),
        ("150 p.b.", D("150"), "pontos_base"),
        ("25 bps", D("25"), "pontos_base"),
        ("50 pontos-base", D("50"), "pontos_base"),
        ("1,5 p.p.", D("1.5"), "pontos_percentuais"),
    ],
)
def test_percentuais_e_pontos(texto, valor, unidade):
    v = parse_valor(texto, "pt")
    assert v.valor == valor and v.unidade == unidade


def test_percentual_e_pontos_nao_recebem_escala():
    v = parse_valor("12,5%", "pt")
    assert v.com_escala(1_000_000) == D("12.5")
    assert parse_valor("25 bps", "pt").com_escala(1_000) == D("25")


# --- ausentes: traço, "n.a.", "Não Aplicável" -----------------------------------------------------------
@pytest.mark.parametrize(
    ("texto", "motivo"),
    [
        ("-", "traco"),
        ("–", "traco"),
        ("—", "traco"),
        ("", "vazio"),
        ("  ", "vazio"),
        ("n.a.", "nao_aplicavel"),
        ("Não Aplicável", "nao_aplicavel"),
        ("N/D", "nao_disponivel"),
    ],
)
def test_celula_sem_valor_nao_vira_zero(texto, motivo):
    v = parse_valor(texto, "pt")
    assert v.ausente and v.valor is None and v.motivo == motivo
    assert v.com_escala(1_000) is None


# --- EN ------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        ("1,234.56", D("1234.56")),
        ("(1,234.5)", D("-1234.5")),
        ("1,234,567", D("1234567")),
        ("12.5", D("12.5")),
        ("0.75", D("0.75")),
    ],
)
def test_en_virgula_de_milhar_e_ponto_decimal(texto, esperado):
    v = parse_valor(texto, "en")
    assert v.valor == esperado and v.formato == "en"


# --- ambiguidade de "1.234" ----------------------------------------------------------------------------
def test_um_ponto_e_tres_digitos_e_ambiguo_no_modo_auto_e_vira_milhar_em_pt():
    v = parse_valor("1.234")
    assert v.ambiguo and v.valor == D("1234")


def test_um_ponto_e_tres_digitos_nao_e_ambiguo_com_formato_conhecido():
    assert parse_valor("1.234", "pt").valor == D("1234") and not parse_valor("1.234", "pt").ambiguo
    assert parse_valor("1.234", "en").valor == D("1.234") and not parse_valor("1.234", "en").ambiguo


def test_auto_decide_pelo_ultimo_separador_quando_ha_os_dois():
    assert parse_valor("1.234,56").formato == "pt" and not parse_valor("1.234,56").ambiguo
    assert parse_valor("1,234.56").formato == "en" and parse_valor("1,234.56").valor == D("1234.56")


def test_auto_um_separador_com_dois_digitos_e_decimal_sem_ambiguidade():
    v = parse_valor("1,23")
    assert v.valor == D("1.23") and not v.ambiguo
    assert parse_valor("1.5").valor == D("1.5")


def test_auto_varios_separadores_iguais_sao_milhar():
    assert parse_valor("1.234.567").valor == D("1234567")
    assert parse_valor("1,234,567").valor == D("1234567")


@pytest.mark.parametrize(
    "texto",
    [
        "1.23.4",
        "12,34,56",
        "1.2345.678",
        "1,2,3",
        "abc",
        "1.234,5,6",
        "--5",
        "12a",
        "1 234 x",
        "()",
        "R$",
        "%",
    ],
)
def test_formas_invalidas_nao_parseiam(texto):
    assert parse_valor(texto, "pt") is None


@pytest.mark.parametrize("texto", ["1.234.56", "12.345,67.8", "1,23,4"])
def test_milhar_mal_agrupado_nao_vira_numero_em_nenhum_formato(texto):
    assert parse_valor(texto, "pt") is None and parse_valor(texto, "en") is None


# --- moeda e escala no próprio trecho ------------------------------------------------------------------
def test_moeda_e_escala_por_extenso_no_trecho():
    v = parse_valor("R$ 169.235 milhões", "pt")
    assert v.valor == D("169235") and v.moeda == "BRL" and v.escala_inline == 1_000_000
    assert v.com_escala() == D("169235000000")


def test_dolar_e_escala_em_ingles():
    v = parse_valor("US$ 3.2 million", "en")
    assert v.valor == D("3.2") and v.moeda == "USD" and v.com_escala() == D("3200000")


def test_negativo_com_moeda_em_varias_posicoes():
    assert parse_valor("(R$ 1.234)", "pt").valor == D("-1234")
    assert parse_valor("-R$ 1.234", "pt").valor == D("-1234")
    assert parse_valor("R$ -1.234", "pt").valor == D("-1234")


def test_escala_do_cabecalho_multiplica_o_valor_da_celula():
    v = parse_valor("(101.806)", "pt")
    assert v.com_escala(1_000_000) == D("-101806000000")


# --- escala e moeda do cabeçalho -----------------------------------------------------------------------
@pytest.mark.parametrize(
    ("cabecalho", "fator", "moeda"),
    [
        ("R$ milhões, exceto percentuais", 1_000_000, "BRL"),
        ("R$ bilhões ou %", 1_000_000_000, "BRL"),
        ("em milhares de reais", 1_000, "BRL"),
        ("in millions of US$", 1_000_000, "USD"),
        ("(em R$ mil)", 1_000, "BRL"),
        ("In thousands of dollars", 1_000, "USD"),
    ],
)
def test_escala_e_moeda_do_cabecalho(cabecalho, fator, moeda):
    e = detectar_escala(cabecalho)
    assert e.fator == fator and e.moeda == moeda


def test_cabecalho_sem_escala_devolve_none_e_mil_nao_confunde_com_milhoes():
    assert detectar_escala("Quantidade ordinárias (Unidades)") is None
    assert detectar_escala("R$ milhões").fator == 1_000_000  # "mil" dentro de "milhões" não conta como mil


# --- formato do documento ------------------------------------------------------------------------------
def test_detecta_formato_pelo_conjunto_de_numeros():
    assert detectar_formato(["914.535", "8,5", "(6,3)", "1.045.338", "29.148.990,51"]) == "pt"
    assert detectar_formato(["1,234.56", "12.5", "(3.2)"]) == "en"
    assert detectar_formato(["1.234", "5.678"]) == "ambiguo"  # só milhar de três dígitos: nada decide
    assert detectar_formato(["texto", "sem número"]) == "ambiguo"


# --- faixas das tabelas de projeção --------------------------------------------------------------------
def test_faixas_com_negativos_e_percentuais():
    a, b = parse_faixa("-30,0 a -27,0", "pt")
    assert (a.valor, b.valor) == (D("-30.0"), D("-27.0"))
    a, b = parse_faixa("0,00% a 16,25%", "pt")
    assert (a.valor, b.valor, a.unidade) == (D("0.00"), D("16.25"), "percentual")


def test_faixa_invalida_ou_com_texto_devolve_none():
    assert parse_faixa("Mantido", "pt") is None
    assert parse_faixa("8,0", "pt") is None
    assert parse_faixa("5,0 a Mantido", "pt") is None


# --- números dentro de um trecho (lastro, F4.3) --------------------------------------------------------
def test_valores_no_texto_acha_anos_valores_e_percentuais():
    trecho = (
        "A receita líquida de 2025 foi de 1.201.131 milhões, alta de 2,8% sobre 2024 e (30,0) no exterior."
    )
    valores = [v.valor for v in valores_no_texto(trecho, "pt")]
    assert D("2025") in valores and D("1201131") in valores and D("2.8") in valores and D("-30.0") in valores


def test_valores_no_texto_ignora_palavras_sem_numero():
    assert valores_no_texto("Sem nenhum valor aqui.", "pt") == []


# --- estatística de células ----------------------------------------------------------------------------
def test_estatisticas_separam_numero_ausente_texto_e_nao_interpretado():
    celulas = ["914.535", "(6,3)", "-", "Total de Depósitos (A)", "R$ milhões", "1.23.4"]
    s = estatisticas_de_celulas(celulas, "pt")
    assert s["numero"] == 2 and s["ausente"] == 1 and s["nao_interpretado"] == 1 and s["texto"] == 2
    assert s["faixa"] == 0
    assert s["exemplos_nao_interpretados"] == ["1.23.4"]


@pytest.mark.parametrize(
    ("a", "b", "c", "d"),
    [
        ("835.670", "(101.806)", "311.474", "1.045.338"),  # 2023
        ("898.994", "(115.698)", "385.604", "1.168.900"),  # 2024
        ("930.662", "(120.016)", "390.485", "1.201.131"),  # 2025
    ],
)
def test_identidade_contabil_a_mais_b_mais_c_igual_d_com_b_entre_parenteses(a, b, c, d):
    soma = sum(parse_valor(x, "pt").valor for x in (a, b, c))
    assert soma == parse_valor(d, "pt").valor


@pytest.mark.parametrize(
    ("texto", "minimo", "maximo"),
    [
        ("9,53% a 15,77% DI", D("9.53"), D("15.77")),
        ("6,0% a 8,5% a.a.", D("6.0"), D("8.5")),
        ("3,02% a 16,25%", D("3.02"), D("16.25")),
    ],
)
def test_faixa_com_sufixo_de_indexador(texto, minimo, maximo):
    a, b = parse_faixa(texto, "pt")
    assert (a.valor, b.valor) == (minimo, maximo)


def test_rotulo_com_numero_e_faixa_de_prazo_sao_texto_e_faixa_de_percentual_e_faixa():
    s = estatisticas_de_celulas(
        ["Longo Prazo 2028", "01 a 30 dias", "0,00% a 16,25%", "Acima de 360 dias"], "pt"
    )
    assert s["texto"] == 3 and s["faixa"] == 1 and s["nao_interpretado"] == 0
