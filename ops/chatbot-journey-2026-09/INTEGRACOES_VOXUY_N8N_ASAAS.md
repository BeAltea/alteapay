# Integrações AlteaPay — Voxuy · n8n · ASAAS (guia para o time do n8n)

**Estado:** implementado e validado na branch `feature/chatbot-journey`, **atrás de flags desligadas** (produção sem mudança de comportamento). Contratos abaixo refletem o **código real**. Última atualização: 2026-09-18.

> Convenção de assinatura (n8n ↔ AlteaPay, nos dois sentidos): **HMAC-SHA256** de `${timestamp}.${body}` com o segredo `N8N_WEBHOOK_SECRET`. Headers: `x-alteapay-signature` e `x-alteapay-timestamp` (epoch em segundos). Janela de tolerância **±300 s**. Idempotência por `event_id`.

---

## 0. Fluxo canônico

```
1. AlteaPay → Voxuy: dispara a transação com os dados do cliente + link do chat
2. Voxuy → WhatsApp: envia a mensagem do funil com o link (/c/{token})
3. Cliente → Chat: acessa, autentica por CPF/CNPJ, e negocia (fluxo do n8n conduz)
4. n8n → AlteaPay: no aceite, pede a criação da cobrança (payment.create); recebe o link
5. ASAAS → AlteaPay: webhook confirma o pagamento (fonte da verdade)
6. AlteaPay: exibe status atualizado + histórico ao cliente e no painel
```

**O que o time do n8n constrói:** o **fluxo-cérebro** (§2) que recebe cada turno do chat (`chat.turn`) e responde com a fala + a ação; e, quando decide fechar, chama as ações de domínio (§3), sendo a principal `payment.create`.

---

## 1. Voxuy (AlteaPay → Voxuy) — já implementado

A AlteaPay dispara; a Voxuy agenda o funil. **A API da Voxuy é só de entrada** (não há webhook de saída nem blacklist — o opt-out é controlado pela AlteaPay).

- **Endpoint:** `POST` na URL de webhook da conta (contém o `<codigo>`; tratada como segredo `VOXUY_WEBHOOK_URL`). `Content-Type: application/json`. Autenticação: campo **`apiToken`** no corpo.
- **Payload (minimização de PII — sem CPF, sem valor):**

```json
{
  "apiToken": "<VOXUY_API_TOKEN>",
  "id": "<whatsapp_messages.id>",
  "planId": "<tenant.voxuy_plan_id>",
  "customEvent": 63,
  "paymentType": 99,
  "status": 99,
  "clientName": "Fabio",
  "clientPhoneNumber": "+5511912341234",
  "clientEmail": null, "clientDocument": null,
  "value": null, "totalValue": null, "date": null,
  "metadata": {
    "consult_url": "https://alteapay.com/c/AbC...",
    "optout_url": "https://alteapay.com/c/AbC.../cancelar?k=...",
    "block_url": "https://alteapay.com/c/AbC.../bloquear?k=...",
    "brand_name": "AlteaPay", "creditor_name": "VMAX", "first_name": "Fabio"
  }
}
```

- **Resposta:** `200 {"Success": true}` · `400` com `errors` por campo + `traceId`. Detalhes completos em `docs/WHATSAPP_VOXUY_INTEGRATION.md`.

O link `metadata.consult_url` abre o chat (§2). **O n8n não interage com a Voxuy** — só com o chat.

---

## 2. n8n — Papel A: o fluxo recebe cada turno (AlteaPay → n8n)

A cada mensagem do cliente, a AlteaPay faz `POST` **assinado** para a URL do fluxo (`tenant.n8n_chat_flow_url` → `N8N_CHAT_FLOW_URL`). O fluxo é **stateless**: todo o contexto viaja no payload; para memória de conversa, use `thread_id` como chave.

### 2.1 Request — o que o n8n RECEBE (`chat.turn`)

```json
{
  "type": "chat.turn",
  "thread_id": "th_9f...",
  "session_id": "uuid-da-sessao",
  "company_id": "uuid-do-tenant",
  "channel": "webchat",
  "message": "consigo pagar em 2x?",
  "session_state": {
    "identity_verified": true,
    "debt_acknowledged": false,
    "fulfillment_mode": "A",
    "outcome": null
  },
  "debtor": {
    "name": "Fabio",
    "document_masked": "390.***.**7-05",
    "document_hash": "b1e2...sha256hex",
    "document": null
  },
  "debt": {
    "id": "uuid-da-divida",
    "amount": 418.90,
    "due_date": "2025-03-10",
    "description": "Contrato ...",
    "aging_days": 557
  },
  "tenant": {
    "fulfillment_mode": "A",
    "official_channel_label": "Atendimento VMAX"
  }
}
```

