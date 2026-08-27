# Integração n8n ⇄ Chatbot de Negociação AlteaPay

**Endpoint:** `POST /api/webhooks/n8n`
**Branch:** `feature/chatbot-n8n-webhook` (alteapay-v2)
**Última atualização:** 2026-08-27

Este documento é o guia completo para conectar fluxos do n8n ao chatbot de
negociação da AlteaPay: arquitetura, segurança (HMAC), referência de API,
receitas de fluxo no n8n e troubleshooting.

---

## 1. Arquitetura

```
┌─────────────┐   POST /api/webhooks/n8n (HMAC)   ┌──────────────────────┐
│   Fluxo     │ ─────────────────────────────────▶ │  AlteaPay v2 (BFF)   │
│   n8n       │ ◀───────────────────────────────── │  app/api/webhooks/   │
│             │      resposta sync OU 202          │  n8n/route.ts        │
│  Webhook    │                                    └─────────┬────────────┘
│  node       │                                              │ x-app-token
│  (callback) │                                    ┌─────────▼────────────┐
│      ▲      │                                    │  negotiation-agent   │
│      │      │                                    │  (FastAPI/LangGraph) │
│      │      │       callback assinado (HMAC)     │  /session/init /chat │
│      └──────┼──── worker BullMQ `alteapay-n8n` ◀─┴──────────────────────┘
└─────────────┘
```

- O n8n **nunca fala direto com o agente** — todo tráfego passa pelo BFF da
  v2, que autentica, audita (`conversation_messages`), aplica rate limit e
  atualiza o funil da sessão (`negotiation_sessions`).
- Sessões criadas via n8n têm `channel_origin='n8n'`; mensagens têm
  `channel='n8n'`. Toda a trilha LGPD existente (PII mascarada, mensagens
  imutáveis, tool_calls + prompt_version por turno) se aplica igualmente.
- No modo **async**, o turno roda no worker (fila `alteapay-n8n`,
  concorrência 1 — GPU única no host) e o resultado é entregue em um Webhook
  node do seu fluxo, **assinado com o mesmo esquema HMAC**.

---

## 2. Segurança

### 2.1 Esquema de assinatura (obrigatório em todo request)

Cada request ao webhook DEVE conter dois headers:

| Header | Conteúdo |
|---|---|
| `x-alteapay-timestamp` | Epoch em **segundos** (inteiro) do momento do envio |
| `x-alteapay-signature` | `sha256=` + HMAC-SHA256 hex de `` `${timestamp}.${corpoRaw}` `` com `N8N_WEBHOOK_SECRET` |

Regras aplicadas pelo servidor:

- **Janela anti-replay:** \|agora − timestamp\| ≤ **300s**, senão `401 timestamp fora da janela`.
- **Assinatura sobre o corpo cru** (bytes exatamente como enviados) concatenado
  ao timestamp — reenviar um corpo capturado com outro timestamp invalida a
  assinatura.
- Comparação em **tempo constante** (`timingSafeEqual`).
- Secret ausente no servidor → `503` (endpoint desligado por configuração).

Os **callbacks** do modo async são assinados pelo AlteaPay com o MESMO esquema
e os MESMOS headers — valide-os no seu fluxo (ver §5.3).

### 2.2 Onde vive o secret

- **Cluster local:** `Secret alteapay-app-secrets` (namespace `alteapay-app`),
  chave `N8N_WEBHOOK_SECRET`. O script
  `scripts/bootstrap-k8s-secrets.sh` gera (ou preserva) o valor — rode-o
  sempre depois de `kubectl apply -k k8s/base/` (o apply sobrescreve o secret
  com placeholders).
- Para ler o valor em uso:

```bash
kubectl get secret alteapay-app-secrets -n alteapay-app \
  -o jsonpath='{.data.N8N_WEBHOOK_SECRET}' | base64 -d
```

- No n8n, guarde-o como **credencial/variável de ambiente** (ex.:
  `ALTEAPAY_N8N_SECRET`) — nunca hardcoded no fluxo.

### 2.3 Demais camadas

- Rate limit: **120 req/min por IP** no webhook + **20 msg/min por sessão**.
- Idempotência opcional por `event_id` (§6).
- Consentimento LGPD é pré-condição para `session.message` (§4.2).
- No cluster local, a NetworkPolicy só permite egress para CIDRs privados —
  o callback do modo async só alcança um n8n em rede local/privada
  (ex.: `http://host.orb.internal:5678/...`).

