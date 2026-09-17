# Operação da jornada de negociação

Guia de operação para ligar, pausar e diagnosticar a jornada em produção.
Estado atual: **deployada com todas as flags OFF** (comportamento idêntico ao anterior).

## Ligar para um tenant (ordem)
1. **Kill switch global**: `CHAT_JOURNEY_ENABLED=true` no Netlify + ECS (habilita rotas; ainda admin-only por tenant).
2. **Motor da conversa**: `NEGOTIATION_ENGINE` — `disabled` (menu determinístico, sem IA), `n8n` (+`N8N_CHAT_FLOW_URL`) ou `agent` (+`AGENT_URL`/`AGENT_APP_TOKEN`).
3. **Abrir ao público de um tenant**: `tenant_chat_config.journey_public_enabled=true` (sem isso, `/c/*` exige sessão admin/super_admin — modo canário).
4. **WhatsApp real**: `WHATSAPP_PROVIDER=voxuy` + `VOXUY_*` (senão `mock`, que só gera o link para copiar do painel).
5. **Workers**: rebuild da imagem Fargate (ARM64) + `desired-count ≥ 1`.

## Pausar tudo (kill switch)
`CHAT_JOURNEY_ENABLED=false` no Netlify → `/c/*` e `/api/chat/*` voltam a 404, hook de jornada no webhook para de ser chamado. Cobranças já emitidas seguem válidas (o webhook ASAAS continua conciliando pelo caminho normal).

## Casos (contestação / já paguei / atendimento)
Painel `/super-admin/negociacao-ia/casos`. `negotiation_cases`: `type` dispute/payment_claim/human_handoff, `status` open→in_review→resolved. Resolver um caso reabre/encerra a supressão associada (`dispute`/`human`).

## Ler a jornada de um cliente
`/super-admin/negociacao-ia/jornada` (busca por doc mascarado) → `journey_timeline`. Ou SQL: `select * from journey_timeline where customer_id=$1 order by occurred_at`.

## Supressões
`contact_suppressions` (opt-out, bloqueio, pago, disputa, humano). Todo caminho de envio (campanha, `sendWhatsApp`) consulta `isSuppressed` antes. Opt-out/bloqueio via webhook do provider entram automaticamente. Painel permite adicionar/desativar manual.

## Rollback
- Comportamento: `CHAT_JOURNEY_ENABLED=false` (imediato) — nada da jornada roda.
- Migrations são **aditivas**: rollback = flags off; nada precisa ser dropado.
- Código: Netlify publica deploy anterior; backup do banco em `ops/chatbot-journey-2026-09/backups/`.

## Não-duplicidade de cobrança
Todo aceite passa pelo guard duplo (`lib/asaas-idempotency.ts`): nível local (agreement vivo/pago) + nível ASAAS (payment não-encerrado do customer). Confirmado no E2E (reexecução = 0 nova cobrança).
