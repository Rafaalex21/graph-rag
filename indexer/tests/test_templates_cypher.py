"""Templates Cypher (F6.3, ARQUITETURA §7.2): fato_financeiro, serie_metrica, comparar_segmentos, riscos,
eventos e pessoas_cargos.

Formas de falhar, escritas antes do código (cada uma tem um teste abaixo):

Comum
 1. um template escreve no grafo, não tem LIMIT ou concatena texto do usuário na consulta (injeção);
 2. a entidade ou o tema com aspas, chaves ou `;` vira parte do Cypher em vez de parâmetro;
 3. o driver falha e a exceção sobe até o roteador, em vez de um `erro` no resultado;
 4. nada encontrado vira resposta inventada: o resultado tem de vir vazio e dizer por quê.
fato_financeiro
 5. métrica fora do catálogo chama o grafo mesmo assim, ou "lucro"/"faturamento" não achem a canônica;
 6. período em formato do usuário ("2025", "4T25", "31/12/2025") não vira o id do grafo, ou um período
    inválido passa em silêncio;
 7. sem período, o "mais recente" é um período de projeção, posterior ao ano-base do documento;
 8. entidade com outra caixa/acento não casa; entidade desconhecida devolve os fatos do emissor sem avisar;
 9. a escala é ignorada (16.782 × 10⁶ ≠ 16.782) ou o texto sai fora do padrão pt-BR;
10. o mesmo valor, em duas escalas ou em duas páginas, aparece como dois fatos, ou valores que divergem de
    verdade aparecem como um só sem aviso;
11. fato de unidade incompatível com a métrica (percentual de crescimento sob uma métrica monetária) volta;
12. só há recortes e o total é inventado; o pedido de um recorte devolve o total.
serie_metrica
13. a série sai fora de ordem cronológica, preenche lacunas ou mistura trimestre com ano;
14. períodos com valores conflitantes viram um ponto sem aviso; a variação cruza unidades ou lacunas.
comparar_segmentos
15. um segmento pedido que não existe some em silêncio; "pessoas fisicas" não casa "Pessoas Físicas";
16. sem lista de segmentos, devolve todos os recortes sem teto, ou sem ordem.
riscos / eventos / pessoas_cargos
17. categoria inexistente é aceita; tema sem resultado devolve riscos quaisquer;
18. o filtro por ano descarta evento sem data sem contar, ou o devolve como se fosse do ano;
19. "diretora presidente" não casa "Diretor Presidente"; sem nenhum filtro devolve todas as pessoas;
20. nome de pessoa que é um cargo (defeito conhecido da extração) sai sem aviso.
"""

import pytest

from indexer.templates_cypher import (
    CONSULTAS,
    comparar_segmentos,
    consolidar_fatos,
    eventos,
    fato_financeiro,
    formatar_valor,
    normalizar_periodo,
    pessoas_cargos,
    resolver_entidade,
    resolver_metrica,
    riscos,
    serie_metrica,
)

CAT = [
    {
        "id": "net_income",
        "name": "Net income",
        "name_pt": "Lucro líquido",
        "kind": "monetary",
        "aliases": ["lucro", "lucro líquido do exercício", "profit"],
    },
    {
        "id": "net_interest_income",
        "name": "Net interest income",
        "name_pt": "Receita líquida de juros",
        "kind": "monetary",
        "aliases": ["margem financeira líquida"],
    },
    {
        "id": "credit_portfolio",
        "name": "Credit portfolio",
        "name_pt": "Carteira de crédito",
        "kind": "monetary",
        "aliases": ["carteira"],
    },
    {
        "id": "employee_headcount",
        "name": "Employee headcount",
        "name_pt": "Quantidade de empregados",
        "kind": "count",
        "aliases": ["empregados"],
    },
]

BB = "Banco do Brasil S.A."


