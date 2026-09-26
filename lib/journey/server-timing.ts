// QA rodada 5 (Q2-01) — medição por etapa do clique PAGAR via `Server-Timing`.
//
// Cada etapa relevante do caminho da cobrança (guard, fechamento, ASAAS customer,
// ASAAS payment, write-back, entrega do link) registra a duração num coletor
// por request (AsyncLocalStorage — sem estado global entre requests). A rota
// anexa tudo ao header `Server-Timing` (sem PII: só nomes fixos e ms).
// Fora de um `runWithTimings`, `timed` só executa a função (testes/workers).
import { AsyncLocalStorage } from "node:async_hooks"

type Store = Map<string, number>

const als = new AsyncLocalStorage<Store>()

/** Executa `fn` com um coletor de etapas; devolve o resultado e as etapas. */
export async function runWithTimings<T>(fn: () => Promise<T>): Promise<{ result: T; timings: Store }> {
  const store: Store = new Map()
  const result = await als.run(store, fn)
  return { result, timings: store }
}

/** Soma `ms` na etapa `name` do coletor corrente (no-op fora de runWithTimings). */
export function addTiming(name: string, ms: number): void {
  const store = als.getStore()
  if (!store) return
  store.set(name, (store.get(name) ?? 0) + Math.max(0, Math.round(ms)))
}

/** Mede a duração de `fn` na etapa `name` (também em caso de erro). */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now()
  try {
    return await fn()
  } finally {
    addTiming(name, Date.now() - t)
  }
}

/** Formata as etapas no padrão `nome;dur=ms, ...` (nomes seguros para header). */
export function formatServerTiming(timings: Map<string, number>): string {
  return Array.from(timings.entries())
    .filter(([name]) => /^[a-z0-9_]+$/i.test(name))
    .map(([name, ms]) => `${name};dur=${ms}`)
    .join(", ")
}
