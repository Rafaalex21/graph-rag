#!/usr/bin/env python3
"""Sincroniza docs/ETAPAS.md com o GitHub: marcos (um por fase), rótulos e issues (uma por tarefa).

O ETAPAS.md é a fonte da verdade. A sincronia é idempotente:
  - cria o que falta (marco, rótulo, issue);
  - fecha a issue cuja tarefa está [x] e reabre a que voltou a não estar;
  - mantém os rótulos "em andamento" e "bloqueada" conforme [~] e [!].
Textos de issues já criadas não são reescritos.

Requer o GitHub CLI (`gh`) autenticado e, fora de uma pasta de repositório, --repo DONO/REPO.

Uso:
    python tools/etapas_to_issues.py --dry-run          # mostra o plano, sem chamar o gh
    python tools/etapas_to_issues.py                    # sincroniza
    python tools/etapas_to_issues.py --repo fulano/graph-rag --file docs/ETAPAS.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from etapas import Phase, Task, ler, validar  # noqa: E402

CORES = ["1d76db", "0e8a16", "5319e7", "fbca04", "b60205", "0052cc", "006b75", "d93f0b", "c5def5", "bfd4f2", "7057ff"]
ROTULOS_FIXOS = {
    "em andamento": ("fbca04", "Tarefa em curso ([~] no ETAPAS.md)"),
    "bloqueada": ("d73a4a", "Tarefa bloqueada ([!] no ETAPAS.md)"),
    "etapas": ("ededed", "Gerada a partir de docs/ETAPAS.md"),
}
TITULO_RE = re.compile(r"^(F\d+\.\d+)\s+·\s")


class GH:
    def __init__(self, repo: str | None, dry: bool):
        self.dry = dry
        self.env = dict(os.environ)
        if repo:
            self.env["GH_REPO"] = repo

    def run(self, *args: str, entrada: str | None = None, leitura: bool = False) -> str:
        if self.dry:
            return ""
        r = subprocess.run(
            ["gh", *args], input=entrada, capture_output=True, text=True,
            encoding="utf-8", env=self.env,
        )
        if r.returncode != 0:
            raise SystemExit(f"gh {' '.join(args[:3])} falhou:\n{r.stderr.strip()}")
        return r.stdout


def corpo_issue(t: Task, f: Phase, numeros: dict[str, int]) -> str:
    partes = [t.texto, ""]
    if t.aceite:
        partes += ["**Critério de aceite**", f"{t.aceite}", ""]
    if t.depende:
        deps = ", ".join(f"#{numeros[d]} ({d})" if d in numeros else d for d in t.depende)
        partes += [f"**Depende de:** {deps}", ""]
    if t.nota:
        partes += [f"**Nota:** {t.nota}", ""]
    obj = f.meta.get("objetivo")
    if obj:
        partes += [f"> Fase {f.id} — {f.titulo}. {obj}", ""]
    partes += [
        "---",
        "_Gerada de `docs/ETAPAS.md`. Para mudar texto, critério ou dependência, edite o arquivo "
        "(a fonte da verdade); marcar `[x]` lá fecha esta issue na próxima sincronia._",
    ]
    return "\n".join(partes)


def rotulos_da_tarefa(t: Task) -> list[str]:
    r = [f"fase:{t.fase}", "etapas"]
    if t.status == "andamento":
        r.append("em andamento")
    elif t.status == "bloqueada":
        r.append("bloqueada")
    return r


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", default="docs/ETAPAS.md")
    ap.add_argument("--repo", help="DONO/REPO (por padrão, o repositório da pasta atual)")
    ap.add_argument("--dry-run", action="store_true", help="não chama o gh; supõe um repositório vazio")
    ap.add_argument("--pausa", type=float, default=1.1, help="segundos entre criações (evita limite do GitHub)")
    a = ap.parse_args()

    fases = ler(a.file)
    erros, avisos = validar(fases)
    for w in avisos:
        print(f"aviso: {w}")
    if erros:
        for e in erros:
            print(f"ERRO: {e}")
        return 1

    gh = GH(a.repo, a.dry_run)
    marca = "[simulação] " if a.dry_run else ""

    # 1. rótulos
    for nome, (cor, desc) in ROTULOS_FIXOS.items():
        print(f"{marca}rótulo  {nome}")
        gh.run("label", "create", nome, "--color", cor, "--description", desc, "--force")
    for i, f in enumerate(fases):
        nome = f"fase:{f.id}"
        print(f"{marca}rótulo  {nome}")
        gh.run("label", "create", nome, "--color", CORES[i % len(CORES)], "--description",
               f"{f.id} · {f.titulo}"[:100], "--force")

    # 2. marcos
    existentes: set[str] = set()
    if not a.dry_run:
        saida = gh.run("api", "repos/{owner}/{repo}/milestones?state=all&per_page=100", "--paginate")
        existentes = {m["title"] for m in json.loads(saida or "[]")} if saida.lstrip().startswith("[") else set()
    for f in fases:
        titulo = f"{f.id} · {f.titulo}"
        if titulo in existentes:
            continue
        print(f"{marca}marco   {titulo}")
        desc = " ".join(filter(None, [f.meta.get("objetivo", ""), f"Entrega: {f.meta['entrega']}" if "entrega" in f.meta else ""]))
        gh.run("api", "repos/{owner}/{repo}/milestones", "-f", f"title={titulo}", "-f", f"description={desc[:900]}")

    # 3. issues
    numeros: dict[str, int] = {}
    estado: dict[str, str] = {}
    rotulos_atuais: dict[str, set[str]] = {}
    if not a.dry_run:
        saida = gh.run("issue", "list", "--state", "all", "--limit", "1000",
                       "--json", "number,title,state,labels")
        for it in json.loads(saida or "[]"):
            if m := TITULO_RE.match(it["title"]):
                if m[1] in numeros:  # duplicata: vale a issue mais antiga
                    print(f"aviso: {m[1]} tem mais de uma issue (#{numeros[m[1]]} e #{it['number']})")
                    if it["number"] > numeros[m[1]]:
                        continue
                numeros[m[1]] = it["number"]
                estado[m[1]] = it["state"]
                rotulos_atuais[m[1]] = {x["name"] for x in it["labels"]}

    criadas = fechadas = reabertas = 0
    for f in fases:
        marco = f"{f.id} · {f.titulo}"
        for t in f.tarefas:
            titulo = f"{t.id} · {t.texto}"
            if len(titulo) > 250:
                titulo = titulo[:247] + "…"
            if t.id not in numeros:
                print(f"{marca}issue   {titulo}")
                args = ["issue", "create", "--title", titulo, "--body-file", "-", "--milestone", marco]
                for r in rotulos_da_tarefa(t):
                    args += ["--label", r]
                url = gh.run(*args, entrada=corpo_issue(t, f, numeros)).strip()
                criadas += 1
                if url:
                    numeros[t.id] = int(url.rstrip("/").rsplit("/", 1)[-1])
                    estado[t.id] = "OPEN"
                    rotulos_atuais[t.id] = set(rotulos_da_tarefa(t))
                    time.sleep(a.pausa)
                if t.status == "feita" and t.id in numeros:
                    gh.run("issue", "close", str(numeros[t.id]), "--reason", "completed")
                    fechadas += 1
                continue

            n = str(numeros[t.id])
            if t.status == "feita" and estado[t.id] == "OPEN":
                print(f"{marca}fechar  #{n} {t.id}")
                gh.run("issue", "close", n, "--reason", "completed")
                fechadas += 1
            elif t.status != "feita" and estado[t.id] == "CLOSED":
                print(f"{marca}reabrir #{n} {t.id}")
                gh.run("issue", "reopen", n)
                reabertas += 1
            # rótulos de estado
            quer = {"em andamento": t.status == "andamento", "bloqueada": t.status == "bloqueada"}
            for nome, deve in quer.items():
                tem = nome in rotulos_atuais.get(t.id, set())
                if deve and not tem:
                    gh.run("issue", "edit", n, "--add-label", nome)
                elif tem and not deve:
                    gh.run("issue", "edit", n, "--remove-label", nome)

    print(f"{marca}pronto: {criadas} criada(s), {fechadas} fechada(s), {reabertas} reaberta(s)")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