def fato(valor=16782.0, escala=1_000_000, periodo="2025-FY", fim="2025-12-31", pagina=93, **kw):
    base = {
        "id": f"fact:{valor}-{escala}-{pagina}-{periodo}",
        "valor": valor,
        "unidade": "currency",
        "moeda": None,
        "escala": escala,
        "periodo": periodo,
        "fim": fim,
        "tipo_periodo": "fiscal_year",
        "entidade": BB,
        "qualificador": "nenhum",
        "dimensao": None,
        "rotulo": "Lucro líquido",
        "pagina": pagina,
        "pagina_fim": pagina,
    }
    base.update(kw)
    return base


class GrafoFalso:
    """Responde por nome de consulta; registra o que foi chamado."""

    def __init__(self, **respostas):
        self.respostas = {
            "emissor": [{"emissor": BB, "ano_base": 2025}],
            "entidades_dos_fatos": [
                {"entidade": BB, "n": 1106},
                {"entidade": "BB Consórcios", "n": 10},
                {"entidade": "Banco Votorantim S.A.", "n": 9},
            ],
        }
        self.respostas.update(respostas)
        self.chamadas: list[tuple[str, dict, str]] = []
        self.falha: Exception | None = None

    def execute_query(self, cypher, params=None, **kw):
        if self.falha:
            raise self.falha
        nome = next(n for n, c in CONSULTAS.items() if c == cypher)
        self.chamadas.append((nome, params or {}, cypher))
        return [dict(r) for r in self.respostas.get(nome, [])], None, None

    def nomes(self):
        return [n for n, _, _ in self.chamadas]

    def params(self, nome):
        return next(p for n, p, _ in self.chamadas if n == nome)


# ---------- 1-4: segurança e envelope comum ----------


@pytest.mark.parametrize("nome", sorted(CONSULTAS))
def test_consultas_sao_somente_leitura_e_limitadas(nome):
    c = CONSULTAS[nome].upper()
    for proibido in ("CREATE ", "MERGE ", "DELETE ", " SET ", "REMOVE ", "DROP ", "LOAD CSV", "CALL APOC"):
        assert proibido not in c, (nome, proibido)
    assert "LIMIT" in c, nome


def test_texto_do_usuario_vai_como_parametro_nunca_na_consulta():
    perigoso = "x'}) DETACH DELETE n //"
    g = GrafoFalso(riscos=[], eventos=[], pessoas=[])
    riscos(g, tema=perigoso)
    eventos(g, tema=perigoso)
    pessoas_cargos(g, cargo=perigoso)
    for _, params, cypher in g.chamadas:
        assert "DETACH" not in cypher and perigoso not in cypher
        assert all(isinstance(v, (str, int, float, bool, list, type(None))) for v in params.values())


@pytest.mark.parametrize(
    "chamada",
    [
        lambda g: fato_financeiro(g, "lucro", periodo="2025", catalogo=CAT),
        lambda g: serie_metrica(g, "lucro", catalogo=CAT),
        lambda g: comparar_segmentos(g, "carteira de crédito", catalogo=CAT),
        lambda g: riscos(g),
        lambda g: eventos(g),
        lambda g: pessoas_cargos(g, cargo="presidente"),
    ],
)
def test_falha_do_driver_vira_erro_no_resultado_e_nao_excecao(chamada):
    g = GrafoFalso()
    g.falha = RuntimeError("Neo4j fora do ar")
    r = chamada(g)
    assert r["erro"] and "Neo4j fora do ar" in r["erro"]
    assert r["evidencias"] == []


def test_nada_encontrado_volta_vazio_com_aviso():
    g = GrafoFalso(fatos=[])
    r = fato_financeiro(g, "lucro", periodo="2019", catalogo=CAT)
    assert r["evidencias"] == [] and r["fatos"] == [] and r["erro"] is None
    assert r["aviso"]


# ---------- 5-12: fato_financeiro ----------


