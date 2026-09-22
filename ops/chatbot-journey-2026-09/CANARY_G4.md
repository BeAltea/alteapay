# J-F8 / G4 — Canário admin-only da jornada (tenant Altea-Testes)

**Objetivo:** provar, em produção, o caminho ponta-a-ponta da jornada de negociação
com a imagem Fargate nova (`journey-9e2aaee`), restrito ao tenant de teste
`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` e a usuários admin logados — sem tocar
em nenhum tenant real e sem cobrar dinheiro de verdade.

> **Imagem Fargate:** `:latest = :journey-9e2aaee` → `sha256:a2e21f88…caf023`
> **Rollback da imagem:** `vmax-guard-292caf9` → `sha256:704f603c…d319cf`

---

## Raio de alcance (LER ANTES DE EXECUTAR)

O canário não é 100% isolado no tenant de teste. Três efeitos vazam para produção:

1. **Chave ASAAS = produção (`$aact_prod_…`).** O `confirm` cria uma cobrança
   ASAAS **real** (boleto/PIX de verdade). Mitigação: 1 cobrança, valor mínimo
   (à vista PIX, R$ 5,00), **cancelada logo após o write-back** (antes de qualquer
   pagamento). O guard de idempotência trata `DELETED` como não-bloqueante.
2. **Worker Fargate é compartilhado.** Subir `alteapay-workers` para `desired=1`
   drena **todas** as filas de produção (`alteapay-email`, `alteapay-charge`,
   `asaas-*`, `bulk-*`, `whatsapp`, `n8n`), não só o job do canário. **PRÉ-REQUISITO
   DURO:** confirmar que essas filas estão vazias/quase-vazias antes de escalar
   (ver "Gate de fila" abaixo). Se houver backlog, NÃO escalar o serviço global.
3. **Flag global no Netlify.** `CHAT_JOURNEY_ENABLED=true` liga o gancho de
   conciliação no webhook ASAAS para **todos** os tenants. É aditivo e seguro:
   `journeyOnPaymentEvent` retorna cedo para qualquer acordo sem
   `negotiation_session_id` (todos os acordos de produção). Ainda assim, é uma
   mudança de comportamento em produção — por isso o gate G4.

Efeitos que **não** ocorrem no canário:
- **E-mail ao credor:** só dispara em `PAYMENT_RECEIVED`. Como cancelamos a
  cobrança e nunca pagamos, nenhum e-mail ao credor é enviado. (Verificar ainda
  assim que `tenant_chat_config.creditor_notification_emails` do tenant de teste
  aponta para endereço interno.)
- **WhatsApp real:** sem `WHATSAPP_PROVIDER=voxuy`, o worker usa o provider `mock`
  — o "envio" apenas cunha o token e marca `sent`. Nenhuma mensagem real sai.

---

## Gate de fila (PRÉ-REQUISITO — decisão do Fabio)

Antes de `desired=1`, é preciso confirmar que as filas de produção estão vazias.
A leitura direta do Upstash exige a credencial de produção (bloqueada pelo
classificador de auto-mode). Opções:

- **(A)** Fabio roda o probe read-only e cola o resultado:
  ```
  ! cd /Users/seufabio/git/ALTEAPAY/altea-pay && \
    export REDIS_URL="$(aws ecs describe-task-definition --task-definition alteapay-workers:6 \
      --region sa-east-1 --query "taskDefinition.containerDefinitions[0].environment[?name=='REDIS_URL'].value | [0]" --output text)" && \
    npx tsx /tmp/queue-probe.ts
  ```
- **(B)** Fabio autoriza a permissão de Bash para o probe e eu rodo.

**Regra:** `TOTAL_PENDING_ACROSS_QUEUES` deve ser **0** (ou apenas jobs
reconhecidamente do canário) para prosseguir com o escalonamento do serviço
compartilhado. Se > 0, PARAR e tratar o backlog primeiro.

---

## Sequência (só após o gate de fila)

1. **Config do tenant de teste** (uma vez):
   - `tenant_chat_config.journey_public_enabled = false` (modo admin-only → `/c/` dá 404 para não-admin).
   - `creditor_notification_emails` = e-mail interno (ou vazio).
   - matriz ativa com uma linha à vista/PIX (desconto 0%).
2. **Flags no Netlify (produção):**
   - `CHAT_JOURNEY_ENABLED=true`
   - `NEGOTIATION_ENGINE=disabled` (menu determinístico — sem IA/n8n no canário)
   - `WHATSAPP_PROVIDER=mock`
   - redeploy do site (as env vars só valem no próximo build/deploy).
3. **Worker:** `aws ecs update-service --cluster alteapay --service alteapay-workers --desired-count 1 --region sa-east-1` e aguardar `runningCount=1` + health.
4. **Rodar o canário:** `npx tsx ops/chatbot-journey-2026-09/scripts/canary_g4.ts --run`
   (default é `--dry-run`; ver script). Ele: semeia 1 cliente sintético (CPF
   válido gerado, dívida R$ 5,00), cria campanha, "envia" (mock), cunha token,
   autentica via HTTP em https://alteapay.com, pega oferta à vista, aceita e
   confirma. Depois espera o worker gravar `asaas_payment_id` **real** (prefixo
   `pay_`, não `pay_mock_`).
5. **Cancelar a cobrança real** (via ASAAS API/`asaasChargeCancelQueue`) e
   confirmar o webhook real `PAYMENT_DELETED` → `payment.cancelled` na conciliação.
6. **Coletar evidências** (journey_events, agreement, session outcome).

## Rollback / desmontagem (SEMPRE ao final)

1. `aws ecs update-service --cluster alteapay --service alteapay-workers --desired-count 0 --region sa-east-1`
2. Netlify: `CHAT_JOURNEY_ENABLED=false` + redeploy (volta ao estado G3).
3. Garantir cobrança ASAAS do canário `DELETED` (nenhum valor a receber).
4. Dados sintéticos ficam no tenant de teste (não poluem tenants reais);
   opcionalmente marcar a sessão como `abandoned`.

## Critérios de aprovação (Go/No-Go do G5)

- [ ] `/c/[token]` responde 404 para anônimo e 200 para admin logado (gate D13).
- [ ] auth por CPF: 3 erros → lock; CPF certo → 200 + cookie de sessão.
- [ ] oferta da matriz, aceite em 2 passos, `agreement` criado com `origin=chat_journey` e `negotiation_session_id`.
- [ ] worker novo gravou `asaas_payment_id` **real** + `asaas_pix_qrcode_url`.
- [ ] reenvio do confirm → mesmo agreement, 0 cobrança nova (idempotência).
- [ ] `PAYMENT_DELETED` real reconciliou (`payment.cancelled`), sessão fora de `agreement_closed`.
- [ ] nenhum e-mail ao credor disparado; nenhum efeito em tenant real.
- [ ] filas de produção sem drenagem indevida (gate de fila = 0 antes de escalar).