---

## 3. URL base

| Ambiente | URL |
|---|---|
| Cluster local (LoadBalancer OrbStack) | `http://<EXTERNAL-IP>:3000/api/webhooks/n8n` (`kubectl get svc alteapay-web -n alteapay-app`) |
| Port-forward | `kubectl -n alteapay-app port-forward svc/alteapay-web 3000:3000` → `http://localhost:3000/api/webhooks/n8n` |
| Produção (futuro) | `https://alteapay.com/api/webhooks/n8n` |

---

## 4. Referência da API

Todas as ações usam `POST /api/webhooks/n8n` com um corpo JSON contendo o
campo discriminador **`action`**. Respostas seguem o padrão
`{ "success": true|false, ... }`.

### 4.0 `ping` — teste de conectividade e assinatura

```json
{ "action": "ping" }
```

Resposta: `{ "success": true, "service": "alteapay-chatbot", "agent": { "ok": true } }`
(`agent.ok=false` indica o agente de negociação fora do ar — mensagens vão falhar).

### 4.1 `session.create` — cria sessão de negociação

```json
{
  "action": "session.create",
  "company_id": "<uuid do tenant>",
  "document": "12345678901",          // OU "debt_id": "<uuid>"
  "identity_verified": false,          // true SOMENTE se o fluxo já validou CPF+data de nascimento
  "debt_acknowledged": false,
  "consent": true                      // consentimento LGPD colhido no canal de origem
}
```

- `document`: localiza o cliente do tenant (CPF/CNPJ, com ou sem máscara) e
  usa a dívida `pending` mais antiga. `debt_id` tem precedência e dispensa o
  documento.
- A sessão é criada com `channel_origin='n8n'` e o thread do agente é
  **semeado imediatamente** (`/session/init`) — dá para conversar
  server-to-server sem abrir o chat web.
- `consent: true` registra o consentimento LGPD (versão corrente) na criação.
  **Sem consentimento a sessão não aceita mensagens** — colha-o no seu canal
  ("Você concorda em negociar por este canal? …") antes de criar a sessão, ou
  não use e apenas envie o `deep_link` (o chat web colhe o consentimento na
  interface).
- `identity_verified: true` pula o identity gate do agente. Use APENAS se o
  fluxo n8n validou CPF + data de nascimento do devedor. Com `false`, o
  próprio agente conduz a verificação nas primeiras mensagens.

Resposta:

```json
{
  "success": true,
  "session_id": "…", "thread_id": "web_…",
  "token": "…64 hex… (mostrado UMA única vez)",
  "deep_link": "http://…/negociar/<token>",
  "expires_at": "2026-08-28T…", "fulfillment_mode": "A",
  "consent_recorded": true
}
```

Dois jeitos de usar:
1. **Handoff para o chat web:** envie o `deep_link` ao devedor (WhatsApp,
   e-mail, SMS — o que o fluxo n8n orquestrar). Single-use, TTL 24h.
2. **Conversa server-to-server:** guarde `session_id` e use `session.message`.

### 4.2 `session.message` — um turno de conversa

```json
{
  "action": "session.message",
  "session_id": "<uuid>",
  "message": "texto do devedor (1–2000 chars)",
  "mode": "sync",                      // ou "async"
  "callback_url": "http://…",          // obrigatório no async
  "event_id": "id-único-do-seu-fluxo", // opcional, idempotência
  "metadata": { "qualquer": "coisa" }  // opcional, ecoado no callback
}
```

**Sync** (default): a resposta chega inline. Atenção: com o modelo local
(qwen2.5:14b em GPU única) um turno leva **~100–120s** — configure o timeout
do HTTP Request node para ≥ 180000 ms, ou prefira async.

```json
{
  "success": true, "session_id": "…",
  "reply": "texto do agente",
  "action": null | "agreement_closed" | "redirect_payment" | "redirect_attendance" | "handoff",
  "agreement_id": null, "verified": false,
  "events": ["identity_verified", …], "prompt_version": "5"
}
```

**Async**: retorna `202 { "success": true, "queued": true, "job_id": "…" }` e o
resultado (mesmo shape acima, mais `event_id` e `metadata`) é POSTado no
`callback_url`, assinado (§2.1). Falha de entrega → 3 tentativas com backoff;
o turno do LLM **não** é re-executado (resultado cacheado).