def test_metrica_desconhecida_nao_chama_o_grafo_e_sugere():
    g = GrafoFalso()
    r = fato_financeiro(g, "índice de felicidade", catalogo=CAT)
    assert r["erro"] == "metrica_desconhecida" and r["evidencias"] == []
    assert g.chamadas == []
    r2 = fato_financeiro(g, "lucro bruto", catalogo=CAT)  # compartilha "lucro" com uma métrica
    assert "Net income" in r2["sugestoes"]


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("lucro", "net_income"),
        ("Lucro Líquido", "net_income"),
        ("profit", "net_income"),
        ("o lucro líquido do exercício de 2025", "net_income"),  # o texto traz mais do que o termo
        ("receita liquida de juros", "net_interest_income"),
        ("Carteira", "credit_portfolio"),
    ],
)
def test_resolver_metrica_usa_o_catalogo_com_sinonimos(texto, esperado):
    m, _ = resolver_metrica(texto, CAT)
    assert m and m["id"] == esperado


def test_resolver_metrica_prefere_o_termo_mais_longo_e_nao_adivinha_empate():
    m, _ = resolver_metrica("receita líquida de juros", CAT)
    assert m["id"] == "net_interest_income"
    assert resolver_metrica("", CAT)[0] is None


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("2025", "2025-FY"),
        ("FY2025", "2025-FY"),
        ("exercício de 2025", "2025-FY"),
        ("2025-FY", "2025-FY"),
        ("4T25", "2025-Q4"),
        ("4T2025", "2025-Q4"),
        ("4º trimestre de 2025", "2025-Q4"),
        ("Q4 2025", "2025-Q4"),
        ("2025-Q4", "2025-Q4"),
        ("31/12/2025", "2025-12-31"),
        ("2025-12-31", "2025-12-31"),
        ("31 de dezembro de 2025", "2025-12-31"),
    ],
)
def test_normalizar_periodo(texto, esperado):
    assert normalizar_periodo(texto) == esperado


@pytest.mark.parametrize("texto", ["ontem", "5T25", "13/13/2025", "99", ""])
def test_periodo_invalido_levanta_erro(texto):
    with pytest.raises(ValueError):
        normalizar_periodo(texto)


def test_periodo_invalido_vira_erro_sem_consultar_fatos():
    g = GrafoFalso()
    r = fato_financeiro(g, "lucro", periodo="ontem", catalogo=CAT)
    assert r["erro"] == "periodo_invalido"
    assert "fatos" not in g.nomes()


def test_consulta_leva_metrica_periodo_entidade_e_unidade_certos():
    g = GrafoFalso(fatos=[fato()])
    fato_financeiro(g, "lucro", periodo="2025", catalogo=CAT)
    p = g.params("fatos")
    assert p["metrica"] == "metric:net_income" and p["periodos"] == ["2025-FY"]
    assert p["entidades"] == [BB] and p["qualificador"] == "nenhum"
    assert p["unidade"] == "currency" and p["modo"] == "total" and p["limite"] > 0


def test_unidade_vem_do_tipo_da_metrica():
    g = GrafoFalso(fatos=[])
    fato_financeiro(g, "empregados", periodo="2025", catalogo=CAT)
    assert g.params("fatos")["unidade"] == "count"


def test_sem_periodo_usa_o_mais_recente_ate_o_ano_base_e_avisa():
    g = GrafoFalso(
        fatos=[
            fato(valor=999.0, periodo="2026-FY", fim="2026-12-31", pagina=7),  # projeção, depois do ano-base
            fato(valor=16782.0),
            fato(valor=12000.0, periodo="2024-FY", fim="2024-12-31"),
        ]
    )
    r = fato_financeiro(g, "lucro", catalogo=CAT)
    assert r["periodo_assumido"] is True
    assert [f["periodo"] for f in r["fatos"]] == ["2025-FY"]


def test_com_periodo_informado_o_ano_base_nao_corta():
    g = GrafoFalso(fatos=[fato(valor=999.0, periodo="2026-FY", fim="2026-12-31")])
    r = fato_financeiro(g, "lucro", periodo="2026", catalogo=CAT)
    assert [f["periodo"] for f in r["fatos"]] == ["2026-FY"] and r["periodo_assumido"] is False


