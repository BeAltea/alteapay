// §C3: indicador "trabalhando" server-side após o Negociar. recordWorkingPlaceholder
// grava uma bolha do assistente ("Estou preparando sua negociação…") que o poller
// exibe IMEDIATAMENTE (sem mudança no cliente) enquanto o negotiation.start viaja
// ao n8n. Dedup por CONTEÚDO (janela 15min): re-cliques/re-entradas nunca empilham.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"

const CO = "eeeeeeee-0000-0000-0000-000000000099"
const SID = "sess-work-1"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))

function reset() {
  db = { chat_messages: [] }
}

describe("recordWorkingPlaceholder (§C3)", () => {
  beforeEach(reset)

  it("grava a bolha 'Estou preparando…' do assistente (engine=platform)", async () => {
    const { recordWorkingPlaceholder, WORKING_PLACEHOLDER_TEXT } = await import("@/lib/journey/chat-turn")
    await recordWorkingPlaceholder({ companyId: CO, sessionId: SID })
    expect(db.chat_messages.length).toBe(1)
    const msg = db.chat_messages[0]
    expect(msg.role).toBe("assistant")
    expect(msg.text).toBe(WORKING_PLACEHOLDER_TEXT)
    expect(msg.engine).toBe("platform")
    expect(msg.session_id).toBe(SID)
    expect(msg.company_id).toBe(CO)
  })

  it("carrega dados neutros (sem PII: valor/venc/documento)", async () => {
    const { recordWorkingPlaceholder } = await import("@/lib/journey/chat-turn")
    await recordWorkingPlaceholder({ companyId: CO, sessionId: SID })
    const json = JSON.stringify(db.chat_messages[0])
    expect(json).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/) // sem CPF
    expect(json).not.toMatch(/R\$\s*\d/) // sem valor
  })

  it("dedup por conteúdo: 3 chamadas na mesma sessão → 1 só placeholder", async () => {
    const { recordWorkingPlaceholder } = await import("@/lib/journey/chat-turn")
    await recordWorkingPlaceholder({ companyId: CO, sessionId: SID })
    await recordWorkingPlaceholder({ companyId: CO, sessionId: SID })
    await recordWorkingPlaceholder({ companyId: CO, sessionId: SID })
    expect(db.chat_messages.length).toBe(1) // mantém só a última (uma)
  })

  it("sessões distintas NÃO compartilham dedup (cada uma tem seu placeholder)", async () => {
    const { recordWorkingPlaceholder } = await import("@/lib/journey/chat-turn")
    await recordWorkingPlaceholder({ companyId: CO, sessionId: "sess-A" })
    await recordWorkingPlaceholder({ companyId: CO, sessionId: "sess-B" })
    expect(db.chat_messages.length).toBe(2)
  })
})
