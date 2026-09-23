# Integrações ASAAS ⇄ AlteaPay ⇄ n8n ⇄ Voxuy — Estado e Gaps

**Data:** 2026-09-22 · **Objetivo:** mapa técnico das integrações de cobrança/pagamento para identificar gaps, e registro do que foi implementado nesta rodada.

---

## 0. Política de comunicação (DECISÃO — implementada)

**O ASAAS não envia NENHUMA comunicação ao devedor.** Toda comunicação (e-mail + WhatsApp) é feita pela **AlteaPay**. Do ASAAS queremos **só o link de pagamento**.

**Implementado (`lib/asaas.ts`):**
- `createAsaasCustomer` **força `notificationDisabled: true`** (ignora o valor do caller) — chave-mestra que suprime e-mail/SMS/WhatsApp do ASAAS, sem janela de corrida.
- `updateAsaasCustomer` **também força `notificationDisabled: true`** — reforça em clientes que já existiam no ASAAS (criados antes desta política) quando passam por atualização no fluxo de cobrança.
- `OPTIMIZED_NOTIFICATION_CONFIG` — todos os canais do cliente (`emailEnabledForCustomer`, `smsEnabledForCustomer`, `whatsappEnabledForCustomer`, `phoneCallEnabledForCustomer`) viraram **`false`** em todos os eventos (cinto e suspensório: mesmo que a matriz por-evento rode, não reativa nada).
- **Antes:** o ASAAS desligava só e-mail e mantinha **SMS + WhatsApp LIGADOS** (PAYMENT_CREATED, OVERDUE, RECEIVED). Agora: tudo off.

---

## 1. Fluxo de cobrança (n8n → ASAAS → AlteaPay → conciliação)

```
n8n (payment.create)  →  AlteaPay cria cobrança no ASAAS (POST /payments, cliente com notificationDisabled=true)
                          ASAAS devolve: id + invoiceUrl (+ pixQrCodeUrl/bankSlipUrl)
                          AlteaPay salva em agreements (asaas_invoice_url etc.), vinculado à sessão
   ↓                                          ↓
   link devolvido ao n8n                      link consultável no hub por devedor
   (resposta payment.create, valores          (/super-admin/negociacoes-chat — coluna "Link de pagamento" + badge "pago")
    em CENTAVOS)                              ↓
   ↓                          ASAAS webhook (PAYMENT_RECEIVED/CONFIRMED) → conciliação
   AlteaPay compartilha o link              → agreements.payment_status=received, debts.status=paid
   no chat/e-mail/WhatsApp                    → jornada: sessão fechada, resolver retorna `settled` (quitada)
                                              → guard de idempotência bloqueia nova cobrança (não cobra 2x)
```

**Link de pagamento canônico:** `agreements.asaas_invoice_url` → fallback `asaas_payment_url` → `asaas_boleto_url` → `asaas_pix_qrcode_url`. (`app/api/chat/payment/route.ts`.)

---

## 2. Onde está cada peça (código)

| Peça | Arquivo:linha |
|---|---|
| Criar cobrança ASAAS | `lib/asaas.ts` `createAsaasPayment()` (`POST /payments`) |
| **Desligar comunicação ASAAS** | `lib/asaas.ts` `createAsaasCustomer`/`updateAsaasCustomer` (`notificationDisabled:true`) + `OPTIMIZED_NOTIFICATION_CONFIG` (canais off) |
| Salvar link em `agreements` | `app/actions/send-payment-link.tsx`, `lib/queue/workers/asaas-charge-create.worker.ts`, webhook |
| **Link consultável no hub** | `lib/negotiation/admin-data.ts` (anexa `payment_link`/`payment_paid` por devedor) + `components/negotiation/chat-sessions-content.tsx` (exibe "Link de pagamento" + badge "pago") |
| n8n `payment.create` | `app/api/webhooks/n8n/route.ts` → `lib/journey/payment-actions.ts` (`paymentCreate`, idempotência por `(session_id, offer_id)`) |
| Resposta ao n8n | `app/api/webhooks/n8n/route.ts` `paymentCreateResponseForN8n()` (URLs + valores em centavos) |
| Consulta de status (n8n) | `app/api/webhooks/n8n/route.ts` ação `session.status` |
| Webhook ASAAS (conciliação) | `app/api/asaas/webhook/payments/route.ts` (4 estratégias de match, dedupe `asaas_webhook_events`) |
| Jornada pós-pagamento | `lib/journey/reconciliation.ts` `journeyOnPaymentEvent()` (fecha sessão, `settled`) |
| Guard anti-cobrança-dupla | `lib/asaas-idempotency.ts` |
| Voxuy (WhatsApp) | `lib/whatsapp/voxuy/*` (hoje **mock**) |