def test_entidade_casa_sem_caixa_nem_acento_e_vai_ao_grafo_com_o_nome_exato():
    g = GrafoFalso(fatos=[fato(entidade="BB Consórcios")])
    fato_financeiro(g, "lucro", entidade="bb consorcios", periodo="2025", catalogo=CAT)
    assert g.params("fatos")["entidades"] == ["BB Consórcios"]


def test_entidade_desconhecida_e_erro_com_sugestoes_e_nao_cai_no_emissor():
    g = GrafoFalso()
    r = fato_financeiro(g, "lucro", entidade="BB Consorcios Imaginária", catalogo=CAT)
    assert r["erro"] == "entidade_desconhecida" and "BB Consórcios" in r["sugestoes"]
    assert "fatos" not in g.nomes()


def test_resolver_entidade_exata_depois_contida_e_unica():
    conhecidas = [BB, "BB Consórcios", "BB Seguridade", "BB Seguros Participações"]
    assert resolver_entidade("banco do brasil", conhecidas, BB)[0] == BB  # contida no nome do emissor
    assert resolver_entidade(None, conhecidas, BB)[0] == BB
    assert resolver_entidade("BB", conhecidas, BB)[0] is None  # ambígua: não adivinha
    assert resolver_entidade("BB Seguridade", conhecidas, BB)[0] == "BB Seguridade"


@pytest.mark.parametrize(
    "valor, unidade, escala, moeda, esperado",
    [
        (16782.0, "currency", 1_000_000, None, "R$ 16.782 milhões"),
        (16.8, "currency", 1_000_000_000, "BRL", "R$ 16,8 bilhões"),
        (1.76, "currency", 1_000_000_000, "BRL", "R$ 1,76 bilhão"),
        (5500008083.77, "currency", 1, "BRL", "R$ 5.500.008.083,77"),
        (35.0, "currency", 1000, None, "R$ 35 mil"),
        (23.9, "percent", 1, None, "23,9%"),
        (130.0, "count", 1, None, "130"),
        (85.2, "count", 1000, None, "85,2 mil"),
        (31.75, "currency", 1, "BRL", "R$ 31,75"),
    ],
)
def test_formatar_valor_em_pt_br_com_escala_explicita(valor, unidade, escala, moeda, esperado):
    assert formatar_valor(valor, unidade, escala, moeda) == esperado


def test_valor_absoluto_aplica_a_escala():
    g = GrafoFalso(fatos=[fato()])
    r = fato_financeiro(g, "lucro", periodo="2025", catalogo=CAT)
    f = r["fatos"][0]
    assert f["valor_absoluto"] == 16_782_000_000.0 and f["texto_valor"] == "R$ 16.782 milhões"
    ev = r["evidencias"][0]
    assert ev["tipo"] == "fato" and ev["paginas"] == "p. 93" and "16.782 milhões" in ev["texto"]
    assert ev["id"].startswith("fact:") and ev["score"] == 1.0


def test_mesmo_valor_em_duas_escalas_e_duas_paginas_vira_um_fato_com_as_duas_paginas():
    fatos = [
        fato(valor=16.8, escala=1_000_000_000, pagina=22),
        fato(valor=16782.0, pagina=93),
        fato(valor=16782.0, pagina=80),
    ]
    out = consolidar_fatos(fatos)
    assert len(out) == 1
    assert out[0]["escala"] == 1_000_000 and out[0]["paginas"] == [22, 80, 93]  # fica a escala mais fina
    assert out[0]["conflito"] is False


def test_valores_que_divergem_de_verdade_ficam_separados_e_marcam_conflito():
    out = consolidar_fatos([fato(valor=1229907.0, pagina=84), fato(valor=175442.0, pagina=94)])
    assert len(out) == 2 and all(f["conflito"] for f in out)


def test_conflito_so_vale_dentro_do_mesmo_periodo_e_recorte():
    out = consolidar_fatos([fato(), fato(valor=12000.0, periodo="2024-FY", fim="2024-12-31")])
    assert len(out) == 2 and not any(f["conflito"] for f in out)


