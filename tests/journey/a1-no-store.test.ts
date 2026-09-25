// A1 / N1 (BLOQUEANTE) — leituras da jornada SEM cache.
//
// Produção servia o `active_prompt` e o delta de mensagens congelados (Data Cache
// do Next 14 sobre o `fetch` do supabase-js no runtime Netlify). Dois guards:
//  (a) createServiceClient() injeta `fetch` com cache:'no-store' POR PADRÃO (o
//      opt-out é explícito: { noStore:false });
//  (b) toda rota app/api/chat/**/route.ts (e o webhook n8n) declara
//      dynamic="force-dynamic" + fetchCache="force-no-store" + revalidate=0.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const captured: Array<{ url: string; key: string; opts: Record<string, unknown> | undefined }> = []
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, opts?: Record<string, unknown>) => {
    captured.push({ url, key, opts })
    return { from: () => ({}) }
  },
}))

describe("(a) createServiceClient — no-store por padrão", () => {
  beforeEach(() => {
    captured.length = 0
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  })

  it("default: injeta global.fetch que força cache:'no-store' em toda chamada", async () => {
    const { createServiceClient } = await import("@/lib/supabase/service")
    createServiceClient()
    expect(captured.length).toBe(1)
    const global = captured[0].opts?.global as { fetch?: (i: unknown, init?: RequestInit) => unknown } | undefined
    expect(typeof global?.fetch).toBe("function")

    const seen: Array<RequestInit | undefined> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init)
      return new Response("[]", { status: 200 })
    }) as typeof fetch
    try {
      await global!.fetch!("https://example.supabase.co/rest/v1/chat_prompts", { method: "GET", headers: { a: "b" } })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(seen.length).toBe(1)
    expect(seen[0]?.cache).toBe("no-store")
    // os demais campos do init são preservados
    expect(seen[0]?.method).toBe("GET")
    expect((seen[0]?.headers as Record<string, string>).a).toBe("b")
  })

  it("{ noStore: true } explícito continua injetando no-store (compat com quem já usava)", async () => {
    const { createServiceClient } = await import("@/lib/supabase/service")
    createServiceClient({ noStore: true })
    const global = captured[0].opts?.global as { fetch?: unknown } | undefined
    expect(typeof global?.fetch).toBe("function")
  })

  it("{ noStore: false } é o opt-out explícito (sem fetch injetado)", async () => {
    const { createServiceClient } = await import("@/lib/supabase/service")
    createServiceClient({ noStore: false })
    expect(captured[0].opts?.global).toBeUndefined()
  })

  it("sem credenciais → lança (nunca cria client mudo)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const { createServiceClient } = await import("@/lib/supabase/service")
    expect(() => createServiceClient()).toThrow()
  })
})

function walkRoutes(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkRoutes(full))
    else if (name === "route.ts") out.push(full)
  }
  return out
}

describe("(b) varredura: rotas da jornada declaram force-dynamic + force-no-store + revalidate 0", () => {
  const root = process.cwd()
  const chatRoutes = walkRoutes(join(root, "app", "api", "chat"))
  const n8nRoute = join(root, "app", "api", "webhooks", "n8n", "route.ts")
  const all = [...chatRoutes, n8nRoute]

  it("há rotas em app/api/chat/** (a varredura não está vazia)", () => {
    expect(chatRoutes.length).toBeGreaterThanOrEqual(10)
  })

  for (const file of all) {
    const rel = file.slice(root.length + 1)
    it(`${rel}: dynamic="force-dynamic" + fetchCache="force-no-store" + revalidate=0`, () => {
      const src = readFileSync(file, "utf8")
      expect(src).toMatch(/export const dynamic = "force-dynamic"/)
      expect(src).toMatch(/export const fetchCache = "force-no-store"/)
      expect(src).toMatch(/export const revalidate = 0/)
    })
  }

  it("nenhum módulo da jornada faz opt-out do no-store", () => {
    const libDir = join(root, "lib", "journey")
    const files = readdirSync(libDir).filter((f) => f.endsWith(".ts"))
    for (const f of files) {
      const src = readFileSync(join(libDir, f), "utf8")
      expect(src, f).not.toMatch(/createServiceClient\(\s*\{\s*noStore:\s*false/)
    }
  })
})
