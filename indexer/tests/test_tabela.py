from indexer.tabela import CATEGORIAS, montar, num, seg


def rel(corr, fid=1.0, rec=0.5, pr=0.6, an=0.2, p50=4.0, p95=9.0):
    m = {"n": 5, "media": None}
    cats = {c: {"correcao": {"n": 1, "media": corr}} for c, _ in CATEGORIAS}
    return {
        "so_no_recorte": {
            "correcao": {"n": 54, "media": corr},
            "fidelidade": {"n": 54, "media": fid},
            "recall_contexto": {"n": 49, "media": rec},
        },
        "por_categoria": cats,
        "mecanicas": {
            "so_no_recorte": {
                "page_recall": {"@6": {"n": 49, "media": pr}},
                "acerto_numerico": {"n": 20, "media": an},
                "latencia_s": {"n": 54, "p50": p50, "p95": p95, "maximo": 20.0, **m},
            }
        },
    }


def test_formatacao_em_ptbr():
    assert num({"n": 1, "media": 0.5463}) == "0,55"
    assert num({"n": 0, "media": None}) == "—" and num(None) == "—"
    assert seg(4.46) == "4,5" and seg(None) == "—"


def test_tabela_tem_uma_linha_por_degrau_e_marca_o_que_nao_existe_sem_contexto():
    rels = {"v0-a0": rel(0.2), "v0-a1": rel(0.3), "v0-a2": rel(0.4), "f3-2-a3-60": rel(0.55)}
    md = montar(rels)
    linhas = {
        c: next(x for x in md.splitlines() if x.startswith(f"| **{c}**")) for c in ("A0", "A1", "A2", "A3")
    }
    assert "n/a | n/a" in linhas["A0"] and "0,20" in linhas["A0"]
    assert "0,55" in linhas["A3"] and "4,0 / 9,0" in linhas["A3"]
    assert "| A3r | A3 + reescrita (step-back e HyDE) | (não rodado)" in md
    assert "só nas 54 com `no_recorte` = sim" in md
