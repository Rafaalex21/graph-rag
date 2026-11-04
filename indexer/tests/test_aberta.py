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
