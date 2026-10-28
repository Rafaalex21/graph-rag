"""I-2 · Normalizador numérico (ARQUITETURA §5, tarefa F1.7).

É o ponto em que documentos financeiros mais enganam um RAG: separadores de milhar e de decimal que mudam
de idioma, negativos entre parênteses, "-" no lugar de zero, escala dita no cabeçalho ("R$ milhões") e
percentuais ou pontos-base. Tudo em `Decimal`, sem ponto flutuante.

* `parse_valor` interpreta uma célula ou trecho ("(1.234,5)", "66,25%", "R$ 169.235 milhões");
* `detectar_escala` lê a escala e a moeda de um cabeçalho ("em milhares de reais", "in millions of US$");
* `detectar_formato` decide entre pt-BR e EN olhando uma amostra de números do documento;
* `parse_faixa` interpreta "8,0 a 12,0" e "-30,0 a -27,0";
* `valores_no_texto` acha e interpreta os números de um trecho (base do lastro numérico da F4.3).

A ambiguidade de "1.234" (1234 em pt-BR, 1,234 em EN) só é sinalizada no modo `auto`; com o formato
conhecido (`pt` ou `en`) ela não existe.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

# hífen, sinal de menos (U+2212) e travessão curto quando colados a um número
SINAIS_NEGATIVOS = "-−–"
# o que uma célula pode trazer no lugar de um valor
AUSENTES = {
    "": "vazio",
    "-": "traco",
    "–": "traco",
    "—": "traco",
    "−": "traco",
    "n.a.": "nao_aplicavel",
    "n.a": "nao_aplicavel",
    "n/a": "nao_aplicavel",
    "na": "nao_aplicavel",
    "não aplicável": "nao_aplicavel",
    "nao aplicavel": "nao_aplicavel",
    "n.d.": "nao_disponivel",
    "n/d": "nao_disponivel",
    "nd": "nao_disponivel",
    "s/d": "nao_disponivel",
}
MOEDAS = (
    (re.compile(r"US\$|USD|d[óo]lares?|dollars?", re.IGNORECASE), "USD"),
    (re.compile(r"R\$|BRL|reais|real\b", re.IGNORECASE), "BRL"),
    (re.compile(r"€|EUR|euros?", re.IGNORECASE), "EUR"),
)
# escala por extenso; a ordem importa ("milhões" antes de "mil")
ESCALAS = (
    (re.compile(r"\bbilh(?:ões|oes|ão|ao)\b|\bbillions?\b|\bbi\b", re.IGNORECASE), 1_000_000_000),
    (re.compile(r"\bmilh(?:ões|oes|ão|ao)\b|\bmillions?\b|\bmi\b", re.IGNORECASE), 1_000_000),
    (re.compile(r"\bmilhares\b|\bmil\b|\bthousands?\b", re.IGNORECASE), 1_000),
)
UNIDADES_TEXTO = (
    (
        re.compile(
            r"\bp\.?\s?b\.?(?![a-z])|\bbps\b|\bbp\b|pontos?[- ]base|pontos? b[áa]sicos?", re.IGNORECASE
        ),
        "pontos_base",
    ),
    (re.compile(r"\bp\.?\s?p\.?(?![a-z])|pontos? percentuais?", re.IGNORECASE), "pontos_percentuais"),
)
SO_NUMERO = re.compile(r"\d[\d\.,]*")
TOKEN_NUMERO = re.compile(r"(?<![\w.,])\(?[-−]?\d[\d\.,]*\)?\s?%?")
SEPARADOR_DE_FAIXA = re.compile(r"\s+(?:a|até|to)\s+", re.IGNORECASE)
# "9,53% a 15,77% DI", "6% a.a.": o indexador ou o período depois da faixa não faz parte dos números
SUFIXO_DE_TAXA = re.compile(r"\s+(?:c?di|selic|ipca|igp-?m|tr|a\.a\.|p\.a\.|a\.m\.)\.?$", re.IGNORECASE)


@dataclass(frozen=True)
class Valor:
    """Resultado da interpretação de um texto numérico."""

    texto: str
    valor: Decimal | None = None
    unidade: str = "numero"  # numero | percentual | pontos_base | pontos_percentuais
    moeda: str | None = None
    escala_inline: int = 1  # "169.235 milhões" -> 1_000_000
    ausente: bool = False
    motivo: str | None = None  # traco | vazio | nao_aplicavel | nao_disponivel
    negativo_por_parenteses: bool = False
    formato: str | None = None  # pt | en
    ambiguo: bool = False

    def com_escala(self, escala_do_cabecalho: int = 1) -> Decimal | None:
        """Valor em unidades: aplica a escala do trecho e a do cabeçalho.

        Percentuais e pontos não têm escala.
        """
        if self.valor is None:
            return None
        if self.unidade != "numero":
            return self.valor
        return self.valor * self.escala_inline * escala_do_cabecalho

    def como_float(self, escala_do_cabecalho: int = 1) -> float | None:
        v = self.com_escala(escala_do_cabecalho)
        return None if v is None else float(v)


@dataclass(frozen=True)
class Escala:
    fator: int
    moeda: str | None
    trecho: str


def _limpa(texto: str) -> str:
    return re.sub(r"\s+", " ", texto.replace("\xa0", " ").replace(" ", " ")).strip()


def _converte(digitos: str, formato: str) -> tuple[Decimal, str, bool] | None:
    """Converte "1.234,56" ou "1,234.56" em Decimal. Devolve (valor, formato usado, ambíguo) ou None."""
    ponto, virgula = digitos.count("."), digitos.count(",")
    ambiguo = False

    if formato == "auto":
        if ponto and virgula:
            formato = "pt" if digitos.rfind(",") > digitos.rfind(".") else "en"
        elif ponto or virgula:
            sep = "." if ponto else ","
            n = ponto or virgula
            depois = len(digitos.rsplit(sep, 1)[1])
            if n > 1:  # vários separadores iguais: só pode ser milhar
                formato = "pt" if sep == "." else "en"
            elif depois != 3:  # um separador e não são 3 dígitos: é decimal
                formato = "pt" if sep == "," else "en"
            else:  # "1.234" ou "1,234": pode ser milhar ou decimal
                ambiguo = True
                formato = "pt"
        else:
            formato = "pt"

    milhar, decimal = (".", ",") if formato == "pt" else (",", ".")
    if digitos.count(decimal) > 1:
        return None
    inteiro, _, fracao = digitos.partition(decimal)
    grupos = inteiro.split(milhar)
    if len(grupos) > 1 and (not 1 <= len(grupos[0]) <= 3 or any(len(g) != 3 for g in grupos[1:])):
        return None
    if milhar in fracao or not (fracao == "" or fracao.isdigit()):
        return None
    try:
        return Decimal("".join(grupos) + ("." + fracao if fracao else "")), formato, ambiguo
    except InvalidOperation:
        return None


def parse_valor(texto: str, formato: str = "auto") -> Valor | None:
    """Interpreta um número como aparece no documento. Devolve None se o texto não for um número.

    `formato`: "pt" (1.234,56), "en" (1,234.56) ou "auto" (decide pelo texto e sinaliza `ambiguo`).
    Um texto que é só traço, "n.a." ou "Não Aplicável" volta como `Valor(ausente=True, motivo=...)`.
    """
    original = texto
    t = _limpa(texto)
    chave = t.lower()
    if chave in AUSENTES:
        return Valor(texto=original, ausente=True, motivo=AUSENTES[chave])

    negativo = parenteses = False
    m = re.fullmatch(r"\((.*)\)", t)
    if m:
        negativo = parenteses = True
        t = m.group(1).strip()

    moeda = None
    for padrao, codigo in MOEDAS:
        if padrao.search(t):
            moeda = codigo
            t = padrao.sub(" ", t, count=1)
            break
    t = _limpa(t)

    if t and t[0] in SINAIS_NEGATIVOS and len(t) > 1 and (t[1].isdigit() or t[1] == " "):
        negativo = True
        t = t[1:].strip()

    escala = 1
    for padrao, fator in ESCALAS:
        if padrao.search(t):
            escala = fator
            t = padrao.sub(" ", t, count=1)
            break

    unidade = "numero"
    if "%" in t:
        unidade = "percentual"
        t = t.replace("%", " ")
    else:
        for padrao, nome in UNIDADES_TEXTO:
            if padrao.search(t):
                unidade = nome
                t = padrao.sub(" ", t, count=1)
                break
    t = _limpa(t)
    if t and t[0] in SINAIS_NEGATIVOS and len(t) > 1 and t[1].isdigit():  # "R$ -1.234", "-1,5 p.b."
        negativo = True
        t = t[1:]

    if not SO_NUMERO.fullmatch(t):
        return None
    convertido = _converte(t, formato)
    if convertido is None:
        return None
    numero, usado, ambiguo = convertido
    return Valor(
        texto=original,
        valor=-numero if negativo else numero,
        unidade=unidade,
        moeda=moeda,
        escala_inline=escala,
        negativo_por_parenteses=parenteses,
        formato=usado,
        ambiguo=ambiguo,
    )


def detectar_escala(cabecalho: str) -> Escala | None:
    """Escala e moeda declaradas no cabeçalho: "R$ milhões", "em milhares de reais", "in millions of US$"."""
    t = _limpa(cabecalho)
    fator = trecho = None
    for padrao, f in ESCALAS:
        m = padrao.search(t)
        if m:
            fator, trecho = f, m.group(0)
            break
    if fator is None:
        return None
    moeda = next((codigo for padrao, codigo in MOEDAS if padrao.search(t)), None)
    return Escala(fator=fator, moeda=moeda, trecho=trecho)


def detectar_formato(amostras: list[str]) -> str:
    """ "pt", "en" ou "ambiguo", pelos números de uma amostra (as amostras ambíguas não contam)."""
    pt = en = 0
    for a in amostras:
        for token in SO_NUMERO.findall(_limpa(a)):
            r = _converte(token, "auto")
            if r is None or r[2]:
                continue
            if "." in token or "," in token:
                pt += r[1] == "pt"
                en += r[1] == "en"
    if pt == en:
        return "ambiguo"
    return "pt" if pt > en else "en"


def parse_faixa(texto: str, formato: str = "auto") -> tuple[Valor, Valor] | None:
    """ "8,0 a 12,0" -> (8,0; 12,0). Aceita sufixo de indexador ("... DI"). Se só um lado for número, None."""
    partes = SEPARADOR_DE_FAIXA.split(SUFIXO_DE_TAXA.sub("", _limpa(texto)))
    if len(partes) != 2:
        return None
    a, b = parse_valor(partes[0], formato), parse_valor(partes[1], formato)
    if a is None or b is None or a.ausente or b.ausente:
        return None
    return a, b


def valores_no_texto(texto: str, formato: str = "auto") -> list[Valor]:
    """Números de um trecho, em ordem (anos, valores, percentuais); trechos que não parseiam são ignorados."""
    saida = []
    for m in TOKEN_NUMERO.finditer(texto):
        v = parse_valor(m.group(0).strip(), formato)
        if v is not None and not v.ausente:
            saida.append(v)
    return saida


def estatisticas_de_celulas(textos: list[str], formato: str) -> dict:
    """Quantas células viram número, faixa, ausente (traço etc.), texto comum ou número que não parseia.

    "Não interpretado" é só o que parece um número (dígitos e separadores, sem letras) e não parseia.
    """
    cont = {"numero": 0, "faixa": 0, "ausente": 0, "texto": 0, "nao_interpretado": 0}
    exemplos: list[str] = []
    for t in textos:
        limpo = _limpa(t or "")
        v = parse_valor(limpo, formato)
        if v is not None:
            cont["ausente" if v.ausente else "numero"] += 1
        elif parse_faixa(limpo, formato) is not None:
            cont["faixa"] += 1
        elif re.search(r"\d", limpo) and re.fullmatch(r"[\d\.,%()\-−–\s$]+", limpo):
            cont["nao_interpretado"] += 1
            exemplos.append(limpo)
        else:
            cont["texto"] += 1
    cont["exemplos_nao_interpretados"] = exemplos[:30]
    return cont


def main() -> None:
    import argparse
    import json
    from pathlib import Path

    ap = argparse.ArgumentParser(
        description="Interpreta as células de tabelas de um DoclingDocument e resume."
    )
    ap.add_argument("docling_json", type=Path)
    ap.add_argument("--formato", default="auto", choices=("auto", "pt", "en"))
    a = ap.parse_args()

    doc = json.loads(a.docling_json.read_text(encoding="utf-8"))
    textos = [c.get("text") or "" for t in doc["tables"] for c in t["data"].get("table_cells", [])]
    formato = a.formato
    if formato == "auto":
        detectado = detectar_formato(textos)
        print(f"formato detectado nas {len(textos)} células: {detectado}")
        formato = "pt" if detectado == "ambiguo" else detectado
    stats = estatisticas_de_celulas(textos, formato)
    stats["celulas"] = len(textos)
    stats["formato_usado"] = formato
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
