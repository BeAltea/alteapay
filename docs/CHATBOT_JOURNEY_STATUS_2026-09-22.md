# Chatbot / Jornada de Negociação — Status de Implementação

**Data:** 2026-09-22 · **Branch:** `feature/journey-neutral-prelogin` (mergeada em `main` via PRs #73–#81)
**Produção:** `https://alteapay.com` (Netlify + Supabase `hpjzlmurljxzwjtwcbkz` sa-east-1 + Upstash/BullMQ + Fargate)
**Estado dos testes:** ~499 verdes · build/deploy verdes · último deploy `368f8e6`.

> Substitui `CHATBOT_JOURNEY_STATUS_2026-09-21.md`. Este documento reflete o que está **no ar hoje**, o que está **pronto mas gated**, e o que **falta**.

---

## 1. Resumo executivo — o que está NO AR

O chat público de negociação está **ativo em produção** para o cedente **VMAX**:

**👉 Link do chat: `https://alteapay.com/n/k7Qm3Xb9Rt`** (link único por cedente; código opaco `public_link_code`, não revela "VMAX").

Fluxo do cliente hoje: abre o link → tela neutra AlteaPay → informa **CPF/CNPJ** → o sistema resolve a dívida:
- **Dívida aberta** (`pending`/`in_negotiation`) → mensagem única de **reconhecimento** com nome + credor + valor + vencimento + botões **[1] Sim, reconheço / [0] Não reconheço**.
- **Dívida paga** (`paid`) → mensagem de **quitação** (valor + "PAGA em DD/MM/AAAA") + botão **"Recebi uma cobrança — falar com atendimento"** → `/?tipo=recebi_cobranca#contato`.
- **Sem dívida / documento inexistente** → mensagem **uniforme** "não encontramos dívidas…".

Motor de conversa hoje = **assistido determinístico** (`NEGOTIATION_ENGINE=disabled`). O n8n está **codado mas desligado** (§5). Provider WhatsApp = **`mock`** (nada é enviado; §4). Sem cobrança ASAAS real (Upstash no teto).

---

## 2. Link único `/n/{code}` — acesso, auth e reconhecimento

- **URL sem o nome do credor** (código opaco `tenant_chat_config.public_link_code` = `k7Qm3Xb9Rt` para o VMAX; `public_link_enabled=true`, janela até 2026-10-21). Marca do credor **só aparece após o login** (casca neutra AlteaPay antes; `noStore` para ligar/desligar o link em tempo real).
- **Auth = só CPF/CNPJ** (`authenticateByPublicLink`): DV, resposta **uniforme** para inexistente/sem-dívida, timing equalizado (~600ms), rate-limit **IP + documento + teto por cedente/hora**, captcha Turnstile **funcional e ligável** (`CHAT_CAPTCHA_ENABLED`, hoje OFF). Auditoria só com `doc_hash`/`ip_hash`.
- **`resolveByDocument`** (`lib/journey/resolver.ts`) retorna união discriminada **`open | settled | none`**:
  - busca o customer por documento (query direta `.in(candidatos cru+pontuado)` — **sem** o antigo limite de 1000 linhas do Supabase que quebrava tudo);
  - `open` = dívidas `pending`/`in_negotiation`; `settled` = só dívidas `paid`; `none` = sem customer ou sem dívida.
- **Reconhecimento** (`lib/journey/acknowledgement.ts`): mensagem ÚNICA `"Olá, {1º nome}! Temos uma dívida em seu nome da empresa {credor}. Valor atualizado {R$X}, vencimento mais antigo em {DD/MM}. Você reconhece esta cobrança em seu nome?"`. Clique **Sim** → "Perfeito! Então vamos trabalhar juntos para sanar o seu débito." Clique **Não** → "Obrigado pelo seu retorno… entre em contato diretamente com a {credor}." Sem ofertas/desconto (não implementado ainda). Log append-only em `debt_acknowledgements` + `journey_events`.
- **Front do chat** (`components/journey/chat.tsx`): histórico preservado ao clicar; timer de inatividade **5 min** → volta pro **login do chat `/n/{code}`** (nunca `/auth/login`); **401 (sessão expirada)** também redireciona pro login do chat.

## 3. Dívida paga (settled)

Cliente cuja dívida está `paid` entra no chat e vê a mensagem de quitação (data de `agreements.payment_received_at` → `asaas_payment_date` → `debts.updated_at`) + o botão de contato. `resolveByDocument` distingue `settled` de `none` (só `none` mantém a resposta uniforme). Exposição consistente com a de dívida aberta (auth CPF-only, só o próprio débito).

## 4. Hub "Enviar Negociação" via Voxuy (mock)

Página `/super-admin/negociacoes`: seleção 1/N → `send-preview` (contagens por canal + exclusões) → diálogo → `send`. Canal por contato (celular→WhatsApp Voxuy; senão e-mail; senão `no_contact`). **Não cria cobrança** (caminho antigo = `negotiation_send_mode='charge_email'`, preservado). Provider **`VoxuyApiProvider` dialeto `enterprise_v1`** (`{flowId, contact{name, phoneNumber, variables{link_negociacao, primeiro_nome, credor}}}`, POST na URL-credencial sem apiToken, resposta `success` minúsculo) — hoje em **`mock`** (nada enviado). Payload sem `document`/`email`/`transaction`/valores. Idempotência nossa (`jobId`, `UNIQUE(campaign_id, customer_id)`). `DISPATCH_MODE=inline` (piloto sem worker).

## 5. Integração n8n (papel A/B) — CÓDIGO PRONTO, engine DISABLED

`NEGOTIATION_ENGINE=disabled` até GATE X6 (runbook 2026-09-22).
- **Papel A** (nós→n8n, `lib/negotiation/engine.ts`+`n8n.ts`): Basic Auth + HMAC (`${ts}.${body}`) + `X-AlteaPay-Event-Id`; `N8N_TIMEOUT_MS` (20000); **modo async (202→`chat.send`)**; **fallback assistido** em timeout/5xx/inválido (cliente nunca vê erro); validação de `action`; URL `tenant_chat_config.n8n_chat_flow_url`→env→disabled; latency/execution_id em `chat_messages`.
- **Papel B** (n8n→nós, `/api/webhooks/n8n`): todas as ações §5.2, HMAC±300s, dedupe por `event_id`, validação sessão/tenant, `payment.create` idempotente por `(session_id, offer_id)`, `already_charged`→`payment.status`, `debt_not_acknowledged` 409, `offer.propose` fora da matriz 422, nunca declara pago (D6).
- **Observabilidade:** painel de sessão mostra `n8n_execution_id`/latência/fallback por turno. Probe `scripts/ops/n8n-probe.ts`. Docs `docs/N8N_TEAM_INTEGRATION_GUIDE.md`.
- **PENDENTE (Fabio/n8n):** configurar o fluxo (Webhook Basic Auth + nó HMAC do Apêndice B + ping + roteamento por `event`), setar envs no Netlify (`N8N_CHAT_FLOW_URL`, `N8N_WEBHOOK_SECRET`, `N8N_BASIC_AUTH_USER/PASSWORD`, `N8N_TIMEOUT_MS`) → **probe → GATE X0** → depois `NEGOTIATION_ENGINE=n8n` (GATE X6). URL/senha = SEGREDO (só env, nunca log/commit).

## 6. Observabilidade / painel

Painel `/super-admin/negociacoes-chat`: **lê `chat_messages`** (corrigido — lia a antiga `conversation_messages` vazia, causa do `Msgs=0`/transcript vazio). Lista **por devedor** (agrupa sessões, expansível). KPIs: devedores em negociação, %auth, conversas ativas (30min), acordos, redirects, reconhecimentos. Transcript com cabeçalho + timeline (msgs+eventos+cliques, `n8n_execution_id` em badge super_admin) + rodapé (acordo/casos); sessão sem mensagem explica em vez de abrir vazia.

## 7. Segurança / branding

- **CPF mascarado** por padrão nas listas super-admin + endpoint `/api/super-admin/reveal-document` (super_admin, loga `document.revealed`); doc em claro fora dos payloads.
- **Branding AlteaPay:** favicon/ícones "A" dourado (`app/icon.{svg,png}`, apple-icon, favicon.ico); **zero refs v0** (package.json `name=alteapay`); metadata/manifest; header sem corte (`min-h-0`).
- CPF não sai ao n8n (mascarado+hash; `payment_origin=platform` travado). Valores em centavos na borda n8n/Voxuy.

## 8. Infra / envs / migrations / deploys

- **Netlify (produção):** `CHAT_JOURNEY_ENABLED=true`, `NEGOTIATION_ENGINE=disabled`, `WHATSAPP_DISPATCH_MODE=mock`, `DISPATCH_MODE=inline`, `EMAIL_SEND_MODE=inline`, `INLINE_DISPATCH_MAX_BATCH=25`, `PUBLIC_AUTH_*`, `CHAT_CAPTCHA_ENABLED=false`. **Netlify CLI instalado+autenticado** (site `alteapay`, id `2b3e9413-19c5-4b62-8234-0068d962d121`).
- **Migrations aplicadas em prod:** `20260922_hub_link_status.sql` (contact_profile, negotiation_state, link único, engine_owner, channel, voxuy_flow_id). `contact_profile` recomputado (3172 com celular). `n8n_chat_flow_url` já existia (20260918).
- **Upstash no teto** → worker Fargate desligado → sem pagamento/envio real (mock/inline).
- Deploys via `netlify api createSiteBuild {clear_cache:true}` (a landing `/n/` cacheia render; clear-cache ou o `noStore` cobrem).

## 9. PENDENTE (não implementado)

1. **Reuso de sessão na origem (A1.1):** `establishSession` sempre cria sessão nova → várias sessões por devedor (hoje só o DISPLAY agrupa). Falta: reaproveitar sessão `open` dentro do TTL + colunas `reopen_count/first_opened_at/previous_session_id/merged_into_session_id` + backfill de consolidação (sem apagar).
2. **Reconstrução de transcripts antigos (A2.4):** as ~20 sessões antigas têm dado em `journey_events`, não em `chat_messages`; reconstruir (ou marcar não-reconstituível).
3. **Ativação Voxuy real (A3):** código pronto; falta credencial (`VOXUY_WEBHOOK_URL`) + `voxuy_flow_id` + telefones E.164 → segue `mock`.
4. **n8n GATE X0/X6** (§5): fluxo n8n + envs + probe (Fabio).
5. Não-bloqueantes: captcha Turnstile (ligar antes de público amplo), paginação server-side já feita, `List-Unsubscribe` no e-mail já feito.

## 10. Referências de código
- Link/auth: `app/(journey)/n/[code]/*`, `lib/journey/{generic-auth,resolver,public-link,acknowledgement,captcha,public-rate-limit}.ts`, `app/api/chat/{auth,messages,button}/route.ts`.
- Engine/n8n: `lib/negotiation/{engine,n8n,assisted}.ts`, `app/api/webhooks/n8n/route.ts`, `lib/journey/chat-turn.ts`.
- Hub/Voxuy: `lib/journey/{campaigns,campaign-send}.ts`, `lib/whatsapp/voxuy/*`, `app/api/super-admin/negotiations/{send-preview,send}/*`, `app/super-admin/negociacoes/*`.
- Painel: `lib/negotiation/{admin-data,chat-debtors,transcript-context}.ts`, `app/super-admin/negociacoes-chat/*`.
- Docs: `docs/{N8N_TEAM_INTEGRATION_GUIDE,N8N_INTEGRATION,CHATBOT_PROD_COMPAT,CHAT_JOURNEY_OPERATIONS,LGPD_CHATBOT,VOXUY_API_INTEGRATION}.md`.
