from indexer.normalize import linhas_repetidas, normalizar


def _item(colecao, i, label=None, text=None, pagina=1, nivel=None):
    d = {"self_ref": f"#/{colecao}/{i}", "prov": [{"page_no": pagina}], "children": []}
    if label:
        d["label"] = label
    if text is not None:
        d["text"] = text
    if nivel is not None:
        d["level"] = nivel
    return d


def _doc(paginas, itens):
    """itens: lista de (colecao, item) na ordem de leitura; monta body/children com referências."""
    doc = {"pages": {str(p): {} for p in range(1, paginas + 1)}, "texts": [], "tables": [],
           "pictures": [], "groups": []}
    filhos = []
    for colecao, item in itens:
        item["self_ref"] = f"#/{colecao}/{len(doc[colecao])}"
        doc[colecao].append(item)
        filhos.append({"$ref": item["self_ref"]})
    doc["body"] = {"children": filhos}
    return doc


def _pagina(p, corpo):
    """Uma página com cabeçalho, rodapé e número de página, mais o corpo informado."""
    itens = [("texts", _item("texts", 0, "page_header", f"Formulário de Referência {p}", p))]
    itens += corpo
    itens += [("texts", _item("texts", 0, "page_footer", "Banco X | Relações com Investidores", p))]
    itens += [("texts", _item("texts", 0, "text", str(p), p))]  # número de página rotulado como texto
    return itens


def test_remove_cabecalho_rodape_e_numero_de_pagina_repetidos():
    itens = []
    for p in range(1, 11):
        paragrafo = f"Assunto {chr(96 + p)} tratado só nesta página."  # sem dígitos: cada página é diferente
        itens += _pagina(p, [("texts", _item("texts", 0, "text", paragrafo, p))])
    doc = _doc(10, itens)
    r = normalizar(doc)
    e = r["estatisticas"]
    assert e["removidos"]["rotulo_cabecalho_rodape"] == 20
    assert e["removidos"]["regra_das_repetidas"] == 10  # o número da página, rotulado como `text`
    assert e["linhas_repetidas_depois"] == 0
    assert all(x["tipo"] == "text" for x in r["elementos"])
    assert len(r["elementos"]) == 10


def test_nota_vai_para_a_tabela_anterior_e_o_rotulo_notas_some():
    tabela = _item("tables", 0, "table", None, 1)
    corpo = [
        ("texts", _item("texts", 0, "section_header", "Indicadores", 1, nivel=1)),
        ("tables", tabela),
        ("texts", _item("texts", 0, "text", "Notas:", 1)),
        ("texts", _item("texts", 0, "footnote", "(1) Não inclui recursos do FCO.", 1)),
        ("texts", _item("texts", 0, "text", "(2) Valores em R$ milhões.", 1)),
        ("texts", _item("texts", 0, "text", "Texto seguinte, sem relação com a tabela.", 1)),
    ]
    r = normalizar(_doc(1, corpo))
    tabelas = [x for x in r["elementos"] if x["tipo"] == "table"]
    textos_das_notas = [n["texto"] for n in tabelas[0]["notas"]]
    assert textos_das_notas == ["(1) Não inclui recursos do FCO.", "(2) Valores em R$ milhões."]
    assert r["estatisticas"]["notas_associadas"] == 2
    assert r["estatisticas"]["removidos"]["rotulo_notas"] == 1
    assert [x["tipo"] for x in r["elementos"]] == ["section_header", "table", "text"]


def test_nota_sem_tabela_antes_fica_no_texto_marcada():
    corpo = [
        ("texts", _item("texts", 0, "text", "Parágrafo qualquer.", 1)),
        ("texts", _item("texts", 0, "text", "(1) Nota que não segue tabela nem figura.", 1)),
    ]
    r = normalizar(_doc(1, corpo))
    assert r["estatisticas"]["notas_sem_ancora"] == 1
    assert r["elementos"][-1]["nota_sem_ancora"] is True


def test_paginas_originais_vem_do_mapa():
    corpo = [("texts", _item("texts", 0, "text", "Algo.", 2))]
    r = normalizar(_doc(2, corpo), mapa_paginas={1: 1, 2: 80})
    assert r["elementos"][0]["paginas_recorte"] == [2]
    assert r["elementos"][0]["paginas_originais"] == [80]


def test_linhas_repetidas_detecta_acima_do_limiar():
    elementos = [{"texto": f"Rodapé {p}", "paginas_recorte": [p]} for p in range(1, 11)]
    assert linhas_repetidas(elementos, 10)[0]["paginas"] == 10
    assert linhas_repetidas(elementos[:2], 10) == []
