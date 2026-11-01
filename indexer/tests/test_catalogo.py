import json

from indexer.catalogo import (
    NENHUMA,
    buscar_termo,
    esquema_do_juiz,
    indice_de_termos,
    ler_catalogo,
    linhas_de_metricas,
    mapear,
    montar_pedido,
    resumo,
    rotulos,
    tipos_do_catalogo,
    validar,
)
from indexer.importar import preparar

CATALOGO = [
    {"id": "net_income", "name": "Net income", "name_pt": "Lucro líquido", "kind": "monetary",
     "definition": "Resultado final do período.", "aliases": ["profit", "lucro"]},
    {"id": "net_revenue", "name": "Net revenue", "name_pt": "Receita líquida", "kind": "monetary",
     "definition": "Receita depois das deduções.", "aliases": ["revenue", "receita", "faturamento"]},
    {"id": "credit_portfolio", "name": "Credit portfolio", "name_pt": "Carteira de crédito",
     "kind": "monetary", "definition": "Saldo das operações de crédito.", "aliases": []},
]  # fmt: skip
TIPOS = ["monetary", "percent", "ratio", "count", "price"]


def registro(rotulo, motivo="aceito", unidade="u1", evidencia="trecho", entidade="Banco X", pagina=10):
    return {
        "unidade": unidade, "tipo": "pai", "paginas": [pagina, pagina], "posicao": 0, "motivo": motivo,
        "fato": {
            "metric": rotulo, "value": 1.0, "unit": "currency", "currency": "BRL", "scale": 1,
            "period": "2025-FY", "period_type": "fiscal_year", "entity": entidade, "segment": None,
            "evidence": evidencia,
        },
    }  # fmt: skip


class JuizFalso:
    def __init__(self, respostas):
        self.respostas = respostas
        self.chamadas = []

    def __call__(self, mensagens):
        pedido = mensagens[-1]["content"]
        self.chamadas.append(pedido)
        rotulo = pedido.split("\n")[0].removeprefix("Rótulo da métrica: ")
        return self.respostas[rotulo]


def resposta(metrica, dimensao=None, qualificador="nenhum"):
    return {"metrica": metrica, "dimensao": dimensao, "qualificador": qualificador, "justificativa": "x"}


def test_catalogo_do_repositorio_esta_integro():
    catalogo = ler_catalogo()
    assert validar(catalogo, tipos_do_catalogo()) == []
    assert len(catalogo) >= 90


def test_validar_acusa_id_nome_tipo_e_termo_repetidos():
    ruim = [
        CATALOGO[0],
        {**CATALOGO[1], "id": "net_income", "kind": "dinheiro", "definition": " "},
        {**CATALOGO[2], "aliases": ["lucro"]},
    ]
    problemas = validar(ruim, TIPOS)
    assert any("id repetido" in p for p in problemas)
    assert any("tipo 'dinheiro'" in p for p in problemas)
    assert any("definição vazia" in p for p in problemas)
    assert any("termo 'lucro' aponta para" in p for p in problemas)


def test_validar_acusa_campo_ausente():
    assert any("faltam campos" in p for p in validar([{"id": "x"}], TIPOS))


def test_mapeamento_terminologico_pt_en_do_catalogo_real():
    indice = indice_de_termos(ler_catalogo())
    for termo in ("faturamento", "receita", "revenue", "Receita Líquida", "RECEITA"):
        assert buscar_termo(termo, indice) == "net_revenue", termo
    for termo in ("lucro", "Net income", "lucro líquido", "profit", "Lucro Liquido"):
        assert buscar_termo(termo, indice) == "net_income", termo
    assert buscar_termo("ROE", indice) == "return_on_equity"
    assert buscar_termo("Índice de Basileia", indice) == "basel_ratio"
    assert buscar_termo("assunto qualquer", indice) is None


