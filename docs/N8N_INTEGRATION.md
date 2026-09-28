# Integração n8n ⇄ Chatbot AlteaPay — n8n como cérebro da conversa

**Última atualização:** 2026-09-21 (onda R: reconhecimento com botões + pagamento
variante A + contrato v2 em centavos)

> **📘 Guia autossuficiente para o time do n8n:** `docs/N8N_TEAM_INTEGRATION_GUIDE.md`
> (14 seções, PT-BR) + exemplos `.http` em `docs/n8n/examples/` + fixtures em
> `docs/n8n/fixtures/`. **Contrato v2 (2026-09-21):** valores monetários nas
> interfaces n8n são **inteiros em CENTAVOS**; reconhecimento da dívida é a 1ª
> interação (`chat.turn.debt_acknowledgement`); `payment.create` recusa
> `409 debt_not_acknowledged` sem reconhecimento e é idempotente por
> `(session_id, offer_id)` (`idempotent:true`); `501 not_implemented` para
> `payment_origin != 'platform'`; novas ações `chat.send`/`prompt.ask`/`prompt.close`;
> botões `1=Sim`/`0=Não`/`2..N` lista/`98`=Voltar/`99`=Atendente.

O chatbot de negociação usa **fluxos do n8n como engine da conversa**
(`NEGOTIATION_ENGINE=n8n`, padrão). A plataforma AlteaPay é o **sistema de
registro e de ações de domínio**: sessões, consentimento LGPD, auditoria
imutável de mensagens, regras de desconto, fechamento de acordo e cobrança
ASAAS. O fluxo/LLM **nunca** decide desconto nem manuseia URLs de pagamento —
apenas conversa e sinaliza intenções; o servidor executa.

---

## 1. Arquitetura — os dois papéis do n8n

### Papel A — cérebro do chat (canais da plataforma: web chat `/negociar`)

```
Devedor ⇄ /negociar/<token> ⇄ BFF AlteaPay ──POST assinado──▶ Fluxo n8n (cérebro)
                                   ▲            chat.turn        │ AI Agent node
                                   └──── {reply, action, …} ◀────┘ (memória por thread_id)
```

Cada turno do chat web é POSTado (HMAC) ao fluxo `N8N_CHAT_FLOW_URL` com o
**contexto completo** (sessão, devedor, dívida, modo do tenant). O fluxo
responde o contrato do §4. O BFF grava inbound/outbound na auditoria e aplica
os efeitos no funil.

### Papel B — n8n conduz o canal (Telegram, WhatsApp via n8n, CRM…)

```
Devedor ⇄ Canal X ⇄ Fluxo n8n (canal + cérebro) ──POST assinado──▶ /api/webhooks/n8n
                                                    session.create / session.record /
                                                    agreement.close / session.redirect /
                                                    session.status
```

O fluxo conversa direto com o devedor e usa o webhook da plataforma para as
ações de domínio (§5).

---

## 2. Segurança

Idêntica nos dois sentidos — **HMAC-SHA256 de `${timestamp}.${corpoRaw}`** com
`N8N_WEBHOOK_SECRET`:

| Header | Conteúdo |
|---|---|
| `x-alteapay-timestamp` | epoch em segundos |
| `x-alteapay-signature` | `sha256=<hex>` |

- Janela anti-replay ±300s; comparação em tempo constante; corpo cru (re-serializar quebra a assinatura).
- A **plataforma assina** o que envia aos fluxos (chat.turn, session.init, callbacks async) — valide no fluxo (§6.1).
- Os **fluxos assinam** o que enviam a `/api/webhooks/n8n`.
- Rate limit inbound (N8N-12): pela identidade autenticada, depois do HMAC — 60 req/min por sessão (flow.* usam o limite próprio do N8N-13), 3000 req/min por cedente, 300 req/min para chamadas sem sessão (ping); inválidas/sem assinatura: 60/min (balde comum ou por IP confiável). `N8N_RATE_LIMIT_MODE=legacy` volta ao 120/min por IP. Runbook: `ops/negociacao-final/12-rate-limit-e-ip.md`. Idempotência por `event_id` (§7).
- Invariantes do servidor: descontos SEMPRE de `charge-rules` (buckets de
  aging); URL de canal oficial SEMPRE de `tenant_chat_config`;
  `agreement.close` exige sessão com consentimento + identidade verificada.

## 3. Variáveis de ambiente

| Env | Uso |
|---|---|
| `NEGOTIATION_ENGINE` | `n8n` (padrão). `agent` só para o rig de treino local legado |
| `N8N_WEBHOOK_SECRET` | HMAC compartilhado (openssl rand -hex 32) |
| `N8N_WEBHOOK_SECRET_PREVIOUS` | opcional: segredo anterior aceito **só na entrada** durante a rotação (nunca assina). Remover ao fim da janela. Runbook: `ops/n8n-sync-fix/12-n8n4-segredos-e-rotacao.md` |
| `N8N_CHAT_FLOW_URL` | URL do Webhook trigger do fluxo-cérebro |
| `N8N_SESSION_FLOW_URL` | opcional — fluxo notificado em `session.init` |
| `N8N_FLOW_TIMEOUT_MS` | timeout da chamada ao fluxo (default 60000) |

---

## 4. Contrato do fluxo-cérebro (`N8N_CHAT_FLOW_URL`)

### Request (plataforma → fluxo), tipo `chat.turn`

> **Atualizado em 2026-09-27 (N8N-14):** o corpo real leva também o envelope plano
> no topo (`event`, `event_id`, `timestamp`/`occurred_at`, `contract_version`,
> `callback_url`) — ver **§14**. O exemplo abaixo é o contrato v1 mínimo.

```json
{
  "type": "chat.turn",
  "thread_id": "web_<session_id>",
  "session_id": "…", "company_id": "…", "channel": "webchat",
  "message": "texto do devedor",
  "session_state": {
    "identity_verified": true, "debt_acknowledged": false,
    "fulfillment_mode": "B", "outcome": "in_progress"
  },
  "debtor": { "name": "…", "document": "…" },
  "debt": { "id": "…", "amount": 13586.32, "due_date": "2025-07-08",
            "description": "…", "aging_days": 90 },
  "tenant": { "fulfillment_mode": "B", "official_channel_label": "Portal da Prefeitura" }
}
```

`debtor`/`debt` vêm `null` se a sessão não tem vínculo. A URL do canal oficial
**não** viaja — o fluxo sinaliza redirect e quem entrega a URL é o servidor.

### Response (Respond to Webhook node) — só `reply` é obrigatório

```json
{
  "reply": "texto ao devedor",
  "action": "agreement_closed|redirect_payment|redirect_attendance|handoff",
  "events": ["identity_verified", "offer_proposed"],
  "verified": true,
  "close_offer_id": "avista"
}
```

**`close_offer_id`** (`"avista"` ou `"parc_N"`, N≤60): pede que **o servidor**
feche o acordo com as regras oficiais de desconto e enfileire a cobrança — o
caminho recomendado. O turno volta com `action:"agreement_closed"` +
`agreement_id`. Alternativa: o fluxo chama a ação `agreement.close` (§5).

**Responsabilidades do fluxo-cérebro:**
- **Identity gate**: se `session_state.identity_verified=false`, confirmar CPF
  (+ segundo fator definido pela operação) contra `debtor.document` antes de
  revelar valores; ao passar, incluir `"identity_verified"` em `events` e
  `verified:true`.
- **Modo B/C**: com `fulfillment_mode` B, não fechar acordo — usar
  `action:"redirect_payment"`. Contestações → `action:"redirect_attendance"`.
- **Memória**: usar `thread_id` como chave (ex.: Simple Memory do AI Agent node).

## 5. API inbound — `POST /api/webhooks/n8n` (ações)

Todas assinadas (§2); corpo `{ "action": …, … }`; resposta `{ "success": … }`.

