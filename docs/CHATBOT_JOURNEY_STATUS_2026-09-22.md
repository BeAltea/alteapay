# Chatbot / Jornada de Negociação — Status de Implementação

**Data:** 2026-09-22 (atualizado com a onda F1–F4 + fixes, deployada) · **Branch:** `feature/journey-neutral-prelogin` (mergeada em `main` via PRs #73–#84)
**Produção:** `https://alteapay.com` (Netlify + Supabase `hpjzlmurljxzwjtwcbkz` sa-east-1 + Upstash/BullMQ + Fargate)
**Estado dos testes:** **590 verdes** · typecheck baseline (202 pré-existentes, zero novos) · build/deploy verdes · último deploy `391c085` (código) + `4f8d66d` (hotfix migration).

> Substitui `CHATBOT_JOURNEY_STATUS_2026-09-21.md`. Este documento reflete o que está **no ar hoje**, o que está **pronto mas gated**, e o que **falta**.
>
> **Novidades desta atualização (deployadas 2026-09-22):** seleção de **canal** no envio (WhatsApp+e-mail — §4), **filtro por perfil de contato** (§4a), **Gerenciamento de E-mails** com templates (§4b), **template padrão por cedente** (§4c), **reuso de sessão** agora funcionando (§2), **idempotência de campanha** e correções de segurança (§7). Detalhe operacional: `/api/chat/auth` **exige `consent:true`** no payload.

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
- **Payload do auth:** `POST /api/chat/auth` **exige `consent:true`** (além de `code` + `document`). Sem consent → `reason:"invalid"` (`generic-auth.ts:427`). O frontend real envia; testes por curl precisam incluí-lo.
- **Reuso de sessão (A1.1) — AGORA FUNCIONA:** o mesmo devedor que reentra no link dentro do TTL **reabre a MESMA sessão** (`findReusableOpenSession` → `reopenSession`, `reopen_count`++) em vez de multiplicar registros. Colunas `reopen_count/first_opened_at/previous_session_id/merged_into_session_id` (migration `20260924`) + backfill de consolidação aplicados. **Fix crítico:** o INSERT de `createHandoffSession` passou a gravar `last_activity_at` (antes NULL → o reuso nunca achava a sessão) e o UPDATE de enriquecimento deixou de engolir erro. Ver §8 (incidente do CHECK `channel`).

## 3. Dívida paga (settled)

Cliente cuja dívida está `paid` entra no chat e vê a mensagem de quitação (data de `agreements.payment_received_at` → `asaas_payment_date` → `debts.updated_at`) + o botão de contato. `resolveByDocument` distingue `settled` de `none` (só `none` mantém a resposta uniforme). Exposição consistente com a de dívida aberta (auth CPF-only, só o próprio débito).

## 4. Hub "Enviar Negociação" — SELEÇÃO DE CANAL (F1) via Voxuy (mock) + e-mail (SendGrid real)

Página `/super-admin/negociacoes`: seleção 1/N → `send-preview` → diálogo → `send`. **Não cria cobrança** (caminho antigo `charge_email` preservado).

- **Multi-canal (F1):** o diálogo mostra **dois checkboxes — `[x] WhatsApp (Voxuy)` + `[x] E-mail (SendGrid)`** (ambos ON por padrão; decisão E2 do Fabio = **"ambos os canais"**), mais `[ ] Não duplicar (prioriza WhatsApp para quem tem os dois)`. Cada devedor recebe por **TODOS** os canais que possuir (celular→WhatsApp, e-mail→e-mail, ambos→os dois). Com "não duplicar", quem tem os dois vai só por WhatsApp (e-mail = `priorizado_whatsapp`). Com um canal só, quem não tem aquele contato → exclusão **`sem_contato_para_o_canal`** (nunca troca silenciosa).
- **Preview/envio por canal:** `send-preview` devolve elegíveis/excluídos **por canal** + o **cruzamento** (quantos pelos dois). `send` dispara **por canal em sequências INDEPENDENTES** (try/catch por canal — falha no e-mail não derruba o WhatsApp). Resultado por `(devedor, canal)`.
- **WhatsApp** = `VoxuyApiProvider` dialeto `enterprise_v1` — hoje **`mock`** (nada enviado). **E-mail** = `dispatchEmailInvite`/`dispatchRenderedEmail` (SendGrid, **`EMAIL_SEND_MODE=inline` = REAL em produção**), com `List-Unsubscribe`.
- **Idempotência por canal (E4):** 1 `whatsapp_messages` por `(campaign_id, customer_id, channel)` — `UNIQUE(campaign_id, customer_id, channel)` (migration `20260926`, era `(campaign_id, customer_id)`).
- **Idempotência de campanha (A1):** o diálogo gera **1 chave por abertura** (`idempotencyKey`); double-click/retry reusam a **MESMA campanha** (fast-path + `UNIQUE(company_id, idempotency_key)` da migration `20260927` resolvendo a corrida no INSERT). Evita **e-mail real duplicado** no double-click. `INLINE_DISPATCH_MAX_BATCH=25` orienta dividir em lotes acima do teto.

## 4a. Filtro por perfil de contato (F2)

Lista `/super-admin/negociacoes`: grupo **Contato** com 4 opções combináveis — **Só celular** (`mobile`), **Só e-mail** (`email_only`), **Ambos** (`both`), **Sem contato** (`none`) — refletidas na URL (`?contato=mobile,both`). Contagem do cabeçalho e "selecionar todos os filtrados" respeitam o filtro. Usa `customers.contact_profile` + índice `(company_id, contact_profile)`. Distribuição VMAX: **both 3041 · mobile 131 · email_only 23 · none 1**. Ícone discreto por linha indica o perfil.

## 4b. Gerenciamento de E-mails (F3)

Menu "Enviar Email" → **"Gerenciamento de E-mails"** (`/super-admin/emails`) com abas **Comunicações** (envio avulso, intacto) e **Templates**. CRUD + **versionamento** (append-only, restaurar cria nova versão, arquivar ≠ apagar), escopo **global** ou **por cedente**, propósito `negotiation`/`communication`. Editor: assunto, pré-header, HTML com destaque de sintaxe, texto alternativo, **preview em `iframe sandbox` sem scripts**, **enviar teste** (SendGrid **sandbox**). **Allowlist de variáveis** (`primeiro_nome, credor, marca, link_negociacao, link_descadastro, contato_suporte, ano`) — **bloqueia** valor/CPF/CNPJ/vencimento/faturas/contrato na gravação; `negotiation` exige `{{link_negociacao}}`+`{{link_descadastro}}`. **Sanitizador HTML** allowlist (grava E renderiza): remove `<script>/<style>/on*/javascript:/data:` não-imagem, `@import`/`expression()`, força `rel="noopener noreferrer"`. Tabelas `email_templates`, `email_template_versions`, `email_template_defaults` (migration `20260925`, RLS por company_id, escrita só super_admin). API `/api/super-admin/email-templates/*`.

## 4c. Template padrão por cedente (F4)

No envio por e-mail, `resolveNegotiationTemplate(companyId)` escolhe: **padrão do cedente** (`email_template_defaults`, purpose `negotiation`) → **padrão global** → **convite embutido**. Render só com a allowlist de variáveis + **re-sanitização**; se o template perder os links obrigatórios ou referenciar variável proibida, **cai no convite embutido** (com aviso). Grava `email_template_id`/`email_template_version_id` em `whatsapp_messages` quando não-builtin (null no builtin). O diálogo mostra "E-mail usará: <template> (padrão do cedente / global / convite AlteaPay)".

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
- **Validação adversarial da onda F1–F4** (2 agentes read-only tentando quebrar): fixes aplicados — **sanitizador de e-mail** (bloco `<style>` descartado com conteúdo; normalização de URL passou a cobrir DEL `0x7F`), **piso de cooldown ≥1** (evita `cooldownDays=0` desarmar o gate cross-campanha) e **idempotência de campanha** (§4, A1). Allowlist de variáveis impede PII/valor do débito em template. Rotas de template gated a super_admin; `test-send` só em SendGrid sandbox.

## 8. Infra / envs / migrations / deploys

- **Netlify (produção):** `CHAT_JOURNEY_ENABLED=true`, `NEGOTIATION_ENGINE=disabled`, `WHATSAPP_DISPATCH_MODE=mock`, `DISPATCH_MODE=inline`, `EMAIL_SEND_MODE=inline`, `INLINE_DISPATCH_MAX_BATCH=25`, `PUBLIC_AUTH_*`, `CHAT_CAPTCHA_ENABLED=false`. **Netlify CLI instalado+autenticado** (site `alteapay`, id `2b3e9413-19c5-4b62-8234-0068d962d121`).
- **Migrations aplicadas em prod:** `20260918` (last_activity_at, n8n_chat_flow_url), `20260922_hub_link_status` (contact_profile, negotiation_state, link único, engine_owner, channel, voxuy_flow_id), `20260924_session_reuse` (reopen_count/first_opened_at/previous_session_id/merged_into_session_id). **Onda F1–F4 (2026-09-22):** `20260925_email_templates`, `20260926_hub_channel_unique` (UNIQUE por canal), `20260927_campaign_idempotency` (idempotency_key + UNIQUE parcial), **`20260928_session_channel_public_link`** (hotfix do CHECK). Backfills aplicados: consolidação de sessões, reconstrução de `chat_messages`, e `last_activity_at` (11 sessões `open` que estavam NULL).
- **⚠️ Incidente resolvido na validação pós-deploy — CHECK de `channel`:** o CHECK de `negotiation_sessions.channel` só aceitava `web_campaign|web_generic|admin_preview`, mas o link público grava **`web_public_link`**. Isso quebrava o enrichment de sessão **silenciosamente** (as sessões ficavam com `channel`/`debt_ids` NULL). Quando o **reuso** passou a funcionar, `reopenSession` começou a **lançar** nessa violação e o route (defesa D14, `auth/route.ts:76-80`) convertia a exceção em **`no_debt`** → o devedor que **reentrava** recebia "não encontramos dívidas". Corrigido pela migration `20260928` (adiciona `web_public_link` ao CHECK). Pós-fix: 1º acesso grava channel/debt_ids/primary_debt_id/first_opened_at; reentrada reabre a mesma sessão; CPF pago OK. **Resíduo:** ~40 sessões antigas seguem com `channel/debt_ids` NULL (reopen não faz backfill; não quebra — a resolução fornece o débito no auth).
- **Upstash no teto** → worker Fargate desligado → WhatsApp em mock/inline. **E-mail (SendGrid) roda REAL em produção** (`EMAIL_SEND_MODE=inline`).
- Deploys via `netlify api createSiteBuild {clear_cache:true}` (a landing `/n/` cacheia render; clear-cache ou o `noStore` cobrem).

## 9. PENDENTE (não implementado)

**✅ Concluído nesta onda (antes pendente):** reuso de sessão na origem (A1.1 — §2/§8, funcionando em prod); reconstrução de transcripts antigos (A2.4 — `chat_messages` reconstruídos de `journey_events`).

1. **Ativação Voxuy real (A3):** código pronto; falta credencial (`VOXUY_WEBHOOK_URL`) + `voxuy_flow_id` + telefones E.164 → segue `mock`. (E-mail já é real via SendGrid.)
2. **n8n GATE X0/X6** (§5): fluxo n8n + envs + probe (Fabio).
3. **Backfill opcional:** ~40 sessões antigas com `channel/debt_ids` NULL (§8) — o reopen não faz backfill; não quebra, mas dá para preencher via script se quiser consistência.
4. Não-bloqueantes: captcha Turnstile (ligar antes de público amplo); A3-report (modo `queue` reporta "sent" — inócuo em prod, que roda `inline`); paginação server-side e `List-Unsubscribe` já feitos.

## 10. Referências de código
- Link/auth: `app/(journey)/n/[code]/*`, `lib/journey/{generic-auth,resolver,public-link,acknowledgement,captcha,public-rate-limit}.ts`, `app/api/chat/{auth,messages,button}/route.ts`.
- Engine/n8n: `lib/negotiation/{engine,n8n,assisted}.ts`, `app/api/webhooks/n8n/route.ts`, `lib/journey/chat-turn.ts`.
- Hub/Voxuy/canal (F1): `lib/journey/{campaigns,campaign-send,email-dispatch}.ts`, `lib/whatsapp/voxuy/*`, `app/api/super-admin/negotiations/{send-preview,send}/*`, `components/super-admin/negotiations/{send-dialog,send-contract}.ts(x)`, `app/super-admin/negociacoes/*`.
- Filtro contato (F2): `components/super-admin/negotiations/{filters,query}.ts`.
- E-mails/templates (F3/F4): `app/super-admin/emails/*`, `components/super-admin/emails/*`, `lib/email/templates/{sanitize,variables,validate,preview,repository,resolve-default,types}.ts`, `app/api/super-admin/email-templates/*`.
- Sessão/reuso: `lib/negotiation/sessions.ts` (`createHandoffSession`/`findReusableOpenSession`/`reopenSession`), `lib/journey/generic-auth.ts` (`establishSession`).
- Painel: `lib/negotiation/{admin-data,chat-debtors,transcript-context}.ts`, `app/super-admin/negociacoes-chat/*`.
- Docs: `docs/{N8N_TEAM_INTEGRATION_GUIDE,N8N_INTEGRATION,CHATBOT_PROD_COMPAT,CHAT_JOURNEY_OPERATIONS,LGPD_CHATBOT,VOXUY_API_INTEGRATION}.md`.
