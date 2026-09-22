// Testes de rota do CRUD de templates de e-mail (F3):
//  - gate de super_admin (401/403);
//  - preview sanitiza e avisa sobre variáveis proibidas;
//  - POST create rejeita (422) template com variável proibida e cria (201) válido;
//  - negotiation sem os links é rejeitado.
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---- fake service client mínimo p/ o repository (create) ----
// Guarda inserts em memória e devolve linhas plausíveis.
let inserted: Record<string, any[]> = {}

function fakeServiceClient() {
  return {
    from(table: string) {
      const state: any = { table, _insert: null, _eq: {} }
      const qb: any = {
        select() {
          return qb
        },
        eq(col: string, val: any) {
          state._eq[col] = val
          return qb
        },
        neq() {
          return qb
        },
        is() {
          return qb
        },
        in() {
          return qb
        },
        order() {
          return qb
        },
        limit() {
          return qb
        },
        range() {
          return qb
        },
        insert(row: any) {
          state._insert = row
          return qb
        },
        update(row: any) {
          state._update = row
          return qb
        },
        upsert() {
          return qb
        },
        async single() {
          if (state._insert) {
            const id = `${table}-${(inserted[table]?.length ?? 0) + 1}`
            const row = { id, ...state._insert }
            inserted[table] = [...(inserted[table] ?? []), row]
            return { data: row, error: null }
          }
          if (state._update) return { data: { id: state._eq.id ?? "x", ...state._update }, error: null }
          return { data: null, error: null }
        },
        async maybeSingle() {
          return { data: null, error: null }
        },
        then(res: (r: { data: any[]; error: null }) => void) {
          res({ data: [], error: null })
        },
      }
      return qb
    },
  }
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeServiceClient() }))

// auth mutável por teste
let ROLE: string | null = "super_admin"
let USER: { id: string } | null = { id: "admin-1" }
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: USER }, error: USER ? null : new Error("no user") }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: ROLE ? { role: ROLE } : null, error: null }) }) }),
    }),
  }),
}))

function makeRequest(body: unknown, url = "http://localhost/api"): any {
  return { json: async () => body, url }
}
async function call(handler: (req: any) => Promise<any>, body: unknown, url?: string) {
  const res = await handler(makeRequest(body, url))
  return { status: res.status, json: () => res.json() }
}

beforeEach(() => {
  vi.resetModules()
  inserted = {}
  ROLE = "super_admin"
  USER = { id: "admin-1" }
})

describe("gate de super_admin", () => {
  it("POST sem usuário → 401", async () => {
    USER = null
    const { POST } = await import("@/app/api/super-admin/email-templates/route")
    const res = await call(POST, {})
    expect(res.status).toBe(401)
  })

  it("POST com role != super_admin → 403", async () => {
    ROLE = "admin"
    const { POST } = await import("@/app/api/super-admin/email-templates/route")
    const res = await call(POST, {})
    expect(res.status).toBe(403)
  })
})

describe("preview", () => {
  it("sanitiza e avisa sobre variável proibida", async () => {
    const { POST } = await import("@/app/api/super-admin/email-templates/preview/route")
    const res = await call(POST, {
      subject: "s",
      preheader: "",
      html: "<p>Olá {{primeiro_nome}} {{valor_divida}}</p><script>bad()</script>",
      purpose: "communication",
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.previewHtml.toLowerCase()).not.toContain("<script")
    expect(data.canSave).toBe(false)
    // purpose=communication → variável de débito nunca é permitida (dois níveis)
    expect(data.warnings.join(" ")).toMatch(/dado do débito/i)
  })

  // Regressão: o preview do template de cobrança da VMAX (allow_debt_fields=true +
  // negotiation + variáveis de débito) NÃO pode lançar NEM acusar as DEBT vars como
  // proibidas quando o GATE está aberto — era a causa da página de e-mails quebrar
  // (o editor não enviava allowDebtFields, o gate ficava fechado e o painel virava
  // um mar de "variável proibida"). Passa o gate → sem aviso de débito, canSave ok.
  it("VMAX (allow_debt_fields + negotiation + debt vars): não lança e não acusa débito", async () => {
    const { POST } = await import("@/app/api/super-admin/email-templates/preview/route")
    const res = await call(POST, {
      subject: "{{credor}}: regularize sua pendência",
      preheader: "Comunicação oficial",
      html:
        "<p>Olá {{nome_cliente}}</p><p>{{documento_mascarado}} — {{valor_divida}} — {{vencimento_original}}</p>" +
        '<p>{{qtd_faturas}}</p><a href="{{link_negociacao}}">Negociar</a>' +
        '<a href="{{link_descadastro}}">Sair</a>',
      textFallback: "{{nome_cliente}} {{valor_divida}} {{link_negociacao}} {{link_descadastro}}",
      purpose: "negotiation",
      allowDebtFields: true,
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    // Sem exceção: preview renderizado.
    expect(typeof data.previewHtml).toBe("string")
    expect(data.previewHtml.length).toBeGreaterThan(0)
    // Nenhum aviso — o gate está aberto, as DEBT vars são legítimas aqui.
    expect(data.warnings).toEqual([])
    expect(data.canSave).toBe(true)
  })

  // Contra-prova de SEGURANÇA: o MESMO corpo, mas com o gate FECHADO
  // (allowDebtFields ausente), volta a acusar as variáveis de débito. A regra de
  // segurança não foi enfraquecida.
  it("mesmo corpo sem allow_debt_fields → DEBT vars continuam proibidas", async () => {
    const { POST } = await import("@/app/api/super-admin/email-templates/preview/route")
    const res = await call(POST, {
      subject: "{{credor}}",
      html:
        "<p>{{nome_cliente}} {{valor_divida}}</p>" +
        '<a href="{{link_negociacao}}">x</a><a href="{{link_descadastro}}">y</a>',
      purpose: "negotiation",
      // allowDebtFields omitido de propósito
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.canSave).toBe(false)
    expect(data.warnings.join(" ")).toMatch(/dado do débito/i)
  })
})

describe("POST create — validação", () => {
  it("rejeita (422) template com variável proibida", async () => {
    const { POST } = await import("@/app/api/super-admin/email-templates/route")
    const res = await call(POST, {
      name: "Ruim",
      scope: "global",
      purpose: "communication",
      subject: "Olá {{primeiro_nome}}",
      html: "<p>{{cpf}}</p>",
    })
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.validation.ok).toBe(false)
  })

  it("rejeita (422) negotiation sem os links obrigatórios", async () => {
    const { POST } = await import("@/app/api/super-admin/email-templates/route")
    const res = await call(POST, {
      name: "Neg",
      scope: "global",
      purpose: "negotiation",
      subject: "Olá {{primeiro_nome}}",
      html: "<p>oi {{primeiro_nome}}</p>",
    })
    expect(res.status).toBe(422)
  })

  it("cria (201) um template válido e persiste versão 1", async () => {
    const { POST } = await import("@/app/api/super-admin/email-templates/route")
    const res = await call(POST, {
      name: "Bom",
      scope: "global",
      purpose: "communication",
      subject: "Olá {{primeiro_nome}}",
      html: "<p>Olá {{primeiro_nome}} da {{credor}}</p>",
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.template).toBeDefined()
    expect(data.version.version).toBe(1)
    // uma linha em email_templates e uma em email_template_versions
    expect(inserted["email_templates"]).toHaveLength(1)
    expect(inserted["email_template_versions"]).toHaveLength(1)
    // o HTML persistido é o sanitizado (sem script)
    expect(inserted["email_template_versions"][0].html.toLowerCase()).not.toContain("script")
  })
})
