import { beforeAll, describe, expect, it } from "vitest"

beforeAll(() => {
  process.env.NEGOTIATION_JWT_SECRET = "test-secret-with-enough-length-123456"
})

describe("negotiation crypto", () => {
  it("gera token opaco de 32 bytes e hash sha256 estável", async () => {
    const { generateHandoffToken, sha256Hex } = await import("@/lib/negotiation/crypto")
    const { token, tokenHash } = generateHandoffToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(tokenHash).toBe(sha256Hex(token))
    expect(generateHandoffToken().token).not.toBe(token)
  })

  it("JWT de sessão: assina, verifica e rejeita adulteração", async () => {
    const { signChatJwt, verifyChatJwt } = await import("@/lib/negotiation/crypto")
    const jwt = signChatJwt({ sid: "s-1", cid: "c-1" })
    const claims = verifyChatJwt(jwt)
    expect(claims).toMatchObject({ sid: "s-1", cid: "c-1" })

    const [h, p, s] = jwt.split(".")
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sid: "s-1", cid: "OUTRA-COMPANY", exp: Math.floor(Date.now() / 1000) + 9999 }),
    ).toString("base64url")
    expect(verifyChatJwt(`${h}.${tamperedPayload}.${s}`)).toBeNull()
    expect(verifyChatJwt("lixo")).toBeNull()
  })

  it("JWT expirado é rejeitado", async () => {
    const { signChatJwt, verifyChatJwt } = await import("@/lib/negotiation/crypto")
    const jwt = signChatJwt({ sid: "s-1", cid: "c-1" }, -10)
    expect(verifyChatJwt(jwt)).toBeNull()
  })
})
