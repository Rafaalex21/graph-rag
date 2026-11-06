"""Text2Cypher (F6.4, ARQUITETURA §7.3): pergunta → prompt (esquema, terminologia, exemplos, formato) → LLM →
Cypher → execução somente leitura → linhas e evidências.

Formas de falhar, escritas antes do código (cada uma tem um teste abaixo):

 1. o LLM devolve o Cypher dentro de um bloco ```, com prosa antes, com "Cypher:" na frente ou com vários
    comandos, e o que vai ao banco não é só a primeira consulta;
 2. o LLM devolve vazio ou só prosa e a execução tenta rodar mesmo assim;
 3. o Cypher gerado tem erro e a exceção sobe até o roteador, em vez de um `erro` no resultado;
 4. a execução não usa sessão de leitura (um Cypher de escrita gerado alucinando passaria);
 5. a consulta devolve milhares de linhas e todas entram no contexto; ou o corte some sem aviso;
 6. o prompt esquece o esquema (rótulos, relações, propriedades), a terminologia PT↔EN das métricas, os
    exemplos ou a instrução de formato; ou leva `embedding` e textos longos e estoura o contexto;
 7. a APOC não responde e o prompt sai sem esquema, sem avisar;
 8. os exemplos *few-shot* repetem as perguntas de avaliação (o número medido seria vazamento);
 9. a medida de acerto aceita o valor por acaso (dezenas de linhas), erra por arredondamento de float ou
    não ignora acento/caixa no texto esperado;
10. o resultado sem página é tratado como citável; linhas vazias viram resposta em vez de aviso;
11. a pergunta vazia chama o LLM; o LLM que cai (timeout) derruba a chamada.
"""

import json
from pathlib import Path

import pytest

from indexer.text2cypher import (
    acerto,
    agrupar_relacoes,
    agrupar_rotulos,
    carregar_exemplos,
    executar,
    extrair_cypher,
    formatar_esquema,
    montar_prompt,
    perguntar,
    rotulos_candidatos,
    terminologia,
)

CAT = [
    {"id": "net_income", "name": "Net income", "name_pt": "Lucro líquido", "kind": "monetary",
     "aliases": ["lucro", "resultado líquido"]},
    {"id": "employee_headcount", "name": "Employee headcount", "name_pt": "Quantidade de empregados",
     "kind": "count", "aliases": ["empregados", "funcionários"]},
]  # fmt: skip

ESQUEMA = {
    "nos": {
        "FinancialFact": {"id": "STRING", "value": "FLOAT", "page": "INTEGER", "metric": "STRING",
                          "embedding": "LIST", "evidence": "STRING"},
        "Metric": {"id": "STRING", "name": "STRING", "namePt": "STRING"},
        "Parent": {"id": "STRING", "text": "STRING", "pageStart": "INTEGER"},
    },
    "relacoes": [("FinancialFact", "OF_METRIC", "Metric", {"qualifier": "STRING", "dimension": "STRING"})],
    "valores": {
        "OF_METRIC.qualifier": ["nenhum", "variacao_percentual"],
        "Period.id": ["2025-FY", "2025-Q4"],
    },
}  # fmt: skip


class Resultado:
    """O que `session.run` devolve: iterável de linhas e `consume()` com o resumo (plano e avisos)."""

    def __init__(self, linhas):
        self.linhas = linhas

    def __iter__(self):
        return iter(self.linhas)

    def consume(self):
        return type("Resumo", (), {"plan": None, "notifications": []})()


class Sessao:
    def __init__(self, linhas=None, falha=None):
        self.linhas, self.falha, self.consultas = linhas or [], falha, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, cypher, **kw):
        self.consultas.append((cypher, kw))
        if self.falha:
            raise self.falha
        return Resultado(self.linhas)


