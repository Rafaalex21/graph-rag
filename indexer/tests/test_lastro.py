from decimal import Decimal

import pytest

from indexer.lastro import (
    ACEITO,
    MOTIVOS,
    avaliar,
    conferir,
    escalas_do_contexto,
    evidencia_no_texto,
    numeros_da_evidencia,
    resumir,
    so_em_faixas,
)

TABELA = """Documento: Empresa Exemplo S.A.
Seção: Resultados
Página: 10
Texto que antecede a tabela: (nenhum)
Notas da tabela: (nenhuma)
Escala/moeda declarada: fator 1000000, moeda BRL

Tabela (Markdown; células vazias podem ser parte de cabeçalhos mesclados):
| R$ milhões, exceto percentuais | 2023 | 2024 | 2025 | Var.% 25/24 |
|---|---|---|---|---|
| Receita total | 1.000 | 1.100 | 1.210 | 10,0 |
| Despesa total | (800) | (850) | (900) | 5,9 |
| Margem (%) | 20,0 | 22,7 | 25,6 | 2,9 |
"""

MISTA = """Escala/moeda declarada: fator 1000000000, moeda BRL

Tabela (Markdown; células vazias podem ser parte de cabeçalhos mesclados):
| R$ bilhões ou % |  | 1T25 |  | 9M25 |
| Indicadores | Projeção Inicial | Observado | Revisão | Observado |
|---|---|---|---|---|
| Carteira (%) | 5,0 a 9,0 | 6,1 | Mantido | 7,3 |
| Lucro ajustado | 30,0 a 34,0 | 9,3 | Mantido | 28,3 |
"""

REGIOES = """Escala/moeda declarada: nenhuma declarada

Tabela (Markdown; células vazias podem ser parte de cabeçalhos mesclados):
|  | Norte | Sul |
|---|---|---|
| Empregados | 1.581 | 5.075 |
"""

PAI = """Documento: Empresa Exemplo S.A.
Trecho:
Em 2025, o lucro totalizou R$ 625 milhões, alta de 12,5% (R$ 70 milhões) sobre 2024.
O quadro tinha 85,2 mil funcionários.
"""


def fato(**kw):
    base = {
        "metric": "Receita total", "value": 1210, "unit": "currency", "currency": None,
        "scale": 1_000_000, "period": "2025-FY", "period_type": "fiscal_year",
        "entity": "Empresa Exemplo", "segment": None, "evidence": "Receita total | 1.210",
    }  # fmt: skip
    return base | kw


def test_fato_de_tabela_com_valor_escala_linha_e_coluna_certos_e_aceito():
    assert avaliar(fato(), TABELA) == ACEITO


def test_evidencia_com_cabecalho_e_linha_em_qualquer_ordem_esta_no_texto():
    assert evidencia_no_texto("Receita total | 2025 | 1.210", TABELA)
    assert evidencia_no_texto("Receita total | ... | Var.% 25/24 | 10,0", TABELA)


@pytest.mark.parametrize(
    "evidencia", ["Receita total | 1.211", "Lucro | 1.210", "Receita total | 21.210", "", " | "]
)
def test_evidencia_que_nao_e_copia_do_texto_e_rejeitada(evidencia):
    assert not evidencia_no_texto(evidencia, TABELA)
    assert avaliar(fato(evidence=evidencia, value=1210), TABELA) in (
        "evidencia_fora_do_texto",
        "metrica_generica",
    )


def test_numero_que_nao_esta_na_evidencia_e_rejeitado():
    assert avaliar(fato(value=1211), TABELA) == "valor_ausente"


def test_sinal_impresso_vale_parenteses_sao_negativos():
    ev = "Despesa total | (900)"
    assert avaliar(fato(metric="Despesa total", value=-900, evidence=ev), TABELA) == ACEITO
    assert avaliar(fato(metric="Despesa total", value=900, evidence=ev), TABELA) == "sinal"
    assert avaliar(fato(value=-1210), TABELA) == "sinal"  # o impresso é positivo


def test_percentual_entre_parenteses_em_texto_corrido_nao_e_negativo():
    ev = "alta de 12,5% (R$ 70 milhões) sobre 2024"
    assert [str(n) for n, _ in numeros_da_evidencia(ev)][:2] == ["12.5", "70"]
    f = fato(metric="Alta do lucro", value=12.5, unit="percent", scale=1, evidence="alta de 12,5% (R$ 70")
    assert avaliar(f, PAI) == ACEITO


def test_valor_que_e_extremo_de_faixa_nao_e_ponto():
    assert so_em_faixas("Lucro ajustado | 30,0 a 34,0", Decimal("30"))
    assert not so_em_faixas("Lucro ajustado | 30,0 a 34,0 | 9,3", Decimal("9.3"))
    f = fato(
        metric="Lucro ajustado", value=30.0, scale=1_000_000_000, evidence="Lucro ajustado | 30,0 a 34,0"
    )
    assert avaliar(f, MISTA) == "faixa"
    ok = fato(
        metric="Lucro ajustado",
        value=9.3,
        scale=1_000_000_000,
        period="2025-Q1",
        evidence="1T25 | Observado | 9,3",
    )
    assert avaliar(ok, MISTA) == ACEITO


def test_numero_so_com_cabecalho_sem_rotulo_da_linha_nao_prova_a_linha():
    f = fato(metric="Outra coisa qualquer", value=1210, evidence="2025 | 1.210")
    assert avaliar(f, TABELA) == "linha"


