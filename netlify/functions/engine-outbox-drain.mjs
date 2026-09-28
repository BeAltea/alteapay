// N8N-10: scheduled function do Netlify — a cada minuto chama o dreno do
// engine_outbox (/api/cron/flush-engine-outbox) com Bearer CRON_SECRET. É o que
// entrega o session.start/negotiation.start pendente SEM depender do worker
// Fargate. Scheduled functions só rodam em deploys PUBLICADOS de produção.
//
// Sem CRON_SECRET/URL → não faz nada. Nunca loga segredo, URL ou corpo.

export default async () => {
  const base = process.env.URL
  const secret = process.env.CRON_SECRET
  if (!base || !secret) return new Response(null, { status: 204 })
  try {
    const resp = await fetch(`${base.replace(/\/+$/, "")}/api/cron/flush-engine-outbox`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!resp.ok) console.warn(`[engine-outbox-drain] dreno respondeu ${resp.status}`)
    await resp.text().catch(() => "")
  } catch (err) {
    console.warn("[engine-outbox-drain] dreno falhou:", err instanceof Error ? err.name : "error")
  }
  return new Response(null, { status: 204 })
}

export const config = {
  schedule: "* * * * *",
}
