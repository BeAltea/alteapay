# Fase 0 — Diagnóstico (Template de cobrança VMAX com dados do débito)

**Data da leitura:** 2026-09-22 · **Read-only** (nenhuma escrita) · **Gate:** G0 (Fabio revisa antes de qualquer código)

Responde aos 15 itens do §3 do prompt. Onde a base diverge do documento, **a base manda** — divergências no fim.

---

## 3.1 — Código

1. **Variáveis (`lib/email/templates/variables.ts:10-18`).** `ALLOWED_VARIABLES = [primeiro_nome, credor, marca, link_negociacao, link_descadastro, contato_suporte, ano]`. Proibição em `validateVariables()` (`variables.ts:84-113`) via `FORBIDDEN_VARIABLE_HINTS` (regex para `valor|divida|debito|saldo`, `fatura|parcela|boleto`, `vencimento|due_date`, `cpf|cnpj|documento`, `contrato`). Aplicada **na gravação** (`validate.ts:62`) **e na renderização** (`resolve-default.ts:231-236` `firstForbiddenVariable`). Erro cita a variável e explica que dados do débito só existem no chat.

2. **Sanitizador (`lib/email/templates/sanitize.ts`) — BLOQUEIO PARCIAL (G0).**
   - `ALLOWED_TAGS`: html, head, body, **table, tr, td**, div, p, span, a, img, strong, em, ul, ol, li, br, hr, h1-h4. **`<tbody>` NÃO está** → removido.
   - `ALLOWED_ATTRS`: href, src, alt, width, height, **style**, align, bgcolor, target, rel. **`cellpadding`, `cellspacing`, `role`, `valign` NÃO estão** → removidos.
   - **Veredito:** `style` inline **PRESERVADO** (bom — o crítico do §3.1.2 está ok); `<table>/<tr>/<td>`, `align`, `bgcolor`, `width` **PRESERVADOS**; **`cellpadding`, `cellspacing`, `role="presentation"`, `<tbody>` REMOVIDOS**. → **Bloqueio de Fase 0 (menor):** o template precisa (a) do sanitizador estendido para aceitar esses atributos de layout de e-mail, OU (b) ser escrito só com `style` inline (padding/border-spacing) e sem `role`. Ver decisão G0.

3. **Contexto de render (`campaign-send.ts:runHubSend` 503-665, `email-dispatch.ts`).** Hoje `buildTemplateVars()` (`campaign-send.ts:372-383`) injeta **só as 7 básicas** — nenhum dado de débito. O loop **tem acesso a `debts`** (usado na elegibilidade, `campaigns.ts`), mas o contexto de e-mail carrega só `customers.name`. `dispatchRenderedEmail()`/`dispatchEmailInvite()` (`email-dispatch.ts`) recebem subject/html/text prontos. → T1 precisa montar o contexto de débito por devedor e injetá-lo.

4. **Fonte do C4 (`lib/journey/acknowledgement.ts:48-101`).** Função **`buildAckContext({companyId, customerId, debtIds}): Promise<AckContext>`**, exportada e **reutilizável** (sem request). Retorna `{firstName, creditorName, updatedValue, invoiceCount, oldestDueDate}`. `updatedValue = Σ debts.amount` (dívidas abertas); `oldestDueDate = min(vmax_invoices.vencimento)` com fallback `min(debts.due_date)`; `invoiceCount = count(vmax_invoices)` fallback nº de dívidas abertas. **É a função que o C4 manda reutilizar** para valor e vencimento (paridade com o chat).

5. **`resolveByDocument` (`resolver.ts:118-225`).** União `open|settled|none`; lê `debts (id,status,amount,due_date,updated_at)`, `OPEN_DEBT_STATUSES=['pending','in_negotiation']`. Reutilizável para leitura, mas é a porta de auth — **não reimplementar**: usar `buildAckContext` para os números.

6. **Máscara (`lib/journey/document.ts:42-47`) — `maskDocument(raw)`.** CPF (11) → **`***.456.789-**`**; CNPJ (14) → **`**.456.789/****-**`**; inválido → `***`. Mesmo helper das listas super-admin (`components/super-admin/revealable-document.tsx`).

7. **UI de template (`components/super-admin/emails/template-editor.tsx:72-79`).** Campos: name, scope, companyId, purpose, subject, preheader, html, textFallback. **NÃO existe** controle "permitir dados do débito" → T2 adiciona o checkbox (liga a `allow_debt_fields`).

8. **Link do chat (`campaign-send.ts:263-267`) — `publicLink(code)` → `${NEXT_PUBLIC_APP_URL}/n/${code}`.** `code = tenant_chat_config.public_link_code`. Injetado em `{{link_negociacao}}`/`{{link_descadastro}}`. VMAX `public_link_code = k7Qm3Xb9Rt`.

