// Teste de INTEGRAÇÃO do contrato do hub de envio (T2 ⇄ T5).
//
// Prova o acoplamento que faltava: a resposta REAL das rotas
//   POST /api/super-admin/negotiations/send-preview
//   POST /api/super-admin/negotiations/send
// casa EXATAMENTE com os tipos de send-contract.ts que o send-dialog consome
// (todo campo lido pelo diálogo existe e tem o tipo certo), e a seleção
// `allFiltered` é aceita (resolvida no servidor, sem 400).
//
// O bug original passou porque nenhum teste exercitava esse acoplamento: o
// diálogo lia campos (byChannel, allowedModes, excluded[], publicLink, counts,
// results) que as rotas não emitiam. Este teste trava o formato dos dois lados.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  SendPreviewResponse,
  SendResponse,
  SendMode,
  SendOutcome,
} from "@/components/super-admin/negotiations/send-contract"

// ---------------------------------------------------------------------------
// Fakes: auth (super_admin), service client (document mask + resolução de ids),
// e as funções de campanha/envio (o formato da ROTA é o que testamos, não a
// mecânica de envio, já coberta por tests/journey/hub-send.test.ts).
// ---------------------------------------------------------------------------

const CO = "eeeeeeee-0000-0000-0000-000000000012"

// customers usados para mascarar documento na resposta.
const CUSTOMERS: Record<string, string> = {
  c1: "11144477735", // cpf
  c2: "52998224725", // cpf
  ex1: "12345678000199", // cnpj
}

// Fake service client: cobre customers.select().eq().in() e negotiation_state
// (para resolveFilteredCustomerIds via query.ts).
function fakeServiceClient() {
  return {
    from(table: string) {
      const qb: any = {
        _filters: {} as Record<string, any>,
        select() { return qb },
        eq(col: string, val: any) { qb._filters[col] = val; return qb },
        in(col: string, val: any[]) { qb._filters[`in_${col}`] = val; return qb },
        gte() { return qb },
        not() { return qb },
        is() { return qb },
        or() { return qb },
        order() { return qb },
        limit() { return qb },
        range(a: number) { qb._range = a; return qb },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then(res: (r: { data: any[]; error: null }) => void) {
          res({ data: rowsFor(table, qb), error: null })
        },
      }
      return qb
    },
  }
}

function rowsFor(table: string, qb: any): any[] {
  if (table === "customers") {
    const ids: string[] = qb._filters["in_id"] ?? []
    return ids
      .filter((id) => CUSTOMERS[id] != null)
      .map((id) => ({ id, document: CUSTOMERS[id], name: "Fulano", contact_profile: "mobile" }))
  }
  if (table === "negotiation_state") {
    // Só a 1ª página é lida (range 0). Dois devedores casam o filtro.
    if (qb._range && qb._range > 0) return []
    return [
      { company_id: CO, customer_id: "c1", stage: "dispatched", stage_rank: 20, channel: "whatsapp", updated_at: "2026-09-10T00:00:00Z", has_live_charge: false },
      { company_id: CO, customer_id: "c2", stage: "in_chat", stage_rank: 60, channel: "email", updated_at: "2026-09-11T00:00:00Z", has_live_charge: false },
    ]
  }
  if (table === "companies") {
    return [{ id: CO, name: "VMAX" }]
  }
  if (table === "tenant_chat_config") {
    return [{ company_id: CO, public_link_code: "k7Qm3Xb9Rt", public_link_enabled: true }]
  }
  // debts / contact_suppressions / whatsapp_campaigns: vazio (satélites).
  return []
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeServiceClient() }))

// auth: super_admin. company_id do body é aceito (super_admin cross-tenant).
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) },
    from: (_t: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { role: "super_admin", company_id: CO, full_name: "Admin" }, error: null }),
        }),
      }),
    }),
  }),
}))

