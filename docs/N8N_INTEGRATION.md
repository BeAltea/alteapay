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
- Rate limit inbound: 120 req/min/IP + 20 msg/min/sessão. Idempotência por `event_id` (§7).
- Invariantes do servidor: descontos SEMPRE de `charge-rules` (buckets de
  aging); URL de canal oficial SEMPRE de `tenant_chat_config`;
  `agreement.close` exige sessão com consentimento + identidade verificada.

## 3. Variáveis de ambiente

| Env | Uso |
|---|---|
| `NEGOTIATION_ENGINE` | `n8n` (padrão). `agent` só para o rig de treino local legado |
| `N8N_WEBHOOK_SECRET` | HMAC compartilhado (openssl rand -hex 32) |
| `N8N_CHAT_FLOW_URL` | URL do Webhook trigger do fluxo-cérebro |
| `N8N_SESSION_FLOW_URL` | opcional — fluxo notificado em `session.init` |
| `N8N_FLOW_TIMEOUT_MS` | timeout da chamada ao fluxo (default 60000) |

---

## 4. Contrato do fluxo-cérebro (`N8N_CHAT_FLOW_URL`)

### Request (plataforma → fluxo), tipo `chat.turn`

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
| `session.create` | cria sessão (registro + `deep_link` single-use TTL 24h) | `company_id`, `document` OU `debt_id`, `consent`, `identity_verified`, `debt_acknowledged` |
| `session.message` | turno completo conduzido pela plataforma (ela chama o fluxo-cérebro) | `session_id`, `message`, `mode: sync\|async`, `callback_url`, `event_id`, `metadata` |
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
| `payment.create` | **Variante A (default):** guard SEMPRE → `agreements` → cobrança ASAAS pelo caminho existente (`close-agreement` + chargeQueue) → aceite + eventos | `{agreement_id, payment_id, billing_type, pix_copy_paste, boleto_url, invoice_url, due_date, total_value, installments}` ou `{status:"processing", poll_after_ms:3000}` (worker 0/0) |
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
