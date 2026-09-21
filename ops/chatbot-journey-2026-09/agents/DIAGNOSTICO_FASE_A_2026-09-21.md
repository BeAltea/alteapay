# Fase A — Diagnóstico do orquestrador (onda "campanha por cedente + status")

**Data:** 2026-09-21 · **Base:** branch `feature/journey-neutral-prelogin` (`0d712f7`) · 232/232 testes verdes, build OK.
**Objetivo:** estabelecer o terreno real antes de abrir as trilhas T1–T6. Nomes de tabela/coluna aqui valem; suposições do prompt que não bateram estão marcadas.

---

## 1. Correções ao ponto de partida do prompt (o que JÁ existe)

O prompt lista vários itens como "não existe". A leitura do código mostra que **boa parte existe parcialmente** — as trilhas **estendem**, não reconstroem:

| Item do prompt | Realidade no código | Implicação |
|---|---|---|
| "seleção/campanha não existe" | `lib/journey/campaigns.ts` já tem `createCampaign`, `startCampaign`, `evaluateEligibility`, `dedupeByPhone`, **`toE164Mobile(phoneRaw)`** | T2 estende (preview, snapshot, ondas, cancelar). **Reusar `toE164Mobile`** — não reescrever normalização de telefone. |
| "tokens: campaign-send gera tokens" | `lib/journey/tokens.ts` (`createAccessToken`, `validateToken`, `issueActionTokens`, `revokeTokens`) + `campaign-send.ts` (`processCampaignMessage`) | prontos; T2/T3/T4 chamam, não recriam. |
| tabelas de campanha | Já existem: `whatsapp_campaigns`, `whatsapp_messages`, `whatsapp_provider_events`, `chat_access_tokens`, `contact_suppressions`, `journey_events`, `negotiation_*` | T2/T3/T4 adicionam **coluna `channel`** e conceito multi-canal por cima do que há; migrations **aditivas**. |
| `journey_events` | ~38 tipos já emitidos (`auth.*`, `offer.*`, `payment.*`, `session.*`, `campaign.*`, `message.*`, `debt.viewed`, `dispute*`, `human.transfer`, `optout.received`, `block.received`…) | **T1 mapeia esses eventos → estágios** (Apêndice A). Não inventar evento novo sem necessidade; se precisar, registrar no contrato. |

**Lista completa de `journey_events.type` hoje:** agreement.created, auth.attempt, auth.failed, auth.locked, auth.success, block.received, campaign.created, campaign.started, chat.turn.assistant, chat.turn.customer, consent.given, contact.stop_failed, contact.stopped, cpf, creditor.notified, debt.viewed, dispute, dispute.registered, human.transfer, message.failed, message.queued, message.suppressed, offer.accepted, offer.expired, offer.presented, offer.rejected, optout.received, payment.cancelled, payment.generated, payment.overdue, payment.paid, payment.sync_error, payment.viewed, payment_claim.registered, receipt.issued, retry.available, session.closed, session.started.

## 2. Colunas de contato reais (T1 depende disto)

`customers` (tabela **não tipada** em `types/supabase.ts`; acesso via `(supabase as any)`):
- **`phone`** (uso: 17x no código) — **coluna única de telefone**. NÃO há `phone2`/`mobile`/`celular`.
- **`email`** (20x).
- **`birth_date`** (2x) — existe, mas **praticamente vazia** (por isso `auth_require_birth_date=false`).
- **Fallback de telefone:** tabela `VMAX` tem `"Telefone 1"` e `"Telefone 2"` (isolamento por `id_company`, não `company_id`).

→ **T1** normaliza `customers.phone` (fallback `VMAX."Telefone 1"/"Telefone 2"`) em `mobile_e164` **reusando a lógica de `toE164Mobile`** (`lib/journey/campaigns.ts`). Se a regra precisar evoluir, T1 e T2 compartilham a MESMA função (T1 abre request se precisar mexer em campaigns.ts).

## 3. Superfície de UI existente (T5 estende)

Páginas super-admin já presentes: `app/super-admin/negociacao-ia/*` (jornada, sessoes, sessoes/[id], campanhas, casos, matriz) e `app/super-admin/negociacoes-chat`. **Decisão de rota:** T5 cria `app/super-admin/negociacoes/*` (lista com status por devedor) OU estende `negociacao-ia/jornada`. Recomendação: **nova rota `negociacoes`** para não colidir com `negociacao-ia` (dono de arquivos disjunto). T5 confirma no contrato.

## 4. Docs de contexto referenciados que NÃO existem

O prompt cita `claude/PROMPT_JORNADA_CHATBOT_2026-09-16.md`, `claude/PROMPT_VOXUY_INTEGRACAO_2026-09-17.md`, `claude/PROMPT_CHAT_N8N_ENDPOINT_2026-09-18.md`, `claude/PROMPT_CHAT_RECONHECIMENTO_E_PAGAMENTO_2026-09-21.md` — **nenhum existe** no repo (nem na meta-repo). Substitutos reais a usar como contexto:
- `docs/CHATBOT_JOURNEY_STATUS_2026-09-21.md` (estado de hoje)
- `docs/WHATSAPP_VOXUY_INTEGRATION.md`, `docs/VOXUY_ACCOUNT_SETUP.md`, `docs/VOXUY_SMOKE_TEST.md`
- `docs/N8N_INTEGRATION.md`, `docs/N8N_TEAM_INTEGRATION_GUIDE.md`, `docs/N8N_FLOW_REQUIREMENTS.md`
- `docs/CHAT_JOURNEY_OPERATIONS.md`, `docs/CHATBOT_PROD_COMPAT.md`, `docs/LGPD_CHATBOT.md`
- Specs Voxuy anteriores: `ops/chatbot-journey-2026-09/PROMPT_VOXUY_2026-09-17.md`, `.../INTEGRACOES_VOXUY_N8N_ASAAS.md`

## 5. Bloqueios de infra (do status 21/09) — confirmam o modo `inline`

1. Worker Fargate **desligado** + imagem desatualizada (não roda `chargeQueue`/`alteapay-email`).
2. Upstash **acima do teto** (607k/500k) — fila instável mesmo se ligar o worker.
3. ~977 devedores resolvíveis; **maioria com cobrança ASAAS viva** → `payment.create` = `already_charged` (409).

→ `DISPATCH_MODE=inline` / `EMAIL_SEND_MODE=inline` (Apêndice D) é **obrigatório** para o piloto sem worker. Filtro "sem cobrança viva" em T2 e reenvio via `payment.status` em T6 (não nova cobrança).

## 6. Verdades de segurança/PII a preservar (todas as trilhas)
- Token opaco = credencial; nada da dívida antes de autenticar; resposta de auth uniforme + timing (~600ms) + lockout.
- Documento em claro NÃO viaja ao n8n por padrão (mascarado + hash).
- **Planilha Voxuy = só Nome (1º nome), Telefone, Email, link** — sem CPF/valor/dívida (E9). Arquivo é PII: download restrito + registrado, nunca commitado.
- Marca do credor só após login (entregue no branch base).
- `company_id` sempre do servidor; RLS em toda tabela nova; rota nova de admin exige `super_admin`.

## 7. Estado de teste
- `pnpm test` = 232 verdes; `pnpm build` OK; `pnpm typecheck` tem **erros PRÉ-EXISTENTES** não relacionados (collection-ruler-engine, erpService, creditAnalysisService, pdfkit) — `next build` ignora (`ignoreBuildErrors:true`). Baseline: nenhum erro novo nos arquivos das trilhas.
