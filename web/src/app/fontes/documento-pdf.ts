import { Injectable } from '@angular/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type Pdfjs = typeof import('pdfjs-dist');

/**
 * O PDF original do Formulário de Referência (`GET /api/documento/pdf`), aberto uma vez por sessão com pdf.js. A biblioteca só
 * é baixada quando alguém abre uma página citada (chunk à parte). O arquivo vem em faixas (`Range`) da própria API: nada de
 * rede externa, e o worker, as fontes padrão e os mapas de caracteres são servidos pelo próprio app (`/pdfjs/`).
 */
@Injectable({ providedIn: 'root' })
export class DocumentoPdf {
  private aberto: Promise<{ biblioteca: Pdfjs; documento: PDFDocumentProxy }> | null = null;

  /** Abre (ou reaproveita) o documento. Se falhar, a próxima chamada tenta de novo. */
  abrir(): Promise<{ biblioteca: Pdfjs; documento: PDFDocumentProxy }> {
    this.aberto ??= this.carregar().catch((erro: unknown) => {
      this.aberto = null;
      throw erro;
    });
    return this.aberto;
  }

  private async carregar(): Promise<{ biblioteca: Pdfjs; documento: PDFDocumentProxy }> {
    const biblioteca = await import('pdfjs-dist');
    const base = new URL('pdfjs/', document.baseURI).href;
    biblioteca.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
    const documento = await biblioteca.getDocument({
      url: new URL('api/documento/pdf', document.baseURI).href,
      rangeChunkSize: 65536,
      standardFontDataUrl: `${base}standard_fonts/`,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      wasmUrl: `${base}wasm/`,
      iccUrl: `${base}iccs/`,
    }).promise;
    return { biblioteca, documento };
  }
}
