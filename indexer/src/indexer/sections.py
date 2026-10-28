"""I-3 · Árvore de seções (ARQUITETURA §5, tarefa F1.5).

O Docling entrega todos os títulos no nível 1, então a hierarquia vem da numeração do próprio documento:

* numerados ("1.", "1.1", "8.15"): o nível é o número de partes e o pai é o prefixo mais próximo já visto;
* com letra ("(a) produtos e serviços"): filhos da última seção numerada;
* sem marcação ("Segmento bancário"): filhos do último título numerado ou com letra.

A árvore é comparada com o sumário impresso do PDF original (lido com o pypdfium2), só nas seções
cuja página inicial existe no recorte.

Uso (a partir de indexer/):
    uv run --group parse python -m indexer.sections ../data/parsed/ARQUIVO.normalizado.json \\
        --pdf-original ../data/raw/ORIGINAL.pdf --mapa ../data/raw/ARQUIVO_mapa.json --saida ../data/parsed
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

NUMERADA = re.compile(r"^(\d{1,2}(?:\.\d{1,2})*)\.?\s+(\S.*)$")
LETRADA = re.compile(r"^\(([a-zA-Z])\)\s+(\S.*)$")
LINHA_SUMARIO = re.compile(r"^\s*(\d{1,2}(?:\.\d{1,2})*)\.?\s+(.+?)\s*\.{3,}\s*(\d+)\s*$")
# o número impresso é a página física menos 1 (a capa não é numerada), ADR-009
DESLOCAMENTO_PADRAO = 1


def normaliza_titulo(texto: str) -> str:
    """Minúsculas, sem acentos nem pontuação, espaços colapsados: base da comparação de títulos."""
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", sem_acento.lower())).strip()


def construir_arvore(elementos: list[dict]) -> list[dict]:
    """Nós da árvore (lista plana, ordem de leitura) a partir dos elementos `section_header`."""
    nos: list[dict] = []
    por_numero: dict[str, dict] = {}
    ultimo_numerado: dict | None = None
    ultimo_estruturado: dict | None = None  # numerado ou com letra

    for indice, e in enumerate(elementos):
        if e.get("tipo") != "section_header":
            continue
        texto = (e.get("texto") or "").strip()
        if not texto:
            continue
        m_num, m_let = NUMERADA.match(texto), LETRADA.match(texto)

        if m_num:
            numero, titulo = m_num.group(1), m_num.group(2).strip()
            partes = numero.split(".")
            pai = next(
                (
                    por_numero[".".join(partes[:i])]
                    for i in range(len(partes) - 1, 0, -1)
                    if ".".join(partes[:i]) in por_numero
                ),
                None,
            )
            tipo, nivel = "numerada", len(partes)
        elif m_let:
            numero, titulo = f"({m_let.group(1).lower()})", m_let.group(2).strip()
            pai = ultimo_numerado
            tipo, nivel = "letra", (ultimo_numerado["nivel"] + 1 if ultimo_numerado else 2)
        else:
            numero, titulo = None, texto
            pai = ultimo_estruturado
            tipo, nivel = "sem_marca", (ultimo_estruturado["nivel"] + 1 if ultimo_estruturado else 1)

        paginas = e.get("paginas_originais") or e.get("paginas_recorte") or []
        no = {
            "id": f"s{len(nos) + 1}",
            "tipo": tipo,
            "numero": numero,
            "titulo": titulo,
            "nivel": nivel,
            "pai": pai["id"] if pai else None,
            "indice_inicio": indice,
            "pagina_inicio": paginas[0] if paginas else None,
        }
        nos.append(no)
        if tipo == "numerada":
            por_numero[numero] = no
            ultimo_numerado = no
            ultimo_estruturado = no
        elif tipo == "letra":
            ultimo_estruturado = no

    # fim de cada seção: antes do primeiro título que não é seu descendente na árvore
    por_id = {n["id"]: n for n in nos}

    def ancestrais(no: dict) -> set[str]:
        achados: set[str] = set()
        atual = por_id.get(no["pai"]) if no["pai"] else None
        while atual:
            achados.add(atual["id"])
            atual = por_id.get(atual["pai"]) if atual["pai"] else None
        return achados

    cadeias = {n["id"]: ancestrais(n) for n in nos}
    for i, no in enumerate(nos):
        fim = next(
            (o["indice_inicio"] for o in nos[i + 1 :] if no["id"] not in cadeias[o["id"]]),
            len(elementos),
        )
        no["indice_fim"] = fim - 1
        paginas = [
            p for e in elementos[no["indice_inicio"] : fim] for p in (e.get("paginas_originais") or [])
        ]
        no["pagina_fim"] = max(paginas) if paginas else no["pagina_inicio"]

    for no in nos:
        cadeia, atual = [], no
        while atual:
            cadeia.append(atual["titulo"])
            atual = por_id.get(atual["pai"]) if atual["pai"] else None
        no["caminho"] = list(reversed(cadeia))
    return nos


def entradas_do_sumario(texto: str) -> list[dict]:
    """Entradas "1.1 Título ..... 5" de um texto de sumário (numeração impressa)."""
    saida = []
    for linha in texto.splitlines():
        m = LINHA_SUMARIO.match(linha)
        if m:
            titulo = re.sub(r"\s+", " ", m.group(2)).strip()
            saida.append({"numero": m.group(1), "titulo": titulo, "pagina_impressa": int(m.group(3))})
    return saida


def ler_sumario_pdf(pdf: Path, primeira: int = 3, ultima: int = 10) -> list[dict]:
    """Lê o sumário impresso do PDF (páginas físicas `primeira` a `ultima`) com o pypdfium2."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf))
    entradas: list[dict] = []
    for i in range(primeira - 1, min(ultima, len(doc))):
        texto = doc[i].get_textpage().get_text_range()
        achadas = entradas_do_sumario(texto)
        if not achadas and entradas:
            break
        entradas += achadas
    return entradas