| Ação | Para quê | Campos principais |
|---|---|---|
| `ping` | conectividade + saúde do engine | — |
| `session.create` | **desligada por padrão** (`N8N_SESSION_CREATE_ENABLED`, §24). Cria sessão (registro + `deep_link` single-use TTL 24h) | `company_id`, `document` OU `debt_id`, `consent`, `identity_verified`, `debt_acknowledged` |
| `session.message` | turno completo conduzido pela plataforma (ela chama o fluxo-cérebro); `callback_url` só no host n8n configurado (§24) | `session_id`, `message`, `mode: sync\|async`, `callback_url`, `event_id`, `metadata` |
| `session.record` | auditoria de conversa conduzida PELO fluxo (Papel B) | `session_id`, `direction: inbound\|outbound`, `content`, `sender?`, `provider_message_id?`; outbound: `events?`, `turn_action?`, `agreement_id?` |
| `agreement.close` | fecha acordo com regras do servidor + enfileira cobrança | `session_id`, `offer_id: avista\|parc_N`, `event_id?` |
| `session.redirect` | modo B: registra clique/intenção e devolve a URL oficial | `session_id`, `offer_presented?`, `confirmed_intent?` |
| `session.status` | funil + links ASAAS do acordo (preenchidos async) | `session_id` |

Destaques:

- **`session.create`**: `consent:true` registra o consentimento LGPD colhido no
  canal (pré-requisito para as demais ações de conversa);
  `identity_verified:true` só se o fluxo validou a identidade —
  `agreement.close` recusa (403) sessões não verificadas.
- **`session.record`** grava em `conversation_messages` (imutável, PII
  redigida). No Papel B registre **todo** turno — trilha LGPD art. 20. Com
  `direction:"outbound"`, `events`/`turn_action` aplicam efeitos no funil
  (ex.: `turn_action:"handoff"` → `handoff_human`).
- **`agreement.close`** responde `{agreement_id, terms, message}`; idempotente
  por sessão (segunda chamada → `duplicate:true`) e por `event_id`. Links de
  pagamento: poll em `session.status` (2–5s) até `agreement.asaas_*` aparecer.
- **`session.message`**: a plataforma registra e chama o fluxo-cérebro por
  você; `mode:"async"` → 202 + callback assinado no `callback_url`.

Erros: 400 JSON inválido · 401 assinatura/replay · 403 consentimento ou
identidade pendente · 404 não encontrado · 409 conflito · 422 validação ·
429 rate limit · 502 fluxo-cérebro indisponível · 503 secret não configurado.

---

## 6. Receitas no n8n

### 6.1 Fluxo-cérebro (Papel A)

```
[Webhook trigger (Raw Body ON)  ← chat.turn assinado da plataforma]
  → [Code: valida assinatura (abaixo)]
  → [AI Agent node]  system prompt: persona de negociação, regras do tenant,
       identity gate quando identity_verified=false, modo B => redirect
       Memory: Simple Memory com sessionKey = {{$json.thread_id}}
  → [Code: monta {reply, action?, events?, verified?, close_offer_id?}]
  → [Respond to Webhook]
```

Validação de assinatura (Code node; igual para callbacks async):

```javascript
const crypto = require('crypto');
const secret = $env.ALTEAPAY_N8N_SECRET;
const raw = $json.body instanceof Object ? JSON.stringify($json.body) : $json.body;
const ts  = $json.headers['x-alteapay-timestamp'];
const sig = $json.headers['x-alteapay-signature'];
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
if (sig !== expected || Math.abs(Date.now()/1000 - Number(ts)) > 300) {
  throw new Error('assinatura inválida — descartado');
}
return [{ json: JSON.parse(raw) }];
```

Assinatura de requests à plataforma (Code node antes do HTTP Request node;
enviar o `raw` EXATO como Body Raw):

```javascript
const crypto = require('crypto');
const body = { action: 'agreement.close', session_id: $json.session_id, offer_id: 'avista' };
const raw = JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const sig = 'sha256=' + crypto.createHmac('sha256', $env.ALTEAPAY_N8N_SECRET)
  .update(`${ts}.${raw}`).digest('hex');
return [{ json: { raw, ts, sig } }];
```

### 6.2 Canal conduzido pelo fluxo (Papel B — ex.: Telegram)

```
[Trigger: mensagem do devedor no canal]
  → [1ª interação? → opt-in LGPD no canal → session.create {consent:true, document}]
  → [session.record {direction:'inbound', content}]
  → [IA do fluxo decide a resposta]
  → [IF aceitou oferta → agreement.close {offer_id} → poll session.status → envia boleto/PIX]
  → [IF modo B → session.redirect → envia official_channel_url]
  → [session.record {direction:'outbound', content, events?, turn_action?}]
  → [envia resposta no canal]
```

### 6.3 Disparo de deep link (sem IA no fluxo)

```
[Trigger: dívida vencida/CRM] → [session.create] → [envia deep_link ao devedor]
  → devedor conversa no chat web (que usa o fluxo-cérebro §6.1)
  → [Cron → session.status → atualiza CRM]
```

## 7. Idempotência

`event_id` em `session.message` e `agreement.close`: retries com o mesmo id →
`duplicate:true` (com resultado cacheado quando concluído; dedupe 24h, cache
1h). `agreement.close` é adicionalmente idempotente por sessão.

## 8. LGPD

- Consentimento antes de conversar (via `session.create consent:true` ou na UI web).
- Papel B: registre TODOS os turnos via `session.record` — a plataforma redige
  PII e mantém a trilha imutável com modelo/versão por turno.
- `chat.turn` envia nome + documento ao fluxo (necessários ao identity gate):
  o n8n deve rodar em infra própria/privada; não logue esses campos em nodes.
- `identity_verified:true` transfere ao fluxo a responsabilidade da verificação.

## 9. Teste rápido (curl assinado)

```bash
SECRET=… ; URL=https://<app>/api/webhooks/n8n
BODY='{"action":"ping"}'; TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"
curl -s "$URL" -H "content-type: application/json" \
  -H "x-alteapay-timestamp: $TS" -H "x-alteapay-signature: $SIG" -d "$BODY"
# → {"success":true,"service":"alteapay-chatbot","engine":{"ok":true,"engine":"n8n"}}
```

## 10. Troubleshooting

| Sintoma | Causa provável |
|---|---|
| `401 assinatura inválida` | body re-serializado (usar Raw), secret divergente, relógio >5min |
| `502` no chat/`session.message` | fluxo-cérebro fora do ar, URL errada, ou fluxo respondeu sem `reply` |
| `engine.ok=false` no ping | `N8N_CHAT_FLOW_URL`/`N8N_WEBHOOK_SECRET` não configurados |
| `403` em `agreement.close` | sessão sem consentimento ou sem identidade verificada |
| `409` em `session.redirect` | tenant sem `official_channel_url` configurado |
| Links ASAAS `null` | fila de cobrança processando — poll `session.status` |

---

## 11. Onda "Chat genérico + auth CPF/CNPJ + contratos n8n" (2026-09-18)

Adição preparatória. Tudo atrás de flags OFF (produção idêntica). Ver
`docs/N8N_FLOW_REQUIREMENTS.md` (o que o fluxo n8n precisa fazer) e
`docs/CHAT_AUTH_SECURITY.md` (segurança da autenticação).

### 11.1 Novo caminho de chat da plataforma (papel A ampliado)

- Endpoint de campanha `/c/{token}` **e** endpoint genérico
  `/t/{tenantSlug}/negociar` (admin-only enquanto `journey_public_enabled=false`).
- Turno canônico: `POST /api/chat/message` (cookie de sessão). Grava
  `chat_messages`, roda o engine (`n8n|stub|disabled`), grava a resposta com
  `n8n_execution_id` + `latency_ms`, devolve `{reply, offers, action}`.
- Engine `stub` (`NEGOTIATION_ENGINE=stub`, só fora de prod / `MOCK_ALL_INTEGRATIONS=1`):
  roteiro determinístico que exercita todas as ações, sem n8n nem LLM.
- Timeout `N8N_TIMEOUT_MS` (default 20000) → modo assíncrono: o cliente vê
  "estou verificando" e o fluxo devolve depois via `session.message` async.

### 11.2 Contrato `chat.turn` (plataforma → n8n) — Apêndice A.1

> **Atualizado em 2026-09-27 (N8N-14):** além dos blocos abaixo, o corpo leva no
> TOPO `event`+`type`, `session_id`, `company_id`, `thread_id`, `channel`,
> `session_state` e `callback_url` — ver **§14** (forma exata enviada hoje).

Montado **exclusivamente** por `lib/journey/context.ts`. Valores monetários em
**centavos** (Integer). Documento **mascarado** por padrão; em claro só quando
`tenant_chat_config.send_document_to_engine=true` **E** `payment_origin='n8n'`.