class BancoFalso:
    def __init__(self, linhas=None, falha=None):
        self.sessao = Sessao(linhas, falha)
        self.modos = []

    def session(self, **kw):
        self.modos.append(kw.get("default_access_mode"))
        return self.sessao


def gerador(resposta, chamadas=None):
    def gera(mensagens):
        if chamadas is not None:
            chamadas.append(mensagens)
        if isinstance(resposta, Exception):
            raise resposta
        return resposta

    return gera


# ---------- 1-2: extração do Cypher ----------


@pytest.mark.parametrize(
    "texto",
    [
        "MATCH (n) RETURN count(n) AS n",
        "```cypher\nMATCH (n) RETURN count(n) AS n\n```",
        "```\nMATCH (n) RETURN count(n) AS n;\n```\nEssa consulta conta os nós.",
        "Cypher: MATCH (n) RETURN count(n) AS n",
        "Aqui está a consulta:\n\nMATCH (n)\nRETURN count(n) AS n;",
        "MATCH (n) RETURN count(n) AS n; MATCH (m) DETACH DELETE m",
    ],
)
def test_extrai_so_a_primeira_consulta(texto):
    c = extrair_cypher(texto)
    assert c.replace("\n", " ").strip().startswith("MATCH (n)") and "DELETE" not in c and "```" not in c
    assert not c.endswith(";")


@pytest.mark.parametrize("texto", ["", "   ", "Não sei responder a essa pergunta.", "```\n```"])
def test_sem_cypher_e_erro_e_nao_chama_o_banco(texto):
    with pytest.raises(ValueError):
        extrair_cypher(texto)
    banco = BancoFalso()
    r = perguntar(banco, "quantos?", gerador(texto), esquema_texto="x", terminologia_texto="y", exemplos=[])
    assert r["erro"] == "sem_cypher" and r["evidencias"] == [] and banco.sessao.consultas == []


def test_ponto_e_virgula_dentro_de_string_nao_corta_a_consulta():
    c = extrair_cypher("MATCH (f) WHERE f.metric = 'a; b' RETURN f.value AS v;")
    assert "'a; b'" in c


# ---------- 3-5: execução ----------


def test_execucao_usa_sessao_de_leitura_e_tempo_limite():
    banco = BancoFalso([{"v": 1}])
    executar(banco, "MATCH (n) RETURN 1 AS v", timeout=7)
    consulta = banco.sessao.consultas[0][0]  # `Query`: kwargs de `run` seriam parâmetros, não tempo limite
    assert banco.modos == ["READ"] and consulta.timeout == 7 and consulta.text == "MATCH (n) RETURN 1 AS v"


def test_erro_do_banco_vira_erro_no_resultado():
    banco = BancoFalso(falha=RuntimeError("Invalid input 'RETURN'"))
    r = perguntar(
        banco,
        "quantos?",
        gerador("MATCH (n RETURN n"),
        esquema_texto="x",
        terminologia_texto="y",
        exemplos=[],
    )
    assert r["erro"].startswith("falha_na_execucao") and "Invalid input" in r["erro"] and r["linhas"] == []


def test_muitas_linhas_sao_cortadas_e_o_corte_e_informado():
    banco = BancoFalso([{"v": i} for i in range(500)])
    linhas, truncado = executar(banco, "MATCH (n) RETURN n.v AS v", limite_linhas=20)
    assert len(linhas) == 20 and truncado is True
    linhas2, truncado2 = executar(BancoFalso([{"v": 1}]), "MATCH (n) RETURN 1 AS v", limite_linhas=20)
    assert truncado2 is False and len(linhas2) == 1


def test_llm_que_cai_vira_erro_e_nao_excecao():
    banco = BancoFalso()
    r = perguntar(
        banco,
        "quantos?",
        gerador(TimeoutError("timeout")),
        esquema_texto="x",
        terminologia_texto="y",
        exemplos=[],
    )
    assert r["erro"].startswith("falha_no_llm") and banco.sessao.consultas == []


