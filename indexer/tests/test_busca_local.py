"""Busca local (F6.1, ARQUITETURA §7.2, ferramenta `entidade`).

Formas de falhar, escritas antes do código (cada uma tem um teste abaixo):

 1. entidade achada só pelo nome exato (texto) ou só pelo vetor some da lista de candidatas;
 2. nome com caractere especial do Lucene (`LD/FTP-C`, `VICRI - Vice-Presidência`) derruba a consulta;
 3. pergunta vazia ou sem nenhuma entidade parecida estoura em vez de devolver evidência vazia;
 4. o emissor (supernó, milhares de arestas) enche o contexto: os tetos de relações, Pais e comunidades valem;
 5. a mesma relação aparece duas vezes quando as duas pontas foram escolhidas;
 6. o mesmo Pai aparece duas vezes (duas entidades o citam) ou a ordem muda entre execuções;
 7. entidade isolada (sem relação nem comunidade) quebra a montagem;
 8. o orçamento de tokens estoura: o que sobra é cortado das camadas de menor prioridade e o corte é contado;
 9. a evidência sem página ganha um rótulo de página inventado (resumo de comunidade não tem página).

Da medição (aceite: recall de contexto ≥ 0,8 nas perguntas "quem é…" do golden set):

10. a seleção das perguntas pega "Quem" no meio da frase ou deixa de fora a rota `entidade`;
11. o recall por regex confunde quebra de linha e hífen de sílaba com texto diferente, ou dá nota a pergunta
    de recusa (que não tem gabarito a recuperar).
"""

from indexer.busca_local import (
    LIMITES_PADRAO,
    buscar,
    fundir_candidatas,
    montar_evidencias,
    nome_na_pergunta,
    ranquear_comunidades,
    ranquear_pais,
    recall_por_regex,
    rotulo_de_paginas,
    selecionar_casos_de_entidade,
    sistema_busca_local,
    texto_exato,
)


def test_candidatas_unem_vetor_e_texto_sem_repetir_e_cortam_em_n():
    vetor = [("a", 0.9), ("b", 0.8), ("c", 0.7)]
    texto = [("z", 5.0), ("b", 4.0)]
    ids = [i for i, _ in fundir_candidatas(vetor, texto, 10)]
    assert set(ids) == {"a", "b", "c", "z"} and len(ids) == 4
    assert ids[0] == "b"  # nas duas listas: a soma dos RRF vence
    assert [i for i, _ in fundir_candidatas(vetor, [], 2)] == ["a", "b"]
    assert [i for i, _ in fundir_candidatas([], texto, 10)] == ["z", "b"]  # só pelo nome exato
    assert fundir_candidatas([], [], 5) == []


def test_ranquear_pais_junta_citacao_por_varias_entidades_e_similaridade_com_a_pergunta():
    mencoes = {"e1": ["p1", "p2", "p3"], "e2": ["p2", "p4"]}
    sim = {"p1": 0.2, "p2": 0.5, "p3": 0.9, "p4": 0.1}
    ordem = ranquear_pais(mencoes, sim, k=3)
    assert ordem[0] == "p2"  # citado pelas duas e com similaridade alta
    assert len(ordem) == 3 and len(set(ordem)) == 3  # sem repetir Pai
    assert ordem == ranquear_pais(mencoes, sim, k=3)  # determinístico
    assert ranquear_pais({}, {}, k=3) == []
    assert ranquear_pais({"e1": ["p1"]}, {}, k=3) == ["p1"]  # sem similaridade ainda ordena


def test_ranquear_pais_empate_de_citacoes_nao_vira_vantagem_para_quem_vem_antes_no_id():
    # achado da medição: com 300 Pais citados 1 vez, o desempate por id fazia o ranking de citações
    # empurrar o Pai mais parecido com a pergunta ('zz') para trás de um Pai citado 2 vezes e pouco parecido
    muitos = [f"p{i:03d}" for i in range(300)] + ["zz"]
    mencoes = {"e1": muitos, "e2": ["p000"]}
    sim = {p: 0.3 for p in muitos} | {"zz": 0.95, "p000": 0.1}
    assert ranquear_pais(mencoes, sim, k=1) == ["zz"]


def test_ranquear_pais_empate_total_desempata_por_id():
    mencoes = {"e1": ["pB", "pA", "pC"]}
    sim = {"pA": 0.5, "pB": 0.5, "pC": 0.5}
    assert ranquear_pais(mencoes, sim, k=3) == ["pA", "pB", "pC"]


