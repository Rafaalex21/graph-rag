"""Embeddings dos resumos de entidade (F5.7): cada teste nomeia uma forma de a busca falhar."""

from indexer.entidades_vec import (
    MAX_ALIASES,
    MAX_CHARS,
    acertou_em_1,
    hash_do_texto,
    precisam_de_vetor,
    texto_da_entidade,
)


def ent(**kw):
    base = {
        "id": "e1",
        "name": "Banco Alfa",
        "type": "ORGANIZATION",
        "summary": "Banco de varejo.",
        "aliases": [],
    }
    return {**base, **kw}


def test_texto_leva_nome_tipo_em_portugues_e_resumo():
    t = texto_da_entidade(ent())
    assert t.startswith("Banco Alfa (organização)") and "Banco de varejo." in t


def test_sem_resumo_o_texto_ainda_identifica_a_entidade():
    t = texto_da_entidade(ent(summary=None))
    assert "Banco Alfa" in t and t.strip() != ""
    assert texto_da_entidade(ent(summary="   ")) == t


def test_apelidos_entram_sem_repetir_o_nome_nem_a_si_mesmos_e_com_limite():
    t = texto_da_entidade(ent(aliases=["BANCO ALFA", "Alfa", "alfa", "Bco Alfa"]))
    assert "Alfa | Bco Alfa" in t and t.count("BANCO ALFA") == 0
    muitos = texto_da_entidade(ent(aliases=[f"apelido{i}" for i in range(50)]))
    assert muitos.count("apelido") == MAX_ALIASES


def test_aliases_ausentes_ou_nulos_nao_quebram():
    assert texto_da_entidade(ent(aliases=None)) == texto_da_entidade(ent(aliases=[]))


def test_tipo_desconhecido_vira_o_proprio_rotulo_em_minusculas():
    assert "(tipo_novo)" in texto_da_entidade(ent(type="TIPO_NOVO"))


def test_texto_enorme_e_cortado_para_caber_no_contexto_do_embedder():
    assert len(texto_da_entidade(ent(summary="x" * 50000))) <= MAX_CHARS


def test_entidades_de_tipos_diferentes_com_o_mesmo_nome_geram_textos_diferentes():
    a, b = ent(type="PRODUCT_OR_SERVICE", name="Pix"), ent(type="POLICY_OR_PROGRAM", name="Pix")
    assert texto_da_entidade(a) != texto_da_entidade(b)


def test_hash_muda_com_o_texto_e_nao_com_o_id():
    assert hash_do_texto("a") != hash_do_texto("b") and hash_do_texto("a") == hash_do_texto("a")


def test_so_embute_quem_nao_tem_vetor_ou_cujo_texto_mudou():
    es = [ent(id="novo"), ent(id="igual"), ent(id="mudou", summary="outro")]
    gravados = {"igual": hash_do_texto(texto_da_entidade(es[1])), "mudou": hash_do_texto("texto velho")}
    assert [e["id"] for e in precisam_de_vetor(es, gravados)] == ["novo", "mudou"]
    assert precisam_de_vetor(es, {e["id"]: hash_do_texto(texto_da_entidade(e)) for e in es}) == []


def test_acerto_em_1_aceita_empate_com_texto_identico_e_recusa_outro_texto():
    textos = {"a": "mesmo", "b": "mesmo", "c": "diferente"}
    assert acertou_em_1("a", ["a"], textos)
    assert acertou_em_1("a", ["b"], textos)  # outra entidade com exatamente o mesmo texto: empate legítimo
    assert not acertou_em_1("a", ["c"], textos)
    assert not acertou_em_1("a", [], textos)