def test_rotulos_conta_so_aceitos_e_guarda_contexto():
    regs = [
        registro("Lucro", evidencia="lucro 10", pagina=5),
        registro("Lucro", evidencia="lucro 20", pagina=7, unidade="u2"),
        registro("Lucro", evidencia="lucro 20", pagina=7, unidade="u3"),  # evidência repetida
        registro("Outro", motivo="unidade"),
    ]
    r = rotulos(regs)
    assert set(r) == {"Lucro"}
    assert r["Lucro"]["n"] == 3
    assert r["Lucro"]["evidencias"] == ["lucro 10", "lucro 20"]
    assert r["Lucro"]["paginas"] == {5, 7}
    assert r["Lucro"]["entidade"] == "Banco X"
    assert "Rótulo da métrica: Lucro" in montar_pedido("Lucro", r["Lucro"])


def test_a_secao_do_pedido_da_extracao_vai_ao_contexto_e_ao_prompt():
    pedidos = {
        "u1": "Documento: X\nSeção: RESULTADOS › Receita de Tarifas e Comissões\nPágina: 97\nTexto.",
        "u2": "Documento: X\nSeção: OUTRA\n",
    }
    regs = [registro("Conta Corrente", unidade="u1"), registro("Conta Corrente", unidade="u2")]
    ctx = rotulos(regs, pedidos)
    assert ctx["Conta Corrente"]["secao"] == "RESULTADOS › Receita de Tarifas e Comissões"  # a do 1º fato
    assert "Seção do documento: RESULTADOS › Receita de Tarifas e Comissões" in montar_pedido(
        "Conta Corrente", ctx["Conta Corrente"]
    )
    sem = rotulos(regs)
    assert sem["Conta Corrente"]["secao"] is None
    assert "Seção do documento: não informada" in montar_pedido("Conta Corrente", sem["Conta Corrente"])


def test_rotulos_vizinhos_da_mesma_unidade_vao_ao_contexto_e_ao_prompt():
    regs = [
        registro("Carteira de Crédito", unidade="t1"),
        registro("Agronegócios", unidade="t1"),
        registro("Empresas", unidade="t1"),
        registro("Agronegócios", unidade="t2"),  # outra unidade: o contexto é o da primeira
        registro("Outro", unidade="t2"),
    ]
    ctx = rotulos(regs)
    assert ctx["Agronegócios"]["irmas"] == ["Carteira de Crédito", "Empresas"]
    assert ctx["Outro"]["irmas"] == ["Agronegócios"]
    assert "Outros rótulos da mesma tabela ou trecho: Carteira de Crédito; Empresas" in montar_pedido(
        "Agronegócios", ctx["Agronegócios"]
    )
    sozinho = rotulos([registro("Único", unidade="t9")])
    assert "mesma tabela ou trecho: nenhum" in montar_pedido("Único", sozinho["Único"])


def test_termo_exato_nao_chama_o_llm_e_o_resto_sim(tmp_path):
    ctx = rotulos([registro("Faturamento"), registro("Financiamentos Rurais")])
    juiz = JuizFalso({"Financiamentos Rurais": resposta("credit_portfolio", "Financiamentos Rurais")})
    mapa = mapear(ctx, CATALOGO, juiz, tmp_path)
    assert mapa["Faturamento"] == {
        "metrica": "net_revenue", "dimensao": None, "qualificador": "nenhum", "por": "termo",
    }  # fmt: skip
    assert mapa["Financiamentos Rurais"]["metrica"] == "credit_portfolio"
    assert mapa["Financiamentos Rurais"]["dimensao"] == "Financiamentos Rurais"
    assert mapa["Financiamentos Rurais"]["por"] == "llm"
    assert len(juiz.chamadas) == 1


def test_cache_evita_repetir_a_chamada(tmp_path):
    ctx = rotulos([registro("Financiamentos Rurais")])
    juiz = JuizFalso({"Financiamentos Rurais": resposta("credit_portfolio", "Rurais")})
    mapear(ctx, CATALOGO, juiz, tmp_path)
    mapear(ctx, CATALOGO, juiz, tmp_path)
    assert len(juiz.chamadas) == 1


