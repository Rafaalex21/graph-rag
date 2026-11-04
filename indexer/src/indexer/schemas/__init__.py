"""Modelos Pydantic da extração (ARQUITETURA §5 I-5) e o gerador do JSON Schema versionado em contracts/."""

from indexer.schemas.aberta import (
    TIPOS_DE_ENTIDADE,
    EntidadeAberta,
    ExtracaoAberta,
    RelacaoAberta,
)
from indexer.schemas.aberta import VERSAO as VERSAO_ABERTA
from indexer.schemas.extracao import (
    MAX_FATOS,
    VERSAO,
    Event,
    ExtracaoDirigida,
    FinancialFact,
    Instrument,
    Organization,
    Person,
    RiskFactor,
    Segment,
)

__all__ = [
    "MAX_FATOS",
    "TIPOS_DE_ENTIDADE",
    "VERSAO",
    "VERSAO_ABERTA",
    "EntidadeAberta",
    "Event",
    "ExtracaoAberta",
    "RelacaoAberta",
    "ExtracaoDirigida",
    "FinancialFact",
    "Instrument",
    "Organization",
    "Person",
    "RiskFactor",
    "Segment",
]
