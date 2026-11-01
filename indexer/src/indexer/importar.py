"""Importação da extração dirigida no Neo4j com MERGE e IDs determinísticos (ARQUITETURA §5 I-5, tarefa F4.4).

Entram os fatos que passaram no lastro (F4.3) e as seis entidades de domínio extraídas (organizações, pessoas,
segmentos, fatores de risco, eventos e instrumentos), todas com o rótulo `__Entity__`. Cada nó tem id derivado
do conteúdo (hash), nunca `randomUUID()`; por isso rodar duas vezes não muda nenhuma contagem
([ADR-035](../../../docs/adr/ADR-035-importacao-idempotente.md)).

- **Fato:** o id é o hash de documento + unidade de origem (Pai ou Tabela) + métrica + período + entidade +
  segmento + valor + evidência. A chave "documento + página + métrica + período + entidade" da §5 fundia fatos
  diferentes (medido: 46 dos 807 aceitos). Escala e unidade ficam fora da chave: corrigir a escala de um fato
  depois (a tabela de risco de mercado não declara a unidade) atualiza o nó em vez de duplicá-lo.
- **Entidade:** o id é o hash do tipo e do nome normalizado (sem caixa, acento nem pontuação); os nomes
  escritos de outro jeito viram `aliases`. Variantes que a normalização não une ("BB" e "Banco do Brasil")
  ficam separadas até a F4.5.
- **Unidade monetária não declarada:** fato em moeda com escala 1, valor inteiro e nenhuma escala no texto
  recebido pelo modelo ganha `unitDeclared = false`. O valor não é convertido (ADR-034).

Precisa do Neo4j no ar (`infra\\neo4j.ps1 iniciar`); não usa LLM. Uso, a partir de `indexer/`:
    uv run python -m indexer.importar executar ../data/parsed/ARQUIVO --doc-id ID
    uv run python -m indexer.importar verificar ../data/parsed/ARQUIVO --doc-id ID
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from indexer.grafo import aplicar_constraints, conectar
from indexer.lastro import ACEITO, METRICAS_GENERICAS, _pedidos, escalas_do_contexto

LOTE = 500
GENERICAS = METRICAS_GENERICAS  # "Total" como entidade de um fato não é uma organização

TIPO_DA_ENTIDADE = {
    "Organization": "ORGANIZATION",
    "Person": "PERSON",
    "Segment": "SEGMENT",
    "RiskFactor": "RISK",
    "Event": "EVENT",
    "Instrument": "FINANCIAL_INSTRUMENT",
}
NOS = ("fatos", "periodos", *TIPO_DA_ENTIDADE)  # as demais chaves de `preparar` são relações


def normalizar(texto: str | None) -> str:
    """Minúsculas, sem acento, só letras e dígitos separados por um espaço."""
    sem_acento = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    return " ".join(re.findall(r"[a-z0-9]+", sem_acento.lower()))


def _hash(*partes: str) -> str:
    return hashlib.sha256("\x1f".join(partes).encode("utf-8")).hexdigest()[:16]


def id_do_fato(doc_id: str, unidade: str, fato: dict) -> str:
    """Id estável do fato: mesma extração, mesmo id; fatos diferentes na mesma unidade, ids diferentes."""
    return "fact:" + _hash(
        doc_id,
        unidade,
        normalizar(fato["metric"]),
        fato["period"],
        normalizar(fato["entity"]),
        normalizar(fato.get("segment")),
        repr(float(fato["value"])),
        normalizar(fato["evidence"]),
    )


def id_da_entidade(tipo: str, *nomes: str | None) -> str:
    return f"ent:{tipo.lower()}:" + _hash(tipo, *(normalizar(n) for n in nomes))


def limites_do_periodo(periodo: str) -> tuple[str, str]:
    """Início e fim (ISO) de `2025-FY`, `2025-Q4` ou `2025-12-31`; o exercício é o ano civil."""
    ano, resto = periodo.split("-", 1)
    if resto == "FY":
        return f"{ano}-01-01", f"{ano}-12-31"
    if resto.startswith("Q"):
        t = int(resto[1])
        fim_mes = 3 * t
        fim_dia = 31 if fim_mes in (3, 12) else 30
        return f"{ano}-{3 * t - 2:02d}-01", f"{ano}-{fim_mes:02d}-{fim_dia}"
    return periodo, periodo


def unidade_nao_declarada(fato: dict, pedido: str) -> bool:
    """Moeda sem escala, valor inteiro e nenhuma escala no texto: vale o número impresso, não "reais"."""
    return (
        fato["unit"] == "currency"
        and fato["scale"] == 1
        and float(fato["value"]).is_integer()
        and not escalas_do_contexto(pedido)
    )


def _sem_repeticao(linhas: list[dict]) -> list[dict]:
    vistos: set[tuple] = set()
    saida = []
    for x in linhas:
        k = tuple(sorted(x.items()))
        if k not in vistos:
            vistos.add(k)
            saida.append(x)
    return saida


class _Entidades:
    """Junta as menções do mesmo id: primeiro valor não nulo de cada campo, grafias e papéis em conjuntos."""

    def __init__(
        self, redirecionar: dict[str, str] | None = None, nomes: dict[str, str] | None = None
    ) -> None:
        # resolução de entidades (F4.5): id absorvido -> id que fica, e o nome canônico de quem fica
        self.redirecionar = redirecionar or {}
        self.nomes = nomes or {}
        self.por_id: dict[str, dict] = {}
        self.origens: dict[str, dict[str, set[str]]] = {
            "pai": {},
            "tabela": {},
        }  # tipo da unidade -> id -> unidades
        self.rotulo: dict[str, str] = {}

    def somar(
        self, rotulo: str, nome: str, unidade: str, tipo_unidade: str, chave: tuple = (), **campos: Any
    ) -> str:
        """Registra uma menção de `nome` na unidade e devolve o id; `chave` acrescenta campos ao hash."""
        id_ = id_da_entidade(rotulo, nome, *chave)
        id_ = self.redirecionar.get(id_, id_)
        e = self.por_id.setdefault(id_, {"id": id_, "name": nome, "aliases": set(), "papeis": set()})
        self.rotulo[id_] = rotulo
        e["aliases"].add(nome.strip())
        for k, v in campos.items():
            if k == "papel":
                if v:
                    e["papeis"].add(v)
            elif v is not None and k not in e:
                e[k] = v
        self.origens[tipo_unidade].setdefault(id_, set()).add(unidade)
        return id_

    def linhas(self) -> dict[str, list[dict]]:
        por_rotulo: dict[str, list[dict]] = {r: [] for r in TIPO_DA_ENTIDADE}
        absorvidos: dict[str, list[str]] = {}
        for fora, fica in self.redirecionar.items():
            absorvidos.setdefault(fica, []).append(fora)
        for id_, e in sorted(self.por_id.items()):
            aliases = sorted(e["aliases"])
            papeis = sorted(e["papeis"])
            rotulo = self.rotulo[id_]
            props = {
                **{k: v for k, v in e.items() if k not in ("aliases", "papeis")},
                "type": TIPO_DA_ENTIDADE[rotulo],
                "aliases": aliases,
                "aliasesText": " | ".join(aliases),
            }
            if papeis:
                props["roles"] = papeis
            if id_ in self.nomes:
                props["name"] = self.nomes[id_]
            if id_ in absorvidos:
                props["absorbedIds"] = sorted(absorvidos[id_])
            por_rotulo[rotulo].append({"id": id_, "props": props})
        return por_rotulo


def preparar(
    registros: list[dict],
    resultados: list[dict],
    pedidos: dict[str, str],
    doc_id: str,
    redirecionar: dict[str, str] | None = None,
    nomes: dict[str, str] | None = None,
) -> dict:
    """Linhas prontas para os UNWIND: nós (`fatos`, `periodos`, uma lista por rótulo de entidade) e relações.

    `registros` vêm do lastro (`<prefixo>.fatos.json`); só `aceito` entra. `resultados` são as unidades da
    extração (`<prefixo>.extracao.json`), de onde vêm as entidades; unidades inválidas não contribuem.
    `redirecionar` e `nomes` vêm da resolução de entidades (`<prefixo>.resolucao.json`, ADR-036): os ids
    absorvidos viram o id que ficou, para que reimportar depois da fusão não recrie os nós fundidos.
    """
    ent = _Entidades(redirecionar, nomes)
    fatos: dict[str, dict] = {}
    periodos: dict[str, dict] = {}
    reported_in: dict[str, list[dict]] = {"pai": [], "tabela": []}
    about: list[dict] = []
    for_period: list[dict] = []
    relacoes_entre_entidades: dict[str, list[dict]] = {
        k: [] for k in ("holds_position", "has_segment", "affects", "involves", "issued_by")
    }

    def org(nome: str | None, unidade: str, tipo_unidade: str) -> str | None:
        if not nome or normalizar(nome) in GENERICAS or not normalizar(nome):
            return None
        return ent.somar("Organization", nome, unidade, tipo_unidade)

    for r in registros:
        if r["motivo"] != ACEITO:
            continue
        f, unidade, tipo = r["fato"], r["unidade"], r["tipo"]
        fid = id_do_fato(doc_id, unidade, f)
        if fid in fatos:  # fato idêntico na mesma unidade: fundido de propósito
            continue
        props = {
            "id": fid,
            "metric": f["metric"],
            "value": f["value"],
            "unit": f["unit"],
            "currency": f.get("currency"),
            "scale": f["scale"],
            "period": f["period"],
            "periodType": f["period_type"],
            "entity": f["entity"],
            "segment": f.get("segment"),
            "evidence": f["evidence"],
            "page": r["paginas"][0],
            "pageEnd": r["paginas"][1],
            "documentId": doc_id,
            "unitDeclared": not unidade_nao_declarada(f, pedidos[unidade]),
        }
        fatos[fid] = {"id": fid, "props": props}
        reported_in[tipo].append({"de": fid, "para": unidade})
        alvo = org(f["entity"], unidade, tipo)
        if alvo:
            about.append({"de": fid, "para": alvo})
        inicio, fim = limites_do_periodo(f["period"])
        periodos[f["period"]] = {"id": f["period"], "start": inicio, "end": fim}
        for_period.append({"de": fid, "para": f["period"]})

    for r in resultados:
        if not r["valida"]:
            continue
        unidade, tipo, resp = r["id"], r["tipo"], r["resposta"]
        for o in resp["organizations"]:
            ent.somar(
                "Organization", o["name"], unidade, tipo,
                papel=o["role"], description=o.get("description"), cnpj=o.get("cnpj"), ticker=o.get("ticker"),
            )  # fmt: skip
        for p in resp["people"]:
            pid = ent.somar("Person", p["name"], unidade, tipo, position=p.get("position"))
            alvo = org(p.get("organization"), unidade, tipo)
            if alvo and p.get("position"):
                relacoes_entre_entidades["holds_position"].append(
                    {"de": pid, "para": alvo, "title": p["position"]}
                )
        for s in resp["segments"]:
            sid = ent.somar(
                "Segment",
                s["name"],
                unidade,
                tipo,
                (s.get("organization"),),
                description=s.get("description"),
            )
            alvo = org(s.get("organization"), unidade, tipo)
            if alvo:
                relacoes_entre_entidades["has_segment"].append({"de": alvo, "para": sid})
        for k in resp["risk_factors"]:
            kid = ent.somar(
                "RiskFactor", k["name"], unidade, tipo, (k["category"],),
                category=k["category"], description=k["description"],
            )  # fmt: skip
            alvo = org(k.get("affected_entity"), unidade, tipo)
            if alvo:
                relacoes_entre_entidades["affects"].append({"de": kid, "para": alvo})
        for e in resp["events"]:
            eid = ent.somar(
                "Event", e["description"], unidade, tipo, (doc_id, unidade, e["type"]),
                eventType=e["type"], date=e.get("date"),
            )  # fmt: skip
            for nome in e["organizations"]:
                alvo = org(nome, unidade, tipo)
                if alvo:
                    relacoes_entre_entidades["involves"].append({"de": eid, "para": alvo})
        for i in resp["instruments"]:
            iid = ent.somar(
                "Instrument", i["name"], unidade, tipo, (i["type"],),
                instrumentType=i["type"], maturity=i.get("maturity"), description=i.get("description"),
            )  # fmt: skip
            alvo = org(i.get("issuer"), unidade, tipo)
            if alvo:
                relacoes_entre_entidades["issued_by"].append({"de": iid, "para": alvo})

    riscos = {i for i, rot in ent.rotulo.items() if rot == "RiskFactor"}
    mentioned: dict[str, list[dict]] = {"pai": [], "tabela": []}
    described: dict[str, list[dict]] = {"pai": [], "tabela": []}
    for tipo, mapa in ent.origens.items():
        for id_, unidades in sorted(mapa.items()):
            destino = described if id_ in riscos else mentioned
            destino[tipo].extend({"de": id_, "para": u} for u in sorted(unidades))
    linhas = {
        "fatos": [fatos[k] for k in sorted(fatos)],
        "periodos": [periodos[k] for k in sorted(periodos)],
        **ent.linhas(),
        "reported_in_pai": reported_in["pai"],
        "reported_in_tabela": reported_in["tabela"],
        "about": about,
        "for_period": for_period,
        "mentioned_in_pai": mentioned["pai"],
        "mentioned_in_tabela": mentioned["tabela"],
        "described_in_pai": described["pai"],
        "described_in_tabela": described["tabela"],
        **relacoes_entre_entidades,
    }
    for (
        chave
    ) in linhas:  # a mesma relação pode vir de várias menções; o MERGE a une, mas não a mande duas vezes
        if chave not in NOS:
            linhas[chave] = _sem_repeticao(linhas[chave])
    return linhas


def _nos_entidade(rotulo: str) -> str:
    return f"UNWIND $rows AS r MERGE (n:__Entity__ {{id: r.id}}) SET n:{rotulo}, n += r.props"


def _relacao(de: str, tipo: str, para: str, extra: str = "") -> str:
    return (
        f"UNWIND $rows AS r MATCH (a:{de} {{id: r.de}}), (b:{para} {{id: r.para}}) "
        f"MERGE (a)-[:{tipo}{extra}]->(b)"
    )


# ordem importa: nós antes das relações
PASSOS = [
    ("periodos", "UNWIND $rows AS r MERGE (n:Period {id: r.id}) SET n += r"),
    ("fatos", "UNWIND $rows AS r MERGE (n:FinancialFact {id: r.id}) SET n += r.props"),
    *[(rotulo, _nos_entidade(rotulo)) for rotulo in TIPO_DA_ENTIDADE],
    ("reported_in_pai", _relacao("FinancialFact", "REPORTED_IN", "Parent")),
    ("reported_in_tabela", _relacao("FinancialFact", "REPORTED_IN", "Table")),
    ("about", _relacao("FinancialFact", "ABOUT", "__Entity__")),
    ("for_period", _relacao("FinancialFact", "FOR_PERIOD", "Period")),
    ("mentioned_in_pai", _relacao("__Entity__", "MENTIONED_IN", "Parent")),
    ("mentioned_in_tabela", _relacao("__Entity__", "MENTIONED_IN", "Table")),
    ("described_in_pai", _relacao("__Entity__", "DESCRIBED_IN", "Parent")),
    ("described_in_tabela", _relacao("__Entity__", "DESCRIBED_IN", "Table")),
    ("holds_position", _relacao("__Entity__", "HOLDS_POSITION", "__Entity__", " {title: r.title}")),
    ("has_segment", _relacao("__Entity__", "HAS_SEGMENT", "__Entity__")),
    ("affects", _relacao("__Entity__", "AFFECTS", "__Entity__")),
    ("involves", _relacao("__Entity__", "INVOLVES", "__Entity__")),
    ("issued_by", _relacao("__Entity__", "ISSUED_BY", "__Entity__")),
]

CONTAGENS = {
    "fatos": "MATCH (n:FinancialFact) RETURN count(n)",
    "periodos": "MATCH (n:Period) RETURN count(n)",
    "entidades": "MATCH (n:__Entity__) RETURN count(n)",
    **{rotulo.lower(): f"MATCH (n:{rotulo}) RETURN count(n)" for rotulo in TIPO_DA_ENTIDADE},
    **{
        tipo.lower(): f"MATCH ()-[r:{tipo}]->() RETURN count(r)"
        for tipo in (
            "REPORTED_IN",
            "ABOUT",
            "FOR_PERIOD",
            "MENTIONED_IN",
            "DESCRIBED_IN",
            "HOLDS_POSITION",
            "HAS_SEGMENT",
            "AFFECTS",
            "INVOLVES",
            "ISSUED_BY",
        )
    },  # fmt: skip
    "fatos_com_unidade_nao_declarada": "MATCH (n:FinancialFact {unitDeclared: false}) RETURN count(n)",
}
# §6.4 e verificações extras: todas devem dar 0
SANIDADE = {
    "fatos_sem_origem": "MATCH (f:FinancialFact) WHERE NOT (f)-[:REPORTED_IN]->() RETURN count(f)",
    "fatos_sem_periodo": "MATCH (f:FinancialFact) WHERE NOT (f)-[:FOR_PERIOD]->() RETURN count(f)",
    "fatos_com_mais_de_uma_origem": (
        "MATCH (f:FinancialFact) WHERE count { (f)-[:REPORTED_IN]->() } <> 1 RETURN count(f)"
    ),
    "entidades_sem_origem": (
        "MATCH (e:__Entity__) WHERE NOT (e)-[:MENTIONED_IN|DESCRIBED_IN]->() RETURN count(e)"
    ),
    "entidades_sem_tipo": "MATCH (e:__Entity__) WHERE e.type IS NULL OR e.name IS NULL RETURN count(e)",
    "fatos_sem_documento": "MATCH (f:FinancialFact) WHERE f.documentId IS NULL RETURN count(f)",
}


def _escalar(driver: Any, cypher: str, banco: str) -> int:
    registros, _, _ = driver.execute_query(cypher, database_=banco)
    return int(registros[0][0])


def carregar(driver: Any, linhas: dict, banco: str = "neo4j", lote: int = LOTE) -> dict[str, int]:
    """Executa os passos em lotes e devolve quantas linhas cada passo enviou."""
    enviadas: dict[str, int] = {}
    for chave, cypher in PASSOS:
        for i in range(0, len(linhas[chave]), lote):
            driver.execute_query(cypher, {"rows": linhas[chave][i : i + lote]}, database_=banco)
        enviadas[chave] = len(linhas[chave])
    return enviadas


def contagens(driver: Any, banco: str = "neo4j") -> dict[str, int]:
    return {k: _escalar(driver, q, banco) for k, q in CONTAGENS.items()}


def sanidade(driver: Any, banco: str = "neo4j") -> dict[str, int]:
    return {k: _escalar(driver, q, banco) for k, q in SANIDADE.items()}


def impressao_digital(driver: Any, banco: str = "neo4j") -> str:
    """Hash dos nós e relações que o importador escreve, com propriedades: mais forte que contar."""
    nos, _, _ = driver.execute_query(
        "MATCH (n) WHERE n:FinancialFact OR n:__Entity__ OR n:Period "
        "RETURN n.id AS id, properties(n) AS p ORDER BY id",
        database_=banco,
    )
    rels, _, _ = driver.execute_query(
        "MATCH (a)-[r]->(b) WHERE a:FinancialFact OR a:__Entity__ "
        "RETURN type(r) AS t, a.id AS de, b.id AS para, properties(r) AS p ORDER BY t, de, para, p",
        database_=banco,
    )
    corpo = {
        "nos": [[r["id"], r["p"]] for r in nos],
        "relacoes": [[r["t"], r["de"], r["para"], r["p"]] for r in rels],
    }
    return hashlib.sha256(json.dumps(corpo, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def importar_duas_vezes(driver: Any, linhas: dict, banco: str = "neo4j") -> dict:
    """Aceite da F4.4: importa, conta, importa de novo e compara contagens e impressão digital."""
    aplicar_constraints(driver, banco)
    carregar(driver, linhas, banco)
    antes, marca_antes = contagens(driver, banco), impressao_digital(driver, banco)
    carregar(driver, linhas, banco)
    depois, marca_depois = contagens(driver, banco), impressao_digital(driver, banco)
    return {
        "antes": antes,
        "depois": depois,
        "iguais": antes == depois and marca_antes == marca_depois,
        "impressao_digital": [marca_antes, marca_depois],
        "diferencas": {k: [antes[k], depois[k]] for k in antes if antes[k] != depois[k]},
        "problemas": sanidade(driver, banco),
    }


def entradas(
    prefixo: Path,
    doc_id: str,
    redirecionar: dict[str, str] | None = None,
    nomes: dict[str, str] | None = None,
) -> dict:
    """As linhas do `<prefixo>`; sem `redirecionar`, usa o `<prefixo>.resolucao.json` se ele existir."""
    registros = json.loads(Path(f"{prefixo}.fatos.json").read_text(encoding="utf-8"))
    resultados = json.loads(Path(f"{prefixo}.extracao.json").read_text(encoding="utf-8"))
    arq = Path(f"{prefixo}.resolucao.json")
    if redirecionar is None and arq.exists():
        plano = json.loads(arq.read_text(encoding="utf-8"))
        redirecionar, nomes = plano["redirecionar"], plano["nomes"]
    return preparar(registros, resultados, _pedidos(prefixo), doc_id, redirecionar, nomes)


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("executar", "verificar"))
    ap.add_argument("prefixo", type=Path, help="ex.: ../data/parsed/bb_fre_2026_recorte")
    ap.add_argument("--doc-id", required=True)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    linhas = entradas(a.prefixo, a.doc_id)
    enviadas = {k: len(v) for k, v in linhas.items()}
    driver = conectar(a.raiz)
    try:
        if a.acao == "executar":
            aplicar_constraints(driver, a.banco)
            carregar(driver, linhas, a.banco)
            saida = {
                "enviadas": enviadas,
                "contagens": contagens(driver, a.banco),
                "problemas": sanidade(driver, a.banco),
            }
        else:
            saida = {"enviadas": enviadas, **importar_duas_vezes(driver, linhas, a.banco)}
        print(json.dumps(saida, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