def test_dimensao_escrita_como_nenhuma_vira_nula(tmp_path):
    ctx = rotulos([registro("Lucro bruto"), registro("Vendas"), registro("Rurais")])
    juiz = JuizFalso({
        "Lucro bruto": resposta("net_income", "nenhuma"),
        "Vendas": resposta("net_revenue", " N/A "),
        "Rurais": resposta("credit_portfolio", " Rurais "),
    })  # fmt: skip
    mapa = mapear(ctx, CATALOGO, juiz, tmp_path)
    # "nenhuma" e "N/A" não são recortes: viram nulos e, sem ser termo do catálogo, o rótulo é a dimensão
    assert mapa["Lucro bruto"]["dimensao"] == "Lucro bruto"
    assert mapa["Vendas"]["dimensao"] == "Vendas"
    assert mapa["Rurais"]["dimensao"] == "Rurais"  # o recorte do modelo, sem espaços sobrando


def test_componente_do_catalogo_resolve_sem_llm_com_o_proprio_termo_como_dimensao(tmp_path):
    catalogo = [{**CATALOGO[2], "componentes": ["Financiamentos Rurais"]}, *CATALOGO[:2]]
    ctx = rotulos([registro("financiamentos rurais"), registro("Carteira de crédito")])
    juiz = JuizFalso({})
    mapa = mapear(ctx, catalogo, juiz, tmp_path)
    assert mapa["financiamentos rurais"] == {
        "metrica": "credit_portfolio", "dimensao": "financiamentos rurais", "qualificador": "nenhum",
        "por": "termo",
    }  # fmt: skip
    assert mapa["Carteira de crédito"]["dimensao"] is None  # o termo do catálogo é o total
    assert juiz.chamadas == []


def test_validar_acusa_componente_que_e_sinonimo_de_outra_metrica():
    ruim = [CATALOGO[0], {**CATALOGO[1], "componentes": ["profit"]}]
    assert any("termo 'profit' aponta para" in p for p in validar(ruim, TIPOS))


def test_rotulo_do_llm_sem_recorte_vira_a_propria_dimensao_e_so_o_termo_do_catalogo_fica_sem(tmp_path):
    ctx = rotulos([registro("Receita Líquida"), registro("Financiamentos"), registro("Variação do lucro")])
    juiz = JuizFalso({
        "Financiamentos": resposta("credit_portfolio", None),
        "Variação do lucro": resposta("net_income", None, "variacao_percentual"),
    })  # fmt: skip
    mapa = mapear(ctx, CATALOGO, juiz, tmp_path)
    assert mapa["Receita Líquida"]["dimensao"] is None  # termo do catálogo: o total
    assert mapa["Financiamentos"]["dimensao"] == "Financiamentos"  # não é o termo, não pode passar por total
    assert mapa["Variação do lucro"]["dimensao"] is None  # variação do total: sem recorte


def test_fatia_de_uma_metrica_ja_percentual_vira_nenhum(tmp_path):
    catalogo = [*CATALOGO, {**CATALOGO[0], "id": "ownership", "name": "Ownership", "name_pt": "Participação",
                            "kind": "percent", "aliases": []}]  # fmt: skip
    ctx = rotulos([registro("Ações em tesouraria - % do total"), registro("PL % do passivo")])
    juiz = JuizFalso({
        "Ações em tesouraria - % do total": resposta("ownership", "Tesouraria", "percentual_do_total"),
        "PL % do passivo": resposta("net_income", None, "percentual_do_total"),
    })  # fmt: skip
    mapa = mapear(ctx, catalogo, juiz, tmp_path)
    assert mapa["Ações em tesouraria - % do total"]["qualificador"] == "nenhum"
    assert mapa["PL % do passivo"]["qualificador"] == "percentual_do_total"  # monetária: a fatia faz sentido


