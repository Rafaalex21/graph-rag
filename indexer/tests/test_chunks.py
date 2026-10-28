import json
import urllib.request
from io import BytesIO

from indexer.chunks import (
    agrupar_blocos,
    blocos_por_secao,
    contador_llama,
    dividir_em_filhos,
    frases,
    segmentar,
)


def palavras(texto: str) -> int:
    """Contador falso: uma palavra, um token."""
    return len(texto.split())


def bloco(id_: str, n_palavras: int, pagina: int = 1, tipo: str = "text") -> dict:
    return {
        "id": id_,
        "tipo": tipo,
        "texto": " ".join(f"{id_}w{i}" for i in range(n_palavras)),
        "paginas_originais": [pagina],
    }


def cabecalho(id_: str, indice: int, nivel: int, caminho: list[str], pai: str | None = None) -> dict:
    return {
        "id": id_,
        "indice_inicio": indice,
        "nivel": nivel,
        "pai": pai,
        "titulo": caminho[-1],
        "caminho": caminho,
    }


def elemento_titulo(texto: str, pagina: int = 1) -> dict:
    return {"id": f"h-{texto}", "tipo": "section_header", "texto": texto, "paginas_originais": [pagina]}


def test_frases_cortam_em_ponto_final_mas_nao_em_abreviacao_minuscula():
    texto = "A receita subiu 5,2% em 2025. O lucro caiu; as provisões subiram. Ver p. 87 do relatório."
    assert frases(texto) == [
        "A receita subiu 5,2% em 2025.",
        "O lucro caiu; as provisões subiram.",
        "Ver p. 87 do relatório.",
    ]


def test_blocos_por_secao_nao_atravessa_titulo_e_separa_tabelas_e_figuras():
    elementos = [
        elemento_titulo("A"),
        bloco("a1", 5),
        {"id": "t1", "tipo": "table", "paginas_originais": [1], "notas": [{"texto": "(1) nota"}]},
        elemento_titulo("A.1"),
        bloco("b1", 5),
        {"id": "f1", "tipo": "picture", "paginas_originais": [1]},
        {"id": "x", "tipo": "document_index", "texto": "sumário", "paginas_originais": [1]},
    ]
    arvore = [cabecalho("s1", 0, 1, ["A"]), cabecalho("s2", 3, 2, ["A", "A.1"], "s1")]
    corpo, fora = blocos_por_secao(elementos, arvore)
    assert [b["id"] for b in corpo["s1"]] == ["a1"]
    assert [b["id"] for b in corpo["s2"]] == ["b1"]  # o sumário (document_index) não vira texto
    assert [(x["id"], x["secao_id"]) for x in fora] == [("t1", "s1"), ("f1", "s2")]
    assert fora[0]["notas"] == ["(1) nota"]


def test_secao_que_cabe_no_maximo_vira_um_pai_so():
    grupos = agrupar_blocos([bloco("a", 700), bloco("b", 700)], palavras, alvo=1200, maximo=1600)
    assert len(grupos) == 1 and grupos[0][2] == 1400 + 0  # 2 parágrafos, separados por linha em branco


def test_secao_grande_e_dividida_em_partes_parecidas_sem_passar_do_maximo():
    blocos = [bloco(f"p{i}", 200) for i in range(30)]  # 6.000 palavras
    grupos = agrupar_blocos(blocos, palavras, alvo=1200, maximo=1600)
    tamanhos = [g[2] for g in grupos]
    assert max(tamanhos) <= 1600 and len(grupos) in (5, 6)
    assert min(tamanhos) >= 600  # nenhuma sobra minúscula
    assert [b["id"] for g in grupos for b in g[0]] == [b["id"] for b in blocos]  # ordem e nada perdido


def test_paragrafo_maior_que_o_maximo_e_cortado_por_frases():
    frase = " ".join(["palavra"] * 99) + "."
    gigante = {"id": "g", "tipo": "text", "texto": " ".join([frase] * 30), "paginas_originais": [3]}
    grupos = agrupar_blocos([gigante], palavras, alvo=1200, maximo=1600)
    assert len(grupos) >= 2 and all(g[2] <= 1600 for g in grupos)


def test_paragrafo_gigante_sem_fim_de_frase_e_cortado_por_palavras_e_termina():
    sem_frases = {"id": "g", "tipo": "text", "texto": " ".join(["palavra"] * 5000), "paginas_originais": [3]}
    grupos = agrupar_blocos([sem_frases], palavras, alvo=1200, maximo=1600)
    assert all(g[2] <= 1600 for g in grupos) and sum(g[2] for g in grupos) >= 5000