def test_so_recortes_sem_total_nao_inventa_total():
    g = GrafoFalso(fatos=[])
    r = fato_financeiro(g, "carteira de crédito", periodo="2025", catalogo=CAT)
    assert r["fatos"] == [] and "recorte" in (r["aviso"] or "")


def test_dimensao_pedida_muda_o_modo_e_casa_o_recorte():
    g = GrafoFalso(
        fatos=[
            fato(valor=373579.0, dimensao="Rurais", pagina=84),
            fato(valor=61834.0, dimensao="Imobiliário"),
        ]
    )
    r = fato_financeiro(g, "carteira de crédito", periodo="2025", dimensao="imobiliario", catalogo=CAT)
    assert g.params("fatos")["modo"] == "recortes"
    assert [f["dimensao"] for f in r["fatos"]] == ["Imobiliário"]


def test_qualificador_invalido_e_erro():
    r = fato_financeiro(GrafoFalso(), "lucro", qualificador="dobro", catalogo=CAT)
    assert r["erro"] == "qualificador_invalido"


# ---------- 13-14: serie_metrica ----------


def test_serie_em_ordem_cronologica_sem_preencher_lacunas_e_sem_variacao_atraves_da_lacuna():
    g = GrafoFalso(
        fatos=[
            fato(valor=1229907.0, periodo="2025-FY", fim="2025-12-31"),
            fato(valor=964043.0, periodo="2023-FY", fim="2023-12-31"),  # 2024 não existe
        ]
    )
    r = serie_metrica(g, "carteira de crédito", catalogo=CAT)
    assert [p["periodo"] for p in r["pontos"]] == ["2023-FY", "2025-FY"]
    assert r["periodos_ausentes"] == ["2024-FY"] and "2024-FY" in r["aviso"]
    assert [p["variacao_pct"] for p in r["pontos"]] == [None, None]  # 2025 não é "o ano seguinte" a 2023
    assert len(r["evidencias"]) == 2


def test_serie_calcula_variacao_entre_anos_vizinhos():
    g = GrafoFalso(
        fatos=[
            fato(valor=1229907.0, periodo="2025-FY", fim="2025-12-31"),
            fato(valor=1099725.0, periodo="2024-FY", fim="2024-12-31"),
        ]
    )
    r = serie_metrica(g, "carteira de crédito", catalogo=CAT)
    assert r["pontos"][1]["variacao_pct"] == pytest.approx(11.8, abs=0.05)
    assert r["periodos_ausentes"] == []


def test_serie_nao_mistura_trimestre_com_ano_por_padrao():
    g = GrafoFalso(fatos=[])
    serie_metrica(g, "lucro", catalogo=CAT)
    assert g.params("fatos")["tipo_periodo"] == "fiscal_year"
    g2 = GrafoFalso(fatos=[])
    serie_metrica(g2, "lucro", tipo_periodo="quarter", catalogo=CAT)
    assert g2.params("fatos")["tipo_periodo"] == "quarter"
    assert serie_metrica(g2, "lucro", tipo_periodo="semana", catalogo=CAT)["erro"] == "tipo_periodo_invalido"


def test_serie_com_conflito_no_periodo_escolhe_o_mais_sustentado_e_lista_as_alternativas():
    g = GrafoFalso(
        fatos=[
            fato(valor=1229907.0, pagina=84),
            fato(valor=1229907.0, pagina=83),
            fato(valor=175442.0, pagina=94),
        ]
    )
    p = serie_metrica(g, "carteira de crédito", catalogo=CAT)["pontos"][0]
    assert p["valor"] == 1229907.0 and p["conflito"] is True
    assert [a["valor"] for a in p["alternativas"]] == [175442.0]


def test_serie_nao_calcula_variacao_de_valor_conflitante_nem_de_zero():
    g = GrafoFalso(
        fatos=[
            fato(valor=0.0, periodo="2023-FY", fim="2023-12-31"),
            fato(valor=5.0, periodo="2024-FY", fim="2024-12-31"),
        ]
    )
    pts = serie_metrica(g, "lucro", catalogo=CAT)["pontos"]
    assert pts[1]["variacao_pct"] is None  # base zero


