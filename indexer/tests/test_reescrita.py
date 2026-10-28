import subprocess
import sys

import pytest

from indexer.busca import fundir_variantes
from indexer.recuperador import recuperar
from indexer.reescrita import reescrever, validar_hyde, validar_stepback

PERGUNTA = "Qual foi o lucro líquido ajustado em 2025?"
GERAL = "Quais foram os resultados financeiros da companhia no exercício de 2025?"
TRECHO = "O resultado do exercício reflete o desempenho das carteiras e o controle das despesas. " * 4


def llm_falso(chamadas=None):
    def chama(mensagens, esquema, max_tokens, temperatura):
        if chamadas is not None:
            chamadas.append((mensagens[0]["content"][:30], max_tokens, temperatura))
        if "pergunta_geral" in esquema["properties"]:
            return {"pergunta_geral": GERAL}
        return {"trecho": TRECHO}

    return chama


def test_so_chama_o_llm_para_o_que_foi_pedido():
    chamadas = []
    assert reescrever(PERGUNTA, llm_falso(chamadas)) == {
        "stepback": None,
        "hyde": None,
        "ms": {},
        "erros": {},
    }
    assert chamadas == []
    r = reescrever(PERGUNTA, llm_falso(chamadas), stepback=True)
    assert (
        r["stepback"] == GERAL and r["hyde"] is None and set(r["ms"]) == {"stepback"} and len(chamadas) == 1
    )
    r = reescrever(PERGUNTA, llm_falso(), stepback=True, hyde=True)
    assert r["stepback"] == GERAL and r["hyde"] == TRECHO.strip() and r["erros"] == {}


def test_falha_do_llm_ou_resposta_invalida_descarta_a_reescrita_e_registra_o_erro():
    def quebrado(m, e, t, temp):
        raise ConnectionError("llama-swap fora do ar")

    r = reescrever(PERGUNTA, quebrado, stepback=True, hyde=True)
    assert r["stepback"] is None and r["hyde"] is None
    assert "ConnectionError" in r["erros"]["stepback"] and "ConnectionError" in r["erros"]["hyde"]

    def igual(m, e, t, temp):
        return {"pergunta_geral": PERGUNTA} if "pergunta_geral" in e["properties"] else {"trecho": "curto"}

    r = reescrever(PERGUNTA, igual, stepback=True, hyde=True)
    assert r["stepback"] is None and "igual" in r["erros"]["stepback"]
    assert r["hyde"] is None and "trecho" in r["erros"]["hyde"]


def test_validacoes():
    assert validar_stepback(PERGUNTA, GERAL) is None
    assert validar_stepback(PERGUNTA, "Sem interrogação no fim da frase aqui") is not None
    assert (
        validar_stepback(PERGUNTA, "qual FOI o lucro liquido ajustado em 2025?") is not None
    )  # igual, sem acento
    assert validar_stepback(PERGUNTA, None) is not None
    assert validar_hyde("x" * 300) is None and validar_hyde("x" * 100) is not None
    assert validar_hyde("x" * 2000) is not None


def test_fundir_variantes_soma_rrf_de_varios_rankings():
    a = [("c1", 0.9), ("c2", 0.8)]
    b = [("c2", 0.7), ("c3", 0.6)]
    assert fundir_variantes([a])[0][0] == "c1"  # um ranking: a ordem dele
    assert [i for i, _ in fundir_variantes([a, b])][0] == "c2"  # presente nos dois sobe
    assert fundir_variantes([]) == []


class Registro(dict):
    pass


class DriverFalso:
    """Vetor devolve listas por consulta (pela 1ª coordenada do vetor); registra o que foi buscado."""

    def __init__(self):
        self.vetores: list[list[float]] = []
        self.textos: list[str] = []

    def execute_query(self, cypher, parametros=None, database_=None):
        if "child_vec" in cypher:
            self.vetores.append(parametros["v"])
            alvo = int(parametros["v"][0])
            return [Registro(id=f"c{alvo}", score=0.9), Registro(id="c9", score=0.5)], None, None
        if "child_ft" in cypher:
            self.textos.append(parametros["q"])
            return [], None, None
        if "HAS_CHILD" in cypher:
            return [Registro(id=i, pai="p" + i[1:]) for i in parametros["ids"]], None, None
        return (
            [
                Registro(id=i, text="t", tokens=5, pageStart=1, pageEnd=1, secaoId="s", caminho="C")
                for i in parametros["ids"]
            ],
            None,
            None,
        )


def embute_pelo_tamanho(textos):
    """Vetor cuja 1ª coordenada identifica o texto: 1 para a original, 2 para o step-back, 3 para o HyDE."""
    saida = []
    for t in textos:
        marca = 3.0 if t.startswith("TRECHO") else 2.0 if "STEP" in t else 1.0
        saida.append([marca, 0.0])
    return saida


def test_recuperar_sem_reescritas_continua_igual_e_com_elas_une_os_rankings():
    base = recuperar(DriverFalso(), "pergunta", embute_pelo_tamanho, k=3, modo="vetor")
    assert [p["id"] for p in base["pais"]] == ["p1", "p9"]

    driver = DriverFalso()
    r = recuperar(
        driver,
        "pergunta",
        embute_pelo_tamanho,
        k=4,
        modo="vetor",
        stepback="STEP geral?",
        hyde="TRECHO hipotético",
    )
    ids = [p["id"] for p in r["pais"]]
    assert set(ids) == {"p1", "p2", "p3", "p9"}  # a original, o step-back e o HyDE contribuíram
    assert ids[0] == "p9"  # o filho c9 está nos três rankings: sobe na fusão
    assert len(driver.vetores) == 3
    # a 3ª busca vetorial é a do HyDE (embutido sem prefixo de instrução)
    assert driver.vetores[2][0] == 3.0


def test_stepback_no_modo_hibrido_tambem_consulta_o_texto():
    driver = DriverFalso()
    recuperar(driver, "pergunta", embute_pelo_tamanho, k=2, modo="hibrido-rrf", stepback="STEP geral?")
    assert len(driver.textos) == 2 and len(driver.vetores) == 2


@pytest.mark.parametrize("modulo", ["indexer.recuperador", "indexer.reranker"])
def test_as_flags_stepback_e_hyde_existem_na_cli(modulo):
    r = subprocess.run(
        [sys.executable, "-m", modulo, "buscar", "--help"], capture_output=True, text=True, encoding="utf-8"
    )
    assert r.returncode == 0 and "--stepback" in r.stdout and "--hyde" in r.stdout and "--llm" in r.stdout
