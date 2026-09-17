# Integração WhatsApp via Voxuy — contrato REAL e handover

**Estado:** adapter implementado, **adormecido** (`WHATSAPP_PROVIDER=mock` em todos os
tenants reais). Nada é enviado a números reais até a conta Voxuy ser configurada
(ver `VOXUY_ACCOUNT_SETUP.md`) e um tenant de teste ser liberado (ver `VOXUY_SMOKE_TEST.md`).

**Fonte do contrato:** documentação oficial Voxuy
(`https://manual.voxuy.com/configuracoes/integracoes/api-voxuy`, lida em 17/09/2026),
transcrita e consolidada em `ops/chatbot-journey-2026-09/PROMPT_VOXUY_2026-09-17.md`.

---

## 1. Natureza da integração (isto muda o desenho)

A API da Voxuy é **só de ENTRADA**: fazemos `POST` de uma **transação** e a Voxuy
**agenda um funil de mensagens** cadastrado na conta. A plataforma controla
**quando disparar, para quem e quais variáveis** — **nunca o texto nem o horário**.
O funil vive na Voxuy e é configurado pela operação.

Cada disparo referencia um **evento** (`customEvent`, inteiro) e um **plano**
(`planId`) previamente criados na conta. Não há SDK: é um POST JSON.

### Arquitetura no código
- Interface: `lib/whatsapp/provider.ts` (`WhatsAppProvider`).
- Providers: `MockWhatsAppProvider` (`lib/whatsapp/mock.ts`) e `VoxuyProvider`
  (`lib/whatsapp/voxuy/provider.ts`). Resolver: `lib/whatsapp/index.ts`.
- Envio: `provider.sendCampaignMessage(...)`, chamado por `lib/journey/campaign-send.ts`
  (worker `lib/queue/workers/whatsapp.worker.ts`, fila `alteapay-whatsapp`).
- Captura inbound: `POST /api/webhooks/whatsapp/voxuy` (rota canônica) e a dinâmica
  `/api/webhooks/whatsapp/[provider]`.
- Supressão/parar de contatar: `lib/journey/suppressions.ts` + `lib/journey/stop-signal.ts`.

---

## 2. Contrato de ENVIO (verificado)

`POST <VOXUY_WEBHOOK_URL>` · `Content-Type: application/json`

A `VOXUY_WEBHOOK_URL` vem **inteira** da conta (Integrações → API VOXUY) e **contém
o `<codigo>`** embutido — **não** montamos a URL por concatenação. Autenticação é o
campo **`apiToken` no corpo** (não header).

### Payload canônico (`buildTransactionPayload`, validado por zod de saída)
```json
{
  "apiToken": "<VOXUY_API_TOKEN>",
  "id": "<whatsapp_messages.id>",
  "planId": "<tenant_chat_config.voxuy_plan_id>",
  "customEvent": 63,
  "paymentType": 99,
  "status": 99,
  "clientName": "Fabio",
  "clientPhoneNumber": "+5511912341234",
  "clientEmail": null,
  "clientDocument": null,
  "value": null, "freight": null, "freightType": null, "totalValue": null,
  "date": null,
  "checkoutUrl": null, "paymentLine": null, "boletoUrl": null, "pixQrCode": null, "pixUrl": null,
  "metadata": {
    "consult_url": "https://alteapay.com/c/<token-consulta>",
    "optout_url": "https://alteapay.com/c/<token-optout>/cancelar",
    "block_url": "https://alteapay.com/c/<token-block>/bloquear",
    "brand_name": "AlteaPay",
    "creditor_name": "VMAX",
    "first_name": "Fabio"
  }
}
```