# ---------- 15-16: comparar_segmentos ----------


LINHAS_SEG = [
    fato(valor=373579.0, dimensao="Rurais", pagina=84),
    fato(valor=61834.0, dimensao="Imobiliário", pagina=84),
    fato(valor=198693.0, dimensao="Financiamentos", pagina=84),
    fato(valor=100.0, dimensao="Pessoas Físicas"),
    fato(valor=388276.0, dimensao="Rurais", pagina=84),  # outro valor para o mesmo recorte: conflito
]


def test_comparar_casa_segmentos_sem_caixa_e_acento_e_ordena_do_maior_ao_menor():
    g = GrafoFalso(fatos=LINHAS_SEG)
    r = comparar_segmentos(
        g,
        "carteira de crédito",
        ["imobiliario", "pessoas fisicas", "financiamentos"],
        periodo="2025",
        catalogo=CAT,
    )
    assert [s["segmento"] for s in r["segmentos"]] == ["Financiamentos", "Imobiliário", "Pessoas Físicas"]
    assert g.params("fatos")["modo"] == "recortes"


def test_segmento_pedido_que_nao_existe_e_listado_e_nao_some():
    g = GrafoFalso(fatos=LINHAS_SEG)
    r = comparar_segmentos(g, "carteira de crédito", ["Rurais", "Aeroespacial"], periodo="2025", catalogo=CAT)
    assert r["nao_encontrados"] == ["Aeroespacial"] and r["aviso"]
    assert [s["segmento"] for s in r["segmentos"]] == ["Rurais"]
    assert r["segmentos"][0]["conflito"] is True  # 373.579 e 388.276 no mesmo recorte


def test_sem_lista_devolve_os_maiores_recortes_com_teto_e_conta_o_resto():
    g = GrafoFalso(fatos=[fato(valor=float(i), dimensao=f"Recorte {i}") for i in range(1, 31)])
    r = comparar_segmentos(g, "carteira de crédito", periodo="2025", limite=5, catalogo=CAT)
    assert [s["valor"] for s in r["segmentos"]] == [30.0, 29.0, 28.0, 27.0, 26.0]
    assert r["omitido"]["segmentos"] == 25


def test_comparar_sem_periodo_usa_o_mais_recente_que_tem_recortes():
    g = GrafoFalso(
        fatos=[
            fato(valor=1.0, dimensao="A", periodo="2024-FY", fim="2024-12-31"),
            fato(valor=2.0, dimensao="A", periodo="2026-FY", fim="2026-12-31"),  # depois do ano-base
        ]
    )
    r = comparar_segmentos(g, "carteira de crédito", catalogo=CAT)
    assert r["periodo"] == "2024-FY" and r["periodo_assumido"] is True


# ---------- 17: riscos ----------

RISCOS = [
    {
        "id": "r1",
        "nome": "Risco de crédito da carteira rural",
        "categoria": "credit",
        "resumo": "Inadimplência no agro.",
        "camadas": ["dirigida"],
        "ini": [100, 101],
        "fim": [100, 101],
    },
    {
        "id": "r2",
        "nome": "Vulnerabilidade da economia brasileira",
        "categoria": "market",
        "resumo": "Eventos externos.",
        "camadas": ["dirigida"],
        "ini": [60],
        "fim": [61],
    },
    {
        "id": "r3",
        "nome": "perdas financeiras",
        "categoria": None,
        "resumo": "Decisões contrárias ao Banco.",
        "camadas": ["aberta"],
        "ini": [],
        "fim": [],
    },
]


def test_riscos_filtra_por_tema_com_acento_e_ordena_por_relevancia():
    g = GrafoFalso(riscos=RISCOS)
    r = riscos(g, tema="inadimplencia agro")
    assert [e["id"] for e in r["evidencias"]] == ["r1"]
    assert r["evidencias"][0]["paginas"] == "p. 100-101" and r["evidencias"][0]["tipo"] == "risco"


