import json

from indexer import extrair
from indexer.extrair import chave_de_cache, extrair_todas, resumir, unidades, validar

VAZIO = {k: [] for k in extrair.TIPOS}
FATO = {
    "metric": "Lucro líquido", "value": 16782, "unit": "currency", "currency": "BRL", "scale": 1_000_000,
    "period": "2025-FY", "period_type": "fiscal_year", "entity": "Banco do Brasil",
    "evidence": "Lucro líquido de R$ 16.782 milhões",
}  # fmt: skip


def resp(obj=None, finish="stop"):
    return {"conteudo": json.dumps(obj if obj is not None else VAZIO), "finish": finish,
            "tokens_prompt": 100, "tokens_saida": 20}  # fmt: skip


def chunks():
    return {
        "pais": [
            {"id": "p1", "caminho": ["Cap", "Sec"], "texto": "Lucro de R$ 1 milhão.", "tokens": 60,
             "pagina_inicio": 3, "pagina_fim": 4},
            {"id": "p2", "caminho": ["Cap"], "texto": "Título", "tokens": 5,
             "pagina_inicio": 3, "pagina_fim": 3},
        ]
    }  # fmt: skip


def tabelas():
    return [
        {"id": "t1", "caminho": ["Cap"], "paginas": [7], "markdown": "| a | b |", "anterior": "", "notas": [],
         "escala": 1_000_000, "moeda": "BRL"}
    ]  # fmt: skip


def test_unidades_pulam_pais_minusculos_e_montam_o_pedido():
    u = unidades(chunks(), tabelas())
    assert [(x["id"], x["tipo"], x["paginas"]) for x in u] == [
        ("p1", "pai", [3, 4]),
        ("t1", "tabela", [7, 7]),
    ]
    assert "Seção: Cap › Sec" in u[0]["pedido"] and "Páginas: 3-4" in u[0]["pedido"]
    assert "Página: 7" in u[1]["pedido"] and "fator 1000000, moeda BRL" in u[1]["pedido"]


def test_validar_aceita_json_do_esquema_e_recusa_o_resto():
    obj, erro, _ = validar(resp({**VAZIO, "financial_facts": [FATO]}))
    assert erro is None and obj["financial_facts"][0]["value"] == 16782
    assert validar(resp(finish="length"))[1].startswith("saída cortada")
    assert "JSON inválido" in validar({"conteudo": "{nao e json", "finish": "stop"})[1]
    ruim = {**VAZIO, "financial_facts": [{**FATO, "period": "2025"}]}
    assert "period" in validar(resp(ruim))[1]
    assert validar(resp({"financial_facts": []}))[0] is None  # faltam as outras listas


def test_retentativa_leva_o_erro_e_conta_a_primeira_tentativa():
    vistas = []
    respostas = iter([resp(finish="length"), resp({**VAZIO, "financial_facts": [FATO]})])

    def gera(mensagens):
        vistas.append(mensagens)
        return next(respostas)

    r = extrair.extrair({"pedido": "x"}, gera)
    assert r["valida"] and r["tentativas"] == 2 and not r["primeira_valida"]
    assert r["tokens_saida"] == 40
    assert "cortada por tamanho" in vistas[1][-1]["content"] and vistas[1][-2]["role"] == "assistant"


def test_unidade_basis_points_com_reais_na_evidencia_e_reparada_e_contada():
    errado = {**FATO, "unit": "basis_points", "currency": None, "evidence": "R$ 625 milhões"}
    obj, erro, reparos = validar(resp({**VAZIO, "financial_facts": [errado]}))
    assert erro is None and reparos == 1
    assert obj["financial_facts"][0]["unit"] == "currency" and obj["financial_facts"][0]["currency"] == "BRL"
    # com "pontos-base" na evidência o rótulo é legítimo e nada é mexido
    bp = {**FATO, "unit": "basis_points", "scale": 1, "evidence": "queda de 25 pontos-base"}
    assert validar(resp({**VAZIO, "financial_facts": [bp]}))[2] == 0
    # sem R$ nem pontos-base não há como saber: continua inválido, para a retentativa
    sem = {**FATO, "unit": "basis_points", "evidence": "valor de 625"}
    assert validar(resp({**VAZIO, "financial_facts": [sem]}))[0] is None


