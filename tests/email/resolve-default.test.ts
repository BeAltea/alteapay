// F4 — resolver do template padrão de negociação por e-mail + render.
//   - cadeia de fallback: cedente > global > builtin;
//   - render substitui as variáveis da allowlist e RE-SANITIZA;
//   - variável proibida no template → cai no builtin (com aviso);
//   - template sem os links obrigatórios → não é escolhido / cai no builtin.
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Fake service client mínimo: tabelas email_template_defaults / email_templates
// / email_template_versions em memória. Suporta eq/is/neq/order/maybeSingle e o
// then() de leitura em lista (para resolveGlobalDefault).
// ---------------------------------------------------------------------------
type Row = Record<string, any>
interface DB {
  email_template_defaults: Row[]
  email_templates: Row[]
  email_template_versions: Row[]
}
let db: DB

interface F { op: "eq" | "is" | "neq"; col: string; val: any }
class QB {
  filters: F[] = []
  constructor(private t: keyof DB) {}
  select() { return this }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this }
  is(col: string, val: any) { this.filters.push({ op: "is", col, val }); return this }
  neq(col: string, val: any) { this.filters.push({ op: "neq", col, val }); return this }
  order() { return this }
  private match(r: Row, f: F): boolean {
    const v = r[f.col]
    switch (f.op) {
      case "eq": return v === f.val
      case "is": return f.val === null ? v == null : v === f.val
      case "neq": return v !== f.val
    }
  }
  private filtered(): Row[] {
    return (db[this.t] ?? []).filter((r) => this.filters.every((f) => this.match(r, f)))
  }
  async maybeSingle() { return { data: this.filtered()[0] ?? null, error: null } }
  async single() { const d = this.filtered()[0]; return { data: d ?? null, error: d ? null : { message: "no rows" } } }
  then(res: (r: { data: Row[]; error: null }) => void) { res({ data: this.filtered(), error: null }) }
}
const fakeClient = { from: (t: keyof DB) => new QB(t) } as any

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeClient }))

const CO = "co-1"
const BUILTIN = { firstName: "Maria", brandName: "AlteaPay", creditorName: "VMAX", link: "https://app/n/abc" }

// html de negociação VÁLIDO (traz os dois links obrigatórios + primeiro_nome/credor).
const VALID_HTML =
  '<p>Olá {{primeiro_nome}} da {{credor}}</p>' +
  '<p><a href="{{link_negociacao}}">negociar</a></p>' +
  '<p><a href="{{link_descadastro}}">sair</a></p>'

function seedTemplate(over: Partial<Row>, version: Partial<Row>): { templateId: string; versionId: string } {
  const templateId = over.id ?? `tpl_${db.email_templates.length + 1}`
  const versionId = version.id ?? `ver_${db.email_template_versions.length + 1}`
  db.email_template_versions.push({
    id: versionId,
    template_id: templateId,
    subject: "Olá {{primeiro_nome}}",
    preheader: "",
    html: VALID_HTML,
    text_fallback: "Negocie: {{link_negociacao}} — sair: {{link_descadastro}}",
    ...version,
  })
  db.email_templates.push({
    id: templateId,
    company_id: null,
    name: "T",
    purpose: "negotiation",
    status: "active",
    current_version_id: versionId,
    updated_at: "2026-01-01",
    ...over,
  })
  return { templateId, versionId }
}

beforeEach(() => {
  db = { email_template_defaults: [], email_templates: [], email_template_versions: [] }
})

