// Correção B10 (A2, ALTO) — /t/{slug}: sem o lock por IP, o login por documento
// ficava sem controle de volume, e `POST /api/chat/auth {tenantSlug}` era aceito
// mesmo com journey_public_enabled=false (o middleware pula /api/).
//  - a ROTA recusa o slug de tenant com jornada pública desligada (salvo admin);
//  - authenticateByDocument aplica o teto por cedente/hora (volume total do
//    tenant) com o mesmo modo degradado do /n/: captcha obrigatório.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test"
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://fake"
const CO = "dddddddd-0000-0000-0000-00000000b10a"
let db: FakeDb
let admin = false
const authCalls: unknown[] = []

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }) }))
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: admin ? { id: "u-admin" } : null } }) } }),
}))

describe("Correção B10 (A2) — gate da rota /api/chat/auth {tenantSlug}", () => {
  beforeEach(() => {
    admin = false
    authCalls.length = 0
    db = {
      tenant_chat_config: [{ company_id: CO, journey_public_enabled: false, branding: { slug: "vmax" } }],
      companies: [{ id: CO, name: "VMAX" }],
      profiles: [{ id: "u-admin", role: "super_admin" }],
    }
  })

  async function post(body: Record<string, unknown>) {
    vi.doMock("@/lib/journey/generic-auth", async (orig) => ({
      ...(await orig<typeof import("@/lib/journey/generic-auth")>()),
      authenticateByDocument: async (i: unknown) => {
        authCalls.push(i)
        return { ok: false, message: "uniforme" }
      },
    }))
    vi.resetModules()
    const { POST } = await import("@/app/api/chat/auth/route")
    const req = {
      json: async () => body,
      headers: { get: () => null },
      cookies: { getAll: () => [], get: () => undefined },
    } as any
    return POST(req)
  }

  it("journey_public_enabled=false → 404 (mesma resposta de slug inexistente); nenhuma autenticação", async () => {
    const res = await post({ tenantSlug: "vmax", document: "11144477735", consent: true })
    expect(res.status).toBe(404)
    expect(authCalls.length).toBe(0)
  })

  it("journey_public_enabled=false + admin autenticado (preview) → segue para a autenticação", async () => {
    admin = true
    const res = await post({ tenantSlug: "vmax", document: "11144477735", consent: true })
    expect(res.status).toBe(401) // mock devolve falha uniforme
    expect(authCalls.length).toBe(1)
  })

  it("journey_public_enabled=true → segue para a autenticação", async () => {
    db.tenant_chat_config[0].journey_public_enabled = true
    const res = await post({ tenantSlug: "vmax", document: "11144477735", consent: true })
    expect(res.status).toBe(401)
    expect(authCalls.length).toBe(1)
  })
})

describe("Correção B10 (A2) — teto por cedente/hora no /t/ (modo degradado)", () => {
  beforeEach(() => {
    vi.doUnmock("@/lib/journey/generic-auth")
    vi.resetModules()
    process.env.CHAT_CAPTCHA_ENABLED = "false"
    process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP = "3"
    db = {
      tenant_chat_config: [{ company_id: CO, auth_max_attempts: 3, auth_lock_minutes: 30, session_ttl_minutes: 60 }],
      chat_auth_generic_attempts: [],
    }
  })

  it("abaixo do teto: fluxo normal (documento inexistente → falha uniforme, tentativa gravada)", async () => {
    vi.doMock("@/lib/journey/resolver", () => ({ resolveByDocument: async () => ({ kind: "none" }) }))
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    const r = await authenticateByDocument({ companyId: CO, document: "11144477735", consent: true, ip: null, userAgent: null, channel: "web_generic" })
    expect(r.ok).toBe(false)
    expect(db.chat_auth_generic_attempts.length).toBe(1)
  })

  it("teto estourado (CPFs distintos) → sem captcha é recusado ANTES de resolver o documento", async () => {
    let resolves = 0
    vi.doMock("@/lib/journey/resolver", () => ({ resolveByDocument: async () => { resolves++; return { kind: "none" } } }))
    const now = new Date().toISOString()
    for (let i = 0; i < 3; i++) db.chat_auth_generic_attempts.push({ company_id: CO, doc_hash: `d${i}`, ip_hash: null, success: false, failure_reason: "unresolved", created_at: now })
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    const r = await authenticateByDocument({ companyId: CO, document: "52998224725", consent: true, ip: null, userAgent: null, channel: "web_generic" })
    expect(r.ok).toBe(false)
    expect(resolves).toBe(0)
    expect(db.chat_auth_generic_attempts.length).toBe(3) // bloqueado sem contabilizar
  })

  it("teto estourado + captcha presente e válido → segue o fluxo (resolve o documento)", async () => {
    let resolves = 0
    vi.doMock("@/lib/journey/resolver", () => ({ resolveByDocument: async () => { resolves++; return { kind: "none" } } }))
    const now = new Date().toISOString()
    for (let i = 0; i < 3; i++) db.chat_auth_generic_attempts.push({ company_id: CO, doc_hash: `d${i}`, ip_hash: null, success: false, failure_reason: "nlink:unresolved", created_at: now })
    const { authenticateByDocument } = await import("@/lib/journey/generic-auth")
    await authenticateByDocument({ companyId: CO, document: "52998224725", consent: true, ip: null, userAgent: null, captchaToken: "tok", channel: "web_generic" })
    expect(resolves).toBe(1)
  })
})
