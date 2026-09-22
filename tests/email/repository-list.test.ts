// Regressão da LISTAGEM de templates (F4/D1 — onda VMAX cobrança).
//
// A página /super-admin/emails lista os templates via listTemplates(). Um template
// gravado DIRETO no banco (o seed da VMAX, com allow_debt_fields=true e variáveis
// de débito) NÃO pode derrubar a listagem inteira. Aqui garantimos que:
//   1) um template "normal" da VMAX é mapeado sem lançar (allowDebtFields=true);
//   2) uma linha malformada é PULADA (guarda por template) sem quebrar as demais.
import { describe, expect, it, vi } from "vitest"
import { listTemplates } from "@/lib/email/templates/repository"

type Rows = Record<string, any[]>

/** Service client fake: devolve os rows por tabela conforme o cenário. */
function fakeClient(rows: Rows) {
  return {
    from(table: string) {
      const qb: any = {
        select() { return qb },
        eq() { return qb },
        neq() { return qb },
        is() { return qb },
        in() { return qb },
        order() { return qb },
        limit() { return qb },
        range() { return qb },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then(res: (r: { data: any[]; error: null }) => void) {
          res({ data: rows[table] ?? [], error: null })
        },
      }
      return qb
    },
  }
}

const VMAX_ROW = {
  id: "t-vmax",
  company_id: "co-vmax",
  name: "VMAX — Cobrança oficial com dados do débito",
  purpose: "negotiation",
  status: "active",
  allow_debt_fields: true,
  current_version_id: "v-vmax",
  created_by: null,
  created_at: "2026-09-22T00:00:00Z",
  updated_at: "2026-09-22T00:00:00Z",
}
const VMAX_VERSION = {
  id: "v-vmax",
  template_id: "t-vmax",
  version: 1,
  subject: "{{credor}}: pendência",
  preheader: "oficial",
  html: "<p>{{nome_cliente}} {{valor_divida}}</p>",
  text_fallback: "{{nome_cliente}} {{valor_divida}}",
  variables_used: ["nome_cliente", "valor_divida"],
  created_by: null,
  created_at: "2026-09-22T00:00:00Z",
}

describe("listTemplates — resiliência (VMAX / allow_debt_fields)", () => {
  it("mapeia o template da VMAX (allowDebtFields=true) sem lançar", async () => {
    const client = fakeClient({
      email_templates: [VMAX_ROW],
      email_template_versions: [VMAX_VERSION],
      email_template_defaults: [{ template_id: "t-vmax" }],
    })
    const rows = await listTemplates(client as any, { includeArchived: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].template.allowDebtFields).toBe(true)
    expect(rows[0].template.purpose).toBe("negotiation")
    expect(rows[0].currentVersion?.subject).toContain("{{credor}}")
    expect(rows[0].isDefault).toBe(true)
  })

  it("uma linha malformada é pulada; as demais seguem na lista", async () => {
    // getters lançam ao serem lidos → mapTemplate estoura para esta linha.
    const badRow: any = {
      get id() { return "t-bad" },
      get company_id() { throw new Error("coluna corrompida") },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = fakeClient({
      email_templates: [VMAX_ROW, badRow],
      email_template_versions: [VMAX_VERSION],
      email_template_defaults: [],
    })
    const rows = await listTemplates(client as any, { includeArchived: true })
    // Só o template bom sobra — a linha ruim NÃO derruba a listagem.
    expect(rows).toHaveLength(1)
    expect(rows[0].template.id).toBe("t-vmax")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
