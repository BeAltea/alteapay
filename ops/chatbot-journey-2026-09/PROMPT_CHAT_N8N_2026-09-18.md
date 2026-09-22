# PROMPT - Chat genérico, autenticação por CPF/CNPJ e contratos para o n8n (fase preparatória)

**Para:** Claude Code (executor) · **Dono:** Fabio (aprova gates) · **Data:** 2026-09-18
**Sistema-alvo:** PRODUÇÃO `altea-pay` · **Branch:** a mesma da onda (`feature/chatbot-journey`)

> GATE N0 já foi decidido (2026-09-18): **(a) A — plataforma executa; (b) consolidado; (c) construir os dois endpoints (genérico admin-only); (d) todas as mitigações §3 confirmadas.** Implementar N1–N8 com esses defaults. Ver `ops/chatbot-journey-2026-09/reports/N0_chat_n8n.md` para o diagnóstico e o schema real.

## 1. Fluxo canônico
1. AlteaPay dispara a Voxuy com as infos do cliente → 2. Voxuy manda WhatsApp com link do chat → 3. Cliente acessa, autentica (CPF/CNPJ) e negocia com os fluxos do n8n → 4. Cobrança ASAAS criada a partir da decisão do n8n → 5. Status gravado na base → 6. AlteaPay exibe infos atualizadas + histórico. Este doc cobre 3, 5, 6 e prepara o 4.

Identidade: endpoint genérico; cliente informa documento e o sistema já sabe quem é e qual a dívida (CPF/CNPJ ligado ao ID da dívida). Único fator = documento (data de nascimento continua implementada e desligada, D10). Ao autenticar, envia ao n8n o ID da dívida + identificação do cliente.

## 2. Origem do pagamento (DECIDIDO: A)
**A - n8n comanda, plataforma executa.** Fluxo chama `POST /api/webhooks/n8n` com `payment.create` e recebe o link na resposta. Guard de idempotência (D7) SEMPRE aplicado. Matriz validada no servidor. Chave ASAAS só no Netlify/ECS. CPF vai mascarado. Implementar **B como variante desligada** atrás de `PAYMENT_ORIGIN`/`tenant_chat_config.payment_origin default 'platform'`. Em B, a plataforma continua aplicando o guard antes de aceitar o registro e recusa registro cuja dívida já tenha cobrança viva (`offer.rejected(reason='already_charged')`).

## 3. Mitigações do endpoint genérico (TODAS obrigatórias)
1. Chat fechado ao público enquanto `journey_public_enabled=false` (só admin/super_admin). 2. Link tokenizado `/c/{token}` é o caminho preferencial; genérico é fallback. 3. **Resposta uniforme**: inexistente, sem dívida aberta e bloqueado devolvem a MESMA mensagem, MESMO status HTTP e timing equalizado. Nunca confirmar que um CPF existe. 4. **Rate-limit/lockout em 2 dimensões independentes**: por IP (5 tent/10min → 30min bloqueio) E por documento (3 erros → 30min). 5. Nada antes de autenticar (sem valor/credor/faturas). 6. Auditoria de toda tentativa (`chat_auth_attempts` com `doc_hash`+`ip_hash`, nunca o documento). 7. Captcha atrás de flag (`CHAT_CAPTCHA_ENABLED` default false, Turnstile sugerido). Preparar `tenant_chat_config.auth_require_otp default false` + nota de 2º fator no handover (não é desta onda).

## 4. Fases N1–N8