def test_resposta_com_id_fora_do_catalogo_vira_nenhuma(tmp_path):
    ctx = rotulos([registro("Coisa"), registro("Variação do lucro")])
    juiz = JuizFalso({
        "Coisa": resposta("inventada", "x"),
        "Variação do lucro": resposta("net_income", None, "variacao_percentual"),
    })  # fmt: skip
    mapa = mapear(ctx, CATALOGO, juiz, tmp_path)
    assert mapa["Coisa"] == {
        "metrica": NENHUMA, "dimensao": None, "qualificador": "nenhum", "por": "llm", "justificativa": "x",
    }  # fmt: skip
    assert mapa["Variação do lucro"]["qualificador"] == "variacao_percentual"


def test_esquema_do_juiz_limita_a_metrica_ao_catalogo():
    esquema = esquema_do_juiz(CATALOGO)
    assert esquema["properties"]["metrica"]["enum"] == [
        "net_income",
        "net_revenue",
        "credit_portfolio",
        NENHUMA,
    ]
    assert esquema["additionalProperties"] is False


def test_resumo_mede_a_fracao_de_fatos_ligados(tmp_path):
    ctx = rotulos([registro("Faturamento"), registro("Faturamento", unidade="u2"), registro("Coisa")])
    juiz = JuizFalso({"Coisa": resposta(NENHUMA)})
    mapa = mapear(ctx, CATALOGO, juiz, tmp_path)
    r = resumo(mapa, ctx)
    assert (r["fatos"], r["fatos_ligados"], r["rotulos_ligados"]) == (3, 2, 1)
    assert r["fracao_de_fatos_ligados"] == round(2 / 3, 4)
    assert (r["por_termo"], r["por_llm"]) == (1, 1)


def test_linhas_de_metricas_criam_nos_do_catalogo_e_um_vinculo_por_fato_mapeado():
    fatos = {
        "f1": {"id": "f1", "props": {"metric": "Faturamento"}},
        "f2": {"id": "f2", "props": {"metric": "Coisa"}},
        "f3": {"id": "f3", "props": {"metric": "Crescimento do lucro"}},
    }
    mapa = {
        "Faturamento": {"metrica": "net_revenue", "dimensao": None, "qualificador": "nenhum", "por": "termo"},
        "Coisa": {"metrica": NENHUMA, "dimensao": None, "qualificador": "nenhum", "por": "llm"},
        "Crescimento do lucro": {
            "metrica": "net_income", "dimensao": None, "qualificador": "variacao_percentual", "por": "llm",
        },
    }  # fmt: skip
    linhas = linhas_de_metricas(CATALOGO, mapa, fatos)
    assert [n["id"] for n in linhas["metricas"]] == [
        "metric:net_income", "metric:net_revenue", "metric:credit_portfolio",
    ]  # fmt: skip
    assert linhas["metricas"][1]["props"]["name"] == "Net revenue"
    assert linhas["metricas"][1]["props"]["namePt"] == "Receita líquida"
    assert linhas["of_metric"] == [
        {"de": "f1", "para": "metric:net_revenue", "qualifier": "nenhum", "dimension": None},
        {"de": "f3", "para": "metric:net_income", "qualifier": "variacao_percentual", "dimension": None},
    ]  # fmt: skip


def test_preparar_sem_catalogo_nao_cria_metricas_e_com_catalogo_nao_muda_os_ids_dos_fatos():
    regs = [registro("Faturamento")]
    pedidos = {"u1": "Texto."}
    sem = preparar(regs, [], pedidos, "doc")
    mapa = {
        "Faturamento": {"metrica": "net_revenue", "dimensao": None, "qualificador": "nenhum", "por": "termo"}
    }
    com = preparar(regs, [], pedidos, "doc", None, None, CATALOGO, mapa)
    assert sem["metricas"] == [] and sem["of_metric"] == []
    assert len(com["metricas"]) == 3 and len(com["of_metric"]) == 1
    assert com["fatos"] == sem["fatos"]
    assert json.dumps(com["of_metric"][0]["de"]) == json.dumps(com["fatos"][0]["id"])
