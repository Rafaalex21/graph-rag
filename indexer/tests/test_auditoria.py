from indexer.auditoria import comparar_numeros, numeros_do_texto, sortear


def test_numeros_em_formato_pt_br_com_sinal_parenteses_e_percentual():
    assert numeros_do_texto("Saldo 914.535 e (6,3) com 8,5 e -1,2% em 2025.") == [
        "914.535",
        "(6,3)",
        "8,5",
        "-1,2%",
        "2025",
    ]


def test_comparacao_acha_numero_com_digito_trocado_e_sinal_perdido():
    docling = ["Ativos", "914.535", "992.616", "(6,3)", "8,5"]
    pdf = "Ativos 914.535 992.516 6,3 8,5"
    c = comparar_numeros(docling, pdf)
    assert not c["identicos"]
    assert c["faltam_no_docling"] == {"992.516": 1, "6,3": 1}
    assert c["sobram_no_docling"] == {"992.616": 1, "(6,3)": 1}


def test_comparacao_identica_ignora_ordem_e_espacos():
    assert comparar_numeros(["1.234", "5,6"], "5,6\n  1.234")["identicos"]


def test_sorteio_e_reprodutivel_e_independe_da_ordem_de_entrada():
    refs = [f"#/tables/{i}" for i in range(40)]
    a = sortear(refs, 15, 7)
    b = sortear(list(reversed(refs)), 15, 7)
    assert a == b and len(set(a)) == 15
    assert sortear(refs, 15, 8) != a
