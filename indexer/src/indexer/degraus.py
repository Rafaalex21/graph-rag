"""Degraus da escada de ablações A0 a A3 (ARQUITETURA §13.3, tarefa F3.5).

Cada degrau é um `Sistema` (pergunta do golden set -> dict com `resposta` e `contexto`) para o harness de
`indexer.avaliar`. Tudo muda de um degrau para o seguinte; o LLM de resposta (Qwen3.6, temperatura 0,2) e o
prompt de resposta são os mesmos, de A1 em diante:

* **A0**: o LLM sem recuperação, de memória (pode dizer que não sabe);
* **A1**: vetor ingênuo; os 6 Filhos mais próximos, sem Pai, sem reranker (cada Filho com ~320 tokens);
* **A2**: o mesmo, com busca híbrida (vetor + full-text, RRF);
* **A3**: híbrida, k×4 Filhos, até 24 Pais, rerank, 6 Pais (o pipeline do `ask`);
* **A3r**: A3 com as duas reescritas da pergunta (step-back e HyDE, F2.8).
"""

from __future__ import annotations

from typing import Any

from indexer.ask import SISTEMA as SISTEMA_COM_TRECHOS
from indexer.ask import (
    Chat,
    conferir_citacoes,
    extrair_citacoes,
    responder,
    rotulo_de_pagina,
)
from indexer.busca import buscar
from indexer.reescrita import llm_llama, reescrever

DEGRAUS = ("a0", "a1", "a2", "a3", "a3r")
K_FILHOS = 6  # o mesmo número de trechos que o A3 entrega ao LLM

SISTEMA_A0 = (
    "Você responde perguntas sobre o Formulário de Referência 2026 (versão 7) do Banco do Brasil. "
    "Você NÃO tem acesso ao documento: responda de memória, em português, de forma direta. "
    "Se não souber ou não tiver certeza, diga que não sabe; não invente valores."
)


def formatar_filhos(filhos: list[dict]) -> str:
    """Trechos rotulados só com a página; o Filho não tem o título da seção, e o ingênuo não busca o Pai."""
    return "\n\n".join(f"[{rotulo_de_pagina(f)}]\n{f['text']}" for f in filhos)


def sistema_a0(chat: Chat):
    def responde(caso: dict) -> dict:
        resposta = chat(
            [{"role": "system", "content": SISTEMA_A0}, {"role": "user", "content": caso["pergunta"]}]
        )
        return {"resposta": resposta, "contexto": [], "citacoes": [], "citacoes_invalidas": 0}

    return responde


def sistema_filhos(driver: Any, embute, chat: Chat, modo: str, k: int = K_FILHOS, banco: str = "neo4j"):
    """A1 (`modo = 'vetor'`) e A2 (`modo = 'hibrido-rrf'`): os k melhores Filhos direto para o LLM."""

    def responde(caso: dict) -> dict:
        pergunta = caso["pergunta"]
        filhos = buscar(driver, pergunta, embute, k=k, modo=modo, banco=banco)
        mensagens = [
            {"role": "system", "content": SISTEMA_COM_TRECHOS},
            {"role": "user", "content": f"Trechos:\n\n{formatar_filhos(filhos)}\n\nPergunta: {pergunta}"},
        ]
        resposta = chat(mensagens) if filhos else "Não encontrei essa informação nos trechos recuperados."
        citacoes = conferir_citacoes(extrair_citacoes(resposta), filhos)
        return {
            "resposta": resposta,
            "citacoes": citacoes,
            "citacoes_invalidas": sum(1 for c in citacoes if not c["valida"]),
            "contexto": [{"paginas": rotulo_de_pagina(f), "caminho": "", "texto": f["text"]} for f in filhos],
        }

    return responde


def sistema_a3(driver: Any, embute, notas, chat: Chat, swap: str | None = None, reescritas: bool = False,
               banco: str = "neo4j"):  # fmt: skip
    """A3 (Pai + reranker) e, com `reescritas`, A3r (step-back e HyDE antes da busca)."""
    llm = llm_llama(swap) if reescritas else None

    def responde(caso: dict) -> dict:
        rew = (
            reescrever(caso["pergunta"], llm, stepback=True, hyde=True)
            if llm
            else {"stepback": None, "hyde": None}
        )
        return responder(
            driver,
            caso["pergunta"],
            embute,
            notas,
            chat,
            banco=banco,
            stepback=rew["stepback"],
            hyde=rew["hyde"],
        )

    return responde