def test_ranquear_comunidades_prefere_mais_membros_selecionados_depois_o_nivel_mais_fino():
    info = {
        "c0": {"level": 0, "rank": 1.0},
        "c1": {"level": 1, "rank": 9.0},
        "c2": {"level": 0, "rank": 5.0},
    }
    membros = {"c0": ["e1", "e2"], "c1": ["e1", "e2"], "c2": ["e1"]}
    assert ranquear_comunidades(membros, info, k=3) == ["c0", "c1", "c2"]
    assert ranquear_comunidades(membros, info, k=1) == ["c0"]
    assert ranquear_comunidades({}, {}, k=2) == []


def test_rotulo_de_paginas():
    assert rotulo_de_paginas([6]) == "p. 6"
    assert rotulo_de_paginas([6, 6]) == "p. 6"
    assert rotulo_de_paginas([9, 6, 12]) == "p. 6, 9, 12"
    assert rotulo_de_paginas([6, 7]) == "p. 6-7"
    assert rotulo_de_paginas([]) == ""  # nada de página inventada


def ent(i, nome="Entidade", resumo="Resumo curto.", paginas=(6,)):
    return {"id": i, "nome": nome, "tipo": "ORGANIZATION", "resumo": resumo, "paginas": list(paginas)}


def rel(a, b, rank, resumo="Relação."):
    return {"de": a, "para": b, "de_nome": a, "para_nome": b, "resumo": resumo, "rank": rank, "paginas": [7]}


def pai(i, texto="Texto do trecho.", ini=6, fim=6, tokens=50):
    return {
        "id": i,
        "text": texto,
        "pageStart": ini,
        "pageEnd": fim,
        "caminho": "A › B",
        "tokens": tokens,
        "score": 0.5,
    }


def com(i, titulo="Tema", resumo="Resumo da comunidade.", nivel=0):
    return {"id": i, "title": titulo, "summary": resumo, "level": nivel, "rank": 1.0}


def test_evidencias_respeitam_tetos_na_ordem_entidade_pai_relacao_comunidade():
    limites = {**LIMITES_PADRAO, "entidades": 1, "relacoes": 2, "pais": 2, "comunidades": 1}
    ev, omitido = montar_evidencias(
        [ent("e1"), ent("e2")],
        [rel("e1", "x", 9), rel("e1", "y", 8), rel("e1", "z", 7)],
        [pai("p1"), pai("p2"), pai("p3")],
        [com("c1"), com("c2")],
        limites,
    )
    tipos = [e["tipo"] for e in ev]
    assert tipos == ["entidade", "pai", "pai", "relacao", "relacao", "comunidade"]
    assert omitido == {"entidades": 1, "relacoes": 1, "pais": 1, "comunidades": 1, "por_orcamento": 0}
    assert len({e["id"] for e in ev}) == len(ev)  # ids únicos
    assert all({"id", "tipo", "paginas", "caminho", "texto", "score"} <= e.keys() for e in ev)


def test_relacao_entre_duas_entidades_escolhidas_entra_uma_vez_so():
    ev, _ = montar_evidencias(
        [ent("a"), ent("b")], [rel("a", "b", 5), rel("b", "a", 5)], [], [], dict(LIMITES_PADRAO)
    )
    assert [e["tipo"] for e in ev].count("relacao") == 1


def test_entidade_isolada_sem_relacao_pai_ou_comunidade_ainda_vira_evidencia():
    ev, omitido = montar_evidencias([ent("e1", paginas=())], [], [], [], dict(LIMITES_PADRAO))
    assert [e["tipo"] for e in ev] == ["entidade"]
    assert ev[0]["paginas"] == ""  # sem Pai que a cite, sem página
    assert sum(omitido.values()) == 0


def test_comunidade_e_sintese_sem_pagina_e_relacao_leva_as_paginas_de_origem():
    ev, _ = montar_evidencias([ent("e1")], [rel("e1", "x", 3)], [], [com("c1")], dict(LIMITES_PADRAO))
    por_tipo = {e["tipo"]: e for e in ev}
    assert por_tipo["comunidade"]["paginas"] == ""
    assert por_tipo["relacao"]["paginas"] == "p. 7"
    assert por_tipo["entidade"]["paginas"] == "p. 6"


