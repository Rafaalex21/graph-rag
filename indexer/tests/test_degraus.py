from indexer import degraus
from indexer.avaliar import julgar, montar_relatorio


def caso(i="N1"):
    return {
        "id": i, "categoria": "numerica", "pergunta": "Qual o lucro?", "paginas": "93",
        "tipo_gabarito": "valor", "valor": "10", "unidade": "%", "no_recorte": "sim", "gabarito": "10%",
    }  # fmt: skip


def test_a0_nao_tem_contexto_nem_citacoes():
    vistas = []

    def chat(mensagens):
        vistas.append(mensagens)
        return "Não sei."

    r = degraus.sistema_a0(chat)(caso())
    assert r == {"resposta": "Não sei.", "contexto": [], "citacoes": [], "citacoes_invalidas": 0}
    assert [m["role"] for m in vistas[0]] == ["system", "user"]
    assert "NÃO tem acesso ao documento" in vistas[0][0]["content"]
    assert vistas[0][1]["content"] == "Qual o lucro?"


def test_a1_e_a2_entregam_k_filhos_sem_pai(monkeypatch):
    chamadas = {}

    def falso_buscar(driver, pergunta, embute, k, modo, banco):
        chamadas.update(k=k, modo=modo)
        return [{"text": f"texto {n}", "pageStart": 90 + n, "pageEnd": 90 + n} for n in range(k)]

    monkeypatch.setattr(degraus, "buscar", falso_buscar)
    prompts = []

    def chat(mensagens):
        prompts.append(mensagens[1]["content"])
        return "Resposta [p. 91]."

    r = degraus.sistema_filhos(None, None, chat, "vetor")(caso())
    assert chamadas == {"k": 6, "modo": "vetor"}
    assert [c["paginas"] for c in r["contexto"]] == [f"p. {90 + n}" for n in range(6)]
    assert "[p. 90]\ntexto 0" in prompts[0] and "Seção" not in prompts[0]
    assert r["citacoes_invalidas"] == 0 and r["citacoes"][0]["valida"]
    degraus.sistema_filhos(None, None, chat, "hibrido-rrf")(caso())
    assert chamadas["modo"] == "hibrido-rrf"


def test_a1_sem_filhos_recusa_sem_chamar_o_llm(monkeypatch):
    monkeypatch.setattr(degraus, "buscar", lambda *a, **k: [])
    r = degraus.sistema_filhos(None, None, lambda m: 1 / 0, "vetor")(caso())
    assert r["resposta"].startswith("Não encontrei") and r["contexto"] == []


def test_a3_so_reescreve_no_a3r(monkeypatch):
    recebido = {}

    def falso_responder(driver, pergunta, embute, notas, chat, **kw):
        recebido.update(kw)
        return {"resposta": "ok", "contexto": []}

    monkeypatch.setattr(degraus, "responder", falso_responder)
    monkeypatch.setattr(degraus, "llm_llama", lambda base: "llm")
    monkeypatch.setattr(
        degraus, "reescrever", lambda p, llm, stepback, hyde: {"stepback": "geral?", "hyde": "trecho"}
    )
    degraus.sistema_a3(None, None, None, None, "http://x", False)(caso())
    assert recebido["stepback"] is None and recebido["hyde"] is None
    degraus.sistema_a3(None, None, None, None, "http://x", True)(caso())
    assert recebido["stepback"] == "geral?" and recebido["hyde"] == "trecho"


def test_julgar_so_as_metricas_pedidas_e_relatorio_tolera_as_ausentes(tmp_path):
    chamadas = []

    def juiz(mensagens, esquema, max_tokens):
        chamadas.append(1)
        return {"veredito": "correta", "justificativa": "ok"}

    c = caso()
    r = {"id": "N1", "resposta": "10%", "contexto": [], "erro": None, "segundos": 1.0}
    notas = julgar([c], [r], juiz, tmp_path, ("correcao",))
    assert len(chamadas) == 1 and [j["metrica"] for j in notas] == ["correcao"]
    rel = montar_relatorio("a0", [c], [r], notas, "a0")
    assert rel["degrau"] == "a0"
    assert rel["geral"]["correcao"]["media"] == 1.0
    assert rel["geral"]["recall_contexto"]["media"] is None
    assert rel["mecanicas"]["geral"]["page_recall"]["@6"]["media"] == 0.0
