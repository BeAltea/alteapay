# Chatbot de Negociação — Porte para a Base de Produção

**Branch:** `feature/chatbot-negotiation` (NÃO mergeada — main intocado)
**Origem:** `alteapay-v2` branch `feature/chatbot-n8n-webhook` (chatbot W0–W8 + webhook n8n)
**Data:** 2026-08-27

Este documento registra o que foi portado, o que muda em produção e o checklist
de go-live. Guias funcionais: `docs/LGPD_CHATBOT.md` e `docs/N8N_INTEGRATION.md`.

---

## 1. O que foi portado (69 arquivos)

| Área | Conteúdo |
|---|---|
| Domínio | `lib/negotiation/*` (sessões, crypto, PII, rate-limit, regras de desconto, cliente do agente, fluxo WhatsApp, n8n) |
| Rotas | `app/api/negotiation/*` (handoff, resolve, consent, message, redirect, status, transcript, health, dev), `app/api/webhooks/whatsapp`, `app/api/webhooks/n8n`, `app/api/agents/close-agreement` |
| Frontend | `/negociar/[token]`, `/negociar/embed/[token]` (white-label), telas de gestão (dashboard + super-admin), demo prefeitura, widget (`public/widget/`) |
| Filas | `alteapay-whatsapp` e `alteapay-n8n` (config, queues, workers, start-workers) |
| Fix | `charge.worker.ts`: write-back de `asaas_*` no agreement quando `externalReference` é um agreement (fluxo chatbot) — antes os links nunca chegavam à UI do chat |
| Middleware | rotas públicas `/negociar`, CSP `frame-ancestors` por tenant no embed, X-Frame-Options |
| Banco | `supabase/migrations/20260702_create_negotiation_chat_tables.sql` + `20260827_n8n_channel.sql` (**NÃO aplicadas em produção** — ver §3) |
| Testes | `tests/negotiation/*` + vitest (`pnpm test` → 24 verdes) |
| LGPD | `scripts/anonymize-session.ts`, `scripts/retention-cleanup.ts` |

Adaptações feitas no porte: preservadas as páginas legais públicas do prod no
middleware; write-back do charge worker aplicado sem os mock-gates da v2
(produção chama ASAAS real); `package.json` ganhou `vitest`, `pg`/`@types/pg`
e scripts de teste.

Validação nesta branch: `pnpm test` 24/24; `tsc --noEmit` sem NENHUM erro novo
(os 201 existentes são legados, idênticos ao main); `next build` verde.
O schema alvo é compatível por construção: o chatbot foi desenvolvido e testado
E2E sobre um clone do banco de produção (dump seed da v2).

## 2. Diferenças de runtime vs ambiente local da v2

| Aspecto | Local (v2/K8s) | Produção (este repo) |
|---|---|---|
| Integrações | mockadas (`MOCK_ALL_INTEGRATIONS=1`) | **REAIS** — fechar acordo via chatbot cria cobrança ASAAS de verdade |
| LLM do agente | Ollama local (~100s/turno) | Anthropic API (segundos/turno) |
| Funções | K8s, sem limite | **Netlify: timeout de função 10–26s** |
| Workers | pods K8s | Fargate (rebuild necessário — novos workers) |
| Agente | Service no cluster | precisa de hosting próprio (ver §3) |

**Consequência do timeout do Netlify:** `POST /api/negotiation/message` e o modo
`sync` do webhook n8n só são viáveis se o turno do agente couber no limite da
função (LLM cloud: ok em geral; se estourar, usar o modo **async** do webhook
n8n — o turno roda no worker Fargate e volta por callback assinado; para o chat
web, considerar migrar o turno para fila em fase 2).

## 3. Checklist de go-live (nada disso foi executado)

1. **Hospedar o agente de negociação** (`alteapay-agents/agents/negotiation`,
   FastAPI/LangGraph) — ex.: Fargate — com `ANTHROPIC_API_KEY`,
   `LLM_PROVIDER=anthropic`, Postgres para checkpoints, `TRAINING_MODE=0`.
   Apontar `NEGOTIATION_AGENT_URL` (Netlify) para ele, com
   `APP_SHARED_TOKEN`/`AGENT_APP_TOKEN` idênticos dos dois lados e
   `REQUIRE_APP_TOKEN=1` no agente.
2. **Aplicar as 2 migrations** no Supabase de produção (SQL editor) e semear
   `tenant_chat_config` por tenant (modo A/B/C, allowed_origins, branding).
3. **Configurar envs no Netlify** (seção nova do `.env.example`): sobretudo
   `N8N_WEBHOOK_SECRET` (openssl rand -hex 32), `NEGOTIATION_JWT_SECRET`,
   `NEGOTIATION_AGENT_URL`, tokens do agente. `WHATSAPP_CHANNEL_ENABLED=0`.
4. **Rebuildar e redeployar os workers Fargate** (imagem passa a incluir
   whatsapp+n8n workers e o fix do charge write-back).
5. **Identidade real (bloqueante para go-live do canal WhatsApp):** o fluxo
   WhatsApp e o gate do agente validam data de nascimento **sintética**
   (artefato do treino local — `syntheticDob`). Produção exige fonte real de
   DOB (ou outro segundo fator) antes de ativar o canal. O chat web via
   `/negociar/<token>` e o n8n com `identity_verified` controlado pelo fluxo
   não dependem disso.
6. Validador do agente: fechar o follow-up "URLs inventadas em modo A" antes
   de expor o modo A a devedores reais (registrado no diagnóstico da v2).
7. Smoke test com tenant piloto em modo B (redirect-only — não emite cobrança).

## 4. O que NÃO muda

Nenhuma rota, action, worker ou tela existente foi alterada além dos três
pontos cirúrgicos: middleware (rotas novas), sidebars (2 itens de menu) e o
write-back aditivo no charge worker (só age quando `externalReference` é UUID
de agreement — cobranças legadas usam outros formatos e passam intocadas).