> **PII:** `debtor.document` é **`null` por padrão** — o fluxo recebe só `document_masked` + `document_hash`. O documento em claro só viaja se o tenant tiver **as duas flags** `send_document_to_engine=true` **e** `payment_origin='n8n'` (variante B). `debt.amount` é o valor da dívida em **reais** (decimal), como armazenado. A URL do canal oficial **não** viaja (o servidor a resolve; o LLM nunca a manuseia).

### 2.2 Response — o que o n8n DEVE devolver

Só `reply` é obrigatório. Campos desconhecidos são ignorados.

```json
{
  "reply": "Posso fazer em 2x no boleto com 18% de desconto. Fecha assim?",
  "action": null,
  "events": [],
  "verified": false,
  "agreement_id": null,
  "close_offer_id": null,
  "n8n_execution_id": "exec_123",
  "tool_calls": [],
  "prompt_version": "n8n-flow"
}
```

- **`reply`** (string, obrigatório): o texto que o cliente vê.
- **`action`** (opcional): `"agreement_closed"` | `"redirect_payment"` | `"redirect_attendance"` | `"handoff"` — sinaliza o desfecho do turno.
- **`close_offer_id`** (opcional): `"avista"` | `"parc_N"` — pede que **o SERVIDOR** feche o acordo com as regras oficiais de desconto (caminho preferido em vez de chamar `agreement.close` à parte). Fechar acordo e obter link de pagamento são operações do servidor.
- **`n8n_execution_id`** (opcional, recomendado): id da execução do fluxo, gravado por turno para correlação/observabilidade.
- Resposta inválida (sem `reply`, JSON quebrado, timeout > `N8N_TIMEOUT_MS`) → o cliente vê uma mensagem neutra e o servidor loga `chat.engine_error`. Sem expor erro interno.

---

## 3. n8n — Papel B: o fluxo chama a AlteaPay (n8n → AlteaPay)

Quando o fluxo decide agir (listar ofertas, propor, **criar a cobrança**, etc.), ele chama:

**`POST https://alteapay.com/api/webhooks/n8n`** — assinado (HMAC, §topo). Envelope:

```json
{ "action": "payment.create", "session_id": "uuid", "event_id": "uuid-por-acao", "args": { } }
```

`session_id` (uuid) é obrigatório; `event_id` garante idempotência (reenviar a mesma ação não duplica efeito). A AlteaPay deriva `company_id` da sessão no servidor — **o n8n nunca envia/forja tenant ou identidade**.

### 3.1 Ações disponíveis

| `action` | `args` | Efeito | Resposta |
|---|---|---|---|
| `debt.summary` | — | leitura | `{success:true, summary:{...}}` |
| `offer.list` | — | ofertas da matriz | `{success:true, offers:[{offer_id, terms}]}` |
| `offer.propose` | `{ terms:{discount_pct,installments,entry_value,billing_type,...} }` | valida contra a matriz | ok: `{success:true, offer_id}` · inválida: `422 {code, offer_id}` |
| `offer.accept` | `{ offer_id }` | fecha via guard | `{success:true, agreement_id}` · `409 {code}` |
| `offer.reject` | `{ offer_id, reason? }` | marca recusada | `{success:true}` |
| **`payment.create`** | `{ offer_id }` | **cria a cobrança (guard SEMPRE)** — ver §3.2 | link do pagamento (ver abaixo) |
| `payment.record` | ver §3.3 (variante B) | registra cobrança criada fora | `{ok:true, code:"recorded"\|"claim", ...}` |
| `payment.status` | — | status atual (segue o ASAAS) | `{ok:true, ...}` |
| `payment_claim.register` | `{ paidAt?, amount?, channel?, note? }` | registra "já paguei" como *claim* | `{success:true, case_id}` |
| `dispute.register` | `{...}` | contestação | `{success:true, case_id}` |
| `human.transfer` | `{ reason }` | encaminha a humano | `{success:true, case_id}` |
| `negotiation.note` | `{...}` | nota na timeline | `{success:true}` |
| `session.close` | `{ outcome? }` | encerra a sessão | `{success:true}` |
| `journey.timeline` | — | timeline de eventos | `{success:true, timeline:[...]}` |

### 3.2 `payment.create` (o principal — variante A, padrão)

O fluxo **decide** criar a cobrança; a **plataforma executa** (aplica o guard de idempotência — nunca cobra 2x — e usa a matriz + o caminho ASAAS já testado). Exige **sessão verificada**.

Request:
```json
{ "action": "payment.create", "session_id": "uuid", "event_id": "uuid", "args": { "offer_id": "uuid-da-oferta" } }
```