def test_riscos_tema_sem_resultado_volta_vazio_e_nao_qualquer_risco():
    r = riscos(GrafoFalso(riscos=RISCOS), tema="criptomoedas")
    assert r["evidencias"] == [] and r["aviso"]


def test_riscos_categoria_valida_vai_ao_grafo_e_invalida_e_erro():
    g = GrafoFalso(riscos=RISCOS)
    riscos(g, categoria="credit")
    assert g.params("riscos")["categoria"] == "credit"
    assert riscos(g, categoria="astrologico")["erro"] == "categoria_invalida"
    g2 = GrafoFalso(riscos=RISCOS)
    riscos(g2, categoria="sem_categoria")
    assert g2.params("riscos")["sem_categoria"] is True


def test_riscos_sem_tema_prioriza_extracao_dirigida_e_com_pagina_e_respeita_o_limite():
    r = riscos(GrafoFalso(riscos=RISCOS), limite=2)
    assert [e["id"] for e in r["evidencias"]] == ["r1", "r2"] and r["omitido"]["riscos"] == 1


# ---------- 18: eventos ----------

EVENTOS = [
    {
        "id": "e1",
        "nome": "BB-BI passou a atuar com quadro próprio",
        "data": "2023-08",
        "tipo": "acquisition",
        "resumo": "Autonomia do BB-BI.",
        "paginas": [30],
        "envolvidos": ["BB-Banco de Investimentos"],
    },
    {
        "id": "e2",
        "nome": "Publicação da Resolução BCB 512",
        "data": "2025-10-10",
        "tipo": None,
        "resumo": "Compulsório.",
        "paginas": [55, 56],
        "envolvidos": ["Banco Central do Brasil"],
    },
    {
        "id": "e3",
        "nome": "revisão dos Compromissos BB 2030",
        "data": None,
        "tipo": None,
        "resumo": "Revisão.",
        "paginas": [12],
        "envolvidos": [],
    },
]


def test_eventos_com_ano_filtra_pela_data_e_conta_os_sem_data():
    r = eventos(GrafoFalso(eventos=EVENTOS), ano=2025)
    assert [e["id"] for e in r["evidencias"]] == ["e2"]
    assert r["omitido"]["sem_data"] == 1 and r["aviso"]


def test_eventos_sem_filtro_ordenam_datados_do_mais_recente_e_depois_os_sem_data():
    r = eventos(GrafoFalso(eventos=EVENTOS))
    assert [e["id"] for e in r["evidencias"]] == ["e2", "e1", "e3"]
    assert r["evidencias"][0]["paginas"] == "p. 55-56" and "2025-10-10" in r["evidencias"][0]["texto"]


def test_eventos_tema_e_ano_invalido():
    r = eventos(GrafoFalso(eventos=EVENTOS), tema="resolução compulsório")
    assert [e["id"] for e in r["evidencias"]] == ["e2"]
    assert eventos(GrafoFalso(eventos=EVENTOS), ano=1800)["erro"] == "ano_invalido"


# ---------- 19-20: pessoas_cargos ----------

PESSOAS = [
    {
        "id": "p1",
        "nome": "Tarciana Paula Gomes Medeiros",
        "cargo_no_no": None,
        "cargo": "Presidente",
        "orgao": BB,
        "paginas": [270, 271],
    },
    {
        "id": "p2",
        "nome": "Diretoria Executiva",
        "cargo_no_no": None,
        "cargo": "Diretor Presidente do Banco",
        "orgao": BB,
        "paginas": [],
    },
    {
        "id": "p3",
        "nome": "Euler Antonio Luz Mathias",
        "cargo_no_no": None,
        "cargo": "Diretor de Finanças",
        "orgao": BB,
        "paginas": [272],
    },
]


