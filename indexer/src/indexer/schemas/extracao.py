"""Esquemas da extração dirigida a esquema (ARQUITETURA §5 I-5, tarefa F4.1).

Cada campo tem `description` (o JSON Schema vai em `response_format` e o modelo lê as descrições) e é
`Optional` sempre que o documento pode não dizer: campo obrigatório sem informação induz o LLM a inventar.
As listas do contêiner `ExtracaoDirigida` são obrigatórias, mas podem vir vazias; assim a gramática força o
modelo a decidir sobre cada tipo em vez de omiti-lo. `extra = "forbid"` vira `additionalProperties: false`.

Os esquemas descrevem só o que o LLM lê no trecho. Identificador, página e ligação com o Pai ou a Tabela de
origem são do contexto da chamada (F4.2) e do importador (F4.4), não do modelo.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

VERSAO = "1.0.0"

# 2025-FY, 2025-Q4 ou 2025-12-31 (§5 I-5)
PADRAO_PERIODO = r"^\d{4}-(FY|Q[1-4])$|^\d{4}-\d{2}-\d{2}$"
# 2025, 2025-06 ou 2025-06-30
PADRAO_DATA = r"^\d{4}(-\d{2}(-\d{2})?)?$"
MAX_EVIDENCIA = 200

Unidade = Literal["currency", "percent", "count", "ratio", "basis_points"]
Escala = Literal[1, 1_000, 1_000_000, 1_000_000_000]
TipoPeriodo = Literal["fiscal_year", "quarter", "point_in_time"]
PapelOrganizacao = Literal[
    "issuer", "subsidiary", "controlled", "affiliate", "auditor", "regulator", "counterparty"
]
CategoriaRisco = Literal[
    "market", "credit", "liquidity", "operational", "regulatory", "currency", "esg", "other"
]
TipoEvento = Literal["acquisition", "divestiture", "issuance", "litigation", "restructuring", "dividends"]
TipoInstrumento = Literal["debenture", "bond", "loan", "derivative"]


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FinancialFact(_Base):
    """Um valor numérico reportado no documento, com período e evidência."""

    metric: str = Field(
        description="Nome da métrica como aparece no texto, ex.: 'Receita líquida', 'Lucro líquido ajustado'"
    )
    value: float = Field(
        description="O número como está escrito na evidência, já com sinal (negativos entre parênteses "
        "viram negativos) e SEM aplicar a escala; ex.: 'R$ 16.782 milhões' -> 16782"
    )
    unit: Unidade = Field(description="Natureza do valor: moeda, percentual, contagem, razão ou pontos-base")
    currency: str | None = Field(
        default=None, description="Código ISO 4217 quando unit = currency, ex.: BRL, USD; senão omitir"
    )
    scale: Escala | None = Field(
        default=None,
        description="Escala declarada na tabela ou no texto (1, 1000, 1000000 ou 1000000000); omitir para "
        "percentuais, razões e contagens sem escala",
    )
    period: str = Field(
        pattern=PADRAO_PERIODO,
        description="Período canônico: 2025-FY (exercício), 2025-Q4 (trimestre) ou 2025-12-31 (data)",
    )
    period_type: TipoPeriodo = Field(
        description="Se o valor é de um exercício, de um trimestre ou de uma data"
    )
    entity: str = Field(description="Empresa ou segmento a que o valor se refere, como aparece no texto")
    segment: str | None = Field(
        default=None, description="Segmento de negócio do valor, se a evidência o nomear; senão omitir"
    )
    evidence: str = Field(
        max_length=MAX_EVIDENCIA,
        description=f"Trecho literal curto (até {MAX_EVIDENCIA} caracteres) copiado do texto, com o valor",
    )

    @field_validator("value")
    @classmethod
    def _finito(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("valor não finito")
        return v


class Organization(_Base):
    """Uma organização citada no trecho e o papel dela em relação ao emissor."""

    name: str = Field(description="Nome da organização como aparece no texto")
    role: PapelOrganizacao = Field(
        description="Papel em relação ao emissor: emissor, subsidiária, controlada, coligada, auditor, "
        "regulador ou contraparte"
    )
    description: str | None = Field(
        default=None, description="Uma frase sobre o que a organização é ou faz, só se o trecho disser"
    )
    cnpj: str | None = Field(default=None, description="CNPJ exatamente como escrito, se aparecer")
    ticker: str | None = Field(default=None, description="Código de negociação (ticker), se aparecer")


class Person(_Base):
    """Uma pessoa citada no trecho com o cargo."""

    name: str = Field(description="Nome completo da pessoa como aparece no texto")
    position: str | None = Field(
        default=None, description="Cargo ou função, ex.: 'Diretor Vice-Presidente'; omitir se não aparecer"
    )
    organization: str | None = Field(
        default=None, description="Organização em que ocupa o cargo, se o trecho a nomear"
    )


class Segment(_Base):
    """Um segmento de negócio ou área de atuação."""

    name: str = Field(description="Nome do segmento como aparece no texto")
    organization: str | None = Field(
        default=None, description="Organização a que o segmento pertence, se o trecho a nomear"
    )
    description: str | None = Field(
        default=None, description="Uma frase sobre o segmento, só se o trecho disser"
    )


class RiskFactor(_Base):
    """Um fator de risco descrito no trecho."""

    name: str = Field(description="Nome curto do risco, ex.: 'Risco de crédito'")
    category: CategoriaRisco = Field(
        description="Categoria: mercado, crédito, liquidez, operacional, regulatório, câmbio, ESG ou outro"
    )
    description: str = Field(description="Resumo do risco em uma ou duas frases, fiel ao trecho")
    affected_entity: str | None = Field(
        default=None, description="Organização ou segmento que o risco afeta, se o trecho disser"
    )


class Event(_Base):
    """Um evento corporativo datado ou datável."""

    type: TipoEvento = Field(
        description="Tipo: aquisição, desinvestimento, emissão, litígio, reestruturação ou dividendos"
    )
    description: str = Field(description="O que aconteceu, em uma ou duas frases, fiel ao trecho")
    date: str | None = Field(
        default=None,
        pattern=PADRAO_DATA,
        description="Data do evento: 2025, 2025-06 ou 2025-06-30; omitir se o trecho não disser",
    )
    organizations: list[str] = Field(
        description="Nomes das organizações envolvidas, como aparecem no texto; lista vazia se nenhuma"
    )


class Instrument(_Base):
    """Um instrumento financeiro emitido ou contratado."""

    name: str = Field(description="Nome ou identificação do instrumento como aparece no texto")
    type: TipoInstrumento = Field(description="Tipo: debênture, bond, empréstimo ou derivativo")
    issuer: str | None = Field(default=None, description="Emissor ou tomador, se o trecho o nomear")
    maturity: str | None = Field(
        default=None,
        pattern=PADRAO_DATA,
        description="Vencimento: 2030, 2030-06 ou 2030-06-30; omitir se não aparecer",
    )
    description: str | None = Field(
        default=None, description="Uma frase com condições relevantes (taxa, valor), só se o trecho disser"
    )


class ExtracaoDirigida(_Base):
    """Tudo o que se extrai de um Pai ou de uma Tabela numa única chamada; listas vazias são válidas."""

    financial_facts: list[FinancialFact] = Field(
        description="Valores numéricos com período e evidência; lista vazia se o trecho não traz nenhum"
    )
    organizations: list[Organization] = Field(description="Organizações citadas; lista vazia se nenhuma")
    people: list[Person] = Field(description="Pessoas citadas com cargo; lista vazia se nenhuma")
    segments: list[Segment] = Field(description="Segmentos de negócio; lista vazia se nenhum")
    risk_factors: list[RiskFactor] = Field(description="Fatores de risco; lista vazia se nenhum")
    events: list[Event] = Field(description="Eventos corporativos; lista vazia se nenhum")
    instruments: list[Instrument] = Field(description="Instrumentos financeiros; lista vazia se nenhum")
