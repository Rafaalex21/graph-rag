import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from indexer.schemas import VERSAO, ExtracaoDirigida, FinancialFact
from indexer.schemas.__main__ import ARQUIVO, gerar

RAIZ = Path(__file__).resolve().parents[2]


def fato(**kw):
    base = {
        "metric": "Lucro líquido", "value": 16782, "unit": "currency", "currency": "BRL",
        "scale": 1_000_000, "period": "2025-FY", "period_type": "fiscal_year",
        "entity": "Banco do Brasil", "evidence": "Lucro líquido de R$ 16.782 milhões em 2025",
    }  # fmt: skip
    return base | kw


def esquema():
    return json.loads(gerar())


def test_arquivo_versionado_em_contracts_esta_em_dia():
    versionado = (RAIZ / ARQUIVO).read_text(encoding="utf-8").replace("\r\n", "\n")
    assert versionado == gerar()
    assert esquema()["version"] == VERSAO


def test_todo_campo_tem_descricao_e_nenhum_modelo_aceita_campo_a_mais():
    defs = esquema()["$defs"]
    assert set(defs) == {
        "Event", "FinancialFact", "Instrument", "Organization", "Person", "RiskFactor", "Segment"
    }  # fmt: skip
    for nome, d in {**defs, "ExtracaoDirigida": esquema()}.items():
        assert d["additionalProperties"] is False, nome
        for campo, p in d["properties"].items():
            assert p.get("description"), f"{nome}.{campo} sem descrição"


def test_so_o_que_o_documento_sempre_diz_e_obrigatorio():
    defs = esquema()["$defs"]
    assert set(defs["FinancialFact"]["required"]) == {
        "metric", "value", "unit", "scale", "period", "period_type", "entity", "evidence"
    }  # fmt: skip
    # moeda e segmento podem faltar (só há moeda em valores monetários); aceitam null no schema
    for campo in ("currency", "segment"):
        tipos = [x.get("type") for x in defs["FinancialFact"]["properties"][campo]["anyOf"]]
        assert "null" in tipos
    assert set(defs["Person"]["required"]) == {"name"}
    assert set(defs["Organization"]["required"]) == {"name", "role"}
    assert set(defs["Event"]["required"]) == {"type", "description", "organizations"}


def test_conteiner_exige_as_sete_listas_mas_aceita_todas_vazias():
    listas = {
        "financial_facts", "organizations", "people", "segments", "risk_factors", "events", "instruments"
    }  # fmt: skip
    assert set(esquema()["required"]) == listas
    vazio = ExtracaoDirigida.model_validate({k: [] for k in listas})
    assert vazio.financial_facts == []
    with pytest.raises(ValidationError):
        ExtracaoDirigida.model_validate({"financial_facts": []})


def test_fato_valido_e_percentual_com_escala_1_e_sem_moeda():
    f = FinancialFact.model_validate(fato())
    assert f.scale == 1_000_000 and f.segment is None
    p = FinancialFact.model_validate(
        fato(unit="percent", value=66.25, currency=None, scale=1, evidence="Índice de 66,25%")
    )
    assert p.scale == 1 and p.currency is None
    with pytest.raises(ValidationError):  # sem escala o valor fica ambíguo ("85,2 mil" virava 85,2)
        FinancialFact.model_validate({k: v for k, v in fato().items() if k != "scale"})


@pytest.mark.parametrize(
    "ruim",
    [
        {"period": "2025"},
        {"period": "2025-Q5"},
        {"period": "FY2025"},
        {"scale": 10},
        {"unit": "money"},
        {"evidence": "x" * 201},
        {"value": float("inf")},
        {"unit": "basis_points"},  # a evidência fala de R$, não de pontos-base
        {"valor_extra": 1},
    ],
)
def test_fato_invalido_e_rejeitado(ruim):
    with pytest.raises(ValidationError):
        FinancialFact.model_validate(fato(**ruim))


@pytest.mark.parametrize(
    "evidencia",
    ["queda de 25 pontos-base", "alta de 25 pontos base", "spread de 25 bps", "variação de 25 p.b."],
)
def test_pontos_base_aceitos_quando_a_evidencia_os_cita(evidencia):
    f = FinancialFact.model_validate(
        fato(unit="basis_points", value=25, scale=1, currency=None, evidence=evidencia)
    )
    assert f.unit == "basis_points"


def test_bps_dentro_de_outra_palavra_nao_vale_como_pontos_base():
    with pytest.raises(ValidationError):
        FinancialFact.model_validate(fato(unit="basis_points", evidence="R$ 3 milhões em campbpsx"))


@pytest.mark.parametrize("periodo", ["2025-FY", "2025-Q4", "2025-12-31"])
def test_periodos_canonicos_aceitos(periodo):
    assert FinancialFact.model_validate(fato(period=periodo)).period == periodo