def test_pessoas_casam_cargo_com_flexao_de_genero():
    r = pessoas_cargos(GrafoFalso(pessoas=PESSOAS), cargo="diretora presidente")
    assert [e["id"] for e in r["evidencias"]] == ["p2"]


def test_pessoas_por_cargo_simples_traz_a_pessoa_com_nome_de_gente_primeiro():
    r = pessoas_cargos(GrafoFalso(pessoas=PESSOAS), cargo="presidente")
    assert [e["id"] for e in r["evidencias"]] == ["p1", "p2"]
    assert r["pessoas"][0]["nome_parece_cargo"] is False and r["pessoas"][1]["nome_parece_cargo"] is True
    assert "cargo" in r["evidencias"][1]["texto"].lower()


def test_pessoas_sem_nenhum_filtro_e_erro_e_nao_lista_todo_mundo():
    g = GrafoFalso(pessoas=PESSOAS)
    assert pessoas_cargos(g).get("erro") == "filtro_obrigatorio" and g.chamadas == []


def test_pessoas_por_nome_e_por_orgao():
    g = GrafoFalso(pessoas=PESSOAS)
    assert [e["id"] for e in pessoas_cargos(g, nome="euler mathias")["evidencias"]] == ["p3"]
    assert len(pessoas_cargos(g, orgao="banco do brasil")["evidencias"]) == 3


def test_pessoas_mesma_pessoa_mesmo_cargo_em_duas_linhas_une_as_paginas():
    dup = [dict(PESSOAS[0]), {**PESSOAS[0], "paginas": [300]}]
    r = pessoas_cargos(GrafoFalso(pessoas=dup), cargo="presidente")
    assert len(r["evidencias"]) == 1 and r["evidencias"][0]["paginas"] == "p. 270-271, 300"


def test_pessoas_cargo_nao_junta_palavras_de_titulos_diferentes():
    p = {
        "id": "p9",
        "nome": "Felipe Prince",
        "cargo_no_no": "Diretor Executivo; Vice-presidente de Riscos",
        "cargo": "Diretor Executivo",
        "orgao": BB,
        "paginas": [303],
    }
    r = pessoas_cargos(GrafoFalso(pessoas=[p]), cargo="diretor presidente")
    assert r["evidencias"] == []  # "diretor" vem de um título e "presidente" de outro


def test_pessoas_cargo_so_no_resumo_entra_depois_dos_titulos_e_diz_a_fonte():
    tarciana = {
        "id": "p8",
        "nome": "Tarciana Medeiros",
        "cargo_no_no": "Membro do Conselho",
        "cargo": "Membro do Conselho",
        "orgao": "Brasilprev",
        "paginas": [315],
        "resumo": "Tarciana Medeiros atua como Diretora Presidente, responsável pelo conteúdo do formulário.",
    }
    cargo_como_nome = {
        "id": "p7",
        "nome": "Presidente do Banco",
        "cargo_no_no": None,
        "cargo": None,
        "orgao": None,
        "paginas": [],
        "resumo": "Cargo de Diretor Presidente indicado pelo governo.",
    }
    r = pessoas_cargos(GrafoFalso(pessoas=[*PESSOAS, tarciana, cargo_como_nome]), cargo="diretora presidente")
    assert [e["id"] for e in r["evidencias"]] == ["p2", "p8"]  # o nó que é cargo não entra pelo resumo
    assert [p["fonte"] for p in r["pessoas"]] == ["cargo", "resumo"]
    assert "Diretora Presidente" in r["evidencias"][1]["texto"]


@pytest.mark.parametrize(
    "nome", ["A Presidente do BB", "Diretores", "Diretoria Executiva", "Presidente do Banco"]
)
def test_nome_com_artigo_ou_plural_de_cargo_tambem_e_marcado(nome):
    p = {"id": "x", "nome": nome, "cargo_no_no": None, "cargo": "Presidente", "orgao": None, "paginas": []}
    r = pessoas_cargos(GrafoFalso(pessoas=[p]), cargo="presidente")
    assert r["pessoas"][0]["nome_parece_cargo"] is True