9. **Marca.** AlteaPay: `app/globals.css` `--primary: oklch(0.78 0.15 85)` (dourado ~`#C4A747`), foreground navy. `tenant_chat_config.branding` (JSONB) = `{brand_name, creditor_name, support_email, slug}` (textual). **ZERO token de marca da VMAX** (nenhuma cor/logo) no código/base. → e-mail sai na casca AlteaPay com a VMAX **identificada em texto**.

---

## 3.2 — Base (SELECT, leitura 2026-09-22)

10. **VMAX (`companies`):** `id=1f7729ee-a537-43fc-a27f-5747c177988d`, `name="VMAX"`, **`cnpj="07685452000101"`** (→ `07.685.452/0001-01`), `email=solange@vmax.com`, `phone=(11) 4894-8000`. **Coluna de CNPJ existe** (`companies.cnpj`). "VMAX" é o `name` (provável fantasia; razão social formal não há campo separado → pergunta D2).

11. **`contact_profile` (hoje):** both **3041** · mobile **131** · email_only **23** · none **1** (total 3196). Bate com o status.

12. **Público real (com e-mail) — FUNNEL:** com e-mail (email_only+both) **3064** → +nome plausível **3064** → +valor aberto>0 **2997** → +vencimento **2997** → +documento válido → **PÚBLICO REAL = 2997**. (67 com e-mail têm 0 dívida aberta; caem fora por `valor`.)

13. **Nº de dívidas abertas por devedor (com e-mail):** 0→67 · **1→2992** · 2→5 · (nenhum 3+). Ou seja, quase todos têm **1** dívida aberta; o texto "N faturas" do C5 só se aplica a ~5 devedores. **Nota:** `vmax_invoices` por doc varia (0/1/2) e nem sempre casa com o nº de dívidas — ver divergência (b).

14. **Amostra de 10 (insumo do V1) — REDIGIDA no git (§10, PII fora do repositório).** A amostra de 10 devedores reais (documento mascarado + 1º nome + valor aberto + vencimento original + nº de faturas) foi levantada e **revisada pelo validador V1** na conferência linha-a-linha contra a base e na paridade com o chat (todos os 10 OK após o fix). Os valores/nomes por devedor **não são persistidos em git** (regenéveis por SELECT read-only quando necessário). Características observadas na amostra: valores entre ~R$ 99 e ~R$ 400; vencimentos originais de jan/2025 a abr/2026 (todos passados); `vmax_invoices` por doc varia 0–2 enquanto as dívidas abertas são ~sempre 1 (ver divergência (b)).

15. **Templates:** existe **1 template GLOBAL** ("Negociação — Convite (padrão)", `purpose=negotiation`, `active`). **Não há template da VMAX** e **não há default da VMAX** (`email_template_defaults` VMAX = 0) → hoje a VMAX cai no global (F4). O novo template vira o default da VMAX (C10).

---

## Divergências / achados (a base manda)

- **(a) Sanitizador não aceita `cellpadding/cellspacing/role/tbody`** (§3.1.2). Decisão G0 abaixo.
- **(b) `qtd_faturas` inconsistente entre fontes:** o valor soma `debts.amount` (quase sempre 1 dívida), mas `buildAckContext.invoiceCount` usa `vmax_invoices` (0/1/2, e 0 para muitos). Como o **C4 exige paridade com o chat**, o e-mail deve reusar `buildAckContext` **como está** (mesmo valor/venc/qtd que o chat mostra). O texto "N faturas" (C5) sai de `buildAckContext.invoiceCount`. **A confirmar** se o chat hoje mostra `invoiceCount` de `vmax_invoices` ou de dívidas (paridade tem que valer para o que estiver no ar).
- **(c) `allow_debt_fields` não existe** em `email_templates` → migration aditiva `20260929`.
- **(d) Vencimentos são datas passadas** (abr/2026 e antes; hoje 22/09/2026) — coerente com "vencimento original em aberto".
- **(e) Sem `NOT NULL`/DROP** necessário; tudo aditivo.

---

## Decisões que o G0 precisa (Fabio)

1. **Sanitizador (bloqueio a):** estender o sanitizador para aceitar `cellpadding`, `cellspacing`, `role`, `valign`, `<tbody>` (atributos/tag benignos de layout de e-mail), OU escrever o template só com `style` inline sem `role`? (Recomendo estender — é o padrão de e-mail table-based e mais acessível.)
2. **Marca VMAX:** confirmar que o e-mail sai na **casca AlteaPay com a VMAX em texto** ("cobrança oficial em nome da VMAX"), já que não há cor/logo VMAX no código.
3. **Apêndice D (podem esperar até G4/G5, mas registrados):** razão social vs fantasia "VMAX" (D2 — CNPJ `07.685.452/0001-01` confirmado); remetente `from` (D3 — hoje `cobranca@alteapay.com`); reply-to (D4); confirmar máscara `***.456.789-**` (D5); múltiplas dívidas = total+contagem (D6 — ~5 casos); corte do piloto dentro dos **2997** (D7); copy do Apêndice A (D8).

**Público-alvo real do template: 2997 devedores VMAX com e-mail e dívida aberta.**
