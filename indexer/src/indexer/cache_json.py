"""Cache das etapas com LLM: um arquivo JSON por pedido, gravado de forma atômica e lido com tolerância.

A rodada p4 da F10.1 (ADR-083) mostrou o defeito. Uma queda de luz no meio da gravação deixou
arquivos de `metricas_cache` pela metade ou cheios de bytes nulos, e a retomada caía com
`JSONDecodeError`. Por isso:

- `gravar` escreve num temporário único da mesma pasta, força o disco (`fsync`) e troca o nome com
  `os.replace`. O arquivo final ou é o antigo, ou é o novo inteiro.
- `ler` trata um arquivo ausente, ilegível, inválido ou que não seja objeto JSON como "não está no
  cache". O pedido é refeito e o arquivo, regravado.

A rodada r2 da F10.2 mostrou outro defeito. O LLM devolveu um JSON com uma metade de par UTF-16
sozinha (o escape `\\ud835`), e `json.loads` aceita isso e entrega um `str` que não pode ser escrito
em UTF-8. Era o mesmo par em todas as tentativas, e a etapa `resolver-planejar` caía sempre no mesmo
ponto. Por isso `gravar` troca cada metade solta por U+FFFD e **devolve o dado limpo**. Quem grava
usa o que `gravar` devolve, e assim o texto que segue para o plano e para o grafo é o mesmo que ficou
no cache.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

SUBSTITUTO = "�"


def _texto_limpo(s: str) -> str:
    # um par válido já chega junto num só caractere; só as metades soltas viram U+FFFD
    return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def limpar(dado: object) -> object:
    """Cópia de `dado` sem metades soltas de par UTF-16 em nenhum texto (chaves inclusive)."""
    if isinstance(dado, str):
        return _texto_limpo(dado)
    if isinstance(dado, dict):
        return {limpar(k): limpar(v) for k, v in dado.items()}
    if isinstance(dado, (list, tuple)):
        return [limpar(v) for v in dado]
    return dado


def ler(arq: Path) -> dict | None:
    """O objeto guardado em `arq`, ou None se ele não existe ou não é um JSON de objeto válido."""
    try:
        bruto = arq.read_bytes()
    except FileNotFoundError:
        return None
    try:
        dado = json.loads(bruto.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return limpar(dado) if isinstance(dado, dict) else None


def gravar(arq: Path, dado: object):
    """Grava `dado` limpo em `arq` de forma atômica e devolve o dado limpo, que é o que o chamador usa.

    Uma interrupção nunca deixa o arquivo pela metade, e uma falha não deixa o temporário para trás."""
    limpo = limpar(dado)
    arq.parent.mkdir(parents=True, exist_ok=True)
    tmp = arq.with_name(f"{arq.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(limpo, ensure_ascii=False, indent=1))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, arq)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return limpo
