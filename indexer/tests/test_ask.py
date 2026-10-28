import json
from pathlib import Path

from indexer.ask import (
    NAO_ENCONTREI,
    SISTEMA,
    avaliar,
    conferir_citacoes,
    extrair_citacoes,
    formatar_contexto,
    pagina_correta,
    paginas_de,
    responder,
    rotulo_de_pagina,
)


def pai(i, a=80, b=80, texto="texto do trecho", caminho="Seção A"):
    return {
        "id": i, "pageStart": a, "pageEnd": b, "text": texto, "caminho": caminho, "tokens": 10,
        "nota_rerank": 0.9, "posicao_antes": 1,
    }  # fmt: skip


def test_rotulo_e_contexto_levam_a_pagina_original_e_o_caminho_da_secao():
    assert (
        rotulo_de_pagina(pai("a", 80, 80)) == "p. 80" and rotulo_de_pagina(pai("a", 156, 157)) == "p. 156-157"
    )
    ctx = formatar_contexto([pai("a", 80, 80, "um"), pai("b", 156, 157, "dois", "Seção B")])
    assert ctx.startswith("[p. 80] Seção: Seção A\num") and "[p. 156-157] Seção: Seção B\ndois" in ctx


def test_paginas_de_aceita_numero_intervalo_e_lista():
    assert (
        paginas_de("80") == [80]
        and paginas_de("156-157") == [156, 157]
        and paginas_de("156–158") == [156, 157, 158]
    )
    assert paginas_de("80, 91") == [80, 91] and paginas_de("abc") == []


def test_extrair_citacoes_pega_os_formatos_usados_e_ignora_colchetes_que_nao_sao_pagina():
    r = "Foi de R$ 1 [p. 91]. Em outra seção [p. 156-157] e ainda [p.200]; veja [nota 3] e [1]."
    assert [c["paginas"] for c in extrair_citacoes(r)] == [[91], [156, 157], [200]]
    assert extrair_citacoes(NAO_ENCONTREI) == []


def test_conferir_citacoes_so_aceita_pagina_dentro_de_um_trecho_entregue():
    pais = [pai("a", 80, 80), pai("b", 156, 157)]
    c = conferir_citacoes(
        extrair_citacoes("a [p. 80] b [p. 157] c [p. 156-157] d [p. 91] e [p. 80-157]"), pais
    )
    assert [x["valida"] for x in c] == [
        True,
        True,
        True,
        False,
        False,
    ]  # 91 não foi entregue; 80-157 mistura trechos


def test_pagina_correta_aceita_ponto_ou_intervalo_que_cubra_a_pagina():
    cit = extrair_citacoes("x [p. 156-157]")
    assert pagina_correta(cit, [157]) and not pagina_correta(cit, [91]) and not pagina_correta([], [91])


class Registro(dict):
    pass


class DriverFalso:
    def execute_query(self, cypher, parametros=None, database_=None):
        if "child_vec" in cypher:
            return [Registro(id="c1", score=0.9)], None, None
        if "child_ft" in cypher:
            return [], None, None
        if "HAS_CHILD" in cypher:
            return [Registro(id="c1", pai="p1")], None, None
        return [
            Registro(id="p1", text="O caixa foi de 159 milhões.", tokens=8, pageStart=91, pageEnd=91,
                     secaoId="s", caminho="Fluxo de caixa")
        ], None, None  # fmt: skip


def embute_falso(textos):
    return [[1.0, 0.0] for _ in textos]


def notas_falsas(pergunta, textos):
    return [1.0 for _ in textos]


def test_responder_entrega_so_o_contexto_ao_llm_e_confere_as_citacoes():
    vistas = []

    def chat(mensagens):
        vistas.append(mensagens)
        return "O caixa foi de 159 milhões [p. 91]."

    r = responder(DriverFalso(), "Qual o caixa?", embute_falso, notas_falsas, chat)
    assert r["resposta"].endswith("[p. 91].") and r["citacoes_invalidas"] == 0 and not r["sem_resposta"]
    assert vistas[0][0]["content"] == SISTEMA and "[p. 91] Seção: Fluxo de caixa" in vistas[0][1]["content"]
    assert vistas[0][1]["content"].rstrip().endswith("Pergunta: Qual o caixa?")
    assert r["fontes"][0]["paginas"] == "p. 91" and {"geracao", "rerank", "total"} <= set(r["latencia_ms"])
    assert r["contexto"] == [
        {"paginas": "p. 91", "caminho": "Fluxo de caixa", "texto": "O caixa foi de 159 milhões."}
    ]
    inventada = responder(DriverFalso(), "q", embute_falso, notas_falsas, lambda m: "Algo [p. 12].")
    assert inventada["citacoes_invalidas"] == 1  # página que não estava nos trechos entregues


def test_sem_candidatos_nao_chama_o_llm_e_diz_que_nao_encontrou():
    class Vazio:
        def execute_query(self, cypher, parametros=None, database_=None):
            return [], None, None

    def nao_chamar(m):
        raise AssertionError("não deveria chamar o LLM")

    r = responder(Vazio(), "q", embute_falso, notas_falsas, nao_chamar)
    assert r["resposta"] == NAO_ENCONTREI and r["sem_resposta"] and r["fontes"] == []


def test_avaliar_conta_pagina_fato_e_recusa_nos_negativos():
    casos = {
        "casos": [{"id": "x", "pergunta": "Qual o caixa?", "paginas_corretas": [91], "fato": "159"}],
        "negativos": [{"id": "n", "pergunta": "Fora do documento?"}],
    }

    def chat(m):
        return NAO_ENCONTREI if "Fora do documento" in m[1]["content"] else "159 milhões [p. 91]"

    r = avaliar(DriverFalso(), embute_falso, notas_falsas, chat, casos)
    assert (r["pagina_correta"], r["fato_na_resposta"], r["citacoes_invalidas"]) == (1, 1, 0)
    assert r["negativos_recusados"] == "1 de 1"


def test_arquivo_de_fumaca_tem_5_casos_com_pagina_fisica_e_fato():
    arq = Path(__file__).resolve().parents[2] / "eval" / "fumaca_f2_9.json"
    d = json.loads(arq.read_text(encoding="utf-8"))
    assert len(d["casos"]) == 5 and d["negativos"]
    assert all(c["paginas_corretas"] and c["fato"] and c["pergunta"].endswith("?") for c in d["casos"])