Regras fixas (garantidas pelo schema de saída, `payloadSchema`):
- `paymentType = 99` ("Nenhum") e `status = 99` ("Nenhum/Desconhecido") — evento personalizado.
- `date = null` (data anterior à criação da licença NÃO agenda mensagens).
- `value`/`totalValue`/`freight` = `null` — **a mensagem não leva valor**.
- `clientDocument = null` e `clientEmail = null` — **zero PII além de primeiro nome + telefone + link + marca (V6)**.
- Campos nativos de pagamento (`pixQrCode`, `pixUrl`, `boletoUrl`, `paymentLine`, `checkoutUrl`)
  = `null` nesta onda; **implementados mas reservados** para um funil futuro de 2ª via (V9).
- `id = whatsapp_messages.id` → **idempotência de envio**: reenviar o mesmo `id`
  **atualiza**, não duplica.

### `metadata` (variáveis do funil) — `buildMetadata`
Só as chaves do Apêndice B.2: `consult_url`, `optout_url`, `block_url`, `brand_name`,
`creditor_name`, `first_name`. **Qualquer chave não prevista é rejeitada** (defesa
contra PII acidental — há teste que falha se alguém adicionar chave nova sem revisar).
Lembrete: `metadata` **aparece no relatório da Voxuy** — daí a minimização.

### Enums
`lib/whatsapp/voxuy/enums.ts` traz as tabelas oficiais completas; só usamos os `99`.
Valores monetários na Voxuy são **Integer em centavos** (R$ 69,90 → 6990) — registrado
como comentário mesmo enviando `null`, para ninguém mandar reais por engano.

### Respostas (§1.5, `classifyVoxuyResponse`)
| HTTP | Tratamento |
|---|---|
| `200 { "Success": true }` | aceito (S maiúsculo; validado case-insensitive) |
| `200` corpo inesperado | aceito + `note=unexpected_body` (logado) |
| `400` | validação; guarda `traceId` em `whatsapp_messages.provider_trace_id` e os **nomes** dos campos (nunca valores) |
| `401/403` | erro de configuração → falha a mensagem e **pausa a campanha** |
| `429/5xx/timeout` | retryável → o BullMQ retenta com backoff (mensagem fica `queued`) |

Log estruturado sem PII: `id`, `httpStatus`, `traceId`, `errorFields` (nomes, não valores).

---

## 3. Opt-out, bloqueio e "parar de contatar" (V3/V5 — não dependem da Voxuy)

A Voxuy **não tem webhook de saída** nem **API de blacklist** (lacunas L1/L2). Logo:
- **Tela de escolha** em `/c/{token}` (antes de qualquer autenticação, **sem dado da
  dívida**): Consultar / Cancelar inscrição / Bloquear número. Três tokens de ação
  distintos (`issueActionTokens`), sem PII, uso único para as ações destrutivas.
- **Cancelar inscrição** (`/c/{token}/cancelar`): suprime o **cliente** no canal WhatsApp.
- **Bloquear número** (`/c/{token}/bloquear`): suprime o **telefone** em todos os canais.
- Ambos são **POST com CSRF de sessão curta** (prefetch de link nunca dispara), revogam
  os tokens do cliente e disparam o **sinal de encerramento** (`sendStopSignal`).
- **"Parar de contatar"** = disparar uma transação para o evento `stop` (funil vazio ou 1
  mensagem de confirmação): a Voxuy **cancela o funil anterior do mesmo número** (é o
  mecanismo que a própria doc descreve, L4). `addSuppression` chama isso automaticamente
  para `optout`/`block`/`paid`; a falha do stop **não** desfaz a supressão local (gera
  `contact.stop_failed` para reprocesso).

---

## 4. Status honesto e painel (V6/V7)

- `whatsapp_messages.status = 'accepted'` quando a Voxuy responde 200 (**aceito para
  agendamento**, não entregue). `delivered`/`read` só existem com fonte real
  (`provider_status_source` ∈ `none | voxuy_webhook | manual`).
- Painel de campanhas: **Aceitas pelo provedor / Cliques / Autenticações / Acordos /
  Suprimidas / Falhas**. Entregue/Lido: "não informado pelo provedor" quando sem fonte.
