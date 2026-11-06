"""Guarda-corpos do Text2Cypher (F6.5, ARQUITETURA §7.3).

O Cypher vem de um LLM que lê a pergunta do usuário; logo é entrada não confiável. Quatro barreiras, da
mais barata à mais forte (a última é a que vale mesmo se as outras falharem):

1. **Texto** (`preparar`): sem comentários, uma única consulta, só leitura (`MATCH`, `WITH`, `UNWIND`,
   `RETURN`), sem cláusula de escrita nem de administração, sem procedimento (`CALL nome(...)`) e sem
   `LOAD CSV`; tamanho máximo; sem caracteres de controle; `LIMIT` literal e no máximo `LIMITE_PADRAO`
   (injetado quando falta). Strings e nomes entre crases são mascarados antes de procurar as palavras,
   então `'Set up'` e `` n.`delete` `` passam.
2. **Plano** (`plano_com_escrita`): o `EXPLAIN` não executa, mas mostra os operadores; qualquer `Create`,
   `Merge`, `Delete`, `Set*`, `Remove*`, `Foreach`, `ProcedureCall`, `LoadCSV` ou `EmptyResult` bloqueia.
3. **Sessão `READ` e tempo limite** (em `text2cypher.executar`): o servidor recusa escrita, o que vale mesmo
   que as duas primeiras barreiras tenham um furo.
4. **Teto de linhas**.

Os avisos do `EXPLAIN` sobre rótulo, propriedade ou relação que não existem (`avisos_do_plano`) não
bloqueiam: são a pista do erro mais comum do LLM e alimentam a única autocorreção.

Limites: `UNION` com `LIMIT` no meio é recusado (`limit_invalido`); palavras de escrita usadas como alias ou
variável (`AS set`) são recusadas por segurança.
"""

from __future__ import annotations

import re

LIMITE_PADRAO = 100
MAX_CARACTERES = 4000
INICIOS = {"MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN", "CALL"}
PROIBIDAS = (
    "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "FOREACH", "LOAD", "USE", "SHOW",
    "GRANT", "DENY", "REVOKE", "ALTER", "RENAME", "TERMINATE", "EXPLAIN", "PROFILE", "TRANSACTIONS",
)  # fmt: skip
_PROIBIDAS = re.compile(r"(?<![\w.$`])(" + "|".join(PROIBIDAS) + r")\b", re.IGNORECASE)
_CALL_PROCEDIMENTO = re.compile(r"\bCALL\s+(?!\{)", re.IGNORECASE)
_CONTROLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
OPERADORES_DE_ESCRITA = ("Create", "Merge", "Delete", "DetachDelete", "Set", "Remove", "Foreach",
                         "ProcedureCall", "LoadCSV", "EmptyResult")  # fmt: skip
_DESCONHECIDOS = ("UnknownPropertyKeyWarning", "UnknownLabelWarning", "UnknownRelationshipTypeWarning")


def _limpar(cypher: str) -> tuple[str, str, str | None]:
    """(texto sem comentários, o mesmo com strings e crases mascaradas, erro). O mascarado tem o mesmo
    tamanho do limpo, então posições de um valem para o outro."""
    limpo: list[str] = []
    mascarado: list[str] = []
    i, n = 0, len(cypher)
    while i < n:
        c = cypher[i]
        if c in "'\"`":
            j = i + 1
            while j < n and cypher[j] != c:
                j += 2 if cypher[j] == "\\" and c != "`" else 1
            if j >= n:
                return "", "", "string_aberta"
            limpo.append(cypher[i : j + 1])
            mascarado.append(c + "_" * (j - i - 1) + c)
            i = j + 1
        elif cypher.startswith("//", i):
            j = cypher.find("\n", i)
            i = n if j < 0 else j
            limpo.append(" ")
            mascarado.append(" ")
        elif cypher.startswith("/*", i):
            j = cypher.find("*/", i + 2)
            if j < 0:
                return "", "", "comentario_aberto"
            i = j + 2
            limpo.append(" ")
            mascarado.append(" ")
        else:
            limpo.append(c)
            mascarado.append(c)
            i += 1
    return "".join(limpo), "".join(mascarado), None