describe("resolveNegotiationTemplate — cadeia de fallback", () => {
  it("escolhe o padrão do CEDENTE quando existe", async () => {
    const { templateId, versionId } = seedTemplate(
      { id: "tpl_cedente", company_id: CO, name: "Cedente", updated_at: "2026-02-01" },
      { id: "ver_cedente" },
    )
    // também há um global, mas o do cedente tem precedência.
    seedTemplate({ id: "tpl_global", company_id: null, name: "Global" }, { id: "ver_global" })
    db.email_template_defaults.push({ company_id: CO, template_id: templateId, purpose: "negotiation" })

    const { resolveNegotiationTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = await resolveNegotiationTemplate(CO, BUILTIN)
    expect(r.source).toBe("cedente")
    expect(r.templateId).toBe("tpl_cedente")
    expect(r.versionId).toBe(versionId)
    expect(r.name).toBe("Cedente")
  })

  it("cai no GLOBAL quando o cedente não tem padrão", async () => {
    seedTemplate({ id: "tpl_global", company_id: null, name: "Global" }, { id: "ver_global" })
    const { resolveNegotiationTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = await resolveNegotiationTemplate(CO, BUILTIN)
    expect(r.source).toBe("global")
    expect(r.templateId).toBe("tpl_global")
  })

  it("cai no BUILTIN quando não há cedente nem global", async () => {
    const { resolveNegotiationTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = await resolveNegotiationTemplate(CO, BUILTIN)
    expect(r.source).toBe("builtin")
    expect(r.templateId).toBeUndefined()
    expect(r.html).toContain(BUILTIN.link) // corpo embutido com o link do hub
  })

  it("padrão do cedente ARQUIVADO é ignorado (cai no global)", async () => {
    const { templateId } = seedTemplate(
      { id: "tpl_arq", company_id: CO, name: "Arq", status: "archived" },
      { id: "ver_arq" },
    )
    seedTemplate({ id: "tpl_global", company_id: null, name: "Global" }, { id: "ver_global" })
    db.email_template_defaults.push({ company_id: CO, template_id: templateId, purpose: "negotiation" })
    const { resolveNegotiationTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = await resolveNegotiationTemplate(CO, BUILTIN)
    expect(r.source).toBe("global")
  })

  it("template sem os links obrigatórios não é escolhido (cai no builtin)", async () => {
    // global cujo corpo perdeu o {{link_descadastro}} → inválido como negociação.
    seedTemplate(
      { id: "tpl_ruim", company_id: null, name: "Ruim" },
      { id: "ver_ruim", html: "<p>Olá {{primeiro_nome}} <a href='{{link_negociacao}}'>x</a></p>", text_fallback: "" },
    )
    const { resolveNegotiationTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = await resolveNegotiationTemplate(CO, BUILTIN)
    expect(r.source).toBe("builtin")
  })
})

describe("resolveNegotiationTemplateInfo — só fonte + nome (para preview)", () => {
  it("reporta a fonte certa (cedente)", async () => {
    const { templateId } = seedTemplate({ id: "tpl_c", company_id: CO, name: "Meu Convite" }, { id: "ver_c" })
    db.email_template_defaults.push({ company_id: CO, template_id: templateId, purpose: "negotiation" })
    const { resolveNegotiationTemplateInfo } = await import("@/lib/email/templates/resolve-default")
    const info = await resolveNegotiationTemplateInfo(CO)
    expect(info.source).toBe("cedente")
    expect(info.name).toBe("Meu Convite")
  })

  it("builtin quando não há padrão: nome = 'Convite padrão AlteaPay'", async () => {
    const { resolveNegotiationTemplateInfo } = await import("@/lib/email/templates/resolve-default")
    const info = await resolveNegotiationTemplateInfo(CO)
    expect(info.source).toBe("builtin")
    expect(info.name).toBe("Convite padrão AlteaPay")
  })
})

describe("renderTemplate — substituição + re-sanitização", () => {
  const RESOLVED = {
    source: "cedente" as const,
    templateId: "t1",
    versionId: "v1",
    subject: "Olá {{primeiro_nome}}",
    preheader: "",
    html: VALID_HTML,
    text: "Negocie: {{link_negociacao}} — sair: {{link_descadastro}} — {{marca}} {{ano}}",
  }
  const VARS = {
    primeiro_nome: "João",
    credor: "VMAX",
    marca: "AlteaPay",
    link_negociacao: "https://app/n/xyz",
    link_descadastro: "https://app/n/xyz",
    contato_suporte: "suporte@alteapay.com",
    ano: "2026",
  }

  it("substitui as variáveis da allowlist no subject/html/text", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = renderTemplate(RESOLVED, VARS, BUILTIN)
    expect(r.ok).toBe(true)
    expect(r.fellBackToBuiltin).toBeFalsy()
    expect(r.subject).toBe("Olá João")
    expect(r.html).toContain("João")
    expect(r.html).toContain("https://app/n/xyz")
    expect(r.text).toContain("AlteaPay 2026")
  })

  it("RE-SANITIZA na renderização (remove <script> vindo do banco)", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const dirty = { ...RESOLVED, html: VALID_HTML + "<script>bad()</script>" }
    const r = renderTemplate(dirty, VARS, BUILTIN)
    expect(r.ok).toBe(true)
    expect(r.html.toLowerCase()).not.toContain("<script")
  })

  it("não injeta variável fora da allowlist (valor do débito é ignorado no map)", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    // mesmo que o chamador passe uma chave proibida, ela NÃO entra no render.
    const r = renderTemplate(RESOLVED, { ...VARS, valor_divida: "R$ 999" } as any, BUILTIN)
    expect(r.html).not.toContain("999")
  })

  it("variável PROIBIDA no template persistido → cai no builtin com aviso", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const bad = { ...RESOLVED, html: VALID_HTML + "<p>{{valor_divida}}</p>" }
    const r = renderTemplate(bad, VARS, BUILTIN)
    expect(r.ok).toBe(true)
    expect(r.fellBackToBuiltin).toBe(true)
    expect(r.reason).toBe("variavel_proibida")
    // o corpo entregue é o builtin (com o link do hub), sem o token proibido.
    expect(r.html).toContain(BUILTIN.link)
    expect(r.html).not.toContain("valor_divida")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("template que perdeu os links obrigatórios → cai no builtin", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const noLinks = { ...RESOLVED, html: "<p>Olá {{primeiro_nome}}</p>", text: "" }
    const r = renderTemplate(noLinks, VARS, BUILTIN)
    expect(r.fellBackToBuiltin).toBe(true)
    expect(r.reason).toBe("sem_links")
    warn.mockRestore()
  })

  it("builtin puro passa direto (sem tokens) e é sanitizado", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const builtinResolved = {
      source: "builtin" as const,
      subject: "Negociação disponível - VMAX",
      preheader: "",
      html: "<p>convite</p>",
      text: "",
    }
    const r = renderTemplate(builtinResolved, VARS)
    expect(r.ok).toBe(true)
    expect(r.fellBackToBuiltin).toBeFalsy()
    expect(r.html).toContain("convite")
  })
})

// ===========================================================================
// D1 — injeção do contexto de DÉBITO (allow_debt_fields) + escape + sweep.
// ===========================================================================

const DEBT_HTML =
  "<p>Olá {{nome_cliente}} ({{documento_mascarado}})</p>" +
  "<p>Valor {{valor_divida}}, venceu em {{vencimento_original}}, {{qtd_faturas}} fatura(s).</p>" +
  '<p><a href="{{link_negociacao}}">negociar</a> <a href="{{link_descadastro}}">sair</a></p>'

const DEBT_CTX = {
  nome_cliente: "Jose Da Silva",
  primeiro_nome: "Jose",
  documento_mascarado: "***.444.777-**",
  valor_divida: "R$ 199,80",
  vencimento_original: "15/04/2026",
  qtd_faturas: "1",
}

describe("renderTemplate — dados do débito (allow_debt_fields)", () => {
  const RESOLVED_DEBT = {
    source: "cedente" as const,
    templateId: "t1",
    versionId: "v1",
    allowDebtFields: true,
    subject: "Olá {{primeiro_nome}}",
    preheader: "",
    html: DEBT_HTML,
    text: "Valor {{valor_divida}} — {{link_negociacao}} — {{link_descadastro}}",
  }
  const VARS = {
    primeiro_nome: "João",
    credor: "VMAX",
    marca: "AlteaPay",
    link_negociacao: "https://app/n/xyz",
    link_descadastro: "https://app/n/xyz",
    contato_suporte: "suporte@alteapay.com",
    ano: "2026",
  }

  it("injeta as 5 DEBT vars quando o template permite E há debtCtx", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const r = renderTemplate(RESOLVED_DEBT, VARS, BUILTIN, DEBT_CTX)
    expect(r.ok).toBe(true)
    expect(r.fellBackToBuiltin).toBeFalsy()
    expect(r.html).toContain("Jose Da Silva")
    expect(r.html).toContain("***.444.777-**")
    expect(r.html).toContain("R$ 199,80")
    expect(r.html).toContain("15/04/2026")
    expect(r.variableGroups).toEqual(["basic", "debt"])
    // sem token remanescente
    expect(r.html).not.toContain("{{")
  })

  it("FALHA FECHADA (render_incomplete) quando allow_debt_fields mas SEM debtCtx", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = renderTemplate(RESOLVED_DEBT, VARS, BUILTIN /* sem debtCtx */)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("render_incomplete")
    // NUNCA renderiza {{valor_divida}} nem cai no builtin com campos vazios.
    expect(r.html).toBe("")
    warn.mockRestore()
  })

  it("HTML-ESCAPA os valores de débito interpolados (nome com < > &)", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const evil = { ...DEBT_CTX, nome_cliente: 'Jose <b>x</b> & "Cia"' }
    const r = renderTemplate(RESOLVED_DEBT, VARS, BUILTIN, evil)
    expect(r.ok).toBe(true)
    // o markup do nome não vira tag real
    expect(r.html).not.toContain("<b>x</b>")
    expect(r.html).toContain("&lt;b&gt;")
  })

  it("varredura final: token {{...}} remanescente no corpo → render_incomplete", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // template de débito que referencia uma DEBT var que o debtCtx não cobre não
    // é possível (o ctx cobre as 5); simulamos um token literal não-variável.
    const withStray = { ...RESOLVED_DEBT, html: DEBT_HTML + "<p>{{sobrou}}</p>" }
    const r = renderTemplate(withStray, VARS, BUILTIN, DEBT_CTX)
    // {{sobrou}} não é básica nem débito → cai antes no guard de variável proibida
    // (fellBackToBuiltin) OU no sweep. Em ambos os casos NÃO envia o token cru.
    expect(r.html).not.toContain("{{sobrou}}")
    warn.mockRestore()
  })

  it("template SEM allow_debt_fields ignora o debtCtx e barra DEBT var (proibida)", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const noFlag = { ...RESOLVED_DEBT, allowDebtFields: false }
    const r = renderTemplate(noFlag, VARS, BUILTIN, DEBT_CTX)
    // DEBT var num template sem a flag → variável fora da allowlist → builtin.
    expect(r.fellBackToBuiltin).toBe(true)
    expect(r.reason).toBe("variavel_proibida")
    expect(r.html).not.toContain("Jose Da Silva")
    warn.mockRestore()
  })

  it("só básicas quando não há debtCtx e o template não é de débito → variableGroups=['basic']", async () => {
    const { renderTemplate } = await import("@/lib/email/templates/resolve-default")
    const basic = {
      source: "cedente" as const,
      templateId: "t1",
      versionId: "v1",
      allowDebtFields: false,
      subject: "Olá {{primeiro_nome}}",
      preheader: "",
      html: VALID_HTML,
      text: "Negocie: {{link_negociacao}} — {{link_descadastro}}",
    }
    const r = renderTemplate(basic, VARS, BUILTIN)
    expect(r.ok).toBe(true)
    expect(r.variableGroups).toEqual(["basic"])
  })
})
