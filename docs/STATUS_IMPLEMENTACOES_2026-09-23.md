# Status de Implementações — AlteaPay (2026-09-23)

Consolida **todas as implementações recentes** (PRs #83–#95, branch `feature/journey-neutral-prelogin` → `main`, deployadas em produção via Netlify). Complementa `docs/CHATBOT_JOURNEY_STATUS_2026-09-22.md` (jornada) e `docs/INTEGRACOES_ASAAS_N8N_VOXUY_2026-09-22.md` (integrações + gaps).

**Produção:** `https://alteapay.com` · **Testes:** ~649+ verdes · **Chat VMAX:** `https://alteapay.com/n/k7Qm3Xb9Rt`.

---

## 1. Envio de negociação — SELEÇÃO DE CANAL (F1–F4)

- **Diálogo "Enviar Negociação"** agora usa **seleção de canal** — checkboxes **WhatsApp + E-mail** (ambos default), "não duplicar". Substituiu o antigo "Método de Pagamento + Canal SMS".
- **Onde:** disponível tanto no hub `/super-admin/negociacoes` (F1) quanto na página do menu **`/super-admin/negotiations`** (que tem a lista rica da VMAX + "Sincronizar ASAAS"). Fix PR #94: o menu apontava pra página velha; trouxe o diálogo F1 pra ela, com **ponte VMAX→customers** (por documento) para resolver os `customerId` das rotas `send-preview`/`send`.
- **Filtro por perfil de contato (F2):** Só celular / Só e-mail / Ambos / Sem contato (URL `?contato=`).
- **Gerenciamento de E-mails (F3):** `/super-admin/emails` — templates CRUD + versionamento, editor com preview `iframe sandbox`, **sanitizador de HTML** (allowlist) + **allowlist de variáveis em 2 níveis** (básicas sempre; **de débito** só com `allow_debt_fields=true` + `purpose=negotiation` + canal e-mail).
- **Template padrão por cedente (F4)** + **template de cobrança VMAX** com dados do débito (nome/valor/vencimento/documento mascarado) — reusa `buildAckContext` (paridade com o chat). Ver `docs/VMAX_COBRANCA_TEMPLATE_FASE0_2026-09-22.md`.
- **Idempotência de campanha (A1):** chave por abertura do diálogo + UNIQUE `(company_id, idempotency_key)` — double-click não duplica envio.
- **Fix PR #93:** `/super-admin/emails` quebrava com o template de débito (o editor não mandava `allowDebtFields` ao preview → "variável proibida"). Corrigido + guardas try/catch por-template.
- **Envio de e-mail:** SendGrid **REAL** (`EMAIL_SEND_MODE=inline`), **click/open tracking DESLIGADO** (o domínio `url6522.alteapay.com` não resolvia e quebrava todos os links — PR #88). WhatsApp = **Voxuy mock** (pendente ativação real).

## 2. Reuso de sessão + auth do chat

- **Reuso de sessão** funcionando: reentrada reabre a MESMA sessão (`reopen_count`++). Fix crítico: `last_activity_at` no INSERT + CHECK `channel` corrigido (`web_public_link`).
- **`/api/chat/auth` exige `consent:true`** no payload (sem ele → `reason:"invalid"`).

## 3. ASAAS — política e cobrança

- **ASAAS NÃO comunica o devedor** (PR #91): `createAsaasCustomer`/`updateAsaasCustomer` forçam `notificationDisabled:true`; matriz de notificações com todos os canais do cliente `false`. Toda comunicação via AlteaPay. **Backfill aplicado: 3.196/3.196 clientes ASAAS com notificação desligada.**
- **Link de pagamento consultável no hub:** exibido por devedor em `/super-admin/negociacoes-chat` (badge "pago" quando conciliado).
- **Cobrança INLINE (PR #95):** `lib/journey/charge-inline.ts` cria a cobrança ASAAS **na própria request** (sem depender do worker Fargate, que está off). Gated por **`CHARGE_MODE`** — **agora `inline` em produção**. Usa as funções canônicas de `lib/asaas` (notificações off), idempotente (guard `asaas-idempotency`), imports dinâmicos (não puxa Redis). `paymentCreate` devolve `created` com o link quando inline.
- **Conciliação:** webhook ASAAS → `paid` → jornada `quitada` → guard bloqueia recobrança (link vira só consulta).

## 4. Base VMAX — completude e sanitização de contatos

- **Backfill de customers:** os **616 devedores VMAX** sem cadastro em `customers` foram **criados** (a partir da VMAX) → **3.812/3.812** agora têm cadastro (o envio de negociação é customers-keyed; antes recusava com "documento sem correspondência").
- **Sanitização de contatos** (Voxuy/n8n): telefone **normalizado para E.164** (`+55DDD9XXXXXXXX`, 0 fora do padrão), pegando o melhor celular entre `phone`/`Telefone 1`/`Telefone 2`; e-mail maximizado. **Cobertura:** celular **3.782**, e-mail **3.647**, ambos **3.618**, sem contato **1**. O trigger `trg_customers_contact_profile` deriva `mobile_e164`/`email_valid`/`contact_profile` do `phone`/`email`.

## 5. Usuário de teste (temporário)

- **Fabio Moura Barros** (CPF 417.190.108-11, +55 11 97460-2123, fabiofmb71@gmail.com) na VMAX, com **dívida fictícia R$ 250** (`pending`). **Flagado** `source_system='test'` + `external_id='TEST_FABIO'`, **fora da tabela VMAX** (não interfere nos valores reais). Testa a jornada pelo chat (`/n/k7Qm3Xb9Rt` + CPF). **Remover:** `node ops/chatbot-journey-2026-09/seed_test_user_fabio.js --remove`.

## 6. Páginas legais

- **Política de Privacidade** e **Termos de Uso** (`public/*.html`): data 22/09/2026, contatos → **relacionamento@alteapay.com**, telefone → **(11) 92580-7306**, fornecedores preenchidos (hospedagem Netlify/Supabase/AWS/Upstash, WhatsApp Voxuy, SMS+e-mail SendGrid/Twilio, pagamentos ASAAS, automação n8n), retenção/opt-out/analytics.

---

## 7. Configuração de produção (envs relevantes)

| Env | Valor | Efeito |
|---|---|---|
| `CHARGE_MODE` | **`inline`** | Cobrança ASAAS criada na request (worker off) |
| `EMAIL_SEND_MODE` | `inline` | E-mail SendGrid disparado na request (real) |
| `WHATSAPP_DISPATCH_MODE` | `mock` | WhatsApp/Voxuy não envia (aguarda ativação) |
| `NEGOTIATION_ENGINE` | `disabled` | Chat assistido determinístico (n8n até GATE X6) |
| `CHAT_JOURNEY_ENABLED` | `true` | Chat público `/n/{code}` ativo |
| SendGrid `from` | `relacionamento@alteapay.com` | Remetente; tracking desligado |

---

## 8. GAPS / pendentes (dependem de config externa ou decisão)

1. **Gatilho de cobrança no chat:** o chat assistido faz só o **reconhecimento** (não tem aceite de oferta que dispare a cobrança); o **n8n** (que chamaria `payment.create`) está off. Com `CHARGE_MODE=inline`, a cobrança é criada **quando houver gatilho** — hoje só via chamada direta ou quando o n8n/aceite existirem.
2. **n8n GATE X0/X6:** configurar o fluxo n8n (Webhook Basic Auth + HMAC + roteamento) + envs (`N8N_*`) → probe → ligar `NEGOTIATION_ENGINE=n8n`. **Pendente Fabio/n8n.**
3. **Voxuy real:** credencial (`VOXUY_WEBHOOK_URL`) + `voxuy_flow_id` + telefones E.164 (já normalizados) → ligar `whatsapp_dispatch_mode=voxuy_api`. Hoje mock.
4. **Worker Fargate off** (Upstash no teto): a cobrança já roda inline; mas e-mail em lote e outros jobs dependem do worker. Ligar quando sair do teto.
5. **ASAAS webhook:** confirmar `ASAAS_WEBHOOK_TOKEN` + URL do webhook registrada no painel ASAAS (conciliação em tempo real; senão só `sync-payments` manual).
6. **Remover o usuário de teste** (Fabio) após validação (§5).

---

*Docs relacionados: `CHATBOT_JOURNEY_STATUS_2026-09-22.md`, `INTEGRACOES_ASAAS_N8N_VOXUY_2026-09-22.md`, `VMAX_COBRANCA_TEMPLATE_FASE0_2026-09-22.md`, `N8N_TEAM_INTEGRATION_GUIDE.md`.*
