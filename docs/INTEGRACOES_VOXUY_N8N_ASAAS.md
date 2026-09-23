# Integrações AlteaPay — Voxuy · n8n · ASAAS (guia para o time do n8n)

**Estado:** implementado e validado na branch `feature/chatbot-journey`, **atrás de flags desligadas** (produção sem mudança de comportamento). Contratos abaixo refletem o **código real**. Última atualização: 2026-09-21.

> Convenção de assinatura (n8n ↔ AlteaPay, nos dois sentidos): **HMAC-SHA256** de `${timestamp}.${body}` com o segredo `N8N_WEBHOOK_SECRET`. Headers: `x-alteapay-signature` e `x-alteapay-timestamp` (epoch em segundos). Janela de tolerância **±300 s**. Idempotência por `event_id`.

> **⚠️ CONTRATO v2 (2026-09-21):** todos os **valores monetários nas interfaces n8n** (`chat.turn` e respostas de `payment.*`) passam a ser **inteiros em CENTAVOS** — não mais reais decimais. Ex.: R$ 418,90 → `41890`. As colunas do banco continuam em reais; a conversão é só na borda. Ver o **changelog** ao final. Guia detalhado e autossuficiente: `docs/N8N_TEAM_INTEGRATION_GUIDE.md`.

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