def comparar_com_sumario(
    nos: list[dict],
    sumario: list[dict],
    paginas_presentes: set[int],
    deslocamento: int = DESLOCAMENTO_PADRAO,
) -> dict:
    """Compara a árvore com as entradas do sumário cuja página inicial está entre as páginas presentes."""
    numeradas = {n["numero"]: n for n in nos if n["tipo"] == "numerada"}
    presentes = [s for s in sumario if s["pagina_impressa"] + deslocamento in paginas_presentes]

    detalhe, batem = [], 0
    for s in presentes:
        no = numeradas.get(s["numero"])
        achou = no is not None
        titulo_ok = achou and normaliza_titulo(no["titulo"]) == normaliza_titulo(s["titulo"])
        pagina_ok = achou and no["pagina_inicio"] == s["pagina_impressa"] + deslocamento
        ok = bool(achou and titulo_ok and pagina_ok)
        batem += ok
        detalhe.append(
            {
                "numero": s["numero"],
                "titulo_sumario": s["titulo"],
                "pagina_fisica_esperada": s["pagina_impressa"] + deslocamento,
                "encontrada": achou,
                "titulo_ok": bool(titulo_ok),
                "pagina_ok": bool(pagina_ok),
                "titulo_arvore": no["titulo"] if no else None,
                "pagina_arvore": no["pagina_inicio"] if no else None,
                "ok": ok,
            }
        )

    chaves_sumario = {s["numero"] for s in sumario}
    extras = [
        {"numero": n["numero"], "titulo": n["titulo"], "pagina": n["pagina_inicio"]}
        for n in nos
        if n["tipo"] == "numerada" and n["numero"] not in chaves_sumario
    ]
    return {
        "entradas_no_sumario": len(sumario),
        "entradas_presentes_no_recorte": len(presentes),
        "encontradas": sum(d["encontrada"] for d in detalhe),
        "titulo_ok": sum(d["titulo_ok"] for d in detalhe),
        "pagina_ok": sum(d["pagina_ok"] for d in detalhe),
        "batem": batem,
        "taxa": round(batem / len(presentes), 4) if presentes else None,
        "secoes_numeradas_fora_do_sumario": extras,
        "divergencias": [d for d in detalhe if not d["ok"]],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("normalizado", type=Path)
    ap.add_argument("--pdf-original", type=Path, required=True)
    ap.add_argument("--mapa", type=Path, required=True)
    ap.add_argument("--saida", type=Path, required=True)
    a = ap.parse_args()

    elementos = json.loads(a.normalizado.read_text(encoding="utf-8"))["elementos"]
    mapa = json.loads(a.mapa.read_text(encoding="utf-8"))["mapa"]
    presentes = {m["original_fisica"] for m in mapa}

    nos = construir_arvore(elementos)
    sumario = ler_sumario_pdf(a.pdf_original)
    comparacao = comparar_com_sumario(nos, sumario, presentes)

    nome = a.normalizado.name.removesuffix(".normalizado.json")
    a.saida.mkdir(parents=True, exist_ok=True)
    (a.saida / f"{nome}.secoes.json").write_text(
        json.dumps(
            {"arvore": nos, "sumario_pdf": sumario, "comparacao": comparacao}, ensure_ascii=False, indent=1
        ),
        encoding="utf-8",
    )
    resumo = {
        k: v for k, v in comparacao.items() if k not in ("divergencias", "secoes_numeradas_fora_do_sumario")
    }
    resumo["nos"] = len(nos)
    resumo["por_tipo"] = {
        t: sum(1 for n in nos if n["tipo"] == t) for t in ("numerada", "letra", "sem_marca")
    }
    resumo["divergencias"] = len(comparacao["divergencias"])
    print(json.dumps(resumo, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
