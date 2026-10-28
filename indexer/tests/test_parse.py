from indexer.parse import cobertura_texto


def _doc():
    return {
        "pages": {"1": {}, "2": {}, "3": {}, "4": {}},
        "texts": [
            {"text": "Formulário de Referência", "prov": [{"page_no": 1}]},
            {"text": "   ", "prov": [{"page_no": 2}]},  # só espaços: não conta
            {"text": "Histórico do emissor", "prov": [{"page_no": 3}]},
        ],
        "tables": [{"prov": [{"page_no": 4}]}],
    }


def test_cobertura_conta_texto_e_tabela_e_lista_paginas_sem_texto():
    cob = cobertura_texto(_doc())
    assert cob["paginas"] == 4
    assert cob["com_texto"] == 3
    assert cob["sem_texto"] == [2]
    assert cob["tabelas"] == 1
    assert cob["itens_de_texto"] == 2


def test_cobertura_total_quando_todas_as_paginas_tem_texto():
    doc = _doc()
    doc["texts"][1]["text"] = "Sumário"
    assert cobertura_texto(doc)["sem_texto"] == []
