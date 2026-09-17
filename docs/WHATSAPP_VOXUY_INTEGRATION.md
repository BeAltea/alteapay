# Integração WhatsApp via Voxuy — contrato e smoke test

**Estado:** provider implementado, **adormecido** (`WHATSAPP_PROVIDER=mock` em produção).
Nada é enviado a números reais até a Voxuy ser configurada e o tenant liberado.

## Arquitetura (D12)

A plataforma fala **direto** com a Voxuy através da interface `WhatsAppProvider`
(`lib/whatsapp/provider.ts`). O n8n não participa do disparo. Dois providers:
`MockWhatsAppProvider` (laboratório/canário) e `VoxuyProvider` (produção).

- Envio: `provider.sendCampaignMessage(...)` (worker de campanha).
- Retorno: `POST /api/webhooks/whatsapp/voxuy` → `provider.parseInboundEvent(...)`.
- Supressão: opt-out/bloqueio viram `contact_suppressions` automaticamente.

## Contrato de ENVIO (conhecido da doc pública Voxuy)

`POST https://sistema.voxuy.com/api/{VOXUY_ACCOUNT_CODE}/webhooks/voxuy/transaction`
`Content-Type: application/json`
```json
{
  "apiToken": "<VOXUY_API_TOKEN>",
  "planId": "<tenant.voxuy_plan_id>",
  "customEvent": "<tenant.voxuy_custom_event>",
  "clientPhoneNumber": "+5511912341234",
  "clientName": "…", "clientDocument": "…",
  "id": "<whatsapp_messages.id>",
  "consultUrl": "https://alteapay.com/c/<token>",
  "customFields": { "consult_url": "…", "brand_name": "VMAX", "sender_label": "…" },
  "paymentType": 1, "status": 1
}
```
Resposta esperada: `200 { "Success": true }`.

## Contrato INBOUND (normalizado pela plataforma — proposta a confirmar)

`POST /api/webhooks/whatsapp/voxuy` (auth por `x-alteapay-webhook-secret` = `VOXUY_WEBHOOK_SECRET` até a Voxuy definir o esquema real):
```json
{ "event": "delivered|read|clicked|optout|block|failed|reply",
  "message_ref": "<whatsapp_messages.id ou provider_message_id>",
  "phone": "+55…", "button": "consult|optout|block", "occurred_at": "ISO" }
```
Payload em formato desconhecido → gravado bruto em `whatsapp_provider_events`
(`processed=false`), resposta 200, **nunca 500**. Fixtures em `tests/fixtures/voxuy/`
pinam o mapeador quando a doc real chegar.

## ⚠️ A confirmar com a Voxuy (perguntas C.8)

1. Como passar variáveis (a URL de consulta) ao fluxo disparado por `customEvent`? (`consultUrl`? `customFields`? outro campo?)
2. Existe webhook de SAÍDA com eventos entregue/lido/clique-de-botão/opt-out/bloqueio? Qual o formato e como registrar a URL?
3. Há API de blacklist/supressão, ou como refletir nosso opt-out na Voxuy?
4. O canal é API oficial da Meta? Templates aprovados e botões (URL + quick reply)?
5. Limite de envio (msgs/s) e ambiente de sandbox para teste?

## Envs

| Variável | Onde | Default prod |
|---|---|---|
| `WHATSAPP_PROVIDER` | Netlify + ECS | `mock` |
| `VOXUY_ACCOUNT_CODE`, `VOXUY_API_TOKEN` | ECS (envio) | vazio |
| `VOXUY_WEBHOOK_SECRET` | Netlify (webhook) | vazio |
| `WHATSAPP_RATE_LIMIT_PER_SEC` | ECS | `5` |

## Smoke test (quando houver credencial)

1. `WHATSAPP_PROVIDER=voxuy` só no tenant de teste; preencher `VOXUY_*`.
2. Registrar o webhook de saída da Voxuy → `/api/webhooks/whatsapp/voxuy`.
3. Campanha de 1 número interno → confirmar `sent`; abrir o link → `link.clicked`; responder PARAR → `optout.received` + supressão ativa; reenviar campanha → o número é excluído.
4. Conferir `whatsapp_provider_events` sem `processed=false` inesperado.
