// GET /api/debug/client-ip — diagnóstico do F-4 (fonte confiável do IP do
// cliente na Netlify). DESLIGADO por padrão: só responde com
// CLIENT_IP_DEBUG_TOKEN (≥ 24 chars) configurado e o mesmo token no header
// `x-debug-token` (ou `?token=`, para testar do navegador do celular no 4G).
// Sem isso → 404 (não revela que existe).
//
// Resposta: para cada fonte candidata (x-nf-client-connection-ip, cabeçalho
// assinado do middleware de borda, cada elemento do X-Forwarded-For, helper
// legado), se existe e o HASH salgado do valor (CLIENT_IP_HASH_SALT) — nunca o
// IP em claro. Com `?expect=<seu IP público>`, diz qual fonte bate com ele.
// Procedimento: ops/negociacao-final/12-rate-limit-e-ip.md §5.

import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"

import { clientIpDiagnostics } from "@/lib/http/client-ip"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

function tokenOk(given: string | null): boolean {
  const want = process.env.CLIENT_IP_DEBUG_TOKEN ?? ""
  if (want.length < 24 || !given) return false
  const a = Buffer.from(want)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (!tokenOk(request.headers.get("x-debug-token") ?? url.searchParams.get("token"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const diag = clientIpDiagnostics(request.headers, { expected: url.searchParams.get("expect") })
  // Só hashes/booleans — seguro para log (telemetria do rollout).
  console.log("[client-ip:diag]", JSON.stringify(diag))
  return NextResponse.json(diag, { headers: { "Cache-Control": "no-store" } })
}