def test_pergunta_vazia_nao_chama_o_llm():
    chamadas: list = []
    r = perguntar(
        BancoFalso(),
        "  ",
        gerador("MATCH (n) RETURN n", chamadas),
        esquema_texto="x",
        terminologia_texto="y",
        exemplos=[],
    )
    assert r["erro"] == "pergunta_vazia" and chamadas == []


# ---------- 6-8: prompt, esquema e exemplos ----------


def test_esquema_formatado_traz_rotulos_relacoes_e_valores_sem_embeddings_nem_textos_longos():
    t = formatar_esquema(ESQUEMA)
    assert "FinancialFact" in t and "value: FLOAT" in t and "page: INTEGER" in t
    assert "(:FinancialFact)-[:OF_METRIC {qualifier: STRING, dimension: STRING}]->(:Metric)" in t
    assert "2025-FY" in t and "variacao_percentual" in t
    assert "embedding" not in t and "evidence" not in t  # lista e texto longo ficam fora
    assert "Parent" not in t or "text:" not in t


def test_relacoes_entre_muitos_tipos_de_entidade_viram_uma_linha_so():
    ents = {"Person", "Organization", "Event", "Policy", "Product"}
    rels = [(a, "RELATED_TO", b, {"strength": "INTEGER"}) for a in sorted(ents) for b in sorted(ents)]
    rels += [("Person", "HOLDS_POSITION", "Organization", {"title": "STRING"})]
    rels += [("FinancialFact", "OF_METRIC", "Metric", {})]
    agrupadas = agrupar_relacoes(rels, ents)
    assert ("Entidade", "RELATED_TO", "Entidade", {"strength": "INTEGER"}) in agrupadas
    assert sum(1 for r in agrupadas if r[1] == "RELATED_TO") == 1
    assert (
        "Person",
        "HOLDS_POSITION",
        "Organization",
        {"title": "STRING"},
    ) in agrupadas  # poucos pares: fica
    assert ("FinancialFact", "OF_METRIC", "Metric", {}) in agrupadas
    texto = formatar_esquema({"nos": {}, "relacoes": agrupadas, "valores": {}, "entidades": sorted(ents)})
    assert "Entidade = qualquer um destes rótulos: Event, Organization" in texto


def test_rotulos_de_fatos_agrupam_familias_e_respeitam_o_teto():
    faixas = [f"Percentual mínimo de provisão para carteira C{i}" for i in range(30)]
    rotulos = ["Empregados Branco", "Empregados Pardo", *faixas]
    r = agrupar_rotulos(rotulos, por_familia=3)
    assert "Empregados Branco" in r and "Empregados Pardo" in r
    assert sum(x.startswith("Percentual mínimo") for x in r) == 3  # só três da família
    assert any(x.startswith("(+27 rótulos semelhantes") for x in r)  # e a contagem do resto
    assert len(" | ".join(agrupar_rotulos(rotulos, max_chars=60))) <= 60 + 3 * len(rotulos)
    texto = formatar_esquema({"nos": {}, "relacoes": [], "valores": {}, "rotulos": r})
    assert "Empregados Branco" in texto and "copie o texto exato" in texto


ROTULOS = [
    "Empregados Pardo",
    "Empregados em posições de liderança - Pardo",
    "Empregados em posições de não-liderança - Pardo",
    "Empregados em posições de não-liderança - Preto",
    "Quantidade de terceirizados por localização geográfica - Sul",
    "Quantidade de terceirizados por localização geográfica - TOTAL DE TERCEIRIZADOS",
    "Lucro Líquido",
]


def test_candidatos_trazem_os_rotulos_certos_sem_depender_de_acento_ou_plural():
    r = rotulos_candidatos("Quantos empregados pardos há em posições de NAO-LIDERANCA?", ROTULOS, k=2)
    assert r[0] == "Empregados em posições de não-liderança - Pardo"
    assert "Empregados em posições de liderança - Pardo" not in r[:1]
    assert rotulos_candidatos("terceirizados no Sul", ROTULOS, k=3)[0].endswith("- Sul")


