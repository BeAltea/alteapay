# Chatbot / Jornada de Negociação — Status de Implementação

**Data:** 2026-09-21
**Branch desta entrega:** `feature/journey-neutral-prelogin` (commit `0d712f7`) — 232/232 testes verdes, build OK.
**Escopo definido com o Fabio nesta rodada:** link **tokenizado** por pessoa, **URL sem o nome da empresa** (marca só após o login), engine **assistido** (n8n em construção), **sem cobrança real** por ora.

---

## 1. Modelo de acesso escolhido: link tokenizado `/c/{token}`

O Voxuy dispara, por pessoa, um link **opaco**: `https://alteapay.com/c/{token}`.

- **URL não revela o credor** (é um token aleatório) — atende "URL sem nome da empresa". ✅
- **O token é a credencial forte** (não é adivinhável como um CPF) — mais seguro que o link genérico `/t/{slug}/negociar`, que autentica só por CPF.
- Ao abrir: **tela de escolha neutra** → "Consultar atualização" → **confirmação de CPF + consentimento LGPD** → chat.
- **2º fator (data de nascimento) é opcional por tenant** (`tenant_chat_config.auth_require_birth_date`). Fica **OFF** para o VMAX porque `customers.birth_date` não está populado. O token supre o fator forte.

### Mudança entregue nesta rodada (nome do credor só após o login)
Antes, a marca VMAX aparecia **antes** de autenticar (header do layout + tela de escolha). Agora:

| Arquivo | Mudança |
|---|---|
| `app/(journey)/c/[token]/layout.tsx` | Branding condicional: sem cookie de sessão de chat válido (`verifyChatJwt`, `cid == company_id`) → **casca neutra AlteaPay** (sem nome/logo/cor do credor). Com sessão → branding do credor. |
| `components/journey/choice-screen.tsx` | Copy neutra: "o credor e os detalhes só aparecem após a confirmação dos seus dados". |
| `components/journey/action-confirm.tsx` | Opt-out/bloqueio (pré-login) não cita mais o credor. |
| `components/journey/auth-form.tsx` + `consultar/page.tsx` | No sucesso, navegação **hard** (`window.location`) para `/c/{token}/chat`, forçando o layout a re-renderizar no servidor e revelar a marca **só então**. |

---

## 2. O que funciona HOJE (sem n8n, sem worker, sem Upstash)

Com o engine em `disabled` (**modo assistido determinístico**, `lib/negotiation/assisted.ts`), tudo abaixo é **leitura de banco** — não depende de n8n nem do worker Fargate:

1. Abrir o link → tela neutra → "Consultar".
2. **Autenticar** (CPF + consentimento).
3. **Reconhecimento da dívida** (1ª interação, onda R): botões 1=sim / 0=não — já mostra o débito.
4. Menu assistido: "Ver detalhes das faturas", "Ver opções de pagamento" (lista as ofertas da **matriz** — regras do servidor), "Já paguei", "Contestar", "Falar com atendente".

### Dados verificados em produção (2026-09-21, read-only)
- Empresa **VMAX** `1f7729ee-a537-43fc-a27f-5747c177988d`: 3196 `customers`, 3202 `debts` **materializados** (não só na tabela `VMAX`).
- **~977 devedores resolvíveis** (976 dívidas `in_negotiation` + 1 `pending`).
- `resolveByDocument` (`lib/journey/resolver.ts`) resolve por **`customers` + `debts`** (status `pending`/`in_negotiation`). Documento que só existe na tabela `VMAX` (sem `customers`) → **não resolve**.

---

## 3. O que NÃO funciona ainda (dependências externas)

