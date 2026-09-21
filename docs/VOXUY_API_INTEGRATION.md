# Voxuy — Integração por API (disparo do WhatsApp da jornada)

**Trilha:** dev-T3 · **Onda:** Hub de negociações / link único.
**Estado:** disparo **por API**, dialeto padrão **`enterprise_v1`** (contrato REAL
verificado na doc oficial). Modo de disparo padrão em produção continua **`mock`**
(nada sai sem credencial). Ligar em produção é **configuração, não código**.

---

## 1. Visão geral

O envio da jornada (link `/n/{code}` por pessoa) é **por API da Voxuy**. A
plataforma controla **quando** disparar, **para quem** e **quais variáveis** —
nunca o texto (o template mora na conta Voxuy / Meta).

O provider (`lib/whatsapp/voxuy/api-provider.ts`, classe `VoxuyApiProvider`) fala
**três dialetos**, escolhidos por **configuração do tenant**:

| Dialeto | Papel | Destino | Corpo |
|---|---|---|---|
| **`enterprise_v1`** (**DEFAULT**) | contrato **REAL verificado** | `POST {VOXUY_WEBHOOK_URL}` (**a URL É a credencial**) | `{ flowId, contact:{ name, phoneNumber, variables } }` |
| `transaction_v1` (LEGADO) | contrato do produto antigo | `POST {VOXUY_WEBHOOK_URL}` | corpo canônico `apiToken/planId/customEvent/paymentType=99` |
| `custom` | escape hatch por tenant | `voxuy_request_config.{method,url,headers}` | `voxuy_payload_template` com placeholders |

O **modo de disparo** do tenant é `whatsapp_dispatch_mode`:

| `whatsapp_dispatch_mode` | Efeito |
|---|---|
| `mock` (**default, inclusive produção**) | valida o contrato do payload mas **NÃO** sai do processo; nada é enviado |
| `voxuy_api` | dispara pela API (dialeto conforme `VOXUY_DIALECT`, default `enterprise_v1`) |

---

## 2. Dialeto `enterprise_v1` (contrato REAL verificado) — DEFAULT

### 2.1 Disparo (API de entrada da Voxuy)

- **Endpoint:** a URL vem do painel da Voxuy e **contém o companyId embutido** →
  **A URL É A CREDENCIAL.** Env `VOXUY_WEBHOOK_URL` (segredo). Só `https://`.
  **A URL NUNCA é logada** (nem em erro/timeout) e nunca vai para repo/commit.
- **Método:** `POST`, corpo JSON. **Sem `apiToken`, sem header próprio, sem
  Bearer** — a conta é identificada exclusivamente pela URL.
- **Corpo** (nosso caso = só abordagem, **SEM transação**):

```jsonc
{
  "flowId": 42,                                  // inteiro (obrigatório)
  "contact": {
    "name": "Fabio",                             // 1º nome (nunca nome completo)
    "phoneNumber": "+5511912341234",             // E.164 com DDI +55; obrigatório
    "variables": {                               // EXATAMENTE estas 3 chaves
      "link_negociacao": "https://alteapay.com/n/AbC123",
      "primeiro_nome": "Fabio",
      "credor": "VMAX"
    }
  }
}
```

- **NÃO enviamos:** `document` (CPF fica na plataforma), `email` (canal
  WhatsApp), `transaction`, nem quaisquer valores monetários. `contact.id` /
  `orderNumber` também não são usados no disparo.
- **`variables`** carrega **exatamente** `link_negociacao`, `primeiro_nome`,
  `credor` — mapeadas do `SendCampaignMessageInput` (`consult_url` →
  `link_negociacao`; `first_name`/1º nome → `primeiro_nome`; `creditor_name` (ou
  `brand_name`) → `credor`).

