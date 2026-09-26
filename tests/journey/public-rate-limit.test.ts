// H4 — Rate-limit do link único público: três dimensões INDEPENDENTES (IP,
// documento, teto do cedente/hora), locks progressivos e isolamento por canal.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "cccccccc-0000-0000-0000-000000000002"

let db: FakeDb

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => makeFakeSupabase(db),
}))

const DOC_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // doc_hash A (64)
const DOC_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" // doc_hash B
const IP_1 = "11111111111111111111111111111111" // ip_hash 1 (32)
const IP_2 = "22222222222222222222222222222222"

function reset() {
  db = {}
  delete process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS
  delete process.env.PUBLIC_AUTH_IP_WINDOW_MIN
  delete process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS
  delete process.env.PUBLIC_AUTH_DOC_WINDOW_MIN
  delete process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP
  delete process.env.AUTH_IP_LOCK_ENABLED
}

async function mod() {
  return import("@/lib/journey/public-rate-limit")
}

/** Simula uma falha: registra a tentativa e roda o gatilho de lock. */
async function fail(docHash: string, ipHash: string | null) {
  const m = await mod()
  await m.registerPublicAttempt({ companyId: CO, docHash, ipHash, success: false, reason: "unresolved" })
  await m.onPublicFailure({ companyId: CO, docHash, ipHash })
}

describe("public-rate-limit", () => {
  beforeEach(reset)

  it("hashes de documento/IP são derivados só de hash (sem PII) e determinísticos", async () => {
    const { docHashOf, ipHashOf } = await mod()
    expect(docHashOf("111.444.777-35")).toBe(docHashOf("11144477735")) // normaliza
    expect(docHashOf("11144477735")).toHaveLength(64)
    expect(ipHashOf("1.2.3.4")).toHaveLength(32)
    expect(ipHashOf(null)).toBeNull()
  })

  it("lock por IP após o teto de falhas (independente do documento) — só com AUTH_IP_LOCK_ENABLED=true", async () => {
    // QA rodada 6 (Q1r2-5): a dimensão IP é telemetria por padrão; aqui ela é
    // religada explicitamente (o default desligado é coberto em qa6-ip-lock).
    process.env.AUTH_IP_LOCK_ENABLED = "true"
    process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS = "3"
    // 3 falhas do MESMO IP com documentos diferentes → lock por IP.
    await fail(DOC_A, IP_1)
    await fail(DOC_B, IP_1)
    await fail(DOC_A, IP_1)
    const m = await mod()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC_B, ipHash: IP_1 })
    expect(dec.blocked).toBe(true)
    if (dec.blocked) expect(dec.scope).toBe("ip")
    // outro IP não está bloqueado.
    const ok = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC_B, ipHash: IP_2 })
    expect(ok.blocked).toBe(false)
  })

  it("lock por DOCUMENTO após o teto (independente do IP)", async () => {
    process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS = "3"
    process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS = "999" // isola: não queremos lock de IP aqui
    // 3 falhas do MESMO documento em IPs diferentes → lock por documento.
    await fail(DOC_A, IP_1)
    await fail(DOC_A, IP_2)
    await fail(DOC_A, "33333333333333333333333333333333")
    const m = await mod()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC_A, ipHash: "99999999999999999999999999999999" })
    expect(dec.blocked).toBe(true)
    if (dec.blocked) expect(dec.scope).toBe("document")
  })

  it("bloqueio PROGRESSIVO: 2º lock dura mais que o 1º (10 → 30 min)", async () => {
    process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS = "1"
    process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS = "999"
    // 1ª falha → 1º lock (10min)
    await fail(DOC_A, IP_1)
    const firstLock = db.chat_auth_generic_locks?.filter((l) => l.scope === "document") ?? []
    expect(firstLock).toHaveLength(1)
    const dur1 = Date.parse(firstLock[0].locked_until) - Date.now()
    // 2ª falha → 2º lock (30min), mais longo
    await fail(DOC_A, IP_1)
    const locks = db.chat_auth_generic_locks?.filter((l) => l.scope === "document") ?? []
    expect(locks.length).toBe(2)
    const dur2 = Date.parse(locks[1].locked_until) - Date.now()
    expect(dur2).toBeGreaterThan(dur1)
    // ~10min e ~30min (tolerância de segundos)
    expect(Math.round(dur1 / 60000)).toBe(10)
    expect(Math.round(dur2 / 60000)).toBe(30)
  })

  it("teto do cedente/hora → modo DEGRADADO (degraded=true), sem bloquear", async () => {
    process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP = "3"
    process.env.PUBLIC_AUTH_IP_MAX_ATTEMPTS = "999"
    process.env.PUBLIC_AUTH_DOC_MAX_ATTEMPTS = "999"
    const m = await mod()
    // 3 tentativas do tenant (conta VOLUME, sucesso incluso) → estoura o teto.
    await m.registerPublicAttempt({ companyId: CO, docHash: DOC_A, ipHash: IP_1, success: true, reason: "ok" })
    await m.registerPublicAttempt({ companyId: CO, docHash: DOC_B, ipHash: IP_2, success: false, reason: "unresolved" })
    await m.registerPublicAttempt({ companyId: CO, docHash: DOC_A, ipHash: IP_2, success: false, reason: "unresolved" })
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", ipHash: "44444444444444444444444444444444" })
    expect(dec.blocked).toBe(false)
    expect(dec.degraded).toBe(true)
  })

  it("isolamento por canal: tentativas de OUTRO canal não contam para o teto/hora", async () => {
    process.env.PUBLIC_AUTH_TENANT_HOURLY_CAP = "2"
    // insere 5 tentativas SEM o prefixo nlink: (ex.: /t/ genérico) — não devem contar.
    db.chat_auth_generic_attempts = Array.from({ length: 5 }, () => ({
      company_id: CO, doc_hash: DOC_A, ip_hash: IP_1, success: false,
      failure_reason: "unresolved", created_at: new Date().toISOString(),
    }))
    const m = await mod()
    const dec = await m.evaluatePublicRateLimit({ companyId: CO, docHash: DOC_A, ipHash: IP_1 })
    expect(dec.degraded).toBe(false) // as 5 do outro canal não contaram
  })

  it("registerPublicAttempt marca o canal (nlink:) e nunca vaza doc em claro", async () => {
    const m = await mod()
    await m.registerPublicAttempt({ companyId: CO, docHash: DOC_A, ipHash: IP_1, success: false, reason: "unresolved" })
    const row = db.chat_auth_generic_attempts?.[0]
    expect(row?.failure_reason).toBe("nlink:unresolved")
    expect(row?.doc_hash).toBe(DOC_A)
    // só hash: 64 hex, sem dígitos de CPF crus
    expect(row?.doc_hash).toMatch(/^[a-f0-9]{64}$/)
  })
})
