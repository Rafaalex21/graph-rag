"""Busca global map-reduce (F6.2, ARQUITETURA §7.2, ferramenta `panorama`).

Formas de falhar, escritas antes do código (cada uma tem um teste abaixo):

 1. a escolha das comunidades ignora o nível ou o limiar de rating, ou deixa passar mais que o teto;
 2. nenhuma comunidade passa nos filtros e o código chama o LLM mesmo assim;
 3. o lote estoura o contexto (relatório gigante) ou deixa uma comunidade de fora / repete uma em dois lotes;
 4. o mapa devolve nota fora de 0 a 10, etiqueta que não existe ou texto vazio, e isso entra no contexto;
 5. a resposta do mapa não é o objeto esperado e o lote some sem aviso (ou derruba a busca);
 6. um lote que falha derruba os outros; todos falharem passa por "nada encontrado";
 7. o mesmo ponto vem de duas comunidades e aparece duas vezes; a ordem muda entre execuções;
 8. o orçamento de tempo estoura e a busca continua chamando o LLM (o aceite é ≤ 90 s);
 9. o progresso não chega, chega fora de ordem, ou um callback que falha derruba a busca;
10. o reduce falha e a busca inteira falha junto, em vez de devolver os pontos;
11. a pergunta vazia chama o grafo e o LLM.
"""

import json

import pytest

from indexer.busca_global import (
    LIMITES_PADRAO,
    buscar,
    escolher_comunidades,
    montar_lotes,
    selecionar_pontos,
    texto_do_relatorio,
    validar_pontos,
)


def com(i, nivel=LIMITES_PADRAO["nivel"], rating=7, score=0.5, titulo=None, texto="Texto do relatório."):
    relatorio = {
        "title": titulo or f"Tema {i}",
        "summary": f"Resumo {i}.",
        "findings": [{"summary": f"Achado {i}", "explanation": texto}],
    }
    return {
        "id": i,
        "title": relatorio["title"],
        "summary": relatorio["summary"],
        "report": json.dumps(relatorio),
        "level": nivel,
        "rating": rating,
        "score": score,
    }


def test_escolha_filtra_nivel_e_rating_ordena_por_similaridade_e_corta_no_teto():
    cs = [
        com("a", nivel=0, score=0.9),
        com("b", nivel=1, score=0.8),
        com("c", nivel=1, rating=4, score=0.95),  # rating abaixo do limiar
        com("d", nivel=1, score=0.7),
        com("e", nivel=1, score=0.6),
    ]
    assert [c["id"] for c in escolher_comunidades(cs, nivel=1, rating=5, k=10)] == ["b", "d", "e"]
    assert [c["id"] for c in escolher_comunidades(cs, nivel=1, rating=5, k=2)] == ["b", "d"]
    assert [c["id"] for c in escolher_comunidades(cs, nivel=None, rating=5, k=10)] == ["a", "b", "d", "e"]
    assert [c["id"] for c in escolher_comunidades(cs, nivel=1, rating=4, k=10)][0] == "c"  # limiar é ">="
    assert escolher_comunidades([], nivel=1, rating=5, k=3) == []
    assert escolher_comunidades(cs, nivel=2, rating=5, k=3) == []


def test_texto_do_relatorio_junta_titulo_resumo_e_achados_e_aguenta_json_quebrado():
    t = texto_do_relatorio(com("a", texto="Explicação longa."))
    assert "Tema a" in t and "Resumo a." in t and "Achado a" in t and "Explicação longa." in t
    quebrado = {**com("b"), "report": "{não é json"}
    assert "Tema b" in texto_do_relatorio(quebrado) and "Resumo b." in texto_do_relatorio(quebrado)
    assert texto_do_relatorio({**com("c"), "report": None}).startswith("Tema c")


def test_lotes_nao_perdem_nem_repetem_comunidade_e_relatorio_gigante_e_cortado_nao_descartado():
    cs = [com(str(i), texto="x" * 1000) for i in range(7)]
    lotes = montar_lotes(cs, lote_chars=2500, max_por_relatorio=1500)
    ids = [c["id"] for lote in lotes for c in lote]
    assert ids == [str(i) for i in range(7)]  # todas, uma vez, na mesma ordem
    assert all(len(lote) >= 1 for lote in lotes) and len(lotes) > 1
    enorme = montar_lotes([com("g", texto="y" * 50000)], lote_chars=2500, max_por_relatorio=1500)
    assert len(enorme) == 1 and len(enorme[0]) == 1  # entra sozinha, truncada pelo texto do pedido
    assert montar_lotes([], lote_chars=2500, max_por_relatorio=1500) == []


ETIQ = {"C1": com("a"), "C2": com("b", nivel=2)}


