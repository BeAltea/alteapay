// Backfill one-off: desliga TODAS as notificações do ASAAS em clientes já
// existentes (política: o ASAAS não comunica o devedor; toda comunicação via
// AlteaPay). Percorre GET /customers e faz PUT notificationDisabled=true nos que
// ainda estão com notificação ligada. Idempotente (pula os já desligados).
//
// Roda no runtime de PRODUÇÃO (onde ASAAS_API_KEY existe) — a chave nunca sai.
// Auth server-a-servidor por Bearer CRON_SECRET. Resumível por ?offset= para não
// estourar o timeout do serverless. Dry-run por padrão: exige ?apply=true.
import { NextRequest, NextResponse } from "next/server"
import { updateAsaasCustomer } from "@/lib/asaas"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const ASAAS_API_URL = process.env.ASAAS_API_URL || "https://api.asaas.com/v3"

interface AsaasCustomerLite {
  id: string
  notificationDisabled?: boolean
}

async function listCustomers(offset: number, limit: number): Promise<{
  data: AsaasCustomerLite[]
  hasMore: boolean
  totalCount: number
}> {
  const key = process.env.ASAAS_API_KEY
  if (!key) throw new Error("ASAAS_API_KEY ausente no runtime")
  // retry simples de 429 (ASAAS limita ~10 req/s)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${ASAAS_API_URL}/customers?limit=${limit}&offset=${offset}`, {
      headers: { access_token: key },
      cache: "no-store",
    })
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") ?? 2) * 1000 + 1500
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    const json = await res.json()
    if (!res.ok) throw new Error(json?.errors?.[0]?.description || `ASAAS list erro ${res.status}`)
    return { data: json.data ?? [], hasMore: Boolean(json.hasMore), totalCount: Number(json.totalCount ?? 0) }
  }
  throw new Error("ASAAS list: 429 após retries")
}

export async function POST(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const url = new URL(request.url)
  const apply = url.searchParams.get("apply") === "true"
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 100)
  const startOffset = Number(url.searchParams.get("offset") ?? 0)
  // teto de clientes processados por invocação (para caber no timeout); o chamador
  // reinvoca com o nextOffset devolvido até hasMore=false.
  const maxPerCall = Math.min(Number(url.searchParams.get("max") ?? 300), 500)

  let offset = startOffset
  let scanned = 0
  let alreadyDisabled = 0
  let updated = 0
  const errors: Array<{ id: string; error: string }> = []
  let totalCount = 0
  let hasMore = true

  while (scanned < maxPerCall) {
    const page = await listCustomers(offset, limit)
    totalCount = page.totalCount
    if (page.data.length === 0) { hasMore = false; break }
    for (const c of page.data) {
      scanned++
      if (c.notificationDisabled === true) { alreadyDisabled++; continue }
      if (!apply) { updated++; continue } // dry-run: conta quantos seriam atualizados
      try {
        await updateAsaasCustomer(c.id, { notificationDisabled: true })
        updated++
        await new Promise((r) => setTimeout(r, 120)) // ~8 req/s, respeita o rate-limit
      } catch (e) {
        errors.push({ id: c.id, error: (e as Error).message })
      }
    }
    offset += page.data.length
    hasMore = page.hasMore
    if (!page.hasMore) break
  }

  return NextResponse.json({
    mode: apply ? "APPLIED" : "DRY_RUN",
    totalCount,
    scanned,
    alreadyDisabled,
    updated: apply ? updated : undefined,
    wouldUpdate: apply ? undefined : updated,
    errors: errors.length ? errors.slice(0, 20) : [],
    errorCount: errors.length,
    nextOffset: offset,
    hasMore,
  })
}
