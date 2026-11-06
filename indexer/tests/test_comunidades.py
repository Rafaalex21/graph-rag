"""Hierarquia de comunidades e modularidade (F5.5): cada teste nomeia uma forma de falhar."""

import pytest

from indexer.comunidades import hierarquia, modularidade, refinar, resumo_por_nivel


def test_dois_niveis_aninhados_ligam_cada_comunidade_a_seu_pai():
    # a,b,c juntos no nível 0 e no 1; d,e juntos no 0; no nível 1 d,e se juntam a f
    atrib = {"a": [0, 0], "b": [0, 0], "c": [1, 0], "d": [2, 1], "e": [2, 1], "f": [3, 1]}
    coms = hierarquia(atrib)
    por_nivel = resumo_por_nivel(coms)
    assert por_nivel == {0: 4, 1: 2}
    n0 = {tuple(c["membros"]): c for c in coms if c["nivel"] == 0}
    n1 = {tuple(c["membros"]): c for c in coms if c["nivel"] == 1}
    assert n0[("a", "b")]["pai"] == n1[("a", "b", "c")]["id"] == n0[("c",)]["pai"]
    assert n0[("d", "e")]["pai"] == n1[("d", "e", "f")]["id"]
    assert all(c["pai"] is None for c in n1.values())


def test_o_id_nao_depende_da_ordem_nem_dos_numeros_do_gds():
    a = {"a": [5, 9], "b": [5, 9], "c": [7, 9]}
    b = {"c": [1, 4], "b": [8, 4], "a": [8, 4]}  # outra numeração e outra ordem
    assert sorted(c["id"] for c in hierarquia(a)) == sorted(c["id"] for c in hierarquia(b))


def test_comunidade_igual_em_dois_niveis_tem_ids_diferentes():
    coms = hierarquia({"a": [0, 0], "b": [0, 0]})
    assert len({c["id"] for c in coms}) == 2 and {c["nivel"] for c in coms} == {0, 1}


def test_um_nivel_so_nao_tem_pai():
    coms = hierarquia({"a": [0], "b": [0], "c": [1]})
    assert len(coms) == 2 and all(c["pai"] is None for c in coms)


def test_comunidade_unitaria_continua_na_hierarquia():
    coms = hierarquia({"a": [0, 0], "b": [1, 0]})
    assert sorted(len(c["membros"]) for c in coms if c["nivel"] == 0) == [1, 1]


def test_nivel_que_nao_se_aninha_e_erro_e_nao_pai_escolhido_ao_acaso():
    with pytest.raises(ValueError, match="aninhad"):
        hierarquia({"a": [0, 0], "b": [0, 1]})  # a e b juntos no nível 0, separados no 1


def test_refinar_divide_a_comunidade_que_tem_dois_pais_e_nao_escolhe_um():
    # achado da F5.8: o Leiden do GDS deixou uma comunidade do nível 0 com dois pais
    atrib = {"a": [0, 0], "b": [0, 0], "c": [0, 1], "d": [1, 1]}
    novas, divididas = refinar(atrib)
    assert divididas == [1, 0]  # 1 comunidade do nível 0 dividida; o nível de cima não muda
    coms = hierarquia(novas)  # agora aninha, sem ValueError
    n0 = {tuple(c["membros"]): c for c in coms if c["nivel"] == 0}
    assert set(n0) == {("a", "b"), ("c",), ("d",)}
    n1 = {tuple(c["membros"]): c["id"] for c in coms if c["nivel"] == 1}
    assert n0[("a", "b")]["pai"] == n1[("a", "b")] and n0[("c",)]["pai"] == n1[("c", "d")]


def test_refinar_nao_mexe_no_que_ja_aninha_e_propaga_a_divisao_para_baixo():
    ok = {"a": [0, 0], "b": [1, 0], "c": [2, 1]}
    novas, divididas = refinar(ok)
    assert divididas == [0, 0]
    assert [len({v[n] for v in novas.values()}) for n in (0, 1)] == [3, 2]  # mesmas comunidades de antes
    # três níveis: a divisão do nível 2 desce até o 0 (a e b ficam juntos só se tiverem o mesmo caminho)
    tres = {"a": [0, 0, 0], "b": [0, 0, 1], "c": [0, 0, 1]}
    novas, divididas = refinar(tres)
    assert divididas == [1, 1, 0]
    coms = hierarquia(novas)
    assert sorted(len(c["membros"]) for c in coms if c["nivel"] == 0) == [1, 2]


def test_refinar_nao_muda_as_entidades_de_lugar_so_separa():
    atrib = {"a": [0, 0], "b": [0, 1], "c": [1, 1]}
    novas, _ = refinar(atrib)
    # quem estava junto no nível 1 continua junto; quem estava no mesmo nível 0 e pai igual continua junto
    assert novas["b"][1] == novas["c"][1] != novas["a"][1]
    assert len({tuple(v) for v in novas.values()}) == 3


def test_entrada_vazia_ou_com_niveis_de_tamanhos_diferentes():
    assert hierarquia({}) == []
    with pytest.raises(ValueError, match="niveis"):
        hierarquia({"a": [0, 0], "b": [0]})


def test_membros_saem_ordenados_para_o_hash_ser_estavel():
    (c,) = hierarquia({"z": [0], "a": [0], "m": [0]})
    assert c["membros"] == ["a", "m", "z"]


ARESTAS = [
    ("a", "b", 1.0),
    ("b", "c", 1.0),
    ("a", "c", 1.0),
    ("d", "e", 1.0),
    ("e", "f", 1.0),
    ("d", "f", 1.0),
]


def test_modularidade_de_dois_triangulos_separados():
    part = {"a": 0, "b": 0, "c": 0, "d": 1, "e": 1, "f": 1}
    assert modularidade(ARESTAS, part) == pytest.approx(0.5)


def test_modularidade_de_tudo_numa_comunidade_e_zero_e_a_dos_unitarios_e_negativa():
    assert modularidade(ARESTAS, dict.fromkeys("abcdef", 0)) == pytest.approx(0.0)
    assert modularidade(ARESTAS, {k: i for i, k in enumerate("abcdef")}) == pytest.approx(-1 / 6)


def test_modularidade_usa_o_peso_das_arestas():
    arestas = [("a", "b", 9.0), ("b", "c", 1.0)]
    junto = modularidade(arestas, {"a": 0, "b": 0, "c": 1})
    errado = modularidade(arestas, {"a": 0, "b": 1, "c": 1})
    assert junto > errado


def test_modularidade_sem_arestas_nao_divide_por_zero():
    assert modularidade([], {"a": 0}) == 0.0