---

## 3. Estado por integração + GAPS

### ASAAS
- ✅ **Comunicação desligada** (implementado — §0).
- ✅ **Link salvo e consultável** por devedor no hub (implementado — §2).
- ✅ **Conciliação** via webhook (existe): pagamento → `settled`/quitada, guard bloqueia recobrança.
- ⚠️ **GAP-A1 (clientes legados):** clientes criados no ASAAS ANTES desta política têm `notificationDisabled=false`. Só são corrigidos quando passam por `updateAsaasCustomer` (fluxo de cobrança). **Ação sugerida:** rodar um backfill que faça `PUT /customers/{id}` com `notificationDisabled:true` em todos os clientes ASAAS do cedente (script ops).
- ⚠️ **GAP-A2 (timing assíncrono):** a criação da cobrança passa por fila (`asaas-charge-create.worker`); se o worker estiver lento/desligado, o `payment.create` devolve `status:"processing"` sem o link — o n8n precisa fazer polling em `session.status`. **Com o worker Fargate off (Upstash no teto), a criação real pode não completar** — validar o worker antes do go-live de cobrança real.
- ⚠️ **GAP-A3 (múltiplos acordos):** o guard de idempotência é por ACORDO, não por DÍVIDA — em teoria dois acordos abertos da mesma dívida poderiam gerar duas cobranças (raro). Avaliar guard por `debt_id`.
- 🔑 **Webhook token:** confirmar `ASAAS_WEBHOOK_TOKEN` setado e a URL do webhook registrada no painel ASAAS (senão a conciliação não chega em tempo real — resta só o `sync-payments` manual).

### n8n
- ✅ **Papel A/B codado** (engine `disabled` até GATE X6): `payment.create` cria cobrança e devolve o link; HMAC + dedupe por `event_id`.
- ⚠️ **GAP-N1 (GATE X0):** o fluxo n8n precisa ser configurado (Webhook Basic Auth + nó HMAC + roteamento por `event`) e os envs setados no Netlify (`N8N_CHAT_FLOW_URL`, `N8N_WEBHOOK_SECRET`, `N8N_BASIC_AUTH_USER/PASSWORD`) → probe → GATE X0. **Pendente do Fabio/n8n.** (URL/senha = SEGREDO, só env.)
- ⚠️ **GAP-N2 (link no processing):** se a cobrança volta `processing`, o n8n precisa do loop de polling `session.status` até o link existir. Confirmar que o fluxo n8n implementa esse polling.
- ⚠️ **GAP-N3 (valores em centavos):** a borda n8n usa **centavos** (contrato v2 §6.4). Garantir que o fluxo n8n converte para exibir R$ no chat.