- **Cliques** (nossos, confiáveis) são o sinal de alcance real.
- Aviso de **telefone duplicado** na seleção **bloqueia o início** da campanha (V10).
- Contador de `whatsapp_provider_events` não processados aparece no topo.

---

## 5. Dedupe e cooldown por telefone (V10)

Uma campanha **nunca** tem dois destinos com o mesmo `clientPhoneNumber` (senão o funil
de um cancelaria o do outro). O cooldown (`contact_cooldown_days`) é avaliado **por
telefone e por cliente**. Índice `whatsapp_messages(company_id, phone_e164, created_at)`.

---

## 6. Contrato INBOUND (proposto — NÃO confirmado pela Voxuy)

`POST /api/webhooks/whatsapp/voxuy` — auth por `VOXUY_INBOUND_SECRET` em header
`x-alteapay-webhook-secret` **ou** query `?s=` (não sabemos o que a Voxuy suporta).
Grava **tudo** em `whatsapp_provider_events`, responde **200 sempre**, **nunca 500**.
O mapeador (`lib/whatsapp/voxuy/inbound.ts`) reconhece só o contrato normalizado abaixo:
```json
{ "event": "delivered|read|clicked|optout|block|failed|reply",
  "message_ref": "<id que enviamos>", "phone": "+55…",
  "button": "consult|optout|block", "occurred_at": "ISO-8601" }
```
Qualquer outro formato → `processed=false` para análise. **Quando a Voxuy confirmar o
formato real, só este arquivo muda.**

---

## 7. Envs

| Variável | Onde | Default | Uso |
|---|---|---|---|
| `WHATSAPP_PROVIDER` | Netlify + ECS | `mock` | `mock` \| `voxuy` (por tenant via `tenant_chat_config.whatsapp_provider`) |
| `VOXUY_WEBHOOK_URL` | ECS | vazio | URL completa (contém o `<codigo>`) |
| `VOXUY_API_TOKEN` | ECS | vazio | campo `apiToken` |
| `VOXUY_INBOUND_SECRET` | Netlify | vazio | segredo da rota de captura |
| `VOXUY_TIMEOUT_MS` | ECS | `10000` | timeout do POST |
| `WHATSAPP_RATE_LIMIT_PER_SEC` | ECS | `5` | limiter (não documentado pela Voxuy) |

Por tenant (`tenant_chat_config`): `voxuy_plan_id`, `voxuy_events`
(`{"approach":63,"stop":64,"receipt":null}`), `whatsapp_provider`.

---

## 8. O que NÃO existe (lacunas L1–L5) e o que fazer quando existir

| Lacuna | Hoje | Quando a Voxuy confirmar |
|---|---|---|
| L1 webhook de saída | métricas param em "aceita"; usamos cliques nossos | ligar o mapeador inbound + `provider_status_source='voxuy_webhook'` |
| L2 blacklist própria | opt-out é 100% nosso | consultar/sincronizar se existir |
| L3 botões | um link + tela de escolha | usar botões de URL com os 3 tokens (V2) |
| L4 cancelar funil | nova transação p/ o mesmo número (evento `stop`) | usar endpoint próprio se surgir |
| L5 rate limit/canal | limiter conservador (5/s) | ajustar limiter; validar WABA/templates |

Perguntas abertas à Voxuy: Apêndice E do prompt (também em
`ops/chatbot-journey-2026-09/reports/V0_voxuy_diagnostico.md`).

---

## 9. Migrations

- `supabase/migrations/20260916_chat_journey_core.sql` (onda da jornada).
- `supabase/migrations/20260917_voxuy_journey_additions.sql` (esta onda, **aditiva**,
  **não aplicada em produção**): `accepted` status, `provider_transaction_id`,
  `provider_status_source`, `provider_trace_id`, `stop_signal_sent_at`, `accepted_at`,
  índice por telefone; `chat_access_tokens.purpose`/`consumed_at`; `tenant_chat_config.voxuy_events`.
