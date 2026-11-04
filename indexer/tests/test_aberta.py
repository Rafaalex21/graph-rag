import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from indexer import extracao_aberta as ea
from indexer.schemas import TIPOS_DE_ENTIDADE, VERSAO_ABERTA, ExtracaoAberta
from indexer.schemas.__main__ import ARQUIVO_ABERTA, gerar_aberta

RAIZ = Path(__file__).resolve().parents[2]


def entidade(nome="Banco do Brasil S.A.", tipo="ORGANIZATION", desc="Banco múltiplo."):
    return {"name": nome, "type": tipo, "description": desc}


def relacao(origem, destino, forca=5, desc="Relação citada no trecho."):
    return {"source": origem, "target": destino, "description": desc, "strength": forca}


def esquema():
    return json.loads(gerar_aberta())


def test_arquivo_versionado_em_contracts_esta_em_dia():
    versionado = (RAIZ / ARQUIVO_ABERTA).read_text(encoding="utf-8").replace("\r\n", "\n")
    assert versionado == gerar_aberta()
    assert esquema()["version"] == VERSAO_ABERTA


def test_os_onze_tipos_fixos_estao_no_schema_e_na_arquitetura():
    assert len(TIPOS_DE_ENTIDADE) == 11
    arquitetura = (RAIZ / "docs" / "ARQUITETURA.md").read_text(encoding="utf-8")
    for tipo in TIPOS_DE_ENTIDADE:
        assert f"`{tipo}`" in arquitetura
    assert esquema()["$defs"]["EntidadeAberta"]["properties"]["type"]["enum"] == list(TIPOS_DE_ENTIDADE)
    assert tuple(ea.DEFINICAO_DOS_TIPOS) == TIPOS_DE_ENTIDADE
    for tipo in TIPOS_DE_ENTIDADE:
        assert f"- {tipo}:" in ea.SISTEMA


def test_todo_campo_tem_descricao_e_nenhum_modelo_aceita_campo_a_mais():
    defs = esquema()["$defs"]
    assert set(defs) == {"EntidadeAberta", "RelacaoAberta"}
    for nome, d in {**defs, "ExtracaoAberta": esquema()}.items():
        assert d["additionalProperties"] is False, nome
        for campo, p in d["properties"].items():
            assert p.get("description"), f"{nome}.{campo} sem descrição"


def test_listas_sao_obrigatorias_e_podem_vir_vazias():
    assert ExtracaoAberta.model_validate({"entities": [], "relationships": []}).entities == []
    with pytest.raises(ValidationError):
        ExtracaoAberta.model_validate({"entities": []})


def test_tipo_fora_dos_dez_e_forca_fora_de_1_a_10_sao_rejeitados():
    with pytest.raises(ValidationError):
        ExtracaoAberta.model_validate({"entities": [entidade(tipo="COMPANY")], "relationships": []})
    for forca in (0, 11):
        with pytest.raises(ValidationError):
            ExtracaoAberta.model_validate(
                {
                    "entities": [entidade("A"), entidade("B")],
                    "relationships": [relacao("A", "B", forca)],
                }
            )


def test_o_schema_impoe_os_limites_por_gramatica():
    s = esquema()
    assert s["properties"]["entities"]["maxItems"] == 30
    assert s["properties"]["relationships"]["maxItems"] == 40
    assert s["$defs"]["RelacaoAberta"]["properties"]["strength"]["enum"] == list(range(1, 11))


def test_relacao_so_vale_entre_entidades_da_resposta_sem_olhar_caixa_nem_espacos():
    ok = {
        "entities": [entidade("Banco do Brasil S.A."), entidade("BB Seguridade", "ORGANIZATION")],
        "relationships": [relacao("banco  do brasil s.a.", "BB Seguridade")],
    }
    assert len(ExtracaoAberta.model_validate(ok).relationships) == 1
    solta = {"entities": [entidade("A")], "relationships": [relacao("A", "Fantasma")]}
    with pytest.raises(ValidationError, match="Fantasma"):
        ExtracaoAberta.model_validate(solta)


@pytest.mark.parametrize(
    "nome",
    ["14 de agosto de 2024", "08 de outubro de 2021", "1º de março", "agosto de 2024", "2025", "31/12/2025",
     "R$ 625 milhões", "R$ 7.055 mil", "27,1%", "95,11%", "US$ 1,5 bilhão", "625"],
)  # fmt: skip
def test_nome_que_e_so_data_ou_valor_nao_e_entidade(nome):
    with pytest.raises(ValidationError, match="data ou um valor"):
        ExtracaoAberta.model_validate({"entities": [entidade(nome, "EVENT")], "relationships": []})


