/**
 * Mock mode gates for outbound third-party integrations.
 *
 * When a service is in mock mode, its lowest-level HTTP/SDK call
 * short-circuits and returns a realistic in-process response instead of
 * leaving the process. Used for local/training environments seeded with
 * production data where real customers must never be contacted.
 *
 * Env contract (each defaults to real mode when unset):
 * - ASAAS_MODE=mock
 * - SENDGRID_MODE=mock
 * - TWILIO_MODE=mock
 * - ASSERTIVA_MODE=mock
 * - MOCK_ALL_INTEGRATIONS=1 forces mock for all services.
 */

export type MockableService = "asaas" | "sendgrid" | "twilio" | "assertiva" | "voxuy" | "n8n"

const MODE_ENV_VAR: Record<MockableService, string> = {
  asaas: "ASAAS_MODE",
  sendgrid: "SENDGRID_MODE",
  twilio: "TWILIO_MODE",
  assertiva: "ASSERTIVA_MODE",
  voxuy: "VOXUY_MODE",
  n8n: "N8N_MODE",
}

export function isMockMode(service: MockableService): boolean {
  if (process.env.MOCK_ALL_INTEGRATIONS === "1") {
    return true
  }
  return process.env[MODE_ENV_VAR[service]] === "mock"
}

/**
 * Deterministic hex string derived from the input (FNV-1a based).
 * Used to build stable mock ids like `cus_mock_<12 hex>` without exposing PII.
 */
export function mockHex(input: string, length = 12): string {
  let out = ""
  for (let round = 0; out.length < length; round++) {
    let h = 0x811c9dc5
    const s = `${round}:${input}`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, "0")
  }
  return out.slice(0, length)
}
