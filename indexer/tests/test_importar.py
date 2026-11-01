import pytest

from indexer.importar import (
    NOS,
    PASSOS,
    VINCULOS_DE_METRICA_FORA_DO_PLANO,
    carregar,
    id_da_entidade,
    id_do_fato,
    limites_do_periodo,
    normalizar,
    preparar,
    unidade_nao_declarada,
)

DOC = "doc-exemplo"
TIPOS_DE_DOMINIO = ("Person", "Segment", "RiskFactor", "Event", "Instrument")
TABELA_EM_MILHOES = (
    "Escala/moeda declarada: fator 1000000, moeda BRL\n\nTabela (Markdown)\n| R$ milhões | 2025 |\n"
)
TABELA_SEM_UNIDADE = "Escala/moeda declarada: nenhuma declarada\n\nTabela (Markdown)\n| Fator | Resultado |\n"


def fato(**kw):
    base = {
        "metric": "Receita total", "value": 1210, "unit": "currency", "currency": "BRL",
        "scale": 1_000_000, "period": "2025-FY", "period_type": "fiscal_year",
        "entity": "Empresa Exemplo S.A.", "segment": None, "evidence": "Receita total | 1.210",
    }  # fmt: skip
    return base | kw


def registro(unidade="u1", tipo="tabela", motivo="aceito", **kw):
    return {
        "unidade": unidade,
        "tipo": tipo,
        "paginas": [10, 10],
        "posicao": 0,
        "motivo": motivo,
        "fato": fato(**kw),
    }


def resposta(**listas):
    vazio = {"financial_facts": [], "organizations": [], "people": [], "segments": [],
             "risk_factors": [], "events": [], "instruments": []}  # fmt: skip
    return {**vazio, **listas}


def unidade(id_="u1", tipo="tabela", valida=True, **listas):
    return {"id": id_, "tipo": tipo, "paginas": [10, 10], "valida": valida,
            "resposta": resposta(**listas) if valida else None}  # fmt: skip


PEDIDOS = {"u1": TABELA_EM_MILHOES, "u2": TABELA_SEM_UNIDADE, "p1": "Trecho de texto."}


class DriverFalso:
    def __init__(self):
        self.chamadas = []

    def execute_query(self, cypher, parametros=None, database_=None):
        self.chamadas.append((cypher, parametros))


def _linhas_vazias():
    return {chave: [] for chave, _ in PASSOS}


def test_carregar_remove_vinculos_de_metrica_que_o_plano_nao_tem_mais():
    linhas = _linhas_vazias()
    linhas["metricas"] = [{"id": "metric:a", "props": {"id": "metric:a"}}]
    linhas["of_metric"] = [{"de": "fact:1", "para": "metric:a", "qualifier": "nenhum", "dimension": None}]
    driver = DriverFalso()
    carregar(driver, linhas)
    ultima = driver.chamadas[-1]
    assert ultima[0] == VINCULOS_DE_METRICA_FORA_DO_PLANO
    assert ultima[1] == {"chaves": ["fact:1|metric:a"]}


def test_carregar_sem_metricas_no_plano_nao_apaga_vinculo_nenhum():
    driver = DriverFalso()
    carregar(driver, _linhas_vazias())
    assert all(c[0] != VINCULOS_DE_METRICA_FORA_DO_PLANO for c in driver.chamadas)


def test_a_remocao_so_toca_em_vinculos_of_metric():
    assert VINCULOS_DE_METRICA_FORA_DO_PLANO.count("DELETE") == 1
    assert "[x:OF_METRIC]" in VINCULOS_DE_METRICA_FORA_DO_PLANO
    assert "DETACH" not in VINCULOS_DE_METRICA_FORA_DO_PLANO


def test_normalizar_tira_caixa_acento_e_pontuacao():
    assert normalizar("  Banco do Brasil S.A. ") == "banco do brasil s a"
    assert normalizar("Conselho de Administração") == normalizar("CONSELHO  DE ADMINISTRACAO")
    assert normalizar(None) == ""


def test_id_do_fato_e_estavel_e_nao_depende_de_escala_nem_de_unidade_do_valor():
    base = id_do_fato(DOC, "u1", fato())
    assert base == id_do_fato(DOC, "u1", fato())
    assert base.startswith("fact:")
    assert base == id_do_fato(
        DOC, "u1", fato(scale=1_000, unit="ratio", currency=None)
    )  # a escala se corrige