def test_ajustes_deterministicos_period_type_e_moeda_e_idempotentes():
    erradas = {**FATO, "period_type": "quarter", "currency": None}
    outro = {
        **FATO,
        "period": "2025-Q4",
        "period_type": "quarter",
        "evidence": "US$ 3 milhões",
        "currency": None,
    }
    pct = {**FATO, "unit": "percent", "currency": None, "period": "2025-12-31", "period_type": "fiscal_year"}
    obj = {**VAZIO, "financial_facts": [erradas, outro, pct]}
    assert extrair.ajustar_fatos(obj) == {"period_type": 2, "currency": 2}
    fatos = obj["financial_facts"]
    assert [f["period_type"] for f in fatos] == ["fiscal_year", "quarter", "point_in_time"]
    assert [f["currency"] for f in fatos] == ["BRL", "USD", None]
    assert extrair.ajustar_fatos(obj) == {"period_type": 0, "currency": 0}


def test_teto_de_fatos_e_imposto_pelo_schema():
    lotado = {**VAZIO, "financial_facts": [FATO] * (extrair.MAX_FATOS + 1)}
    assert validar(resp(lotado))[0] is None
    assert validar(resp({**VAZIO, "financial_facts": [FATO] * extrair.MAX_FATOS}))[0] is not None


def test_duas_respostas_invalidas_deixam_a_unidade_invalida():
    r = extrair.extrair({"pedido": "x"}, lambda m: {"conteudo": "[]", "finish": "stop"})
    assert not r["valida"] and r["resposta"] is None and r["tentativas"] == 2 and r["erro"]


def test_cache_por_hash_retomada_nao_repete_chamadas(tmp_path):
    lista = unidades(chunks(), tabelas())
    chamadas = []

    def gera(mensagens):
        chamadas.append(1)
        return resp()

    primeira = extrair_todas(lista, gera, tmp_path)
    assert len(chamadas) == 2 and all(not r["do_cache"] for r in primeira)
    segunda = extrair_todas(lista, gera, tmp_path)
    assert len(chamadas) == 2 and all(r["do_cache"] for r in segunda)  # nenhuma chamada nova
    assert resumir(segunda)["chamadas"] == 0 and resumir(primeira)["chamadas"] == 2
    assert not list(tmp_path.glob("*.tmp"))


def test_interrompida_no_meio_so_repete_o_que_faltou(tmp_path):
    lista = unidades(chunks(), tabelas())
    n = {"c": 0}

    def cai_na_segunda(mensagens):
        n["c"] += 1
        if n["c"] == 2:
            raise ConnectionError("o PC reiniciou")
        return resp()

    try:
        extrair_todas(lista, cai_na_segunda, tmp_path, paralelismo=1)
    except ConnectionError:
        pass
    chamadas = []
    extrair_todas(lista, lambda m: chamadas.append(1) or resp(), tmp_path, paralelismo=1)
    assert len(chamadas) == 1  # só a unidade que não terminou


def test_entrada_invalida_do_cache_e_tentada_de_novo_e_a_chave_muda_com_o_pedido(tmp_path):
    u = unidades(chunks(), tabelas())[0]
    extrair_todas([u], lambda m: {"conteudo": "[]", "finish": "stop"}, tmp_path)
    chamadas = []
    r = extrair_todas([u], lambda m: chamadas.append(1) or resp(), tmp_path)[0]
    assert r["valida"] and len(chamadas) == 1
    assert chave_de_cache(u) != chave_de_cache({**u, "pedido": u["pedido"] + "!"})
    assert chave_de_cache(u) != chave_de_cache(u, "outro-modelo")


def test_resumo_conta_itens_validade_e_tokens():
    ok = {"valida": True, "primeira_valida": True, "do_cache": False, "chamadas": 1, "tokens_prompt": 10,
          "tokens_saida": 5, "segundos": 2.0, "tipo": "pai", "id": "a",
          "resposta": {**VAZIO, "financial_facts": [FATO, FATO]}}  # fmt: skip
    ruim = {**ok, "valida": False, "primeira_valida": False, "id": "b", "tipo": "tabela", "resposta": None}
    cacheada = {**ok, "do_cache": True, "chamadas": 0, "id": "c"}
    s = resumir([ok, ruim, cacheada])
    assert s["unidades"] == 3 and s["validas"] == 2 and s["invalidas"] == ["b"] and s["do_cache"] == 1
    assert s["itens"]["financial_facts"] == 4 and s["chamadas"] == 2
    assert s["tokens_prompt"] == 20 and s["por_tipo"] == {"pai": 2, "tabela": 1}
