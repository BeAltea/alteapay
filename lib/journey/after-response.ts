// Latência (ops/negociacao-final/10-latencia.md) — trabalho OPCIONAL fora do
// caminho da resposta ao devedor.
//
// Em produção as funções do Netlify rodam em us-east-2 e o Supabase em
// sa-east-1: cada ida ao banco custa ~150 ms. Escritas que não mudam o que o
// devedor vê (projeção negotiation_state, telemetria, disparo best-effort ao n8n)
// não precisam segurar a resposta. Mas numa função serverless o trabalho depois
// da resposta pode ser congelado/perdido — por isso a regra:
//
//   - a plataforma expõe `waitUntil` (Next 14 lê `Symbol.for('@next/request-context')`,
//     que o runtime do Netlify (@netlify/plugin-nextjs v5) preenche com o
//     `context.waitUntil` da função) → o trabalho roda depois da resposta e a
//     função só termina quando ele acaba;
//   - sem `waitUntil` → roda INLINE (o chamador espera, como antes). Nunca
//     arriscamos perder a escrita por um ganho de latência;
//   - `AFTER_RESPONSE_MODE=background` (servidor local de longa duração, medição)
//     → dispara e segue sem esperar.
//
// Só vai para cá o que é OPCIONAL por natureza. Escritas de auditoria que provam
// uma decisão do devedor (reconhecimento, aceite, acordo, cobrança) continuam no
// caminho, apenas em paralelo quando independentes.

const NEXT_REQUEST_CONTEXT = Symbol.for("@next/request-context")

type WaitUntil = (p: Promise<unknown>) => void

export type AfterResponseMode = "wait_until" | "background" | "inline"

function platformWaitUntil(): WaitUntil | null {
  try {
    const holder = (globalThis as Record<symbol, unknown>)[NEXT_REQUEST_CONTEXT] as
      | { get?: () => { waitUntil?: unknown } | undefined }
      | undefined
    const ctx = holder?.get?.()
    const fn = ctx?.waitUntil
    if (typeof fn !== "function") return null
    return (p) => (fn as (p: Promise<unknown>) => void).call(ctx, p)
  } catch {
    return null
  }
}

/** Como o trabalho pós-resposta será executado nesta request (para o Server-Timing). */
export function afterResponseMode(): AfterResponseMode {
  if (platformWaitUntil()) return "wait_until"
  return process.env.AFTER_RESPONSE_MODE === "background" ? "background" : "inline"
}

/**
 * Agenda `work` para depois da resposta quando é seguro (ver cabeçalho). Devolve
 * uma promise que o chamador DEVE aguardar: resolve na hora quando o trabalho
 * foi deferido, ou quando o trabalho termina no modo inline. NUNCA rejeita — a
 * falha vira um aviso curto (sem PII), como já era nas escritas best-effort.
 */
export function runAfterResponse(label: string, work: () => Promise<unknown>): Promise<void> {
  const run = (): Promise<void> =>
    Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        (err: unknown) => {
          console.warn(`[after-response] ${label} falhou (não-fatal):`, (err as Error)?.message ?? String(err))
        },
      )
  const waitUntil = platformWaitUntil()
  if (waitUntil) {
    const p = run()
    try {
      waitUntil(p)
      return Promise.resolve()
    } catch {
      return p
    }
  }
  if (process.env.AFTER_RESPONSE_MODE === "background") {
    void run()
    return Promise.resolve()
  }
  return run()
}

/**
 * Dispara `work` FORA do caminho da resposta e NUNCA é aguardado — nem no modo
 * inline. Para entregas que já são duráveis por outro meio (o `engine_outbox`
 * do N8N-10: a linha fica 'pending' e um dos drenos reentrega). Com `waitUntil`
 * a função só termina quando o trabalho acaba; sem ele o trabalho segue solto.
 * É o ÚNICO ponto que registra trabalho pós-resposta no runtime (a entrega do
 * outbox usa este helper). NUNCA rejeita.
 */
export function deferAfterResponse(label: string, work: () => Promise<unknown>): void {
  const p = Promise.resolve()
    .then(work)
    .then(
      () => undefined,
      (err: unknown) => {
        console.warn(`[after-response] ${label} falhou (não-fatal):`, err instanceof Error ? err.name : "error")
      },
    )
  const waitUntil = platformWaitUntil()
  if (!waitUntil) return
  try {
    waitUntil(p)
  } catch {
    // sem request-context utilizável: segue solto (p já está em andamento).
  }
}

// Encadeamento por chave (ex.: projeção por devedor): trabalhos com a MESMA
// chave rodam em série dentro da instância, na ordem em que foram agendados —
// a projeção negotiation_state é ler→aplicar→regravar e dois eventos do mesmo
// devedor em paralelo podiam se sobrescrever.
const chains = new Map<string, Promise<void>>()

export function serializeByKey(key: string, work: () => Promise<unknown>): Promise<void> {
  // `prev` nunca rejeita (guardamos a versão `settled`).
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(() => work()).then(() => undefined)
  const settled = next.catch(() => undefined)
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return next
}
