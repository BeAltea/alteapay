// QA round 1 — QAA1-08 (painel Abrir/Copiar deriva SEMPRE da bolha persistida,
// em qualquer viewport) e QAA1-07 / B2 / A1-R10 (link cancelado perde a ação
// viva no PRÓXIMO poll, inclusive incremental — sem F5).
//  - chat-display: paymentLinkActionOf (ação anexada ou derivada da URL da bolha
//    'payment_link'), isLivePaymentLink (live:false OU href terminal),
//    latestLivePaymentLinkId (só a ÚLTIMA viva ganha o painel);
//  - GET /api/chat/messages: `dead_payment_links` (hrefs das cobranças terminais
//    do cliente nesta empresa) em TODO poll, com e sem `since`; isolado por tenant;
//  - chat.tsx: o tick do intervalo não empilha um 2º GET com um poll em voo
//    (os "dois GETs sem since em 3 s" da evidência QAA1-08).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFakeSupabase, type FakeDb } from "./_fake-supabase"
import {
  isLivePaymentLink,
  latestLivePaymentLinkId,
  paymentLinkActionOf,
  type ChatMsg,
} from "@/components/journey/chat-display"

process.env.CHAT_JOURNEY_ENABLED = "true"
process.env.NEGOTIATION_JWT_SECRET = "test-secret-qa1-live"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"

const CO = "eeeeeeee-0000-0000-0000-000000qa1lv1"
const SID = "sess-qa1-live"
const CUST = "cust-qa1-live"
const DEBT = "debt-qa1-live"

let db: FakeDb
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => makeFakeSupabase(db) }))
vi.mock("@/lib/journey/events", () => ({ recordEvent: async () => ({ ok: true, duplicate: false }), getTimeline: async () => [] }))

const LIVE = {
  id: "ag-live", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_live", status: "active", payment_status: "pending", asaas_status: "PENDING",
  asaas_invoice_url: "https://asaas/i/live", asaas_payment_url: "https://asaas/i/live", asaas_boleto_url: null, asaas_pix_qrcode_url: null,
  agreed_amount: 250, installments: 1, due_date: "2026-10-01",
}
const DEAD = {
  id: "ag-dead", company_id: CO, customer_id: CUST, asaas_payment_id: "pay_dead", status: "cancelled", payment_status: "deleted", asaas_status: "PENDING",
  asaas_invoice_url: "https://asaas/i/dead", asaas_payment_url: "https://asaas/i/dead", asaas_boleto_url: "https://asaas/b/dead", asaas_pix_qrcode_url: null,
  agreed_amount: 250, installments: 1, due_date: "2026-09-28",
}