| Item | Estado | Bloqueio |
|---|---|---|
| **Cérebro n8n** (`NEGOTIATION_ENGINE=n8n`) | Plataforma pronta; **fluxo n8n em construção** | O fluxo-cérebro precisa existir/estar hospedado (`N8N_CHAT_FLOW_URL` + `N8N_WEBHOOK_SECRET`). Sem ele, roda no assistido. |
| **Pagamento real** (PIX/boleto) | Wired (variante A) | Depende do **worker Fargate** (fila `chargeQueue`), que está **desligado** + imagem desatualizada, e do **Upstash no teto** (607k/500k req). Decisão atual do Fabio: **sem cobrança real por ora**. |
| **Round-trip do link de pagamento** (AlteaPay cria na ASAAS → n8n → chat) | Wired: `/api/webhooks/n8n` ação `payment.create` → `paymentCreate` → devolve o link (`paymentCreateResponseForN8n`) | Exige engine=n8n (item acima) **e** worker (item acima). |

### Cuidado de dados: cobrança duplicada
A maioria dos ~977 devedores **já tem cobrança ASAAS viva** (988 acordos ativos / 991 overdue). O guard anti-duplicação faz `payment.create` devolver **`already_charged` (409)** nesses casos. Quando o pagamento entrar em escopo: escolher devedores **sem cobrança viva**, ou o fluxo reenviar o link existente via `payment.status`.

---

## 4. Go-live do teste (10 usuários) — o que falta ligar

**Ordem sugerida:**

1. **Deploy do branch** `feature/journey-neutral-prelogin` (merge no `main` → auto-deploy Netlify). *(este código)*
2. **Seed `tenant_chat_config` do VMAX** (idempotente): `journey_public_enabled=true`, `payment_origin='platform'`, `auth_require_birth_date=false`, branding (nome/cores/logo do VMAX **para pós-login**). *(escrita em prod — requer aprovação)*
3. **Envs no Netlify (produção)** — *não há Netlify CLI nesta máquina; feito pelo Fabio no painel:*
   - `CHAT_JOURNEY_ENABLED=true`  ← hoje OFF (é o que faz tudo dar 404)
   - `NEGOTIATION_ENGINE=disabled` (assistido) — manter até o n8n subir
   - `CHAT_CAPTCHA_ENABLED=false` (o widget de captcha ainda é stub; **não ligar**)
   - Conferir que `CHAT_SESSION_SECRET` / `SUPABASE_JWT_SECRET` estão setados (assina o cookie).
   - Redeploy após salvar envs.
4. **Gerar 10 tokens** (`campaign-send`) para 10 devedores VMAX com dívida `in_negotiation` + documento + telefone → URLs `/c/{token}` + telefones para alimentar o Voxuy. *(escrita em prod + PII — requer aprovação)*
5. **Smoke test antes do disparo:** abrir 1 token → confirmar (a) tela pré-login **sem** "VMAX", (b) auth por CPF, (c) reconhecimento + dívida corretos, (d) header vira **VMAX** só depois do login.
6. **Disparo Voxuy** para os 10.

**Fora do escopo deste teste:** gerar PIX/boleto real (worker/Upstash), conversa via n8n.

---

## 5. Postura de segurança / LGPD do teste
- Token opaco = credencial; **nada da dívida antes de autenticar**; resposta de auth **uniforme** + lockout por documento/IP + timing equalizado (~600ms).
- Auditoria append-only de toda tentativa (`chat_auth_attempts`, `journey_events`) com hash de doc/IP (nunca o dado cru).
- Marca do credor exposta **apenas após o login** (esta entrega).
- Documento em claro **não** viaja ao n8n por padrão (mascarado + hash); só com 2 flags — irrelevante enquanto engine=assistido.

---

## 6. Referências de código
- Entrada tokenizada: `app/(journey)/c/[token]/*`
- Auth: `lib/journey/auth.ts` (token) · `app/api/chat/auth/route.ts`
- Resolução devedor/dívida: `lib/journey/resolver.ts`
- Engine: `lib/negotiation/engine.ts` (assisted/stub/agent/n8n) · `lib/negotiation/assisted.ts`
- Pagamento (papel B): `lib/journey/payment-actions.ts` · `app/api/webhooks/n8n/route.ts`
- Config do tenant: tabela `tenant_chat_config`
- Docs correlatas: `CHATBOT_PROD_COMPAT.md`, `CHAT_JOURNEY_OPERATIONS.md`, `N8N_TEAM_INTEGRATION_GUIDE.md`, `N8N_FLOW_REQUIREMENTS.md`
