# n8n — sonda do papel A + URL por tenant (operacional)

**Data:** 2026-09-21 · **Branch:** `feature/journey-neutral-prelogin`
**Escopo:** ferramental para plugar o fluxo-cérebro n8n (papel A) com segurança.
**Regra de ouro:** nada aqui contém URL/segredo/senha real — só placeholders. A
sonda lê tudo de `process.env`; a migration é aditiva e NÃO se aplica por aqui.

> Guia autossuficiente do fluxo (para o time do n8n): `docs/N8N_TEAM_INTEGRATION_GUIDE.md`.
> Contrato detalhado: `docs/N8N_INTEGRATION.md` · requisitos do fluxo: `docs/N8N_FLOW_REQUIREMENTS.md`.

---

## 1. O que foi entregue

| Artefato | Caminho | Papel |
|---|---|---|
| Sonda de conectividade+segurança | `scripts/ops/n8n-probe.ts` | ping assinado ao `N8N_CHAT_FLOW_URL` (papel A), 4 casos |
| Migration (URL por tenant) | `supabase/migrations/20260923_n8n_tenant_flow_url.sql` | reafirma `tenant_chat_config.n8n_chat_flow_url` (aditiva/idempotente) + comentário |
| Guia do time do n8n | `docs/N8N_TEAM_INTEGRATION_GUIDE.md` | headers reais do papel A, snippets Code, modo async, erros, checklist 14 itens |

## 2. Sonda `scripts/ops/n8n-probe.ts`

Simula o que a plataforma faz em produção (`lib/negotiation/n8n.ts`
→ `buildN8nOutboundHeaders`): assina `${ts}.${body}` em HMAC-SHA256, adiciona
Basic Auth e um `x-alteapay-event-id`, e POSTa `{"action":"ping"}` ao
`N8N_CHAT_FLOW_URL` com `AbortSignal.timeout(20000)`.

Imprime SOMENTE status HTTP + latência + veredito. **Nunca** imprime URL,
segredo, senha nem o header `Authorization`.

| # | Caso | Esperado |
|---|---|---|
| 1 | ok (assinado + Basic Auth) | `200` (`{ok:true}`/`{success:true}`) |
| 2 | assinatura adulterada | recusa (`401`/`403`) |
| 3 | timestamp `-600s` (fora de ±300s) | recusa (`401`/`403`) |
| 4 | sem `Authorization` (Basic Auth omitido) | `401` |

### Rodar

```bash
# defina no ambiente (NUNCA hardcode; NÃO commitar):
export N8N_CHAT_FLOW_URL='<N8N_CHAT_FLOW_URL>'
export N8N_WEBHOOK_SECRET='<N8N_WEBHOOK_SECRET>'
export N8N_BASIC_AUTH_USER='<N8N_BASIC_AUTH_USER>'
export N8N_BASIC_AUTH_PASSWORD='<N8N_BASIC_AUTH_PASSWORD>'

pnpm exec tsx scripts/ops/n8n-probe.ts
```

Exit code `0` = todos os casos no esperado; `1` = há caso fora do esperado ou
env ausente (o motivo é impresso em `console.error`, sem valores).

> A sonda aponta para o fluxo do time (papel A), não para o nosso
> `/api/webhooks/n8n` (papel B). Para exercitar o papel B use o `ping` assinado
> com `openssl` de `docs/N8N_INTEGRATION.md` §9.

## 3. Migration — URL por tenant

`supabase/migrations/20260923_n8n_tenant_flow_url.sql`:

```sql
alter table public.tenant_chat_config add column if not exists n8n_chat_flow_url text;
comment on column public.tenant_chat_config.n8n_chat_flow_url is '...';
```

- **Aditiva e idempotente.** A coluna já existia (`20260918_chat_n8n_prep.sql`);
  esta migration reafirma e documenta. Segura para reexecutar.
- **Precedência (resolvida no CÓDIGO, `lib/negotiation/engine.ts`
  → `resolveChatFlowUrl`):** `tenant_chat_config.n8n_chat_flow_url` → env
  `N8N_CHAT_FLOW_URL` → vazio (engine degrada para o **assistido**, sem erro).
- **NÃO aplicar em produção por aqui.** O orquestrador aplica com backup no gate.
  Quando preenchida, a coluna é um **segredo operacional** (URL-credencial) —
  nunca logar/expor.

Para plugar um tenant específico (ex.: VMAX), depois do fluxo publicado:

```sql
-- executado pelo orquestrador/Fabio, fora deste repo:
update public.tenant_chat_config
set n8n_chat_flow_url = '<N8N_CHAT_FLOW_URL do tenant>'
where company_id = '<COMPANY_ID>';
```

Sem valor por tenant, o engine cai na env global `N8N_CHAT_FLOW_URL`.

## 4. Como plugar (ordem)

1. Time do n8n publica o Webhook trigger com **Basic Auth** + **Raw Body ON** e
   os dois nós Code (validar/gerar HMAC — `docs/N8N_TEAM_INTEGRATION_GUIDE.md` §3).
2. Setar as envs (`N8N_CHAT_FLOW_URL`, `N8N_WEBHOOK_SECRET`,
   `N8N_BASIC_AUTH_USER`, `N8N_BASIC_AUTH_PASSWORD`) no ambiente de execução.
3. Rodar a **sonda** (§2) — os 4 casos devem bater.
4. `NEGOTIATION_ENGINE=n8n`. Sem `N8N_CHAT_FLOW_URL` (global nem por tenant) o
   engine degrada para o assistido — o cliente nunca vê erro.
5. Percorrer o **checklist de 14 itens** (`docs/N8N_TEAM_INTEGRATION_GUIDE.md` §12).

## 5. Segurança (inegociável)

- Nunca commitar URL/segredo/senha; use os placeholders acima.
- A sonda e os docs redigem/omitem qualquer credencial.
- O servidor decide desconto/parcela/validade (matriz) e é o único que gera
  cobrança (guard de idempotência). O fluxo/LLM só conversa e sinaliza intenção.