Erros relevantes: `403` consentimento pendente, `404` sessão inexistente,
`429` rate limit, `502` agente indisponível.

### 4.3 `session.status` — funil e links de pagamento

```json
{ "action": "session.status", "session_id": "<uuid>" }
```

```json
{
  "success": true, "session_id": "…",
  "outcome": "in_progress" | "agreement_closed" | "redirected_official" | "handoff_human" | "abandoned" | "identity_failed" | "expired",
  "identity_verified": true, "consent_recorded": true,
  "channel_origin": "n8n", "created_at": "…",
  "agreement": {
    "id": "…", "agreed_amount": 950.0, "installments": 1,
    "asaas_boleto_url": "…", "asaas_pix_qrcode_url": "…",
    "asaas_invoice_url": "…", "asaas_payment_url": "…"
  }
}
```

Os links ASAAS são preenchidos **assincronamente** pela fila de cobrança após
`action: "agreement_closed"` — faça polling curto (2–5s) até aparecerem.

---

## 5. Receitas no n8n

### 5.1 Assinando requests (Code node antes do HTTP Request)

Adicione um **Code node** que monta corpo + headers:

```javascript
// Code node (Run Once for Each Item) — assina o request para o AlteaPay
const crypto = require('crypto');

const secret = $env.ALTEAPAY_N8N_SECRET;      // credencial/env do n8n
const body = {
  action: 'session.message',
  session_id: $json.session_id,
  message: $json.message,
  mode: 'async',
  callback_url: 'http://host.orb.internal:5678/webhook/alteapay-reply',
  event_id: $execution.id + '-' + $itemIndex,
  metadata: { execution: $execution.id },
};

const raw = JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const sig = 'sha256=' + crypto.createHmac('sha256', secret)
  .update(`${ts}.${raw}`).digest('hex');

return [{ json: { raw, ts, sig } }];
```

**HTTP Request node** em seguida:

- Method: `POST` — URL: `http://<alteapay>/api/webhooks/n8n`
- Send Headers: `x-alteapay-timestamp: {{$json.ts}}`,
  `x-alteapay-signature: {{$json.sig}}`, `Content-Type: application/json`
- Body Content Type: **Raw** → `{{$json.raw}}`
  ⚠️ **Envie exatamente a string `raw` assinada.** Se o n8n re-serializar o
  JSON (Body "JSON" montado no próprio node), a assinatura quebra.
- Timeout: 30000 ms (async) ou ≥ 180000 ms (sync).

### 5.2 Fluxo 1 — disparo de negociação com deep link

```
[Trigger: dívida vencida / planilha / CRM]
  → [Code: assina {action:'session.create', company_id, document, …}]
  → [HTTP Request → AlteaPay]
  → [IF success]
      → [WhatsApp/Email/SMS node: envia $json.deep_link ao devedor]
      → [Wait / Cron → Code assina session.status → HTTP Request → registra outcome no CRM]
```

O devedor negocia no chat web (consentimento + identidade na interface);
o fluxo n8n só distribui o link e acompanha o desfecho.

### 5.3 Fluxo 2 — relay conversacional (canal externo ⇄ chatbot)

Conecta qualquer canal que o n8n fale (Telegram, live chat, CRM…) ao agente:

```
[Trigger: mensagem do devedor no canal X]
  → [1ª mensagem? → Code assina session.create (consent:true após opt-in no canal)]
  → [Code: assina session.message mode:'async' + callback_url]
  → [HTTP Request → AlteaPay]  (202 imediato)

[Webhook node: /webhook/alteapay-reply]     ← callback assinado do AlteaPay
  → [Code: VALIDA a assinatura do callback — abaixo]
  → [Canal X: envia $json.reply ao devedor]
  → [IF action == 'agreement_closed' → session.status até links ASAAS → envia boleto/PIX]
```

Validação do callback (Code node logo após o Webhook node — configure o
Webhook node com **Raw Body** ligado):

```javascript
const crypto = require('crypto');
const secret = $env.ALTEAPAY_N8N_SECRET;

const raw = $json.body instanceof Object ? JSON.stringify($json.body) : $json.body;
const ts  = $json.headers['x-alteapay-timestamp'];
const sig = $json.headers['x-alteapay-signature'];

const expected = 'sha256=' + crypto.createHmac('sha256', secret)
  .update(`${ts}.${raw}`).digest('hex');

if (sig !== expected || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
  throw new Error('callback com assinatura inválida — descartado');
}
return [{ json: JSON.parse(raw) }];
```

