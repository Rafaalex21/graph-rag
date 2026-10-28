import indexer


def test_pacote_importa_e_tem_versao():
    assert indexer.__version__ == "0.1.0"
