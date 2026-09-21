# Guia de Integração para o Time do n8n — AlteaPay (chat de negociação)

**Versão do contrato:** **v2 (2026-09-21)** · **Estado:** implementado na branch `feature/chatbot-journey`, atrás de flags desligadas (produção sem mudança de comportamento). **Autossuficiente:** este documento basta para construir o fluxo do n8n de ponta a ponta.

> **Regra de ouro:** o fluxo do n8n é o **cérebro da conversa** (decide o que dizer e qual ação pedir). A AlteaPay é o **sistema de registro e de ações de domínio** (decide desconto/parcela/validade pela matriz, cria a cobrança, aplica os guards). O fluxo **nunca** fecha acordo, obtém link de pagamento ou declara pagamento por conta própria.

Sumário: [1 Visão geral](#1-visão-geral) · [2 Conceitos](#2-conceitos) · [3 Autenticação HMAC](#3-autenticação-hmac) · [4 chat.turn (request)](#4-chatturn--o-que-o-fluxo-recebe) · [5 Resposta ao chat.turn](#5-resposta-ao-chatturn) · [6 Botões e IDs](#6-catálogo-de-botões-e-ids) · [7 Catálogo de ações](#7-catálogo-de-ações-papel-b) · [8 Sequência de pagamento](#8-sequência-de-pagamento-passo-a-passo) · [9 Tabela de erros](#9-tabela-de-erros) · [10 O que o fluxo NUNCA faz](#10-o-que-o-fluxo-nunca-faz) · [11 Ambiente de teste](#11-ambiente-de-teste) · [12 Checklist de aceite](#12-checklist-de-aceite-do-fluxo) · [13 Limites e prazos](#13-limites-e-prazos) · [14 Glossário e changelog](#14-glossário-e-changelog)

---

## 1. Visão geral

O cliente recebe um link no WhatsApp e abre o chat. Ele autentica por documento (CPF/CNPJ), a AlteaPay valida a identidade e, **como primeira interação**, pergunta com botões: *"você reconhece esta cobrança?"* (onda R). A partir daí, cada mensagem do cliente vira um `chat.turn` assinado, enviado ao **seu fluxo n8n**, que responde a fala e, quando o cliente aceita uma condição, pede à AlteaPay `payment.create`. A AlteaPay cria a cobrança no ASAAS e devolve o link, que o fluxo manda no chat. O pagamento só é confirmado pelo **webhook do ASAAS** (fonte da verdade).

```
WhatsApp(link) → Chat(auth+consent) → Reconhecimento(botões Sim/Não)
      → cliente conversa → [chat.turn → n8n → reply] (loop)
      → cliente aceita → n8n: payment.create → AlteaPay cria cobrança ASAAS → link
      → n8n: chat.send(link) → cliente paga → ASAAS webhook → status atualizado
```

Dois canais entre n8n e AlteaPay, ambos assinados por HMAC (§3):
- **Papel A (AlteaPay → n8n):** a AlteaPay POSTa `chat.turn` no seu fluxo (§4); você responde (§5).
- **Papel B (n8n → AlteaPay):** o fluxo POSTa em `POST /api/webhooks/n8n` com `{action, session_id, event_id, args}` (§7).

---

## 2. Conceitos

| Conceito | O que é |
|---|---|
| **Tenant / credor** | A empresa credora (multi-tenant). A AlteaPay isola tudo por `company_id`, **derivado no servidor** a partir da sessão — o n8n nunca envia/forja tenant. |
| **Cliente / devedor** | A pessoa que deve. Identificada por documento (CPF/CNPJ). O documento viaja **mascarado** ao fluxo por padrão. |
| **Dívida (debt)** | O débito consolidado do cliente naquele tenant. Uma sessão pode consolidar várias dívidas (`debt_ids`), com uma `primary_debt_id`. |
| **Fatura (invoice)** | Item da dívida (detalhe fino: número, vencimento, saldo). |
| **Sessão (session)** | A conversa do chat. Tem `session_id`, `thread_id` (chave de memória), estado (verificada, reconhecimento, outcome). |
| **Oferta (offer)** | Uma condição de pagamento **gerada/validada pela matriz do servidor** (desconto, parcelas, forma). O fluxo escolhe entre ofertas; nunca inventa desconto. |
| **Matriz (matrix)** | As regras do tenant (desconto máximo, entrada mínima, parcelas, formas, validade). O **servidor** decide; a matriz viaja no contexto só para o fluxo saber os limites. |
| **Acordo (agreement)** | A oferta aceita e fechada, com a cobrança ASAAS vinculada. Criado pela AlteaPay. |
| **Cobrança (charge)** | O pagamento no ASAAS (PIX / boleto / cartão) com link, gerada pela AlteaPay. |
| **Reconhecimento (acknowledgement)** | A resposta Sim/Não à pergunta "você reconhece esta cobrança?", registrada em log append-only. Gate do `payment.create`. |
| **Prompt** | Uma pergunta com botões numéricos exibida ao cliente (o reconhecimento é o 1º prompt). |

---

## 3. Autenticação HMAC

Todas as chamadas (nos dois sentidos) são assinadas por **HMAC-SHA256** sobre a string `${timestamp}.${body}`, com o segredo compartilhado `<SEGREDO_COMPARTILHADO>` (variável `N8N_WEBHOOK_SECRET`).

- **Headers:**
  - `x-alteapay-signature`: o HMAC em hex.
  - `x-alteapay-timestamp`: epoch em **segundos** (string).
- **Janela de tolerância:** ±300 s. Fora disso → `401`.
- **`body`:** o corpo **cru** (a mesma string exata que vai no POST). Assine antes de qualquer reserialização.

### Nó Code do n8n — GERAR a assinatura (ao chamar o papel B)

```javascript
// Nó "Code" (Run Once for All Items). Requer: crypto (nativo do Node do n8n).
const crypto = require('crypto');
const SECRET = $env.N8N_WEBHOOK_SECRET; // <SEGREDO_COMPARTILHADO>

const bodyObj = {
  action: 'payment.create',
  session_id: $json.session_id,
  event_id: $json.event_id,        // uuid por ação (idempotência)
  args: { offer_id: $json.offer_id },
};
const body = JSON.stringify(bodyObj);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');

return [{
  json: { body, timestamp, signature },
}];
// No nó HTTP Request seguinte: Body = {{$json.body}} (RAW/JSON como string),
// Headers: x-alteapay-signature={{$json.signature}}, x-alteapay-timestamp={{$json.timestamp}}
```

### Nó Code do n8n — VALIDAR a assinatura (ao receber o chat.turn)

```javascript
// Nó "Code" logo após o Webhook trigger que recebe o chat.turn.
const crypto = require('crypto');
const SECRET = $env.N8N_WEBHOOK_SECRET;

const rawBody = $json.body ? JSON.stringify($json.body) : ''; // use o corpo cru se disponível
const ts = $headers['x-alteapay-timestamp'];
const sig = $headers['x-alteapay-signature'];

const now = Math.floor(Date.now() / 1000);
if (!ts || Math.abs(now - Number(ts)) > 300) {
  throw new Error('timestamp fora da janela (±300s)');
}
const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(sig || '', 'hex'), Buffer.from(expected, 'hex'));
if (!ok) throw new Error('assinatura inválida');

return [{ json: $json.body }];
```

> **Dica:** no Webhook trigger do n8n, habilite "Raw Body" para assinar/validar sobre o corpo exato.

---

## 4. chat.turn — o que o fluxo RECEBE

A cada mensagem do cliente (ou clique de botão), a AlteaPay POSTa no seu fluxo (`N8N_CHAT_FLOW_URL`). O fluxo é **stateless**: todo o contexto viaja aqui; para memória, use `thread_id`.

> **Valores monetários em CENTAVOS (v2).** Documento **MASCARADO** por padrão.

```json
{
  "type": "chat.turn",
  "thread_id": "th_9f2c...",
  "session_id": "uuid-da-sessao",
  "company_id": "uuid-do-tenant",
  "channel": "webchat",
  "message": "consigo pagar em 2x?",
  "session_state": {
    "identity_verified": true,
    "debt_acknowledged": true,
    "fulfillment_mode": "A",
    "outcome": null
  },
  "debt_acknowledgement": {
    "answered": true,
    "acknowledged": true,
    "button_id": 1,
    "answered_at": "2026-09-21T12:00:00.000Z",
    "prompt_id": "uuid-do-prompt"
  },
  "active_prompt": {
    "id": "uuid-do-prompt",
    "kind": "payment_method_choice",
    "question": "Como prefere pagar?",
    "buttons": [
      { "id": 2, "label": "PIX", "value": "PIX" },
      { "id": 3, "label": "Boleto", "value": "BOLETO" }
    ]
  },
  "customer": {
    "first_name": "Fabio",
    "document_type": "cpf",
    "document_masked": "390.***.**7-05",
    "document_hash": "b1e2...sha256hex",
    "document": null
  },
  "debt": {
    "id": "uuid-da-divida",
    "ids": ["uuid-da-divida"],
    "original_value": 41890,
    "updated_value": 45230,
    "oldest_due_date": "2025-03-10",
    "aging_days": 557,
    "invoice_count": 3,
    "invoices": [
      { "invoice": "F123", "due_date": "2025-03-10", "value": 15000 }
    ]
  },
  "matrix": {
    "id": "uuid-matriz",
    "max_discount_pct": 20,
    "min_entry_pct": 20,
    "max_installments": 3,
    "allowed_billing_types": ["PIX", "BOLETO"],
    "proposal_validity_days": 7
  },
  "offers": [
    {
      "id": "uuid-oferta",
      "terms": {
        "discount_pct": 20, "entry_value": 0, "installments": 1,
        "installment_value": 36184, "total_value": 36184,
        "billing_type": "PIX", "first_due_date": "2026-09-28"
      },
      "valid_until": "2026-09-28T00:00:00.000Z"
    }
  ],
  "history_tail": [
    { "role": "assistant", "text": "Olá! Como posso ajudar?" },
    { "role": "customer", "text": "consigo pagar em 2x?" }
  ],
  "available_actions": ["debt.summary","offer.list","offer.propose","offer.accept","payment.create","chat.send","prompt.ask","human.transfer"]
}
```

Campo a campo:
- **`type`**: sempre `"chat.turn"`.
- **`thread_id`**: chave de memória da conversa (estável por sessão).
- **`session_id`**, **`company_id`**: identificadores; `company_id` é informativo (o servidor sempre re-deriva).
- **`channel`**: `webchat` (ou `n8n`/`whatsapp` em cenários auxiliares).
- **`message`**: o texto do cliente (ou o label do botão clicado).
- **`session_state`**: `identity_verified`, `debt_acknowledged`, `fulfillment_mode` (`A`), `outcome`.
- **`debt_acknowledgement`**: reconhecimento da dívida (§ reconhecimento). `answered` (já respondeu?), `acknowledged` (Sim=true/Não=false/`null` se não respondeu), `button_id` (1/0), `answered_at`, `prompt_id`.
- **`active_prompt`**: se há um prompt de botões pendente (o cliente deve clicar). `buttons[].id` são os IDs do §6.
- **`customer`**: `first_name`, `document_type`, `document_masked`, `document_hash`, `document` (`null` por padrão — claro só com as 2 flags).
- **`debt`**: `original_value`/`updated_value` **em centavos**, `oldest_due_date`, `aging_days`, `invoice_count`, `invoices[]` (com `value` em centavos).
- **`matrix`**: limites do tenant (o servidor decide; use só para propor dentro dos limites).
- **`offers[]`**: ofertas válidas atuais, `terms.*` **em centavos**.
- **`history_tail`**: últimas mensagens (contexto curto). Nunca contém documento em claro.
- **`available_actions`**: as ações de domínio permitidas no estado atual.

---

## 5. Resposta ao chat.turn

Só `reply` é obrigatório. Campos desconhecidos são ignorados.

**Exemplo CERTO:**
```json
{
  "reply": "Posso fazer à vista no PIX com 20% de desconto: R$ 361,84. Fecha assim?",
  "action": null,
  "close_session": false,
  "n8n_execution_id": "exec_00123"
}
```

**Exemplo ERRADO (e por quê):**
```json
{
  "message": "...",          // ERRADO: o campo é "reply", não "message"
  "discount_pct": 35,        // ERRADO: o fluxo NÃO decide desconto (é da matriz)
  "payment_link": "https://..." // ERRADO: link só a AlteaPay gera via payment.create
}
```

- **`reply`** (obrigatório): o texto que o cliente vê.
- **`action`** (opcional): `agreement_closed` | `redirect_payment` | `redirect_attendance` | `handoff`.
- **`close_session`** (opcional): `true` encerra a sessão após a resposta.
- **`n8n_execution_id`** (opcional, recomendado): id da execução, gravado por turno para observabilidade.
- Resposta inválida (sem `reply` / JSON quebrado / timeout) → o cliente vê uma mensagem neutra e o servidor loga `chat.engine_error`. Nunca expomos erro interno.

---

## 6. Catálogo de botões e IDs

Todo botão carrega um **`id` numérico**. **Contrato fixo:**

| ID | Significado |
|---|---|
| **`1`** | **Sim** (booleano) |
| **`0`** | **Não** (booleano) |
| `2..N` | Itens de lista (`value` = `offer_id` / `PIX` / `BOLETO` / `CREDIT_CARD`, na ordem exibida) |
| `98` | Voltar |
| `99` | Atendente (handoff) |

> **1 = Sim, 0 = Não** é inegociável. Um prompt **booleano** (`generic_yes_no`, `debt_acknowledgement`, `payment_confirmation`) só pode ter ids `1`, `0` e opcionalmente `99` — **nunca** itens de lista.

`prompt_kind` conhecidos: `debt_acknowledgement`, `offer_choice`, `payment_method_choice`, `payment_confirmation`, `generic_yes_no`. O fluxo pode criar prompts com **kinds novos** (via `prompt.ask`/`chat.send`) — o servidor aceita e registra, desde que os botões respeitem os reservados (ids únicos, sem colidir com 1/0/98/99 fora do significado).

O servidor valida o catálogo: ids inteiros, **únicos**, labels não-vazios. Erros: `button_id_duplicate`, `button_label_missing`, `boolean_button_id_invalid`, `boolean_missing_yes_no`.

**Como o clique volta ao fluxo:** o cliente clica → `POST /api/chat/button` (AlteaPay) grava o clique como mensagem do cliente e, se a engine é n8n, envia um novo `chat.turn` com o label do botão. Para o **reconhecimento**, a AlteaPay processa o clique localmente (registra Sim/Não) e o resultado chega ao fluxo no próximo `chat.turn` via `debt_acknowledgement`.

---

## 7. Catálogo de ações (papel B)

`POST https://alteapay.com/api/webhooks/n8n` — assinado (§3). Envelope: `{ "action", "session_id", "event_id", "args" }`. `event_id` (uuid por ação) garante idempotência.

### 7.1 `debt.summary`
- **Request:** `{ "action":"debt.summary", "session_id":"uuid" }`
- **Response:** `{ "success":true, "summary": { "creditorName", "originalValue", "agingDays", "oldestDueDate", "invoices":[...] } }`
- **Ao cliente:** resuma o débito com clareza (valor, nº de faturas, vencimento).

### 7.2 `offer.list`
- **Request:** `{ "action":"offer.list", "session_id":"uuid" }`
- **Response:** `{ "success":true, "offers":[ { "id", "terms", "valid_until" } ] }` (gera da matriz se não houver).
- **Ao cliente:** apresente as condições disponíveis (à vista com desconto, parcelado).

### 7.3 `offer.propose`
- **Request:** `{ "action":"offer.propose", "session_id":"uuid", "args":{ "terms":{ "discount_pct","installments","entry_value","billing_type","total_value","installment_value","first_due_date","original_value","discount_value" } } }`
- **Response ok:** `{ "success":true, "offer_id":"uuid" }` · **inválida:** `422 { "code":"DISCOUNT_ABOVE_MAX"|..., "offer_id" }`
- **Ao cliente:** só ofereça o que a matriz permite; se recusar, explique que essa condição não está disponível.

### 7.4 `offer.accept`
- **Request:** `{ "action":"offer.accept", "session_id":"uuid", "args":{ "offer_id":"uuid" } }`
- **Response:** `{ "success":true, "agreement_id":"uuid" }` · `409 { code }`
- **Nota:** prefira `payment.create` (fecha + cria a cobrança e devolve o link).

### 7.5 `offer.reject`
- **Request:** `{ "action":"offer.reject", "session_id":"uuid", "args":{ "offer_id":"uuid", "reason":"..." } }`
- **Response:** `{ "success":true }`

### 7.6 `payment.create` — o principal (variante A)
- **Request:** `{ "action":"payment.create", "session_id":"uuid", "event_id":"uuid", "args":{ "offer_id":"uuid", "billing_type":"PIX" } }`
- **Response (cobrança pronta):** ver §8 (valores em **centavos**, `idempotent`, links).
- **Response (worker off):** `{ "ok":true, "status":"processing", "agreement_id", "poll_after_ms":3000 }` → consulte `payment.status` até obter o link.
- **Erros:** `409 debt_not_acknowledged` (cliente não reconheceu), `409 already_charged`, `422` (oferta inválida contra a matriz vigente), `501 not_implemented` (`payment_origin != 'platform'`).
- **Ao cliente:** mande o link (PIX copia-e-cola / boleto / `invoice_url`).

### 7.7 `payment.status`
- **Request:** `{ "action":"payment.status", "session_id":"uuid" }`
- **Response:** `{ "ok":true, "agreement_id", "payment": { ..., "total_value":<centavos> }, "payment_status", "asaas_status" }`
- **NUNCA** aceita status vindo do fluxo — a fonte é o ASAAS.

### 7.8 `chat.send`
- **Request:** `{ "action":"chat.send", "session_id":"uuid", "event_id":"uuid", "args":{ "text":"Segue seu PIX 👇", "prompt": { "kind":"payment_method_choice", "question":"Como prefere pagar?", "buttons":[{"id":2,"label":"PIX","value":"PIX"}] }, "payment_ref": { "agreement_id":"uuid" }, "n8n_execution_id":"exec_9" } }`
- **Response:** `{ "ok":true, "message_id":"uuid", "prompt_id":"uuid|null", "duplicate":false }`
- **Dedupe:** reenviar com o mesmo `event_id` (24h) devolve o mesmo `message_id` com `duplicate:true`.

### 7.9 `prompt.ask`
- **Request:** `{ "action":"prompt.ask", "session_id":"uuid", "args":{ "kind":"generic_yes_no", "question":"Confirma?", "buttons":[{"id":1,"label":"Sim"},{"id":0,"label":"Não"}] } }`
- **Response:** `{ "ok":true, "prompt_id":"uuid" }`

### 7.10 `prompt.close`
- **Request:** `{ "action":"prompt.close", "session_id":"uuid" }`
- **Response:** `{ "ok":true, "closed":true }`

### 7.11 `dispute.register`
- **Request:** `{ "action":"dispute.register", "session_id":"uuid", "args":{ "note":"..." } }`
- **Response:** `{ "success":true, "case_id":"uuid" }` (suprime cobrança da dívida).

### 7.12 `payment_claim.register` ("já paguei")
- **Request:** `{ "action":"payment_claim.register", "session_id":"uuid", "args":{ "paidAt":"2026-09-20", "amount":<centavos>, "channel":"pix", "note":"..." } }`
- **Response:** `{ "success":true, "case_id":"uuid" }` — **não muda o acordo** (a verdade é o ASAAS).

### 7.13 `human.transfer`
- **Request:** `{ "action":"human.transfer", "session_id":"uuid", "args":{ "reason":"..." } }`
- **Response:** `{ "success":true, "case_id":"uuid" }`

### 7.14 `negotiation.note`
- **Request:** `{ "action":"negotiation.note", "session_id":"uuid", "args":{ ... } }`
- **Response:** `{ "success":true }`

### 7.15 `session.close`
- **Request:** `{ "action":"session.close", "session_id":"uuid", "args":{ "outcome":"closed_by_flow" } }`
- **Response:** `{ "success":true }`

---

## 8. Sequência de pagamento passo a passo

**Pré-requisito:** o cliente já **reconheceu** a dívida (`debt_acknowledgement.acknowledged=true`). Sem isso, `payment.create` recusa.

1. Cliente aceita uma condição no chat.
2. Fluxo → `payment.create` (assinado):
   ```json
   { "action":"payment.create", "session_id":"uuid", "event_id":"evt-1", "args":{ "offer_id":"uuid", "billing_type":"PIX" } }
   ```
3. AlteaPay valida oferta + reconhecimento + matriz vigente + guard de idempotência, cria agreement + cobrança ASAAS.
4. **Resposta com link (centavos):**
   ```json
   {
     "ok": true, "idempotent": false, "status": "created",
     "agreement_id": "uuid", "asaas_payment_id": "pay_123",
     "billing_type": "PIX", "total_value": 36184, "installments": 1,
     "due_date": "2026-09-28",
     "invoice_url": "https://www.asaas.com/i/...",
     "pix_copy_paste": "00020126...", "pix_qr_code_url": "00020126...",
     "boleto_url": null, "boleto_line": null
   }
   ```
5. Fluxo → `chat.send` com o link (PIX copia-e-cola / boleto / `invoice_url`).
6. **Se o worker estiver desligado**, o passo 4 devolve:
   ```json
   { "ok": true, "idempotent": false, "status": "processing", "agreement_id": "uuid", "poll_after_ms": 3000 }
   ```
   Aguarde `poll_after_ms` e consulte `payment.status` até obter os links.
7. **Reenvio idempotente** (mesma oferta na mesma sessão) devolve o payload **IDÊNTICO** com `idempotent: true` e **zero cobrança nova**:
   ```json
   { "ok": true, "idempotent": true, "status": "created", "agreement_id": "uuid", "asaas_payment_id": "pay_123", "total_value": 36184, "...": "idêntico" }
   ```
8. Cliente paga → **ASAAS webhook** confirma → a AlteaPay atualiza o acordo. O fluxo não declara pagamento.

---

## 9. Tabela de erros

Sempre `{ "ok":false, "code", "message" }` (ou `{ "success":false, "error", "code" }`), sem PII.

| HTTP | code | Causa | O que dizer ao cliente |
|---|---|---|---|
| `401` | — | Assinatura/timestamp inválidos (±300s) | (erro técnico; não expor) |
| `403` | — | Sessão não verificada (exigida p/ pagamento) | "Preciso confirmar sua identidade primeiro." |
| `404` | `prompt_not_found` | Prompt inexistente/de outra sessão | (recarregar estado) |
| `404` | — | Sessão inexistente/fechada | "Sua sessão expirou. Abra o link novamente." |
| `409` | `already_charged` | Dívida já tem cobrança viva | "Já existe uma cobrança em aberto para essa dívida — te reenvio o link." |
| `409` | `debt_not_acknowledged` | Cliente não reconheceu a dívida | "Antes de gerar o pagamento, preciso que você confirme que reconhece esta cobrança." |
| `409` | `prompt_not_active` | Clique em prompt já respondido/superseded | "Essa opção não está mais disponível; veja as atualizadas." |
| `422` | `DISCOUNT_ABOVE_MAX` | Desconto acima do permitido pela matriz | "Essa condição não está disponível; posso oferecer estas." |
| `422` | `INSTALLMENTS_ABOVE_MAX` | Parcelas acima do máximo | idem |
| `422` | `ENTRY_BELOW_MIN` | Entrada abaixo do mínimo | idem |
| `422` | `INSTALLMENT_BELOW_MIN` | Parcela abaixo do mínimo | idem |
| `422` | `BILLING_TYPE_NOT_ALLOWED` | Forma de pagamento não permitida | idem |
| `422` | `PIX_CANNOT_INSTALL` | PIX não parcela | "No PIX é à vista; posso parcelar no boleto." |
| `422` | `TOTAL_MISMATCH` | Total inconsistente com os termos | (revisar proposta) |
| `422` | `button_id_duplicate` / `boolean_button_id_invalid` | Catálogo de botões inválido | (corrigir o fluxo) |
| `422` | `empty_message` | `chat.send` sem `text` nem `prompt` | (corrigir o fluxo) |
| `501` | `not_implemented` | `payment_origin != 'platform'` (variante B) | (não aplicável nesta onda) |

---

## 10. O que o fluxo NUNCA faz

- **Nunca** decide desconto/parcela/validade — isso é da **matriz do servidor**. O fluxo escolhe entre ofertas geradas/validadas.
- **Nunca** fecha acordo nem gera link de pagamento por conta própria — usa `payment.create` (a AlteaPay executa).
- **Nunca** declara pagamento (`payment.status` não aceita status do fluxo). A verdade é o **webhook do ASAAS**. "Já paguei" vira `payment_claim`.
- **Nunca** cobra sem reconhecimento (bloqueio `debt_not_acknowledged`, salvo flag do tenant).
- **Nunca** recebe/loga o documento em claro (só mascarado, salvo as 2 flags do tenant).
- **Nunca** envia/forja `company_id` ou identidade — o servidor deriva da sessão.
- **Nunca** escreve direto no banco (Supabase) — só via `/api/webhooks/n8n`.

---

## 11. Ambiente de teste

- **Stub determinístico:** com `MOCK_ALL_INTEGRATIONS=1` e `NEGOTIATION_ENGINE=stub`, a AlteaPay roda um roteiro que exercita todas as ações sem servidor n8n — útil para validar o encadeamento localmente.
- **Roteiro de smoke (do lado do fluxo):**
  1. `ping` (`{ "action":"ping" }`) → `200 { success:true, engine }` (valida assinatura + saúde).
  2. Receba um `chat.turn` e responda um `reply` simples.
  3. `debt.summary` e `offer.list` → confira valores **em centavos**.
  4. `payment.create` sem reconhecimento → deve dar `409 debt_not_acknowledged`.
  5. Simule o reconhecimento (o cliente clica Sim no chat) e repita `payment.create` → `created`/`processing`.
  6. Repita `payment.create` na mesma oferta → `idempotent:true`, mesmo link.
  7. `chat.send` com um link → confirme que aparece no chat (via `GET /api/chat/messages?since=`).
- Exemplos prontos: `docs/n8n/examples/*.http` (um por ação) e fixtures em `docs/n8n/fixtures/`.

---

## 12. Checklist de aceite do fluxo

- [ ] Assinatura HMAC gerada e validada corretamente (±300s); `ping` responde `success:true`.
- [ ] Lê `chat.turn` tratando **centavos** (não multiplica por 100 de novo).
- [ ] Respeita a **matriz** (nunca oferece fora dos limites); trata `422`.
- [ ] Conduz o **reconhecimento** (não tenta pagar antes; trata `409 debt_not_acknowledged`).
- [ ] Usa `payment.create` para cobrar; trata `processing` (polling via `payment.status`).
- [ ] Idempotência: reenvio de `payment.create` não gera cobrança nova.
- [ ] Manda o link via `chat.send`; usa `event_id` para dedupe.
- [ ] Trata `409 already_charged` e `prompt_not_active` com fala adequada.
- [ ] Inclui `n8n_execution_id` na resposta ao `chat.turn`.
- [ ] Não loga/persiste documento em claro.

---

## 13. Limites e prazos

- **Timeout do turno:** `N8N_TIMEOUT_MS` (padrão 20 s). Acima disso, o cliente vê uma mensagem neutra e o turno vira **assíncrono** (o fluxo devolve depois via callback assinado).
- **Netlify (Functions):** janela típica de resposta ~10–26 s; projete o fluxo para responder rápido ou usar o modo assíncrono.
- **Assíncrono:** para respostas longas, use o modo com `callback_url` (assinado) — o servidor entrega a resposta ao cliente quando ela chega.
- **Validade da proposta:** definida pela matriz (`proposal_validity_days`); ofertas expiram e não podem ser aceitas depois.
- **TTL da sessão:** `session_ttl_minutes` (padrão 60). Depois disso, o cliente reautentica.
- **Rate limit:** 120 req/min por IP no `/api/webhooks/n8n`; limites por sessão nas mensagens.
- **Polling da UI:** `GET /api/chat/messages?since=` a cada ~2,5 s, para em `visibilitychange`, teto 20 min.
- **Worker de cobrança:** `payment.create` depende do worker (Fargate) para gerar o link no ASAAS. **Chat ligado exige worker ligado**; sem ele, o `payment.create` fica em `processing`.

---

## 14. Glossário e changelog

**Glossário:** *tenant/credor* (empresa, isolada por `company_id`) · *cliente/devedor* · *dívida/fatura* · *sessão* (`thread_id` = memória) · *oferta* (da matriz) · *matriz* (regras do tenant) · *acordo* (oferta fechada) · *cobrança* (pagamento ASAAS) · *reconhecimento* (Sim/Não append-only) · *prompt* (pergunta com botões) · *guard* (proteção de idempotência da cobrança) · *variante A* (AlteaPay executa a cobrança — único caminho desta onda).

**Changelog do contrato:**
- **v2 — 2026-09-21 (onda R) — VERSÃO ATUAL:**
  - Valores monetários **em centavos** em todas as interfaces n8n.
  - Reconhecimento da dívida como 1ª interação; `chat.turn.debt_acknowledgement`; bloqueio `409 debt_not_acknowledged` no `payment.create`.
  - Ações novas: `chat.send`, `prompt.ask`, `prompt.close`; clique de botão via `POST /api/chat/button`; polling via `GET /api/chat/messages?since=`.
  - `payment.create` idempotente por `(session_id, offer_id)` com `idempotent:true`; `501 not_implemented` para `payment_origin != 'platform'`.
  - Catálogo de botões/IDs: `1=Sim`, `0=Não`, `2..N` lista, `98=Voltar`, `99=Atendente`.
- **v1 — 2026-09-18:** contrato inicial (valores em reais decimais). Substituído por v2.
