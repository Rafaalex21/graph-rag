import json

from indexer.tabelas import (
    ESQUEMA,
    descrever,
    gerar_todas,
    grade_para_markdown,
    linhas_para_o_grafo,
    montar_pedido,
    preparar_tabelas,
    validar,
)


def cel(texto, r, c, cab=False, rs=1, cs=1):
    return {
        "text": texto,
        "column_header": cab,
        "row_header": False,
        "start_row_offset_idx": r,
        "start_col_offset_idx": c,
        "end_row_offset_idx": r + rs,
        "end_col_offset_idx": c + cs,
    }


GRADE = [
    [cel("", 0, 0, True), cel("2025", 0, 1, True, cs=2), cel("2025", 0, 1, True, cs=2)],
    [cel("Depósitos (A)", 1, 0), cel("835.670", 1, 1), cel("(101.806)", 1, 2)],
]
VALIDA = {
    "descricao": "Tabela de depósitos do banco em 2025, em R$ milhões, com os componentes do total.",
    "perguntas": [
        "Qual o total de depósitos em 2025?",
        "Como variaram os depósitos?",
        "Quanto vale a linha A?",
    ],
}


def test_markdown_cabecalho_separador_celula_mesclada_so_na_origem_e_pipe_escapado():
    md = grade_para_markdown(GRADE).splitlines()
    assert md[0] == "|  | 2025 |  |"  # a célula mesclada aparece só na posição de origem
    assert md[1] == "|---|---|---|"
    assert md[2] == "| Depósitos (A) | 835.670 | (101.806) |"
    g = [[cel("a|b", 0, 0)]]
    assert (
        grade_para_markdown(g).splitlines()[0] == "| a\\|b |"
    )  # sem cabeçalho marcado, a 1ª linha é o cabeçalho
    assert grade_para_markdown([]) == ""


def test_validar_aceita_resposta_boa_e_acusa_cada_defeito():
    assert validar(VALIDA) == []
    assert any("perguntas" in e for e in validar({**VALIDA, "perguntas": ["Só uma pergunta aqui?"]}))
    assert any(
        "perguntas" in e
        for e in validar({**VALIDA, "perguntas": [f"Pergunta número {i} aqui?" for i in range(6)]})
    )
    assert any("repetidas" in e for e in validar({**VALIDA, "perguntas": ["Qual o total aqui?"] * 3}))
    assert any(
        "'?'" in e
        for e in validar({**VALIDA, "perguntas": ["Pergunta um sem ponto", "Qual a dois?", "Qual a três?"]})
    )
    assert any(
        "a tabela" in e
        for e in validar(
            {**VALIDA, "perguntas": ["O que a tabela mostra aqui?", "Qual a dois?", "Qual a três?"]}
        )
    )
    assert any("descrição" in e for e in validar({**VALIDA, "descricao": "curta"}))
    assert validar("lixo") == ["resposta não é um objeto JSON"]


def tabela(**extra):
    base = {
        "id": "t1",
        "ref": "#/tables/0",
        "secao_id": "doc:s1",
        "caminho": ["Captações", "Depósitos"],
        "paginas": [84],
        "linhas": 2,
        "colunas": 3,
        "markdown": "| a |\n|---|\n| 1 |",
        "notas": ["Obs: x"],
        "anterior": "Texto antes.",
        "escala": 1_000_000,
        "moeda": "BRL",
    }
    return {**base, **extra}


def test_pedido_leva_contexto_escala_e_corta_tabela_gigante():
    p = montar_pedido(tabela(), "Doc X")
    assert "Doc X" in p and "Captações › Depósitos" in p and "Página: 84" in p
    assert "fator 1000000, moeda BRL" in p and "Obs: x" in p and "Texto antes." in p
    assert "[... tabela cortada ...]" in montar_pedido(tabela(markdown="x" * 20000), "Doc")
    assert "nenhuma declarada" in montar_pedido(tabela(escala=None, moeda=None), "Doc")
    assert "Página: 5-6" in montar_pedido(tabela(paginas=[5, 6]), "Doc")


def test_descrever_faz_uma_retentativa_com_os_erros_anexados():
    chamadas = []

    def gera(mensagens):
        chamadas.append(mensagens)
        return {"descricao": "x", "perguntas": []} if len(chamadas) == 1 else VALIDA

    r = descrever(tabela(), gera, "Doc")
    assert r["valida"] and r["tentativas"] == 2 and r["perguntas"] == VALIDA["perguntas"]
    assert "Corrija estes problemas" in chamadas[1][-1]["content"] and chamadas[1][-2]["role"] == "assistant"
    ruim = descrever(tabela(), lambda m: {"descricao": "x", "perguntas": []}, "Doc")
    assert not ruim["valida"] and ruim["tentativas"] == 3 and ruim["erros"]  # desiste na 3ª