def test_orcamento_de_tokens_corta_do_fim_e_conta_o_que_cortou():
    grande = "x" * 3000  # ~1000 tokens estimados
    limites = {**LIMITES_PADRAO, "tokens": 1200}
    ev, omitido = montar_evidencias(
        [ent("e1")],
        [rel("e1", "x", 1, resumo=grande)],
        [pai("p1", tokens=300), pai("p2", tokens=300)],
        [com("c1", resumo=grande)],
        limites,
    )
    tipos = [e["tipo"] for e in ev]
    assert tipos[0] == "entidade" and "pai" in tipos  # prioridade: entidade e Pais
    assert "comunidade" not in tipos
    assert omitido["por_orcamento"] >= 1


def test_a_primeira_entidade_entra_mesmo_se_estourar_o_orcamento():
    ev, _ = montar_evidencias([ent("e1", resumo="y" * 9000)], [], [], [], {**LIMITES_PADRAO, "tokens": 100})
    assert [e["tipo"] for e in ev] == ["entidade"]


class Registro(dict):
    pass


class DriverFalso:
    """Responde cada Cypher pelo trecho que o identifica; guarda o que foi pedido."""

    def __init__(
        self, vetor=(), texto=(), entidades=(), relacoes=(), mencoes=(), sim=(), pais=(), comunidades=()
    ):
        self.dados = {
            "entity_vec": [Registro(id=i, score=s) for i, s in vetor],
            "entity_ft": [Registro(id=i, score=s) for i, s in texto],
            "e.summary": [Registro(**e) for e in entidades],
            "SUMMARIZED_RELATIONSHIP": [Registro(**r) for r in relacoes],
            "MENTIONED_IN": [Registro(entidade=e, pai=p) for e, p in mencoes],
            "vector.similarity.cosine": [Registro(pai=p, sim=s) for p, s in sim],
            "p.text": [Registro(**p) for p in pais],
            "IN_COMMUNITY": [Registro(**c) for c in comunidades],
        }
        self.pedidos: list[tuple[str, dict]] = []

    def execute_query(self, cypher, parametros=None, database_=None):
        self.pedidos.append((cypher, parametros or {}))
        for chave, linhas in self.dados.items():
            if chave in cypher:
                return linhas, None, None
        raise AssertionError(f"consulta inesperada: {cypher}")


def embute_falso(textos):
    return [[1.0, 0.0] for _ in textos]


ENT_A = {
    "id": "a",
    "nome": "União Federal",
    "tipo": "ORGANIZATION",
    "resumo": "Controladora.",
    "paginas": [6],
}


def test_buscar_ponta_a_ponta_com_driver_falso_devolve_evidencias_e_latencia():
    d = DriverFalso(
        vetor=[("a", 0.9)],
        texto=[("a", 3.0)],
        entidades=[
            {
                "id": "a",
                "nome": "União Federal",
                "tipo": "ORGANIZATION",
                "resumo": "Controladora.",
                "pages": [6],
            }
        ],
        relacoes=[
            {
                "de": "a",
                "para": "b",
                "de_nome": "União Federal",
                "para_nome": "BB",
                "resumo": "Controla.",
                "rank": 4,
                "pages": [6],
            }
        ],  # fmt: skip
        mencoes=[("a", "p1")],
        sim=[("p1", 0.8)],
        pais=[
            {
                "id": "p1",
                "text": "A União detém 50%.",
                "pageStart": 6,
                "pageEnd": 6,
                "caminho": "Capital",
                "tokens": 20,
            }
        ],
        comunidades=[
            {"entidade": "a", "id": "c1", "title": "Controle", "summary": "Resumo.", "level": 0, "rank": 1.0}
        ],
    )
    r = buscar(d, "Quem é a União Federal?", embute_falso)
    assert [e["tipo"] for e in r["evidencias"]] == ["entidade", "pai", "relacao", "comunidade"]
    assert r["entidades"] == [{"id": "a", "nome": "União Federal", "score": r["entidades"][0]["score"]}]
    assert set(r["latencia_ms"]) >= {"total", "embedding_da_consulta"}
    assert r["omitido"]["por_orcamento"] == 0


def test_buscar_pergunta_vazia_ou_sem_entidade_devolve_vazio_sem_consultar_o_grafo_a_toa():
    d = DriverFalso()
    r = buscar(d, "   ", embute_falso)
    assert r["evidencias"] == [] and r["entidades"] == [] and d.pedidos == []
    r = buscar(DriverFalso(), "pergunta sem entidade parecida", embute_falso)
    assert r["evidencias"] == [] and r["entidades"] == []