// campaigns: config do hub + avaliação/preview. Emula um excluído (ex1) para
// provar o array `excluded` por-devedor com documento mascarado.
vi.mock("@/lib/journey/campaigns", async (orig) => {
  const actual = (await orig()) as any
  return {
    ...actual,
    loadTenantHubConfig: async () => ({
      cooldownDays: 7,
      minDebtValue: 0,
      sendMode: "both" as SendMode, // both → allowedModes = todos os 3
      dispatchMode: "mock",
      provider: "mock",
      publicLinkCode: "k7Qm3Xb9Rt",
      publicLinkEnabled: true,
      linkTtlHours: 168,
      voxuyFlowId: null,
      voxuyPlanId: null,
    }),
    evaluateHubEligibility: async ({ customerIds }: { customerIds: string[] }) => {
      // c1 whatsapp elegível (com cobrança viva), c2 email elegível; ex1 excluído.
      const all = [
        { customerId: "c1", eligible: true, channel: "whatsapp", hasLiveCharge: true },
        { customerId: "c2", eligible: true, channel: "email", hasLiveCharge: false },
        { customerId: "ex1", eligible: false, reason: "sem_contato" },
      ]
      return all.filter((r) => customerIds.includes(r.customerId))
    },
    createHubCampaign: async () => ({ campaignId: "camp-1", evaluated: [], counts: {} }),
  }
})

// campaign-send: retorna items (status/reason) que a rota mapeia p/ results.
vi.mock("@/lib/journey/campaign-send", () => ({
  runHubSend: async ({ dryRun }: { dryRun: boolean }) => ({
    campaignId: "camp-1",
    mode: "both",
    dispatchMode: "queue",
    dryRun,
    items: [
      { customerId: "c1", channel: "whatsapp", status: "sent", messageId: "m1" },
      { customerId: "c2", channel: "email", status: "sent", messageId: "m2" },
      { customerId: "ex1", status: "skipped", reason: "sem_contato" },
    ],
    summary: { sent: 2, failed: 0, suppressed: 0, skipped: 1 },
  }),
}))

// ---------------------------------------------------------------------------
function makeRequest(body: unknown): any {
  return {
    json: async () => body,
    nextUrl: { searchParams: new URLSearchParams() },
  }
}

/** Resposta mínima que os testes inspecionam (status + json()). O handler sempre
 * devolve um NextResponse; o cast fixa o tipo para o strict mode. */
interface RouteResponse {
  status: number
  json: () => Promise<any>
}
type RouteHandler = (req: any) => Promise<unknown>
async function call(POST: RouteHandler, body: unknown): Promise<RouteResponse> {
  return (await POST(makeRequest(body))) as RouteResponse
}

// document mascarado: nunca em claro (regra §3).
const CLEAR_DOCS = Object.values(CUSTOMERS)
function assertNoClearDocument(masked: string) {
  expect(CLEAR_DOCS).not.toContain(masked)
  expect(masked).toMatch(/\*/) // toda máscara tem ao menos um '*'
}

beforeEach(() => {
  vi.resetModules()
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
})

