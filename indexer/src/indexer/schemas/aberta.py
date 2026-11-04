"""Esquema da extração aberta (ARQUITETURA §5 I-6, tarefa F5.1).

É a camada MS GraphRAG: entidades de onze tipos financeiros fixos e relações com força de 1 a 10, em JSON por
gramática no lugar das tuplas com delimitadores do artigo original (ADR-004). Diferente da extração dirigida
(`extracao.py`), aqui a lista de tipos é aberta ao que o trecho disser, mas o conjunto de tipos é fechado e
fixado antes, como o livro exige. A ligação com o Pai de origem (`MENTIONED_IN`) é do contexto da chamada.

As duas listas são obrigatórias e podem vir vazias. `extra = "forbid"` vira `additionalProperties: false`.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VERSAO = "1.0.0"  # ainda não consumida por nenhuma etapa: o 11º tipo entrou antes do primeiro uso
MAX_ENTIDADES = 30  # por Pai; imposto por gramática (maxItems)
MAX_RELACOES = 40
MAX_DESCRICAO = 300  # caracteres

# A ordem é a da §5 I-6 e a do prompt (indexer.extracao_aberta.DEFINICAO_DOS_TIPOS).
TIPOS_DE_ENTIDADE = (
    "ORGANIZATION",
    "PERSON",
    "SEGMENT",
    "PRODUCT_OR_SERVICE",
    "FINANCIAL_METRIC",
    "RISK",
    "EVENT",
    "FINANCIAL_INSTRUMENT",
    "REGULATION",
    "POLICY_OR_PROGRAM",
    "LOCATION",
)
TipoDeEntidade = Literal[
    "ORGANIZATION",
    "PERSON",
    "SEGMENT",
    "PRODUCT_OR_SERVICE",
    "FINANCIAL_METRIC",
    "RISK",
    "EVENT",
    "FINANCIAL_INSTRUMENT",
    "REGULATION",
    "POLICY_OR_PROGRAM",
    "LOCATION",
]
# A força é um enum de inteiros, e não minimum/maximum, porque a gramática do llama-server impõe enum
# (a F4.2 mediu que `pattern` não é imposto).
Forca = Literal[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]


_MESES = "janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro"
# Nome que é só uma data ("14 de agosto de 2024", "2025") ou só um valor ("R$ 625 milhões", "27,1%"). O LLM os
# devolve como EVENT e FINANCIAL_METRIC mesmo com o prompt proibindo (medido na F5.1, ADR-038); a gramática
# não impõe `pattern`, então a recusa é por validação, com a retentativa levando a mensagem de erro.
NOME_DE_DATA_OU_VALOR = re.compile(
    rf"^\s*(\d{{1,2}}º?\s+de\s+)?({_MESES})(\s+de\s+\d{{4}})?\s*$"
    r"|^\s*\d{1,2}/\d{1,2}/\d{2,4}\s*$"
    r"|^\s*(19|20)\d{2}\s*$"
    r"|^\s*((R|US)\$\s*)?[\d.,]+(\s*(%|mil|milh(ão|ões)|bilh(ão|ões)|trilh(ão|ões)))?\s*$",
    re.IGNORECASE,
)


def normalizar_nome(nome: str) -> str:
    """Chave de comparação dos nomes dentro de uma resposta: sem espaços sobrando nem caixa."""
    return " ".join(nome.split()).casefold()


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EntidadeAberta(_Base):
    """Uma entidade citada no trecho, com o tipo e o que o trecho diz sobre ela."""

    name: str = Field(
        min_length=1,
        description="Nome da entidade como aparece no texto, na grafia mais completa que o trecho usar",
    )
    type: TipoDeEntidade = Field(
        description="Um dos tipos fixos: ORGANIZATION, PERSON, SEGMENT, PRODUCT_OR_SERVICE, "
        "FINANCIAL_METRIC, RISK, EVENT, FINANCIAL_INSTRUMENT, REGULATION, POLICY_OR_PROGRAM ou LOCATION"
    )
    description: str = Field(
        min_length=1,
        max_length=MAX_DESCRICAO,
        description=f"O que o trecho diz sobre a entidade, em uma ou duas frases (até {MAX_DESCRICAO} "
        "caracteres), sem acrescentar o que o trecho não diz",
    )

    @field_validator("name")
    @classmethod
    def _nome_nao_e_data_nem_valor(cls, nome: str) -> str:
        if NOME_DE_DATA_OU_VALOR.match(nome):
            raise ValueError(
                f"'{nome}' é uma data ou um valor, não uma entidade: nomeie o EVENT pelo que aconteceu "
                "(a data vai na descrição) e ponha o valor na descrição da entidade a que pertence; "
                "remova também as relações que usam esse nome"
            )
        return nome


class RelacaoAberta(_Base):
    """Uma relação entre duas entidades da mesma resposta."""

    source: str = Field(min_length=1, description="Nome da entidade de origem, idêntico ao de `entities`")
    target: str = Field(min_length=1, description="Nome da entidade de destino, idêntico ao de `entities`")
    description: str = Field(
        min_length=1,
        max_length=MAX_DESCRICAO,
        description=f"Por que as duas se relacionam, segundo o trecho (até {MAX_DESCRICAO} caracteres)",
    )
    strength: Forca = Field(
        description="Força da relação de 1 a 10: 1-3 citação de passagem, 4-6 relação clara, 7-10 relação "
        "central ao trecho (controle, emissão, regulação direta, risco principal)"
    )


class ExtracaoAberta(_Base):
    """Entidades e relações de um Pai numa única chamada; listas vazias são válidas."""

    entities: list[EntidadeAberta] = Field(
        max_length=MAX_ENTIDADES,
        description=f"Entidades dos tipos fixos citadas no trecho (até {MAX_ENTIDADES}); "
        "lista vazia se nenhuma",
    )
    relationships: list[RelacaoAberta] = Field(
        max_length=MAX_RELACOES,
        description=f"Relações entre as entidades acima (até {MAX_RELACOES}); lista vazia se nenhuma",
    )

    @model_validator(mode="after")
    def _relacao_so_entre_entidades_da_resposta(self) -> ExtracaoAberta:
        nomes = {normalizar_nome(e.name) for e in self.entities}
        soltas = sorted(
            {r.source for r in self.relationships if normalizar_nome(r.source) not in nomes}
            | {r.target for r in self.relationships if normalizar_nome(r.target) not in nomes}
        )
        if soltas:
            raise ValueError(
                f"relações citam entidades que não estão em `entities`: {soltas[:5]}; "
                "inclua a entidade ou remova a relação"
            )
        return self