def test_buscar_escapa_a_consulta_lucene_e_nao_manda_consulta_so_de_operadores():
    d = DriverFalso(vetor=[("a", 0.9)], entidades=[
        {"id": "a", "nome": "N", "tipo": "T", "resumo": "R", "pages": []}
    ])  # fmt: skip
    buscar(d, "Quem aprova a LD/FTP-C do (VICRI - Vice-Presidência)?", embute_falso)
    q_texto = [p["q"] for c, p in d.pedidos if "entity_ft" in c]
    assert q_texto and "\\/" in q_texto[0] and "\\(" in q_texto[0] and "\\-" in q_texto[0]
    d2 = DriverFalso(vetor=[])
    buscar(d2, "AND OR NOT", embute_falso)  # só palavras reservadas: nada a buscar no texto
    assert not [c for c, _ in d2.pedidos if "entity_ft" in c]


def test_buscar_aplica_o_teto_de_candidatas_e_de_entidades_na_consulta():
    muitos = [(f"e{i}", 1.0 - i / 100) for i in range(30)]
    d = DriverFalso(vetor=muitos, entidades=[
        {"id": f"e{i}", "nome": f"N{i}", "tipo": "T", "resumo": "R", "pages": []} for i in range(3)
    ])  # fmt: skip
    r = buscar(d, "pergunta", embute_falso, {**LIMITES_PADRAO, "entidades": 3})
    pedido = next(p for c, p in d.pedidos if "e.summary" in c)
    assert len(pedido["ids"]) == 3
    assert len(r["entidades"]) <= 3


CASOS = [
    {"id": "T01", "pergunta": "Quem é o acionista controlador?", "rota_esperada": "buscar_trechos"},
    {"id": "T02", "pergunta": "Quais os valores do banco?", "rota_esperada": "buscar_trechos"},
    {"id": "T15", "pergunta": "Quem responde pelo formulário?", "rota_esperada": "entidade"},
    {"id": "T16", "pergunta": "O que é a subsidiária X?", "rota_esperada": "entidade"},
    {"id": "T17", "pergunta": "Qual empresa audita e quem aprova?", "rota_esperada": "varias"},
    {"id": "F01", "pergunta": "Quem ganhou a Copa de 2014?", "rota_esperada": "nenhuma"},
]


def test_selecao_pega_quem_no_inicio_e_a_rota_entidade_e_deixa_o_resto():
    ids = [c["id"] for c in selecionar_casos_de_entidade(CASOS)]
    assert ids == ["T01", "T15", "T16"]  # "Quem" no meio (T17) não conta; recusa (F01) fica de fora


def caso(evidencia, tipo="texto", paginas="6"):
    return {"id": "X", "evidencia": evidencia, "tipo_gabarito": tipo, "paginas": paginas}


def test_recall_por_regex_normaliza_espaco_e_hifen_de_silaba_e_pontua_cada_parte():
    ctx = [{"texto": "A União Federal,\n detém 50,0% do­capital"}, {"texto": "outro trecho"}]
    assert recall_por_regex(caso("União Federal, detém 50,0%"), ctx) == 1.0
    assert recall_por_regex(caso("União Federal && nunca-aparece"), ctx) == 0.5
    assert recall_por_regex(caso("nunca-aparece"), ctx) == 0.0
    assert recall_por_regex(caso("ABC"), []) == 0.0
    assert recall_por_regex(caso("", tipo="recusa"), ctx) is None  # sem gabarito a recuperar
    assert recall_por_regex(caso("x", tipo="recusa"), ctx) is None


def test_sistema_busca_local_entrega_o_contexto_no_formato_do_avaliador_sem_resposta():
    d = DriverFalso(
        vetor=[("a", 0.9)],
        entidades=[{"id": "a", "nome": "N", "tipo": "T", "resumo": "R", "pages": [6]}],
        mencoes=[("a", "p1")],
        sim=[("p1", 0.8)],
        pais=[{"id": "p1", "text": "Texto.", "pageStart": 6, "pageEnd": 6, "caminho": "C", "tokens": 5}],
    )
    sistema = sistema_busca_local(d, embute_falso)
    r = sistema({"pergunta": "Quem é N?"})
    assert r["resposta"] == "" and r["citacoes"] == []
    assert [c["paginas"] for c in r["contexto"]] == ["p. 6", "p. 6"]
    assert {"paginas", "caminho", "texto"} <= r["contexto"][0].keys()
    assert r["latencia_ms"]["total"] >= 0


