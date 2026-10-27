#!/usr/bin/env python3
"""Leitor e validador do docs/ETAPAS.md (somente biblioteca padrão).

Uso:
    python tools/etapas.py check   [docs/ETAPAS.md]   # valida; sai com 1 se houver erro
    python tools/etapas.py resumo  [docs/ETAPAS.md]   # progresso por fase
    python tools/etapas.py json    [docs/ETAPAS.md]   # estrutura completa em JSON

O formato é o descrito na seção "Como ler e editar" do próprio ETAPAS.md.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

PHASE_RE = re.compile(r"^##\s+(F\d+)\s+·\s+(.+?)\s*$")
META_RE = re.compile(r"^>\s*([^\W\d_]+):\s*(.*?)\s*$")
TASK_RE = re.compile(r"^-\s+\[([ ~x!])\]\s+\*\*(F\d+\.\d+)\*\*\s+(.*?)\s*$")
SUB_RE = re.compile(r"^\s+-\s+(aceite|depende|nota):\s*(.*?)\s*$")
ID_RE = re.compile(r"F\d+\.\d+")

STATUS = {" ": "pendente", "~": "andamento", "x": "feita", "!": "bloqueada"}


@dataclass
class Task:
    id: str
    status: str  # pendente | andamento | feita | bloqueada
    texto: str
    aceite: str = ""
    depende: list[str] = field(default_factory=list)
    nota: str = ""
    fase: str = ""


@dataclass
class Phase:
    id: str
    titulo: str
    meta: dict[str, str] = field(default_factory=dict)
    tarefas: list[Task] = field(default_factory=list)


def parse(texto: str) -> list[Phase]:
    fases: list[Phase] = []
    fase: Phase | None = None
    tarefa: Task | None = None
    for linha in texto.splitlines():
        if m := PHASE_RE.match(linha):
            fase = Phase(id=m[1], titulo=m[2])
            fases.append(fase)
            tarefa = None
            continue
        if fase is None:
            continue
        if linha.startswith("## "):  # seção fora do plano (ex.: "Matriz de modelos")
            fase = None
            tarefa = None
            continue
        if m := TASK_RE.match(linha):
            tarefa = Task(id=m[2], status=STATUS[m[1]], texto=m[3], fase=fase.id)
            fase.tarefas.append(tarefa)
            continue
        if tarefa and (m := SUB_RE.match(linha)):
            chave, valor = m[1], m[2]
            if chave == "depende":
                tarefa.depende = ID_RE.findall(valor)
            else:
                setattr(tarefa, chave, valor)
            continue
        if not fase.tarefas and (m := META_RE.match(linha)):
            fase.meta[m[1]] = m[2]
    return fases


def ler(caminho: str | Path) -> list[Phase]:
    return parse(Path(caminho).read_text(encoding="utf-8"))


def validar(fases: list[Phase]) -> tuple[list[str], list[str]]:
    erros: list[str] = []
    avisos: list[str] = []
    ids: dict[str, Task] = {}
    ids_fase: set[str] = set()
    for f in fases:
        if f.id in ids_fase:
            erros.append(f"fase repetida: {f.id}")
        ids_fase.add(f.id)
        if not f.tarefas:
            avisos.append(f"{f.id}: fase sem tarefas")
        for t in f.tarefas:
            if t.id in ids:
                erros.append(f"tarefa repetida: {t.id}")
            ids[t.id] = t
            if not t.id.startswith(f.id + "."):
                erros.append(f"{t.id}: o prefixo não bate com a fase {f.id}")
            if not t.aceite:
                avisos.append(f"{t.id}: sem critério de aceite")
    for t in ids.values():
        for d in t.depende:
            if d not in ids:
                erros.append(f"{t.id}: depende de {d}, que não existe")
            elif d == t.id:
                erros.append(f"{t.id}: depende de si mesma")
    # ciclos (busca em profundidade)
    visitando: set[str] = set()
    visto: set[str] = set()

    def dfs(i: str, trilha: list[str]) -> None:
        if i in visto or i not in ids:
            return
        if i in visitando:
            erros.append("ciclo de dependências: " + " → ".join(trilha + [i]))
            return
        visitando.add(i)
        for d in ids[i].depende:
            dfs(d, trilha + [i])
        visitando.discard(i)
        visto.add(i)

    for i in ids:
        dfs(i, [])
    # coerência de estado: concluída com dependência não concluída
    for t in ids.values():
        if t.status == "feita":
            for d in t.depende:
                if d in ids and ids[d].status != "feita":
                    avisos.append(f"{t.id} está feita, mas depende de {d} ({ids[d].status})")
    return erros, avisos


def resumo(fases: list[Phase]) -> str:
    linhas = []
    total = feitas = 0
    for f in fases:
        n = len(f.tarefas)
        k = sum(t.status == "feita" for t in f.tarefas)
        total += n
        feitas += k
        linhas.append(f"{f.id:<4} {k:>2}/{n:<2}  {f.titulo}")
    linhas.append(f"{'':<4} {feitas:>2}/{total:<2}  total")
    return "\n".join(linhas)


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "check"
    caminho = argv[2] if len(argv) > 2 else "docs/ETAPAS.md"
    fases = ler(caminho)
    if cmd == "check":
        erros, avisos = validar(fases)
        for a in avisos:
            print(f"aviso: {a}")
        for e in erros:
            print(f"ERRO: {e}")
        n = sum(len(f.tarefas) for f in fases)
        print(f"{len(fases)} fases, {n} tarefas, {len(erros)} erro(s), {len(avisos)} aviso(s)")
        return 1 if erros else 0
    if cmd == "resumo":
        print(resumo(fases))
        return 0
    if cmd == "json":
        print(json.dumps([asdict(f) for f in fases], ensure_ascii=False, indent=2))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv))