```json
{ "event":"chat.turn","event_id":"uuid","timestamp":"ISO",
  "session":{"id":"uuid","channel":"web_campaign|web_generic|admin_preview","verified":true,"verified_at":"ISO","consent":true,"turn_index":3,"engine":"n8n","locale":"pt-BR"},
  "tenant":{"id":"uuid","slug":"vmax","brand_name":"VMAX","creditor_name":"VMAX","fulfillment_mode":"A","payment_origin":"platform"},
  "customer":{"id":"uuid","first_name":"Fabio","document_type":"cpf","document_masked":"***.456.789-**","document_hash":"sha256...","document":null},
  "debt":{"id":"uuid-primary","ids":["uuid-primary","uuid-2"],"original_value":4189000,"updated_value":4189000,"oldest_due_date":"2025-03-10","aging_days":557,"invoice_count":3,"invoices":[{"invoice":"FAT...","due_date":"2025-03-10","value":1399000}]},
  "matrix":{"id":"uuid","max_discount_pct":35,"min_entry_pct":20,"max_installments":3,"allowed_billing_types":["PIX","BOLETO","CREDIT_CARD"],"proposal_validity_days":7},
  "offers":[{"id":"uuid","terms":{"discount_pct":35,"entry_value":0,"installments":1,"installment_value":2722900,"total_value":2722900,"billing_type":"PIX","first_due_date":"2026-09-25"},"valid_until":"ISO"}],
  "agreement":null }
```

Resposta esperada do fluxo (Apêndice A.2) — `reply` é obrigatório; `action`
opcional e sempre validada pelo servidor; `n8n_execution_id` rastreado por turno:

```json
{ "reply":"Posso fazer em 2x no boleto, com 18% de desconto. Fecha assim?",
  "action":{"type":"offer.propose","args":{"discount_pct":18,"installments":2,"entry_value":0,"billing_type":"BOLETO"}},
  "n8n_execution_id":"exec_123", "close_offer_id":null }
```

### 11.3 Novas ações de domínio no `POST /api/webhooks/n8n` (papel B)

Mesma segurança (HMAC `${timestamp}.${body}`, janela ±300s, anti-replay por
`event_id`). Sessão precisa estar **aberta + verificada + do tenant** para as
ações de pagamento.

| Ação | Efeito | Resposta |
|---|---|---|
| `payment.create` | **Variante A (default):** `args.offer_id` = uuid de `offer.list` (canônico) ou alias `avista`/`parc_N` (§19) → guard SEMPRE → `agreements` → cobrança ASAAS pelo caminho existente (`close-agreement`, inline ou chargeQueue) → aceite + eventos | resposta **plana** `{ok, idempotent, status:"created"\|"already_charged", agreement_id, asaas_payment_id, billing_type, total_value (centavos), installments, due_date, invoice_url, pix_copy_paste, pix_qr_image, pix_expiration, pix_pending, pix_fallback_url, boleto_url, boleto_line, boleto_barcode?, offer_id, offer_alias}` ou `{status:"processing", poll_after_ms:3000}` (só `CHARGE_MODE=queue`) — ver §19 |
| `payment.record` | **Variante B (off):** guard antes; registra cobrança PENDING + URLs do n8n; **NUNCA aceita status pago** (D6 → `payment_claim` + `payment.claim_from_engine`) | `{code:"recorded", agreement_id}` \| `{code:"claim", case_id}` |
| `payment.status` | estado atual da cobrança do acordo (fonte = base local; a verdade do pagamento é o webhook ASAAS) | `{agreement_id, payment, payment_status, asaas_status}` |
| `negotiation.note` | anota observação estruturada no funil | `{success:true}` |

Códigos de erro: `401` assinatura/janela; `409` `already_charged` /
`payment_origin_n8n`; `422` código de validação de oferta
(`DISCOUNT_ABOVE_MAX`, `INSTALLMENTS_ABOVE_MAX`, `ENTRY_BELOW_MIN`,
`INSTALLMENT_BELOW_MIN`, `BILLING_TYPE_NOT_ALLOWED`, `PIX_CANNOT_INSTALL`,
`TOTAL_MISMATCH`); `404` sessão. Sempre `{success:false, error, code}` sem PII.

**D6 inegociável:** o n8n registra cobrança criada (`pending`) e URLs, **não
declara pagamento**. `payment.record` com status pago vira
`negotiation_cases(type='payment_claim')`; o acordo só muda via webhook ASAAS/sync.

### 11.4 Envs novas (todas com default seguro)

| Env | Default | Papel |
|---|---|---|
| `NEGOTIATION_ENGINE` | `disabled` | `n8n` \| `stub` \| `disabled` |
| `N8N_CHAT_FLOW_URL` | — | URL do fluxo-cérebro (papel A) |
| `N8N_WEBHOOK_SECRET` | — | HMAC dos dois sentidos |
| `N8N_TIMEOUT_MS` | `20000` | timeout do turno → modo assíncrono |
| `CHAT_SESSION_SECRET` | (usa `NEGOTIATION_JWT_SECRET`/`SUPABASE_JWT_SECRET`) | cookie de sessão |
| `CHAT_CAPTCHA_ENABLED` / `CHAT_CAPTCHA_PROVIDER` / `CHAT_CAPTCHA_SECRET` | `false` / `turnstile` / — | captcha do auth genérico |
| `CHAT_AUTH_IP_MAX_ATTEMPTS` / `CHAT_AUTH_IP_WINDOW_MIN` | `5` / `10` | lock por IP (§3.4) |

Por tenant (`tenant_chat_config`): `n8n_chat_flow_url`, `payment_origin`,
`send_document_to_engine`, `debt_selection`, `auth_require_otp`,
`journey_public_enabled`, `auth_max_attempts`, `auth_lock_minutes`,
`session_ttl_minutes`.

### 11.5 Endpoint de laboratório

`POST /api/dev/n8n-stub` — fluxo n8n **falso** para E2E: verifica a assinatura
HMAC do nosso lado e devolve uma resposta no contrato de A.2. **404 em produção**
(só existe fora de prod ou com `MOCK_ALL_INTEGRATIONS=1`). Uso:
`NEGOTIATION_ENGINE=n8n` + `N8N_CHAT_FLOW_URL=<origin>/api/dev/n8n-stub`.

---

## 12. 2026-09-25 — D2/D4 aplicados nos fluxos do n8n

Decisões de 25/09: **D2 — só o nosso `payment.create` cria cobrança**; **D4 — URL singular
`/api/webhook/n8n` → `/api/webhooks/n8n`**. Aplicadas via API do n8n, com backup do JSON antes
de cada PUT (fora do git) e reversíveis. Relatório: `ops/negociacao-final/02-impl-A5.md`.

### 12.1 O que mudou

- **`1.7 Debt Collection (ASAAS)`** não cria mais cliente/cobrança no ASAAS nem insere em
  `agreements`. Os nós ASAAS (`Get Customer`, `Create Customer`, `Generate Pay Installment`,
  `Generate Paym. Cash`, `Get All Installments Generated`), `Customer Found?`,
  `Format Paym. Method & Due Date`, `Prepare Data for Ingestion`, `Is it a installment payment?`
  e `Update Agreements` estão **desconectados e desabilitados** (não apagados). No lugar, o bloco
  `AlteaPay: *` chama o nosso webhook assinado (HMAC `sha256=`, credencial `Crypto account`,
  mesmo padrão do `4. Send Msg & Update`):
  1. `offer.list` — o servidor gera (ou reaproveita) as ofertas da matriz da sessão;
  2. escolha da oferta com o mesmo nº de parcelas negociado
     (`ongoing_agreement.selected_agreement.installments_count`; sem ele, à vista) — **o n8n só
     escolhe entre ofertas geradas; nunca define desconto/valor** (D8/D11);
  3. `payment.create { offer_id, billing_type }` → `invoice_url`/`asaas_payment_id` alimentam
     `Parse Payment URL` → `Call 'Send Msg & Update'` (`already_charged` reenvia o link do
     acordo vivo).
  - 4xx/5xx, `processing`, resposta sem link ou parcela sem oferta → `AlteaPay: Error text` →
    `7. Send Error Msg w/ Persistency`. **Nunca cobrança direta.**
  - `chat_endpoint` passou a ser propagado às chamadas de `4. Send Msg & Update` (não era).
