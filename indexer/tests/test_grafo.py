import re
from pathlib import Path

from indexer.grafo import (
    CONSTRAINTS,
    PASSOS,
    SANIDADE,
    aplicar_constraints,
    carregar,
    conferir_com_arquivo,
    ler_env,
    preparar,
    sanidade,
)

ARQUITETURA = Path(__file__).resolve().parents[2] / "docs" / "ARQUITETURA.md"

ARVORE = [
    {
        "id": "s1",
        "numero": "1",
        "titulo": "Riscos",
        "nivel": 1,
        "pai": None,
        "caminho": ["Riscos"],
        "pagina_inicio": 4,
        "pagina_fim": 6,
    },
    {
        "id": "s2",
        "numero": "1.1",
        "titulo": "Câmbio",
        "nivel": 2,
        "pai": "s1",
        "caminho": ["Riscos", "Câmbio"],
        "pagina_inicio": 5,
        "pagina_fim": 6,
    },
    {
        "id": "s3",
        "numero": "2",
        "titulo": "Negócios",
        "nivel": 1,
        "pai": None,
        "caminho": ["Negócios"],
        "pagina_inicio": 7,
        "pagina_fim": 7,
    },
]
CHUNKS = {
    "pais": [
        {
            "id": "p1",
            "secao_id": "s1",
            "ordem": 1,
            "texto": "um",
            "tokens": 5,
            "pagina_inicio": 4,
            "pagina_fim": 4,
        },
        {
            "id": "p2",
            "secao_id": "s2",
            "ordem": 1,
            "texto": "dois",
            "tokens": 6,
            "pagina_inicio": 5,
            "pagina_fim": 6,
        },
        {
            "id": "p3",
            "secao_id": "s3",
            "ordem": 1,
            "texto": "tres",
            "tokens": 7,
            "pagina_inicio": 7,
            "pagina_fim": 7,
        },
    ],
    "filhos": [
        {
            "id": "c1",
            "pai_id": "p1",
            "ordem": 1,
            "texto": "Riscos\num",
            "tokens": 8,
            "pagina_inicio": 4,
            "pagina_fim": 4,
        },
        {
            "id": "c2",
            "pai_id": "p2",
            "ordem": 1,
            "texto": "Riscos › Câmbio\ndois",
            "tokens": 9,
            "pagina_inicio": 5,
            "pagina_fim": 6,
        },
        {
            "id": "c3",
            "pai_id": "p3",
            "ordem": 1,
            "texto": "Negócios\ntres",
            "tokens": 7,
            "pagina_inicio": 7,
            "pagina_fim": 7,
        },
    ],
}
DOC = {
    "id": "doc",
    "title": "T",
    "issuer": "E",
    "fiscalYear": 2025,
    "language": "pt-BR",
    "sourceFile": "a.pdf",
    "pages": 10,
    "pagesIndexed": 4,
}


class DriverFalso:
    def __init__(self, respostas=None):
        self.chamadas: list[tuple[str, dict | None]] = []
        self.respostas = respostas or {}

    def execute_query(self, cypher, parametros=None, database_=None):
        self.chamadas.append((cypher, parametros))
        return [[self.respostas.get(cypher, 0)]], None, None


def test_constraints_sao_exatamente_as_da_secao_6_3_da_arquitetura():
    texto = ARQUITETURA.read_text(encoding="utf-8")
    secao = re.sub(r"\s+", " ", texto[texto.index("### 6.3") : texto.index("### 6.4")])
    do_doc = re.findall(
        r"CREATE CONSTRAINT (\w+) IF NOT EXISTS FOR \((n:\S+)\)\s+REQUIRE (n\.\w+) IS UNIQUE", secao
    )
    do_codigo = [
        re.match(
            r"CREATE CONSTRAINT (\w+) IF NOT EXISTS FOR \((n:\S+)\) REQUIRE (n\.\w+) IS UNIQUE", c
        ).groups()
        for c in CONSTRAINTS
    ]
    assert len(do_doc) == 11 and do_codigo == do_doc