@pytest.mark.parametrize(
    "campo",
    [
        {"metric": "Despesa total"},
        {"period": "2024-FY"},
        {"entity": "Outra S.A."},
        {"segment": "Varejo"},
        {"value": 70},
        {"evidence": "Receita total | 1.210 | Var."},
    ],
)
def test_fatos_diferentes_na_mesma_unidade_tem_ids_diferentes(campo):
    assert id_do_fato(DOC, "u1", fato()) != id_do_fato(DOC, "u1", fato(**campo))


def test_mesmo_fato_em_outra_unidade_ou_outro_documento_e_outro_id():
    assert id_do_fato(DOC, "u1", fato()) != id_do_fato(DOC, "u2", fato())
    assert id_do_fato(DOC, "u1", fato()) != id_do_fato("outro", "u1", fato())


def test_id_do_fato_ignora_caixa_e_espacos_da_metrica():
    assert id_do_fato(DOC, "u1", fato()) == id_do_fato(DOC, "u1", fato(metric="  RECEITA   total "))


def test_id_da_entidade_une_grafias_que_so_diferem_na_normalizacao():
    assert id_da_entidade("Organization", "Banco do Brasil S.A.") == id_da_entidade(
        "Organization", "BANCO DO BRASIL S A"
    )
    assert id_da_entidade("Organization", "Alfa") != id_da_entidade("Segment", "Alfa")


@pytest.mark.parametrize(
    "periodo,esperado",
    [
        ("2025-FY", ("2025-01-01", "2025-12-31")),
        ("2025-Q1", ("2025-01-01", "2025-03-31")),
        ("2025-Q2", ("2025-04-01", "2025-06-30")),
        ("2025-Q3", ("2025-07-01", "2025-09-30")),
        ("2025-Q4", ("2025-10-01", "2025-12-31")),
        ("2025-09-30", ("2025-09-30", "2025-09-30")),
    ],
)
def test_limites_do_periodo(periodo, esperado):
    assert limites_do_periodo(periodo) == esperado


def test_unidade_monetaria_so_e_nao_declarada_sem_escala_valor_inteiro_e_sem_escala_no_texto():
    sem = fato(scale=1, value=59016)
    assert unidade_nao_declarada(sem, TABELA_SEM_UNIDADE)
    assert not unidade_nao_declarada(sem, TABELA_EM_MILHOES)  # a tabela declara
    assert not unidade_nao_declarada(fato(scale=1, value=15380219.22), TABELA_SEM_UNIDADE)  # centavos: reais
    assert not unidade_nao_declarada(fato(scale=1_000_000, value=59016), TABELA_SEM_UNIDADE)
    assert not unidade_nao_declarada(fato(unit="percent", scale=1, value=7), TABELA_SEM_UNIDADE)


def test_so_o_fato_aceito_entra_e_ele_aponta_para_a_unidade_o_periodo_e_a_entidade():
    registros = [registro(), registro(motivo="unidade", metric="Rejeitado")]
    linhas = preparar(registros, [unidade()], PEDIDOS, DOC)
    assert len(linhas["fatos"]) == 1
    f = linhas["fatos"][0]
    assert f["props"]["documentId"] == DOC and f["props"]["page"] == 10 and f["props"]["unitDeclared"] is True
    assert linhas["reported_in_tabela"] == [{"de": f["id"], "para": "u1"}] and linhas["reported_in_pai"] == []
    assert linhas["periodos"] == [{"id": "2025-FY", "start": "2025-01-01", "end": "2025-12-31"}]
    assert linhas["for_period"] == [{"de": f["id"], "para": "2025-FY"}]
    (org,) = linhas["Organization"]
    assert linhas["about"] == [{"de": f["id"], "para": org["id"]}]
    assert org["props"]["type"] == "ORGANIZATION" and org["props"]["name"] == "Empresa Exemplo S.A."
    assert linhas["mentioned_in_tabela"] == [{"de": org["id"], "para": "u1"}]


def test_fato_identico_na_mesma_unidade_e_fundido_e_com_evidencia_diferente_nao_e():
    iguais = [registro(), registro()]
    assert len(preparar(iguais, [], PEDIDOS, DOC)["fatos"]) == 1
    distintos = [registro(), registro(evidence="Receita total | 2025 | 1.210")]
    assert len(preparar(distintos, [], PEDIDOS, DOC)["fatos"]) == 2


