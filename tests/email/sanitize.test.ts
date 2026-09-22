// Testes do sanitizador de HTML por allowlist (E10 / §5.5).
// Prova que os vetores clássicos são NEUTRALIZADOS e que o HTML legítimo passa.
import { describe, it, expect } from "vitest"
import { sanitizeEmailHtml, toPlainText } from "@/lib/email/templates/sanitize"

describe("sanitizeEmailHtml — remove vetores de execução", () => {
  it("remove <script> e o seu conteúdo", () => {
    const out = sanitizeEmailHtml('<p>oi</p><script>alert(1)</script>')
    expect(out.toLowerCase()).not.toContain("<script")
    expect(out).not.toContain("alert(1)")
    expect(out).toContain("<p>oi</p>")
  })

  it("remove <script> mesmo com atributos/espacos/maiusculas", () => {
    const out = sanitizeEmailHtml('<SCRIPT type="text/javascript">evil()</SCRIPT>')
    expect(out.toLowerCase()).not.toContain("script")
    expect(out).not.toContain("evil()")
  })

  it("remove handlers on* (onerror, onclick, onload)", () => {
    const out = sanitizeEmailHtml('<img src="x" onerror="alert(1)"><div onclick="steal()">x</div>')
    expect(out.toLowerCase()).not.toContain("onerror")
    expect(out.toLowerCase()).not.toContain("onclick")
    expect(out).not.toContain("alert(1)")
    expect(out).not.toContain("steal()")
  })

  it("bloqueia href=javascript:", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">clique</a>')
    expect(out.toLowerCase()).not.toContain("javascript:")
    // o link fica sem href, mas o texto permanece
    expect(out).toContain("clique")
  })

  it("bloqueia javascript: ofuscado com entidades e whitespace", () => {
    const out = sanitizeEmailHtml('<a href="ja\tvascript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain("javascript:")
    const out2 = sanitizeEmailHtml('<a href="&#106;avascript:alert(1)">x</a>')
    // após decodificar &#106; = 'j' → detecta javascript: e dropa o href
    expect(out2).not.toMatch(/href=/i)
  })

  it("remove <iframe>, <object>, <embed>", () => {
    const out = sanitizeEmailHtml('<iframe src="evil"></iframe><object data="x"></object><embed src="y">')
    expect(out.toLowerCase()).not.toContain("iframe")
    expect(out.toLowerCase()).not.toContain("object")
    expect(out.toLowerCase()).not.toContain("embed")
  })

  it("bloqueia data: exceto imagem em <img>", () => {
    const script = sanitizeEmailHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(script.toLowerCase()).not.toContain("data:text")
    const img = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(img).toContain("data:image/png;base64")
  })

  it("neutraliza CSS inline perigoso (expression, url(javascript:))", () => {
    const out = sanitizeEmailHtml('<div style="width:expression(alert(1));color:red">x</div>')
    expect(out.toLowerCase()).not.toContain("expression(")
    const out2 = sanitizeEmailHtml('<div style="background:url(javascript:alert(1))">x</div>')
    expect(out2.toLowerCase()).not.toContain("javascript:")
  })

  it("força rel=noopener noreferrer em links externos", () => {
    const out = sanitizeEmailHtml('<a href="https://exemplo.com">ext</a>')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it("preserva tags e atributos da allowlist", () => {
    const html =
      '<table><tr><td style="align:center"><strong>Oi</strong> <a href="https://a.com/n/x">link</a></td></tr></table>'
    const out = sanitizeEmailHtml(html)
    expect(out).toContain("<table>")
    expect(out).toContain("<strong>")
    expect(out).toContain('href="https://a.com/n/x"')
  })

  it("remove tags fora da allowlist mas preserva o texto interno", () => {
    const out = sanitizeEmailHtml("<marquee>corre</marquee><form>x</form>")
    expect(out.toLowerCase()).not.toContain("marquee")
    expect(out.toLowerCase()).not.toContain("<form")
    expect(out).toContain("corre")
  })

  it("é idempotente (sanitizar o output não muda nada)", () => {
    const html = '<p>oi <a href="https://x.com">y</a></p><script>bad()</script>'
    const once = sanitizeEmailHtml(html)
    const twice = sanitizeEmailHtml(once)
    expect(twice).toBe(once)
  })

  // Regressão: <style> era allowlisted mas o CONTEÚDO do bloco nunca passava por
  // sanitizeStyle → @import/expression()/url() remoto vazavam (exfil/execução).
  it("descarta o bloco <style> COM o conteúdo (@import/expression não vazam)", () => {
    const out = sanitizeEmailHtml(
      '<style>@import url("https://evil.example/x.css");div{width:expression(alert(1))}</style><p>oi</p>',
    )
    expect(out.toLowerCase()).not.toContain("<style")
    expect(out.toLowerCase()).not.toContain("@import")
    expect(out.toLowerCase()).not.toContain("expression(")
    expect(out).toContain("<p>oi</p>")
  })

  // Regressão: o range antigo [\x00-\x1f\s] não removia DEL (0x7F), deixando
  // "\x7Fjavascript:" sobreviver à normalização de URL.
  it("bloqueia javascript: precedido de DEL (0x7F)", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain("javascript:")
    expect(out).not.toMatch(/href=/i)
  })
})

// Onda VMAX (G0): atributos/tag benignos de layout de e-mail table-based.
describe("sanitizeEmailHtml — layout de e-mail (onda VMAX)", () => {
  it("PRESERVA cellpadding, cellspacing, role, valign e <tbody>", () => {
    const html =
      '<table role="presentation" cellpadding="0" cellspacing="0">' +
      '<tbody><tr><td valign="top">Oi</td></tr></tbody></table>'
    const out = sanitizeEmailHtml(html)
    expect(out).toContain('role="presentation"')
    expect(out).toContain('cellpadding="0"')
    expect(out).toContain('cellspacing="0"')
    expect(out).toContain('valign="top"')
    expect(out.toLowerCase()).toContain("<tbody>")
    expect(out.toLowerCase()).toContain("</tbody>")
    expect(out).toContain("Oi")
  })

  it("os novos atributos NÃO reabrem vetor de script (on*/javascript: continuam removidos)", () => {
    const html =
      '<table role="presentation" cellpadding="0" onmouseover="steal()">' +
      '<tbody onload="x()"><tr><td valign="top"><a href="javascript:evil()">z</a></td></tr></tbody></table>'
    const out = sanitizeEmailHtml(html)
    expect(out).toContain('role="presentation"')
    expect(out).toContain('cellpadding="0"')
    expect(out.toLowerCase()).not.toContain("onmouseover")
    expect(out.toLowerCase()).not.toContain("onload")
    expect(out).not.toContain("steal()")
    expect(out).not.toContain("x()")
    expect(out.toLowerCase()).not.toContain("javascript:")
  })

  it("<script> continua descartado mesmo dentro de <tbody>", () => {
    const out = sanitizeEmailHtml("<table><tbody><tr><td>ok</td></tr></tbody></table><script>bad()</script>")
    expect(out.toLowerCase()).not.toContain("<script")
    expect(out).not.toContain("bad()")
    expect(out).toContain("ok")
  })

  it("continua idempotente com os novos atributos/tag", () => {
    const html =
      '<table role="presentation" cellpadding="0" cellspacing="0"><tbody><tr><td valign="middle">x</td></tr></tbody></table>'
    const once = sanitizeEmailHtml(html)
    expect(sanitizeEmailHtml(once)).toBe(once)
  })
})

describe("toPlainText", () => {
  it("remove tags e <style>/<head>", () => {
    const txt = toPlainText('<html><head><style>p{color:red}</style></head><body><p>Olá &amp; bem-vindo</p></body></html>')
    expect(txt).not.toContain("<")
    expect(txt).not.toContain("color:red")
    expect(txt).toContain("Olá & bem-vindo")
  })
})
