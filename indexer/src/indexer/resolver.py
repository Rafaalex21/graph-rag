"""Resolução de entidades: normalização, bloqueio, similaridade, confirmação por LLM e fusão (§5 I-7, F4.5).

Duas etapas, separadas para que o LLM nunca toque no grafo:

- `planejar` (LLM, sem escrever no Neo4j): gera os pares candidatos, confirma cada um com o Qwen3.6 e grava
  `data/parsed/<prefixo>.resolucao.json` (fora do git) com os pares julgados e o mapa "id absorvido -> id
  que fica". Repetir o comando não repete chamadas: as decisões ficam em cache por hash do pedido.
- `aplicar` (sem LLM): funde no Neo4j com `apoc.refactor.mergeNodes` e reescreve as propriedades pelo
  importador da F4.4 já com o mapa de redirecionamento, de modo que reimportar depois da fusão não recria
  os nós absorvidos (ADR-036).

Candidatos vêm de quatro fontes: o bloqueio da §5 I-7 (tipo e primeiro token significativo, mais siglas),
a contenção lexical dos nomes, a sigla e a similaridade de embedding; o embedding sozinho não separa
duplicatas de não duplicatas (medido: ADR-036). Mesmo CNPJ ou ticker com o mesmo nome (sem sufixo) funde
sem LLM; com nomes diferentes o par vai ao LLM, e CNPJs diferentes vetam a fusão.

Uso, a partir de `indexer/`, com o Neo4j e o llama-swap (perfis `vetorizar` e `indexar`) no ar:
    uv run python -m indexer.resolver planejar ../data/parsed/ARQUIVO --doc-id ID
    uv run python -m indexer.resolver aplicar ../data/parsed/ARQUIVO --doc-id ID
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import re
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.importar import TIPO_DA_ENTIDADE, carregar, contagens, entradas, impressao_digital, normalizar

MODELO_LLM = "qwen36-35b-a3b"
VERSAO_DO_PROMPT = "v1"
LIMIAR_NO_BLOCO = 0.70  # a §5 I-7 propunha 0,92; medido, quase nenhuma duplicata chega lá (ADR-036)
LIMIAR_GLOBAL = 0.80
PARES_SEM_JUIZ_NO_TIPO = ("Event",)  # sem dados reais para calibrar; ficam de fora
STOP = frozenset("de do da dos das e a o as os em no na para por com".split())
SUFIXOS = frozenset("sa ltda inc corp ltd limited".split())
NOMES_INVALIDOS = frozenset({"", "null", "n a", "na", "desconhecido", "none"})

Juiz = Callable[[list[dict]], dict]

ESQUEMA_DO_JUIZ = {
    "type": "object",
    "additionalProperties": False,
    "required": ["mesma_entidade", "justificativa"],
    "properties": {
        "mesma_entidade": {"type": "boolean"},
        "justificativa": {"type": "string", "maxLength": 240},
    },
}
SISTEMA = (
    "Você compara dois registros de entidade extraídos de um documento financeiro em português e "
    "decide se os dois se referem à MESMA entidade do mundo real. São a mesma entidade: grafias "
    "diferentes, sigla e nome por extenso, nome com e sem sufixo societário (S.A., Ltda.) e nome "
    "completo e abreviado. NÃO são a mesma entidade: empresas diferentes do mesmo grupo (controladora "
    "e subsidiária), órgãos ou cargos diferentes, pessoas diferentes, segmentos diferentes, e siglas "
    "de instituições diferentes. Na dúvida, responda false. Responda só com o JSON pedido."
)
PEDIDO = """Tipo da entidade: {tipo}

Registro A
- Nome: {a_nome}
- Papéis no documento: {a_papeis}
- Descrição: {a_desc}
- CNPJ: {a_cnpj}
- Trecho onde aparece: {a_trecho}

Registro B
- Nome: {b_nome}
- Papéis no documento: {b_papeis}
- Descrição: {b_desc}
- CNPJ: {b_cnpj}
- Trecho onde aparece: {b_trecho}

