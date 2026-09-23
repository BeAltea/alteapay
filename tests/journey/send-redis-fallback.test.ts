// Fallback inline AUTOMÁTICO na rota do hub (POST /api/super-admin/negotiations/send).
//
// Prova o novo comportamento do modo EFETIVO de envio:
//   - env=queue + Redis OK (ping true)  → mantém 'queue' (não quebra o modo fila).
//   - env=queue + Redis FORA (ping false)→ FORÇA 'inline' (fallback automático).
//   - env=queue + Redis TIMEOUT (ping resolve false por timeout) → FORÇA 'inline'.
//   - env=inline                         → segue 'inline' SEM sequer pingar o Redis.
//
// O ping é mockado (pingRedis de @/lib/queue). Olhamos o dispatchMode com que o
// runHubSend é chamado — a prova de que o fallback aconteceu (ou não).

import { beforeEach, describe, expect, it, vi } from "vitest"

const CO = "eeeeeeee-0000-0000-0000-000000000012"

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

vi.mock("@/app/api/super-admin/negotiations/selection", () => ({
  resolveSelection: async (body: any) => ({ customerIds: body.customerIds ?? [] }),
}))

vi.mock("@/lib/journey/campaigns", () => ({
  loadTenantHubConfig: async () => ({
    cooldownDays: 7, minDebtValue: 0, sendMode: "whatsapp_chat", dispatchMode: "mock",
    provider: "mock", publicLinkCode: "k7Qm3Xb9Rt", publicLinkEnabled: true, linkTtlHours: 168,
    voxuyFlowId: null, voxuyPlanId: null,
  }),
  createHubCampaign: async () => ({ campaignId: "camp-1" }),
}))

// pingRedis mockável: cada teste decide o retorno. Registra as chamadas para
// provar que o env=inline NEM pinga.
const pingRef = { value: true, calls: 0 }
vi.mock("@/lib/queue", () => ({
  pingRedis: async () => { pingRef.calls += 1; return pingRef.value },
}))

// runHubSend: registra o dispatchMode efetivo com que foi chamado.
let hubCalls: Array<{ dispatchMode: string; dryRun: boolean }> = []
vi.mock("@/lib/journey/campaign-send", () => ({
  runHubSend: async ({ dispatchMode, dryRun }: { dispatchMode: string; dryRun: boolean }) => {
    hubCalls.push({ dispatchMode, dryRun })
    return { campaignId: "camp-1", mode: "whatsapp_chat", dispatchMode, dryRun, items: [], summary: { sent: 0, failed: 0, suppressed: 0, skipped: 0 } }
  },
}))

function makeRequest(body: unknown): any {
  return { json: async () => body, headers: { get: () => null }, nextUrl: { searchParams: new URLSearchParams() } }
}
async function call(POST: (r: any) => Promise<any>, body: unknown) {
  return (await POST(makeRequest(body))) as { status: number; json: () => Promise<any> }
}

beforeEach(() => {
  vi.resetModules()
  hubCalls = []
  roleRef.role = "super_admin"
  pingRef.value = true
  pingRef.calls = 0
  process.env.NEXT_PUBLIC_APP_URL = "https://alteapay.com"
  process.env.INLINE_DISPATCH_MAX_BATCH = "25"
  delete process.env.EMAIL_SEND_MODE
  delete process.env.DISPATCH_MODE
})

describe("modo efetivo — env=queue + Redis OK", () => {
  it("Redis responde (ping true): MANTÉM 'queue' (não quebra o modo fila)", async () => {
    pingRef.value = true
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b"], channels: ["whatsapp"] })
    expect(res.status).toBe(200)
    expect(pingRef.calls).toBe(1) // pingou (era queue)
    expect(hubCalls[0].dispatchMode).toBe("queue")
  })
})

describe("modo efetivo — env=queue + Redis indisponível → fallback inline", () => {
  it("ping false (Redis fora): FORÇA 'inline'", async () => {
    pingRef.value = false
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b"], channels: ["whatsapp"] })
    expect(res.status).toBe(200)
    expect(pingRef.calls).toBe(1)
    expect(hubCalls[0].dispatchMode).toBe("inline")
  })

  it("fallback inline ainda respeita o teto de lote (acima do teto → 400 com forcedInline)", async () => {
    pingRef.value = false
    process.env.INLINE_DISPATCH_MAX_BATCH = "2"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a", "b", "c"], channels: ["whatsapp"] })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.maxBatch).toBe(2)
    expect(data.forcedInline).toBe(true)
    // não disparou (recusou por lote).
    expect(hubCalls.length).toBe(0)
  })

  it("fallback inline respeita a trava super_admin (admin de tenant → 403)", async () => {
    pingRef.value = false
    roleRef.role = "admin"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a"], channels: ["whatsapp"] })
    expect(res.status).toBe(403)
    expect(hubCalls.length).toBe(0)
  })
})

describe("modo efetivo — env=inline não pinga", () => {
  it("DISPATCH_MODE=inline: segue 'inline' SEM pingar o Redis", async () => {
    process.env.DISPATCH_MODE = "inline"
    const { POST } = await import("@/app/api/super-admin/negotiations/send/route")
    const res = await call(POST, { companyId: CO, customerIds: ["a"], channels: ["whatsapp"] })
    expect(res.status).toBe(200)
    expect(pingRef.calls).toBe(0) // já era inline: não precisa pingar
    expect(hubCalls[0].dispatchMode).toBe("inline")
  })
})
