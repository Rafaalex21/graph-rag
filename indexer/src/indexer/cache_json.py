"""Cache das etapas com LLM: um arquivo JSON por pedido, gravado de forma atômica e lido com tolerância.

A rodada p4 da F10.1 (ADR-083) mostrou o defeito. Uma queda de luz no meio da gravação deixou
arquivos de `metricas_cache` pela metade ou cheios de bytes nulos, e a retomada caía com
`JSONDecodeError`. Por isso:

- `gravar` escreve num temporário único da mesma pasta, força o disco (`fsync`) e troca o nome com
  `os.replace`. O arquivo final ou é o antigo, ou é o novo inteiro.
- `ler` trata um arquivo ausente, ilegível, inválido ou que não seja objeto JSON como "não está no
  cache". O pedido é refeito e o arquivo, regravado.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path


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
    return dado if isinstance(dado, dict) else None


def gravar(arq: Path, dado: object) -> None:
    """Grava `dado` em `arq` de forma atômica: uma interrupção nunca deixa o arquivo pela metade."""
    arq.parent.mkdir(parents=True, exist_ok=True)
    tmp = arq.with_name(f"{arq.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(dado, ensure_ascii=False, indent=1))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, arq)
