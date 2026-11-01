# Política de segurança

Este projeto roda 100% local (llama.cpp, llama-swap e Neo4j escutam só em `127.0.0.1`) e não tem versão em produção. Mesmo assim, falhas são bem-vindas.

## Como relatar

Use o relato privado do GitHub: aba **Security** → **Report a vulnerability**. Não abra issue pública com detalhes de uma falha, e nunca cole chaves, senhas ou trechos de documentos confidenciais em issues.

## O que o repositório nunca contém

- `.env`, chaves, tokens e senhas (o `.gitignore` os barra; `.env.example` traz só valores fictícios);
- modelos (`.gguf`, `.safetensors`) e a pasta `data/`, que guarda o documento processado e o grafo;
- trechos do documento-fonte além do necessário (veja o ADR-009).
