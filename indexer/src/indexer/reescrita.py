"""Reescritas opcionais da consulta: step-back e HyDE (ARQUITETURA §7 e cap. 3, tarefa F2.8).

* **Step-back:** o LLM troca a pergunta por outra mais geral, que traz o contexto necessário para respondê-la
  ("Qual foi o lucro de 2025?" -> "Quais foram os resultados financeiros no exercício de 2025?"). A busca roda
  também com ela.
* **HyDE** (*Hypothetical Document Embeddings*): o LLM escreve um trecho hipotético que responderia à
  pergunta, no estilo do documento; o vetor desse trecho (lado do documento, sem instrução) é mais parecido
  com os Filhos do que o da pergunta. Os fatos do trecho podem estar errados; só o "jeito" do texto importa.

As duas são opcionais e **voltam à busca original em caso de falha**: se o LLM errar ou devolver algo
inválido, a reescrita é descartada e registrada, e a recuperação segue com a pergunta. As chamadas rodam em
paralelo. O LLM é o do perfil `consultar` (Qwen3.6) ou, no `consultar-rapido`, o gpt-oss.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar): flags de `indexer.recuperador buscar` e
`indexer.reranker buscar`:  `--stepback`  `--hyde`  `--llm MODELO`
    uv run python -m indexer.reescrita "Qual foi o lucro líquido em 2025?" --stepback --hyde
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

MODELO_LLM = "qwen36-35b-a3b"
DOCUMENTO = "Formulário de Referência (documento da CVM) de uma companhia brasileira"

ESQUEMA_STEPBACK = {
    "type": "object",
    "properties": {"pergunta_geral": {"type": "string", "minLength": 15}},
    "required": ["pergunta_geral"],
    "additionalProperties": False,
}
ESQUEMA_HYDE = {
    "type": "object",
    "properties": {"trecho": {"type": "string", "minLength": 200}},
    "required": ["trecho"],
    "additionalProperties": False,
}

PROMPT_STEPBACK = """Você ajuda um sistema de busca sobre um {documento}.
Reescreva a pergunta do usuário como UMA pergunta mais geral e abstrata, que trate do tema e do contexto
necessários para respondê-la, mantendo a empresa e o período quando houver. Não responda a pergunta.

Exemplos:
Pergunta: Qual foi o lucro líquido ajustado em 2025?
Pergunta geral: Quais foram os resultados financeiros da companhia no exercício de 2025?
Pergunta: Quem é o presidente do conselho de administração?
Pergunta geral: Como é composta e organizada a administração da companhia?

Pergunta: {pergunta}"""

PROMPT_HYDE = """Você ajuda um sistema de busca sobre um {documento}.
Escreva um trecho de 80 a 130 palavras, em português formal e no estilo desse tipo de documento, que
responderia à pergunta abaixo. Não é preciso que os fatos estejam corretos: o que importa é o vocabulário e o
tom do documento. Evite números exatos. Não mencione a pergunta nem o usuário.

Pergunta: {pergunta}"""

LLM = Callable[[list[dict], dict, int, float], dict]


def llm_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 300) -> LLM:
    """Função (mensagens, esquema, max_tokens, temperatura) -> objeto JSON, sem raciocínio."""

    def chama(mensagens: list[dict], esquema: dict, max_tokens: int, temperatura: float) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": temperatura,
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "reescrita", "strict": True, "schema": esquema},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(json.load(r)["choices"][0]["message"]["content"])

    return chama


def _normaliza(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", sem_acento.lower())).strip()


def validar_stepback(original: str, texto: object) -> str | None:
    """Problema da pergunta geral (None = válida)."""
    if not isinstance(texto, str) or not (15 <= len(texto.strip()) <= 300):
        return "pergunta geral ausente ou fora de 15 a 300 caracteres"
    if not texto.strip().endswith("?"):
        return "não termina com '?'"
    if _normaliza(texto) == _normaliza(original):
        return "igual à pergunta original"
    return None


def validar_hyde(texto: object) -> str | None:
    if not isinstance(texto, str) or not (200 <= len(texto.strip()) <= 1500):
        return "trecho ausente ou fora de 200 a 1.500 caracteres"
    return None


def reescrever(pergunta: str, llm: LLM, stepback: bool = False, hyde: bool = False) -> dict:
    """Reescritas pedidas, em paralelo. Devolve {'stepback': str|None, 'hyde': str|None, 'ms': {...},
    'erros': {...}}; qualquer falha vira None e entra em 'erros' (a busca segue com a pergunta)."""

    def passo(nome: str) -> tuple[str, str | None, str | None, float]:
        t0 = time.perf_counter()
        try:
            if nome == "stepback":
                prompt = PROMPT_STEPBACK.format(documento=DOCUMENTO, pergunta=pergunta)
                resposta = llm([{"role": "user", "content": prompt}], ESQUEMA_STEPBACK, 120, 0.2)
                texto = resposta.get("pergunta_geral")
                erro = validar_stepback(pergunta, texto)
            else:
                prompt = PROMPT_HYDE.format(documento=DOCUMENTO, pergunta=pergunta)
                resposta = llm([{"role": "user", "content": prompt}], ESQUEMA_HYDE, 400, 0.4)
                texto = resposta.get("trecho")
                erro = validar_hyde(texto)
        except Exception as e:  # rede, JSON, modelo fora do ar: a reescrita é opcional
            texto, erro = None, f"{type(e).__name__}: {e}"[:200]
        return (
            nome,
            (texto.strip() if erro is None and texto else None),
            erro,
            (time.perf_counter() - t0) * 1000,
        )

    pedidos = [n for n, ligado in (("stepback", stepback), ("hyde", hyde)) if ligado]
    saida: dict = {"stepback": None, "hyde": None, "ms": {}, "erros": {}}
    if not pedidos:
        return saida
    with ThreadPoolExecutor(max_workers=len(pedidos)) as pool:
        for nome, texto, erro, ms in pool.map(passo, pedidos):
            saida[nome] = texto
            saida["ms"][nome] = round(ms, 1)
            if erro:
                saida["erros"][nome] = erro
    return saida


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pergunta")
    ap.add_argument("--stepback", action="store_true")
    ap.add_argument("--hyde", action="store_true")
    ap.add_argument("--llm", default=MODELO_LLM)
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    a = ap.parse_args()
    r = reescrever(a.pergunta, llm_llama(a.swap, a.llm), a.stepback, a.hyde)
    print(json.dumps(r, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
