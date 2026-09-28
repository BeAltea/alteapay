// lib/security-logger.ts: security_events.ip_address nunca recebe o 1º elemento
// do X-Forwarded-For (forjável) nem IP em claro. Grava o hash salgado do IP da
// fonte confiável (lib/http/client-ip.ts); sem fonte confiável ou sem sal → null.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = { headers: new Headers(), inserted: [] as Record<string, unknown>[] }

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
}))

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        state.inserted.push(row)
        return { error: null }
      },
    }),
  }),
}))

import { clientIpHash } from "@/lib/http/client-ip"
import { logSecurityEvent } from "@/lib/security-logger"

const KEYS = ["TRUSTED_CLIENT_IP_SOURCE", "CLIENT_IP_HASH_SALT", "CLIENT_IP_HEADER_SECRET", "TRUSTED_PROXY_HOPS"] as const
const saved: Record<string, string | undefined> = {}
const SALT = "test-salt-0123456789abcdef"
const SPOOF = "6.6.6.6"
const REAL = "203.0.113.7"

beforeEach(() => {
  state.inserted = []
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function log(h: Record<string, string>) {
  state.headers = new Headers(h)
  await logSecurityEvent({ event_type: "credit_analysis", action: "test", company_id: "co-1" })
  expect(state.inserted).toHaveLength(1)
  return state.inserted[0].ip_address
}

describe("logSecurityEvent — ip_address", () => {
  it("fonte confiável netlify + sal: grava o hash salgado do IP da borda, nunca o XFF forjado", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "edge,netlify"
    process.env.CLIENT_IP_HASH_SALT = SALT
    const ip = await log({ "x-forwarded-for": `${SPOOF}, 10.0.0.1`, "x-nf-client-connection-ip": REAL })
    expect(ip).toBe(clientIpHash(REAL, { CLIENT_IP_HASH_SALT: SALT }))
    expect(ip).toMatch(/^[0-9a-f]{16}$/)
    expect(String(ip)).not.toContain(SPOOF)
    expect(String(ip)).not.toContain(REAL)
  })

  it("só XFF forjado, sem fonte confiável que bata: null (nunca o valor do cliente)", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "edge,netlify"
    process.env.CLIENT_IP_HASH_SALT = SALT
    const ip = await log({ "x-forwarded-for": SPOOF, "x-real-ip": SPOOF })
    expect(ip).toBeNull()
  })

  it("sem sal: null (não grava IP em claro)", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "netlify"
    const ip = await log({ "x-nf-client-connection-ip": REAL, "x-forwarded-for": SPOOF })
    expect(ip).toBeNull()
  })

  it("modo legacy: usa o helper (último salto), nunca o 1º elemento do XFF", async () => {
    process.env.CLIENT_IP_HASH_SALT = SALT
    const ip = await log({ "x-forwarded-for": `${SPOOF}, 198.51.100.9` })
    expect(ip).toBe(clientIpHash("198.51.100.9", { CLIENT_IP_HASH_SALT: SALT }))
    expect(ip).not.toBe(clientIpHash(SPOOF, { CLIENT_IP_HASH_SALT: SALT }))
  })

  it("mesmo IP → mesmo hash (correlacionável entre eventos)", async () => {
    process.env.TRUSTED_CLIENT_IP_SOURCE = "netlify"
    process.env.CLIENT_IP_HASH_SALT = SALT
    const a = await log({ "x-nf-client-connection-ip": REAL })
    state.inserted = []
    const b = await log({ "x-nf-client-connection-ip": REAL, "x-forwarded-for": "1.2.3.4" })
    expect(a).toBe(b)
  })
})