### N1 — Resolver de documento e endpoint genérico
1. `lib/journey/document.ts`: `normalizeDocument(raw)` → dígitos; `classify(doc)` → cpf(11)|cnpj(14)|invalid; validação de DV para CPF (módulo 11) E CNPJ (pesos 5432987654321); rejeitar sequências repetidas. Testes.
2. `lib/journey/resolver.ts`: `resolveByDocument({companyId, document})` → `{customerId, debtIds[], primaryDebtId, totalOpen, agingDays, invoiceCount} | null`. Junção sempre por documento normalizado dos dois lados (`regexp_replace(document,'\D','','g')` em customers; `regexp_replace("CPF/CNPJ",'\D','','g')` na VMAX — VMAX usa `id_company` e coluna aspeada). Fonte primária = `customers`. Se só VMAX sem customers → `null` + `auth.unresolved` (NÃO criar registro). `primaryDebtId` = dívida aberta mais antiga; `debtIds` = todas abertas (status `pending`+`in_negotiation`) do cliente no tenant. NUNCA cruzar company_id. `agingDays` pela fatura/vencimento mais antigo.
3. Rotas: `GET /t/{tenantSlug}/negociar` (genérico por tenant; slug resolve company_id; sem slug → 404). `GET /c/{token}` (atalho campanha; documento digitado precisa casar com o do token). Mesmo componente de auth, branding do tenant, `X-Robots-Tag: noindex`, CSP restritiva.
4. `POST /api/chat/auth` (estende): aceita `{document, token?, birthDate?, captchaToken?}`. Ordem: valida formato → captcha (se flag) → rate-limit IP → lock por documento → resolve → cria sessão. Falha em qualquer ponto = resposta uniforme. Sucesso: cookie assinado (`CHAT_SESSION_SECRET`, httpOnly, Secure, SameSite=Lax, TTL deslizante) só com `session_id`; grava `auth.success`+`session.started`.
5. Consentimento LGPD antes do 1º turno (checkbox), grava `consent.given`.

### N2 — Sessão, contexto e histórico
1. Migration aditiva `2026091X_chat_n8n_*.sql`: `negotiation_sessions` (ADICIONAR o que falta: `debt_ids uuid[]`, `primary_debt_id`, `engine text`, `status text` ('open','closed'), `last_activity_at`, `closed_at`, `consent_at`, `channel text` ('web_campaign'|'web_generic'|'admin_preview')). **`chat_messages`** (novo): id, company_id, session_id, role('customer','assistant','system'), text, offers_snapshot jsonb, n8n_execution_id text, engine text, latency_ms int, created_at. `tenant_chat_config` (+): `payment_origin text default 'platform'`, `auth_require_otp boolean default false`, `send_document_to_engine boolean default false`, `n8n_chat_flow_url text`, `debt_selection text default 'consolidated'`. Índices: `chat_messages(session_id,created_at)`, `negotiation_sessions(company_id,customer_id,status)`. RLS por company_id, service_role para escrita.
2. `lib/journey/context.ts` → `buildSessionContext(sessionId)`: monta o objeto que vai ao n8n (Apêndice A.1) a partir de customers, debts, vmax_invoices, matriz e ofertas válidas. **Mascaramento embutido**: `document_masked`+`document_hash`; documento em claro só se `send_document_to_engine=true` E `payment_origin='n8n'`. Nenhum outro lugar monta esse payload.

### N3 — Engine e contrato papel A
1. `NEGOTIATION_ENGINE` aceita `n8n|stub|disabled` (`agent` continua inerte). URL: `tenant.n8n_chat_flow_url` → `N8N_CHAT_FLOW_URL` → senão `stub` fora de prod / `disabled` em prod (registra `chat.engine_error` 1x/sessão).
2. `POST /api/chat/message`: `{text}` + cookie. Grava `chat_messages(customer)`+`chat.turn.customer` → monta contexto → chama engine → grava resposta (`assistant`, `n8n_execution_id`, `latency_ms`) → executa ação (N4) → devolve `{reply, offers?, payment?, actions?}`.
3. Envelope assinado HMAC-SHA256 de `${timestamp}.${body}` com `N8N_WEBHOOK_SECRET`, janela ±300s, `event_id` por turno. Timeout 20s → modo assíncrono (responde "estou verificando", n8n devolve via `session.message` async com callback assinado).
4. Auth chega ao n8n no 1º turno: `session.verified=true`, `verified_at`, `customer.document_masked`/`document_hash`, `debt.id`(=primary), `debt.ids[]`.
5. **Stub** (`lib/negotiation/engines/stub.ts` + `POST /api/dev/n8n-stub`, só fora de prod ou `MOCK_ALL_INTEGRATIONS=1`): roteiro determinístico exercitando TODAS as ações (saudação→resumo→ofertas→aceite→payment.create→link→encerramento + contestação, "já paguei", humano). Verifica o HMAC do nosso lado.

