// W2 — DISPATCH_MODE=inline na rota do hub (POST /api/super-admin/negotiations/send).
//
// Prova as travas do disparo síncrono (inline):
//   - teto INLINE_DISPATCH_MAX_BATCH: seleção acima do teto é RECUSADA (400) com
//     mensagem clara (não trunca silenciosamente).
//   - trava super_admin: admin de tenant NÃO pode disparar inline (403).
//   - dentro do teto + super_admin: passa (dispatchMode=inline chega ao runHubSend).
//   - queue (default): o teto/trava não se aplicam (admin dispara, sem limite).
//
// A mecânica de envio em si (recheck/pause/idempotência) é coberta em
// tests/journey/whatsapp-pause-idempotency.test.ts. Aqui olhamos só a rota.

import { beforeEach, describe, expect, it, vi } from "vitest"

const CO = "eeeeeeee-0000-0000-0000-000000000012"

// ---------------------------------------------------------------------------
// auth mockável: o papel (super_admin | admin) troca por teste via `roleRef`.
// ---------------------------------------------------------------------------
const roleRef = { role: "super_admin" as "super_admin" | "admin" }

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) },
    from: (_t: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { role: roleRef.role, company_id: CO, full_name: "Admin" }, error: null }),
        }),
      }),
    }),
  }),
}))

// service client: só usado para mascarar documento na resposta (retorna vazio).
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (_t: string) => {
      const qb: any = {
        select: () => qb, eq: () => qb, in: () => qb,
        then: (res: (r: { data: any[]; error: null }) => void) => res({ data: [], error: null }),
      }
      return qb
    },
  }),
}))

// selection: resolve os ids no servidor. Devolve a lista pedida (customerIds).
vi.mock("@/app/api/super-admin/negotiations/selection", () => ({
  resolveSelection: async (body: any) => ({ customerIds: body.customerIds ?? [] }),
}))

// hub config + campanha (o foco é a trava da rota, não a avaliação).
vi.mock("@/lib/journey/campaigns", () => ({
  loadTenantHubConfig: async () => ({
    cooldownDays: 7, minDebtValue: 0, sendMode: "whatsapp_chat", dispatchMode: "mock",
    provider: "mock", publicLinkCode: "k7Qm3Xb9Rt", publicLinkEnabled: true, linkTtlHours: 168,
    voxuyFlowId: null, voxuyPlanId: null,
  }),
  createHubCampaign: async () => ({ campaignId: "camp-1" }),
}))

// runHubSend: registra o dispatchMode com que foi chamado (prova que 'inline'
// chega até aqui só quando as travas passam).
let hubCalls: Array<{ dispatchMode: string; dryRun: boolean }> = []
vi.mock("@/lib/journey/campaign-send", () => ({
  runHubSend: async ({ dispatchMode, dryRun }: { dispatchMode: string; dryRun: boolean }) => {
    hubCalls.push({ dispatchMode, dryRun })
    return { campaignId: "camp-1", mode: "whatsapp_chat", dispatchMode, dryRun, items: [], summary: { sent: 0, failed: 0, suppressed: 0, skipped: 0 } }
  },
}))

function makeRequest(body: unknown): any {
  return { json: async () => body, nextUrl: { searchParams: new URLSearchParams() } }
}
async function call(POST: (r: any) => Promise<any>, body: unknown) {
  return (await POST(makeRequest(body))) as { status: number; json: () => Promise<any> }
}

beforeEach(() => {
  vi.resetModules()
  hubCalls = []
  roleRef.role = "super_admin"
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  process.env.INLINE_DISPATCH_MAX_BATCH = "3" // teto pequeno para o teste
  delete process.env.EMAIL_SEND_MODE
  delete process.env.DISPATCH_MODE
})

describe("inline — teto INLINE_DISPATCH_MAX_BATCH", () => {
  it("acima do teto: RECUSA 400 com mensagem clara e NÃO dispara", async () => {
    process.env.DISPATCH_MODE = "inline"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b", "c", "d"], channels: ["whatsapp"] })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.maxBatch).toBe(3)
    expect(data.received).toBe(4)
    expect(String(data.error)).toMatch(/lote/i)
    // nada foi disparado.
    expect(hubCalls.length).toBe(0)
  })

  it("dentro do teto: passa e runHubSend recebe dispatchMode='inline'", async () => {
    process.env.DISPATCH_MODE = "inline"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b", "c"], channels: ["whatsapp"] })
    expect(res.status).toBe(200)
    expect(hubCalls.length).toBe(1)
    expect(hubCalls[0].dispatchMode).toBe("inline")
  })

  it("dryRun ignora o teto (não envia de verdade)", async () => {
    process.env.DISPATCH_MODE = "inline"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b", "c", "d", "e"], channels: ["whatsapp"], dryRun: true })
    expect(res.status).toBe(200)
    expect(hubCalls[0].dryRun).toBe(true)
  })
})

describe("inline — trava super_admin", () => {
  it("admin de tenant NÃO pode disparar inline (403)", async () => {
    process.env.DISPATCH_MODE = "inline"
    roleRef.role = "admin"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a"], channels: ["whatsapp"] })
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(String(data.error)).toMatch(/super_admin/i)
    expect(hubCalls.length).toBe(0)
  })

  it("super_admin dentro do teto: dispara inline normalmente", async () => {
    process.env.DISPATCH_MODE = "inline"
    roleRef.role = "super_admin"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b"], channels: ["whatsapp"] })
    expect(res.status).toBe(200)
    expect(hubCalls[0].dispatchMode).toBe("inline")
  })
})

describe("queue (default) — teto/trava não se aplicam", () => {
  it("admin dispara em modo queue sem limite de lote", async () => {
    // sem DISPATCH_MODE/EMAIL_SEND_MODE => queue.
    roleRef.role = "admin"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b", "c", "d", "e"], channels: ["whatsapp"] })
    expect(res.status).toBe(200)
    expect(hubCalls[0].dispatchMode).toBe("queue")
  })
})
