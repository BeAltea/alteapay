// D3 — CONTRASTE AA (R-23). Utilitário PURO (sem React/DOM) para escolher a cor de
// TEXTO (#000 ou #fff) que dá o melhor contraste sobre uma cor de fundo do tenant
// (var(--brand-secondary)). Um cedente pode semear um secundário claro; texto branco
// fixo sobre um fundo claro cai abaixo de AA (4.5:1) e o devedor não lê os botões.
// Aqui derivamos a cor de texto ADAPTATIVA por luminância — a saída vira o CSS var
// --brand-secondary-fg, consumido pelos botões de marca (color: var(...)).
//
// Testável no node do vitest (mesmo padrão de wait-machine.ts/chat-display.ts): a
// decisão vive aqui, fora dos componentes/layouts (que só consomem o resultado).

/** Componentes RGB 0..255 (ou null se o hex for inválido/desconhecido). */
export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * Faz o parse de uma cor hex (#rgb, #rrggbb, com/sem #). Retorna null para
 * qualquer formato não reconhecido (ex.: "rgb(...)", nome CSS, vazio) — o chamador
 * cai no default seguro. NÃO lança.
 */
export function parseHexColor(input: string | null | undefined): Rgb | null {
  if (typeof input !== "string") return null
  const hex = input.trim().replace(/^#/, "")
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16)
    const g = parseInt(hex[1] + hex[1], 16)
    const b = parseInt(hex[2] + hex[2], 16)
    return { r, g, b }
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }
  return null
}

/** Luminância relativa WCAG (0..1) de uma cor RGB (fórmula sRGB linearizada). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Razão de contraste WCAG (1..21) entre duas cores. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 }
const WHITE: Rgb = { r: 255, g: 255, b: 255 }

/**
 * Escolhe a cor de TEXTO (#000000 ou #ffffff) com melhor contraste sobre a cor de
 * fundo do tenant. Garante AA (≥4.5:1) sempre que uma das duas atingir — e a
 * escolha é a de MAIOR contraste. Hex inválido/desconhecido → "#ffffff" (mantém o
 * comportamento atual: branco sobre o default #2563eb, ~4.98:1). Determinística.
 */
export function adaptiveTextColor(bgHex: string | null | undefined): "#000000" | "#ffffff" {
  const bg = parseHexColor(bgHex)
  if (!bg) return "#ffffff"
  const withWhite = contrastRatio(bg, WHITE)
  const withBlack = contrastRatio(bg, BLACK)
  return withBlack > withWhite ? "#000000" : "#ffffff"
}
