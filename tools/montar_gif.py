"""Monta o GIF de demonstração do README (F10.1) a partir dos quadros de `e2e/tests/ao-vivo/demo.spec.ts`.

Quadros a cada 500 ms em `data/demo/quadros/`; o GIF toca cada quadro por `--ms` (padrão 160 ms, ~3x mais rápido que o real),
com uma faixa no rodapé que diz que está acelerado e de onde vem o documento. Quadros repetidos em sequência viram um só, com
a duração somada. Grava `docs/img/demo.gif` e avisa se passar de 10 MB.

    uv run --project indexer python tools/montar_gif.py [--largura 960] [--ms 160]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

RAIZ = Path(__file__).resolve().parent.parent
FONTE = "Banco do Brasil S.A., Formulário de Referência 2026 (v7, CVM)  ·  modelos locais, sem rede  ·  acelerado ~3×"


def faixa(img: Image.Image, texto: str) -> Image.Image:
    a = 26
    nova = Image.new("RGB", (img.width, img.height + a), (19, 26, 37))
    nova.paste(img, (0, 0))
    d = ImageDraw.Draw(nova)
    try:
        f = ImageFont.truetype("segoeui.ttf", 14)
    except OSError:
        f = ImageFont.load_default()
    d.text((10, img.height + 5), texto, fill=(229, 233, 241), font=f)
    return nova


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quadros", type=Path, default=RAIZ / "data" / "demo" / "quadros")
    ap.add_argument("--saida", type=Path, default=RAIZ / "docs" / "img" / "demo.gif")
    ap.add_argument("--largura", type=int, default=960)
    ap.add_argument("--ms", type=int, default=160)
    a = ap.parse_args()
    arquivos = sorted(a.quadros.glob("*.png"))
    if not arquivos:
        raise SystemExit(f"sem quadros em {a.quadros}")
    quadros: list[Image.Image] = []
    duracoes: list[int] = []
    anterior: Image.Image | None = None
    for p in arquivos:
        img = Image.open(p).convert("RGB")
        img = img.resize((a.largura, round(img.height * a.largura / img.width)), Image.LANCZOS)
        if anterior is not None and ImageChops.difference(img, anterior).getbbox() is None:
            duracoes[-1] += a.ms
            continue
        anterior = img
        quadros.append(faixa(img, FONTE).quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
        duracoes.append(a.ms)
    duracoes[-1] = max(duracoes[-1], 3000)  # segura o último quadro antes de repetir
    a.saida.parent.mkdir(parents=True, exist_ok=True)
    quadros[0].save(a.saida, save_all=True, append_images=quadros[1:], duration=duracoes, loop=0, optimize=True, disposal=1)
    mb = a.saida.stat().st_size / 1e6
    print(f"{a.saida}: {len(arquivos)} capturas, {len(quadros)} quadros, {sum(duracoes) / 1000:.1f} s, {mb:.1f} MB")
    if mb > 10:
        print("AVISO: passou de 10 MB (regra da F10.1); reduza --largura ou aumente --ms")


if __name__ == "__main__":
    main()