def _limit_externo(mascarado: str) -> re.Match | None:
    """O último `LIMIT` fora de parênteses e chaves (o de dentro de subconsulta não limita a saída)."""
    nivel, pos = 0, None
    profundidade = []
    for c in mascarado:
        nivel += c in "({["
        nivel -= c in ")}]"
        profundidade.append(nivel)
    for m in re.finditer(r"\bLIMIT\b", mascarado, re.IGNORECASE):
        if profundidade[m.start()] == 0:
            pos = m
    return pos


def preparar(
    cypher: str, limite: int = LIMITE_PADRAO, max_caracteres: int = MAX_CARACTERES
) -> tuple[str | None, str | None]:
    """(consulta pronta para o `EXPLAIN`, None) ou (None, motivo). Motivos: vazia, muito_longa,
    caractere_de_controle, string_aberta, comentario_aberto, varios_comandos, sem_leitura, incompleta,
    clausula_proibida:X, procedimento_proibido, limit_invalido."""
    if not (cypher or "").strip():
        return None, "vazia"
    if len(cypher) > max_caracteres:
        return None, "muito_longa"
    if _CONTROLE.search(cypher):
        return None, "caractere_de_controle"
    limpo, mascarado, erro = _limpar(cypher)
    if erro:
        return None, erro
    limpo, mascarado = limpo.strip(), mascarado.strip()
    while mascarado.endswith(";"):
        limpo, mascarado = limpo[:-1].rstrip(), mascarado[:-1].rstrip()
    if ";" in mascarado:
        return None, "varios_comandos"
    achado = _PROIBIDAS.search(mascarado)  # primeiro o perigo: é o motivo que o log deve mostrar
    if achado:
        return None, f"clausula_proibida:{achado.group(1).upper()}"
    if _CALL_PROCEDIMENTO.search(mascarado):
        return None, "procedimento_proibido"
    tokens = re.findall(r"[A-Za-z_]+", mascarado)
    if not tokens or tokens[0].upper() not in INICIOS:
        return None, "sem_leitura"
    if len(tokens) < 2 or not re.search(r"\bRETURN\b|\bWITH\b|\bCALL\b", mascarado, re.IGNORECASE):
        return None, "incompleta"
    m = _limit_externo(mascarado)
    if m is None:
        return f"{limpo} LIMIT {limite}", None
    valor = re.fullmatch(r"\s*(\d+)\s*", mascarado[m.end() :])
    if not valor:
        return None, "limit_invalido"
    if int(valor.group(1)) > limite:
        limpo = f"{limpo[: m.end()]} {limite}"
    return limpo, None


def plano_com_escrita(plano: dict | None) -> str | None:
    """Motivo se algum operador do plano do `EXPLAIN` escreve ou chama procedimento; senão None."""
    if not plano:
        return None
    nome = str(plano.get("operatorType", "")).split("@")[0]
    if nome.startswith(OPERADORES_DE_ESCRITA):
        return f"plano_com_escrita:{nome}"
    for filho in plano.get("children") or []:
        achado = plano_com_escrita(filho)
        if achado:
            return achado
    return None


def avisos_do_plano(notificacoes: list | None) -> tuple[list[str], list[str]]:
    """(rótulo/propriedade/relação que não existem, outros avisos como produto cartesiano)."""
    desconhecidos: list[str] = []
    outros: list[str] = []
    for n in notificacoes or []:
        codigo = str(n.get("code", ""))
        texto = str(n.get("description") or n.get("title") or codigo)[:240]
        (desconhecidos if any(d in codigo for d in _DESCONHECIDOS) else outros).append(texto)
    return desconhecidos, outros