**De onde vem `flowId`:** `tenant_chat_config.voxuy_flow_id` (integer, dono: T1)
senão env `VOXUY_FLOW_ID`. Coerção defensiva para inteiro; ausência (fora do
mock) ⇒ erro de **configuração** visível (`errorClass: "config"`), a campanha não
dispara. Onde ler o `flowId` no painel da Voxuy é **pergunta aberta** (§8).

**De onde vem a URL:** `VOXUY_WEBHOOK_URL` (env/segredo), injetada no
`VoxuyApiConfig.webhookUrl`. É a credencial — tratada como segredo em todo o
código (nunca logada).

### 2.2 Resposta e classificação

- `{"success": true}` + HTTP 200 ⇒ `accepted`.
- `{"success": false, "message": "..."}` + HTTP 400 (ou 200 com `success:false`)
  ⇒ `failed` (`validation`). A `message` é **truncada** (≤200 chars) e tratada
  como **potencialmente sensível** — vai só para `raw.note`, nunca para campos
  estruturados nem log de valor.
- **`success` é minúsculo** — lido **case-insensitive** (o produto antigo usava
  `Success`; ambos são aceitos).

| HTTP / corpo | Resultado | `errorClass` | Sinal |
|---|---|---|---|
| 200 + `success:true` | `accepted` | — | — |
| 200 + corpo sem envelope | `accepted` | — | `raw.note="unexpected_body"` |
| 200 + `success:false` | `failed` | `validation` | `raw.note` = message truncada |
| 400 (+ `message`) | `failed` | `validation` | `raw.note` = message truncada |
| 401 / 403 | `failed` | `config` | **`raw.pauseCampaign=true`** (credencial errada não resolve repetindo) |
| 429 / 5xx / timeout / network | `failed` | `retryable` | a fila reagenda (1 tentativa por job aqui) |

Timeout: `VOXUY_TIMEOUT_MS` (default `10000`). **1 tentativa por job** (o BullMQ
reagenda os retryáveis).

### 2.3 Idempotência (é NOSSA)

O Enterprise **não tem chave de idempotência** neste caso: sem `transaction` não
há `id`/`orderNumber` para reconciliar. O controle é **NOSSO**:

- `jobId` determinístico da fila (`wa_<campaign>_<customer>`),
- status em `whatsapp_messages` (`queued`→`accepted`/`failed`), e
- **reverificação de supressão/cobrança viva antes do envio** (`campaign-send.ts`)
  + o guard `msg.status !== "queued"` (idempotência de reprocesso).

**Pergunta aberta:** dois POSTs idênticos geram **2 disparos** na Voxuy? Sem
chave de idempotência do lado deles, assumimos que sim — por isso o controle
antiduplicação vive todo do nosso lado (§8).

### 2.4 Trava final comum (`assertFinalPayloadSafe`)

Vale para **todos os dialetos**. O corpo final é validado por zod:
- **proíbe** `document`/`cpf` (topo **e** `contact.*`), `clientDocument`, e
  qualquer valor monetário (`value`/`totalValue`/`freight`/`amount`) não-nulo;
- **proíbe** `transaction` não-nula (o enterprise_v1 não leva transação);
- **exige** E.164 em `contact.phoneNumber` (enterprise) e em
  `clientPhoneNumber`/`phone` (legados).

Violação ⇒ `errorClass: "validation"`, **nada é enviado**.

---

## 3. Dialeto `transaction_v1` (LEGADO)

`POST {VOXUY_WEBHOOK_URL}` com o corpo canônico do produto antigo
(`apiToken/id/planId/customEvent/paymentType=99/status=99`, valores `null`,
`metadata` com as variáveis). Reusa `buildTransactionPayload` /
`classifyVoxuyResponse` de `lib/whatsapp/voxuy/provider.ts`. Ativado só com
`VOXUY_DIALECT=transaction_v1`. Exige `VOXUY_API_TOKEN` + `voxuy_plan_id` +
`voxuy_events.approach`.

## 4. Dialeto `custom`

