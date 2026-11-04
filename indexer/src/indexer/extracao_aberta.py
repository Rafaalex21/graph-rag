"""Extração aberta por Pai, a camada MS GraphRAG (ARQUITETURA §5 I-6, tarefa F5.1).

Cada Pai vira uma chamada ao Qwen3.6 do perfil `indexar` com `response_format: json_schema` do contêiner
`ExtracaoAberta` (`contracts/open_extraction.schema.json`): entidades de onze tipos fixos e relações com força
de 1 a 10. Só Pais entram (Tabelas ficam com a extração dirigida). Valem as mesmas regras da F4.2: resposta
validada pelo Pydantic, uma retentativa com a mensagem de erro anexada, cache por hash e gravação atômica.

* **Prompt em português**, com os nomes como aparecem no documento (não traduzidos nem normalizados): quem
  converge variantes de grafia é a F5.3, e quem cruza com o catálogo de métricas da F4.6 também.
* **Exemplo fictício** no prompt (empresa inventada): nenhum trecho do documento do BB vai para o repositório
  (ADR-009).
* **Gleaning** (F5.2): `--gleaning 1` faz uma segunda chamada no mesmo diálogo pedindo só o que faltou
  (`CONTINUAR`); o acréscimo é fundido à primeira resposta, sem repetir nome nem relação, e a fusão passa
  pelas mesmas validações. A primeira resposta fica guardada à parte (`resposta`), o resultado com a rodada
  extra em `gleaning.resposta`, para medir o ganho sobre os mesmos Pais sem rodar a primeira passada duas
  vezes. O contrato (ARQUITETURA §5 I-6) é 0 ou 1 rodada; a decisão está no ADR-039.

Uso (a partir de indexer/, com llama-swap no perfil `indexar` no ar):
    uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --amostra 5
    uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --amostra 20 \\
        --minimo 100 --semente 2 --gleaning 1 --saida aberta_f52 --excluir ID1 ID2
    uv run python -m indexer.extracao_aberta resumo ../data/parsed/bb_fre_2026_recorte --saida aberta_f52
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import time
import unicodedata
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from indexer.extrair import DOCUMENTO, MODELO_LLM, PEDIDO_PAI, _gravar, _paginas
from indexer.schemas import TIPOS_DE_ENTIDADE, VERSAO_ABERTA, ExtracaoAberta
from indexer.schemas.aberta import MAX_ENTIDADES, MAX_RELACOES, normalizar_nome

VERSAO_DO_PROMPT = "v3"  # v1 e v2 foram lidas nos mesmos 5 Pais e corrigidas: ver ADR-038
MIN_TOKENS_AMOSTRA = 300  # a amostra da F5.1 sorteia entre Pais com texto suficiente para ter o que revisar
MAX_TOKENS_SAIDA = 6000  # 30 entidades + 40 relações cabem com folga no slot do perfil `indexar`

DEFINICAO_DOS_TIPOS = {
    "ORGANIZATION": "empresa, banco, órgão, comitê, diretoria, unidade interna, cargo, fundo, instituição, "
    "grupo ou conglomerado (inclui controladas, coligadas, acionistas controladores e contrapartes)",
    "PERSON": "pessoa física citada pelo nome próprio; cargo, órgão ou grupo de acionistas não é PERSON",
    "SEGMENT": "segmento operacional, de negócio, de mercado ou de listagem (ex.: varejo, agronegócio, "
    "Novo Mercado)",
    "PRODUCT_OR_SERVICE": "produto, serviço, linha de crédito, plataforma ou canal que a empresa oferece "
    "a clientes; políticas e programas internos não são produtos",
    "FINANCIAL_METRIC": "indicador financeiro nomeado (ex.: lucro líquido, índice de Basileia); o valor "
    '("R$ 625 milhões", "27,1%") nunca é uma entidade: vai na descrição do indicador ou do que ele mede',
    "RISK": "risco ou fator de risco nomeado (ex.: risco de crédito, lavagem de dinheiro)",
    "EVENT": "acontecimento com data ou período (aquisição, emissão, mudança de controle, ação judicial, "
    "aprovação, revisão)",
    "FINANCIAL_INSTRUMENT": "instrumento ou valor mobiliário (ação, debênture, letra, CDB, derivativo)",
    "REGULATION": "lei, norma, decreto, resolução, circular ou regulamento externo",
    "POLICY_OR_PROGRAM": "política, programa, metodologia, processo ou instrumento interno de governança, "
    "controle e compliance (ex.: política de prevenção à lavagem de dinheiro, programa de integridade)",
    "LOCATION": "país, estado, cidade, praça ou região geográfica relevante para a operação",
}

# O esquema, o prompt e esta tabela dizem os mesmos onze tipos, na mesma ordem; o teste confere.
assert tuple(DEFINICAO_DOS_TIPOS) == TIPOS_DE_ENTIDADE

EXEMPLO_TRECHO = (
    "A Alfa Energia S.A. é controlada pela Holding Beta Participações e atua nos segmentos de geração e de "
    "distribuição. Em março de 2024 emitiu debêntures de R$ 500 milhões para financiar a usina Ventania, em "
    "Pernambuco. A Resolução ANEEL nº 999 limita o reajuste das tarifas de distribuição. O lucro líquido de "
    "2023 foi de R$ 80 milhões. A Política de Integridade, aprovada pelo Conselho de Administração, é "
    "gerida pela Diretoria de Conformidade, que a revisou em 2024."
)
EXEMPLO_RESPOSTA = {
    "entities": [
        {
            "name": "Alfa Energia S.A.",
            "type": "ORGANIZATION",
            "description": "Empresa de energia controlada pela Holding Beta Participações.",
        },
        {
            "name": "Holding Beta Participações",
            "type": "ORGANIZATION",
            "description": "Controladora da Alfa Energia S.A.",
        },
        {"name": "geração", "type": "SEGMENT", "description": "Segmento em que a Alfa Energia atua."},
        {"name": "distribuição", "type": "SEGMENT", "description": "Segmento em que a Alfa Energia atua."},
        {
            "name": "debêntures",
            "type": "FINANCIAL_INSTRUMENT",
            "description": "Emitidas em março de 2024, de R$ 500 milhões, para financiar a usina Ventania.",
        },
        {
            "name": "usina Ventania",
            "type": "PRODUCT_OR_SERVICE",
            "description": "Usina em Pernambuco financiada com as debêntures.",
        },
        {"name": "Pernambuco", "type": "LOCATION", "description": "Estado onde fica a usina Ventania."},
        {
            "name": "Resolução ANEEL nº 999",
            "type": "REGULATION",
            "description": "Limita o reajuste das tarifas de distribuição.",
        },
        {
            "name": "lucro líquido",
            "type": "FINANCIAL_METRIC",
            "description": "Foi de R$ 80 milhões em 2023.",
        },
        {
            "name": "Política de Integridade",
            "type": "POLICY_OR_PROGRAM",
            "description": "Aprovada pelo Conselho de Administração e gerida pela Diretoria de Conformidade.",
        },
        {
            "name": "Conselho de Administração",
            "type": "ORGANIZATION",
            "description": "Aprovou a Política de Integridade.",
        },
        {
            "name": "Diretoria de Conformidade",
            "type": "ORGANIZATION",
            "description": "Gere e revisou em 2024 a Política de Integridade.",
        },
        {
            "name": "revisão da Política de Integridade",
            "type": "EVENT",
            "description": "Feita em 2024 pela Diretoria de Conformidade.",
        },
    ],
    "relationships": [
        {
            "source": "Holding Beta Participações",
            "target": "Alfa Energia S.A.",
            "description": "A Holding Beta Participações controla a Alfa Energia.",
            "strength": 9,
        },
        {
            "source": "Alfa Energia S.A.",
            "target": "debêntures",
            "description": "A Alfa Energia emitiu as debêntures em março de 2024.",
            "strength": 8,
        },
        {
            "source": "debêntures",
            "target": "usina Ventania",
            "description": "As debêntures financiam a usina.",
            "strength": 7,
        },
        {
            "source": "usina Ventania",
            "target": "Pernambuco",
            "description": "A usina fica em Pernambuco.",
            "strength": 3,
        },
        {
            "source": "Resolução ANEEL nº 999",
            "target": "distribuição",
            "description": "A resolução limita o reajuste de tarifas do segmento.",
            "strength": 6,
        },
        {
            "source": "Alfa Energia S.A.",
            "target": "lucro líquido",
            "description": "O lucro líquido da Alfa Energia em 2023 foi de R$ 80 milhões.",
            "strength": 4,
        },
        {
            "source": "Conselho de Administração",
            "target": "Política de Integridade",
            "description": "O Conselho de Administração aprovou a política.",
            "strength": 7,
        },
        {
            "source": "Diretoria de Conformidade",
            "target": "Política de Integridade",
            "description": "A Diretoria de Conformidade gere a política.",
            "strength": 7,
        },
        {
            "source": "Diretoria de Conformidade",
            "target": "revisão da Política de Integridade",
            "description": "A Diretoria de Conformidade fez a revisão em 2024.",
            "strength": 5,
        },
    ],
}

_TIPOS_NO_PROMPT = "\n".join(f"- {t}: {d}" for t, d in DEFINICAO_DOS_TIPOS.items())

SISTEMA = (
    "Você extrai um grafo de conhecimento de um Formulário de Referência de uma empresa brasileira. "
    "Responda apenas com o JSON do esquema, sem comentários.\n"
    "Tipos de entidade (use só estes onze, exatamente como escritos):\n"
    f"{_TIPOS_NO_PROMPT}\n"
    "Regras:\n"
    "1. Extraia só o que o trecho diz; nunca complete com o que você sabe de memória. Escreva o estado que "
    "o trecho afirma: se ele só anuncia, propõe, aprova ou autoriza algo, não diga que já aconteceu.\n"
    '2. "name": o nome como está no texto, sem traduzir nem abreviar; se houver forma completa e sigla, '
    "use a completa. Uma entidade aparece uma vez só na lista, mesmo citada várias vezes ou com dois nomes "
    "(a lei e o apelido dela são uma entidade; o outro nome vai na descrição, e nunca há relação "
    '"é a mesma coisa" entre dois nomes).\n'
    '3. "description": o que o trecho diz sobre a entidade, em até duas frases, sem opinião.\n'
    "4. Relações: só entre entidades da sua lista, com `source` e `target` idênticos ao `name` delas. "
    "Descreva por que se relacionam, segundo o trecho: só ligue duas coisas se o trecho as liga, e não "
    "porque estão no mesmo parágrafo ou na mesma frase.\n"
    "5. Força de 1 a 10, usando a escala toda: 1-3 citação de passagem ou ligação por lista; 4-6 relação "
    "clara; 7-10 relação central ao trecho (controle, emissão, regulação direta, risco principal). Só as "
    "três ou quatro relações mais importantes do trecho passam de 7; a maioria fica entre 3 e 6.\n"
    "6. Não crie entidade para números, valores, datas, nomes de seções, tabelas ou páginas. Um "
    'acontecimento com data é um EVENT nomeado pelo que aconteceu ("leilão da oferta", "aprovação da '
    'reorganização", "revisão da política"), com a data na descrição; nunca use a data como nome. Inclua '
    "esses EVENT (aprovações, revisões, aquisições, emissões).\n"
    f"7. No máximo {MAX_ENTIDADES} entidades: priorize as centrais ao trecho. Trecho sem entidades dos "
    "tipos acima: devolva as duas listas vazias.\n\n"
    f"Exemplo (empresa fictícia).\nTrecho: {EXEMPLO_TRECHO}\n"
    f"Resposta: {json.dumps(EXEMPLO_RESPOSTA, ensure_ascii=False)}"
)

Resposta = dict[str, Any]
Gerador = Callable[[list[dict]], Resposta]


def unidades(chunks: dict, documento: str = DOCUMENTO) -> list[dict]:
    """Uma unidade por Pai com texto (mesmo pedido da F4.2): id, tamanho, páginas e o pedido ao LLM."""
    saida = []
    for p in chunks["pais"]:
        pedido = PEDIDO_PAI.format(
            documento=documento,
            caminho=" › ".join(p["caminho"]),
            paginas=_paginas(p["pagina_inicio"], p["pagina_fim"]),
            texto=p["texto"],
        )
        saida.append(
            {
                "id": p["id"],
                "tipo": "pai",
                "tokens": p["tokens"],
                "paginas": [p["pagina_inicio"], p["pagina_fim"]],
                "pedido": pedido,
            }
        )
    return saida


def amostrar(
    lista: list[dict], n: int, semente: int, minimo: int = MIN_TOKENS_AMOSTRA, excluir: tuple[str, ...] = ()
) -> list[dict]:
    """`n` Pais sorteados (com semente) entre os de pelo menos `minimo` tokens, na ordem do documento.

    A regra é registrada no ADR para a amostra ser refeita; o corte de tokens só evita sortear trechos que
    não têm o que revisar, e `excluir` tira os Pais que já serviram para ajustar o prompt."""
    elegiveis = [u for u in lista if u["tokens"] >= minimo and u["id"] not in excluir]
    sorteados = random.Random(semente).sample(elegiveis, min(n, len(elegiveis)))
    ordem = {u["id"]: i for i, u in enumerate(lista)}
    return sorted(sorteados, key=lambda u: ordem[u["id"]])


def esquema_de_resposta() -> dict:
    """O JSON Schema que vai em `response_format` (o mesmo de `contracts/open_extraction.schema.json`)."""
    return ExtracaoAberta.model_json_schema()


def gerador_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 900) -> Gerador:
    """Função mensagens -> {conteudo, finish, tokens_prompt, tokens_saida}; o schema vai por gramática."""
    esquema = esquema_de_resposta()

    def gera(mensagens: list[dict]) -> Resposta:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.1,
            "max_tokens": MAX_TOKENS_SAIDA,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "extracao_aberta", "strict": True, "schema": esquema},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            dados = json.load(r)
        escolha = dados["choices"][0]
        uso = dados.get("usage", {})
        return {
            "conteudo": escolha["message"]["content"],
            "finish": escolha.get("finish_reason"),
            "tokens_prompt": uso.get("prompt_tokens", 0),
            "tokens_saida": uso.get("completion_tokens", 0),
        }

    return gera


def validar(resposta: Resposta) -> tuple[dict | None, str | None]:
    """(objeto validado, None) ou (None, problema). Saída cortada por tamanho é inválida."""
    if resposta.get("finish") == "length":
        return None, f"saída cortada por tamanho: devolva no máximo {MAX_ENTIDADES // 2} entidades"
    try:
        return ExtracaoAberta.model_validate_json(resposta["conteudo"]).model_dump(mode="json"), None
    except ValidationError as e:
        if any(x["type"] == "json_invalid" for x in e.errors()):
            return None, f"JSON inválido: {e.errors()[0]['msg']}"
        return None, "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:5])


def extrair(unidade: dict, gera: Gerador, tentativas_max: int = 3) -> dict:
    """Extrai uma unidade; se a resposta for inválida, anexa o erro e pede de novo (no máximo 3 chamadas:
    recusar um nome que é data deixa relações soltas, que só a segunda retentativa costuma limpar)."""
    t0 = time.perf_counter()
    mensagens = [{"role": "system", "content": SISTEMA}, {"role": "user", "content": unidade["pedido"]}]
    tokens_prompt = tokens_saida = tentativas = 0
    primeira_valida = False
    obj, erro = None, None
    while tentativas < tentativas_max:
        r = gera(mensagens)
        tentativas += 1
        tokens_prompt += r.get("tokens_prompt", 0)
        tokens_saida += r.get("tokens_saida", 0)
        obj, erro = validar(r)
        if tentativas == 1:
            primeira_valida = obj is not None
        if obj is not None:
            break
        mensagens += [
            {"role": "assistant", "content": r.get("conteudo") or ""},
            {"role": "user", "content": f"A resposta é inválida ({erro}). Corrija e responda de novo."},
        ]
    return {
        "valida": obj is not None,
        "resposta": obj,
        "erro": erro,
        "tentativas": tentativas,
        "primeira_valida": primeira_valida,
        "tokens_prompt": tokens_prompt,
        "tokens_saida": tokens_saida,
        "segundos": round(time.perf_counter() - t0, 1),
    }


CONTINUAR = (
    "Faltaram entidades ou relações do trecho na sua resposta. Responda de novo com o mesmo esquema, mas só "
    "com o que ainda não está nela: entidades dos onze tipos que o trecho cita e a sua lista não tem, e "
    "relações novas, entre entidades da lista anterior ou das novas, com os nomes idênticos aos da lista. "
    "Valem as mesmas regras. Se nada faltou, devolva as duas listas vazias."
)


def fundir(base: dict, adicional: dict) -> tuple[dict, dict]:
    """Funde o acréscimo do *gleaning* à primeira resposta e devolve (fundida, o que foi mesmo acrescentado).

    Entidade com nome já existente (sem caixa nem espaços sobrando) e relação com o mesmo par origem-destino
    não entram de novo. Dentro dos tetos de entidades e de relações, as relações que citam nome fora da lista
    fundida são descartadas e contadas, em vez de invalidar o acréscimo todo."""
    nomes = {normalizar_nome(e["name"]) for e in base["entities"]}
    entidades, repetidas = [], 0
    for e in adicional.get("entities", []):
        if not (isinstance(e, dict) and "name" in e):
            continue
        chave = normalizar_nome(e["name"])
        if chave in nomes:
            repetidas += 1
        elif len(base["entities"]) + len(entidades) < MAX_ENTIDADES:
            nomes.add(chave)
            entidades.append(e)
    pares = {(normalizar_nome(r["source"]), normalizar_nome(r["target"])) for r in base["relationships"]}
    relacoes, repetidas_rel, soltas = [], 0, 0
    for r in adicional.get("relationships", []):
        if not (isinstance(r, dict) and "source" in r and "target" in r):
            continue
        par = (normalizar_nome(r["source"]), normalizar_nome(r["target"]))
        if par in pares:
            repetidas_rel += 1
        elif par[0] not in nomes or par[1] not in nomes:
            soltas += 1
        elif len(base["relationships"]) + len(relacoes) < MAX_RELACOES:
            pares.add(par)
            relacoes.append(r)
    fundida = {
        "entities": base["entities"] + entidades,
        "relationships": base["relationships"] + relacoes,
    }
    return fundida, {
        "entities": entidades,
        "relationships": relacoes,
        "entidades_repetidas": repetidas,
        "relacoes_repetidas": repetidas_rel,
        "relacoes_soltas": soltas,
    }


def completar(unidade: dict, base: dict, gera: Gerador, tentativas_max: int = 2) -> dict:
    """Uma rodada de *gleaning* sobre a resposta `base` (já válida): o acréscimo é fundido e a fusão validada.

    Se a rodada não der uma fusão válida, vale a primeira resposta (`valida` falso e o erro)."""
    t0 = time.perf_counter()
    mensagens = [
        {"role": "system", "content": SISTEMA},
        {"role": "user", "content": unidade["pedido"]},
        {"role": "assistant", "content": json.dumps(base, ensure_ascii=False)},
        {"role": "user", "content": CONTINUAR},
    ]
    tokens_prompt = tokens_saida = tentativas = 0
    fundida, acrescimo, erro = None, None, None
    while tentativas < tentativas_max:
        r = gera(mensagens)
        tentativas += 1
        tokens_prompt += r.get("tokens_prompt", 0)
        tokens_saida += r.get("tokens_saida", 0)
        fundida, acrescimo, erro = None, None, None
        if r.get("finish") == "length":
            erro = (
                "saída cortada por tamanho: devolva só as entidades e relações que faltam, em poucas linhas"
            )
        else:
            try:
                adicional = json.loads(r["conteudo"])
                if not isinstance(adicional, dict):
                    raise ValueError("a resposta não é um objeto JSON")
                fundida, acrescimo = fundir(base, adicional)
                fundida = ExtracaoAberta.model_validate(fundida).model_dump(mode="json")
            except ValueError as e:  # JSON inválido e ValidationError (que herda de ValueError)
                fundida, acrescimo = None, None
                erro = _problema(e)
        if fundida is not None:
            break
        mensagens += [
            {"role": "assistant", "content": r.get("conteudo") or ""},
            {"role": "user", "content": f"A resposta é inválida ({erro}). Corrija e responda de novo."},
        ]
    return {
        "valida": fundida is not None,
        "resposta": fundida if fundida is not None else base,
        "acrescimo": acrescimo,
        "erro": erro,
        "tentativas": tentativas,
        "tokens_prompt": tokens_prompt,
        "tokens_saida": tokens_saida,
        "segundos": round(time.perf_counter() - t0, 1),
    }


def _problema(e: ValueError) -> str:
    if isinstance(e, ValidationError):
        return "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:5])
    return f"JSON inválido: {e}"


def chave_de_gleaning(unidade: dict, modelo: str = MODELO_LLM) -> str:
    """Chave da rodada extra: a da primeira passada mais o texto de `CONTINUAR`."""
    return hashlib.sha1(f"g1|{chave_de_cache(unidade, modelo)}|{CONTINUAR}".encode()).hexdigest()[:20]


def chave_de_cache(unidade: dict, modelo: str = MODELO_LLM) -> str:
    # o patch do schema não muda o que o modelo deve devolver; só maior.menor entra na chave
    versao_schema = VERSAO_ABERTA.rsplit(".", 1)[0]
    base = f"{VERSAO_DO_PROMPT}|{versao_schema}|{modelo}|{unidade['pedido']}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:20]


def _com_cache(arq: Path, fazer: Callable[[], dict]) -> tuple[dict, bool]:
    """(resultado, veio do cache). Só entrada válida do cache vale; toda execução nova é gravada."""
    if arq.exists():
        guardada = json.loads(arq.read_text(encoding="utf-8"))
        if guardada.get("valida"):
            return guardada, True
    r = fazer()
    _gravar(arq, r)
    return r, False


def extrair_todas(
    lista: list[dict],
    gera: Gerador,
    cache: Path,
    paralelismo: int = 2,
    modelo: str = MODELO_LLM,
    log=None,
    gleaning: int = 0,
) -> list[dict]:
    """Extrai todas as unidades com cache por hash. Com `gleaning=1`, cada Pai de primeira passada válida
    ganha uma rodada extra (`completar`) em `gleaning`; `resposta` segue sendo a primeira passada."""
    if gleaning not in (0, 1):
        raise ValueError("gleaning é 0 ou 1 (ARQUITETURA §5 I-6)")
    cache.mkdir(parents=True, exist_ok=True)

    def uma(u: dict) -> dict:
        r, do_cache = _com_cache(cache / f"{chave_de_cache(u, modelo)}.json", lambda: extrair(u, gera))
        r = {**r, "do_cache": do_cache, "chamadas": 0 if do_cache else r["tentativas"], "gleaning": None}
        tag = "cache" if do_cache else ("ok" if r["valida"] else "INVÁLIDA")
        if gleaning and r["valida"]:
            g, g_cache = _com_cache(
                cache / f"g1_{chave_de_gleaning(u, modelo)}.json", lambda: completar(u, r["resposta"], gera)
            )
            r["gleaning"] = {**g, "do_cache": g_cache, "chamadas": 0 if g_cache else g["tentativas"]}
            tag += "+g" if g["valida"] else "+g INVÁLIDO"
        if log:
            log(f"{u['id']} p. {u['paginas'][0]}: {tag}")
        return {"id": u["id"], "tokens": u["tokens"], "paginas": u["paginas"], **r}

    with ThreadPoolExecutor(max_workers=paralelismo) as pool:
        return list(pool.map(uma, lista))


def final(resultado: dict) -> dict | None:
    """A resposta que vale: a da rodada extra, se houve e foi válida; senão a primeira passada."""
    g = resultado.get("gleaning")
    if g and g["valida"]:
        return g["resposta"]
    return resultado["resposta"] if resultado["valida"] else None


_SUFIXOS = {"s.a.", "s/a", "s.a", "ltda.", "ltda", "sa"}


def _sem_acento(texto: str) -> str:
    d = unicodedata.normalize("NFKD", texto)
    return " ".join("".join(c for c in d if not unicodedata.combining(c)).casefold().split())


def lastro_de_nome(nome: str, texto: str) -> bool:
    """O nome da entidade aparece no texto do Pai (sem acento, caixa nem espaços sobrando)? Também vale o
    nome sem sufixo societário, sem o que vem entre parênteses ou só o que está entre eles (sigla).

    É um teste mecânico e conservador: acusa falta de lastro em nomes que o LLM reescreveu, e deixa passar
    entidade de nome certo e descrição inventada; por isso a leitura dos acréscimos continua sendo manual."""
    t = _sem_acento(texto)
    variantes = {_sem_acento(nome)}
    fora = re.sub(r"\([^)]*\)", " ", nome)
    variantes.add(_sem_acento(fora))
    variantes.update(_sem_acento(m) for m in re.findall(r"\(([^)]+)\)", nome))
    for v in list(variantes):
        palavras = v.split()
        while palavras and palavras[-1] in _SUFIXOS:
            palavras.pop()
            variantes.add(" ".join(palavras))
    return any(v and v in t for v in variantes)


def nomes_repetidos(resposta: dict) -> list[str]:
    """Nomes que aparecem mais de uma vez em `entities` (a regra 2 do prompt os proíbe)."""
    vistos: set[str] = set()
    repetidos: list[str] = []
    for e in resposta["entities"]:
        chave = normalizar_nome(e["name"])
        if chave in vistos:
            repetidos.append(e["name"])
        vistos.add(chave)
    return repetidos


def resumir(resultados: list[dict]) -> dict:
    """Contagens da execução: validade, itens por tipo, força das relações, tokens e tempo."""
    validas = [r["resposta"] for r in resultados if r["valida"]]
    por_tipo = {t: 0 for t in TIPOS_DE_ENTIDADE}
    forcas = {k: 0 for k in range(1, 11)}
    for resp in validas:
        for e in resp["entities"]:
            por_tipo[e["type"]] += 1
        for rel in resp["relationships"]:
            forcas[rel["strength"]] += 1
    ativas = [r for r in resultados if not r["do_cache"]]
    return {
        "unidades": len(resultados),
        "validas": len(validas),
        "validas_na_primeira": sum(r["primeira_valida"] for r in resultados),
        "invalidas": [r["id"] for r in resultados if not r["valida"]],
        "do_cache": sum(r["do_cache"] for r in resultados),
        "chamadas": sum(r["chamadas"] for r in resultados),
        "entidades": sum(len(r["entities"]) for r in validas),
        "relacoes": sum(len(r["relationships"]) for r in validas),
        "entidades_por_tipo": por_tipo,
        "relacoes_por_forca": forcas,
        "nomes_repetidos": sum(len(nomes_repetidos(r)) for r in validas),
        "no_teto_de_entidades": sum(1 for r in validas if len(r["entities"]) >= MAX_ENTIDADES),
        "tokens_prompt": sum(r["tokens_prompt"] for r in ativas),
        "tokens_saida": sum(r["tokens_saida"] for r in ativas),
        "segundos_de_llm": round(sum(r["segundos"] for r in ativas), 1),
    }


def _pct(parte: float, todo: float) -> float | None:
    return round(100 * parte / todo, 1) if todo else None


def resumir_ganho(resultados: list[dict], textos: dict[str, str]) -> dict:
    """O que a rodada de *gleaning* acrescentou sobre a primeira passada, nos Pais em que as duas valeram.

    `textos` mapeia o id do Pai ao que o LLM leu (o pedido), para o lastro mecânico dos nomes
    (`lastro_de_nome`). Os custos são só os das chamadas feitas nesta execução (o cache não conta)."""
    pares = [r for r in resultados if r["valida"] and r.get("gleaning") and r["gleaning"]["valida"]]
    base_e = sum(len(r["resposta"]["entities"]) for r in pares)
    base_r = sum(len(r["resposta"]["relationships"]) for r in pares)
    novas = [(r["id"], e) for r in pares for e in r["gleaning"]["acrescimo"]["entities"]]
    novas_r = sum(len(r["gleaning"]["acrescimo"]["relationships"]) for r in pares)
    sem_lastro_base = sum(
        not lastro_de_nome(e["name"], textos[r["id"]]) for r in pares for e in r["resposta"]["entities"]
    )
    sem_lastro_novas = [(i, e["name"]) for i, e in novas if not lastro_de_nome(e["name"], textos[i])]
    por_tipo = {t: 0 for t in TIPOS_DE_ENTIDADE}
    for _, e in novas:
        por_tipo[e["type"]] += 1
    g_feitas = [r["gleaning"] for r in pares if not r["gleaning"]["do_cache"]]
    b_feitas = [r for r in pares if not r["do_cache"]]
    return {
        "pais_com_as_duas": len(pares),
        "pais_so_primeira_passada": sum(1 for r in resultados if r["valida"] and r not in pares),
        "gleaning_invalido": [
            r["id"] for r in resultados if r.get("gleaning") and not r["gleaning"]["valida"]
        ],
        "pais_que_ganharam_entidade": sum(1 for r in pares if r["gleaning"]["acrescimo"]["entities"]),
        "pais_que_ganharam_relacao": sum(1 for r in pares if r["gleaning"]["acrescimo"]["relationships"]),
        "entidades_primeira": base_e,
        "entidades_acrescentadas": len(novas),
        "ganho_entidades_pct": _pct(len(novas), base_e),
        "relacoes_primeira": base_r,
        "relacoes_acrescentadas": novas_r,
        "ganho_relacoes_pct": _pct(novas_r, base_r),
        "acrescimos_por_tipo": por_tipo,
        "entidades_repetidas_descartadas": sum(
            r["gleaning"]["acrescimo"]["entidades_repetidas"] for r in pares
        ),
        "relacoes_repetidas_descartadas": sum(
            r["gleaning"]["acrescimo"]["relacoes_repetidas"] for r in pares
        ),
        "relacoes_soltas_descartadas": sum(r["gleaning"]["acrescimo"]["relacoes_soltas"] for r in pares),
        "sem_lastro_de_nome_primeira_pct": _pct(sem_lastro_base, base_e),
        "sem_lastro_de_nome_acrescentadas": len(sem_lastro_novas),
        "sem_lastro_de_nome_acrescentadas_pct": _pct(len(sem_lastro_novas), len(novas)),
        "sem_lastro_de_nome_lista": sem_lastro_novas,
        "custo_primeira": {
            "pais": len(b_feitas),
            "tokens_saida": sum(r["tokens_saida"] for r in b_feitas),
            "segundos": round(sum(r["segundos"] for r in b_feitas), 1),
        },
        "custo_gleaning": {
            "pais": len(g_feitas),
            "tokens_prompt": sum(g["tokens_prompt"] for g in g_feitas),
            "tokens_saida": sum(g["tokens_saida"] for g in g_feitas),
            "segundos": round(sum(g["segundos"] for g in g_feitas), 1),
            "chamadas": sum(g["chamadas"] for g in g_feitas),
        },
    }


def _carregar(prefixo: Path) -> dict:
    return json.loads(Path(f"{prefixo}.chunks.json").read_text(encoding="utf-8"))


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    for nome in ("executar", "resumo"):
        p = sub.add_parser(nome)
        p.add_argument("prefixo", type=Path, help="ex.: ../data/parsed/bb_fre_2026_recorte")
        p.add_argument("--amostra", type=int, default=0, help="só N Pais sorteados (0 = todos)")
        p.add_argument("--semente", type=int, default=1)
        p.add_argument(
            "--minimo", type=int, default=MIN_TOKENS_AMOSTRA, help="tokens mínimos dos Pais sorteados"
        )
        p.add_argument("--excluir", nargs="*", default=[], help="ids de Pais que não podem ser sorteados")
        p.add_argument("--saida", default="aberta", help="sufixo do arquivo: <prefixo>.<saida>.json")
        if nome == "executar":
            p.add_argument("--swap", default="http://127.0.0.1:8080")
            p.add_argument("--paralelismo", type=int, default=2)
            p.add_argument("--gleaning", type=int, choices=(0, 1), default=0, help="rodadas extras (0 ou 1)")
    a = ap.parse_args()

    chunks = _carregar(a.prefixo)
    lista = unidades(chunks)
    if a.amostra:
        lista = amostrar(lista, a.amostra, a.semente, a.minimo, tuple(a.excluir))
    destino = Path(f"{a.prefixo}.{a.saida}.json")
    cache = a.prefixo.parent / "aberta_cache"
    if a.acao == "resumo":
        resultados = json.loads(destino.read_text(encoding="utf-8"))
    else:
        resultados = extrair_todas(
            lista,
            gerador_llama(a.swap),
            cache,
            a.paralelismo,
            log=lambda m: print(m, file=sys.stderr, flush=True),
            gleaning=a.gleaning,
        )
        _gravar(destino, resultados)
    resumo = {"primeira_passada": resumir(resultados)}
    if any(r.get("gleaning") for r in resultados):
        # o lastro vale contra o pedido inteiro (documento, seção e trecho): o emissor e os nomes de seção
        # que o LLM vê também são "o que o trecho diz"
        resumo["ganho_do_gleaning"] = resumir_ganho(
            resultados, {u["id"]: u["pedido"] for u in unidades(chunks)}
        )
    print(json.dumps(resumo, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
