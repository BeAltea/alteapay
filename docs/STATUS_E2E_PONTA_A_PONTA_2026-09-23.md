# Status E2E — Cobrança ponta a ponta (WhatsApp/e-mail → chat → cobrança → webhook)

**Data:** 2026-09-23 · **Cedente de teste:** VMAX (`1f7729ee-a537-43fc-a27f-5747c177988d`) · **Usuário de teste:** Fabio Moura Barros

---

## 1. Resumo executivo — o que FUNCIONA e o que NÃO

| Etapa do fluxo | Estado | Observação |
|---|---|---|
| **Envio por E-MAIL** (link de negociação) | ✅ **FUNCIONA** | Fabio recebeu o e-mail real (SendGrid inline, sem Redis). |
| **Envio por WhatsApp (Voxuy)** | ⚠️ **ACEITA mas NÃO ENTREGA** | Nossa integração está **correta e comprovada** (payload exato, Voxuy retorna `{"success":true}`). A não-entrega é **do lado Voxuy/Meta** (ver §5). |
| **Link `/n/{code}` → página neutra** | ✅ FUNCIONA | `https://alteapay.com/n/k7Qm3Xb9Rt` responde 200. (Bug de barra dupla `//n/` corrigido.) |
| **Auth por CPF/CNPJ** | ✅ FUNCIONA | Fabio autenticou e entrou no chat. |
| **Chat (negociação)** | ✅ FUNCIONA (assistido) | Usa o **engine ASSISTIDO** (menu determinístico). **n8n está DESLIGADO.** |
| **Aceite → cobrança ASAAS inline** | 🟡 PRONTO, não testado E2E | Código pronto (`CHARGE_MODE=inline`); Fabio ainda não chegou ao aceite (bloqueado antes pelo WhatsApp/link). |
| **Webhook ASAAS → fecha jornada** | 🟡 PRONTO, não testado nesta rodada | Conciliação fecha em `PAYMENT_CONFIRMED`/`RECEIVED`. |
| **n8n como cérebro da conversa** | ⛔ DESLIGADO | `NEGOTIATION_ENGINE=disabled`. Contrato pronto; ligar depende do time n8n (§4). |

**Conclusão:** o fluxo **por e-mail** roda ponta-a-ponta até o chat. O **WhatsApp** trava só na **entrega da Voxuy** (config do lado deles). A cobrança/webhook estão prontos e faltam ser exercitados até o fim.

---

## 2. Config atual de produção (verificada 2026-09-23)

**Envs Netlify:** `CHAT_JOURNEY_ENABLED=true` · `DISPATCH_MODE=inline` · `EMAIL_SEND_MODE=inline` · `CHARGE_MODE=inline` · `NEGOTIATION_ENGINE=disabled` · `VOXUY_MODE`/`MOCK_ALL_INTEGRATIONS` ausentes (→ envio real) · `VOXUY_WEBHOOK_URL`/`N8N_CHAT_FLOW_URL`/`ASAAS_WEBHOOK_TOKEN`/`CRON_SECRET` SET.

**Tenant VMAX (`tenant_chat_config`):** `whatsapp_dispatch_mode=voxuy_api` · `whatsapp_provider=voxuy` (as DUAS precisam estar em voxuy) · `voxuy_flow_id=7064` · `journey_public_enabled=true` · `public_link_code=k7Qm3Xb9Rt` · `session_ttl_minutes=43200` (30 dias) · `official_channel_label=NULL` ⚠️ (gap, ver §7) · `fulfillment_mode=A`.

**Infra:** workers Fargate + Upstash **DESLIGADOS** → tudo roda **inline** (fallback sem Redis completo).

---

## 3. O que está DEPLOYADO e funcionando (esta rodada)