def test_estimativa_baixa_nao_deixa_passar_do_maximo():
    def conta_com_custo_por_separador(texto: str) -> int:
        return len(texto.split()) + 5 * texto.count("\n\n")  # o separador "custa" 5, não 1

    blocos = [bloco(f"p{i}", 20) for i in range(300)]
    grupos = agrupar_blocos(blocos, conta_com_custo_por_separador, alvo=1200, maximo=1600)
    assert all(g[2] <= 1600 for g in grupos)


def test_filhos_tem_sobreposicao_de_cerca_de_12_por_cento_e_paginas_proprias():
    frases_ = [f"Frase {i} " + " ".join(["x"] * 18) + "." for i in range(40)]  # 20 palavras cada
    bloco_a = {"id": "a", "texto": " ".join(frases_[:20]), "paginas_originais": [5]}
    bloco_b = {"id": "b", "texto": " ".join(frases_[20:]), "paginas_originais": [6]}
    filhos = dividir_em_filhos([bloco_a, bloco_b], "Cap › Seção", palavras, alvo=100, sobreposicao=0.12)
    assert len(filhos) >= 8
    for atual, seguinte in zip(filhos, filhos[1:], strict=False):
        assert seguinte["tokens_sobrepostos"] > 0
        assert atual["corpo"].split()[-1] in seguinte["corpo"]  # a cauda do anterior reaparece no seguinte
    tokens = [palavras("Cap › Seção\n" + f["corpo"]) for f in filhos]
    assert max(tokens) <= 100
    assert filhos[0]["paginas"] == [5] and filhos[-1]["paginas"] == [6]
    medias = [f["tokens_sobrepostos"] / palavras(f["corpo"]) for f in filhos[1:]]
    assert 0.05 <= sum(medias) / len(medias) <= 0.25


def test_segmentar_pais_ficam_na_secao_filhos_carregam_o_prefixo_e_ids_sao_deterministicos():
    elementos = [
        elemento_titulo("Riscos"),
        bloco("r1", 60, 4),
        elemento_titulo("Câmbio", 5),
        bloco("c1", 80, 5),
        bloco("c2", 80, 6),
    ]
    arvore = [cabecalho("s1", 0, 1, ["Riscos"]), cabecalho("s2", 2, 2, ["Riscos", "Câmbio"], "s1")]
    r1 = segmentar(elementos, arvore, "doc", palavras, palavras, alvo_filho=50)
    r2 = segmentar(elementos, arvore, "doc", palavras, palavras, alvo_filho=50)
    assert [p["id"] for p in r1["pais"]] == [p["id"] for p in r2["pais"]]
    assert [f["id"] for f in r1["filhos"]] == [f["id"] for f in r2["filhos"]]
    assert [p["secao_id"] for p in r1["pais"]] == ["s1", "s2"]  # um Pai por seção: não se misturam
    assert (r1["pais"][1]["pagina_inicio"], r1["pais"][1]["pagina_fim"]) == (5, 6)
    assert all(f["texto"].startswith(f["prefixo"] + "\n") for f in r1["filhos"])
    assert {f["prefixo"] for f in r1["filhos"] if f["pai_id"] == r1["pais"][1]["id"]} == {"Riscos › Câmbio"}
    assert r1["estatisticas"]["filhos_orfaos"] == 0 and r1["estatisticas"]["pais_sem_filho"] == 0
    assert r1["secoes_sem_texto"] == []


def test_secao_sem_texto_nao_gera_pai_e_e_listada():
    elementos = [elemento_titulo("Vazia"), elemento_titulo("Cheia"), bloco("x", 30)]
    arvore = [cabecalho("s1", 0, 1, ["Vazia"]), cabecalho("s2", 1, 1, ["Cheia"])]
    r = segmentar(elementos, arvore, "doc", palavras, palavras)
    assert [p["secao_id"] for p in r["pais"]] == ["s2"] and r["secoes_sem_texto"] == ["s1"]


def test_contador_llama_usa_a_rota_upstream_e_guarda_em_cache(monkeypatch):
    chamadas = []

    def falso(req, timeout):
        chamadas.append((req.full_url, json.loads(req.data)))
        return BytesIO(json.dumps({"tokens": [1, 2, 3]}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", falso)
    conta = contador_llama("http://127.0.0.1:8080", "qwen3-embed-0.6b")
    assert conta("olá mundo") == 3 and conta("olá mundo") == 3
    assert chamadas == [
        ("http://127.0.0.1:8080/upstream/qwen3-embed-0.6b/tokenize", {"content": "olá mundo"})
    ]