def test_preparar_liga_secoes_pais_filhos_e_encadeia_os_pais_em_ordem_de_leitura():
    r = preparar(CHUNKS, ARVORE, DOC)
    assert [s["id"] for s in r["secoes"]] == ["doc:s1", "doc:s2", "doc:s3"]
    assert r["secoes"][1]["path"] == "Riscos › Câmbio" and r["secoes"][1]["level"] == 2
    assert r["tem_secao"] == [{"de": "doc", "para": "doc:s1"}, {"de": "doc", "para": "doc:s3"}]
    assert r["tem_subsecao"] == [{"de": "doc:s1", "para": "doc:s2"}]
    assert r["tem_pai"] == [
        {"de": "doc:s1", "para": "p1"},
        {"de": "doc:s2", "para": "p2"},
        {"de": "doc:s3", "para": "p3"},
    ]
    assert r["tem_filho"][1] == {"de": "p2", "para": "c2"}
    assert r["next"] == [{"de": "p1", "para": "p2"}, {"de": "p2", "para": "p3"}]
    assert r["pais"][1] == {
        "id": "p2",
        "text": "dois",
        "tokens": 6,
        "pageStart": 5,
        "pageEnd": 6,
        "ordinal": 1,
    }


def test_carregar_manda_nos_antes_das_relacoes_e_divide_em_lotes():
    driver = DriverFalso()
    linhas = preparar(CHUNKS, ARVORE, DOC)
    enviadas = carregar(driver, linhas, lote=2)
    assert enviadas == {k: len(linhas[k]) for k, _ in PASSOS}
    ordem = [
        c.split("MERGE")[1].split("{")[0].strip() if "(n:" in c else c.split("MERGE")[1].strip()[:30]
        for c, _ in driver.chamadas
    ]
    assert ordem[0].startswith("(n:Document") and ordem[1].startswith("(n:Section")
    rotulos_dos_nos = [i for i, (c, _) in enumerate(driver.chamadas) if "MERGE (n:" in c]
    primeira_relacao = next(i for i, (c, _) in enumerate(driver.chamadas) if "MERGE (a)-" in c)
    assert max(rotulos_dos_nos) < primeira_relacao
    # 3 secoes com lote 2 → 2 chamadas; 2 relacoes next → 1 chamada
    assert sum(1 for c, _ in driver.chamadas if "MERGE (n:Section" in c) == 2
    assert all(len(p["rows"]) <= 2 for _, p in driver.chamadas)


def test_carregar_e_idempotente_na_forma_so_usa_merge_por_id():
    for _, cypher in PASSOS:
        assert "CREATE" not in cypher and "MERGE" in cypher


def test_aplicar_constraints_manda_as_onze():
    driver = DriverFalso()
    assert aplicar_constraints(driver) == 11 and len(driver.chamadas) == 11


def test_sanidade_roda_todas_as_consultas_e_conferencia_compara_com_o_arquivo():
    respostas = {
        "MATCH (n:Section) RETURN count(n)": 3,
        "MATCH (n:Parent) RETURN count(n)": 3,
        "MATCH (n:Child) RETURN count(n)": 3,
        "MATCH ()-[r:HAS_PARENT]->() RETURN count(r)": 3,
        "MATCH ()-[r:HAS_CHILD]->() RETURN count(r)": 3,
        "MATCH ()-[r:NEXT]->() RETURN count(r)": 2,
        "MATCH ()-[r:HAS_SECTION]->() RETURN count(r)": 2,
        "MATCH ()-[r:HAS_SUBSECTION]->() RETURN count(r)": 1,
        "SHOW CONSTRAINTS YIELD type WHERE type CONTAINS 'UNIQUENESS' RETURN count(*)": 11,
    }
    resultado = sanidade(DriverFalso(respostas))
    assert set(resultado["problemas"]) == set(SANIDADE) and not any(resultado["problemas"].values())
    conf = conferir_com_arquivo(resultado, CHUNKS, ARVORE)
    assert all(v["ok"] for v in conf.values()), conf


def test_conferencia_acusa_diferenca_de_contagem():
    resultado = {
        "contagens": {
            "secoes": 3,
            "pais": 2,
            "filhos": 3,
            "tem_pai": 3,
            "tem_filho": 3,
            "next": 2,
            "tem_secao": 2,
            "constraints_de_unicidade": 11,
            "tem_subsecao": 1,
        }
    }
    conf = conferir_com_arquivo(resultado, CHUNKS, ARVORE)
    assert conf["pais"]["ok"] is False and conf["filhos"]["ok"] is True


def test_ler_env_ignora_comentarios_e_nao_expoe_nada_alem_do_pedido(tmp_path):
    arq = tmp_path / ".env"
    arq.write_text("\ufeff# c\nNEO4J_USER=neo4j\n\nNEO4J_PASSWORD=abc=123\n", encoding="utf-8")
    assert ler_env(arq) == {"NEO4J_USER": "neo4j", "NEO4J_PASSWORD": "abc=123"}
    assert ler_env(tmp_path / "nao-existe") == {}
