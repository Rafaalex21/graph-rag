import json, sys, re
import pypdfium2 as pdfium
pdf = pdfium.PdfDocument(r"C:\Users\Rafael\Documents\Graph Rag\data\raw\banco_do_brasil_formulario_referencia_2026.pdf")
chaves = {
 "caixa operacional 2025": r"159\.254 milhões",
 "empréstimo NDB": r"New Development Bank \(NDB\), no valor de US\$ 200 milhões",
 "programa de integridade criado": r"Criado em 2017, o Programa de Compliance e Integridade",
 "auditor KPMG": r"KPMG Auditores Independentes",
 "processos CGU 2023": r"Em 2023, quatro processos foram julgados",
}
texto = {}
for i in range(len(pdf)):
    texto[i + 1] = re.sub(r"\s+", " ", pdf[i].get_textpage().get_text_range())
out = {}
for nome, rx in chaves.items():
    paginas = [p for p, t in texto.items() if re.search(rx, t)]
    out[nome] = paginas
    print(nome, "->", paginas)
json.dump(out, open(r"C:\Users\Rafael\Documents\Graph Rag\docs\adr\ADR-026-gold_paginas.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
