import { describe, expect, it, beforeAll } from "vitest"
import { issueActionCsrf, verifyActionCsrf } from "@/lib/journey/optout"

beforeAll(() => {
  process.env.CHAT_SESSION_SECRET = "test-csrf-secret"
})

describe("CSRF de ação (V4.3 — prefetch-safe)", () => {
  it("um csrf emitido valida para o mesmo token+purpose", () => {
    const csrf = issueActionCsrf("tok-abc", "optout")
    expect(verifyActionCsrf(csrf, "tok-abc", "optout")).toBe(true)
  })

  it("não valida cruzando purpose", () => {
    const csrf = issueActionCsrf("tok-abc", "optout")
    expect(verifyActionCsrf(csrf, "tok-abc", "block")).toBe(false)
  })

  it("não valida com token diferente", () => {
    const csrf = issueActionCsrf("tok-abc", "block")
    expect(verifyActionCsrf(csrf, "tok-xyz", "block")).toBe(false)
  })

  it("rejeita csrf malformado", () => {
    expect(verifyActionCsrf("", "tok", "optout")).toBe(false)
    expect(verifyActionCsrf("garbage", "tok", "optout")).toBe(false)
    expect(verifyActionCsrf("123.abc", "tok", "optout")).toBe(false)
  })

  it("rejeita csrf expirado (timestamp antigo)", () => {
    // forja um timestamp de 20 min atrás com um mac inválido: expira antes de checar mac
    const oldTs = (Date.now() - 20 * 60 * 1000).toString()
    expect(verifyActionCsrf(`${oldTs}.qualquer`, "tok", "optout")).toBe(false)
  })
})