def test_validacao_dos_pontos_descarta_o_invalido_e_conta():
    resposta = {
        "pontos": [
            {"comunidade": "C1", "ponto": "  Risco de crédito.  ", "nota": 8},
            {"comunidade": "C2", "ponto": "Risco de mercado.", "nota": 8.0},
            {"comunidade": "C9", "ponto": "Etiqueta inventada.", "nota": 9},
            {"comunidade": "C1", "ponto": "   ", "nota": 9},
            {"comunidade": "C1", "ponto": "Nota alta demais.", "nota": 11},
            {"comunidade": "C1", "ponto": "Nota negativa.", "nota": -1},
            {"comunidade": "C1", "ponto": "Nota texto.", "nota": "alta"},
            {"comunidade": "C1", "ponto": "Nota booleana.", "nota": True},
            "lixo",
        ]
    }
    pontos, descartados = validar_pontos(resposta, ETIQ)
    assert [(p["comunidade"], p["texto"], p["nota"]) for p in pontos] == [
        ("a", "Risco de crédito.", 8),
        ("b", "Risco de mercado.", 8),
    ]
    assert pontos[1]["nivel"] == 2 and pontos[0]["titulo"] == "Tema a"
    assert descartados == 7


@pytest.mark.parametrize("ruim", [None, "texto", [], {}, {"pontos": "x"}, {"pontos": None}])
def test_resposta_do_mapa_fora_do_esquema_e_erro_para_o_lote_tentar_de_novo(ruim):
    with pytest.raises(ValueError):
        validar_pontos(ruim, ETIQ)


def test_lista_vazia_de_pontos_e_resposta_valida_comunidade_sem_nada_a_dizer():
    assert validar_pontos({"pontos": []}, ETIQ) == ([], 0)


def ponto(c, texto, nota, score=0.5):
    return {
        "comunidade": c,
        "titulo": f"T{c}",
        "nivel": 1,
        "texto": texto,
        "nota": nota,
        "similaridade": score,
    }


def test_selecao_de_pontos_deduplica_filtra_nota_ordena_de_forma_estavel_e_corta():
    pontos = [
        ponto("a", "Risco de crédito é o principal.", 6),
        ponto(
            "b", "risco de crédito é o principal", 9
        ),  # mesmo texto (caixa e pontuação): fica o de nota maior
        ponto("c", "Risco de mercado.", 9, score=0.9),
        ponto("d", "Risco de liquidez.", 9, score=0.1),
        ponto("e", "Nota zero.", 0),
        ponto("f", "Risco cibernético.", 3),
    ]
    sel, omitido = selecionar_pontos(pontos, nota_minima=1, k=3, tokens=10_000)
    assert [p["comunidade"] for p in sel] == ["b", "c", "d"] or [p["comunidade"] for p in sel] == [
        "c",
        "b",
        "d",
    ]
    assert {p["comunidade"] for p in sel} == {"b", "c", "d"}
    assert sel == selecionar_pontos(list(reversed(pontos)), 1, 3, 10_000)[0]  # independe da ordem de chegada
    assert omitido == {"abaixo_da_nota": 1, "duplicados": 1, "acima_do_teto": 1, "por_orcamento": 0}


def test_selecao_respeita_o_orcamento_de_tokens_mas_mantem_o_melhor_ponto():
    pontos = [ponto("a", "x" * 3000, 9), ponto("b", "y" * 3000, 8)]
    sel, omitido = selecionar_pontos(pontos, nota_minima=1, k=5, tokens=1200)
    assert [p["comunidade"] for p in sel] == ["a"] and omitido["por_orcamento"] == 1
    sel, _ = selecionar_pontos(pontos, nota_minima=1, k=5, tokens=10)
    assert [p["comunidade"] for p in sel] == ["a"]  # o melhor entra mesmo estourando


class Registro(dict):
    pass


class DriverFalso:
    def __init__(self, comunidades=()):
        self.linhas = [Registro(c) for c in comunidades]
        self.pedidos = []

    def execute_query(self, cypher, parametros=None, database_=None):
        self.pedidos.append((cypher, parametros or {}))
        assert "community_vec" in cypher, cypher
        return self.linhas, None, None


def embute_falso(textos):
    return [[1.0, 0.0] for _ in textos]


class MapaFalso:
    """Devolve, para cada lote, um ponto por etiqueta (nota fixa); registra os pedidos."""

    def __init__(self, nota=8, falhar_em=(), erro=RuntimeError):
        self.nota, self.falhar_em, self.erro = nota, set(falhar_em), erro
        self.pedidos = []

    def __call__(self, mensagens, esquema):
        n = len(self.pedidos)
        self.pedidos.append(mensagens)
        if n in self.falhar_em:
            raise self.erro("llama-swap fora do ar")
        etiquetas = esquema["properties"]["pontos"]["items"]["properties"]["comunidade"]["enum"]
        return {
            "pontos": [{"comunidade": e, "ponto": f"Ponto {n}-{e}.", "nota": self.nota} for e in etiquetas]
        }


def seis():
    return [com(str(i), score=1 - i / 10, texto="z" * 800) for i in range(6)]