- **Fallback inline SEM Redis (completo):** e-mail (`EMAIL_SEND_MODE=inline` → SendGrid direto), cobrança (`CHARGE_MODE=inline`), WhatsApp (`DISPATCH_MODE=inline`), auth/sessão e aceite→boleto — nenhum toca Redis. Fallback **automático**: se o modo for `queue` mas o Upstash não responder (`pingRedis`, timeout 1.5s), força inline.
- **Contrato n8n v1** (`lib/negotiation/payload.ts`): alinhado à captura real (type, contract_version, event_id determinístico, `debtor.name`/`id`, `debt.id`/`amount_cents`/`amount_formatted`, `tenant.chat_link` etc.). Outbox durável. **Gated (engine disabled) → nada é enviado.**
- **Cobrança:** `payment.create` valida matriz (422 fora / 409 sem reconhecimento), `already_charged` devolve link existente, caminho assistido fecha sem depender do n8n.
- **Conciliação:** webhook ASAAS fecha `debt.paid`+acordo+VMAX PAGO em CONFIRMED/RECEIVED/RECEIVED_IN_CASH.
- **ASAAS não comunica o devedor:** `notificationDisabled:true` forçado (trava de build).
- **Voxuy adapter (enterprise_v1):** payload só `link_negociacao/primeiro_nome/credor` (sem valor/vencimento/doc), URL canônica validada, 404→pausa, probe W0.
- **UX do hub de envio:** progresso REAL item-a-item (stream NDJSON), painel **"✓ Envio concluído"** sempre aparece, flag **"Permitir reenvio"** (ignora cooldown), coluna **"Enviado"** (já recebeu WhatsApp/e-mail + data) nas duas telas.
- **Rota debug** `/api/webhooks/whatsapp/voxuy/test-send` (Bearer CRON_SECRET): dispara o payload real e devolve o retorno cru da Voxuy.
- **Timeout do chat:** 60min → 30 dias (VMAX).
- **Páginas legais** (privacidade/termos), contato `relacionamento@alteapay.com` / `(11) 92580-7306`.

---

## 4. n8n — DESLIGADO (contrato pronto)

- `NEGOTIATION_ENGINE=disabled` → o chat usa o engine **assistido**, não o n8n. **Nenhum payload é enviado ao n8n hoje.**
- **Decisão 2026-09-23:** o n8n **removeu a autenticação**; seguimos "só com o endpoint". A URL (`N8N_CHAT_FLOW_URL`) é a única proteção → **segredo**. GATE X0 rebaixado para conectividade.
- **Para ligar (`NEGOTIATION_ENGINE=n8n`):** o time n8n precisa (1) passar a **ler `type`** (não `event`) no chat.turn; (2) o fluxo conduzir a negociação. Rever o budget de latência do login.
- Payload que **seria** enviado (exemplo com dados do Fabio): `type:chat.turn`, `debtor{name:"Fabio", document_masked:"***.190.108-**", document:null}`, `debt{amount:250, amount_cents:25000, due_date:"2026-08-15", aging_days:39}`, `tenant{brand_name:"VMAX", chat_link:".../n/k7Qm3Xb9Rt"}`.

---

## 5. WhatsApp/Voxuy — por que NÃO entrega (diagnóstico)

**Comprovado (chamada direta `test-send` pro nº do Fabio):**
```json
{ "status":200, "body":{"success":true}, "flowId":7064,
  "payloadShape":{"flowId":7064,"contactKeys":["name","phoneNumber","variables"],
  "variableKeys":["link_negociacao","primeiro_nome","credor"]} }
```
→ **Nosso lado está 100% correto** (`success:true`). Segundo a doc oficial
(`manual.voxuyenterprise.com.br`), `success:true` significa **"recebi o webhook"**,
**nunca** "entreguei" — não existe status de entrega **por mensagem** via API. A causa
está no painel Voxuy/Meta.

**Causas prováveis, em ORDEM de probabilidade:**
1. **BLACKLIST (mais provável).** O contato clicou **"Sair da lista"/"Cancelar
   Recebimento"** e entrou na blacklist da Voxuy (ação de fluxo **"Adicionar à
   blacklist"**, que *"impede que automações sejam enviadas"*). A API segue retornando
   `success:true`. Explicaria "clicaram e pararam de receber". **Verificar:** CRM →
   Contatos → filtro **blacklist**.
2. **Contato PRESO no fluxo.** Um nó **"Aguarda resposta indefinidamente"** (sem tempo
   limite) mantém o contato dentro do funil, e ele **não reentra** num novo disparo
   (comportamento **não documentado** — disparar a um contato já dentro do fluxo). A API
   ainda responde `success:true`. **Verificar:** CRM → Contatos → filtro **fluxos**.
3. **Forma de pagamento da Meta** esgotada/ausente (conta WhatsApp conectada em 21/09).
   **Verificar:** Business Manager → Contas WhatsApp.
4. **Limite de mensagens por nível** da conta — não explica a falha de **1** mensagem,
   mas dimensiona o tamanho do piloto.