@pytest.mark.parametrize(
    "nome",
    ["leilão de agosto de 2024", "Plano 2025", "Resolução CVM nº 85/22", "Lei 12.846/2013", "Basileia 17%",
     "Banco Digio S.A.", "Novo Mercado", "Decreto 8.945/2016"],
)  # fmt: skip
def test_nome_com_data_ou_numero_junto_de_palavras_e_entidade(nome):
    assert ExtracaoAberta.model_validate({"entities": [entidade(nome)], "relationships": []})


def test_o_erro_de_nome_que_e_data_vai_na_retentativa():
    ruim = {"entities": [entidade("14 de agosto de 2024", "EVENT")], "relationships": []}
    obj, erro = ea.validar(resposta_do_llm(ruim))
    assert obj is None and "entities.0.name" in erro and "data ou um valor" in erro


def test_exemplo_do_prompt_e_valido_para_o_proprio_schema():
    resp = ExtracaoAberta.model_validate(ea.EXEMPLO_RESPOSTA)
    assert {e.type for e in resp.entities} <= set(TIPOS_DE_ENTIDADE)
    assert {"POLICY_OR_PROGRAM", "FINANCIAL_METRIC"} <= {e.type for e in resp.entities}
    assert min(r.strength for r in resp.relationships) <= 3  # o exemplo usa a escala toda
    assert "Banco do Brasil" not in ea.SISTEMA  # exemplo fictício: nada do documento vai ao repositório


def pais(*tokens):
    return {
        "pais": [
            {
                "id": f"p{i}",
                "caminho": ["Seção"],
                "texto": f"texto {i}",
                "tokens": t,
                "pagina_inicio": i,
                "pagina_fim": i + 1,
            }
            for i, t in enumerate(tokens, start=1)
        ]
    }


def test_unidades_trazem_todos_os_pais_com_o_pedido_da_f4_2():
    lista = ea.unidades(pais(50, 400))
    assert [u["id"] for u in lista] == ["p1", "p2"]
    assert "Páginas: 2-3" in lista[1]["pedido"] and "texto 2" in lista[1]["pedido"]


def test_amostra_e_reproduzivel_ordenada_e_so_com_pais_de_tamanho_suficiente():
    lista = ea.unidades(pais(*([400] * 10 + [50] * 5)))
    a = ea.amostrar(lista, 5, semente=1)
    assert a == ea.amostrar(lista, 5, semente=1)
    assert a != ea.amostrar(lista, 5, semente=2)
    assert len(a) == 5 and all(u["tokens"] >= ea.MIN_TOKENS_AMOSTRA for u in a)
    assert [u["id"] for u in a] == sorted((u["id"] for u in a), key=lambda i: int(i[1:]))
    assert len(ea.amostrar(lista, 50, semente=1)) == 10


def resposta_do_llm(obj, finish="stop"):
    return {"conteudo": json.dumps(obj), "finish": finish, "tokens_prompt": 10, "tokens_saida": 5}


VALIDA = {"entities": [entidade()], "relationships": []}


def test_validar_aceita_valida_e_explica_saida_cortada_ou_invalida():
    assert ea.validar(resposta_do_llm(VALIDA))[0]["entities"][0]["name"] == "Banco do Brasil S.A."
    assert "cortada" in ea.validar(resposta_do_llm(VALIDA, "length"))[1]
    assert "JSON inválido" in ea.validar({"conteudo": "{", "finish": "stop"})[1]
    obj, erro = ea.validar(resposta_do_llm({"entities": [entidade(tipo="X")], "relationships": []}))
    assert obj is None and "entities.0.type" in erro


def test_extrair_repete_uma_vez_com_o_erro_anexado_e_depois_desiste():
    chamadas = []

    def gera(mensagens):
        chamadas.append(mensagens)
        return resposta_do_llm(VALIDA) if len(chamadas) == 2 else {"conteudo": "{", "finish": "stop"}

    r = ea.extrair({"pedido": "trecho"}, gera)
    assert r["valida"] and r["tentativas"] == 2 and not r["primeira_valida"]
    assert "A resposta é inválida" in chamadas[1][-1]["content"]
    assert chamadas[0][0]["role"] == "system" and chamadas[0][1]["content"] == "trecho"

    r = ea.extrair({"pedido": "trecho"}, lambda m: {"conteudo": "{", "finish": "stop"})
    assert not r["valida"] and r["tentativas"] == 3 and r["resposta"] is None


