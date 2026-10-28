"""I-2 · Normalização do DoclingDocument (ARQUITETURA §5, tarefa F1.4).

Trabalha sobre o JSON do Docling já carregado em dict, sem importar o Docling, e produz uma lista de
elementos na ordem de leitura:

* remove cabeçalhos e rodapés de página (rótulos do Docling) e qualquer linha curta cujo texto,
  com os números trocados por `#`, apareça em mais de 30% das páginas (por exemplo o número da página
  que o Docling rotulou como `text`);
* remove figuras decorativas (ícones e logotipos de mesmo tamanho e altura em mais de 30% das páginas do
  mesmo formato), que no topo da página seriam atribuídas à seção anterior;
* associa as notas (`footnote` ou parágrafos que começam com `(n)`) à tabela ou à figura que as precede.

Uso (a partir de indexer/):
    uv run python -m indexer.normalize ../data/parsed/ARQUIVO.docling.json \\
        --mapa ../data/raw/ARQUIVO_mapa.json --saida ../data/parsed
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

LIMIAR_PADRAO = 0.30
TAMANHO_MAXIMO_REPETIDA = 120  # só linhas curtas entram na regra das repetidas
# a linha também precisa aparecer em ao menos 3 páginas (evita falso positivo em documentos minúsculos)
MINIMO_PAGINAS = 3
ROTULOS_ESTRUTURAIS = {"page_header", "page_footer"}
PADRAO_NOTA = re.compile(r"^\(\d{1,2}\)\s")
PADRAO_ROTULO_NOTAS = re.compile(r"^notas?\s*:?\s*$", re.IGNORECASE)
COLECOES_ANCORA = {"tables", "pictures"}


def _resolve(doc: dict, ref: str) -> tuple[str, dict]:
    _, colecao, indice = ref.split("/")
    return colecao, doc[colecao][int(indice)]


def ordem_de_leitura(doc: dict) -> list[tuple[str, dict]]:
    """Itens (coleção, item) na ordem de leitura, percorrendo a árvore `body` (grupos são atravessados)."""
    saida: list[tuple[str, dict]] = []

    def anda(no: dict) -> None:
        for filho in no.get("children", []):
            colecao, item = _resolve(doc, filho["$ref"])
            if colecao != "groups":
                saida.append((colecao, item))
            anda(item)

    anda(doc["body"])
    return saida


def chave_de_repeticao(texto: str) -> str:
    """Texto minúsculo, sem espaços repetidos e com cada sequência de dígitos trocada por `#`."""
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", texto.lower())).strip()


def paginas_do_item(item: dict) -> list[int]:
    return sorted({p["page_no"] for p in item.get("prov", [])})


def _eh_nota(colecao: str, item: dict) -> bool:
    if colecao != "texts":
        return False
    texto = (item.get("text") or "").strip()
    return item.get("label") == "footnote" or (
        item.get("label") in ("text", "list_item") and bool(PADRAO_NOTA.match(texto))
    )


def linhas_repetidas(elementos: list[dict], total_paginas: int, limiar: float = LIMIAR_PADRAO) -> list[dict]:
    """Linhas de texto (com números normalizados) presentes em mais de `limiar` das páginas."""
    paginas: dict[str, set[int]] = defaultdict(set)
    exemplo: dict[str, str] = {}
    for e in elementos:
        textos = [e.get("texto") or ""] + [n["texto"] for n in e.get("notas", [])]
        for t in textos:
            chave = chave_de_repeticao(t)
            if chave:
                paginas[chave].update(e["paginas_recorte"])
                exemplo.setdefault(chave, t)
    return sorted(
        (
            {"linha": exemplo[k], "chave": k, "paginas": len(v)}
            for k, v in paginas.items()
            if len(v) > limiar * total_paginas and len(v) >= MINIMO_PAGINAS
        ),
        key=lambda x: -x["paginas"],
    )


def _chave_de_tamanho_pagina(doc: dict, pagina: int) -> tuple[int, int]:
    tamanho = doc.get("pages", {}).get(str(pagina), {}).get("size", {})
    return round(tamanho.get("width", 0)), round(tamanho.get("height", 0))


def figuras_decorativas(doc: dict, limiar: float = LIMIAR_PADRAO) -> set[str]:
    """`self_ref` das figuras com mesmo tamanho e mesma altura na página (arredondados a 5 pt; o eixo x é
    ignorado porque o ícone muda de lado entre seções) em mais de `limiar` das páginas do mesmo formato
    (e em pelo menos MINIMO_PAGINAS): ícones e logotipos de página."""
    paginas_por_formato: dict[tuple[int, int], int] = defaultdict(int)
    for numero in doc.get("pages", {}):
        paginas_por_formato[_chave_de_tamanho_pagina(doc, int(numero))] += 1

    paginas_por_chave: dict[tuple, set[int]] = defaultdict(set)
    chaves: dict[str, tuple] = {}
    for figura in doc.get("pictures", []):
        if not figura.get("prov"):
            continue
        prov = figura["prov"][0]
        b = prov["bbox"]
        formato = _chave_de_tamanho_pagina(doc, prov["page_no"])
        chave = (
            formato,
            round(abs(b["r"] - b["l"]) / 5),
            round(abs(b["t"] - b["b"]) / 5),
            round(max(b["t"], b["b"]) / 5),
        )
        chaves[figura["self_ref"]] = chave
        paginas_por_chave[chave].add(prov["page_no"])

    return {
        ref
        for ref, chave in chaves.items()
        if len(paginas_por_chave[chave]) > limiar * paginas_por_formato[chave[0]]
        and len(paginas_por_chave[chave]) >= MINIMO_PAGINAS
    }


def normalizar(doc: dict, mapa_paginas: dict[int, int] | None = None, limiar: float = LIMIAR_PADRAO) -> dict:
    """Devolve {'elementos': [...], 'estatisticas': {...}} a partir do DoclingDocument em dict."""
    total_paginas = len(doc.get("pages", {}))
    itens = ordem_de_leitura(doc)

    # 1) linhas curtas repetidas em mais de `limiar` das páginas (texto livre, fora dos rótulos estruturais)
    paginas_por_chave: dict[str, set[int]] = defaultdict(set)
    for colecao, item in itens:
        texto = (item.get("text") or "").strip()
        if colecao == "texts" and texto and len(texto) <= TAMANHO_MAXIMO_REPETIDA:
            paginas_por_chave[chave_de_repeticao(texto)].update(paginas_do_item(item))
    repetidas = {
        k
        for k, v in paginas_por_chave.items()
        if len(v) > limiar * total_paginas and len(v) >= MINIMO_PAGINAS
    }

    decorativas = figuras_decorativas(doc, limiar)
    removidos = {
        "rotulo_cabecalho_rodape": 0,
        "regra_das_repetidas": 0,
        "figura_decorativa_repetida": 0,
        "rotulo_notas": 0,
    }
    elementos: list[dict] = []
    # última tabela/figura, enquanto só houver notas (ou o rótulo "Notas:") depois dela
    ancora: dict | None = None
    notas_associadas = 0
    notas_orfas = 0

    def converte(colecao: str, item: dict) -> dict:
        paginas = paginas_do_item(item)
        e = {
            "id": item["self_ref"],
            "tipo": item.get("label") or colecao.rstrip("s"),
            "texto": (item.get("text") or None),
            "paginas_recorte": paginas,
            "paginas_originais": [mapa_paginas.get(p, p) for p in paginas] if mapa_paginas else paginas,
        }
        if item.get("level") is not None and item.get("label") == "section_header":
            e["nivel"] = item["level"]
        return e

    for colecao, item in itens:
        texto = (item.get("text") or "").strip()
        rotulo = item.get("label")

        if colecao == "pictures" and item.get("self_ref") in decorativas:
            removidos["figura_decorativa_repetida"] += 1
            continue
        if colecao == "texts" and rotulo in ROTULOS_ESTRUTURAIS:
            removidos["rotulo_cabecalho_rodape"] += 1
            continue
        curta = len(texto) <= TAMANHO_MAXIMO_REPETIDA
        if colecao == "texts" and texto and curta and chave_de_repeticao(texto) in repetidas:
            removidos["regra_das_repetidas"] += 1
            continue

        eh_rotulo_notas = rotulo == "text" and bool(PADRAO_ROTULO_NOTAS.match(texto))
        if colecao == "texts" and eh_rotulo_notas and ancora is not None:
            removidos["rotulo_notas"] += 1  # "Notas:" logo depois da tabela: o rótulo não carrega informação
            continue

        if _eh_nota(colecao, item):
            e = converte(colecao, item)
            if ancora is not None:
                ancora.setdefault("notas", []).append(e)
                notas_associadas += 1
            else:
                e["nota_sem_ancora"] = True
                elementos.append(e)
                notas_orfas += 1
            continue

        e = converte(colecao, item)
        elementos.append(e)
        ancora = e if colecao in COLECOES_ANCORA else None

    estat = {
        "paginas": total_paginas,
        "itens_lidos": len(itens),
        "elementos": len(elementos),
        "removidos": removidos,
        "linhas_repetidas_antes": len(repetidas),
        "notas_associadas": notas_associadas,
        "notas_sem_ancora": notas_orfas,
        "tabelas": sum(1 for e in elementos if e["tipo"] == "table"),
        "limiar": limiar,
    }
    estat["linhas_repetidas_depois"] = len(linhas_repetidas(elementos, total_paginas, limiar))
    return {"elementos": elementos, "estatisticas": estat}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("docling_json", type=Path)
    ap.add_argument("--mapa", type=Path, help="mapa recorte -> página física do original (ADR-009)")
    ap.add_argument("--saida", type=Path, required=True)
    ap.add_argument("--limiar", type=float, default=LIMIAR_PADRAO)
    a = ap.parse_args()

    doc = json.loads(a.docling_json.read_text(encoding="utf-8"))
    mapa = None
    if a.mapa:
        m = json.loads(a.mapa.read_text(encoding="utf-8"))["mapa"]
        mapa = {x["recorte"]: x["original_fisica"] for x in m}

    resultado = normalizar(doc, mapa, a.limiar)
    resultado["origem"] = a.docling_json.name
    a.saida.mkdir(parents=True, exist_ok=True)
    nome = a.docling_json.name.removesuffix(".docling.json")
    (a.saida / f"{nome}.normalizado.json").write_text(
        json.dumps(resultado, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(json.dumps(resultado["estatisticas"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
