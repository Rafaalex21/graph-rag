# ruff: noqa: E501  (módulo de relatório: as linhas longas são texto de tabela em Markdown)
"""Congelamento da v1 (F9.5, `eval/f95-medida-congelamento.md`): auditoria de rede, reprodutibilidade e `v1.md`, sem LLM.

Subcomandos (a partir de `indexer/`):
    uv run python -m indexer.f95 rede                    # RNF-1 (a): auditoria do código -> eval/resultados/f95-rede.json
    uv run python -m indexer.f95 repro [--gravar]        # RNF-7: YAML x lock, hashes dos prompts (--gravar põe o bloco no lock)
    uv run python -m indexer.f95 repro --tag v1.0.0      # RNF-7 (d): os hashes do lock são os dos arquivos no commit da tag
    uv run python -m indexer.f95 v1                      # eval/resultados/v1.md a partir dos relatórios
As regras de veredito estão no documento da medida, escritas antes de rodar; aqui só se aplicam.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from .tabela import CABECALHO_V1, CATEGORIAS, _linha_v1, num, seg

# arquivos que contêm prompts (do agente, das ferramentas, da extração, dos resumos e do juiz) e a configuração dos perfis
ARQUIVOS_DE_PROMPT = [
    "api/src/agente/agente.ts",
    "api/src/agente/atualizador.ts",
    "api/src/agente/roteador.ts",
    "api/src/agente/critico.ts",
    "api/src/agente/redator.ts",
    "api/src/ferramentas/busca.ts",
    "api/src/ferramentas/consultar.ts",
    "api/src/ferramentas/panorama.ts",
    "api/src/artefatos/gerador.ts",
    "api/src/llm/perfis.ts",
    "indexer/src/indexer/extrair.py",
    "indexer/src/indexer/extracao_aberta.py",
    "indexer/src/indexer/resumos.py",
    "indexer/src/indexer/relatorios.py",
    "indexer/src/indexer/text2cypher.py",
    "indexer/src/indexer/reescrita.py",
    "indexer/src/indexer/ask.py",
    "indexer/src/indexer/busca_global.py",
    "indexer/src/indexer/metricas.py",
    "contracts/extraction.schema.json",
    "contracts/open_extraction.schema.json",
    "infra/llama-swap.yaml",
]
FORA_DA_V1 = {
    "Qwen3-Embedding-4B-Q8_0.gguf",
    "embeddinggemma-2-Q8_0.gguf",
    "bge-m3-q8_0.gguf",
}  # candidatos do bake-off (F9.3)
LOOPBACK = {"127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"}
CHAVES_DOCUMENTAIS = (
    "$schema",
    "$id",
    "xmlns",
    "externalDocs",
    "license",
    "contact",
    "description",
    "homepage",
    "repository",
)
VRAM_MAX_MB = 15.2 * 1024
RAM_MAX_MB = 28 * 1024


def _raiz(a: argparse.Namespace) -> Path:
    return a.raiz.resolve()


def _sha(dados: bytes) -> str:
    return hashlib.sha256(dados.replace(b"\r\n", b"\n")).hexdigest()  # LF e CRLF dão o mesmo hash


def _ler_lock(p: Path) -> tuple[dict, bool]:
    bruto = p.read_bytes()
    bom = bruto.startswith(b"\xef\xbb\xbf")
    return json.loads(bruto.decode("utf-8-sig")), bom


# ---------------------------------------------------------------- RNF-1 (a): auditoria do código


def rede(raiz: Path) -> dict:
    alvos: list[Path] = []
    for pasta, padroes in (
        ("api/src", ("*.ts",)),
        ("web/src", ("*.html", "*.css", "*.scss", "*.ts", "*.json")),
        ("contracts", ("*.yaml", "*.json")),
    ):
        for pad in padroes:
            alvos += [
                p
                for p in (raiz / pasta).rglob(pad)
                if "node_modules" not in p.parts and "dist" not in p.parts
            ]
    alvos.append(raiz / "infra" / "llama-swap.yaml")
    achados = []
    for p in sorted(set(alvos)):
        for i, linha in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for m in re.finditer(r"https?://[^\s\"'`)>\]]+", linha):
                url = m.group(0)
                host = urlparse(url).hostname or url.split("/")[2]
                if host in LOOPBACK or host in {h.strip("[]") for h in LOOPBACK}:
                    continue
                ini = linha.lstrip()
                documental = ini.startswith(("//", "*", "/*", "#", "<!--")) or any(
                    c in linha for c in CHAVES_DOCUMENTAIS
                )
                achados.append(
                    {
                        "arquivo": str(p.relative_to(raiz)).replace("\\", "/"),
                        "linha": i,
                        "host": host,
                        "url": url,
                        "tipo": "documental" if documental else "candidato",
                        "contexto": linha.strip()[:160],
                    }
                )
    saida = {
        "arquivos_varridos": len(set(alvos)),
        "achados": achados,
        "candidatos": [a for a in achados if a["tipo"] == "candidato"],
        "regra": "candidato = URL fora de loopback que não está em comentário nem em chave documental ($schema, $id, xmlns, externalDocs, license, contact, description, homepage, repository)",
    }
    (raiz / "eval" / "resultados" / "f95-rede.json").write_text(
        json.dumps(saida, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return saida


# ---------------------------------------------------------------- RNF-7: reprodutibilidade


def repro(raiz: Path, gravar: bool, tag: str | None) -> dict:
    lock_p = raiz / "infra" / "models.lock.json"
    lock, bom = _ler_lock(lock_p)
    yaml = (raiz / "infra" / "llama-swap.yaml").read_text(encoding="utf-8")
    no_yaml = set(re.findall(r"-m \$\{modelos\}/([^\s]+\.gguf)", yaml))
    no_lock = {m["arquivo"] for m in lock["modelos"] if m.get("sha256")}
    sem_lock = sorted(no_yaml - no_lock)
    ausentes = [a for a in ARQUIVOS_DE_PROMPT if not (raiz / a).exists()]
    if ausentes:
        raise SystemExit(f"arquivos de prompt que não existem: {ausentes}")
    hashes = {a: _sha((raiz / a).read_bytes()) for a in ARQUIVOS_DE_PROMPT}
    if gravar:
        lock["prompts"] = {
            "_nota": "F9.5: sha256 (fins de linha normalizados para LF) dos arquivos que contêm prompts e a configuração dos perfis; gerado por `uv run python -m indexer.f95 repro --gravar`; a tag v1.0.0 fixa o conteúdo",
            "arquivos": hashes,
        }
        texto = json.dumps(lock, ensure_ascii=False, indent=2) + "\n"
        lock_p.write_bytes((b"\xef\xbb\xbf" if bom else b"") + texto.encode("utf-8"))
    gravados = lock.get("prompts", {}).get("arquivos", {})
    verify_p = raiz / "eval" / "resultados" / "f95-verify.json"
    verify = json.loads(verify_p.read_text(encoding="utf-8-sig")) if verify_p.exists() else None
    saida: dict = {
        "yaml_sem_entrada_no_lock": sem_lock,
        "fora_da_v1_no_yaml": sorted(set(sem_lock) & FORA_DA_V1),
        "yaml_sem_lock_nao_explicado": sorted(set(sem_lock) - FORA_DA_V1),
        "prompts_no_lock": len(gravados),
        "prompts_iguais_ao_arquivo_atual": gravados == hashes and len(gravados) == len(ARQUIVOS_DE_PROMPT),
        "verify_models": verify,
    }
    if tag:

        def na_tag(a: str) -> str | None:
            r = subprocess.run(["git", "show", f"{tag}:{a}"], cwd=raiz, capture_output=True)
            return _sha(r.stdout) if r.returncode == 0 else None

        lock_na_tag = subprocess.run(
            ["git", "show", f"{tag}:infra/models.lock.json"], cwd=raiz, capture_output=True
        )
        gravados_tag = (
            json.loads(lock_na_tag.stdout.decode("utf-8-sig")).get("prompts", {}).get("arquivos", {})
            if lock_na_tag.returncode == 0
            else {}
        )
        divergentes = [a for a in ARQUIVOS_DE_PROMPT if na_tag(a) != gravados_tag.get(a)]
        saida["tag"] = {
            "nome": tag,
            "arquivos_divergentes_do_lock_da_tag": divergentes,
            "ok": not divergentes and len(gravados_tag) == len(ARQUIVOS_DE_PROMPT),
        }
    if not tag:
        (raiz / "eval" / "resultados" / "f95-repro.json").write_text(
            json.dumps(saida, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return saida


# ---------------------------------------------------------------- v1.md


def _json(res: Path, nome: str) -> dict | None:
    p = res / f"{nome}.json"
    return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else None


def _p(v: float | None, casas: int = 2) -> str:
    return "—" if v is None else f"{v:.{casas}f}".replace(".", ",")


def _pct(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    o = sorted(vals)
    return o[min(len(o) - 1, int(-(-p * len(o) // 1)) - 1)]


def _med(vals: list[float]) -> float | None:
    if not vals:
        return None
    o = sorted(vals)
    m = len(o) // 2
    return o[m] if len(o) % 2 else (o[m - 1] + o[m]) / 2


def _metas(res: Path) -> tuple[list[list[str]], list[str]]:
    """Linhas da tabela das metas (meta, limite, medido, veredito) e a lista de desvios."""
    linhas: list[list[str]] = []
    desvios: list[str] = []

    def reg(meta: str, limite: str, medido: str, ok: bool | None, desvio: str) -> None:
        linhas.append(
            [meta, limite, medido, "**atingida**" if ok else ("**desvio**" if ok is False else "não medida")]
        )
        if ok is not True:
            desvios.append(f"**{meta}**: {desvio}")

    # RNF-1
    rede = _json(res, "f95-rede")
    rec = _json(res, "f95-recursos")
    if rede is not None and rec is not None:
        cand = rede["candidatos"]
        conex = rec["conexoes_remotas_fora_de_loopback"]
        ok = not cand and not conex
        reg(
            "RNF-1 Privacidade",
            "nenhuma chamada de rede externa em tempo de consulta",
            f"código: {len(rede['achados'])} URL(s) fora de loopback, {len(cand)} candidata(s) (as demais em comentário ou chave documental); amostras de rede ({rec['amostras']}, a cada {rec['intervalo_s']} s): {len(conex)} endereço(s) remoto(s) fora de loopback",
            ok,
            f"candidatas no código: {', '.join(c['arquivo'] + ':' + str(c['linha']) for c in cand) or 'nenhuma'}; remotos vistos: {', '.join(conex) or 'nenhum'}",
        )
    else:
        reg("RNF-1 Privacidade", "nenhuma chamada de rede externa", "sem relatório", None, "não medida")
    # RNF-2 e RNF-3
    lat = _json(res, "f95-latencia")
    if lat is not None:
        c = [r for r in lat["rnf2"] if r["perfil"] == "consultar"]
        rp = [r for r in lat["rnf2"] if r["perfil"] == "consultar-rapido"]

        def dentro(r: dict) -> bool:
            return (
                r["http"] == 200
                and r["primeiro_token_ms"] is not None
                and r["fim_ms"] is not None
                and r["primeiro_token_ms"] <= 5000
                and r["fim_ms"] <= 20000
                and r["terminou_em"] == "fim"
            )

        n_ok = sum(dentro(r) for r in c)
        tok = [r["primeiro_token_ms"] / 1000 for r in c if r["primeiro_token_ms"] is not None]
        fim = [r["fim_ms"] / 1000 for r in c if r["fim_ms"] is not None]
        so_tok = sum(1 for r in c if r["primeiro_token_ms"] is not None and r["primeiro_token_ms"] <= 5000)
        so_fim = sum(1 for r in c if r["fim_ms"] is not None and r["fim_ms"] <= 20000)
        rap_ok = sum(dentro(r) for r in rp)
        reg(
            "RNF-2 Latência (pergunta simples)",
            "1º token ≤ 5 s e resposta completa ≤ 20 s (regra: ≥ 27 de 30)",
            f"`consultar`: **{n_ok} de {len(c)}** com os dois; 1º token ≤ 5 s em {so_tok}, completa ≤ 20 s em {so_fim}; 1º token p50 {_p(_med(tok), 1)} s e p95 {_p(_pct(tok, 0.95), 1)} s; completa p50 {_p(_med(fim), 1)} s e p95 {_p(_pct(fim, 0.95), 1)} s. Informativo, `consultar-rapido`: {rap_ok} de {len(rp)} com os dois",
            n_ok >= 27,
            f"{n_ok} de {len(c)} perguntas simples com 1º token ≤ 5 s e completa ≤ 20 s (mínimo 27); o redator só escreve depois do ciclo de busca, então o 1º token não sai antes do fim da recuperação",
        )
        t = lat["rnf3"]
        ate90 = sum(1 for r in t if r["fim_ms"] is not None and r["fim_ms"] <= 90_000)
        prog = sum(1 for r in t if r["etapas_antes_do_token"] >= 3)
        fim3 = [r["fim_ms"] / 1000 for r in t if r["fim_ms"] is not None]
        reg(
            "RNF-3 Latência (busca global)",
            "≤ 90 s, com progresso transmitido (regra: 10 de 10 e ≥ 3 etapas antes do 1º token)",
            f"{ate90} de {len(t)} em ≤ 90 s (p50 {_p(_med(fim3), 1)} s, máx. {_p(max(fim3) if fim3 else None, 1)} s); progresso (≥ 3 eventos `etapa` antes do 1º token) em {prog} de {len(t)}",
            ate90 == len(t) == prog and len(t) == 10,
            f"{ate90} de {len(t)} em ≤ 90 s; progresso em {prog} de {len(t)}",
        )
    else:
        reg(
            "RNF-2 Latência (pergunta simples)",
            "1º token ≤ 5 s e completa ≤ 20 s",
            "sem relatório",
            None,
            "não medida",
        )
        reg("RNF-3 Latência (busca global)", "≤ 90 s", "sem relatório", None, "não medida")
    # RNF-4 e RNF-5
    a6, a6n = _json(res, "f94r3-a6"), _json(res, "f94r3n-a6")
    a3, a3n = _json(res, "v1-a3"), _json(res, "v1n-a3")
    a1 = _json(res, "v1-a1")
    if a6 and a6n:
        f60, f24 = a6["geral"]["fidelidade"]["media"], a6n["geral"]["fidelidade"]["media"]
        reg(
            "RNF-4 Fidelidade",
            "≥ 0,90 no golden set (nas 60 e nas 24)",
            f"60: {_p(f60)}; 24: {_p(f24)}",
            f60 >= 0.90 and f24 >= 0.90,
            f"60: {_p(f60)}; 24: {_p(f24)}",
        )
    if a6 and a6n and a3 and a3n:
        c60, c24 = a6["geral"]["correcao"]["media"], a6n["geral"]["correcao"]["media"]
        b60, b24 = a3["geral"]["correcao"]["media"], a3n["geral"]["correcao"]["media"]
        i1 = a1["geral"]["correcao"]["media"] if a1 else None
        ok = c60 >= 0.70 and c24 >= 0.70 and c60 - b60 >= 0.15 and c24 - b24 >= 0.15
        reg(
            "RNF-5 Correção",
            "≥ 0,70 e ≥ +15 p.p. sobre a linha de base vetorial (A3), nas 60 e nas 24",
            f"60: A6 {_p(c60)} contra A3 {_p(b60)} ({_p((c60 - b60) * 100, 0)} p.p.; contra o A1 ingênuo {_p(i1)}); 24: A6 {_p(c24)} contra A3 {_p(b24)} ({_p((c24 - b24) * 100, 0)} p.p.)",
            ok,
            f"60: {_p(c60)} (A3 {_p(b60)}); 24: {_p(c24)} (A3 {_p(b24)})",
        )
    # RNF-6
    r60, r24 = _json(res, "f95-redator"), _json(res, "f95n-redator")
    if r60 and r24:
        c60, c24 = r60["citacao"], r24["citacao"]
        ok = (
            c60["sem_citacao"] == 0
            and c24["sem_citacao"] == 0
            and c60["afirmacoes_numericas"] > 0
            and c24["afirmacoes_numericas"] > 0
        )
        reg(
            "RNF-6 Rastreabilidade",
            "100% das afirmações numéricas com página de origem",
            f"60: {c60['citadas']} de {c60['afirmacoes_numericas']} ({_p(c60['percentual'])}%); 24: {c24['citadas']} de {c24['afirmacoes_numericas']} ({_p(c24['percentual'])}%); a régua mede se há citação válida, não se ela sustenta a frase",
            ok,
            f"frases numéricas sem citação: 60: {c60['sem_citacao']} ({', '.join(c60['respostas_com_frase_sem_citacao']) or 'nenhuma resposta'}); 24: {c24['sem_citacao']} ({', '.join(c24['respostas_com_frase_sem_citacao']) or 'nenhuma resposta'})",
        )
    else:
        reg(
            "RNF-6 Rastreabilidade",
            "100% das afirmações numéricas com página",
            "sem relatório",
            None,
            "não medida",
        )
    # RNF-7
    rp = _json(res, "f95-repro")
    if rp:
        v = rp.get("verify_models") or {}
        a = v.get("exit_code") == 0
        b = not rp["yaml_sem_lock_nao_explicado"]
        cc = rp["prompts_iguais_ao_arquivo_atual"]
        reg(
            "RNF-7 Reprodutibilidade",
            "versões de modelos, quantizações e prompts fixadas no `models.lock.json`",
            f"(a) `verify_models.ps1` sai com {v.get('exit_code', '—')}; (b) modelos do YAML sem entrada no lock: {len(rp['yaml_sem_entrada_no_lock'])}, dos quais fora da v1 (bake-off da F9.3): {len(rp['fora_da_v1_no_yaml'])}, sem explicação: {len(rp['yaml_sem_lock_nao_explicado'])}; (c) {rp['prompts_no_lock']} arquivos de prompt com sha256 no lock, iguais aos atuais: {'sim' if cc else 'não'}; (d) o commit da tag tem esses mesmos hashes: conferido depois da tag (`uv run python -m indexer.f95 repro --tag v1.0.0`)",
            a and b and cc,
            f"verify_models {v.get('exit_code')}; YAML sem explicação: {rp['yaml_sem_lock_nao_explicado']}; prompts iguais: {cc}",
        )
    else:
        reg(
            "RNF-7 Reprodutibilidade",
            "versões e prompts fixados no lock",
            "sem relatório",
            None,
            "não medida",
        )
    # RNF-8
    if rec:
        v, r = rec["vram_pico_mb"], rec["ram_usada_pico_mb"]
        f92 = _json(res, "f92-vram") or {}
        gem = (f92.get("gemma") or {}).get("completa_pico_mb")
        reg(
            "RNF-8 Orçamento de memória",
            "pico de VRAM ≤ 15,2 GB e de RAM ≤ 28 GB",
            f"na rodada da API (`consultar` e `consultar-rapido`, Neo4j no ar): VRAM {_p(v / 1024)} GB (primeira amostra, antes dos modelos: {_p((rec['vram_primeira_mb'] or 0) / 1024)} GB), RAM usada {_p(r / 1024)} GB (primeira: {_p(rec['ram_usada_primeira_mb'] / 1024)} GB). O perfil `avaliar` (F9.2): VRAM {_p((gem or 0) / 1024)} GB",
            v <= VRAM_MAX_MB and r <= RAM_MAX_MB,
            f"VRAM {_p(v / 1024)} GB (limite 15,2) e RAM {_p(r / 1024)} GB (limite 28)",
        )
    else:
        reg("RNF-8 Orçamento de memória", "VRAM ≤ 15,2 GB e RAM ≤ 28 GB", "sem relatório", None, "não medida")
    return linhas, desvios


def v1(raiz: Path) -> str:
    res = raiz / "eval" / "resultados"
    linhas = [
        ("A0", "v1-a0", "LLM sem recuperação (de memória)"),
        ("A1", "v1-a1", "Vetor ingênuo: 6 Filhos"),
        ("A2", "v1-a2", "+ full-text (híbrido RRF): 6 Filhos"),
        ("A3", "v1-a3", "+ Pai e reranker (24 Pais → 6)"),
        (
            "A3ts",
            "f95-a3ts",
            "controle: só `buscar_trechos` pelo pipeline do agente em TypeScript e o redator (refeito na F9.5)",
        ),
        ("A4", "f95-a4", "+ templates de fatos e Text2Cypher (`consultar_grafo`) (refeito na F9.5)"),
        ("A5", "f95-a5", "+ busca local (`entidade`) e global (`panorama`) (refeito na F9.5)"),
        ("A6", "f94r3-a6", "agente completo: 12 ferramentas e crítico (até 2 rodadas); é a r3 da F9.4"),
    ]
    rels = {r: _json(res, n) for r, n, _ in linhas}
    antigos = {r: _json(res, f"v1-{r.lower()}") for r in ("A3ts", "A4", "A5", "A6")}
    novas = [
        ("A3", "v1n-a3", "Pai e reranker"),
        ("A6", "f94r3n-a6", "agente completo com crítico (r3 da F9.4)"),
    ]
    relnovas = {r: _json(res, n) for r, n, _ in novas}
    pres = [(r, rels[r], d) for r, _, d in linhas if rels[r] is not None]
    faltam = [r for r, _, _ in linhas if rels[r] is None]
    metas, desvios = _metas(res)
    lock, _ = _ler_lock(raiz / "infra" / "models.lock.json")
    por_cat = [
        "| Degrau | " + " | ".join(r for _, r in CATEGORIAS) + " |",
        "|---|" + "---:|" * len(CATEGORIAS),
    ]
    for r, rel, _ in pres:
        por_cat.append(
            f"| **{r}** | "
            + " | ".join(num(rel["por_categoria"][c]["correcao"]) for c, _ in CATEGORIAS)
            + " |"
        )
    comp = [
        "| Degrau | Correção F9.1 | Correção agora | Acerto numérico F9.1 | Acerto numérico agora | Latência p50 / p95 agora (s) |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for r in ("A3ts", "A4", "A5", "A6"):
        a, n = antigos[r], rels[r]
        if a and n:
            m = n["mecanicas"]["geral"]
            comp.append(
                f"| **{r}** | {num(a['geral']['correcao'])} | {num(n['geral']['correcao'])} | {num(a['mecanicas']['geral']['acerto_numerico'])} | {num(m['acerto_numerico'])} | {seg(m['latencia_s']['p50'])} / {seg(m['latencia_s']['p95'])} |"
            )
    saida = [
        "# v1: escada de ablações final e metas da §1.3",
        "",
        "Gerado por `uv run python -m indexer.f95 v1` (sem LLM) a partir dos relatórios em `eval/resultados/`. Definições, regras de veredito e limites em [`eval/f95-medida-congelamento.md`](../f95-medida-congelamento.md), fixadas antes de rodar. **O código do produto é o do commit `5a5266d`** (F9.4); esta etapa só acrescentou ferramentas de medida. Golden set de 60 perguntas (`eval/golden.csv`) no documento inteiro; juiz Gemma 4 26B-A4B ([ADR-028](../../docs/adr/ADR-028-metricas-com-juiz-local.md)); métricas mecânicas do [ADR-029](../../docs/adr/ADR-029-metricas-mecanicas.md). Uma execução por degrau; **diferença menor que 0,05 vale como empate** (3 perguntas).",
        "",
        "## Escada final (60 perguntas)",
        "",
        CABECALHO_V1,
        *[_linha_v1(r, rel, "geral") for r, rel, _ in pres],
        "",
        *[f"- **{r}**: {d}" for r, _, d in pres],
        *([f"- Degraus sem relatório: {', '.join(faltam)}."] if faltam else []),
        "",
        "A0 a A3 são as execuções da F9.1 (Python; índice e embeddings sem mudança). A3ts, A4 e A5 foram **refeitos na F9.5 com o redator da F9.4**; o A6 é a r3 da F9.4. A latência de A0 a A3 é a do `ask` em Python; a de A3ts a A6 inclui atualizador, roteador, redator e, no A6, o crítico: comparar as duas famílias é indicativo.",
        "",
        "### O que o redator novo mudou nos degraus refeitos (F9.1 contra F9.5)",
        "",
        *comp,
        "",
        "## Correção por categoria (60 perguntas)",
        "",
        *por_cat,
        "",
        "## Grupo novo (24 perguntas de `eval/golden_novas.csv`, fora do ajuste; só A3 e A6)",
        "",
        CABECALHO_V1,
        *[_linha_v1(r, rel, "geral") for r, _, _ in novas if (rel := relnovas[r]) is not None],
        "",
        "## Metas da §1.3 (ARQUITETURA)",
        "",
        "| Meta | Limite | Medido | Veredito |",
        "|---|---|---|---|",
        *[f"| {a} | {b} | {c} | {d} |" for a, b, c, d in metas],
        "",
        "### Desvios (explicados no [ADR-082](../../docs/adr/ADR-082-congelamento-da-v1.md))",
        "",
        *([f"- {d}" for d in desvios] or ["- nenhum"]),
        "",
        "## Ressalvas",
        "",
        "- **Golden e rótulos do juiz são do Claude** (ADR-027, ADR-030); o Gemma é juiz de respostas do Qwen; só a correção foi calibrada (95% de concordância em 20).",
        "- **O A6 é uma execução** (a r3 da F9.4, depois de três rodadas de correção, todas contadas) e a variância do Qwen a 0,2 e do juiz **não foi medida**; o resultado nas 60 é otimista (conjunto em que as falhas foram lidas), o grupo novo (24, categorias de 3 a 6 perguntas) é a checagem.",
        "- **Latência** depende desta máquina (RX 9070 16 GB, 32 GB de RAM, Windows) e do cache de prompt do servidor; uma execução, sem intervalo de confiança.",
        "- **A amostragem de rede (RNF-1) não prova ausência** de conexão (uma conexão curta pode escapar dos 2 s).",
        "- **Dívida aberta da F9.3:** o reranker com `-c 4096` devolve HTTP 500 em ~1,3% das chamadas.",
        "",
        "## Versões congeladas",
        "",
        f"- llama.cpp `{lock['llama_cpp']['versao']}` (builds Vulkan e HIP); llama-swap `{lock['llama_swap']['versao']}`; Neo4j `{lock['neo4j']['versao']}` ({lock['neo4j']['edicao']}) com APOC e GDS.",
        *[
            f"- {m['papel']}: `{m['arquivo']}` ({m['quantizacao']}), sha256 `{m['sha256'][:12]}…`"
            for m in lock["modelos"]
        ],
        f"- Prompts: {len(lock.get('prompts', {}).get('arquivos', {}))} arquivos com sha256 no bloco `prompts` de `infra/models.lock.json`.",
        "",
        "Regerar: `uv run python -m indexer.f95 v1` (a partir de `indexer/`, sem LLM).",
        "",
    ]
    return "\n".join(saida)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("comando", choices=["rede", "repro", "v1"])
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--gravar", action="store_true")
    ap.add_argument("--tag")
    a = ap.parse_args()
    raiz = _raiz(a)
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    if a.comando == "rede":
        print(json.dumps(rede(raiz), ensure_ascii=False, indent=2))
    elif a.comando == "repro":
        print(json.dumps(repro(raiz, a.gravar, a.tag), ensure_ascii=False, indent=2))
    else:
        texto = v1(raiz)
        (raiz / "eval" / "resultados" / "v1.md").write_text(texto, encoding="utf-8")
        print(texto)


if __name__ == "__main__":
    main()