**Enfraquece a suspeita anterior ("flowId errado"):** a doc oficial só menciona *"ID do
fluxo específico a executar"* — **não há um ID de gatilho de API separado** do ID do
fluxo. O `flowId 7064` deve estar correto; o problema quase certamente é blacklist/fluxo,
não ID.

**ORDEM de verificação (do mais barato ao mais caro):**
1. **CRM → o contato** (+5511974602123): está em **blacklist**? preso num **fluxo**?
   marcado como **WhatsApp inválido**?
2. **Disparar de novo** e olhar o contador **"Executados"** do nó **Template**.
3. **Atendimento** (histórico da conversa) para o número.
4. **Business Manager** (forma de pagamento / limite de mensagens).
5. **Suporte Voxuy**, se nada acima explicar.

---

## 6. Pendências / próximos passos

**Bloqueia o WhatsApp (Voxuy-side, do Fabio) — na ordem do §5:** checar **blacklist** e **contato preso no fluxo** (CRM → Contatos) → redisparar e olhar "Executados" do nó Template → checar **forma de pagamento/limite** no Business Manager. (flowId 7064 provavelmente está OK — ver §5.)
**Para o teste E2E completo:** logar no chat (agora sem timeout) → aceitar condição → gerar boleto/PIX R$250 → (pagar) → webhook fechar. Pode ser feito **pelo link do e-mail** (que funciona), sem depender do WhatsApp.
**Para 25 reais:** só após o W6 (1 número) validado ponta-a-ponta. Seleção no hub, `dryRun` antes, cap inline 25, coluna "Enviado" ajuda a não duplicar.
**n8n:** alinhar o fluxo (`type`) + ligar `NEGOTIATION_ENGINE=n8n`.
**G4 (migrations):** `20260930_engine_outbox` + `20260931_debtor_engine_snapshot` **NÃO aplicadas em prod** (o código roda sem elas; aplicar antes de ligar o n8n/jornada durável).
**Config:** preencher `tenant_chat_config.official_channel_label` da VMAX (hoje NULL).

---

## 7. Gotchas descobertos (para não repetir)

1. **Coluna legada `whatsapp_provider`:** o hub grava `campaign.provider` a partir dela — para envio real, setar **AMBOS** `whatsapp_dispatch_mode='voxuy_api'` E `whatsapp_provider='voxuy'` no tenant. Só um → badge "simulado" + saída mock.
2. **flowId do tenant vs env:** `loadVoxuyApiConfig` exigia o env `VOXUY_FLOW_ID` mesmo com o tenant — travava a msg em `queued`. Corrigido (injeta o flowId do tenant).
3. **`NEXT_PUBLIC_APP_URL` com barra final** → link `//n/` → not-found. Corrigido (normaliza em todos os pontos).
4. **Duas telas de negociação:** `/super-admin/negotiations` (antiga, VMAX/agreements — a que o Fabio usa) vs `/super-admin/negociacoes` (nova, journey). A coluna "Enviado" foi para as duas.
5. **Hub lista da tabela `VMAX`** (não `customers`): o usuário de teste precisou de linha na VMAX para aparecer.
6. **Cooldown com piso de 1 dia** (não desarma por config) → flag "Permitir reenvio".
7. **Stream de progresso:** o proxy/Netlify cortava a última linha NDJSON → o painel de sucesso descartava o envio. Corrigido (não lança sem `done`).

---

## 8. Usuário de teste — LIMPEZA (após validar)

- `customers` `c6d03721` (Fabio, `source_system='test'`, `external_id='TEST_FABIO'`) + `debts` `0efc0a54` (R$250).
- `VMAX` linha `c4dc0ada` (marcada `Motivo Específico='TESTE_FABIO_REMOVER'`) — **some no valor da VMAX até remover**.
- **Reverter:** VMAX `whatsapp_dispatch_mode='mock'` + `whatsapp_provider='mock'`; `delete from "VMAX" where id_company=VMAX and "Motivo Específico"='TESTE_FABIO_REMOVER'`; remover o customer/debt de teste; `session_ttl_minutes` de volta a 60 (se não quiser 30 dias em prod).

---

*Documentos relacionados: `docs/FASE0_INTEGRACAO_PONTA_A_PONTA_2026-09-23.md` (diagnóstico), `docs/INTEGRACOES_ASAAS_N8N_VOXUY_2026-09-22.md` (integrações), `RUNBOOK` Voxuy.*
</content>