A e B são a mesma entidade?"""
PEDIDO_OUTRO_TIPO = PEDIDO.replace(
    "Tipo da entidade: {tipo}",
    "Tipo do registro A: {tipo}\nTipo do registro B: {tipo_b}\n"
    "(Os dois foram extraídos com tipos diferentes; o tipo pode estar errado em um deles. "
    "Compare o que o nome e o trecho dizem.)",
)


def nome_base(nome: str | None) -> tuple[str, ...]:
    """Tokens do nome normalizado, sem o sufixo societário (S.A., Ltda., Inc., Corp., Ltd., Limited)."""
    tokens = normalizar(nome).split()
    saida: list[str] = []
    i = 0
    while i < len(tokens):
        if tokens[i] == "s" and i + 1 < len(tokens) and tokens[i + 1] == "a":
            i += 2
        elif tokens[i] in SUFIXOS:
            i += 1
        else:
            saida.append(tokens[i])
            i += 1
    return tuple(saida)


def significativos(nome: str | None) -> tuple[str, ...]:
    return tuple(t for t in nome_base(nome) if t not in STOP)


def iniciais(nome: str | None) -> str:
    sig = significativos(nome)
    return "".join(t[0] for t in sig) if len(sig) >= 2 else ""


def _partes(nome: str) -> list[str]:
    """O nome inteiro e os pedaços separados por " - " ou " / " ("CEF - Caixa Econômica Federal")."""
    return [nome, *[p for p in re.split(r"\s[-–/]\s", nome) if p.strip()]]


def chaves_de_bloco(nome: str | None) -> set[str]:
    """Primeiro token significativo e iniciais de cada parte do nome: "BCB" casa com "Banco Central"."""
    chaves: set[str] = set()
    for parte in _partes(nome or ""):
        sig = significativos(parte)
        if sig:
            chaves.add(sig[0])
        if iniciais(parte):
            chaves.add(iniciais(parte))
    return chaves


def cnpj_digitos(cnpj: str | None) -> str:
    return re.sub(r"\D", "", cnpj or "")


def relacao_forte(a: dict, b: dict) -> str | None:
    """`forte` (mesmo CNPJ ou ticker), `veto` (CNPJs diferentes) ou None."""
    ca, cb = cnpj_digitos(a.get("cnpj")), cnpj_digitos(b.get("cnpj"))
    if ca and cb:
        return "forte" if ca == cb else "veto"
    ta, tb = (a.get("ticker") or "").strip().upper(), (b.get("ticker") or "").strip().upper()
    if ta and tb and ta == tb:
        return "forte"
    return None


def cosseno(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    )


def _contido(a: tuple[str, ...], b: tuple[str, ...]) -> bool:
    sa, sb = set(a), set(b)
    return bool(sa) and bool(sb) and (sa <= sb or sb <= sa)


def _sigla(a: dict, b: dict) -> bool:
    """Uma das duas é um token só e igual às iniciais do nome da outra ("BCB" e "Banco Central do Brasil")."""
    for x, y in ((a, b), (b, a)):
        sx = significativos(x["name"])
        if len(sx) == 1 and sx[0] == iniciais(y["name"]):
            return True
    return False


def valido(e: dict) -> bool:
    return normalizar(e["name"]) not in NOMES_INVALIDOS


def sem_parenteses(nome: str | None) -> str:
    return re.sub(r"\s*\([^)]*\)", "", nome or "").strip()


def _com_nota_entre_parenteses(a: dict, b: dict) -> bool:
    """Um nome é o outro mais uma sigla ou nota entre parênteses ("Comitê de Auditoria (Coaud)")."""
    base_a, base_b = nome_base(sem_parenteses(a["name"])), nome_base(sem_parenteses(b["name"]))
    return bool(base_a) and base_a == base_b and ("(" in a["name"]) != ("(" in b["name"])


def _compoe(alvo: str, tokens: tuple[str, ...], usados: int = 0) -> bool:
    """`alvo` é a soma de prefixos (2 letras ou mais) dos primeiros tokens, de pelo menos dois ("bacen")."""
    if not tokens:
        return False
    for n in range(2, min(len(tokens[0]), len(alvo)) + 1):
        if alvo[:n] != tokens[0][:n]:
            break  # um prefixo maior também não casa
        resto = alvo[n:]
        if (not resto and usados >= 1) or (resto and _compoe(resto, tokens[1:], usados + 1)):
            return True
    return False


def _contracao(a: dict, b: dict) -> bool:
    """Um nome de uma palavra só é a contração do outro ("Bacen" e "Banco Central do Brasil")."""
    for x, y in ((a, b), (b, a)):
        sx, sy = significativos(x["name"]), significativos(y["name"])
        if len(sx) == 1 and len(sx[0]) >= 4 and len(sy) >= 2 and _compoe(sx[0], sy):
            return True
    return False


def candidatos(entidades: list[dict], vetores: dict[str, list[float]]) -> list[dict]:
    """Pares com as razões da candidatura; nomes inválidos ("N/A", "null") e eventos ficam fora.

    Dentro do mesmo tipo valem todas as razões. Entre tipos diferentes só o nome igual: a extração aberta
    dá tipos diferentes ao mesmo ente (o Ministério da Fazenda como organização e como pessoa) e o juiz decide
    se o tipo errado era o de um dos dois. Nome contido entre tipos ficou de fora: dos 50 pares do recorte o
    juiz aceitou 7, e 4 eram erros ou dúvidas (a "taxa básica de juro", indicador, com as "Mudanças na taxa
    básica de juro", risco; o "valor justo" com os ativos a valor justo; dois órgãos com o ministério pelo
    CNPJ), contra 3 plausíveis (ADR-040)."""
    validas = sorted(
        (e for e in entidades if valido(e) and e["label"] not in PARES_SEM_JUIZ_NO_TIPO),
        key=lambda e: e["id"],
    )
    saida = []
    for a, b in itertools.combinations(validas, 2):
        forca = relacao_forte(a, b)
        if forca == "veto":
            continue
        sim = cosseno(vetores[a["id"]], vetores[b["id"]])
        sa, sb = significativos(a["name"]), significativos(b["name"])
        if a["label"] != b["label"]:
            if nome_base(a["name"]) == nome_base(b["name"]):
                saida.append(
                    {
                        "a": a["id"],
                        "b": b["id"],
                        "similaridade": round(sim, 4),
                        "razoes": ["nome_igual_outro_tipo"],
                    }
                )
            continue
        mesmo_bloco = bool(chaves_de_bloco(a["name"]) & chaves_de_bloco(b["name"]))
        razoes = []
        if forca == "forte":
            # só o mesmo nome (sem sufixo) com a mesma chave funde sem juiz; um órgão que usa o CNPJ do
            # ministério (procuradoria, secretaria) é outra entidade e vai ao LLM (ADR-036)
            mesmo_nome = nome_base(a["name"]) == nome_base(b["name"])
            razoes.append("chave_forte" if mesmo_nome else "mesmo_cnpj")
        if _com_nota_entre_parenteses(a, b):
            razoes.append("nota_entre_parenteses")  # funde sem juiz, como a chave forte
        if _contido(sa, sb):
            razoes.append("nome_contido")
        if mesmo_bloco and _sigla(a, b):
            razoes.append("sigla")
        if _contracao(a, b):
            razoes.append("contracao")
        if mesmo_bloco and sim >= LIMIAR_NO_BLOCO:
            razoes.append("embedding_no_bloco")
        if sim >= LIMIAR_GLOBAL:
            razoes.append("embedding_global")
        if razoes:
            saida.append({"a": a["id"], "b": b["id"], "similaridade": round(sim, 4), "razoes": razoes})
    return saida


def _chave_de_cache(pedido: str, modelo: str) -> str:
    return hashlib.sha256(f"{VERSAO_DO_PROMPT}\x1f{modelo}\x1f{SISTEMA}\x1f{pedido}".encode()).hexdigest()[
        :20
    ]


def juiz_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 300) -> Juiz:
    """Função mensagens -> {mesma_entidade, justificativa}; a gramática impõe o JSON."""

    def julga(mensagens: list[dict]) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0,
            "max_tokens": 400,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "mesma_entidade", "strict": True, "schema": ESQUEMA_DO_JUIZ},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            dados = json.load(r)
        return json.loads(dados["choices"][0]["message"]["content"])

    return julga


def descricao_de(e: dict, maximo: int = 2) -> str:
    """A descrição da dirigida (texto) ou as primeiras da aberta (lista, uma por Pai), no máximo `maximo`."""
    return e.get("description") or " ".join((e.get("descriptions") or [])[:maximo])


def montar_pedido(a: dict, b: dict) -> str:
    def campos(prefixo: str, e: dict) -> dict:
        return {
            f"{prefixo}_nome": e["name"],
            f"{prefixo}_papeis": ", ".join(e.get("roles") or []) or "não informado",
            f"{prefixo}_desc": descricao_de(e) or "não informada",
            f"{prefixo}_cnpj": e.get("cnpj") or "não informado",
            f"{prefixo}_trecho": e.get("trecho") or "não disponível",
        }

    modelo = PEDIDO if a["label"] == b["label"] else PEDIDO_OUTRO_TIPO
    return modelo.format(
        tipo=TIPO_DA_ENTIDADE[a["label"]],
        tipo_b=TIPO_DA_ENTIDADE[b["label"]],
        **campos("a", a),
        **campos("b", b),
    )


def julgar(
    pares: list[dict], por_id: dict[str, dict], juiz: Juiz, cache: Path, modelo: str = MODELO_LLM
) -> list[dict]:
    """Decide cada par: chave forte funde sem LLM; os demais vão ao juiz (com cache por hash do pedido)."""
    cache.mkdir(parents=True, exist_ok=True)
    saida = []
    for p in pares:
        a, b = por_id[p["a"]], por_id[p["b"]]
        if "chave_forte" in p["razoes"]:
            saida.append(
                {**p, "decisao": True, "por": "chave_forte", "justificativa": "mesmo CNPJ ou ticker"}
            )
            continue
        if "nota_entre_parenteses" in p["razoes"]:
            saida.append(
                {
                    **p,
                    "decisao": True,
                    "por": "regra",
                    "justificativa": "mesmo nome, um com sigla entre parênteses",
                }
            )
            continue
        pedido = montar_pedido(a, b)
        arq = cache / f"{_chave_de_cache(pedido, modelo)}.json"
        if arq.exists():
            r = json.loads(arq.read_text(encoding="utf-8"))
        else:
            r = juiz([{"role": "system", "content": SISTEMA}, {"role": "user", "content": pedido}])
            arq.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        saida.append(
            {**p, "decisao": bool(r["mesma_entidade"]), "por": "llm", "justificativa": r["justificativa"]}
        )
    return saida


def fechamento(decisoes: list[dict], vetores: dict[str, list[float]]) -> list[dict]:
    """Pares que faltam para fechar os grupos: se a~b e b~c foram aceitos e a,c nunca foram julgados.

    Sem o julgamento de a,c, uma ponte entre duas entidades distintas as fundiria (o juiz aceitou
    "Procuradoria Geral da Fazenda Nacional/Ministério da Fazenda" com a Secretaria do Tesouro e com a
    Procuradoria, porque os três usam o mesmo CNPJ). Os pares novos vão ao juiz como os demais, com a
    razão `fechamento`."""
    aceitos: dict[str, set[str]] = {}
    julgados: set[frozenset[str]] = set()
    for d in decisoes:
        julgados.add(frozenset((d["a"], d["b"])))
        if d["decisao"]:
            aceitos.setdefault(d["a"], set()).add(d["b"])
            aceitos.setdefault(d["b"], set()).add(d["a"])
    novos: dict[frozenset[str], dict] = {}
    for meio, vizinhos in aceitos.items():
        for a, c in itertools.combinations(sorted(vizinhos), 2):
            par = frozenset((a, c))
            if par not in julgados and par not in novos:
                novos[par] = {
                    "a": a, "b": c, "razoes": ["fechamento"], "via": meio,
                    "similaridade": round(cosseno(vetores[a], vetores[c]), 4),
                }  # fmt: skip
    return sorted(novos.values(), key=lambda p: (p["a"], p["b"]))


def componentes(decisoes: list[dict]) -> tuple[list[list[str]], list[list[str]]]:
    """Grupos de ids a fundir e os conjuntos contraditórios, que o juiz não aceitou por inteiro.

    Os pares aceitos entram do mais parecido para o menos (empate pelo id), e dois grupos só se unem se nenhum
    par entre eles foi julgado "não": com os pares de `fechamento` já julgados, isso é ligação completa, e uma
    ponte não funde o que o juiz separou. Num conjunto de aceitos ligados entre si que acabou em mais de um
    grupo, o que ficou de fora é um conflito (o juiz se contradisse): sai no plano para revisão."""
    aceitos = sorted(
        (d for d in decisoes if d["decisao"]), key=lambda d: (-d["similaridade"], d["a"], d["b"])
    )
    nao = {frozenset((d["a"], d["b"])) for d in decisoes if not d["decisao"]}
    grupo: dict[str, set[str]] = {}
    for d in aceitos:
        ga = grupo.setdefault(d["a"], {d["a"]})
        gb = grupo.setdefault(d["b"], {d["b"]})
        if ga is gb or any(frozenset((x, y)) in nao for x in ga for y in gb):
            continue
        uniao = ga | gb
        for x in uniao:
            grupo[x] = uniao
    limpos = {tuple(sorted(g)) for g in grupo.values() if len(g) > 1}

    pai: dict[str, str] = {}

    def raiz(x: str) -> str:
        pai.setdefault(x, x)
        while pai[x] != x:
            pai[x] = pai[pai[x]]
            x = pai[x]
        return x

    for d in aceitos:
        pai[raiz(d["a"])] = raiz(d["b"])
    ligados: dict[str, set[str]] = {}
    for x in list(pai):
        ligados.setdefault(raiz(x), set()).add(x)
    conflitos = [sorted(c) for c in ligados.values() if any(grupo[x] != c for x in c)]
    return sorted([list(g) for g in limpos]), sorted(conflitos)


def sobrevivente(grupo: list[str], por_id: dict[str, dict]) -> str:
    """Quem fica: o mais citado (fatos + menções); empate pelo nome mais completo e depois pelo id."""

    def peso(i: str) -> tuple:
        e = por_id[i]
        return (
            -(e.get("fatos", 0) + e.get("mencoes", 0)),
            -len(significativos(e["name"])),
            -len(e["name"]),
            i,
        )

    return sorted(grupo, key=peso)[0]


def plano(decisoes: list[dict], por_id: dict[str, dict]) -> dict:
    limpos, conflitos = componentes(decisoes)
    redirecionar: dict[str, str] = {}
    nomes: dict[str, str] = {}
    fusoes = []
    for g in limpos:
        fica = sobrevivente(g, por_id)
        nomes[fica] = por_id[fica]["name"]
        for i in g:
            if i != fica:
                redirecionar[i] = fica
        fusoes.append({"fica": fica, "absorvidos": [i for i in g if i != fica]})
    return {"redirecionar": redirecionar, "nomes": nomes, "fusoes": fusoes, "conflitos": conflitos}


def a_desfazer(no_grafo: list[dict], redirecionar: dict[str, str]) -> list[str]:
    """Sobreviventes de uma fusão anterior cujo conjunto de absorvidos não é o do plano atual.

    Esses nós saem do grafo e o importador os recria já com o plano novo: o `mergeNodes` não tem volta, e o
    importador só acrescenta (uma aresta herdada da fusão antiga ficaria no nó)."""
    esperado: dict[str, list[str]] = {}
    for fora, fica in redirecionar.items():
        esperado.setdefault(fica, []).append(fora)
    return sorted(n["id"] for n in no_grafo if sorted(n["absorbedIds"]) != sorted(esperado.get(n["id"], [])))


def reconciliar(driver: Any, redirecionar: dict[str, str], banco: str = "neo4j") -> int:
    registros, _, _ = driver.execute_query(
        "MATCH (e:__Entity__) WHERE e.absorbedIds IS NOT NULL "
        "RETURN e.id AS id, e.absorbedIds AS absorbedIds",
        database_=banco,
    )
    ids = a_desfazer([dict(r) for r in registros], redirecionar)
    if ids:
        driver.execute_query(
            "MATCH (e:__Entity__) WHERE e.id IN $ids DETACH DELETE e", {"ids": ids}, database_=banco
        )
    return len(ids)


def fundir(driver: Any, fusoes: list[dict], banco: str = "neo4j") -> int:
    """`apoc.refactor.mergeNodes` por grupo: o primeiro nó da lista fica, as relações iguais se unem.

    Os rótulos dos absorvidos vão junto na fusão; quando o grupo junta tipos diferentes, o nó fica só com o
    rótulo do sobrevivente (o id guarda o rótulo: `ent:<rotulo>:<hash>`)."""
    feitas = 0
    for f in fusoes:
        driver.execute_query(
            "MATCH (k:__Entity__ {id: $fica}) "
            "MATCH (o:__Entity__) WHERE o.id IN $fora "
            "WITH k, collect(o) AS fora "
            "CALL apoc.refactor.mergeNodes([k] + fora, {properties: 'discard', mergeRels: true}) YIELD node "
            "WITH node, [l IN labels(node) WHERE l <> '__Entity__' AND toLower(l) <> $rotulo] AS extras "
            "CALL apoc.create.removeLabels(node, extras) YIELD node AS limpo "
            "RETURN limpo.id",
            {"fica": f["fica"], "fora": f["absorvidos"], "rotulo": f["fica"].split(":")[1]},
            database_=banco,
        )
        # uma relação entre dois absorvidos (ou entre eles e o sobrevivente) vira laço; o importador já as
        # descarta, e aqui saem as que a fusão acabou de criar
        driver.execute_query(
            "MATCH (n:__Entity__ {id: $fica})-[x]->(n) DELETE x", {"fica": f["fica"]}, database_=banco
        )
        feitas += len(f["absorvidos"])
    return feitas


def ler_entidades(driver: Any, banco: str = "neo4j") -> list[dict]:
    """As entidades do grafo com o necessário para julgar: rótulo, campos, contagens e um trecho de origem."""
    registros, _, _ = driver.execute_query(
        "MATCH (e:__Entity__) "
        "WITH e, [l IN labels(e) WHERE l <> '__Entity__'][0] AS label "
        "OPTIONAL MATCH (u)<-[:MENTIONED_IN|DESCRIBED_IN]-(e) "
        "WITH e, label, u ORDER BY u.id "
        "WITH e, label, collect(u)[0] AS u "
        "RETURN e.id AS id, label, e.name AS name, e.roles AS roles, e.description AS description, "
        "e.descriptions AS descriptions, e.cnpj AS cnpj, e.ticker AS ticker, e.aliases AS aliases, "
        "count { (:FinancialFact)-[:ABOUT]->(e) } AS fatos, "
        "count { (e)-[:MENTIONED_IN|DESCRIBED_IN]->() } AS mencoes, "
        "coalesce(u.text, u.markdown, '') AS texto",
        database_=banco,
    )
    saida = []
    for r in registros:
        e = dict(r)
        texto = e.pop("texto")
        e["trecho"] = trecho(texto, e["name"])
        saida.append(e)
    return saida


def trecho(texto: str, nome: str, folga: int = 160) -> str:
    """Até 2×folga caracteres em volta da primeira ocorrência do nome (ou o começo do texto)."""
    if not texto:
        return ""
    i = texto.lower().find((nome or "").lower())
    ini = max(0, i - folga) if i >= 0 else 0
    return re.sub(r"\s+", " ", texto[ini : ini + 2 * folga + len(nome or "")]).strip()


def embutir(
    entidades: list[dict], embute: Callable[[list[str]], list[list[float]]]
) -> dict[str, list[float]]:
    textos = [f"{e['name']}. {descricao_de(e)}".strip() for e in entidades]
    vetores: list[list[float]] = []
    for i in range(0, len(textos), 16):
        vetores += embute(textos[i : i + 16])
    return {e["id"]: v for e, v in zip(entidades, vetores, strict=True)}


def _arquivo_do_plano(prefixo: Path) -> Path:
    return Path(f"{prefixo}.resolucao.json")


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    from indexer.embeddings import MODELO_LOTE, embutidor_llama
    from indexer.grafo import conectar

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("planejar", "aplicar"))
    ap.add_argument("prefixo", type=Path)
    ap.add_argument("--doc-id", required=True)
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        if a.acao == "planejar":
            # o plano parte do grafo sem fusões: desfaz as que existirem (os nós fundidos são recriados pelo
            # importador, sem redirecionamento) para que planejar de novo dê sempre o mesmo resultado
            desfeitas = reconciliar(driver, {}, a.banco)
            carregar(driver, entradas(a.prefixo, a.doc_id, {}, {}), a.banco)
            entidades = ler_entidades(driver, a.banco)
            por_id = {e["id"]: e for e in entidades}
            vetores = embutir([e for e in entidades if valido(e)], embutidor_llama(a.swap, MODELO_LOTE))
            pares = candidatos(entidades, vetores)
            cache = a.prefixo.parent / "resolucao_cache"
            juiz = juiz_llama(a.swap)
            decisoes = julgar(pares, por_id, juiz, cache)
            fechados = 0
            for _ in range(3):  # cada rodada pode abrir pares novos; três bastam para grupos de poucos nomes
                faltam = fechamento(decisoes, vetores)
                if not faltam:
                    break
                fechados += len(faltam)
                pares += faltam
                decisoes += julgar(faltam, por_id, juiz, cache)
            p = plano(decisoes, por_id)
            saida = {
                "doc_id": a.doc_id, "limiares": {"bloco": LIMIAR_NO_BLOCO, "global": LIMIAR_GLOBAL},
                "entidades": {i: {"name": e["name"], "label": e["label"]} for i, e in por_id.items()},
                "decisoes": decisoes, **p,
            }  # fmt: skip
            _arquivo_do_plano(a.prefixo).write_text(json.dumps(saida, ensure_ascii=False, indent=1), "utf-8")
            sim = sum(d["decisao"] for d in decisoes)
            print(json.dumps({"fusoes_desfeitas": desfeitas, "candidatos": len(pares),
                              "do_fechamento": fechados, "sim": sim, "nao": len(pares) - sim,
                              "fusoes": len(p["fusoes"]), "absorvidos": len(p["redirecionar"]),
                              "conflitos": len(p["conflitos"])}, ensure_ascii=False))  # fmt: skip
        else:
            p = json.loads(_arquivo_do_plano(a.prefixo).read_text(encoding="utf-8"))
            linhas = entradas(a.prefixo, a.doc_id, p["redirecionar"], p["nomes"])
            antes = contagens(driver, a.banco)
            refeitos = reconciliar(driver, p["redirecionar"], a.banco)
            absorvidos = fundir(driver, p["fusoes"], a.banco)
            carregar(driver, linhas, a.banco)
            meio = contagens(driver, a.banco), impressao_digital(driver, a.banco)
            carregar(driver, linhas, a.banco)
            fim = contagens(driver, a.banco), impressao_digital(driver, a.banco)
            saida = {"refeitos": refeitos, "absorvidos": absorvidos, "antes": antes, "depois": fim[0],
                     "reimportar_nao_muda": meio == fim, "impressao_digital": fim[1]}  # fmt: skip
            print(json.dumps(saida, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
