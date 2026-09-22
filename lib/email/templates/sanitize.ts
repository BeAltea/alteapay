// Sanitizador de HTML por ALLOWLIST (E10 / §5.5).
//
// Aplicado DUAS vezes: na GRAVAÇÃO do template (defesa em profundidade — o que é
// persistido já está limpo) e na RENDERIZAÇÃO (preview/envio — nunca confiar no
// que está no banco). O repo não tem `dompurify`/`sanitize-html`; este é um
// sanitizador de allowlist próprio, sem dependências e testável em Node puro.
//
// Estratégia: allowlist estrita de TAGS e ATRIBUTOS. Tudo fora da lista é
// removido. Protocolos perigosos (`javascript:`, `data:` exceto imagem, `vbscript:`)
// são bloqueados em `href`/`src`. Handlers `on*` são removidos. `<script>`,
// `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>` etc. são descartados
// COM o seu conteúdo (para não deixar corpo de script "solto" no output).

/** Tags permitidas no corpo do e-mail. */
const ALLOWED_TAGS = new Set<string>([
  "html",
  "head",
  "body",
  "table",
  // <tbody> é estrutura de tabela benigna (layout de e-mail table-based). Sem
  // qualquer vetor de script. Adicionada na onda VMAX (G0).
  "tbody",
  "tr",
  "td",
  "div",
  "p",
  "span",
  "a",
  "img",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
])

/** Atributos permitidos (globais — aplicáveis a qualquer tag da allowlist). */
const ALLOWED_ATTRS = new Set<string>([
  "href",
  "src",
  "alt",
  "width",
  "height",
  "style",
  "align",
  "bgcolor",
  "target",
  "rel",
  // Atributos benignos de LAYOUT de e-mail table-based (onda VMAX / G0). Não
  // abrem vetor de script: são só apresentação/estrutura/acessibilidade. Os
  // bloqueios de on*/javascript:/data:não-imagem/@import/expression/<script>
  // continuam intactos.
  "cellpadding",
  "cellspacing",
  "role",
  "valign",
])

/** Tags cujo CONTEÚDO também é descartado (não só a tag). Vetores de execução. */
const DANGEROUS_CONTAINERS = new Set<string>([
  "script",
  "style", // bloco <style> descartado COM conteúdo: o CSS interno (@import,
  // expression(), behavior:, -moz-binding, url() remoto) não era sanitizado.
  // Estilo inline via style="" continua permitido e passa por sanitizeStyle().
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "svg",
  "math",
  "link",
  "meta",
  "base",
  "title",
])

/** Tags vazias (não têm tag de fechamento). */
const VOID_TAGS = new Set<string>(["br", "hr", "img"])

/** Comentários HTML (podem esconder condicionais/CDATA). */
const COMMENT_RE = /<!--[\s\S]*?-->/g

/** Protocolo perigoso em href/src. `data:` só é aceito para imagem (ver abaixo). */
function isDangerousUrl(value: string): boolean {
  const normalized = value
    .replace(/[\u0000-\u0020\u007f-\u009f\s]+/g, "") // remove whitespace/controle (bypass "java\tscript:")
    .toLowerCase()
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:") // tratado à parte para imagem
  )
}

/** `data:` é aceito SOMENTE como imagem embutida (`data:image/...`). */
function isSafeDataImage(value: string): boolean {
  return /^\s*data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value.replace(/\s+/g, ""))
}

