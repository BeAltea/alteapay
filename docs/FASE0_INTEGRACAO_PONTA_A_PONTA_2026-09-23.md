# Fase 0 — Integração ponta a ponta n8n + Voxuy + ASAAS (2026-09-23)

**Read-only** (nenhuma escrita). Entregável do GATE G0. Responde aos 20 itens do §3 + os 7 achados A1–A7. **A realidade manda** — divergências registradas.

---

## Resolução dos 7 achados (§1)

| # | Decisão do prompt | Realidade (Fase 0) | Ação |
|---|---|---|---|
| **A1** | valor ambíguo → mandar `amount_cents`+`amount`+`amount_formatted` | **Todas as colunas de valor são REAIS `numeric(10,2)`** (`debts.amount`, `vmax_invoices.saldo`, `agreements.agreed_amount/original_amount`). Não há coluna em centavos. O código já converte com `toCents(reais)` só na borda n8n. | Mandar os 3 campos: `amount` (reais, do banco), `amount_cents` (`round(reais*100)`), `amount_formatted`. **A borda do ASAAS continua em REAIS — qualquer ×100 lá seria cobrança 100×.** Confirmar com time n8n: texto usa `amount_formatted`, conta usa `amount_cents`. |
| **A2** | `official_channel_label` de outro cedente ("GNLink") | **`grep -ri gnlink` = ZERO ocorrências no repo.** O rótulo sai de `tenant_chat_config.official_channel_label`. O "GNLink" da captura veio do lado do n8n (config de teste), não do nosso código. | Confirmar o texto oficial da VMAX (Apêndice D#6). Teste: payload VMAX sem nome de outro cedente. |
| **A3** | `button.id` string vs D19 numérico | Hoje o payload não manda `button` estruturado no `chat.turn` (só em prompts). | Enviar aditivo `button = {id:"SIM", numeric_id:1, text:"..."}`. |
| **A4** | `aging_days` incoerente | `aging_days` deve ser calculado no disparo, em America/Sao_Paulo, do `due_date` original. | Calcular no envio; teste que compara com `due_date`. |
| **A5** | `channel:"webchat"` vs enum interno | Interno: `web_public_link`/`web_campaign`/`web_generic`/`admin_preview`. | Mapa explícito (Apêndice B do prompt): interno→`webchat`. |
| **A6** | webhook n8n sem auth? | **PROBE CONFIRMA: SEM Basic Auth E SEM validação HMAC** — o n8n devolve **200** a assinatura adulterada, timestamp velho e request sem Authorization. **É GATE.** | **BLOQUEANTE: o time n8n precisa ligar Basic Auth (D31) + nó de validação HMAC no Webhook antes de qualquer dado real.** |
| **A7** | `session_state` incoerente na captura | Tratar como teste manual; `session_state` é projetado do estado real. | Teste: turno de pagamento com `identity_verified=false` não existe. |

---

## §3.1 — Contrato atual com o n8n

1. **Payload atual** (`lib/negotiation/engine.ts` `buildSessionContext:420`, `lib/journey/context.ts`): hoje o caminho principal manda **`event`** (ex.: `event:"chat.turn"`) — **DIVERGE do Apêndice A que espera `type`** (o fallback `buildTurnPayload:313` já usa `type`). Não manda `contract_version`, `amount_formatted`, `button{numeric_id}`, `tenant.chat_link`. HMAC: `sha256=hmac(${ts}.${body})`, headers `x-alteapay-signature`/`x-alteapay-timestamp`/`x-alteapay-event-id`, ±300s, Basic Auth se envs presentes (`lib/negotiation/n8n.ts:13-24,69,97-121`). Valor: `toCents(reais)` na borda (`context.ts:17,51`). Documento: `document_masked`+`document_hash`, `document:null` (só vai em claro se `send_document_to_engine=true` E `payment_origin='n8n'`).
2. **`chat-turn.ts`:** disparo do turno em `runChatbotTurn` (`:96`); `session.start`/init async opcional (`:268`); `negotiation.start` no "Sim" (`:547`, best-effort com fallback assistido). Timeout externo `N8N_TIMEOUT_MS(20000)+5000`.
3. **Webhook `app/api/webhooks/n8n/route.ts`:** ~17 ações (`debt.summary`…`payment.create`…`chat.send`). HMAC via `verifyN8nRequest` (±300s, timing-safe). Dedupe por `event_id` (Redis NX, TTL 24h). `payment.create:652` exige `identity_verified_at`, chama `paymentCreate(ctx, offerId, event_id)`, devolve centavos. Erros: 403 sem consentimento, 409 sem thread, 422 doc inválido, 502 engine indisponível. Rate-limit 120/s por IP.
4. **`generic-auth.ts`:** sequência do login (`authenticateByDocument:161`, `authenticateByPublicLink`): normaliza→hashes→tenant→IP lock→doc lock→captcha→consentimento→DV→`resolveByDocument`→`establishSession`. A **equalização de ~600ms é feita PELA ROTA** (não no módulo). **Oportunidade:** disparar `session.start` async (fila/outbox) sem `await` no caminho da resposta.
5. **`grep -ri gnlink` = ZERO** (A2 não existe no nosso código).
6. **`tenant_chat_config`** (migration `20260702`): `fulfillment_mode`, `official_channel_label`, `branding` jsonb (`brand_name` dentro). `20260918` adicionou `payment_origin`, `send_document_to_engine`, `n8n_chat_flow_url`, `debt_selection`.
7. **`maskDocument`** (`lib/journey/document.ts:42`) — **UMA função**, reusada em chat/e-mail/admin. CPF → `***.456.789-**`; CNPJ → `**.456.789/****-**`. **⚠️ DIVERGE do exemplo `390.***.**7-05`** (mostra os 3 primeiros + 2 últimos; o nosso oculta os 3 primeiros). Decisão N9 pro Fabio.
8. **`buildAckContext`** (`lib/journey/acknowledgement.ts:48`) → `{firstName, creditorName, updatedValue (REAIS), invoiceCount, oldestDueDate}`. Soma `debts.amount`; vencimento de `vmax_invoices.vencimento` fallback `debts.due_date`. É a fonte canônica que alimenta `debt.amount_cents` (via `toCents`).
9. **Sem `engine_outbox`** — só filas BullMQ genéricas. D1 cria a tabela outbox (N3).
10. **`NEGOTIATION_ENGINE`** lido em `engine.ts:44 engineName()`: `disabled` (default, assistido)/`n8n` (exige `N8N_CHAT_FLOW_URL`)/`agent`/`stub`. Override por sessão (`engine_owner`) e por tenant (`n8n_chat_flow_url`).

## §3.2 — Banco (estado/custo)

9. **Login:** `resolveByDocument` (`resolver.ts:130`) → **Index Scan** em `idx_customers_document` com `company_id` como Filter, **3,5 ms**, 3 buffers (cache). **Não há índice composto `(company_id, document)`** — opcional (o documento já é seletivo).
10. **Valor por coluna = todos REAIS `numeric(10,2)`** (não centavos): `debts.amount`, `vmax_invoices.saldo`, `agreements.agreed_amount/original_amount/discount_amount/installment_amount`. `agreements.total_amount` **não existe**. Zero valores com >2 decimais. **A1 resolvido: reais no banco e no ASAAS; centavos só derivado para o n8n.**
11. **Trigger `trg_customers_contact_profile`** (BEFORE INSERT/UPDATE OF phone,email): deriva `mobile_e164`/`email_valid`/`contact_profile` das 3 funções `altea_*`.
12. **Cobertura (2026-09-23):** celular **3.783** · e-mail **3.648** · ambos **3.619** · sem contato **1** (bate com o status +1). Nome plausível 3.813 · doc válido 3.813 · valor aberto>0 **3.128** · vencimento disponível **3.164**.
13. **Divergências de formato:** doc com pontuação no campo **2**; telefone fora de E.164 (mobile_e164 null) **27**; e-mail cru com espaço/maiúscula **393** (derivados já corretos); nome CAIXA ALTA **0**; datas como texto **0**. `birth_date` **100% NULL** — **não ligar `auth_require_birth_date`**.
14. **`negotiation_sessions`** (44 total): `channel` NULL **39** (os ~40 resíduos), `web_public_link` 5; `debt_ids` NULL **0**.
15. **Amostra de 10** (doc mascarado) — no relatório dos agentes; vários com valor alto têm 0 faturas em `vmax_invoices` (venc. vem do fallback `debts.due_date`).

## §3.3 — Config externa

16. **Probe do n8n (GATE X0): FALHA de segurança** — o fluxo responde 200 a request válido, MAS aceita assinatura adulterada, timestamp velho e request sem Authorization (todos 200). **Sem Basic Auth e sem validação HMAC.** (A6 = gate.)
17. **A1 (leitura do valor no fluxo n8n):** pendente resposta escrita do time n8n (Apêndice D#1).
18. **ASAAS:** `ASAAS_WEBHOOK_TOKEN` **SET**. `asaas_webhook_events`: 7.886 eventos, **último 2026-09-18** (~5 dias atrás — nenhum recente; verificar se a URL do webhook ainda está registrada/ativa), 0 não-processados, 4 com erro.
19. **Voxuy:** `VOXUY_WEBHOOK_URL` **AUSENTE** no Netlify; `voxuy_flow_id` **NULL** na VMAX; `whatsapp_dispatch_mode=mock`. → **G7 (Voxuy) bloqueado (esperado, N14 — não bloqueia o resto).**
20. **Envs de produção:** `CHARGE_MODE`, `EMAIL_SEND_MODE`, `WHATSAPP_DISPATCH_MODE`, `NEGOTIATION_ENGINE` (disabled), `N8N_CHAT_FLOW_URL`, `N8N_WEBHOOK_SECRET`, `N8N_BASIC_AUTH_USER`, `N8N_BASIC_AUTH_PASSWORD`, `ASAAS_WEBHOOK_TOKEN` — **todos SET**. `VOXUY_WEBHOOK_URL` ausente.

---

## GATE G0 — o que falta decidir/consertar antes de qualquer código

1. **🔴 SEGURANÇA (A6, bloqueante):** o time n8n precisa **ligar Basic Auth + nó de validação HMAC** no Webhook. Hoje qualquer um posta. **Sem isso, nada de dado real.**
2. **A1 (time n8n, por escrito):** confirmar que texto usa `amount_formatted` e conta usa `amount_cents`; o ASAAS recebe **reais** (o banco é reais).
3. **N9 (Fabio):** máscara canônica — manter a nossa `***.456.789-**` OU adotar a do exemplo `390.***.**7-05`?
4. **A2 (Fabio):** texto oficial do `official_channel_label` da VMAX.
5. **A3 (time n8n):** aceitar `button.id` string + `numeric_id`.
6. **ASAAS webhook:** confirmar que a URL do webhook está registrada/ativa no painel (último evento há 5 dias).
7. **Voxuy (G7):** sem `flowId`+template+`VOXUY_WEBHOOK_URL`, segue mock — não bloqueia o resto.

**Divergências de código a corrigir na Frente A (D1):** `event`→`type`; adicionar `contract_version`, `amount_formatted`, `button{numeric_id}`, `tenant.chat_link`; criar `engine_outbox`; disparo async no login.