### N4 — Ações do n8n (papel B)
Estender `POST /api/webhooks/n8n` (HMAC, anti-replay, idempotência por event_id). Ações validam sessão aberta+verificada+do tenant: `debt.summary`, `offer.list`, `offer.propose` (valida matriz; códigos DISCOUNT_ABOVE_MAX/INSTALLMENTS_ABOVE_MAX/ENTRY_BELOW_MIN/VALUE_BELOW_MIN/BILLING_TYPE_NOT_ALLOWED), `offer.reject`, **`payment.create`** (A: guard→agreements→cobrança ASAAS pelo caminho existente→acceptances+eventos; retorna `{agreement_id,payment_id,billing_type,pix_copy_paste?,boleto_url?,invoice_url,due_date,total_value,installments}`), **`payment.record`** (B: guard antes; grava agreements com ids/URLs do n8n; NUNCA aceita status pago), `payment.status`, `negotiation.note`, `dispute.register`/`payment_claim.register`/`human.transfer`/`session.close`. **D6 inegociável**: n8n registra cobrança criada (`pending`) e URLs, NÃO declara pagamento; `payment.record` com status pago vira claim em `negotiation_cases(type='payment_claim')`; acordo só muda via webhook ASAAS/sync. Tentativa gera `payment.claim_from_engine`.

### N5 — Criação da cobrança
1. Variante A (`payment.create`): reutilizar EXATAMENTE o caminho existente (`lib/negotiation/close-agreement.ts` + chargeQueue) com billingType, installmentCount, dueDate, descontos, `origin='chat_journey'`, `negotiation_session_id`, `offer_id`. `externalReference` = `journey_{sessionId}_{offerId}` (sem `:`). Não escrever 2º caminho.
2. Workers 0/0 (D5): se depende do worker, responde `{status:'processing', poll_after_ms:3000}`, UI faz polling, n8n recebe link no `payment.status` seguinte. Documentar no handover que canário/operação com chat exige worker ligado. Preferir caminho inline se existir (latência) mantendo o guard.
3. Cartão: `CREDIT_CARD` devolve `invoiceUrl`; dados de cartão nunca passam pela plataforma nem n8n. 4. PIX: copia-e-cola + QR; PIX não parcela (parcelado só boleto/cartão). 5. Depois de criada: outras ofertas → `superseded`; `proposal_valid_until` no agreement.

### N6 — Exibição (passo 6)
1. Área do cliente (`/t/{slug}/negociar` autenticado ou `/c/{token}`): card do acordo (valor, desconto, entrada, parcelas, vencimentos, forma, validade, status, botão pagamento) das COLUNAS REAIS de agreements; histórico (chat_messages, ofertas, acordo, pagamentos, 2ª via) com documento mascarado; polling curto na página de pagamento.
2. Painel super-admin (`/super-admin/negociacao-ia`): lista de sessões (canal, tenant, cliente mascarado, engine, status, duração, desfecho), detalhe com transcrição + n8n_execution_id por turno + ofertas + acordo + timeline; filtros por desfecho.
3. Métricas da sessão (usa jornada, sem contadores paralelos).

### N7 — Testes
Unitários (CPF/CNPJ válidos/inválidos/sequências/pontuação; resolver fonte/fallback/null/nunca-cruza-tenant/consolidado; auth resposta-uniforme/lock-IP-e-doc-independentes/timing/token-não-casa; contexto mascarado-por-padrão/claro-só-com-2-flags/sem-outra-PII; engine stub-completo/n8n-sem-URL-fallback/ação-inválida-ignorada/timeout-assíncrono; papel B idempotência/validação-oferta/payment.create-bloqueado-guard/payment.record-recusa-pago/claim_from_engine; histórico ordem/mascaramento). E2E lab (MOCK_ALL_INTEGRATIONS=1, engine stub): jornada inteira pelos 2 caminhos, CPF e CNPJ, aceite, cobrança mock, webhook PAYMENT_RECEIVED, histórico, supressão; repetir aceite → 0 cobranças novas; 4 docs errados → lock; payment.record 2x → already_charged. Suites existentes verdes, next build, lint, typecheck.

### N8 — Deploy com flags e handover · 🛑 GATE N1
Envs (Apêndice C) no Netlify+ECS com tudo desligado. Migrations aplicadas com backup. Smoke prod desligado (/t/vmax/negociar → 404 anônimo, admin acessa; /api/chat/message sem sessão → 401; /api/webhooks/n8n sem assinatura → 401; /api/dev/n8n-stub → 404 em prod; painéis idênticos; webhook ASAAS dedupe; 30min sem erro novo). Preview admin em prod (super_admin percorre com stub no tenant Altea-Testes, PIX real baixo, paga, confere histórico). Docs: `docs/N8N_INTEGRATION.md`, `docs/N8N_FLOW_REQUIREMENTS.md`, `docs/CHAT_AUTH_SECURITY.md`. GATE N1.

