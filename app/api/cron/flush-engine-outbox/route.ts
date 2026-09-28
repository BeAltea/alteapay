// N8N-10: dreno do engine_outbox (session.start / negotiation.start → n8n) que
// NÃO depende do worker Fargate. Chamado a cada minuto pela scheduled function
// do Netlify (netlify/functions/engine-outbox-drain.mjs) e, se preciso, à mão.
//
// Auth server-a-servidor: `Authorization: Bearer ${CRON_SECRET}` (comparação em
// tempo constante; CRON_SECRET vazio → sempre 401). Devolve SÓ contagens —
// nunca payload, URL, segredo ou PII.
//
// Inerte quando não há o que fazer: jornada desligada, engine 'disabled' ou
// tabela ausente (migration pendente → no-op explícito, 1 leitura).
import { NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { engineName } from "@/lib/negotiation/engine"
import { flushOutbox } from "@/lib/negotiation/outbox"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"
export const revalidate = 0

/** Orçamento do dreno por chamada (ms), abaixo do timeout da função no Netlify. */
function budgetMs(): number {
  const n = Number(process.env.ENGINE_OUTBOX_DRAIN_BUDGET_MS)
  return Number.isFinite(n) && n > 0 ? n : 8_000
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const got = Buffer.from(request.headers.get("authorization") ?? "")
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (process.env.CHAT_JOURNEY_ENABLED !== "true" || engineName() === "disabled") {
    return NextResponse.json({ ok: true, skipped: "engine_disabled" })
  }
  const result = await flushOutbox({ limit: 50, budgetMs: budgetMs() })
  if (result.scanned > 0) {
    console.log(
      `[cron:engine-outbox] scanned=${result.scanned} sent=${result.sent} failed=${result.failed} pending=${result.pending}`,
    )
  }
  return NextResponse.json({ ok: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