def test_nome_na_pergunta_ignora_caixa_e_acento_e_exige_palavra_inteira():
    p = "Quem aprova a avaliação interna de risco de LD/FTP-C? Seria a Vice-Presidência de Controles?"
    assert nome_na_pergunta(p, ["LD/FTP-C"])
    assert nome_na_pergunta(p, ["vice-presidencia de controles"])  # sem acento, outra caixa
    assert nome_na_pergunta("O que é a BB Seguridade?", ["BB Seguridade"])
    assert not nome_na_pergunta("O que é a BBSeguridade?", ["BB"])  # pedaço de palavra não vale
    assert not nome_na_pergunta(p, ["Conselho Fiscal"])
    assert nome_na_pergunta(p, ["Conselho Fiscal", "LD/FTP-C"])  # basta um dos nomes (nome ou apelidos)
    assert not nome_na_pergunta(p, ["", None])  # nome vazio não casa com tudo
    assert not nome_na_pergunta("", ["x"])


def test_texto_exato_deixa_so_o_que_a_pergunta_cita_pelo_nome_ou_apelido():
    acertos = [
        {"id": "a", "score": 9.0, "nomes": ["União", "União Federal"]},
        {"id": "b", "score": 8.0, "nomes": ["Banco do Brasil - Portugal"]},
        {"id": "c", "score": 7.0, "nomes": ["Acionistas Controladores", "acionista controlador"]},
    ]
    q = "Quem é o acionista controlador do Banco do Brasil?"
    assert [(i, s) for i, s in texto_exato(acertos, q)] == [("c", 7.0)]
    assert texto_exato([], q) == []


def _driver_com_tres_entidades():
    return DriverFalso(
        vetor=[("a", 0.9), ("b", 0.8), ("c", 0.7)],
        entidades=[
            {"id": i, "nome": f"N{i}", "tipo": "T", "resumo": f"Resumo {i}.", "pages": []} for i in "abc"
        ],
    )


def test_reranker_escolhe_as_entidades_pela_nota_e_nao_pela_ordem_da_busca():
    chamadas = []

    def reranqueia(pergunta, textos):
        chamadas.append((pergunta, textos))
        return [0.1, 0.2, 0.9]  # a terceira candidata é a melhor para o reranker

    r = buscar(
        _driver_com_tres_entidades(), "pergunta", embute_falso, {"entidades": 1}, reranquear=reranqueia
    )
    assert [e["id"] for e in r["entidades"]] == ["c"]
    assert r["entidades"][0]["score"] == 0.9
    assert len(chamadas) == 1 and "Nc" in chamadas[0][1][2] and "Resumo c." in chamadas[0][1][2]
    assert r["rerank"] == "ok"


def test_reranker_que_falha_nao_derruba_a_busca_e_cai_na_ordem_da_busca():
    def quebrado(pergunta, textos):
        raise OSError("llama-swap fora do ar")

    r = buscar(_driver_com_tres_entidades(), "pergunta", embute_falso, {"entidades": 2}, reranquear=quebrado)
    assert [e["id"] for e in r["entidades"]] == ["a", "b"]
    assert r["rerank"] == "falhou"


def test_sem_reranker_a_ordem_e_a_da_busca_e_nao_chama_nada():
    r = buscar(_driver_com_tres_entidades(), "pergunta", embute_falso, {"entidades": 2})
    assert [e["id"] for e in r["entidades"]] == ["a", "b"]
    assert r["rerank"] == "desligado"


def test_golden_de_entidades_tem_as_colunas_do_golden_ids_unicos_e_regex_validos():
    import csv
    import re
    from pathlib import Path

    raiz = Path(__file__).resolve().parents[2]
    with (raiz / "eval" / "golden.csv").open(encoding="utf-8", newline="") as f:
        colunas = csv.DictReader(f).fieldnames
    with (raiz / "eval" / "golden_entidades.csv").open(encoding="utf-8", newline="") as f:
        linhas = list(csv.DictReader(f))
    assert len(linhas) == 10
    assert list(linhas[0]) == colunas  # as mesmas colunas: o avaliador (F3) lê os dois
    assert len({x["id"] for x in linhas}) == len(linhas) and all(x["id"].startswith("E") for x in linhas)
    for x in linhas:
        assert x["rota_esperada"] == "entidade" and x["tipo_gabarito"] == "texto" and x["evidencia"]
        assert all(p.isdigit() for p in x["paginas"].split("|"))
        for parte in x["evidencia"].split(" && "):
            re.compile(parte)
    assert len(selecionar_casos_de_entidade(linhas)) == 10
