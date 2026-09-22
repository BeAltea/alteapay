// Render de PREVIEW (dados fictícios + sanitização). O HTML resultante é servido
// dentro de um `iframe sandbox` SEM allow-scripts (§5.3): mesmo que algo escape
// da sanitização, o iframe não executa script nem navega a janela do painel.

import { sanitizeEmailHtml } from "./sanitize"
import { renderVariables, PREVIEW_SAMPLE } from "./variables"

/**
 * Constrói o HTML do preview:
 *   1. injeta o pré-header (oculto, como no e-mail real);
 *   2. renderiza as variáveis com DADOS FICTÍCIOS (nunca PII);
 *   3. sanitiza de novo (defesa em profundidade na renderização).
 * A ordem (render → sanitize) garante que valores injetados também passam pelo
 * sanitizador, então nem a substituição pode introduzir markup perigoso.
 */
export function buildPreviewHtml(parts: { subject: string; preheader: string; html: string }): string {
  const rendered = renderVariables(parts.html, PREVIEW_SAMPLE)
  const sanitized = sanitizeEmailHtml(rendered)

  const preheader = parts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(
        renderVariables(parts.preheader, PREVIEW_SAMPLE),
      )}</div>`
    : ""

  // Envolve num documento mínimo; o iframe pai já é sandbox sem scripts.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">${preheader}${sanitized}</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