Corpo montado a partir de `tenant_chat_config`:
- `voxuy_request_config` (jsonb): `{ "method", "url", "headers" }`.
- `voxuy_payload_template` (jsonb): template JSON livre com placeholders `{{...}}`.

Placeholders (resolvidos em corpo **e** headers): `{{link_negociacao}}`,
`{{primeiro_nome}}`, `{{credor}}` (aliases enterprise) + `{{phone}}`,
`{{firstName}}`, `{{link}}`, `{{brandName}}`, `{{creditorName}}`, `{{messageId}}`,
`{{flowId}}`, `{{planId}}`, `{{apiToken}}`.

**Placeholder desconhecido ⇒ erro de CONFIGURAÇÃO visível** (`VoxuyTemplateError`,
`errorClass: "config"`, `raw.pauseCampaign: true`) — a campanha **não** dispara.

---

## 5. Chaves de configuração lidas

### Env (produção / Netlify)
| Var | Uso |
|---|---|
| `WHATSAPP_DISPATCH_MODE` | `voxuy_api` \| `mock` (default). Fallback: `WHATSAPP_PROVIDER` (`voxuy`→api) |
| `VOXUY_MODE=mock` / `MOCK_ALL_INTEGRATIONS=1` | força mock (nada sai do processo) |
| `VOXUY_DIALECT` | `enterprise_v1` (**default**) \| `transaction_v1` (legado) \| `custom` |
| `VOXUY_WEBHOOK_URL` | **URL-credencial** (contém o companyId; **é segredo, nunca logada**) |
| `VOXUY_FLOW_ID` | `flowId` (inteiro) do enterprise_v1 — fallback do `tenant_chat_config.voxuy_flow_id` |
| `VOXUY_API_TOKEN` | **só transaction_v1** (o Enterprise não usa apiToken) |
| `VOXUY_PLAN_ID` | fallback de `planId` (transaction_v1) |
| `VOXUY_TIMEOUT_MS` | timeout do POST (default `10000`) |
| `VOXUY_INBOUND_SECRET` | segredo da rota de callback |
| `VOXUY_INBOUND_SECRET_HEADER` | nome do header do segredo (default `x-alteapay-webhook-secret`) |
| `WHATSAPP_RATE_LIMIT_PER_SEC` | limiter conservador da fila (default `5`) |

### `tenant_chat_config` (por tenant — dono: **T1**)
| Coluna | Uso |
|---|---|
| `whatsapp_dispatch_mode` (`voxuy_api\|mock`) | modo efetivo do tenant |
| `voxuy_flow_id` (**integer**) | `flowId` do enterprise_v1 (fonte primária) |
| `voxuy_request_config` (jsonb) | dialeto custom: `{method,url,headers}` |
| `voxuy_payload_template` (jsonb) | dialeto custom: template com `{{...}}` |
| `voxuy_plan_id` (text) | `planId` do transaction_v1 |
| `voxuy_events` (jsonb) | `{approach,stop,receipt}` → `customEvent` (transaction_v1) |

> A fábrica `getWhatsAppProvider` (em `lib/whatsapp/index.ts`) recebe o modo do
> tenant e, para `voxuy_api`, aceita opcionalmente um `apiConfig` já montado
> (URL-credencial + flowId por-tenant) injetado via construtor do
> `VoxuyApiProvider`.

---

## 6. Como ligar (configuração, não código)

1. **Tenant:** `whatsapp_dispatch_mode = 'voxuy_api'` (default é `mock` → nada sai).
2. **Enterprise (default):** setar `VOXUY_WEBHOOK_URL` (a URL-credencial do
   painel) + `voxuy_flow_id` no tenant (ou `VOXUY_FLOW_ID`). `VOXUY_DIALECT`
   pode ficar vazio (default `enterprise_v1`).
3. **Legado transaction_v1:** `VOXUY_DIALECT=transaction_v1` + `VOXUY_API_TOKEN` +
   `voxuy_plan_id` + `voxuy_events.approach`.