- **`1.5`** (`MSG: Invalid Payment Method`) e **`1.6`** (`MSG: Ask for a valid payment method`):
  URL corrigida. O `1. Main` antigo (inativo) está **arquivado** e a API recusa alteração — fica
  com a URL singular, sem efeito.

### 12.2 Por que `offer.list` e não `offer.propose`

`offer.propose` exige `args.terms` com os 9 campos de `OfferTerms` **em reais** — o código passa
`terms` direto a `validateProposedTerms`/`persistOffer`, sem converter centavos e sem conferir
`original_value` contra a dívida — enquanto o contrato n8n (§11.3 e guia do time) diz "centavos
em todas as interfaces". O banco que o n8n lê é uma **cópia separada** (a dívida de teste aparece
lá com `amount=25000`). Um `offer.propose` montado pelo n8n poderia produzir cobrança 100× maior.
**Pendência da plataforma:** `offer.propose` aceitar centavos na borda e validar `original_value`
contra `debts.amount` (ou `payment.create` recusar oferta cujo `original_value` ≠ dívida).

### 12.3 Prova (gate G3)

Execução `7525` do `1.7` (Webhook de teste, sessão de teste): `offer.list` 200 (3 ofertas) →
oferta 1x → `payment.create` 200 `{ok:true, status:'already_charged', idempotent:true}` (acordo
cancelado com `asaas_status=PENDING`, gap N-D1-2) → `chat.send` 200. ASAAS do cliente de teste:
**zero cobranças** antes e depois; cofre `A5-n8n-payment-create` = `nao_criada`. Zero caminho de
`Input`/`Webhook` até qualquer nó ASAAS (verificado por alcance no JSON). **Limite:** a cadeia
`Get Customer Interaction → … → Last Interaction` morre para sessões web (`notification_id` nulo,
N-D2-4); a prova entrou direto no bloco por um nó temporário (removido); o caminho `created` não
foi observado (bloqueado por N-D1-2).

### 12.4 Pendências para o dev do n8n (não corrigidas nesta onda)

- **Botões (N-D2-3):** `Send Message with buttons` (`4. Send Msg & Update`) manda o shape legado
  `{sessionId, output, buttons}` → **422**. Shape correto:
  `{action:'chat.send', session_id, event_id, args:{text, prompt:{kind, question, buttons:[{id:<int>, label}]}}}`
  — `id` **inteiro** (2..97 para lista; 0/1/98/99 reservados) e `label` (não `text`). Idem
  `Format Buttons` do `1.3` (ids string).
- **Segredo hard-coded (N-D2-9):** `Input Normalization` do `1. Main` guarda o segredo num campo
  `Set` e o repassa como `webhook_secret`. Mover para credencial/env do n8n; o bloco novo já não
  depende dele (usa a credencial `Crypto account`). **Exposição e descarte (2026-09-25):** o valor
  que circulou em exportações do workflow (nó `Set` do Main antigo e `pinData` do `Input` de
  1.5/1.6/1.7) é o segredo de **teste/dev** (`webhook_secret_testing`, usado com o host de túnel) —
  conferido por fingerprint: **não** é o `N8N_WEBHOOK_SECRET` de produção nem o valor da credencial
  `Crypto account`, que nunca saíram em exportação. Portanto **não é preciso rotacionar**
  `N8N_WEBHOOK_SECRET`/`Crypto account` (nada de janela combinada); ao mover para credencial,
  **descartar** o valor de teste exposto (gerar outro só para o ambiente de teste,
  `openssl rand -hex 32`) e não fixar nenhum segredo em `pinData` de novo.
  **Atualização (2026-09-27, N8N-4):** a rotação de `N8N_WEBHOOK_SECRET` e das credenciais Basic
  está planejada e pode ser feita sem janela (`N8N_WEBHOOK_SECRET_PREVIOUS`). O runbook é mantido
  fora deste repositório.
- **Router por `step` (D3):** o `1. Main` roteia por `Last Agent Interaction.step` e trata
  `negotiation.start` como turno ("Teste"); `DB: Update Negotiation Status` exige
  `notification_id` (nulo em sessões web) → sub-execuções morrem (N-D2-4). Fora de escopo.
- Copy do `Call 'Send Msg & Update'` (emoji, "Um abraço") não segue a carta de voz D45 — só o
  trecho do `already_charged` foi ajustado. `processing` não tem polling no fluxo (vai ao erro;
  em produção `CHARGE_MODE=inline` devolve `created`).
- `availableInMCP` de 1.5/1.6/1.7 foi resetado para `false` pelo PUT da API pública (chave fora do
  schema); reativar na UI se for usado. Os nós `Webhook` de teste dos sub-fluxos são públicos e
  sem autenticação (hoje inertes: corpo aninhado em `body`) — convém removê-los.

## 13. 2026-09-25 — Regra de supersede do assistido (trilha A2, D1 híbrido)

O assistido da plataforma (menu de 3 opções → parcelas da matriz → pós-link) é a **rede de
segurança sempre presente**. O n8n **conduz** o diálogo **só por prompt acionável**. Vale para
`chat.send` (com `args.prompt`), `prompt.ask` e `prompt.close` quando o prompt ATIVO da sessão é
um menu do assistido criado pela plataforma (`kind ∈ {debt_three_options, offer_choice,
post_payment_link}`, `created_by='platform'`):

| Entrada do n8n | Efeito |
|---|---|
| `chat.send` só com `args.text` (sem botões) | bolha `engine='n8n'` gravada; **não supersede** (o menu continua ativo). Na tela vira nota discreta acima do menu; o fallback genérico do fluxo ("selecione uma das opções válidas", "canal de atendimento automático…") **não é exibido**; markdown é removido |
| `chat.send`/`prompt.ask` com botões inválidos (`validateButtons`: ids não-inteiros, duplicados, `label` ausente, lista vazia) | **422** `{code:<erro de validação>}`; nada é gravado (nem o texto); o menu fica |
| `chat.send`/`prompt.ask` com prompt válido mas **não mapeável** | **422** `{code:'prompt_not_actionable', error:'… (<motivo>)'}`; nada é gravado; o menu fica |
| `chat.send`/`prompt.ask` com prompt **acionável** | supersede o menu (o ativo vira `superseded`; o novo é `created_by='n8n'`) |
| `prompt.close` | **422** `{code:'platform_prompt_protected'}` — o menu só é substituído por prompt acionável (fechar sem substituir deixaria o devedor sem caminho). Prompts criados pelo n8n continuam fechando normalmente |

**Acionável** (`lib/journey/chat-send.ts:assessPromptActionability`) = `validateButtons` OK **e**:
- `offer_choice`: todo item de lista (2..97) leva `value` = `offer_id` de uma oferta `presented`
  desta sessão (obtida por `offer.list`/`offer.propose` — a matriz é do servidor);
- `payment_method_choice`: itens com `value` ∈ `PIX | BOLETO | CREDIT_CARD`;
- kinds booleanos (`debt_acknowledgement`, `generic_yes_no`, `payment_confirmation`): catálogo
  Sim/Não (`1`/`0`, `99` opcional);
- kind desconhecido: só se **todo** botão for reservado (`0/1/98/99`) ou mapear um `offer_id`;
- `debt_three_options`, `debt_consult`, `post_payment_link`: reservados à plataforma (nunca).

Sem menu protegido ativo (ex.: já respondido, ou o ativo é do próprio n8n) vale o comportamento
anterior (qualquer prompt válido supersede).

Cliques em prompts criados pelo n8n com `NEGOTIATION_ENGINE=n8n`: o `chat.turn` ao fluxo tem
timeout curto (`N8N_CLICK_TIMEOUT_MS`, default 4000 ms); estourado, o clique responde
`{action:'engine_timeout', processing:true, prompt:<menu de 3 opções reaberto>}` e a resposta
tardia do fluxo entra pelas regras acima (texto → nota; prompt acionável → substitui). O
`negotiation.start` do "Negociar" é disparado em paralelo à apresentação das parcelas e aguardado
só até `N8N_KICKOFF_DEADLINE_MS` (default 2500 ms; `kickoff: delivered|unavailable|pending` na
resposta do clique). `engine_outbox` continua ausente em produção: a "entrega durável" é um no-op
explícito (log único por processo) até a migration ser aplicada (ver §17).

## 14. 2026-09-27 — Envelope plano nos eventos de saída (N8N-14)

