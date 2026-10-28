import json
import math
import urllib.request
from io import BytesIO

import pytest

from indexer.embeddings import (
    CRIAR_INDICE,
    autoteste,
    conferir_vetor,
    embutidor_llama,
    embutir_filhos,
    formatar_consulta,
    trecho_do_meio,
)


def unitario(i: int, dims: int = 4) -> list[float]:
    v = [0.0] * dims
    v[i % dims] = 1.0
    return v


class Registro(dict):
    """Linha de resultado acessível por nome, como a do driver."""


class DriverFalso:
    def __init__(self, filhos):
        self.filhos = filhos  # {id: texto}
        self.gravados: list[dict] = []
        self.consultas: list[str] = []

    def execute_query(self, cypher, parametros=None, database_=None):
        self.consultas.append(cypher)
        if "WHERE c.embedding IS NULL" in cypher:
            pendentes = [i for i in self.filhos if i not in {g["id"] for g in self.gravados}]
            return [Registro(id=i, text=self.filhos[i]) for i in sorted(pendentes)], None, None
        if "WHERE c.embedding IS NOT NULL" in cypher:
            return [Registro(id=i, text=t) for i, t in sorted(self.filhos.items())], None, None
        if "setNodeVectorProperty" in cypher:
            self.gravados += parametros["rows"]
            return [], None, None
        if "queryNodes" in cypher:
            v = parametros["v"]
            achado = max(self.gravados, key=lambda g: sum(a * b for a, b in zip(g["vetor"], v, strict=True)))
            return [Registro(id=achado["id"], score=1.0)], None, None
        return [], None, None


def test_formato_de_consulta_do_qwen3_embedding():
    assert formatar_consulta("Qual a receita?", "Tarefa X") == "Instruct: Tarefa X\nQuery: Qual a receita?"
    assert formatar_consulta("p").startswith("Instruct: ") and "\nQuery: p" in formatar_consulta("p")


def test_conferir_vetor_exige_dimensao_e_norma_um():
    conferir_vetor([1.0, 0.0, 0.0], dimensoes=3)
    conferir_vetor([0.6, 0.8], dimensoes=2)
    with pytest.raises(ValueError, match="dimensões"):
        conferir_vetor([1.0, 0.0], dimensoes=3)
    with pytest.raises(ValueError, match="normalizado"):
        conferir_vetor([1.0, 1.0], dimensoes=2)


def test_embutidor_llama_ordena_por_index_e_valida(monkeypatch):
    chamadas = []

    def falso(req, timeout):
        chamadas.append((req.full_url, json.loads(req.data)))
        resposta = {"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]}
        return BytesIO(json.dumps(resposta).encode())

    monkeypatch.setattr(urllib.request, "urlopen", falso)
    embute = embutidor_llama("http://x:8080", "modelo-a", dimensoes=2)
    assert embute(["um", "dois"]) == [[1.0, 0.0], [0.0, 1.0]]
    assert chamadas == [("http://x:8080/v1/embeddings", {"model": "modelo-a", "input": ["um", "dois"]})]
    with pytest.raises(ValueError, match="vetores"):
        embutidor_llama("http://x:8080", "m", dimensoes=2)(["a", "b", "c"])


def test_embutir_filhos_grava_em_lotes_e_so_os_pendentes():
    filhos = {f"c{i}": f"Seção\ntexto {i}" for i in range(5)}
    driver = DriverFalso(filhos)
    textos_enviados = []

    def embute(textos):
        textos_enviados.append(list(textos))
        return [unitario(int(t.split()[-1])) for t in textos]

    r = embutir_filhos(driver, embute, "modelo", lote=2)
    assert r["embutidos"] == 5 and [len(t) for t in textos_enviados] == [2, 2, 1]
    assert {g["id"] for g in driver.gravados} == set(filhos)
    # segunda rodada: nada pendente, nada reenviado (retomável e idempotente)
    antes = len(textos_enviados)
    assert embutir_filhos(driver, embute, "modelo", lote=2)["embutidos"] == 0
    assert len(textos_enviados) == antes


def test_indice_e_de_1024_dims_e_cosseno():
    assert "child_vec" in CRIAR_INDICE and "1024" in CRIAR_INDICE and "'cosine'" in CRIAR_INDICE


def test_trecho_do_meio_ignora_o_prefixo_e_pega_o_centro():
    corpo = " ".join(f"w{i}" for i in range(100))
    trecho = trecho_do_meio(f"Cap › Seção\n{corpo}", palavras=10)
    assert trecho.split() == [f"w{i}" for i in range(45, 55)]
    assert trecho_do_meio("Prefixo\ncurto texto", palavras=10) == "curto texto"


def test_autoteste_aprova_quando_cada_filho_volta_para_si_e_reprova_quando_nao():
    filhos = {f"c{i}": f"P\ntexto {i}" for i in range(4)}
    driver = DriverFalso(filhos)
    embutir_filhos(driver, lambda ts: [unitario(int(t.split()[-1])) for t in ts], "m")
    ok = autoteste(driver, lambda ts: [unitario(int(t.split()[-1])) for t in ts], sonda=False)
    assert ok["recall_at_1"] == 1.0 and ok["aprovado"] and ok["falhas"] == []
    # um backend que devolve sempre o mesmo vetor erra 3 de 4
    ruim = autoteste(driver, lambda ts: [unitario(0) for _ in ts], sonda=False)
    assert math.isclose(ruim["recall_at_1"], 0.25) and not ruim["aprovado"] and len(ruim["falhas"]) == 3