def test_candidatos_sem_palavra_em_comum_ou_sem_rotulos_voltam_vazios():
    assert rotulos_candidatos("qual a cor do céu?", ROTULOS) == []
    assert rotulos_candidatos("lucro", []) == []
    assert rotulos_candidatos("", ROTULOS) == []


def test_prompt_poe_os_candidatos_antes_da_pergunta_e_deixa_o_sistema_igual():
    a = montar_prompt("Pergunta A?", "E", "T", [], ["Rótulo X"])
    b = montar_prompt("Pergunta B?", "E", "T", [], ["Rótulo Y"])
    assert a[0] == b[0]  # o prefixo é o mesmo: o cache do llama.cpp o reaproveita
    assert a[1]["content"].index("Rótulo X") < a[1]["content"].index("Pergunta A?")
    assert a[1]["content"].strip().endswith("Pergunta A?")


def test_esquema_lista_os_recortes_de_cada_metrica():
    texto = formatar_esquema(
        {
            "nos": {},
            "relacoes": [],
            "valores": {},
            "recortes": {"Average individual compensation": ["Conselho Fiscal"]},
        }
    )
    assert "Average individual compensation: Conselho Fiscal" in texto


def test_terminologia_liga_o_termo_em_portugues_ao_nome_do_grafo():
    t = terminologia(CAT)
    assert "Net income" in t and "Lucro líquido" in t and "lucro" in t and "resultado líquido" in t
    assert "Employee headcount" in t and "funcionários" in t


def test_prompt_leva_esquema_terminologia_exemplos_e_formato():
    exemplos = [{"pergunta": "Quantos X?", "cypher": "MATCH (n) RETURN count(n) AS total"}]
    msgs = montar_prompt("Qual o lucro?", "ESQUEMA-AQUI", "TERMOS-AQUI", exemplos)
    sistema, usuario = msgs[0]["content"], msgs[-1]["content"]
    assert msgs[0]["role"] == "system" and msgs[-1]["role"] == "user"
    for esperado in ("ESQUEMA-AQUI", "TERMOS-AQUI", "Quantos X?", "RETURN count(n) AS total"):
        assert esperado in sistema
    assert "SOMENTE CYPHER" in sistema and "SEM BLOCOS DE CÓDIGO" in sistema
    assert "f.page AS pagina" in sistema and usuario.strip().endswith("Qual o lucro?")


def test_exemplos_do_repositorio_sao_validos_e_nao_repetem_perguntas_de_avaliacao():
    exemplos = carregar_exemplos()
    assert len(exemplos) >= 6
    for e in exemplos:
        assert e["pergunta"].strip() and e["cypher"].strip().upper().startswith(("MATCH", "WITH", "CALL"))
        assert "DELETE" not in e["cypher"].upper() and "MERGE" not in e["cypher"].upper()
    from indexer.importar import normalizar

    avaliacao = Path(__file__).resolve().parents[2] / "eval"
    perguntas = set()
    import csv

    for nome in ("golden.csv", "golden_agregacao.csv"):
        arq = avaliacao / nome
        if arq.exists():
            with open(arq, encoding="utf-8") as f:
                perguntas |= {normalizar(r["pergunta"]) for r in csv.DictReader(f)}
    assert not ({normalizar(e["pergunta"]) for e in exemplos} & perguntas)


def test_o_prompt_vai_ao_llm_com_a_pergunta_do_usuario():
    chamadas: list = []
    banco = BancoFalso([{"v": 3}])
    perguntar(
        banco,
        "Quantos?",
        gerador("MATCH (n) RETURN 3 AS v", chamadas),
        esquema_texto="E",
        terminologia_texto="T",
        exemplos=[],
    )
    assert len(chamadas) == 1 and chamadas[0][-1]["content"].strip().endswith("Quantos?")