function seed() {
  db = {
    negotiation_sessions: [{ id: SID, company_id: CO, customer_id: CUST, debt_id: DEBT, agreement_id: LIVE.id, thread_epoch: 0 }],
    customers: [{ id: CUST, company_id: CO, name: "Fabio Mendes", document: "11144477735" }],
    companies: [{ id: CO, name: "VMAX LTDA" }],
    tenant_chat_config: [{ company_id: CO, branding: { brand_name: "VMAX" } }],
    debts: [{ id: DEBT, company_id: CO, customer_id: CUST, status: "pending", amount: 250, due_date: "2026-08-15" }],
    vmax_invoices: [],
    agreements: [LIVE, DEAD],
    chat_messages: [], chat_prompts: [],
  }
}
async function getMessages(since?: string) {
  const { GET } = await import("@/app/api/chat/messages/route")
  const { signChatJwt } = await import("@/lib/negotiation/crypto")
  const cookie = signChatJwt({ sid: SID, cid: CO }, 3600)
  const res = await GET({
    cookies: { get: (n: string) => (n === "alteapay_chat_session" ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams(since ? `since=${encodeURIComponent(since)}` : "") },
  } as any)
  return res.json()
}

const linkAction = (href: string, extra: Partial<ChatMsg["action"] & object> = {}) => ({ type: "open_payment_link", label: "Abrir link de pagamento", href, ...extra })
function asst(id: string, text: string, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { id, from: "assistant", text, action: null, promptId: null, ...extra }
}

describe("chat-display — o painel deriva da bolha persistida (QAA1-08)", () => {
  it("paymentLinkActionOf: ação anexada; sem ação mas stage payment_link com URL no texto → derivada; external_link/sem stage → null", () => {
    const withAction = asst("a", "Aqui está seu link\nhttps://asaas/i/1", { action: linkAction("https://asaas/i/1"), stage: "payment_link" })
    expect(paymentLinkActionOf(withAction)).toEqual(linkAction("https://asaas/i/1"))
    const noAction = asst("b", "Aqui está seu link para pagar R$ 250,00, válido até 28/09/2026.\nhttps://asaas/i/2", { stage: "payment_link" })
    expect(paymentLinkActionOf(noAction)).toEqual({ type: "open_payment_link", label: "Abrir link de pagamento", href: "https://asaas/i/2" })
    expect(paymentLinkActionOf(asst("c", "Texto com https://x.test/u sem stage"))).toBeNull()
    expect(paymentLinkActionOf(asst("d", "Contato", { action: { type: "external_link", label: "Contato", href: "https://x.test/c" } }))).toBeNull()
    expect(paymentLinkActionOf({ id: "e", from: "customer", text: "https://asaas/i/3", action: null, stage: "payment_link" })).toBeNull()
    // live:false é propagado (não é "derivado" de novo como vivo)
    const dead = asst("f", "x\nhttps://asaas/i/4", { action: linkAction("https://asaas/i/4", { live: false }), stage: "payment_link" })
    expect(paymentLinkActionOf(dead)?.live).toBe(false)
  })

  it("isLivePaymentLink: vivo por padrão; live:false → morto; href em dead_payment_links → morto (QAA1-07)", () => {
    const dead = new Set(["https://asaas/i/dead"])
    expect(isLivePaymentLink(linkAction("https://asaas/i/live"), dead)).toBe(true)
    expect(isLivePaymentLink(linkAction("https://asaas/i/live"), null)).toBe(true)
    expect(isLivePaymentLink(linkAction("https://asaas/i/live", { live: false }), dead)).toBe(false)
    expect(isLivePaymentLink(linkAction("https://asaas/i/dead"), dead)).toBe(false)
    expect(isLivePaymentLink(null, dead)).toBe(false)
    expect(isLivePaymentLink({ type: "external_link", label: "x", href: "https://asaas/i/live" }, dead)).toBe(false)
  })

  it("latestLivePaymentLinkId: só a ÚLTIMA bolha VIVA ganha o painel; cancelada (por live:false ou por href terminal) nunca", () => {
    const list: ChatMsg[] = [
      asst("m1", "link 1\nhttps://asaas/i/1", { action: linkAction("https://asaas/i/1"), stage: "payment_link" }),
      asst("m2", "link 2\nhttps://asaas/i/2", { action: linkAction("https://asaas/i/2"), stage: "payment_link" }),
      asst("m3", "Como prefere seguir?"),
    ]
    expect(latestLivePaymentLinkId(list, new Set())).toBe("m2")
    // a 2ª foi cancelada no ASAAS (webhook) → o poll seguinte traz o href em dead_payment_links
    expect(latestLivePaymentLinkId(list, new Set(["https://asaas/i/2"]))).toBe("m1")
    // ambas mortas → nenhum painel
    expect(latestLivePaymentLinkId(list, new Set(["https://asaas/i/1", "https://asaas/i/2"]))).toBeNull()
    // servidor marcou live:false na retomada
    list[1].action = linkAction("https://asaas/i/2", { live: false })
    expect(latestLivePaymentLinkId(list, new Set())).toBe("m1")
    // bolha persistida SEM message_action (shape malformado): o painel ainda deriva dela
    const derived: ChatMsg[] = [asst("d1", "Aqui está seu link\nhttps://asaas/i/9", { stage: "payment_link" })]
    expect(latestLivePaymentLinkId(derived, new Set())).toBe("d1")
  })
})

describe("GET /api/chat/messages — dead_payment_links em todo poll (QAA1-07)", () => {
  beforeEach(seed)

  it("sem `since`: traz os hrefs das cobranças TERMINAIS do cliente (invoice/payment/boleto), nunca os da viva", async () => {
    const body = await getMessages()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.dead_payment_links)).toBe(true)
    expect(body.dead_payment_links).toEqual(expect.arrayContaining(["https://asaas/i/dead", "https://asaas/b/dead"]))
    expect(body.dead_payment_links).not.toContain("https://asaas/i/live")
  })

  it("COM `since` (poll incremental, bolha do link já fora da janela): dead_payment_links continua vindo → a bolha antiga perde a ação no próximo ciclo", async () => {
    db.chat_messages = [{
      id: "m-link", company_id: CO, session_id: SID, role: "assistant", prompt_id: null,
      text: "Aqui está seu link\nhttps://asaas/i/dead", created_at: "2026-09-25T10:00:00Z",
      offers_snapshot: { stage: "payment_link", agreement_id: DEAD.id, message_action: linkAction("https://asaas/i/dead") },
    }]
    const body = await getMessages("2026-09-25T10:00:01Z")
    expect(body.messages.length).toBe(0) // a bolha não volta no incremental…
    expect(body.dead_payment_links).toContain("https://asaas/i/dead") // …mas o client sabe que o link morreu
    // e a regra pura do client desliga o painel dela com isso
    const msg: ChatMsg = { id: "m-link", from: "assistant", text: "x", action: linkAction("https://asaas/i/dead"), stage: "payment_link" }
    expect(latestLivePaymentLinkId([msg], new Set(body.dead_payment_links))).toBeNull()
  })

  it("isolamento: acordo terminal de OUTRA empresa / outro cliente nunca entra; sem cobrança terminal → []", async () => {
    db.agreements = [
      { ...DEAD, id: "ag-other-co", company_id: "outra-empresa", asaas_invoice_url: "https://asaas/i/other-co" },
      { ...DEAD, id: "ag-other-cust", customer_id: "outro-cliente", asaas_invoice_url: "https://asaas/i/other-cust" },
      LIVE,
    ]
    const body = await getMessages()
    expect(body.dead_payment_links).toEqual([])
  })
})

describe("chat.tsx — wire-up (leitura do fonte)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "journey", "chat.tsx"), "utf8")

  it("o tick do intervalo não empilha um 2º GET com um poll em voo; dead_payment_links é consumido a cada poll", () => {
    expect(src).toContain("pollMessages({ skipIfInFlight: true })")
    expect(src).toContain("if (opts?.skipIfInFlight && pollInFlightRef.current) return")
    expect(src).toContain("data?.dead_payment_links")
    expect(src).toContain("setDeadLinkHrefs(deadHrefs)")
  })

  it("o painel Abrir/Copiar e o 'link entregue' derivam de paymentLinkActionOf/isLivePaymentLink (nunca de m.action cru)", () => {
    expect(src).toContain("latestLivePaymentLinkId(messages, deadLinkHrefs)")
    expect(src).toContain("m.id === latestPaymentLinkId && paymentLinkActionOf(m)")
    expect(src).toContain("isLivePaymentLink(action, deadHrefs)")
    expect(src).not.toMatch(/m\.action\?\.type === "open_payment_link" &&\s*m\.action\.live !== false/)
  })
})