def test_cache_reaproveita_so_entrada_valida(tmp_path):
    lista = ea.unidades(pais(400))
    n = []

    def gera(mensagens):
        n.append(1)
        return resposta_do_llm(VALIDA)

    primeira = ea.extrair_todas(lista, gera, tmp_path)
    segunda = ea.extrair_todas(lista, gera, tmp_path)
    assert len(n) == 1 and not primeira[0]["do_cache"] and segunda[0]["do_cache"]
    assert segunda[0]["chamadas"] == 0

    ruim = tmp_path / f"{ea.chave_de_cache(lista[0])}.json"
    ruim.write_text(json.dumps({"valida": False}), encoding="utf-8")
    ea.extrair_todas(lista, gera, tmp_path)
    assert len(n) == 2


def test_resumir_conta_entidades_por_tipo_forca_e_nomes_repetidos(tmp_path):
    obj = {
        "entities": [entidade("A"), entidade("a"), entidade("B", "RISK")],
        "relationships": [relacao("A", "B", 8)],
    }
    r = ea.extrair_todas(ea.unidades(pais(400)), lambda m: resposta_do_llm(obj), tmp_path)
    res = ea.resumir(r)
    assert res["validas"] == 1 and res["entidades"] == 3 and res["relacoes"] == 1
    assert res["entidades_por_tipo"]["ORGANIZATION"] == 2 and res["entidades_por_tipo"]["RISK"] == 1
    assert res["relacoes_por_forca"][8] == 1
    assert res["nomes_repetidos"] == 1


# --- F5.2: gleaning ---------------------------------------------------------------------------------------


def base_valida():
    return {
        "entities": [entidade("Banco Alfa S.A."), entidade("Comitê de Auditoria")],
        "relationships": [relacao("Banco Alfa S.A.", "Comitê de Auditoria")],
    }


def test_fundir_nao_repete_nome_nem_par_e_descarta_relacao_solta():
    adicional = {
        "entities": [entidade("  banco ALFA s.a. "), entidade("Cade"), entidade("Lei 1")],
        "relationships": [
            relacao("Banco Alfa S.A.", "Comitê de Auditoria", 8),  # mesmo par da primeira passada
            relacao("Cade", "Banco Alfa S.A."),  # entre nova e antiga: entra
            relacao("Cade", "Fantasma"),  # nome fora da lista: descartada e contada
        ],
    }
    fundida, acrescimo = ea.fundir(base_valida(), adicional)
    assert [e["name"] for e in acrescimo["entities"]] == ["Cade", "Lei 1"]
    assert len(acrescimo["relationships"]) == 1 and len(fundida["relationships"]) == 2
    contagens = (
        acrescimo["entidades_repetidas"],
        acrescimo["relacoes_repetidas"],
        acrescimo["relacoes_soltas"],
    )
    assert contagens == (1, 1, 1)
    assert ExtracaoAberta.model_validate(fundida)  # a fusão passa pelo validador do esquema


def test_fundir_respeita_os_tetos_de_entidades_e_de_relacoes():
    base = {"entities": [entidade(f"E{i}") for i in range(29)], "relationships": []}
    adicional = {"entities": [entidade("N1"), entidade("N2")], "relationships": [relacao("N1", "E0")]}
    fundida, acrescimo = ea.fundir(base, adicional)
    assert len(fundida["entities"]) == 30 and [e["name"] for e in acrescimo["entities"]] == ["N1"]
    assert acrescimo["relacoes_soltas"] == 0 and len(acrescimo["relationships"]) == 1


def test_fundir_ignora_item_sem_nome_em_vez_de_quebrar():
    fundida, acrescimo = ea.fundir(
        base_valida(), {"entities": [{"type": "RISK"}, "texto"], "relationships": [{}]}
    )
    assert acrescimo["entities"] == [] and fundida == base_valida()


def test_completar_valida_a_fusao_e_repete_com_o_erro_se_o_acrescimo_tem_nome_de_data():
    chamadas = []
    boa = {
        "entities": [entidade("Leilão da oferta", "EVENT")],
        "relationships": [relacao("Leilão da oferta", "Banco Alfa S.A.")],
    }
    respostas = [{"entities": [entidade("14 de agosto de 2024", "EVENT")], "relationships": []}, boa]

    def gera(mensagens):
        chamadas.append(list(mensagens))
        return resposta_do_llm(respostas[len(chamadas) - 1])

    r = ea.completar({"pedido": "trecho"}, base_valida(), gera)
    assert r["valida"] and r["tentativas"] == 2
    assert [e["name"] for e in r["acrescimo"]["entities"]] == ["Leilão da oferta"]
    assert len(r["resposta"]["entities"]) == 3
    assert "data ou um valor" in chamadas[1][-1]["content"]
    assert chamadas[0][-1]["content"] == ea.CONTINUAR  # a rodada extra continua o diálogo da primeira
    assert json.loads(chamadas[0][-2]["content"]) == base_valida()