**Problema:** o `chat.turn` do caminho rico (`buildSessionContext`) saía só com
`type:"chat.turn"` e os ids aninhados (`session.id`, `tenant.id`), sem `event`,
`event_id`, `session_id` ou `company_id` no topo — contra o
`ops/n8n-sync-fix/09-n8n-routing-handoff.md` §1(B). No `1. Main`, `body.session_id`
virava nulo e "Fetch debt data" quebrava com uuid `"undefined"`; o turno se perdia.

**Agora** todo POST de saída leva, no TOPO do corpo, `event` (discriminador canônico
fixo — o fluxo roteia por aqui) **e** `type` (rótulo do tenant, `n8n_event_names`).
Os blocos aninhados continuam iguais (mudança aditiva). O header
`x-alteapay-event-id` é o MESMO `event_id` do corpo. A assinatura continua
`sha256=HMAC(N8N_WEBHOOK_SECRET, "${x-alteapay-timestamp}.${corpo exato}")`.

| Evento | Chaves de topo |
|---|---|
| `chat.turn` | `event`, `type`, `contract_version`, `event_id`, `timestamp`, `occurred_at`, `session_id`, `company_id`, `thread_id`, `channel`, `message`, `session_state`, `callback_url`, `available_actions` + aninhados `session`, `tenant`, `customer`, `debt`, `matrix`, `offers`, `debt_acknowledgement`, `active_prompt`, `agreement` |
| `chat.turn` (fallback, contexto irresolvível) | o mesmo envelope + `debt_acknowledgement`, `debtor`, `debt`, `tenant` mínimos |
| `negotiation.start` | `event`, `type`, `contract_version`, `event_id`, `timestamp`, `occurred_at`, `session_id`, `company_id`, `thread_id`, `channel`, `callback_url` + `session`, `tenant`, `customer`, `debt`, `acknowledgement`, `matrix`, `offers`, `available_actions` |
| `session.start` (outbox) | ganhou `event` (antes só `type`); resto inalterado |

- **`event_id` do `chat.turn`** é determinístico por turno: UUID derivado de
  `session_id` + id da mensagem inbound gravada (`conversation_messages.id`). O mesmo
  turno reenviado leva o mesmo id; turnos distintos, ids distintos. O do
  `negotiation.start` é o uuid do clique, reusado na reentrega pelo outbox.
- `company_id` vem sempre da sessão. Documento continua mascarado + hash (claro só
  com as 2 flags do tenant); só o primeiro nome viaja.
- `message` de um clique em prompt do n8n continua sendo o **rótulo** do botão (o
  `button.id` do clique ainda não viaja no `chat.turn`; ver pendências no relatório
  N8N-14).


## 15. 2026-09-27 — Fonte de dados do fluxo = plataforma (N8N-13)

**Problema:** o `1. Main`, os `1.x`, o `4. Send Msg & Update` e o `6. DB Data Fetch` liam
devedor, dívida, régua e o estado do roteador de **outro projeto Supabase** (credencial n8n
"Supabase account", ≠ produção), com schema próprio (`n8n_conversation_messages`,
`debts.original_amount`, `collection_rules.conditions`, `companies.is_active`,
`notifications.negotiation_details`). Devedor não espelhado caía em "não conseguimos encontrar
histórico"; o usuário de teste aparecia com vencimento 2026-02-15 (faixa até 25%) contra
2026-08-15 (5%) em produção. O dinheiro seguia protegido pela revalidação da matriz.

**Decisão:** o n8n **não** recebe a service-role de produção (N8N-4: execuções guardam dados em
claro). Ele lê e grava o próprio estado pela API assinada:

| Ação | O que faz |
|---|---|
| `flow.context` | leitura única: sessão (company_id da sessão), cedente, 1º nome + doc mascarado, dívida em **centavos** com `status`/`open`/`due_date`/aging, matriz da faixa, ofertas vigentes, reconhecimento, prompt ativo, `flow_state` e `bootstrap_step` |
| `flow.state.set` | grava `{step, status, active, ongoing_agreement}` do roteador em `journey_events` (`event_type='n8n.flow_step'`, `actor='n8n'`, **sem** `customer_id` → não move `negotiation_state`). Idempotente por (sessão, `event_id`, step, status) |

- Código: `lib/journey/n8n-flow.ts`; roteamento em `app/api/webhooks/n8n/route.ts`; limite de
  60/min por sessão além do limite por IP. Sem migration.
- Sem histórico de mensagens: o roteador só usa o último passo do agente; o texto já está em
  `conversation_messages`.
- `bootstrap_step`: sem `flow_state` e com a dívida reconhecida na plataforma →
  `debt_recognition` (o `negotiation.start` com `acknowledgement.button_id=1` leva à oferta L1).
- Workflows corrigidos (não aplicados) e o passo a passo: `ops/n8n-sync-fix/n8n13/` e
  `ops/n8n-sync-fix/10-n8n13-fonte-de-dados.md`.

## 16. 2026-09-27 — `1. Main` roteia por `body.event` (N8N-1)

**Problema:** o `Router` do `1. Main` decidia pelo `step` da última mensagem do agente, não por
`body.event`, e chamava nós que exigem `notification_id` (nulo na web): 52 de 100 execuções no
fallback "opções válidas", 38 com uuid `"null"`, nenhuma nos `1.3`–`1.7` desde 23–25/09.

**Agora (não aplicado; `ops/n8n-sync-fix/n8n1/`, handoff `ops/n8n-sync-fix/13-n8n1-roteamento.md`):**
- Switch em `body.event` logo depois da normalização: `session.start` → 2xx sem mensagem;
  `negotiation.start`/`chat.turn` web → `flow.context` → roteamento por `flow_state.step` →
  `bootstrap_step`; evento desconhecido → 2xx e nada. O canal `whatsapp` segue no roteador legado.
- Resposta ao webhook: **sempre `202 {accepted, event, event_id, duplicate}`**; a resposta ao
  devedor vai por `chat.send` assinado com `origin_event_id` (N8N-16). Dedupe por `event_id`.
- Botões no formato do N8N-2 (ofertas do servidor, `value` = `offer_id`, rótulo sem valor); nenhum
  valor/percentual/parcela em texto; o clique numa oferta é executado pela plataforma.
- Sem mudança no app. Geração: n8n13 → `build_n8n1.py` → `build_n8n16.py` → `build_n8n1.py --after-n16`.

## 17. 2026-09-27 — Kickoff confiável pelo `engine_outbox` (N8N-10)

**Problema:** o `session.start` do login nunca chegava ao n8n (9 logins, 0 execuções). O
evento só é enviado depois de gravado no `engine_outbox`, e a tabela não existe em produção
(`PGRST205`): `enqueueEvent` virava no-op explícito e não havia POST. A migration
`supabase/migrations/20260930_engine_outbox.sql` existia e nunca foi aplicada. Além disso,
com a tabela presente o login ficaria esperando o POST ao n8n (até 2,5 s).

**Agora:**

| Evento | Grava no outbox | 1ª tentativa | Reentrega |
|---|---|---|---|
| `session.start` (login, só abertura nova) | sim, `pending` (idempotente por `event_id` determinístico) | fora da resposta (`waitUntil` do runtime; sem ele, solta). O login **não** espera o n8n | drenos |
| `negotiation.start` (clique Negociar) | sim, `pending` **sob lease** (`next_attempt_at = agora + ENGINE_OUTBOX_LEASE_MS`) | POST curto do clique (`N8N_KICKOFF_TIMEOUT_MS`), aguardado só até `N8N_KICKOFF_DEADLINE_MS`; sucesso marca `sent` | drenos, depois do lease |

Drenos (todos usam `flushOutbox`; entrega at-least-once, o fluxo deduplica por `event_id`):

1. **Rota** `POST|GET /api/cron/flush-engine-outbox` (`Authorization: Bearer ${CRON_SECRET}`),
   chamada a cada minuto pela scheduled function `netlify/functions/engine-outbox-drain.mjs`.
   **Não depende do worker Fargate.**
2. **Worker Fargate** (`lib/queue/workers/engine-outbox.drainer.ts`, iniciado em
   `start-workers.ts`) a cada `ENGINE_OUTBOX_DRAIN_INTERVAL_MS`. Só liga com
   `NEGOTIATION_ENGINE=n8n` + `N8N_CHAT_FLOW_URL` no ambiente do worker.
