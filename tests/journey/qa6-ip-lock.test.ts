// QA rodada 6 (Q1r2-5, ALTO) — em produção o "IP do cliente" gravado é um salto
// intermediário da Netlify (comum a vários devedores): 5 CPFs inexistentes
// travavam o login de todos atrás dele. Sem fonte VERIFICÁVEL do IP do cliente no
// runtime do Next na Netlify, a dimensão IP do lock vira só TELEMETRIA por padrão
// (o ip_hash continua gravado); o lock por DOCUMENTO e o teto por cedente seguem.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-0000000qa6ip"
let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))

const DOC = (c: string) => c.repeat(64)
const PROXY_IP = "5447117d5447117d5447117d5447117d" // mesmo ip_hash para todos (salto da Netlify)

async function rl() {
  return import("@/lib/journey/public-rate-limit")
}
async function fail(docHash: string, ipHash: string | null) {
  const m = await rl()
  await m.registerPublicAttempt({ companyId: CO, docHash, ipHash, success: false, reason: "unresolved" })
  await m.onPublicFailure({ companyId: CO, docHash, ipHash })
}

describe("QA rodada 6 — dimensão IP do lock rebaixada a telemetria (Q1r2-5)", () => {
  beforeEach(() => {
    db = {}
    delete process.env.AUTH_IP_LOCK_ENABLED
    delete process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS
    delete process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS
    delete process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP
  })

  it("reprodução do QA: 5 CPFs inexistentes pelo mesmo 'IP' NÃO bloqueiam o devedor legítimo; ip_hash segue gravado", async () => {
    for (const c of ["1", "2", "3", "4", "5", "6"]) await fail(DOC(c), PROXY_IP)
    const m = await rl()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC("f"), ipHash: PROXY_IP })
    expect(dec.blocked).toBe(false)
    expect((db.chat_auth_generic_locks ?? []).filter((l) => l.scope === "ip").length).toBe(0)
    // telemetria preservada
    expect(db.chat_auth_generic_attempts.every((a) => a.ip_hash === PROXY_IP)).toBe(true)
  })

  it("lock IP pré-existente no banco (da rodada anterior) é ignorado por padrão", async () => {
    db.chat_auth_generic_locks = [{ company_id: CO, scope: "ip", key_hash: PROXY_IP, locked_until: new Date(Date.now() + 3600_000).toISOString(), reason: "nlink:ip_rate" }]
    const m = await rl()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC("f"), ipHash: PROXY_IP })
    expect(dec.blocked).toBe(false)
  })

  it("lock por DOCUMENTO continua valendo (o mesmo CPF errando 5x é bloqueado)", async () => {
    for (let i = 0; i < 5; i++) await fail(DOC("a"), PROXY_IP)
    const m = await rl()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC("a"), ipHash: PROXY_IP })
    expect(dec).toMatchObject({ blocked: true, scope: "document" })
  })

  it("teto por cedente/hora continua ligando o modo degradado", async () => {
    process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP = "3"
    for (const c of ["1", "2", "3"]) await fail(DOC(c), PROXY_IP)
    const m = await rl()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC("f"), ipHash: PROXY_IP })
    expect(dec).toMatchObject({ blocked: false, degraded: true })
  })

  it("religado explicitamente (AUTH_IP_LOCK_ENABLED=true) volta a bloquear por IP", async () => {
    process.env.AUTH_IP_LOCK_ENABLED = "true"
    for (const c of ["1", "2", "3", "4", "5"]) await fail(DOC(c), PROXY_IP)
    const m = await rl()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC("f"), ipHash: PROXY_IP })
    expect(dec).toMatchObject({ blocked: true, scope: "ip" })
  })

  it("ipLockEnabled: desligado por padrão", async () => {
    const { ipLockEnabled } = await import("@/lib/journey/client-ip")
    expect(ipLockEnabled()).toBe(false)
    process.env.AUTH_IP_LOCK_ENABLED = "1"
    expect(ipLockEnabled()).toBe(false)
    process.env.AUTH_IP_LOCK_ENABLED = "true"
    expect(ipLockEnabled()).toBe(true)
  })
})