### Voxuy (WhatsApp)
- ⚠️ **GAP-V1 (mock):** Voxuy está **adormecido** (`whatsapp_dispatch_mode` default mock). Nada sai por WhatsApp hoje.
- ⚠️ **GAP-V2 (ativação):** falta credencial real (`VOXUY_WEBHOOK_URL`) + `voxuy_flow_id` + telefones em E.164 para ligar `voxuy_api`. **Pendente do Fabio.**
- ⚠️ **GAP-V3 (envio do link):** como o ASAAS não envia, a AlteaPay tem que mandar o **link de pagamento** por WhatsApp (Voxuy) e/ou e-mail (SendGrid). O envio pelo chat insere a URL/botão; validar que o fluxo (n8n `chat.send` ou o assistido) inclui o link de pagamento quando a cobrança é criada.
- ℹ️ **E-mail (SendGrid) já funciona** direto (`sendEmailViaSendGrid`), com click-tracking **desligado** (o domínio de rastreio `url6522.alteapay.com` não resolve — ver `[[vmax-template-cobranca]]`). O WhatsApp real depende do Voxuy (V1/V2).
- ⚠️ **GAP-V4 (`success:true` não é entrega):** a Voxuy retorna `{"success":true}` = "recebi o webhook", **nunca** "entreguei". **Não existe status de entrega por mensagem via API.** Quando o WhatsApp "some" (aceita mas não chega), diagnosticar **nesta ordem** (doc oficial `manual.voxuyenterprise.com.br`):
  1. **BLACKLIST (mais provável):** o contato clicou "Sair da lista"/"Cancelar Recebimento" → ação de fluxo **"Adicionar à blacklist"** ("impede que automações sejam enviadas"); a API segue `success:true`. **Verificar:** CRM → Contatos → filtro **blacklist**.
  2. **Contato PRESO no fluxo:** nó "Aguarda resposta indefinidamente" sem tempo limite → não reentra num novo disparo (comportamento não documentado). **Verificar:** CRM → Contatos → filtro **fluxos**.
  3. **Forma de pagamento da Meta** esgotada/ausente. **Verificar:** Business Manager → Contas WhatsApp.
  4. **Limite de mensagens por nível** (dimensiona o piloto; não explica falha de 1).
  - **Enfraquece "flowId errado":** a doc só fala "ID do fluxo específico a executar" — não há ID de gatilho de API separado.
- 🧨 **GAP-V5 (produto — botão ambíguo):** **"Cancelar Recebimento"** é ambíguo/perigoso em cobrança — pode ser lido como **"cancelar a cobrança"**, o que explicaria "100% clicaram nele". **Recomendação:** renomear para **"Parar de receber mensagens"** e manter **"Consultar Dívida"** como 1º botão, destacado.
- 🕳️ **GAP-V6 (produto — blacklist invisível):** a blacklist da Voxuy **existe** (como AÇÃO de fluxo, sem API de consulta) e é **INVISÍVEL para a AlteaPay** — continuamos contando o contato como enviado e mandando e-mail. **Correção (em implementação):** nó **Webhook** no fluxo Voxuy → registra a **supressão do nosso lado** (`contact_suppressions`) quando o contato entra na blacklist/opt-out.

---

## 4. Checklist para cobrança real ponta-a-ponta

- [ ] **Worker Fargate ligado** (ou criação de cobrança inline) — hoje off (Upstash no teto) → GAP-A2.
- [ ] **Webhook ASAAS** registrado + `ASAAS_WEBHOOK_TOKEN` — conciliação em tempo real.
- [ ] **Backfill** `notificationDisabled:true` nos clientes ASAAS legados — GAP-A1.
- [ ] **n8n GATE X0** (fluxo + envs + probe) — GAP-N1.
- [ ] **Voxuy real** (credencial + flowId + E.164) — GAP-V1/V2.
- [ ] Fluxo n8n inclui o **link de pagamento** no `chat.send` + polling `session.status` — GAP-N2/N3/V3.
- [ ] Validar que, após pagamento, o devedor vê **quitada** e o link fica **só consulta** (guard bloqueia recobrança) — já implementado, validar E2E.

Ver também [[onda-f1-f4-2026-09-22]], [[vmax-template-cobranca-2026-09-22]], `docs/N8N_TEAM_INTEGRATION_GUIDE.md`.
