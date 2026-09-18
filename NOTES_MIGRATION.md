# NOTES_MIGRATION — Payment Gateway (abstração provider-agnostic)

> **Estado:** branch mantida **separada de propósito**. NÃO mergear em `main` até o gatilho abaixo.
> **Última atualização:** 2026-09-18 · **Base da branch:** `fbf46ee` (2026-02-03).
> Este guia viaja com a branch para quem for retomá-la. O `main` evoluiu muito
> desde 2026-02 (jornada de negociação, chatbot/n8n, Voxuy, home SEO); NÃO faça
> `git merge main` cru nem o inverso — porte os arquivos listados sobre o `main` atual.

## O que esta branch entrega

Uma camada **provider-agnostic** de gateway de pagamento, consumida **in-process
como biblioteca** (NÃO é um serviço HTTP deployado — não há Dockerfile nem
express/fastify; roda no mesmo processo Next/Netlify via alias TS `@payment-api/*`).

- `services/payment-api/src/interfaces/payment-provider.ts` — contrato
  `PaymentProvider` (createCustomer, createPayment, getPayment, refund, cancel,
  parseWebhook) com tipos normalizados.
- `services/payment-api/src/factory/payment-provider-factory.ts` —
  `createPaymentProvider(config)` com switch `asaas` | `custom` e **hard-block do
  custom em produção** (`CustomGatewayProductionBlockedError`).
- `services/payment-api/src/providers/asaas/asaas-adapter.ts` — wrapper **fino**
  que faz dynamic-import do `@/lib/asaas` de produção e normaliza os retornos.
  NÃO reimplementa a API ASAAS.
- `services/payment-api/src/providers/custom/*` — apenas simulador de modo teste.
- Extras **não usados pelo caminho do app**: `queue/payment-worker.ts`,
  `repositories/pg-transaction-repository.ts`, `security/*`. O
  `docker-compose.yml`/`init.sql` sobem um Postgres+Redis próprios (porta 5433)
  só para um log de transações OPCIONAL que o app nem injeta.
- **87 testes (vitest) em 10 arquivos** — boa maturidade de cobertura.

Mudanças no app (mínimas, atrás da flag `PAYMENT_PROVIDER`, default `asaas`):
- `app/actions/create-agreement.ts` — router: com `PAYMENT_PROVIDER` ausente ou
  `asaas`, chama o `createAgreementWithAsaas` atual (fluxo intocado).
- `app/actions/create-agreement-with-payment.ts` — fluxo que grava nas colunas
  `provider_*`.
- `app/api/webhooks/payment/route.ts` — webhook por `provider_payment_id`.
- `components/dashboard/negotiation-form-client.tsx` — passa a usar o router.
- `scripts/026_add_payment_provider_columns.sql` — migration aditiva.
- `tsconfig.json` — alias `@payment-api/* → ./services/payment-api/src/*`.

## Quando migrar (GATILHO)

**Só quando o produto decidir suportar um 2º gateway de pagamento real além do
ASAAS.** Enquanto o único provider real for o ASAAS, esta camada não rende ROI —
o adapter apenas embrulha o `lib/asaas` que já roda em produção. Manter dormente.

## Como migrar (~0,5–1 dia, sobre o `main` atual)

1. **Renumerar a migration.** `scripts/026_add_payment_provider_columns.sql`
   **colide** com o `026_fix_rls_final.sql` já em `main`. Renomear para o próximo
   número livre (ex. `030_add_payment_provider_columns.sql`) e aplicar em produção.
   Ela é aditiva/idempotente (`ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT
   EXISTS` + backfill idempotente `WHERE asaas_payment_id IS NOT NULL AND
   provider_payment_id IS NULL`). Aplicar com o padrão do repo (cliente `pg` com
   `ssl.rejectUnauthorized:false` escopado à conexão; NÃO usar
   `NODE_TLS_REJECT_UNAUTHORIZED=0` — o classificador bloqueia).
2. **Copiar** `services/payment-api/` e adicionar o alias `@payment-api/*` no
   `tsconfig.json`.
3. **Portar** os 3 arquivos de app (router `create-agreement.ts`,
   `create-agreement-with-payment.ts`, `app/api/webhooks/payment/route.ts`) sobre
   as versões atuais de `main` (que divergiram — porte, não faça merge cru).
4. **Rodar os 87 testes** (vitest) + typecheck no CI.
5. Manter `PAYMENT_PROVIDER=asaas` até o 2º provider estar validado.
6. **RECONCILIAR os 2 caminhos de webhook antes de virar a chave:** o
   `create-agreement-with-payment` grava só em `provider_*`, mas o webhook ASAAS
   legado (`/api/webhooks/asaas`) busca por `asaas_payment_id`. Coexistem com
   colunas diferentes — inócuo enquanto em `asaas`, mas precisa unificar antes de
   trocar o provider de verdade.

## Não é necessário

- Deploy de serviço novo (roda in-process no Netlify).
- Infra AWS adicional.
- O `docker-compose.yml`/log de transações (opcional; o app não injeta o repository).