# ---------- 9: a medida de acerto ----------


@pytest.mark.parametrize(
    "esperado, tipo, linhas, certo",
    [
        (1096.0, "numero", [{"total": 1096}], True),
        (703041.09, "numero", [{"soma": 247575.24 + 455465.85}], True),  # arredondamento de float
        (1096.0, "numero", [{"total": 1095}], False),
        (1096.0, "numero", [{"a": "x", "b": 1096.0}], True),  # em qualquer coluna
        (
            1096.0,
            "numero",
            [{"v": float(i)} for i in range(1090, 1100)],
            False,
        ),  # despejo de linhas: por acaso
        ("Sudeste", "texto", [{"regiao": "SUDESTE", "n": 1}], True),
        ("Sudeste", "texto", [{"regiao": "Nordeste"}], False),
        ("Diretoria Executiva", "texto", [{"orgao": "diretoria  executiva"}], True),
        (1096.0, "numero", [], False),
        (1096.0, "numero", [{"v": None}], False),
    ],
)
def test_acerto(esperado, tipo, linhas, certo):
    assert acerto(esperado, tipo, linhas) is certo


# ---------- 10: evidências ----------


def test_evidencias_citam_a_pagina_quando_a_consulta_a_devolve():
    banco = BancoFalso(
        [{"soma": 1096, "pagina": 368, "id": "fact:1"}, {"soma": 5, "pagina": None, "id": "fact:2"}]
    )
    r = perguntar(
        banco,
        "quanto?",
        gerador("MATCH (f) RETURN 1 AS soma"),
        esquema_texto="E",
        terminologia_texto="T",
        exemplos=[],
    )
    assert r["erro"] is None and len(r["evidencias"]) == 2
    e0, e1 = r["evidencias"]
    assert (
        e0["tipo"] == "consulta"
        and e0["paginas"] == "p. 368"
        and "1096" in e0["texto"]
        and e0["score"] == 1.0
    )
    assert e1["paginas"] == ""  # sem página: nada é inventado
    assert r["cypher"].startswith("MATCH")


def test_soma_de_conjunto_vazio_sem_pagina_vem_com_aviso():
    # `sum()` sobre nada devolve 0 e `min(f.page)` devolve null: parece resposta e não tem fonte
    r = perguntar(
        BancoFalso([{"total": 0, "pagina": None}]),
        "quanto?",
        gerador("MATCH (f) RETURN sum(f.value) AS total, min(f.page) AS pagina"),
        esquema_texto="E", terminologia_texto="T", exemplos=[],
    )  # fmt: skip
    assert r["erro"] is None and r["aviso"] and "página" in r["aviso"]
    com_pagina = perguntar(
        BancoFalso([{"total": 5, "pagina": 10}]),
        "quanto?",
        gerador("MATCH (f) RETURN 5 AS total, 10 AS pagina"),
        esquema_texto="E", terminologia_texto="T", exemplos=[],
    )  # fmt: skip
    assert com_pagina["aviso"] is None


def test_resultado_vazio_tem_aviso_e_nenhuma_evidencia():
    r = perguntar(
        BancoFalso([]),
        "quanto?",
        gerador("MATCH (n) RETURN n.v AS v"),
        esquema_texto="E",
        terminologia_texto="T",
        exemplos=[],
    )
    assert r["linhas"] == [] and r["evidencias"] == [] and r["aviso"]


def test_exemplos_json_carrega_do_arquivo(tmp_path):
    arq = tmp_path / "ex.json"
    arq.write_text(json.dumps([{"pergunta": "p", "cypher": "MATCH (n) RETURN n"}]), encoding="utf-8")
    assert carregar_exemplos(arq) == [{"pergunta": "p", "cypher": "MATCH (n) RETURN n"}]