3. **Próximo turno** da sessão (`chat-turn.ts`), agendado fora da resposta.
4. `scripts/ops/flush-engine-outbox.ts` (manual).

Cada envio reivindica a linha antes (compare-and-set em `attempts` + lease em
`next_attempt_at`), então dois drenos simultâneos não postam a mesma linha. Backoff
exponencial (`base × 2^(n-1)`, teto de 6 h) e teto de tentativas → `failed`. 4xx
permanente (exceto 408/429) → `failed` na hora. A URL é a mesma do `negotiation.start`:
`N8N_EVENT_FLOW_URL` → `tenant_chat_config.n8n_chat_flow_url` → `N8N_CHAT_FLOW_URL`.
Corpo = `stableStringify(payload)`, com a mesma assinatura HMAC + Basic de sempre.

Sem a tabela, nada muda: no-op explícito (log 1x) e o processo revê a tabela a cada
`ENGINE_OUTBOX_RECHECK_MS`. Aplicar a migration liga a entrega sem redeploy.

**Flags que existem** (todas opcionais, com default):

| Env | Default | Efeito |
|---|---|---|
| `N8N_KICKOFF_TIMEOUT_MS` | 2500 | timeout do POST do `negotiation.start` no clique |
| `N8N_KICKOFF_DEADLINE_MS` | 2500 | quanto o clique espera o desfecho do kickoff |
| `ENGINE_OUTBOX_TIMEOUT_MS` | 2500 | timeout de cada POST do dreno |
| `ENGINE_OUTBOX_MAX_ATTEMPTS` | 6 | teto de tentativas por linha |
| `ENGINE_OUTBOX_BACKOFF_BASE_MS` | 30000 | base do backoff exponencial |
| `ENGINE_OUTBOX_LEASE_MS` | 60000 | lease de uma linha reivindicada / do `negotiation.start` recém-criado |
| `ENGINE_OUTBOX_RECHECK_MS` | 300000 | prazo para rever a tabela depois de vê-la ausente |
| `ENGINE_OUTBOX_DRAIN_BUDGET_MS` | 8000 | orçamento por chamada da rota de cron |
| `ENGINE_OUTBOX_DRAIN_INTERVAL_MS` | 15000 | intervalo do dreno no worker (0 desliga) |

**`N8N_KICKOFF_MODE` não existe no código.** Foi proposto (`inline` × `queue`, job
`negotiation_start` na fila `alteapay-n8n`) e nunca implementado; relatórios que dizem
que "ligar `N8N_KICKOFF_MODE=queue` exige o rebuild do worker" estão desatualizados. A
fila `alteapay-n8n` é do sentido n8n → app (turno assíncrono `mode:"async"` do
`/api/webhooks/n8n`) e não participa do kickoff.

## 18. 2026-09-27 — Correlação dos callbacks do n8n (N8N-16)

**Problema:** o webhook do `1. Main` aceita POST sem assinatura; os subfluxos assinam com
o segredo real e postam `chat.send` para o `session_id` recebido. A assinatura correta do
callback não prova que a plataforma pediu aquela resposta.

**Defesa da plataforma** (`lib/negotiation/n8n-correlation.ts`, gancho no início do
`POST /api/webhooks/n8n`): uma ação com efeito só é aceita quando ecoa um evento que a
plataforma enviou ao n8n para a MESMA sessão/empresa, dentro da janela, e dentro do teto
de respostas por evento.

- **Id ecoado:** `origin_event_id` no topo do corpo do callback; na falta dele, o próprio
  `event_id` do callback (compatível com o handoff 09 §3, "ecoar o event_id").
- **Registros usados (nenhuma tabela nova):** `chat.turn` → id determinístico recalculado a
  partir das mensagens inbound da sessão (`conversation_messages`, §14); `negotiation.start`
  → linha `n8n_out:<event_id>` em `journey_events` gravada ANTES do POST (também valem as
  linhas legadas `neg_start:`/`neg_start_unavailable:`); `session.start` → `engine_outbox`
  (ausente em produção). Teto: linhas `n8n_reply:<origin>:<k>` em `journey_events`.
- **Ações cobertas:** `chat.send`, `prompt.ask`, `prompt.close`, `payment.create`,
  `payment.record`, `offer.propose`, `offer.accept`, `offer.reject`, `agreement.close`,
  `dispute.register`, `payment_claim.register`, `human.transfer`, `negotiation.note`,
  `session.close`, `session.message`, `session.record`, `session.redirect` e
  `flow.state.set` (este sem consumir o teto). Leituras (`ping`, `session.status`,
  `debt.summary`, `offer.list`, `payment.status`, `journey.timeline`, `flow.context`) e
  `session.create` não são cobertas.
- **Replay** do mesmo callback (mesma ação + mesmo `event_id`) reusa o slot; a idempotência
  de cada ação (ex.: `payment.create` por sessão+oferta) segue igual.

| Env | Default | Efeito |
|---|---|---|
| `N8N_REQUIRE_EVENT_CORRELATION` | OFF | OFF: só telemetria `journey_events.n8n.correlation_miss` (sem PII: ação + código). ON: recusa |
| `N8N_CORRELATION_WINDOW_SECONDS` | `900` | janela entre o envio do evento e o callback |
| `N8N_CORRELATION_MAX_REPLIES` | `12` | callbacks com efeito por evento de origem |

Códigos (flag ON): `403 n8n_origin_missing | n8n_origin_unknown | n8n_origin_wrong_session |
n8n_origin_wrong_company`, `409 n8n_origin_expired | n8n_reply_cap`,
`503 n8n_correlation_unavailable`.

> **Não ligar a flag antes dos fluxos ecoarem o evento.** Hoje nenhum subfluxo manda
> `origin_event_id` (o `5.`/`4.` geram um `event_id` novo por callback), então com a flag ON
> todo `chat.send`/`payment.create` do n8n seria recusado. Ordem e patches dos fluxos:
> `ops/n8n-sync-fix/11-n8n16-autenticacao.md` e `ops/n8n-sync-fix/n8n16/`.

## 19. 2026-09-27 — `payment.create`: aliases de oferta e instruções PIX/boleto (N8N-15)