def test_gerar_todas_usa_cache_por_hash_e_nao_chama_o_llm_de_novo(tmp_path):
    n = []

    def gera(mensagens):
        n.append(1)
        return VALIDA

    ts = [tabela(id="t1"), tabela(id="t2", markdown="| b |\n|---|\n| 2 |")]
    r1 = gerar_todas(ts, gera, "Doc", tmp_path, paralelismo=1)
    assert len(n) == 2 and not any(x["do_cache"] for x in r1)
    r2 = gerar_todas(ts, gera, "Doc", tmp_path, paralelismo=1)
    assert len(n) == 2 and all(x["do_cache"] for x in r2) and r2[0]["perguntas"] == VALIDA["perguntas"]
    # mudar a tabela invalida o cache
    gerar_todas([tabela(markdown="| outra |\n|---|\n| 9 |")], gera, "Doc", tmp_path, paralelismo=1)
    assert len(n) == 3


def test_linhas_do_grafo_tem_ids_deterministicos_e_ligam_secao_tabela_pergunta():
    t = {**tabela(), **VALIDA}
    a, b = linhas_para_o_grafo([t], "doc"), linhas_para_o_grafo([t], "doc")
    assert a == b and len(a["perguntas"]) == 3 and len({q["id"] for q in a["perguntas"]}) == 3
    assert a["tem_tabela"] == [{"de": "doc:s1", "para": "t1"}]
    assert {x["de"] for x in a["tem_pergunta"]} == {"t1"}
    no = a["tabelas"][0]
    assert no["scale"] == 1_000_000 and no["currency"] == "BRL" and no["pageStart"] == 84 and no["rows"] == 2


def test_preparar_tabelas_junta_secao_paginas_notas_texto_anterior_e_escala():
    docling = {
        "tables": [
            {"self_ref": "#/tables/0", "data": {"grid": GRADE, "num_rows": 2, "num_cols": 3}},
        ]
    }
    elementos = [
        {"id": "h", "tipo": "section_header", "texto": "Captações", "paginas_originais": [84]},
        {
            "id": "t",
            "tipo": "text",
            "texto": "Valores em R$ milhões, exceto percentuais.",
            "paginas_originais": [84],
        },
        {
            "id": "#/tables/0",
            "tipo": "table",
            "texto": None,
            "paginas_originais": [84],
            "notas": [{"texto": "Obs: dados gerenciais."}],
        },
    ]
    arvore = [{"id": "s1", "indice_inicio": 0, "caminho": ["Captações"], "nivel": 1, "pai": None}]
    (t,) = preparar_tabelas(docling, elementos, arvore, "doc")
    assert t["secao_id"] == "doc:s1" and t["caminho"] == ["Captações"] and t["paginas"] == [84]
    assert t["notas"] == ["Obs: dados gerenciais."] and t["anterior"].startswith("Valores em R$ milhões")
    assert t["escala"] == 1_000_000 and t["moeda"] == "BRL" and t["linhas"] == 2
    assert t["markdown"].startswith("|  | 2025 |")
    assert json.dumps(ESQUEMA)  # o esquema é serializável (vai no response_format)


def test_validar_rejeita_valor_numerico_na_pergunta_e_a_palavra_fator_na_descricao():
    com_valor = {
        **VALIDA,
        "perguntas": ["Qual a projeção de 37,0 a 40,0 para 2024?", "Qual a dois?", "Qual a três?"],
    }
    assert any("valor numérico" in e for e in validar(com_valor))
    com_milhar = {**VALIDA, "perguntas": ["O saldo de 1.045.338 subiu?", "Qual a dois?", "Qual a três?"]}
    assert any("valor numérico" in e for e in validar(com_milhar))
    # anos e datas são permitidos
    ok = {
        **VALIDA,
        "perguntas": ["Qual o saldo em 31/12/2025?", "Como foi 2024 contra 2025?", "Qual a três?"],
    }
    assert validar(ok) == []
    assert any(
        "fator" in e
        for e in validar({**VALIDA, "descricao": "Valores em escala de fator 1.000.000 do banco."})
    )


def test_prompt_pede_qualificador_unidade_declarada_e_resposta_possivel():
    p = montar_pedido(tabela(), "Doc")
    texto = " ".join(p.split())
    assert (
        "em TODAS as perguntas" in texto and "na dúvida, não afirme" in texto and "não peça um total" in texto
    )


def test_numero_de_secao_nao_e_valor_e_cache_invalido_nao_e_reaproveitado(tmp_path):
    ok = {**VALIDA, "perguntas": ["O que mudou nas seções 7.3 e 7.4?", "Qual a dois?", "Qual a três?"]}
    assert validar(ok) == []
    respostas = [{"descricao": "x", "perguntas": []}] * 3 + [VALIDA]
    chamadas = []

    def gera(m):
        chamadas.append(1)
        return respostas[min(len(chamadas) - 1, len(respostas) - 1)]

    r1 = gerar_todas([tabela()], gera, "Doc", tmp_path, paralelismo=1)
    assert not r1[0]["valida"] and len(chamadas) == 3
    r2 = gerar_todas([tabela()], gera, "Doc", tmp_path, paralelismo=1)  # a entrada inválida é refeita
    assert r2[0]["valida"] and not r2[0]["do_cache"] and len(chamadas) == 4