4. **Custom:** `VOXUY_DIALECT=custom` + `voxuy_request_config` +
   `voxuy_payload_template` no tenant.
5. Sem credencial completa, o provider **recusa** (`VoxuyConfigError`, só NOMES
   faltantes, nunca valores) e a campanha nem inicia.

---

## 7. Callback (Voxuy → nós) `POST /api/webhooks/whatsapp/voxuy`

- **Proteção (sem HMAC):** a Voxuy não assina os callbacks. Aceitamos **URL com
  segredo** (`?s=<VOXUY_INBOUND_SECRET>`) **ou** um **header configurável**
  (`VOXUY_INBOUND_SECRET_HEADER`, default `x-alteapay-webhook-secret`). Segredo
  ausente/errado ⇒ 401.
- **Contrato de saída REAL:** o corpo traz `contact` (`hash`, `id`,
  `invalidWhatsApp`, `tags`, `customVariables`, `name`, `phoneNumber`) e, quando
  há venda, `transaction`. **Não há evento de `delivered`/`read`** documentado —
  **não inventamos**.
- **Mapeamento** (`lib/whatsapp/voxuy/inbound.ts`): correlaciona por
  `contact.hash` (senão `contact.id`); `invalidWhatsApp: true` ⇒ evento `failed`
  (`error: "invalid_whatsapp"`) para marcar o número inválido. Sem sinal
  acionável ⇒ `[]` (a rota grava o bruto em `whatsapp_provider_events` com
  `processed=false` para análise).
- **Resiliência:** dedupe por `event_hash`; corpo ilegível/fuzz ⇒ captura bruta;
  **NUNCA 500** (um provedor que recebe 5xx pode desativar o webhook).

---

## 8. Perguntas ABERTAS à Voxuy (5)

1. **Rate limit:** qual o limite de req/s da API de disparo? (Hoje usamos um
   limiter conservador de 5/s na fila — `WHATSAPP_RATE_LIMIT_PER_SEC`.)
2. **Sandbox:** existe ambiente de sandbox/teste para validar `flowId` e
   variáveis sem disparar mensagens reais?
3. **Blacklist / descadastro:** há API para consultar/registrar
   opt-out/descadastro do lado da Voxuy? (Hoje a supressão autoritativa é NOSSA —
   `contact_suppressions`.)
4. **`flowId` no painel:** onde exatamente se lê o `flowId` (inteiro) de um fluxo
   no painel Enterprise?
5. **Confirmação de entrega/leitura:** confirmar que **não existe** callback de
   `delivered`/`read` (só `contact`/`transaction`/`invalidWhatsApp`). E: **dois
   POSTs idênticos de disparo geram 2 mensagens** (não há idempotência do lado
   deles)?

---

## 9. Arquivos

| Arquivo | Papel |
|---|---|
| `lib/whatsapp/voxuy/api-provider.ts` | `VoxuyApiProvider` (3 dialetos; `buildEnterprisePayload`; `classifyEnterpriseResponse`; trava final) |
| `lib/whatsapp/voxuy/config.ts` | `loadVoxuyApiConfig` (default `enterprise_v1`), `coerceFlowId`, `voxuyInboundSecretHeader`, tipos |
| `lib/whatsapp/voxuy/provider.ts` | builders legados reusados (`buildTransactionPayload`, `classifyVoxuyResponse`) |
| `lib/whatsapp/voxuy/inbound.ts` | mapeador do callback (Enterprise `contact` + legado A.5) |
| `lib/whatsapp/index.ts` | fábrica `getWhatsAppProvider` + `resolveDispatchMode` |
| `app/api/webhooks/whatsapp/voxuy/route.ts` | callback inbound (captura pura; secret por header/query) |
| `tests/whatsapp/voxuy-api-provider.test.ts` | enterprise_v1 (default) + legados + trava + classificação + URL nunca logada |
| `tests/whatsapp/voxuy-callback.test.ts` | callback resiliente (fuzz nunca 500) + `invalidWhatsApp`→failed |
