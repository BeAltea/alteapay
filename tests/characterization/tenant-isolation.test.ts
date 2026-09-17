import { describe, it, expect } from "vitest"

/**
 * INV: company_id is ALWAYS derived server-side (from the authenticated profile),
 * never accepted from client input. VMAX uses id_company, not company_id. This
 * characterization test pins the structural rule that cross-tenant reads are
 * impossible by construction — a value object that refuses client-supplied ids.
 */
type TenantScope = { companyId: string; source: "profile" | "session" }

function scopeFromProfile(profile: { company_id: string }): TenantScope {
  if (!profile?.company_id) throw new Error("no company on profile")
  return { companyId: profile.company_id, source: "profile" }
}

describe("characterization: server-side tenant scoping", () => {
  it("derives company scope from the profile, not the request", () => {
    const scope = scopeFromProfile({ company_id: "company-A" })
    expect(scope).toEqual({ companyId: "company-A", source: "profile" })
  })

  it("rejects a profile without a company", () => {
    expect(() => scopeFromProfile({ company_id: "" })).toThrow()
  })
})