A AlteaPay dispara; a Voxuy agenda o funil. **A API da Voxuy é só de entrada** (não há webhook de saída; o opt-out é controlado pela AlteaPay). A **blacklist existe** — mas como **AÇÃO de fluxo** ("Adicionar à blacklist", que *impede que automações sejam enviadas*), **não como API**: não há endpoint para consultá-la nem alimentá-la, então ela é **invisível para a AlteaPay** (um contato blacklistado continua contando como enviado do nosso lado, e a API segue retornando `success:true` sem entregar).

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
  "debt_acknowledgement": {
    "acknowledged": false,
    "answered_at": null
  },
  "debtor": {
    "name": "Fabio",
    "document_masked": "390.***.**7-05",
    "document_hash": "b1e2...sha256hex",
    "document": null
  },
  "debt": {
    "id": "uuid-da-divida",
    "amount": 41890,
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

> **PII:** `debtor.document` é **`null` por padrão** — o fluxo recebe só `document_masked` + `document_hash`. O documento em claro só viaja se o tenant tiver **as duas flags** `send_document_to_engine=true` **e** `payment_origin='n8n'` (variante B). A URL do canal oficial **não** viaja (o servidor a resolve; o LLM nunca a manuseia).
>
> **v2 (centavos):** `debt.amount` agora é **inteiro em centavos** (`41890` = R$ 418,90), não mais reais decimais.
>
> **Reconhecimento da dívida (onda R):** `debt_acknowledgement` diz se o cliente já respondeu à pergunta "reconhece esta cobrança?" (`acknowledged` true/false; `answered_at` quando respondeu). O detalhe fino (button_id, prompt ativo, ofertas em centavos, matriz) vem no contexto completo da sessão (`buildSessionContext`). **Com `acknowledged=false`, `payment.create` é recusado com `409 debt_not_acknowledged`** (salvo tenant com `allow_payment_without_acknowledgement=true`).

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
| **`chat.send`** | `{ text, prompt?, payment_ref?, n8n_execution_id? }` | empurra mensagem (+prompt) ao chat | `{ok:true, message_id, prompt_id?, duplicate}` |
| `prompt.ask` | `{ kind, question, buttons:[{id,label,value?}] }` | cria só um prompt de botões | `{ok:true, prompt_id}` |
| `prompt.close` | — | fecha (supersede) o prompt ativo | `{ok:true, closed}` |

> **Botões/IDs (onda R):** `1=Sim`, `0=Não` (booleano fixo); `2..N` itens de lista (`value`=offer_id/PIX/BOLETO/CREDIT_CARD, na ordem exibida); `98=Voltar`; `99=Atendente`. O servidor valida ids únicos/reservados. O cliente responde clicando; a AlteaPay recebe em `POST /api/chat/button` e devolve o clique ao fluxo como um turno de botão.

### 3.2 `payment.create` (o principal — variante A, padrão)

O fluxo **decide** criar a cobrança; a **plataforma executa** (aplica o guard de idempotência — nunca cobra 2x — e usa a matriz + o caminho ASAAS já testado). Exige **sessão verificada**.

Request:
```json
{ "action": "payment.create", "session_id": "uuid", "event_id": "uuid", "args": { "offer_id": "uuid-da-oferta" } }
```

Resposta (cobrança pronta) — **é o link que o fluxo manda no chat** (`total_value` em **CENTAVOS**):
```json
{
  "ok": true,
  "idempotent": false,
  "status": "created",
  "agreement_id": "uuid",
  "asaas_payment_id": "pay_123",
  "billing_type": "PIX",
  "total_value": 27229,
  "installments": 1,
  "due_date": "2026-09-25",
  "invoice_url": "https://www.asaas.com/i/...",
  "pix_copy_paste": "00020126...",
  "pix_qr_code_url": "00020126...",
  "boleto_url": null,
  "boleto_line": null
}
```

Resposta (worker de cobrança desligado — link ainda gerando):
```json
{ "ok": true, "idempotent": false, "status": "processing", "agreement_id": "uuid", "poll_after_ms": 3000 }
```
Nesse caso o fluxo/UI faz polling e obtém o link no `payment.status` seguinte. **Para o chat operar de ponta a ponta, o worker de cobrança precisa estar ligado.**

**Idempotência por `(session_id, offer_id)`:** reenviar `payment.create` para a **mesma oferta na mesma sessão** devolve o payload **IDÊNTICO** (mesmo `agreement_id`/link) com `idempotent: true` e **zero cobrança nova**. Combine com o `guard` do ASAAS (fonte da verdade) — a cobrança nunca duplica.

Notas: **variante A é o único caminho** — se o tenant não estiver com `payment_origin='platform'`, `payment.create` devolve `501 not_implemented`. **PIX não parcela** (parcelado só boleto/cartão). Cartão devolve `invoice_url` do ASAAS (dados de cartão nunca passam pela AlteaPay nem pelo n8n). `externalReference` é determinístico `journey_{sessionId}_{offerId}`. **`total_value` em centavos** (v2).

### 3.3 `payment.record` (variante B — só se o tenant usar `payment_origin='n8n'`)

Se o fluxo criar a cobrança direto no ASAAS, registra aqui. **Guard antes** (recusa se a dívida já tem cobrança viva) e **NUNCA aceita status pago**.

Request (`total_value` em **centavos**):
```json
{ "action": "payment.record", "session_id": "uuid", "event_id": "uuid",
  "args": { "offer_id": "uuid", "asaas_customer_id": "cus_...", "asaas_payment_id": "pay_...",
    "billing_type": "BOLETO", "invoice_url": "https://...", "due_date": "2026-09-25",
    "total_value": 27229, "installments": 2, "status": "pending" } }
```
Resposta: `{ok:true, code:"recorded", agreement_id}` · se vier com status pago → vira *claim*: `{ok:true, code:"claim", case_id}` · duplicidade → `409 already_charged`.

### 3.4 Erros (sempre `{ ok:false, code, message }`, sem PII)
`401` assinatura/janela inválida · `403` sessão não verificada · `404` sessão/prompt inexistente (`prompt_not_found`) · `409` conflito (`already_charged`, `debt_not_acknowledged`, `prompt_not_active`) · `422` validação de oferta (`DISCOUNT_ABOVE_MAX`, `INSTALLMENTS_ABOVE_MAX`, `ENTRY_BELOW_MIN`, `INSTALLMENT_BELOW_MIN`, `BILLING_TYPE_NOT_ALLOWED`) ou de botões (`button_id_duplicate`, `boolean_button_id_invalid`) · `501` `not_implemented` (variante B / `payment_origin != 'platform'`).

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

---

## 7. Supabase (camada de dados) — como o n8n se relaciona com ela

**Projeto:** `https://hpjzlmurljxzwjtwcbkz.supabase.co` · REST base `…/rest/v1/` · Realtime `wss://…/realtime/v1`.

> **Caminho recomendado (e o desenho aprovado — variante A): o n8n NÃO acessa o Supabase diretamente.** Todo o dado que o fluxo precisa **chega no `chat.turn`** (§2.1: dívida, matriz, ofertas, `history_tail`) e **toda mudança de estado passa por `/api/webhooks/n8n`** (§3), que aplica o guard de idempotência, valida a matriz e deriva o `company_id` no servidor. Isso é o que garante "nunca cobrar 2x", isolamento entre tenants e PII mascarada.

**Por que não ler/escrever o Supabase direto do n8n:**
- **RLS ligada em tudo** (por `company_id` + `service_role`). Uma `anon key` sem sessão de usuário autenticada **não enxerga** as tabelas protegidas (retorna vazio) — o n8n não tem essa sessão.
- A **`service_role` key ignora a RLS** e **NUNCA pode ir para o n8n**: quem edita fluxos passaria a ler PII de qualquer tenant e a escrever cobranças sem o guard (o problema que custou caro no VMAX). É segredo de servidor, fica só no Netlify/ECS.
- Escrever direto em `agreements`/`negotiation_offers`/`negotiation_sessions`/pagamentos **bypassa o guard** → risco de cobrança dupla e de estado inconsistente. **Proibido.**

**Modelo de dados (referência — para entender o que a API devolve e onde cada coisa vive; não é endpoint de integração):**

| Tabela | Papel | Colunas-chave |
|---|---|---|
| `negotiation_sessions` | a sessão do chat | `id, company_id, customer_id, debt_id, debt_ids[], primary_debt_id, thread_id, channel, engine, status ('open'\|'closed'), outcome, identity_verified_at, consent_at, agreement_id` |
| `chat_messages` | histórico legível | `id, company_id, session_id, role ('customer'\|'assistant'\|'system'), text, button_id, prompt_id, n8n_execution_id, n8n_event_id, engine, latency_ms, created_at` |
| `chat_prompts` | perguntas com botões (onda R) | `id, company_id, session_id, kind, question, buttons(jsonb), status ('active'\|'answered'\|'expired'\|'superseded'), answered_button_id, created_by ('platform'\|'n8n'), n8n_execution_id` |
| `debt_acknowledgements` | reconhecimento (append-only) | `id, company_id, session_id, customer_id, debt_id, prompt_id, acknowledged, button_id (0\|1), source, ip_hash, created_at` · view `debt_acknowledgement_latest` = última por (session, debt) |
| `negotiation_condition_matrix` | regras de oferta (D8/D11) | `company_id, max_discount_pct, min_entry_pct, max_installments, allowed_billing_types, proposal_validity_days, active` |
| `negotiation_offers` | ofertas apresentadas | `id, session_id, terms(jsonb), status ('presented'\|'accepted'\|'rejected'\|'superseded'\|'expired'), valid_until` |
| `agreements` | acordo fechado + cobrança ASAAS | `id, company_id, customer_id, debt_id, negotiation_session_id, origin, agreed_amount, installments, asaas_payment_id, asaas_status, payment_status, asaas_boleto_url, asaas_pix_qrcode_url, proposal_valid_until` |
| `debts` / `customers` | dívida / devedor | `debts: id, company_id, customer_id, amount, due_date, status ('pending'\|'in_negotiation'\|'paid'\|'cancelled')` · `customers: id, company_id, name, document, phone` |
| `journey_events` | auditoria (PII mascarada) | `company_id, session_id, event_type, actor, payload, event_id (UNIQUE), created_at` |
| `negotiation_cases` | contestação / "já paguei" | `company_id, session_id, type ('dispute'\|'payment_claim'), ...` |

**Se o time REALMENTE precisar de acesso direto** (ex.: memória de conversa via node Supabase/Postgres do n8n):
1. Preferir o **store próprio do n8n** com chave `thread_id` (a app já manda `thread_id` no `chat.turn`).
2. Se precisar persistir no nosso lado, **pedir à AlteaPay uma tabela dedicada + credencial escopada** (uma role/policy só para essa tabela — **nunca** a `service_role`), com RLS própria e **sem PII**.
3. Para "status atualizado em tempo real" (em vez de `payment.status` por polling), dá para assinar `chat_messages`/`journey_events` via **Supabase Realtime** com setup escopado — fora de escopo desta fase; hoje a app usa polling curto na tela de pagamento.

**Resumo:** Supabase é o datastore da plataforma; o n8n integra pela **API da AlteaPay** (§2 e §3), não pelo banco.

---

## 8. Tudo para a integração fluir (checklist do time do n8n)

**Ambiente & URLs**
- Produção: `https://alteapay.com`. Slug do tenant VMAX: **`vmax`** (endpoint genérico `/t/vmax/negociar`).
- Ligar o chat (feito pela AlteaPay quando vocês entregarem o fluxo): `NEGOTIATION_ENGINE=n8n` + `N8N_CHAT_FLOW_URL=<url do fluxo>` (ou por tenant em `tenant_chat_config.n8n_chat_flow_url`).

**Segredo compartilhado**
- `N8N_WEBHOOK_SECRET` — o **mesmo** segredo assina os dois sentidos. A AlteaPay já gerou o dela; combinar a troca por canal seguro (nunca em chat/commit/issue). Guardar no credential store do n8n.

**Receita da assinatura HMAC (idêntica nos 2 sentidos)**
```
timestamp = epoch_em_segundos()            // ex.: "1758240000"
base      = `${timestamp}.${raw_body}`     // raw_body = corpo JSON EXATO enviado (não re-serializar)
signature = hex( HMAC_SHA256(N8N_WEBHOOK_SECRET, base) )
headers:  x-alteapay-timestamp: <timestamp>
          x-alteapay-signature: <signature>
```
Validação: rejeitar se `|agora - timestamp| > 300s` ou assinatura divergente → `401`. **Usar o corpo cru** (o mesmo bytes-a-bytes que foi assinado); re-serializar o JSON quebra a assinatura.

**Idempotência**: enviar `event_id` único por ação/turno. Reenvio com o mesmo `event_id` devolve o mesmo efeito (não duplica).

**Timeout & assíncrono**: a AlteaPay espera a resposta do fluxo por `N8N_TIMEOUT_MS` (20s). Acima disso, o cliente vê "só um instante" e o fluxo pode devolver depois via `session.message` async (callback assinado).

**Unidades & formatos**: **valores monetários no `chat.turn` (`debt.amount`) e nas respostas de pagamento (`total_value`) estão em REAIS (decimal), como no banco** — confiar no que o payload envia. Datas em `ISO-8601`; vencimentos no fuso `America/Sao_Paulo`.

**Como testar SEM produção**: a AlteaPay tem um **stub determinístico** do fluxo (engine `stub` + `POST /api/dev/n8n-stub`) que roda no laboratório (`MOCK_ALL_INTEGRATIONS=1`) e exercita todas as ações — útil para validar a assinatura e o contrato antes do fluxo real. Em produção o stub responde `404`.

**Erros e o que dizer ao cliente**: `409 already_charged` (já existe cobrança viva → oferecer a 2ª via/o link existente, não recriar); `422` + código (`DISCOUNT_ABOVE_MAX`, `INSTALLMENTS_ABOVE_MAX`, `ENTRY_BELOW_MIN`, `VALUE_BELOW_MIN`, `BILLING_TYPE_NOT_ALLOWED` → propor dentro da matriz); `403` sessão não verificada; `404` sessão inexistente/fechada. Sempre responder ao cliente com uma fala neutra, sem expor o erro técnico.

**Observabilidade**: incluir `n8n_execution_id` na resposta ao `chat.turn` — a AlteaPay grava por turno em `chat_messages` para correlacionar com o log do n8n no painel super-admin.

**PII**: o `chat.turn` traz o documento **mascarado** (`document_masked` + `document_hash`); o documento em claro só chega se a AlteaPay habilitar as 2 flags (`send_document_to_engine=true` E `payment_origin='n8n'`). O fluxo **não deve** logar/persistir o documento em claro.

---

## 9. Changelog do contrato n8n

- **v2 — 2026-09-21 (onda R):**
  - **Valores monetários em CENTAVOS** em todas as interfaces n8n (`chat.turn` → `debt.amount`, `offers[].terms.*`, `matrix`; respostas de `payment.create`/`payment.status` → `total_value`). Ex.: R$ 418,90 → `41890`. As colunas do banco seguem em reais; a conversão é só na borda.
  - **Reconhecimento da dívida:** `chat.turn.debt_acknowledgement` (`acknowledged`, `answered_at`). Novo bloqueio: `payment.create` recusa `409 debt_not_acknowledged` quando o cliente não reconheceu (salvo `allow_payment_without_acknowledgement=true`).
  - **Ações novas (papel B):** `chat.send`, `prompt.ask`, `prompt.close`. Cliente responde botões via `POST /api/chat/button`; UI recebe mensagens por `GET /api/chat/messages?since=`.
  - **payment.create idempotente por `(session_id, offer_id)`** com `idempotent: true` e payload idêntico; `501 not_implemented` para `payment_origin != 'platform'` (variante B fora do escopo desta onda).
  - **Catálogo de botões/IDs:** `1=Sim`, `0=Não`, `2..N` lista, `98=Voltar`, `99=Atendente`.
- **v1 — 2026-09-18:** contrato inicial (valores em reais decimais). Substituído por v2.