describe("send-preview — resposta casa com SendPreviewResponse (o diálogo lê)", () => {
  it("customerIds explícitos: todos os campos que o diálogo consome existem e têm o tipo certo", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send-preview/route")
    const res = await call(POST, { companyId: CO, customerIds: ["c1", "c2", "ex1"], mode: "whatsapp_chat" })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SendPreviewResponse

    // campos LIDOS pelo send-dialog:
    expect(typeof data.total).toBe("number")            // preview.total
    expect(typeof data.byChannel.whatsapp).toBe("number") // preview.byChannel.whatsapp
    expect(typeof data.byChannel.email).toBe("number")    // preview.byChannel.email
    expect(typeof data.withLiveCharge).toBe("number")     // preview.withLiveCharge
    expect(Array.isArray(data.allowedModes)).toBe(true)   // preview.allowedModes
    expect(["whatsapp_chat", "charge_email", "both"]).toContain(data.mode) // preview.mode
    // publicLink: string | null (o diálogo trata os dois casos)
    expect(data.publicLink === null || typeof data.publicLink === "string").toBe(true)

    // valores esperados
    expect(data.total).toBe(2)
    expect(data.byChannel.whatsapp).toBe(1)
    expect(data.byChannel.email).toBe(1)
    expect(data.withLiveCharge).toBe(1)
    expect(data.publicLink).toBe("https://alteapay.com/n/k7Qm3Xb9Rt")
    // tenant é 'both' → os 3 modos permitidos (habilita a troca no diálogo)
    expect(data.allowedModes).toEqual(["whatsapp_chat", "charge_email", "both"])
  })

  it("excluded é um ARRAY por-devedor (não Record) com documentMasked + reason", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send-preview/route")
    const res = await call(POST, { companyId: CO, customerIds: ["c1", "c2", "ex1"] })
    const data = (await res.json()) as SendPreviewResponse

    expect(Array.isArray(data.excluded)).toBe(true) // o diálogo faz .map/.length
    expect(data.excluded.length).toBe(1)
    const ex = data.excluded[0]
    expect(ex.customerId).toBe("ex1")            // key do <li> e do map
    expect(typeof ex.reason).toBe("string")      // <span>{e.reason}</span>
    expect(typeof ex.documentMasked).toBe("string")
    assertNoClearDocument(ex.documentMasked)     // documento NUNCA em claro
  })

  it("allFiltered é ACEITO (resolve ids no servidor) — não dá 400", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send-preview/route")
    const res = await call(POST, {
      companyId: CO,
      allFiltered: { filters: { companyId: CO, stages: ["dispatched", "in_chat"] }, expectedCount: 2 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SendPreviewResponse
    // os ids vieram de negotiation_state (c1, c2) → 2 elegíveis
    expect(data.total).toBe(2)
  })

  it("sem customerIds e sem allFiltered → 400", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send-preview/route")
    const res = await call(POST, { companyId: CO })
    expect(res.status).toBe(400)
  })
})

describe("send — resposta casa com SendResponse (o diálogo lê)", () => {
  it("customerIds explícitos: dryRun, counts e results por-devedor com os tipos do contrato", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["c1", "c2", "ex1"], mode: "whatsapp_chat", dryRun: true })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SendResponse

    // campos LIDOS pelo SendResultView:
    expect(typeof data.dryRun).toBe("boolean")             // result.dryRun
    for (const k of ["sent", "failed", "suppressed", "skipped"] as SendOutcome[]) {
      expect(typeof data.counts[k]).toBe("number")         // result.counts[k]
    }
    expect(Array.isArray(data.results)).toBe(true)         // result.results.map
    for (const r of data.results) {
      expect(typeof r.customerId).toBe("string")           // key do <tr>
      expect(r.channel === null || ["whatsapp", "email"].includes(r.channel)).toBe(true) // r.channel
      expect(["sent", "failed", "suppressed", "skipped"]).toContain(r.outcome) // OUTCOME_CLASS[r.outcome]
      expect(r.detail === null || typeof r.detail === "string").toBe(true)      // r.detail
      expect(typeof r.documentMasked).toBe("string")       // <td>{r.documentMasked}</td>
      assertNoClearDocument(r.documentMasked)              // documento NUNCA em claro
    }

    // valores esperados (mapeados de items→results)
    expect(data.counts).toEqual({ sent: 2, failed: 0, suppressed: 0, skipped: 1 })
    expect(data.results.length).toBe(3)
    const ex = data.results.find((r) => r.customerId === "ex1")!
    expect(ex.outcome).toBe("skipped")
    expect(ex.detail).toBe("sem_contato")
  })

  it("allFiltered é ACEITO — não dá 400", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, {
      companyId: CO,
      mode: "whatsapp_chat",
      dryRun: true,
      allFiltered: { filters: { companyId: CO, stages: ["dispatched", "in_chat"] }, expectedCount: 2 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as SendResponse
    expect(Array.isArray(data.results)).toBe(true)
  })

  it("sem customerIds e sem allFiltered → 400", async () => {
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, mode: "whatsapp_chat" })
    expect(res.status).toBe(400)
  })
})
