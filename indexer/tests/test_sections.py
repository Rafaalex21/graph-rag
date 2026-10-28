from indexer.sections import (
    comparar_com_sumario,
    construir_arvore,
    entradas_do_sumario,
    normaliza_titulo,
)


def _h(texto, pagina, tipo="section_header"):
    return {"tipo": tipo, "texto": texto, "paginas_originais": [pagina], "paginas_recorte": [pagina]}


def _corpo(pagina):
    return {"tipo": "text", "texto": "Parágrafo.", "paginas_originais": [pagina], "paginas_recorte": [pagina]}


def _exemplo():
    return [
        _h("Formulário", 1),
        _h("1. ATIVIDADES DO EMISSOR", 6),
        _h("1.1 Histórico do emissor", 6),
        _corpo(6),
        _h("Principais movimentos societários", 7),
        _corpo(7),
        _h("1.3 Informações sobre segmentos", 10),
        _h("(a) produtos e serviços", 10),
        _h("Segmento bancário", 10),
        _h("Segmento de seguridade", 11),
        _h("(b) receita do segmento", 11),
        _corpo(12),
        _h("4.2 Principais fatores de risco", 155),
        _corpo(156),
    ]


def test_hierarquia_pelos_numeros_letras_e_titulos_sem_marca():
    nos = construir_arvore(_exemplo())
    por_titulo = {n["titulo"]: n for n in nos}
    assert por_titulo["ATIVIDADES DO EMISSOR"]["nivel"] == 1
    assert por_titulo["Histórico do emissor"]["nivel"] == 2
    assert por_titulo["Histórico do emissor"]["pai"] == por_titulo["ATIVIDADES DO EMISSOR"]["id"]
    assert por_titulo["Principais movimentos societários"]["pai"] == por_titulo["Histórico do emissor"]["id"]
    assert por_titulo["produtos e serviços"]["tipo"] == "letra"
    assert por_titulo["produtos e serviços"]["pai"] == por_titulo["Informações sobre segmentos"]["id"]
    # dois títulos sem marca seguidos são irmãos, filhos da letra (a)
    assert por_titulo["Segmento bancário"]["pai"] == por_titulo["produtos e serviços"]["id"]
    assert por_titulo["Segmento de seguridade"]["pai"] == por_titulo["produtos e serviços"]["id"]
    # (b) volta a ser filho da seção numerada, não de (a)
    assert por_titulo["receita do segmento"]["pai"] == por_titulo["Informações sobre segmentos"]["id"]
    # 4.2 sem o "4." no recorte fica na raiz
    assert por_titulo["Principais fatores de risco"]["pai"] is None


def test_caminho_e_intervalos_de_paginas():
    nos = {n["titulo"]: n for n in construir_arvore(_exemplo())}
    assert nos["Segmento bancário"]["caminho"][-3:] == [
        "Informações sobre segmentos",
        "produtos e serviços",
        "Segmento bancário",
    ]
    # 1.1 vai até antes do 1.3 (mesmo nível), então cobre as páginas 6 e 7
    assert (nos["Histórico do emissor"]["pagina_inicio"], nos["Histórico do emissor"]["pagina_fim"]) == (6, 7)
    # 4.2 é o último título: vai até o fim, página 156
    assert nos["Principais fatores de risco"]["pagina_fim"] == 156


def test_entradas_do_sumario_e_normalizacao_de_titulo():
    texto = (
        "Sumário\n1. ATIVIDADES DO EMISSOR ........ 5\n1.1 Histórico do emissor .......... 5\nlinha solta\n"
    )
    e = entradas_do_sumario(texto)
    assert [(x["numero"], x["pagina_impressa"]) for x in e] == [("1", 5), ("1.1", 5)]
    assert normaliza_titulo("Descrição das  atividades (ASG)") == normaliza_titulo(
        "DESCRICAO das atividades ASG"
    )


def test_comparacao_conta_so_as_entradas_presentes_e_aponta_divergencias():
    nos = construir_arvore(_exemplo())
    sumario = [
        {"numero": "1", "titulo": "ATIVIDADES DO EMISSOR", "pagina_impressa": 5},  # física 6: bate
        {"numero": "1.1", "titulo": "Histórico do emissor", "pagina_impressa": 5},  # física 6: bate
        {
            "numero": "1.3",
            "titulo": "Informações sobre segmentos",
            "pagina_impressa": 8,
        },  # esperava 9, árvore diz 10: página errada
        {"numero": "9", "titulo": "AUDITORES", "pagina_impressa": 362},  # fora do recorte: ignorada
    ]
    c = comparar_com_sumario(nos, sumario, paginas_presentes={6, 7, 10, 11, 12, 155, 156})
    assert c["entradas_presentes_no_recorte"] == 2  # a 1.3 (física 9) também não está nas páginas presentes
    assert c["batem"] == 2 and c["taxa"] == 1.0

    c2 = comparar_com_sumario(nos, sumario, paginas_presentes={6, 9, 10})
    assert c2["entradas_presentes_no_recorte"] == 3
    assert c2["batem"] == 2
    assert [d["numero"] for d in c2["divergencias"]] == ["1.3"]
    assert c2["divergencias"][0]["titulo_ok"] is True and c2["divergencias"][0]["pagina_ok"] is False


def test_secao_termina_no_primeiro_titulo_que_nao_e_descendente():
    # 4.2 não tem o "4." no recorte (sem pai): a seção "1." não pode engoli-la só porque 4.2 tem nível 2
    nos = {n["titulo"]: n for n in construir_arvore(_exemplo())}
    assert nos["ATIVIDADES DO EMISSOR"]["pagina_fim"] == 12
    assert nos["Principais fatores de risco"]["pagina_inicio"] == 155
