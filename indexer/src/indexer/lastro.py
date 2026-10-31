"""Lastro numérico dos fatos extraídos (ARQUITETURA §5 I-5, guarda 3, tarefa F4.3).

O LLM devolve cada fato com o número, a escala e a `evidence` (cópia do trecho). O lastro confere, sem LLM, se
o número do fato aparece na evidência e se a evidência existe no texto que o modelo recebeu. Um fato só é
aceito se passar nas conferências abaixo; quem não passa sai com o primeiro motivo que falhou:

* `evidencia_fora_do_texto`: alguma célula (ou pedaço entre reticências) da evidência não está no texto
  enviado. Em tabela a evidência costuma juntar cabeçalho e linha, então a ordem das células não conta;
* `metrica_generica`: a métrica é só "Outros", "Total" etc., que não diz o que foi medido;
* `valor_ausente`: nenhum número da evidência tem o módulo do valor do fato;
* `sinal`: o módulo aparece, mas com o outro sinal (o valor impresso é que vale: "(900)" é -900 e "redução de
  R$ 400 milhões" é 400; a direção fica no nome da métrica);
* `faixa`: o valor é só um extremo de uma faixa ("7,0 a 11,0"), não um ponto;
* `linha`: em evidência de tabela, o número não está numa linha que traga também o rótulo da evidência ou a
  métrica do fato (só o cabeçalho e o número não provam de qual linha o valor veio);
* `coluna`: o cabeçalho da coluna do valor não combina com o fato: o ano do período não é o da coluna
  ("Var.% 25/24" é 2025) ou o rótulo de dimensão ("Centro-Oeste", "Conselho Fiscal") não está na métrica, na
  entidade nem no segmento;
* `unidade`: percentual acima de 1.000 (quase sempre valor em reais) ou, em tabela de cabeçalho
  "R$ bilhões ou %", unidade que não é a do rótulo da linha ("Carteira (%)" é percentual, "PCLD" é reais);
* `escala`: a escala do fato contradiz o texto. Vale a escala dita ao lado do número ("R$ 625 milhões",
  "85,2 mil"); sem ela, uma escala maior que 1 tem de ser uma das que o contexto da tabela declara (o fator
  da tabela e células como "R$ milhões" ou "R$ bilhões ou %"); percentual e ponto-base têm escala 1;
* `escala_sem_lastro`: a escala do fato é maior que 1, mas nem a evidência nem a tabela falam de escala.

Escala 1 num fato monetário nunca é rejeitada (o valor pode ser mesmo em reais, como "R$ 5,82"), e uma tabela
sem escala declarada não permite saber se "(12.345)" é em reais ou em milhares: essas lacunas ficam para a
auditoria. O valor normalizado é `value * scale`. Tudo em `Decimal`.

Uso (a partir de indexer/):
    uv run python -m indexer.lastro ../data/parsed/bb_fre_2026_recorte
    uv run python -m indexer.lastro ../data/parsed/bb_fre_2026_recorte --amostra 30 --semente 1
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path

from indexer.extrair import unidades
from indexer.numeros import ESCALAS, MOEDAS, TOKEN_NUMERO, parse_faixa, parse_valor

ACEITO = "aceito"
LIMITE_DE_PERCENTUAL = 1000  # acima disso o "percentual" é quase sempre um valor em reais
MOTIVOS = (
    "evidencia_fora_do_texto", "metrica_generica", "valor_ausente", "sinal", "faixa", "linha", "coluna",
    "unidade", "escala", "escala_sem_lastro",
)  # fmt: skip
METRICAS_GENERICAS = frozenset(
    {"outros", "outras", "demais", "total", "subtotal"}
)  # não identificam o que mediram
ELISAO = re.compile(r"\s*(?:\.\.\.|…)\s*")
FATOR_DECLARADO = re.compile(r"Escala/moeda declarada: fator (\d+)")
UNIDADE_MISTA = re.compile(r"R\$[^|]*\sou\s+%", re.IGNORECASE)  # "R$ bilhões ou %": a unidade vem no rótulo
SEPARADOR_MD = re.compile(r"^\|[\s:|-]*---[\s:|-]*$")
# palavras de cabeçalho que não nomeiam uma dimensão (período, escala, tipo de coluna)
PALAVRAS_GENERICAS = frozenset(
    "milhões milhoes bilhões bilhoes exceto percentuais observado revisão revisao projeção projecao inicial "
    "guidance indicadores indicador conceito resultado saldo valor total exercício exercicio período periodo "
    "média media mantido fator".split()
)


def _normaliza(texto: str) -> str:
    return re.sub(r"\s+", " ", texto.replace("\xa0", " ")).strip()


def _canonico(texto: str) -> str:
    """Texto sem as barras de célula e com os espaços colapsados: tabela e texto corrido ficam comparáveis."""
    return _normaliza(texto.replace("|", " "))


def _celulas(trecho: str) -> list[str]:
    return [c for c in (_canonico(x) for x in trecho.split("|")) if c]


def _como_celula(celula: str) -> re.Pattern[str]:
    """A célula inteira, sem ser pedaço de outro número ("13,7" não está em "113,7" nem em "13,75")."""
    return re.compile(r"(?<![\d.,])" + re.escape(celula) + r"(?!\d|[.,]\d)")


def evidencia_no_texto(evidencia: str, texto: str) -> bool:
    """A evidência é cópia do trecho enviado: cada célula (ou pedaço entre reticências) está no texto."""
    alvo = _canonico(texto)
    pedacos = [p for p in (_celulas(x) for x in ELISAO.split(evidencia)) if p]
    return bool(pedacos) and all(_como_celula(c).search(alvo) for p in pedacos for c in p)


def _tem_o_valor(celula: str, valor: Decimal) -> bool:
    return any(abs(n) == abs(valor) for n, _ in numeros_da_evidencia(celula))


def linha_do_valor(evidencia: str, valor: Decimal, pedido: str, metrica: str = "") -> str | None:
    """Em evidência de tabela (células com "|"), a linha da tabela que traz o número e também um rótulo.

    O rótulo é uma célula da evidência com letras e sem ser o próprio número, ou a métrica do fato (inteira ou
    cada parte separada por " - "); o cabeçalho (período, "Observado") fica em outra linha, então só o rótulo
    da linha prova que o número é o da linha certa. Devolve None se nenhuma linha serve.
    """
    celulas = [c for p in ELISAO.split(evidencia) for c in _celulas(p)]
    numericas = [c for c in celulas if _tem_o_valor(c, valor)]
    rotulos = [c for c in celulas if re.search("[A-Za-zÀ-ÿ]", c) and c not in numericas]
    rotulos += [m for m in (_canonico(metrica), *map(_canonico, metrica.split(" - "))) if m]
    for linha in pedido.splitlines():
        if not linha.startswith("|"):
            continue
        alvo = _canonico(linha)
        if not any(_como_celula(c).search(alvo) for c in numericas):
            continue
        primeira = next(iter(_celulas(linha)), "")  # o rótulo da linha pode estar dentro da métrica
        no_metrica = len(primeira) >= 4 and primeira.lower() in metrica.lower()
        if no_metrica or any(_como_celula(r).search(alvo) for r in rotulos):
            return linha
    return None


def so_em_faixas(evidencia: str, valor: Decimal) -> bool:
    """Todo lugar da evidência em que o valor aparece é um extremo de faixa ("7,0 a 11,0"): não é um ponto."""
    onde = [c for p in ELISAO.split(evidencia) for c in _celulas(p) if _tem_o_valor(c, valor)]
    if not onde:
        return False
    return all(
        (f := parse_faixa(c)) is not None
        and any(abs(v.valor) == abs(valor) for v in f if v.valor is not None)
        for c in onde
    )


def _linhas_da_tabela(linha: str) -> list[str]:
    return [c.strip() for c in linha.strip().strip("|").split("|")]


def _cabecalhos(pedido: str) -> list[list[str]]:
    """Linhas de cabeçalho da tabela do pedido (as que vêm antes de "|---|"); células mescladas, que o
    Markdown deixa vazias, herdam o texto da célula à esquerda."""
    linhas = pedido.splitlines()
    for i, ln in enumerate(linhas):
        if SEPARADOR_MD.match(ln):
            topo = []
            for cab in reversed(linhas[max(0, i - 3) : i]):
                if not cab.startswith("|"):
                    break
                topo.insert(0, _linhas_da_tabela(cab))
            for cels in topo:
                for j in range(1, len(cels)):
                    cels[j] = cels[j] or cels[j - 1]
            return topo
    return []


def unidade_confere(fato: dict, linha: str, pedido: str) -> bool:
    """Em tabela de cabeçalho "R$ bilhões ou %", cada linha traz a unidade no rótulo: "Carteira (%)" é
    percentual e "PCLD Ampliada" é valor em reais. O fato tem de seguir o rótulo."""
    if not any(UNIDADE_MISTA.search(c) for cab in _cabecalhos(pedido) for c in cab):
        return True
    rotulo = next(iter(_linhas_da_tabela(linha)), "")
    return ("%" in rotulo) == (fato["unit"] == "percent")


def _anos(texto: str) -> set[int]:
    """Anos que um cabeçalho cita: "2025", "31/12/2025", "1T25", "9M24"; em "Var.% 25/24" só 2025, o ano
    em que a variação é reportada."""
    anos = {int(a) for a in re.findall(r"(?<!\d)(20\d\d)(?!\d)", texto)}
    anos |= {2000 + int(a) for a in re.findall(r"(?<![\dA-Za-z])(?:[1-4]T|[12]S|9M|12M)(\d\d)(?!\d)", texto)}
    anos |= {2000 + int(a) for a in re.findall(r"(?<![\d/])(\d\d)/\d\d(?![\d/])", texto)}
    return anos


def _palavras(texto: str) -> set[str]:
    return {p for p in re.findall(r"[a-zà-ÿ]{4,}", texto.lower()) if p not in PALAVRAS_GENERICAS}


def coluna_confere(fato: dict, valor: Decimal, linha: str, pedido: str) -> bool:
    """O cabeçalho da coluna do valor combina com o fato: o ano do período está entre os que o cabeçalho cita,
    e o rótulo de dimensão da coluna ("Centro-Oeste", "Conselho Fiscal") aparece na métrica, na entidade ou
    no segmento (campos do fato, não a evidência: é neles que o grafo guarda a dimensão). Passa se o valor
    ocorre em mais de uma coluna e alguma delas confere."""
    cabecalhos = _cabecalhos(pedido)
    celulas = _linhas_da_tabela(linha)
    colunas = [i for i, c in enumerate(celulas) if i > 0 and _tem_o_valor(c, valor)]
    if not cabecalhos or not colunas:
        return True
    do_fato = _palavras(" ".join([fato["metric"], fato["entity"], fato.get("segment") or ""]))
    for i in colunas:
        textos = [cab[i] for cab in cabecalhos if i < len(cab) and cab[i]]
        anos = set().union(*(_anos(t) for t in textos)) if textos else set()
        if anos and int(fato["period"][:4]) not in anos:
            continue
        dimensoes = [_palavras(t) for t in textos if not _anos(t)]
        if all(not d or d & do_fato for d in dimensoes):
            return True
    return False


def numeros_da_evidencia(evidencia: str) -> list[tuple[Decimal, int]]:
    """(número com sinal, escala dita logo depois dele) de cada número da evidência."""
    saida = []
    for m in TOKEN_NUMERO.finditer(evidencia):
        token = m.group(0).strip()
        if token.startswith("(") and not token.endswith(")"):  # "(22,6%)" em texto corrido não é negativo
            token = token[1:]
        v = parse_valor(token)
        if v is None or v.ausente or v.valor is None:
            continue
        escala = v.escala_inline
        if v.unidade == "numero" and escala == 1:
            for padrao, fator in ESCALAS:
                if re.match(r"\s*(?:de\s+)?(?:" + padrao.pattern + ")", evidencia[m.end() :], padrao.flags):
                    escala = fator
                    break
        saida.append((v.valor, escala))
    return saida


def escalas_do_contexto(pedido: str) -> set[int]:
    """Escalas que a tabela declara: o fator do pedido e as células de cabeçalho sem número, como
    "R$ milhões" ou "R$ bilhões ou %". Tabelas com dois blocos declaram mais de uma."""
    achadas = set()
    m = FATOR_DECLARADO.search(pedido)
    if m:
        achadas.add(int(m.group(1)))
    for linha in pedido.splitlines():
        if not linha.startswith("|"):
            continue
        for celula in linha.split("|"):
            if re.search(r"\d", celula) or not any(p.search(celula) for p, _ in MOEDAS):
                continue
            for padrao, fator in ESCALAS:
                if padrao.search(celula):
                    achadas.add(fator)
                    break
    return achadas


def avaliar(fato: dict, pedido: str) -> str:
    """`aceito` ou o primeiro motivo de rejeição do fato, dado o pedido (texto) em que ele foi extraído."""
    ev = fato["evidence"]
    if not evidencia_no_texto(ev, pedido):
        return "evidencia_fora_do_texto"
    if _canonico(fato["metric"]).strip(" -:").lower() in METRICAS_GENERICAS:
        return "metrica_generica"
    valor = Decimal(str(fato["value"]))
    mesmo_modulo = [(n, e) for n, e in numeros_da_evidencia(ev) if abs(n) == abs(valor)]
    if not mesmo_modulo:
        return "valor_ausente"
    com_sinal = [(n, e) for n, e in mesmo_modulo if (n < 0) == (valor < 0) or valor == 0]
    if not com_sinal:
        return "sinal"
    if so_em_faixas(ev, valor):
        return "faixa"
    if "|" in ev:
        linha = linha_do_valor(ev, valor, pedido, fato["metric"])
        if linha is None:
            return "linha"
        if not coluna_confere(fato, valor, linha, pedido):
            return "coluna"
        if fato["unit"] in ("percent", "currency") and not unidade_confere(fato, linha, pedido):
            return "unidade"
    if fato["unit"] == "percent" and abs(valor) > LIMITE_DE_PERCENTUAL:
        return "unidade"
    escala = fato["scale"]
    if fato["unit"] in ("percent", "basis_points"):
        return ACEITO if escala == 1 else "escala"
    ditas = {dita for _, dita in com_sinal if dita > 1}
    if ditas:
        return ACEITO if escala in ditas else "escala"
    if escala == 1:
        return ACEITO
    contexto = escalas_do_contexto(pedido)
    if not contexto:
        return "escala_sem_lastro"
    return ACEITO if escala in contexto else "escala"


def conferir(resultados: list[dict], pedidos: dict[str, str]) -> list[dict]:
    """Um registro por fato: unidade, posição, motivo (`aceito` ou rejeição) e o fato."""
    saida = []
    for r in resultados:
        if not r["valida"]:
            continue
        for i, f in enumerate(r["resposta"]["financial_facts"]):
            saida.append(
                {
                    "unidade": r["id"],
                    "tipo": r["tipo"],
                    "paginas": r["paginas"],
                    "posicao": i,
                    "motivo": avaliar(f, pedidos[r["id"]]),
                    "fato": f,
                }  # fmt: skip
            )
    return saida


def _contagem(registros: list[dict]) -> dict:
    return {"fatos": len(registros), "rejeitados": sum(r["motivo"] != ACEITO for r in registros)}


def resumir(registros: list[dict]) -> dict:
    """Taxa de rejeição geral, por motivo, por tipo de unidade e por unidade (`unit`) do fato."""
    n = len(registros)
    por_motivo = Counter(r["motivo"] for r in registros)
    rejeitados = n - por_motivo[ACEITO]
    return {
        "fatos": n,
        "aceitos": por_motivo[ACEITO],
        "rejeitados": rejeitados,
        "taxa_de_rejeicao": round(rejeitados / n, 4) if n else 0.0,
        "por_motivo": {m: por_motivo[m] for m in MOTIVOS},
        "por_tipo": {t: _contagem([r for r in registros if r["tipo"] == t]) for t in ("pai", "tabela")},
        "por_unidade_do_fato": {
            u: _contagem([r for r in registros if r["fato"]["unit"] == u])
            for u in sorted({r["fato"]["unit"] for r in registros})
        },
    }


def _pedidos(prefixo: Path) -> dict[str, str]:
    chunks = json.loads(Path(f"{prefixo}.chunks.json").read_text(encoding="utf-8"))
    tabelas = json.loads(Path(f"{prefixo}.tabelas.json").read_text(encoding="utf-8"))
    return {u["id"]: u["pedido"] for u in unidades(chunks, tabelas)}


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prefixo", type=Path, help="ex.: ../data/parsed/bb_fre_2026_recorte")
    ap.add_argument("--amostra", type=int, default=0, help="sorteia K fatos aceitos para auditar")
    ap.add_argument("--semente", type=int, default=1)
    a = ap.parse_args()

    resultados = json.loads(Path(f"{a.prefixo}.extracao.json").read_text(encoding="utf-8"))
    pedidos = _pedidos(a.prefixo)
    registros = conferir(resultados, pedidos)
    Path(f"{a.prefixo}.fatos.json").write_text(
        json.dumps(registros, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(json.dumps(resumir(registros), ensure_ascii=False, indent=1))
    if a.amostra:
        aceitos = [r for r in registros if r["motivo"] == ACEITO]
        sorteio = random.Random(a.semente).sample(aceitos, min(a.amostra, len(aceitos)))
        pasta = a.prefixo.parent / "auditoria"
        pasta.mkdir(exist_ok=True)
        itens = [{**r, "pedido": pedidos[r["unidade"]]} for r in sorteio]
        arq = pasta / f"f43_amostra_s{a.semente}.json"
        arq.write_text(json.dumps(itens, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"amostra de {len(itens)} fatos aceitos em {arq}", file=sys.stderr)


if __name__ == "__main__":
    main()