def test_entidade_generica_de_fato_nao_vira_organizacao():
    linhas = preparar([registro(entity="Total")], [], PEDIDOS, DOC)
    assert linhas["Organization"] == [] and linhas["about"] == []
    assert len(linhas["fatos"]) == 1


def test_fato_sem_unidade_declarada_recebe_a_marca_e_nao_e_convertido():
    r = registro(unidade="u2", metric="Taxa", value=59016, scale=1)
    (f,) = preparar([r], [], PEDIDOS, DOC)["fatos"]
    assert f["props"]["unitDeclared"] is False
    assert f["props"]["value"] == 59016 and f["props"]["scale"] == 1


def organizacao(nome="Banco Alfa S.A.", papel="subsidiary", **kw):
    return {"name": nome, "role": papel, "description": None, "cnpj": None, "ticker": None} | kw


def test_mencoes_do_mesmo_nome_viram_um_no_com_aliases_e_varias_origens():
    resultados = [
        unidade("p1", "pai", organizations=[organizacao(description="Banco")]),
        unidade("p2", "pai", organizations=[organizacao("BANCO ALFA S A", "affiliate", cnpj="00")]),
    ]
    linhas = preparar([], resultados, PEDIDOS | {"p2": ""}, DOC)
    (org,) = linhas["Organization"]
    p = org["props"]
    assert p["aliases"] == ["BANCO ALFA S A", "Banco Alfa S.A."]
    assert p["aliasesText"] == "BANCO ALFA S A | Banco Alfa S.A."
    assert p["roles"] == ["affiliate", "subsidiary"] and p["description"] == "Banco" and p["cnpj"] == "00"
    assert sorted(x["para"] for x in linhas["mentioned_in_pai"]) == ["p1", "p2"]


def test_entidades_de_dominio_ganham_tipo_relacoes_e_origem():
    banco_alfa = "Banco Alfa"
    resultados = [
        unidade(
            "p1", "pai",
            people=[{"name": "Ana Souza", "position": "Diretora", "organization": banco_alfa}],
            segments=[{"name": "Varejo", "organization": banco_alfa, "description": None}],
            risk_factors=[{"name": "Risco de crédito", "category": "credit", "description": "d",
                           "affected_entity": banco_alfa}],
            events=[{"type": "issuance", "description": "Emissão", "date": "2025-06",
                     "organizations": [banco_alfa]}],
            instruments=[{"name": "IHCD", "type": "debenture", "issuer": banco_alfa, "maturity": None,
                          "description": None}],
        )
    ]  # fmt: skip
    linhas = preparar([], resultados, PEDIDOS, DOC)
    (banco,) = linhas["Organization"]
    tipos = {r: [x["props"]["type"] for x in linhas[r]] for r in TIPOS_DE_DOMINIO}
    assert tipos == {
        "Person": ["PERSON"], "Segment": ["SEGMENT"], "RiskFactor": ["RISK"], "Event": ["EVENT"],
        "Instrument": ["FINANCIAL_INSTRUMENT"],
    }  # fmt: skip
    (pessoa,) = linhas["Person"]
    assert linhas["holds_position"] == [{"de": pessoa["id"], "para": banco["id"], "title": "Diretora"}]
    assert linhas["has_segment"] == [{"de": banco["id"], "para": linhas["Segment"][0]["id"]}]
    alvos = [linhas[r][0]["para"] for r in ("affects", "involves", "issued_by")]
    assert alvos == [banco["id"]] * 3
    risco = linhas["RiskFactor"][0]["id"]
    assert {"de": risco, "para": "p1"} in linhas["described_in_pai"]  # o risco é DESCRIBED_IN
    assert all(x["de"] != risco for x in linhas["mentioned_in_pai"])
    evento = linhas["Event"][0]["props"]
    assert evento["eventType"] == "issuance" and evento["date"] == "2025-06"


def test_unidade_invalida_nao_contribui_e_preparar_e_repetivel():
    entrada = [unidade("p1", "pai", organizations=[organizacao("Alfa")]), unidade("p9", "pai", valida=False)]
    linhas = preparar([], entrada, PEDIDOS, DOC)
    assert len(linhas["Organization"]) == 1
    assert preparar([], entrada, PEDIDOS, DOC) == linhas


def test_toda_chave_de_preparar_tem_um_passo_e_vice_versa():
    linhas = preparar([registro()], [unidade()], PEDIDOS, DOC)
    assert set(linhas) == {chave for chave, _ in PASSOS}
    assert set(NOS) <= set(linhas)