def test_metrica_generica_nao_identifica_a_linha():
    assert avaliar(fato(metric="Total"), TABELA) == "metrica_generica"
    assert avaliar(fato(metric=" - Outros "), TABELA) == "metrica_generica"


@pytest.mark.parametrize(
    "periodo,esperado", [("2025-FY", ACEITO), ("2023-FY", "coluna"), ("2025-12-31", ACEITO)]
)
def test_ano_do_periodo_tem_de_estar_no_cabecalho_da_coluna(periodo, esperado):
    assert avaliar(fato(period=periodo), TABELA) == esperado


def test_coluna_de_variacao_vale_o_ano_em_que_ela_e_reportada():
    base = {"metric": "Variação Receita total 25/24", "value": 10.0, "unit": "percent", "scale": 1}
    assert avaliar(fato(**base, evidence="Receita total | 10,0"), TABELA) == ACEITO
    assert avaliar(fato(**base, period="2024-FY", evidence="Receita total | 10,0"), TABELA) == "coluna"


def test_dimensao_da_coluna_tem_de_estar_nos_campos_do_fato_nao_so_na_evidencia():
    ev = "Empregados | Norte | 1.581"
    f = fato(metric="Empregados", value=1581, unit="count", scale=1, evidence=ev)
    assert avaliar(f, REGIOES) == "coluna"
    assert avaliar(f | {"metric": "Empregados - Norte"}, REGIOES) == ACEITO
    assert avaliar(f | {"segment": "Norte"}, REGIOES) == ACEITO


def test_percentual_absurdo_e_valor_em_reais_com_unidade_errada():
    f = fato(metric="Receita total", value=1210, unit="percent", scale=1)
    assert avaliar(f, TABELA) == "unidade"


def test_tabela_mista_a_unidade_vem_do_rotulo_da_linha():
    ev = "Carteira (%) | 7,3"
    cart = fato(metric="Carteira", value=7.3, unit="percent", scale=1, period="2025-Q3", evidence=ev)
    assert avaliar(cart | {"period": "2025-09-30", "evidence": "9M25 | Observado | 7,3"}, MISTA) == ACEITO
    lucro = fato(
        metric="Lucro ajustado", value=28.3, unit="percent", scale=1, period="2025-09-30",
        evidence="Lucro ajustado | 9M25 | Observado | 28,3",
    )  # fmt: skip
    assert avaliar(lucro, MISTA) == "unidade"
    assert avaliar(lucro | {"unit": "currency", "scale": 1_000_000_000}, MISTA) == ACEITO


@pytest.mark.parametrize(
    "escala,esperado", [(1_000_000, ACEITO), (1_000, "escala"), (1, ACEITO), (1_000_000_000, "escala")]
)
def test_escala_do_fato_tem_de_ser_a_declarada_pela_tabela(escala, esperado):
    assert avaliar(fato(scale=escala), TABELA) == esperado


def test_escala_maior_que_1_sem_nenhuma_escala_no_texto_fica_sem_lastro():
    f = fato(
        metric="Empregados", value=1581, unit="currency", scale=1000, evidence="Empregados | Norte | 1.581"
    )
    assert avaliar(f | {"metric": "Empregados - Norte"}, REGIOES) == "escala_sem_lastro"
    assert escalas_do_contexto(REGIOES) == set()
    assert escalas_do_contexto(TABELA) == {1_000_000}
    assert escalas_do_contexto(MISTA) == {1_000_000_000}


def test_escala_dita_ao_lado_do_numero_vale_mais_que_a_da_tabela():
    ev = "o lucro totalizou R$ 625 milhões"
    f = fato(metric="Lucro", value=625, evidence=ev)
    assert avaliar(f, PAI) == ACEITO
    assert avaliar(f | {"scale": 1}, PAI) == "escala"
    assert avaliar(f | {"scale": 1_000}, PAI) == "escala"
    mil = fato(
        metric="Funcionários", value=85.2, unit="count", scale=1000, evidence="O quadro tinha 85,2 mil"
    )
    assert avaliar(mil, PAI) == ACEITO
    assert avaliar(mil | {"scale": 1}, PAI) == "escala"


def test_percentual_e_ponto_base_tem_escala_1():
    f = fato(metric="Alta do lucro", value=12.5, unit="percent", scale=1_000_000, evidence="alta de 12,5%")
    assert avaliar(f, PAI) == "escala"


def test_conferir_e_resumir_contam_por_motivo_e_ignoram_unidade_invalida():
    resultados = [
        {"id": "u1", "tipo": "tabela", "paginas": [10, 10], "valida": True,
         "resposta": {"financial_facts": [fato(), fato(value=1211)]}},
        {"id": "u2", "tipo": "pai", "paginas": [1, 1], "valida": False, "resposta": None},
    ]  # fmt: skip
    registros = conferir(resultados, {"u1": TABELA, "u2": PAI})
    assert [r["motivo"] for r in registros] == [ACEITO, "valor_ausente"]
    resumo = resumir(registros)
    assert resumo["fatos"] == 2 and resumo["aceitos"] == 1 and resumo["taxa_de_rejeicao"] == 0.5
    assert set(resumo["por_motivo"]) == set(MOTIVOS)
    assert resumo["por_motivo"]["valor_ausente"] == 1
    assert resumo["por_tipo"]["tabela"] == {"fatos": 2, "rejeitados": 1}
