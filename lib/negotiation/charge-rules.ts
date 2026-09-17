// Espelho da tabela de descontos à vista do rules engine do agente
// (alteapay-agents/agents/negotiation/config/charge_rules.yaml). O agente é a
// fonte de verdade na conversa (valida a oferta antes do WS-5); este espelho
// garante que o acordo gravado use o MESMO percentual do bucket de aging.
// Qualquer mudança lá exige mudança aqui — pinado por characterization test.

export const CASH_DISCOUNT_BUCKETS = [
  { minDays: 366, pct: 35 },
  { minDays: 181, pct: 25 },
  { minDays: 90, pct: 15 },
  { minDays: 0, pct: 5 },
] as const

export function cashDiscountPctForAging(agingDays: number): number {
  for (const bucket of CASH_DISCOUNT_BUCKETS) {
    if (agingDays >= bucket.minDays) return bucket.pct
  }
  return 5
}
