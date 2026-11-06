"""Comparação do especialista Text2Cypher (Gemma 3 4B) com o LLM principal (F6.6). Sem banco nem modelo.

Formas de a comparação falhar, escritas antes do código:

1. O especialista foi treinado num formato de prompt próprio (instrução em inglês, `Schema:`, `Question:`,
   `Cypher output:`), sem papel `system` (o template do Gemma não tem). Se a comparação só rodasse o
   prompt de 4 seções do Qwen, o número do especialista mediria o prompt, não o modelo: precisam existir
   as duas variantes, escolhidas por nome, e um nome desconhecido tem de falhar alto em vez de cair
   silenciosamente no padrão.
2. A variante nativa tem de levar a mesma informação que o Qwen recebe da pergunta (esquema e rótulos
   candidatos), senão o confronto é desigual, e tem de terminar pedindo o Cypher.
3. O especialista responde de outro jeito: `Cypher output: MATCH ...` numa linha só, cerca ```cypher, ou
   prosa depois da consulta. O extrator só pode devolver a consulta.
4. A latência de uma medição fria (carga do modelo na primeira chamada) não pode entrar na mediana das
   demais: o resumo separa a primeira chamada, e a carga tem uma medida própria.
5. A acurácia de execução e a taxa de consultas que ao menos rodam são números diferentes (o especialista
   pode escrever Cypher válido e errado): o resumo traz os dois, e um caso bloqueado pela guarda ou sem
   Cypher conta como não executado.
6. A corrida tem de usar a mesma guarda e a mesma medida para os dois: a variante do prompt passa por
   `perguntar` sem tocar na guarda, e a autocorreção funciona com o prompt de uma mensagem só.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from indexer.text2cypher import (
    aquecer,
    compactar_esquema,
    extrair_cypher,
    montar_mensagens,
    montar_prompt,
    montar_prompt_especialista,
    perguntar,
    resumir_casos,
)
from test_guarda_cypher import BancoFalso, Resumo, llm, plano  # banco falso da F6.5

ESQUEMA = "(:FinancialFact {metric: STRING, value: FLOAT, page: INTEGER})"
CANDIDATOS = ["Lucro líquido ajustado", "Lucro líquido"]


# ---------- 1 e 2: as duas variantes de prompt ----------


def test_prompt_nativo_e_uma_mensagem_de_usuario_so_sem_papel_system():
    msgs = montar_prompt_especialista("Quanto foi o lucro?", ESQUEMA, CANDIDATOS)
    assert [m["role"] for m in msgs] == ["user"]


def test_prompt_nativo_segue_o_formato_de_treino_e_termina_pedindo_o_cypher():
    texto = montar_prompt_especialista("Quanto foi o lucro?", ESQUEMA, CANDIDATOS)[0]["content"]
    assert texto.startswith("Generate Cypher statement to query a graph database.")
    assert "Schema:" in texto and "Question: Quanto foi o lucro?" in texto
    assert texto.rstrip().endswith("Cypher output:")
    assert texto.index("Schema:") < texto.index("Question:")


def test_prompt_nativo_leva_o_esquema_e_os_candidatos_como_o_do_qwen():
    nativo = montar_prompt_especialista("Quanto foi o lucro?", ESQUEMA, CANDIDATOS)[0]["content"]
    completo = montar_prompt("Quanto foi o lucro?", ESQUEMA, "T", [], CANDIDATOS)
    assert ESQUEMA in nativo
    for rotulo in CANDIDATOS:
        assert rotulo in nativo and rotulo in completo[-1]["content"]


def test_prompt_nativo_sem_candidatos_nao_deixa_secao_vazia():
    texto = montar_prompt_especialista("q?", ESQUEMA, None)[0]["content"]
    assert "Hint" not in texto and "Question: q?" in texto


def test_montar_mensagens_escolhe_a_variante_pelo_nome():
    completo = montar_mensagens("completo", "q?", ESQUEMA, "TERMOS", [], CANDIDATOS)
    nativo = montar_mensagens("nativo", "q?", ESQUEMA, "TERMOS", [], CANDIDATOS)
    assert [m["role"] for m in completo] == ["system", "user"]
    assert [m["role"] for m in nativo] == ["user"]
    assert "TERMOS" in completo[0]["content"] and "TERMOS" not in nativo[0]["content"]


def test_variante_desconhecida_falha_alto():
    with pytest.raises(ValueError, match="variante"):
        montar_mensagens("inventada", "q?", ESQUEMA, "T", [], None)


# ---------- 2b: o esquema compacto (a terceira variante) ----------

ESQUEMA_LONGO = (
    "Nós (rótulo e propriedades):\n(:FinancialFact) {metric: STRING, value: FLOAT}\n"
    "Relações:\n(:FinancialFact)-[:FOR_PERIOD]->(:Period)\n"
    "Entidade = qualquer um destes rótulos: Person, Organization\n"
    "Rótulos existentes em FinancialFact.metric (copie o texto exato ao filtrar por f.metric):\n"
    "Lucro | Receita | Despesa\n"
    "Exemplos de recorte (OF_METRIC.dimension) por métrica; os rótulos de f.metric têm prioridade:\n"
    "Headcount: Sul | Norte\n"
    "Valores de exemplo:\nPeriod.id: 2025-FY | 2024-FY"
)


def test_compactar_tira_rotulos_recortes_e_valores_e_mantem_a_estrutura():
    curto = compactar_esquema(ESQUEMA_LONGO)
    assert "(:FinancialFact) {metric: STRING, value: FLOAT}" in curto
    assert "(:FinancialFact)-[:FOR_PERIOD]->(:Period)" in curto
    assert "Entidade = qualquer um destes rótulos" in curto
    for fora in ("Rótulos existentes", "Lucro | Receita", "Exemplos de recorte", "Valores de exemplo"):
        assert fora not in curto
    assert len(curto) < len(ESQUEMA_LONGO) / 2


def test_compactar_esquema_sem_secoes_longas_nao_muda_nada():
    assert compactar_esquema(ESQUEMA) == ESQUEMA


def test_variante_compacto_e_nativa_com_esquema_curto_e_mantem_os_candidatos():
    msgs = montar_mensagens("compacto", "Quanto?", ESQUEMA_LONGO, "TERMOS", [], CANDIDATOS)
    assert [m["role"] for m in msgs] == ["user"]
    texto = msgs[0]["content"]
    assert texto.startswith("Generate Cypher statement") and texto.rstrip().endswith("Cypher output:")
    assert "Rótulos existentes" not in texto and "Valores de exemplo" not in texto
    assert all(r in texto for r in CANDIDATOS) and "TERMOS" not in texto


# ---------- 3: como o especialista responde ----------


@pytest.mark.parametrize(
    "texto",
    [
        "Cypher output: MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1",
        "cypher output:\nMATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1",
        "```cypher\nMATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1\n```\nIsso devolve o valor.",
        "MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1\n\nExplanation: devolve o valor.",
    ],
)
def test_extrator_entende_as_formas_de_resposta_do_especialista(texto):
    assert extrair_cypher(texto) == "MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1"


def test_quebra_de_linha_escrita_como_barra_n_vira_espaco_fora_de_string():
    """O especialista foi treinado com Cypher em JSON e devolve `\\n` literal entre as cláusulas; sem tratar,
    `\\nRETURN` não é uma palavra e a guarda recusa a consulta como `incompleta` (visto no 1º teste real)."""
    cru = "MATCH (f:FinancialFact)\\nWHERE f.page = 3\\nRETURN f.value AS v"
    assert extrair_cypher(cru) == "MATCH (f:FinancialFact) WHERE f.page = 3 RETURN f.value AS v"
    assert extrair_cypher("```cypher\n" + cru + "\n```") == extrair_cypher(cru)


def test_barra_n_dentro_de_string_do_cypher_e_preservada():
    texto = "MATCH (f:FinancialFact) WHERE f.metric = 'a\\nb' RETURN f.value AS v"
    assert extrair_cypher(texto) == texto


def test_consulta_com_barra_n_literal_passa_pela_guarda_depois_do_extrator():
    from indexer.guarda_cypher import preparar

    final, motivo = preparar(extrair_cypher("MATCH (n:X)\\nRETURN count(n) AS total"))
    assert motivo is None and final.endswith("LIMIT 100")


def test_prosa_do_especialista_sem_consulta_continua_sendo_sem_cypher():
    with pytest.raises(ValueError, match="sem_cypher"):
        extrair_cypher("Cypher output: não sei responder a isso")


# ---------- 4 e 5: o resumo da corrida ----------


def caso(id_, grupo, ok, erro=None, total=1000, llm=900, bloqueada=None):
    return {
        "id": id_, "grupo": grupo, "ok": ok, "erro": erro, "linhas": 1 if ok else 0,
        "latencia_ms": {"llm": llm, "total": total}, "bloqueada": bloqueada, "corrigida": False,
    }  # fmt: skip


def test_resumo_separa_a_primeira_chamada_da_mediana_das_demais():
    casos = [
        caso("a", "teste", True, total=9000, llm=8900),  # a primeira leva a carga do modelo
        caso("b", "teste", True, total=1000, llm=900),
        caso("c", "teste", False, total=3000, llm=2900),
        caso("d", "ajuste", True, total=2000, llm=1900),
    ]
    r = resumir_casos(casos)
    assert r["latencia_ms"]["primeira"] == 9000
    assert r["latencia_ms"]["mediana"] == 2000  # sem a primeira: 1000, 2000, 3000
    assert r["latencia_ms"]["maximo"] == 3000
    assert r["latencia_ms"]["llm_mediana"] == 1900
    assert r["latencia_ms"]["mediana_com_primeira"] == 2500


def test_resumo_conta_acerto_por_grupo_e_consultas_que_rodaram():
    casos = [
        caso("a", "teste", True),
        caso("b", "teste", False),  # rodou e errou
        caso("c", "teste", False, erro="sem_cypher"),
        caso("d", "teste", False, erro="bloqueada_pela_guarda: clausula_proibida:SET", bloqueada="x"),
        caso("e", "ajuste", True),
        caso("f", "ajuste", False, erro="falha_na_execucao: Invalid input"),
    ]
    r = resumir_casos(casos)
    assert r["teste"] == {"n": 4, "acertos": 1, "acuracia": 0.25, "rodaram": 2, "taxa_rodou": 0.5}
    assert r["ajuste"] == {"n": 2, "acertos": 1, "acuracia": 0.5, "rodaram": 1, "taxa_rodou": 0.5}
    assert r["geral"]["n"] == 6 and r["geral"]["acertos"] == 2 and r["geral"]["rodaram"] == 3
    assert r["erros"] == {"sem_cypher": 1, "bloqueada_pela_guarda": 1, "falha_na_execucao": 1}


def test_resumo_de_corrida_vazia_nao_divide_por_zero():
    r = resumir_casos([])
    assert r["geral"]["n"] == 0 and r["geral"]["acuracia"] == 0
    assert r["latencia_ms"]["mediana"] == 0 and r["latencia_ms"]["primeira"] == 0


def test_resumo_com_um_caso_so_usa_ele_como_mediana():
    r = resumir_casos([caso("a", "teste", True, total=700)])
    assert r["latencia_ms"]["primeira"] == 700 and r["latencia_ms"]["mediana"] == 700


# ---------- 4: a carga do modelo ----------


class _Servidor:
    """llama-swap de mentira: atende a primeira requisição devagar, como na carga do modelo."""

    def __init__(self, atraso=0.0, status=200):
        self.corpos: list[dict] = []
        dono = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers["Content-Length"])
                dono.corpos.append(json.loads(self.rfile.read(n)))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if status == 200:
                    self.wfile.write(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())

            def log_message(self, *a):
                pass

        self.http = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.http.server_port}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def fechar(self):
        self.http.shutdown()
        self.http.server_close()


def test_aquecer_pede_um_token_ao_modelo_certo_e_devolve_o_tempo_em_ms():
    s = _Servidor()
    try:
        ms = aquecer(s.url, "gemma3-4b-text2cypher")
    finally:
        s.fechar()
    assert isinstance(ms, int) and ms >= 0
    assert s.corpos[0]["model"] == "gemma3-4b-text2cypher" and s.corpos[0]["max_tokens"] <= 4


def test_aquecer_propaga_a_falha_do_servidor_em_vez_de_medir_um_erro():
    s = _Servidor(status=500)
    try:
        with pytest.raises(Exception):  # noqa: B017 - o tipo é do urllib; o que importa é não engolir
            aquecer(s.url, "x")
    finally:
        s.fechar()


# ---------- 6: mesma guarda, outro prompt ----------


def test_perguntar_aceita_a_variante_nativa_e_manda_uma_mensagem_so_ao_llm():
    vistas: list = []

    def gera(mensagens):
        vistas.append(mensagens)
        return "Cypher output: MATCH (f:FinancialFact) RETURN f.value AS v, f.page AS pagina"

    r = perguntar(
        BancoFalso(), "Quanto?", gera, esquema_texto=ESQUEMA, terminologia_texto="T", exemplos=[],
        rotulos=["Lucro líquido"], prompt="nativo",
    )  # fmt: skip
    assert [m["role"] for m in vistas[0]] == ["user"]
    assert r["erro"] is None and r["linhas"]


def test_guarda_continua_valendo_para_o_especialista():
    r = perguntar(
        BancoFalso(), "q?", lambda m: "Cypher output: MATCH (n) DETACH DELETE n", esquema_texto=ESQUEMA,
        terminologia_texto="T", exemplos=[], prompt="nativo",
    )  # fmt: skip
    assert r["erro"].startswith("bloqueada_pela_guarda")


def test_autocorrecao_funciona_com_o_prompt_de_uma_mensagem_so():
    banco = BancoFalso(
        explain=[RuntimeError("Invalid input 'RETURN'"), Resumo(plano("NodeByLabelScan"))],
    )
    gera = llm("MATCH (n RETURN n", "MATCH (f:FinancialFact) RETURN f.value AS v, f.page AS pagina")
    r = perguntar(
        banco, "q?", gera, esquema_texto=ESQUEMA, terminologia_texto="T", exemplos=[], prompt="nativo"
    )
    assert r["guarda"]["corrigida"] and r["erro"] is None
    assert [m["role"] for m in gera.chamadas[1]] == ["user", "assistant", "user"]


def test_perguntar_com_variante_desconhecida_devolve_erro_e_nao_chama_o_llm():
    chamadas: list = []
    r = perguntar(
        BancoFalso(), "q?", lambda m: chamadas.append(m) or "MATCH (n) RETURN n", esquema_texto=ESQUEMA,
        terminologia_texto="T", exemplos=[], prompt="inventada",
    )  # fmt: skip
    assert r["erro"].startswith("prompt_invalido") and not chamadas