## Apêndice A — Contrato papel A (plataforma → n8n)
### A.1 chat.turn
```json
{ "event":"chat.turn","event_id":"uuid","timestamp":"ISO",
  "session":{"id":"uuid","channel":"web_campaign|web_generic|admin_preview","verified":true,"verified_at":"ISO","consent":true,"turn_index":3,"engine":"n8n","locale":"pt-BR"},
  "tenant":{"id":"uuid","slug":"vmax","brand_name":"VMAX","creditor_name":"VMAX","fulfillment_mode":"A","payment_origin":"platform"},
  "customer":{"id":"uuid","first_name":"Fabio","document_type":"cpf","document_masked":"***.456.789-**","document_hash":"sha256...","document":null},
  "debt":{"id":"uuid-primary","ids":["uuid-primary","uuid-2"],"original_value":41890,"updated_value":41890,"oldest_due_date":"2025-03-10","aging_days":557,"invoice_count":3,"invoices":[{"invoice":"FAT...","due_date":"2025-03-10","value":13990}]},
  "matrix":{"id":"uuid","max_discount_pct":35,"min_entry_pct":20,"max_installments":3,"allowed_billing_types":["PIX","BOLETO","CREDIT_CARD"],"proposal_validity_days":7},
  "offers":[{"id":"uuid","terms":{"discount_pct":35,"entry_value":0,"installments":1,"installment_value":27229,"total_value":27229,"billing_type":"PIX","first_due_date":"2026-09-25"},"valid_until":"ISO"}],
  "available_actions":["debt.summary","offer.list","offer.propose","offer.accept","offer.reject","payment.create","payment.status","dispute.register","payment_claim.register","human.transfer","negotiation.note","session.close"],
  "agreement":null,"message":{"role":"customer","text":"consigo pagar em 2x?"},"history_tail":[{"role":"assistant","text":"..."}] }
```
Valores monetários em centavos (Integer). `customer.document` = null salvo exceção das 2 flags.
### A.2 Resposta esperada
```json
{ "reply":"Posso fazer em 2x no boleto, com 18% de desconto. Fecha assim?",
  "action":{"type":"offer.propose","args":{"discount_pct":18,"installments":2,"entry_value":0,"billing_type":"BOLETO"}},
  "events":[{"type":"note","payload":{"intent":"parcelamento"}}],"n8n_execution_id":"exec_123","close_session":false }
```
`reply` obrigatório (o que o cliente vê); `action` opcional e validada pelo servidor (recusa registrada, reply continua exibido); campos desconhecidos ignorados+logados 1x/sessão. Resposta inválida/timeout → mensagem neutra + `chat.engine_error`.

## Apêndice B — Papel B
`POST /api/webhooks/n8n`, headers `x-alteapay-timestamp`+`x-alteapay-signature` (HMAC-SHA256 de `${timestamp}.${body}`).
payment.create → `{ok:true,agreement_id,payment_id,billing_type,invoice_url,pix_copy_paste,boleto_url,due_date,total_value,installments}`. payment.record (nunca status pago) → ok ou already_charged. Erros: 401 assinatura/janela; 409 already_charged; 422 código validação oferta; 404 sessão. Sempre `{ok:false,code,message}` sem PII.

## Apêndice C — Envs novas
`NEGOTIATION_ENGINE`(disabled), `N8N_CHAT_FLOW_URL`, `N8N_WEBHOOK_SECRET`, `N8N_TIMEOUT_MS`(20000), `CHAT_SESSION_SECRET`, `CHAT_CAPTCHA_ENABLED`(false)/`CHAT_CAPTCHA_PROVIDER`(turnstile)/`CHAT_CAPTCHA_SECRET`, `CHAT_AUTH_IP_MAX_ATTEMPTS`(5)/`CHAT_AUTH_IP_WINDOW_MIN`(10). Por tenant: n8n_chat_flow_url, payment_origin, send_document_to_engine, debt_selection, auth_require_otp, journey_public_enabled, auth_max_attempts, auth_lock_minutes, session_ttl_minutes.

## Apêndice D — O que o n8n precisa responder (para o próximo prompt)
URL do fluxo por tenant; como assina de volta; formato exato da resposta; LLM/custo; variante A/B; latência; tratamento de 409/422; memória (history_tail vs próprio); n8n_execution_id; fluxos auxiliares.