def test_completar_que_nao_da_fusao_valida_mantem_a_primeira_passada():
    r = ea.completar({"pedido": "t"}, base_valida(), lambda m: {"conteudo": "{", "finish": "stop"})
    assert (
        not r["valida"] and r["tentativas"] == 2 and r["resposta"] == base_valida() and r["acrescimo"] is None
    )
    r = ea.completar({"pedido": "t"}, base_valida(), lambda m: resposta_do_llm({}, "length"))
    assert not r["valida"] and "cortada" in r["erro"]


def test_completar_aceita_listas_vazias_quando_nada_faltou():
    r = ea.completar(
        {"pedido": "t"}, base_valida(), lambda m: resposta_do_llm({"entities": [], "relationships": []})
    )
    assert r["valida"] and r["resposta"] == base_valida() and r["acrescimo"]["entities"] == []


@pytest.mark.parametrize(
    ("nome", "texto", "esperado"),
    [
        ("Banco Digio S.A.", "alienação da participação no Banco Digio S.A., pela BB Elo", True),
        ("Banco Digio S.A.", "participação no Banco Digio", True),  # sem o sufixo societário
        ("Comitê Executivo (CEPI)", "O Comitê Executivo de Prevenção (CEPI) reúne-se", True),  # só a sigla
        ("Conselho de Defesa Econômica", "pelo conselho de defesa economica", True),
        ("Sest", "Bacen, Sest e Cade", True),
        ("Superintendência Fantasma", "Bacen, Sest e Cade", False),
        ("", "qualquer texto", False),
    ],
)  # fmt: skip
def test_lastro_de_nome_ignora_acento_caixa_sufixo_e_parenteses(nome, texto, esperado):
    assert ea.lastro_de_nome(nome, texto) is esperado


def pai_longo(i="p1", texto="Banco Alfa S.A. e o Comitê de Auditoria. O Cade aprovou."):
    return {
        "pais": [
            {"id": i, "caminho": ["S"], "texto": texto, "tokens": 400, "pagina_inicio": 1, "pagina_fim": 1}
        ]
    }


def test_extrair_todas_com_gleaning_guarda_as_duas_passadas_e_nao_repete_chamada_do_cache(tmp_path):
    lista = ea.unidades(pai_longo())
    n = []

    def gera(mensagens):
        n.append(1)
        if mensagens[-1]["content"] == ea.CONTINUAR:
            return resposta_do_llm(
                {"entities": [entidade("Cade")], "relationships": [relacao("Cade", "Banco Alfa S.A.")]}
            )
        return resposta_do_llm(base_valida())

    r = ea.extrair_todas(lista, gera, tmp_path, gleaning=1)[0]
    assert len(n) == 2 and len(r["resposta"]["entities"]) == 2  # `resposta` segue sendo a primeira passada
    assert len(ea.final(r)["entities"]) == 3 and r["gleaning"]["chamadas"] == 1
    r2 = ea.extrair_todas(lista, gera, tmp_path, gleaning=1)[0]
    assert len(n) == 2 and r2["gleaning"]["do_cache"] and r2["do_cache"]
    ea.extrair_todas(lista, gera, tmp_path, gleaning=0)  # sem gleaning reaproveita a primeira passada
    assert len(n) == 2
    assert ea.extrair_todas(lista, gera, tmp_path)[0]["gleaning"] is None


def test_gleaning_so_aceita_zero_ou_um(tmp_path):
    with pytest.raises(ValueError, match="0 ou 1"):
        ea.extrair_todas([], lambda m: {}, tmp_path, gleaning=2)


def test_resumir_ganho_conta_acrescimos_lastro_e_custo(tmp_path):
    chunks = pai_longo()

    def gera(mensagens):
        if mensagens[-1]["content"] == ea.CONTINUAR:
            return resposta_do_llm(
                {"entities": [entidade("Cade"), entidade("Entidade Inventada")], "relationships": []}
            )
        return resposta_do_llm(base_valida())

    r = ea.extrair_todas(ea.unidades(chunks), gera, tmp_path, gleaning=1)
    g = ea.resumir_ganho(r, {"p1": chunks["pais"][0]["texto"]})
    assert (g["entidades_primeira"], g["entidades_acrescentadas"], g["ganho_entidades_pct"]) == (2, 2, 100.0)
    assert g["sem_lastro_de_nome_acrescentadas"] == 1 and g["sem_lastro_de_nome_lista"] == [
        ("p1", "Entidade Inventada")
    ]
    assert g["custo_gleaning"]["chamadas"] == 1 and g["pais_com_as_duas"] == 1
    assert (
        ea.resumir_ganho(ea.extrair_todas(ea.unidades(chunks), gera, tmp_path), {})["pais_com_as_duas"] == 0
    )