def test_buscar_ponta_a_ponta_pontos_sintese_e_progresso_em_ordem():
    eventos = []
    mapa = MapaFalso()
    r = buscar(
        DriverFalso(seis()),
        "Quais os riscos?",
        embute_falso,
        mapa,
        lambda m: "Síntese dos riscos.",
        {"lote_chars": 2000, "paralelismo": 1},
        progresso=eventos.append,
    )
    assert r["sintese"] == "Síntese dos riscos." and r["reduce"] == "ok"
    assert len(r["pontos"]) == 6 and all(p["tipo"] == "ponto" and p["paginas"] == "" for p in r["pontos"])
    assert {"id", "tipo", "paginas", "caminho", "texto", "score"} <= r["pontos"][0].keys()
    fases = [e["fase"] for e in eventos]
    assert fases[0] == "selecao" and fases[-1] == "fim" and "sintese" in fases
    feitas = [e["comunidades_feitas"] for e in eventos if e["fase"] == "mapa"]
    assert feitas == sorted(feitas) and feitas[-1] == 6
    assert all(e["comunidades_total"] == 6 for e in eventos if e["fase"] in ("selecao", "mapa"))
    assert r["comunidades"] == {"consideradas": 6, "lotes": len(mapa.pedidos), "lotes_falhos": 0}


def test_sem_comunidade_que_passe_nos_filtros_nao_chama_o_llm():
    mapa = MapaFalso()
    r = buscar(DriverFalso([com("a", rating=2)]), "Pergunta?", embute_falso, mapa, lambda m: "x")
    assert mapa.pedidos == [] and r["pontos"] == [] and r["reduce"] == "sem_pontos" and r["sintese"] is None


def test_pergunta_vazia_nao_toca_no_grafo_nem_no_llm():
    d, mapa = DriverFalso(seis()), MapaFalso()
    r = buscar(d, "  ", embute_falso, mapa, lambda m: "x")
    assert d.pedidos == [] and mapa.pedidos == [] and r["pontos"] == []


def test_lote_que_falha_nao_derruba_os_outros_e_e_contado():
    mapa = MapaFalso(falhar_em=(0, 1))  # as duas tentativas do primeiro lote
    r = buscar(
        DriverFalso(seis()), "Pergunta?", embute_falso, mapa, None, {"lote_chars": 2000, "paralelismo": 1}
    )
    assert r["comunidades"]["lotes_falhos"] == 1 and len(r["pontos"]) > 0
    assert len(mapa.pedidos) == r["comunidades"]["lotes"] + 1  # o lote que falhou foi tentado duas vezes


def test_todos_os_lotes_falhando_nao_passa_por_nada_encontrado():
    mapa = MapaFalso(falhar_em=range(100))
    r = buscar(DriverFalso(seis()), "Pergunta?", embute_falso, mapa, None, {"lote_chars": 2000})
    assert r["pontos"] == [] and r["comunidades"]["lotes_falhos"] == r["comunidades"]["lotes"] > 0
    assert r["reduce"] == "sem_pontos" and r["erro"] == "todos os lotes do mapa falharam"


def test_orcamento_de_tempo_para_de_chamar_o_llm_e_o_reduce_ainda_roda():
    relogio = [0.0]

    class Mapa(MapaFalso):
        def __call__(self, mensagens, esquema):
            relogio[0] += 10.0  # cada lote "demora" 10 s
            return super().__call__(mensagens, esquema)

    mapa = Mapa()
    r = buscar(
        DriverFalso(seis()),
        "Pergunta?",
        embute_falso,
        mapa,
        lambda m: "Síntese parcial.",
        {"lote_chars": 1000, "paralelismo": 1, "orcamento_s": 25},
        agora=lambda: relogio[0],
    )
    assert len(mapa.pedidos) == 3  # 0 s, 10 s e 20 s começam; aos 30 s o orçamento de 25 s já passou
    assert r["omitido"]["comunidades_por_tempo"] == 3 and r["truncado_por_tempo"] is True
    assert r["sintese"] == "Síntese parcial." and len(r["pontos"]) == 3


def test_callback_de_progresso_que_falha_nao_derruba_a_busca():
    def ruim(evento):
        raise RuntimeError("cliente SSE caiu")

    r = buscar(DriverFalso(seis()), "Pergunta?", embute_falso, MapaFalso(), None, progresso=ruim)
    assert len(r["pontos"]) == 6


def test_reduce_que_falha_devolve_os_pontos_sem_sintese():
    def quebrado(mensagens):
        raise OSError("timeout")

    r = buscar(DriverFalso(seis()), "Pergunta?", embute_falso, MapaFalso(), quebrado)
    assert r["reduce"] == "falhou" and r["sintese"] is None and len(r["pontos"]) == 6


def test_sem_gerador_de_reduce_so_devolve_os_pontos():
    r = buscar(DriverFalso(seis()), "Pergunta?", embute_falso, MapaFalso(), None)
    assert r["reduce"] == "desligado" and r["sintese"] is None


def test_resultado_e_o_mesmo_com_paralelismo_1_ou_2():
    um = buscar(
        DriverFalso(seis()), "P?", embute_falso, MapaFalso(), None, {"lote_chars": 2000, "paralelismo": 1}
    )
    dois = buscar(
        DriverFalso(seis()), "P?", embute_falso, MapaFalso(), None, {"lote_chars": 2000, "paralelismo": 2}
    )
    assert sorted(p["texto"] for p in um["pontos"]) == sorted(p["texto"] for p in dois["pontos"])
    assert LIMITES_PADRAO["rating"] == 5