> Se o Webhook node não expuser o raw body idêntico, prefira validar com
> comparação do JSON re-serializado APENAS se você controla a rede; o ideal é
> Raw Body ativado.

### 5.4 Fluxo 3 — cobrança pós-acordo

Após `agreement_closed`, os links de pagamento chegam pela fila de cobrança:

```
[IF action == 'agreement_closed']
  → [Wait 5s] → [Code assina session.status → HTTP Request]
  → [IF agreement.asaas_payment_url vazio → loop (máx. 6x)]
  → [Envia boleto/PIX pelo canal do devedor]
```

---

## 6. Idempotência

- Passe um `event_id` estável por mensagem (ex.: id da mensagem no canal de
  origem). Retries do n8n com o mesmo `event_id`:
  - turno já concluído → resposta com `duplicate: true` + resultado cacheado (1h);
  - turno em andamento → `duplicate: true` sem resultado (aguarde o callback).
- Janela de deduplicação: 24h (Redis do cluster).

---

## 7. Códigos de erro

| Status | Significado | Ação no fluxo |
|---|---|---|
| 400 | JSON inválido | corrigir Code node |
| 401 | assinatura/timestamp inválidos | conferir secret, raw body e relógio |
| 403 | consentimento LGPD pendente | recriar sessão com `consent:true` ou usar deep link |
| 404 | sessão/cliente/dívida não encontrados | conferir ids e tenant |
| 409 | sessão sem thread | recriar a sessão |
| 422 | corpo não passa na validação (`issues` no corpo) | corrigir campos |
| 429 | rate limit (120/min IP; 20/min sessão) | backoff |
| 502 | agente de negociação fora do ar | retry com backoff; conferir `ping` |
| 503 | `N8N_WEBHOOK_SECRET` não configurado no servidor | rodar bootstrap de secrets |

---

## 8. LGPD

- Consentimento é **pré-condição** de conversa (igual ao chat web). Via n8n:
  colha o opt-in no canal de origem e envie `consent:true` no
  `session.create`; o registro guarda data e versão do texto de consentimento.
- Mensagens são auditadas em `conversation_messages` (imutável, PII mascarada
  em `content_redacted`, `tool_calls` + `prompt_version` por turno — art. 20).
- `identity_verified:true` transfere ao fluxo n8n a responsabilidade da
  verificação de identidade — documente COMO o fluxo validou (CPF + data de
  nascimento no canal de origem).
- Não logue CPF/telefone em nodes do n8n; use os campos mascarados.

---

## 9. Teste rápido por curl

```bash
SECRET=$(kubectl get secret alteapay-app-secrets -n alteapay-app \
  -o jsonpath='{.data.N8N_WEBHOOK_SECRET}' | base64 -d)
URL=http://localhost:3000/api/webhooks/n8n   # via port-forward

BODY='{"action":"ping"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"

curl -s "$URL" -H "content-type: application/json" \
  -H "x-alteapay-timestamp: $TS" -H "x-alteapay-signature: $SIG" \
  -d "$BODY"
```

Esperado: `{"success":true,"service":"alteapay-chatbot","agent":{"ok":true}}`.

---

## 10. Troubleshooting

| Sintoma | Causa provável |
|---|---|
| `401 assinatura inválida` sempre | Body re-serializado pelo n8n (use Raw), ou secret divergente (rotação pelo bootstrap sem atualizar o n8n) |
| `401 timestamp fora da janela` | Relógio do host do n8n dessincronizado (>5 min) |
| `502` no `session.create`/`message` | `negotiation-agent` fora do ar ou Ollama do host parado (`ollama ls`) |
| Callback nunca chega | n8n fora da rede privada (NetworkPolicy bloqueia egress público) ou `callback_url` errado; ver logs do worker: `kubectl logs deploy/alteapay-workers -n alteapay-app \| grep N8N` |
| Sync estoura timeout | Turno local leva ~100–120s; aumente o timeout do node ou use async |
| Links ASAAS `null` após acordo | Fila de cobrança ainda processando — polling de `session.status` |

**Logs úteis:**

```bash
kubectl logs deploy/alteapay-web -n alteapay-app | grep "webhooks:n8n"
kubectl logs deploy/alteapay-workers -n alteapay-app | grep "N8N"
kubectl logs deploy/negotiation-agent -n alteapay-negotiation --tail=50
```
