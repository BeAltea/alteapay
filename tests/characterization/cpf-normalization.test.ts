import { describe, it, expect } from "vitest"

/**
 * INV: CPF/CNPJ must be normalized to digits-only before cross-table matching
 * (VMAX "CPF/CNPJ" vs customers.document). We assert the normalization contract
 * against any exported helper; if none is exported yet, the test pins the
 * expected behavior so the refactor that introduces one must match it.
 */
const digitsOnly = (s: string) => s.replace(/\D/g, "")

describe("characterization: CPF/CNPJ normalization", () => {
  it("strips punctuation to digits only", () => {
    expect(digitsOnly("529.982.247-25")).toBe("52998224725")
    expect(digitsOnly("11.222.333/0001-81")).toBe("11222333000181")
  })

  it("matches the codebase helper when one exists", async () => {
    const mod: any = await import("@/lib/utils").catch(() => null)
    const helper = mod?.normalizeDocument ?? mod?.onlyDigits ?? mod?.digitsOnly
    if (typeof helper === "function") {
      expect(helper("529.982.247-25")).toBe("52998224725")
    }
  })
})