/** CSS inline perigoso: `expression()`, `url(javascript:)`, `@import`, etc. */
function sanitizeStyle(value: string): string {
  const lowered = value.toLowerCase()
  if (
    lowered.includes("javascript:") ||
    lowered.includes("expression(") ||
    lowered.includes("vbscript:") ||
    lowered.includes("@import") ||
    /url\(\s*['"]?\s*(javascript|vbscript|data:text)/i.test(value)
  ) {
    return ""
  }
  return value
}

interface ParsedAttr {
  name: string
  value: string
}

/** Faz o parse dos atributos de uma tag (tolerante a aspas simples/duplas/sem aspas). */
function parseAttributes(raw: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = []
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const name = m[1]
    const value = m[3] ?? m[4] ?? m[5] ?? ""
    attrs.push({ name, value })
  }
  return attrs
}

function decodeEntitiesForCheck(value: string): string {
  // Decodifica entidades numéricas/hex simples para pegar `&#106;avascript:`.
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_s, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_s, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
}

function buildAttributes(tag: string, attrs: ParsedAttr[]): string {
  const out: string[] = []
  let isExternalLink = false

  for (const { name, value } of attrs) {
    const lname = name.toLowerCase()

    // Handlers de evento: SEMPRE removidos.
    if (lname.startsWith("on")) continue
    // Atributos que injetam markup/JS.
    if (lname === "srcdoc" || lname === "formaction" || lname === "xlink:href") continue

    if (!ALLOWED_ATTRS.has(lname)) continue

    if (lname === "href" || lname === "src") {
      const decoded = decodeEntitiesForCheck(value)
      if (isDangerousUrl(decoded)) {
        // `data:` só passa se for imagem em <img src>.
        if (lname === "src" && tag === "img" && isSafeDataImage(decoded)) {
          out.push(`src="${escapeAttr(value)}"`)
        }
        // caso contrário: dropar o atributo inteiro (link/imagem fica sem href/src).
        continue
      }
      if (lname === "href" && /^https?:\/\//i.test(decoded.trim())) {
        isExternalLink = true
      }
      out.push(`${lname}="${escapeAttr(value)}"`)
      continue
    }

    if (lname === "style") {
      const clean = sanitizeStyle(value)
      if (clean) out.push(`style="${escapeAttr(clean)}"`)
      continue
    }

    if (lname === "target") {
      out.push(`target="${escapeAttr(value)}"`)
      continue
    }

    out.push(`${lname}="${escapeAttr(value)}"`)
  }

  // Links externos → sempre rel="noopener noreferrer" (evita tabnabbing/leak).
  // Ordem determinística (target, rel) para o sanitizador ser IDEMPOTENTE: um link
  // externo já sanitizado tem target+rel e deve reemitir na mesma ordem.
  if (tag === "a" && isExternalLink) {
    // remove qualquer rel/target que o autor tenha posto e força os seguros.
    const filtered = out.filter((a) => !a.startsWith("rel=") && !a.startsWith("target="))
    filtered.push(`target="_blank"`)
    filtered.push(`rel="noopener noreferrer"`)
    return filtered.join(" ")
  }

  return out.join(" ")
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Sanitiza HTML por allowlist. Retorna HTML seguro (tags/atributos permitidos).
 * Idempotente: sanitizar um output já sanitizado não muda nada.
 */
export function sanitizeEmailHtml(input: string): string {
  if (!input) return ""

  // 1. Remove comentários (podem conter condicionais IE / CDATA / markup oculto).
  let html = input.replace(COMMENT_RE, "")

  // 2. Descarta blocos perigosos COM conteúdo (<script>…</script>, <iframe>…, etc.).
  for (const tag of DANGEROUS_CONTAINERS) {
    const blockRe = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi")
    html = html.replace(blockRe, "")
    // Tag de abertura solta (sem fechamento) — remove a tag de abertura também.
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi")
    html = html.replace(openRe, "")
    const closeRe = new RegExp(`<\\/${tag}\\s*>`, "gi")
    html = html.replace(closeRe, "")
  }

  // 3. Percorre todas as tags restantes e aplica a allowlist.
  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g
  html = html.replace(TAG_RE, (full, rawName: string, rawAttrs: string) => {
    const tag = rawName.toLowerCase()
    const isClosing = full.startsWith("</")

    if (!ALLOWED_TAGS.has(tag)) {
      // Tag desconhecida: remove a TAG mas preserva o texto ao redor (o replace
      // só substitui o `<...>`, o conteúdo entre tags permanece).
      return ""
    }

    if (isClosing) {
      return VOID_TAGS.has(tag) ? "" : `</${tag}>`
    }

    const attrs = parseAttributes(rawAttrs)
    const attrStr = buildAttributes(tag, attrs)
    const selfClose = VOID_TAGS.has(tag) ? " /" : ""
    return attrStr ? `<${tag} ${attrStr}${selfClose}>` : `<${tag}${selfClose}>`
  })

  return html
}

/** Texto simples (fallback) — remove QUALQUER tag e normaliza entidades básicas. */
export function toPlainText(html: string): string {
  return html
    .replace(COMMENT_RE, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