**Problema (QA `ops/qa-e2e/10-n8n-api-personas.md`, persona c #9/#10):**
(a) o `docs/CONTRATO_N8N_PAYMENT_CREATE.json` v1.0 mandava `args.offer_id = 'avista' | 'parc_N'`,
mas o servidor só aceitava o uuid de `offer.list` (`'avista'` → `409 OFFER_NOT_AVAILABLE`);
(b) na resposta `created` de uma cobrança PIX, `pix_copy_paste` e `pix_qr_code_url` vinham `null`.

### 19.1 (a) Aliases — decisão: ACEITAR, com resolução estrita no servidor

`args.offer_id` aceita o **uuid** de `offer.list` (canônico, sem mudança) **ou** um alias:

| Alias | Resolve para |
|---|---|
| `avista` | a oferta `presented`, não vencida, de **1 parcela** desta sessão |
| `parc_N` (2 ≤ N ≤ 60) | a oferta `presented`, não vencida, de **N parcelas** desta sessão |

Por que é seguro (regra de ouro — o servidor decide valores):
- a resolução é **só-leitura** (`lib/negotiation/offer-alias.ts`): o alias só **seleciona** uma
  oferta que o servidor já gerou e apresentou na sessão (isolada por `session_id` + `company_id`);
  nunca gera oferta nem monta termos. Sem ofertas → `409 OFFER_ALIAS_NOT_FOUND` (chame `offer.list`);
- resolve só com **exatamente uma** candidata. Duas ou mais (ex.: um `offer.propose` do fluxo além
  da oferta da matriz) → `409 OFFER_ALIAS_AMBIGUOUS` — o servidor nunca "adivinha" e cobra um valor
  diferente do que o fluxo disse ao devedor. Só vencidas → `409 OFFER_EXPIRED`;
- a oferta integral do botão Pagar (0%/1x) nunca conta como `avista`;
- depois do resolve o caminho é **idêntico** ao do uuid (reconhecimento, matriz vigente, guard
  duplo de `lib/asaas-idempotency.ts`, idempotência por `(session_id, offer_id)`);
- **idempotência alias ↔ uuid:** após o 1º `payment.create` a oferta vira `accepted` (irmãs
  `superseded`); sem candidata `presented`, o alias cai na oferta `accepted` do mesmo tipo → mesma
  oferta → mesmo acordo → mesma cobrança (`idempotent:true`). Se um `offer.list` posterior gerar um
  conjunto novo, o alias resolve para a oferta nova e o guard devolve `already_charged` com o link
  existente — nunca 2ª cobrança.

A resposta passa a trazer `offer_id` (uuid resolvido) e `offer_alias` (alias usado ou `null`).
`agreement.close` (ação legada) continua com a semântica própria de `avista`/`parc_N` do
`close-agreement` (desconto por faixa de aging) — não confundir com o `payment.create`.

### 19.2 (b) PIX nulo — causa e correção

**Causa:** o objeto de pagamento do ASAAS (`POST`/`GET /payments`) **não tem** copia-e-cola nem QR.
O write-back (`charge-inline.ts`, worker, `send-payment-link`) gravava `asaas_pix_qrcode_url` a
partir de `asaasPayment.pixQrCodeUrl` — campo que só o **mock** devolve; em produção é sempre
`null`. A borda n8n mapeava `pix_copy_paste` (e `pix_qr_code_url`) dessa coluna. O PIX só existe em
`GET /payments/{id}/pixQrCode` (`payload`, `encodedImage`, `expirationDate`), que ninguém chamava.
O web chat não sofre disso: manda o devedor ao `invoice_url` (checkout ASAAS com PIX/boleto).

**Correção** (`lib/journey/payment-instructions.ts`, só na borda n8n; web chat intocado):
- `payment.create` (`created`/`already_charged`) e `payment.status` (objeto `payment`, cobrança
  não paga) consultam o ASAAS sob demanda, com prazo de **2,5 s**:
  - **PIX:** `pix_copy_paste` (BR Code), `pix_qr_image` (`data:image/png;base64,…`),
    `pix_expiration`, `pix_pending:false`, `pix_fallback_url:null`;
  - estourou o prazo / erro ASAAS → `pix_pending:true` + `pix_fallback_url` (= `invoice_url`). A
    cobrança existe; só as instruções não vieram — mande o link ou repita `payment.status`;
  - **BOLETO:** `GET /payments/{id}/identificationField` → `boleto_line` (linha digitável),
    `boleto_barcode`, `boleto_pending`; `boleto_url` (PDF, `bankSlipUrl`) continua da base;
  - cartão: nada extra (`invoice_url`).
- Nada é persistido; o payload PIX/QR/linha **nunca** é logado (só `paymentId` + `timeout`/`erro`).
- `pix_qr_code_url` fica **deprecado** (coluna legada, `null` em produção) — use `pix_qr_image`.
- O mock ASAAS (`MOCK_MODE`) ganhou `pixQrCode` e `identificationField`.

### 19.3 Forma da resposta (chaves)

- **Antes:** `ok, idempotent, status, agreement_id, asaas_payment_id, billing_type, total_value,
  installments, due_date, invoice_url, pix_copy_paste (null), pix_qr_code_url (null), boleto_url,
  boleto_line (null)`.
- **Depois (PIX):** as mesmas + `pix_qr_image, pix_expiration, pix_pending, pix_fallback_url,
  offer_id, offer_alias` (`pix_copy_paste` preenchido).
- **Depois (BOLETO):** as mesmas + `boleto_barcode, boleto_pending, offer_id, offer_alias`
  (`boleto_line` preenchido).

Erros reais do `payment.create`: `403` sessão não verificada · `409 debt_not_acknowledged` ·
`409 OFFER_NOT_AVAILABLE` (uuid inexistente/consumido) · `409 OFFER_EXPIRED` ·
`409 OFFER_ALIAS_NOT_FOUND` · `409 OFFER_ALIAS_AMBIGUOUS` · `422 offer_outside_matrix` /
`no_matrix_row` · `501 not_implemented` · `503 charge_deferred`. `already_charged` é **200**
(`status:"already_charged"` + link existente), não erro. Contrato completo:
`docs/CONTRATO_N8N_PAYMENT_CREATE.json` v1.1.

## 20. 2026-09-27 — Contrato de botões n8n → chat (N8N-2)

**Problema:** nenhum botão do n8n era aceito. O `4. Send Msg & Update` mandava o envelope
`{sessionId, output, buttons}` (422 "corpo inválido") e, desde 25/09, `chat.send` com
`id: Number(b.id)` (métodos `PIX`/`CARTAO` viram `null` → 422 `button_id_invalid`) e parcelas
`offer_choice` sem `offer_id`, com valor calculado pelo n8n (422 `prompt_not_actionable`, ou
beco sem saída no clique). Especificação completa para o fluxo:
`ops/n8n-sync-fix/14-n8n2-botoes.md`.

**Forma canônica** (inalterada): `chat.send` com
`args.prompt = {kind, question, buttons:[{id:<int>, label, value?, order?}]}`. Oferta =
`kind:"offer_choice"` + `value` = `offer_id` vigente (de `offer.list`); método =
`payment_method_choice` + `value` ∈ `PIX|BOLETO|CREDIT_CARD`; `1/0` Sim/Não
(`debt_acknowledgement` executa o reconhecimento na plataforma); `96` Já paguei; `98` Voltar;
`99` Atendimento (handoff pela plataforma em qualquer prompt).

**Sempre ligado:** botão cujo `value` é uma oferta vigente da sessão tem o **rótulo regenerado
pela oferta do servidor** — o devedor nunca vê um valor escrito pelo n8n num botão que cobra a
oferta do servidor. O que é aceito não muda.

**Adaptador legado** (`N8N_LEGACY_BUTTONS_ADAPTER=on`, default **off**;
`lib/negotiation/n8n-buttons.ts`): converte ids string, `text`→`label`, métodos por id ou pelo
início do rótulo, `offer_id`, tokens de ação (`nao_reconheco`, `ja_paguei`, `atendimento`,
`voltar`…) e o envelope `{sessionId, output, buttons}`. Oferta só entra se resolver para uma
oferta vigente (por id, ou casamento exato de parcelas+valor com uma única oferta da matriz);
o resto é descartado com motivo. Sem nenhum botão válido, o texto entra como bolha e a sessão
fica com o menu determinístico (nunca beco sem saída); sem nada para exibir → 422
`buttons_invalid`. Resposta ganha `buttons_report` (`dropped_buttons`, `fallback`,
`relabeled`) e, no fallback, `fallback_prompt_id`. Telemetria:
`journey_events.chat.engine_buttons_adapted` (sem PII). Invariantes mantidas: 1 prompt ativo,
`thread_epoch`, janela do N8N-8 (`prompt_outside_window`), idempotência por `event_id`.

**Síncrono:** a resposta síncrona do `negotiation.start` passa pelo mesmo caminho; a do
`chat.turn` só lê `reply` (botões ignorados) — para botões num turno, 202 + `chat.send`.

explícito (log único por processo) até a migration ser aplicada.

## 21. 2026-09-27 — Guard de texto do n8n (N8N-6)

Todo texto do n8n que pode chegar ao devedor passa por um guard **no servidor**
(`lib/negotiation/n8n-text-guard.ts`) antes de ser gravado: `chat.send` (`args.text`,
`args.prompt.question` e rótulos dos botões), a resposta síncrona do kickoff
(`negotiation.start`, que usa o mesmo `chatSend`) e o `reply` síncrono do `chat.turn` (papel A).
O GET `/api/chat/messages` e o `/api/chat/history` aplicam o mesmo filtro na leitura, então
linhas antigas e o fallback do fluxo não saem pela API. O filtro do client web continua como
defesa em profundidade.

**Normalização (sempre):** HTML removido; link markdown `[rótulo](url)` vira o rótulo; URL fora
do domínio da plataforma (`alteapay.com` e o host de `NEXT_PUBLIC_APP_URL`) é removida;
espaços normalizados; corte em 2000 caracteres. Link de pagamento se entrega por
`payment.create`/`payment_ref`, não por URL no texto.

**O texto PODE conter:** empatia, orientação e perguntas ("desconto" sem número é permitido);
valores, percentuais, número de parcelas e datas **idênticos** a um fato do servidor para a
sessão. Os fatos aceitos são: as ofertas vigentes (`offer.list`: total, parcela, entrada,
desconto em R$ e %, `first_due_date`, `valid_until`), o prompt ativo da plataforma, o valor e o
vencimento da dívida, e os acordos do devedor. Os valores são comparados em centavos, em
qualquer formato brasileiro (`R$ 1.234,56`, `R$1234,56`, `1.234,56 reais`). `1x` e "à vista"
sempre passam.

**O texto NÃO PODE conter:**
- número monetário que o servidor não gerou (`R$`/reais, `%` de desconto, `Nx`/`N parcelas`,
  data `dd/mm/aaaa` ou `dd/mm` com contexto de prazo);
- concessão de desconto ("desconto aprovado/concedido/liberado", "dívida perdoada");
- estado que a plataforma não tem: "pagamento confirmado/recebido", "dívida quitada/paga" (só
  com pagamento confirmado), "acordo fechado/firmado" (só com acordo) e "negociação/atendimento
  encerrado" (só com a sessão encerrada);
- fallback/erro do fluxo: "selecione uma das opções válidas", "canal de atendimento
  automático", "não conseguimos encontrar histórico", "opção inválida", menção a
  n8n/workflow/webhook, uuid, `null`/`undefined`/`NaN`, `{{ }}`/`$json` e stack traces.

**Resposta à recusa (`chat.send`):** **422**
`{success:false, code:"text_rejected", reason:<motivo>, error:"…"}`. Nada visível ao devedor é
gravado, nem o prompt. Motivos (`reason`):

| reason | categoria |
|---|---|
| `unverified_amount`, `unverified_percent`, `unverified_installments`, `unverified_date`, `discount_claim` | money |
| `state_claim_paid`, `state_claim_agreement`, `state_claim_closed` | state |
| `engine_fallback_text`, `internal_leak` | fallback |
| `empty_after_sanitize` | empty |

As checagens estruturais do prompt (`validateButtons`, `prompt_not_actionable`,
`prompt_outside_window`) rodam antes e mantêm os códigos da §13.

A categoria **fallback** conta como falha do engine, como o timeout/5xx da §5: a sessão cai no
assistido (`engine='disabled'`, a menos que `NEGOTIATION_ENGINE_FALLBACK=off`) e, se não houver
prompt ativo, o menu de 3 opções é reaberto. No papel A (`reply` síncrono), qualquer recusa
troca o texto pelo reply determinístico do assistido. Os efeitos do turno (ação/acordo) são
mantidos e `events` recebe `n8n_text_rejected`.

Toda recusa grava `journey_events.event_type='chat.engine_text_rejected'` (ator `n8n`) com o
payload `{reason, category, source, text_len, text_hash}`, sem texto cru e sem PII.

## 22. 2026-09-27 — Thread (época) das mensagens do n8n e o reset de 24h (N8N-9)

Depois de 24 h sem mensagem, a autenticação encerra a thread do chat: arquiva as linhas
(`archived_at`) e faz `negotiation_sessions.thread_epoch + 1`. O GET `/api/chat/messages` e o
recap mostram só a época corrente (`thread_epoch` NULL = época 0). O histórico
(`/api/chat/history`) mostra todas e devolve `thread_epoch` por mensagem.

- `chat.send`, `prompt.ask` (e o `chat.turn` síncrono/assíncrono) gravam a época **corrente da
  sessão, lida no servidor no momento da escrita** (`lib/journey/thread-epoch.ts`). O n8n não
  informa nem pode alterar a época; um `thread_epoch` no corpo é ignorado.
- Resposta atrasada: se `args.n8n_execution_id` já gravou linhas **só** na thread encerrada (a
  execução começou antes do reset), `chat.send`/`prompt.ask` devolvem **409**
  `{code:'thread_epoch_stale'}` e nada é gravado (nem texto nem prompt). Auditoria:
  `chat.engine_invalid_action` com `payload.code='thread_epoch_stale'` (sem texto). Não re-tentar.
  O fluxo deve mandar `n8n_execution_id` (`$execution.id`) em todo `chat.send`/`prompt.ask`.
- Clique num prompt da thread encerrada (aba aberta desde antes do reset) nunca é re-alvejado ao
  menu da thread nova: **409** `prompt_stale` com o prompt ativo (o client re-hidrata).

## 23. 2026-09-28 — Integração (branch `integration/n8n-latency-2026-09-28`)

As seções 14–22 foram escritas em branches paralelas e renumeradas aqui (antes havia três §15 e
dois §14). Mapa: §14 N8N-14 · §15 N8N-13 · §16 N8N-1 · §17 N8N-10 · §18 N8N-16 · §19 N8N-15 ·
§20 N8N-2 · §21 N8N-6 · §22 N8N-9. Decisões de integração que valem para todas:

- **Ordem dentro de `POST /api/webhooks/n8n`:** rate limit pré-auth (só para requisição sem
  assinatura válida, N8N-12) → HMAC com segredo atual ou `N8N_WEBHOOK_SECRET_PREVIOUS` (N8N-4) →
  parse → adaptador do envelope legado (N8N-2) → correlação (N8N-16) → rate limit por identidade
  (N8N-12) → ação. No `chat.send`: contrato de botões (rótulo do servidor) → dedupe por `event_id`
  → época da thread (N8N-9) → guard de texto (N8N-6, que vê o rótulo do servidor) → escrita. No
  `payment.create`: alias (N8N-15) → efeito → instruções PIX/boleto. Teste:
  `tests/webhooks/n8n.route-order.integration.test.ts`.
- **Saída assina só com o segredo atual** (`N8N_WEBHOOK_SECRET`); `_PREVIOUS` só é aceito na entrada.
- **`session.start`:** um só mecanismo — INSERT no `engine_outbox` (fora do caminho do login quando
  há `waitUntil`) e entrega pela `deferDelivery`, que registra no `waitUntil` de
  `lib/journey/after-response.ts` e nunca é aguardada: o login nunca espera o n8n.
- **Fluxos n8n:** compor só com `ops/n8n-sync-fix/n8n5/compose_chain.py` e aplicar só com
  `ops/n8n-sync-fix/tools/apply-workflow.mjs`, na ordem `2 → 3 → 5 → 7 → 4 → 1.1…1.7 → 1. Main → 6`.
  O `1. Main` do N8N-16 não responde mais `200 "Workflow was started"` antes do roteamento.
- Plano de implantação: `ops/negociacao-final/13-plano-rollout-integracao.md`.

## 24. 2026-09-28 — Achados de segurança fechados

| Achado | Mudança | Flag / default |
|---|---|---|
| `session.create` fora da correlação: quem tem o segredo HMAC criava sessão + deep link (até com `identity_verified:true`) para qualquer documento | Ação atrás de flag. OFF → **403** `n8n_session_create_disabled`, antes de qualquer leitura de banco. Nenhum fluxo do n8n usa a ação (as sessões nascem em `/n/`, `/t/`, `/c/`, handoff). `lib/negotiation/n8n-session-create.ts` | `N8N_SESSION_CREATE_ENABLED`, **OFF** |
| `callback_url` do modo async aceitava qualquer URL | `isAllowedN8nCallbackUrl` (`lib/negotiation/n8n.ts`): mesma origem de um fluxo n8n por env (`isConfiguredN8nOrigin`), sem usuário/senha na URL. Route → **422** `callback_url_not_allowed` sem enfileirar; o worker confere de novo antes do turno e termina sem POST e sem retry | — |
| `lib/security-logger.ts` gravava o 1º elemento cru do `x-forwarded-for` | `security_events.ip_address` = `clientIpHash(resolveClientIp(headers))`: hash salgado (`CLIENT_IP_HASH_SALT`, 16 hex) do IP da fonte confiável; sem fonte ou sem sal → `null`. Nenhum consumidor lê o IP em claro. Linhas antigas continuam com o valor cru | segue `TRUSTED_CLIENT_IP_SOURCE` |
| `session.init` legado (só com `N8N_SESSION_FLOW_URL`) mandava nome completo e documento | Corpo = `buildSessionInitPayload` (`lib/negotiation/engine.ts`): `first_name`, `document_masked`, `document_hash` (sha256 dos dígitos). O engine `agent` (self-hosted) continua recebendo o payload completo | `N8N_SESSION_FLOW_URL` ausente em produção |

Testes: `tests/webhooks/n8n.security-findings.test.ts`, `tests/negotiation/n8n-worker-callback-url.test.ts`,
`tests/http/security-logger-ip.test.ts`, `tests/negotiation/session-init-pii.test.ts`.
