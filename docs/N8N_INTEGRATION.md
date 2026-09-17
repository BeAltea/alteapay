# Integração n8n ⇄ Chatbot AlteaPay — n8n como cérebro da conversa

**Última atualização:** 2026-09-01 (pivô: fluxos n8n conduzem a conversa; o
agente LangGraph interno foi descontinuado do caminho de produto)

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