Resposta (cobrança pronta) — **é o link que o fluxo manda no chat**:
```json
{
  "ok": true,
  "agreement_id": "uuid",
  "payment_id": "pay_123",
  "billing_type": "PIX",
  "pix_copy_paste": "00020126...",
  "boleto_url": null,
  "invoice_url": "https://www.asaas.com/i/...",
  "due_date": "2026-09-25",
  "total_value": 272.29,
  "installments": 1
}
```

Resposta (worker de cobrança desligado — link ainda gerando):
```json
{ "ok": true, "status": "processing", "agreement_id": "uuid", "poll_after_ms": 3000 }
```
Nesse caso o fluxo/UI faz polling e obtém o link no `payment.status` seguinte. **Para o chat operar de ponta a ponta, o worker de cobrança precisa estar ligado.**

Notas: **PIX não parcela** (parcelado só boleto/cartão). Cartão devolve `invoice_url` do ASAAS (dados de cartão nunca passam pela AlteaPay nem pelo n8n). `externalReference` é determinístico `journey_{sessionId}_{offerId}`.

### 3.3 `payment.record` (variante B — só se o tenant usar `payment_origin='n8n'`)

Se o fluxo criar a cobrança direto no ASAAS, registra aqui. **Guard antes** (recusa se a dívida já tem cobrança viva) e **NUNCA aceita status pago**.

Request:
```json
{ "action": "payment.record", "session_id": "uuid", "event_id": "uuid",
  "args": { "offer_id": "uuid", "asaas_customer_id": "cus_...", "asaas_payment_id": "pay_...",
    "billing_type": "BOLETO", "invoice_url": "https://...", "due_date": "2026-09-25",
    "total_value": 272.29, "installments": 2, "status": "pending" } }
```
Resposta: `{ok:true, code:"recorded", agreement_id}` · se vier com status pago → vira *claim*: `{ok:true, code:"claim", case_id}` · duplicidade → `409 already_charged`.

### 3.4 Erros (sempre `{ ok:false, code, message }`, sem PII)
`401` assinatura/janela inválida · `403` sessão não verificada · `409` conflito (`already_charged`) · `422` validação de oferta (`DISCOUNT_ABOVE_MAX`, `INSTALLMENTS_ABOVE_MAX`, `ENTRY_BELOW_MIN`, `VALUE_BELOW_MIN`, `BILLING_TYPE_NOT_ALLOWED`) · `404` sessão inexistente/fechada.

---

## 4. ASAAS — fonte da verdade do pagamento

- A cobrança nasce da decisão do n8n via `payment.create` (§3.2) — a AlteaPay cria o `customer`/`payment` no ASAAS pelo código existente e devolve o link (PIX copia-e-cola / boleto / `invoice_url`).
- **O n8n nunca declara pagamento.** O status só muda o acordo quando o **webhook do ASAAS** (`PAYMENT_RECEIVED`/`CONFIRMED`) ou o `sync-payments` confirmar. "Já paguei" vindo do cliente vira `payment_claim` (não muda o acordo).
- A chave ASAAS de produção fica **só** no Netlify/ECS (variante A). Na variante B, o n8n usaria uma **credencial ASAAS separada** (rotação combinada).

---

## 5. O que o time do n8n precisa entregar / decidir (Apêndice D)

Para fechar a integração ponta a ponta (ver também `docs/N8N_FLOW_REQUIREMENTS.md`):
1. URL do fluxo-cérebro (por tenant, se houver mais de um) e onde guardar `N8N_WEBHOOK_SECRET`.
2. Confirmar o **formato exato da resposta** ao `chat.turn` (§2.2) — se divergir, só o mapeador da AlteaPay muda.
3. LLM/modelo e custo por turno.
4. Variante **A** (padrão) ou **B** para o ASAAS.
5. Latência típica/máxima por turno (define síncrono vs assíncrono > `N8N_TIMEOUT_MS`).
6. Como o fluxo trata `409 already_charged` e `422` de oferta inválida (o que diz ao cliente).
7. Memória: usa o `thread_id`/estado próprio ou depende do contexto que enviamos.
8. Disponibilizar `n8n_execution_id` na resposta (observabilidade).
9. Fluxos auxiliares previstos (2ª via, lembrete, pós-pagamento) e quais ações de domínio (§3.1) precisam.

---

## 6. Segurança (resumo)
- Documento **mascarado por padrão** ao n8n; claro só com as 2 flags (§2.1).
- Endpoint de chat fechado ao público (`journey_public_enabled=false`) até o gate de abertura com 2º fator. Detalhes em `docs/CHAT_AUTH_SECURITY.md`.
- Guard de idempotência sempre no `payment.create`/`record`; ASAAS é a fonte da verdade.
- HMAC nos dois sentidos; `event_id` idempotente; `company_id` sempre derivado no servidor.
