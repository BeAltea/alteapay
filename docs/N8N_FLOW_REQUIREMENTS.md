# O que o fluxo n8n precisa fazer (contrato do lado do n8n)

**Última atualização:** 2026-09-21 · Complemento de `docs/N8N_INTEGRATION.md`.

> **Contrato v2 (onda R):** ver o guia completo em `docs/N8N_TEAM_INTEGRATION_GUIDE.md`.
> Mudanças que o fluxo DEVE implementar: (1) tratar **valores em centavos** no
> `chat.turn` e nas respostas de `payment.*`; (2) conduzir o **reconhecimento**
> (não pagar antes; tratar `409 debt_not_acknowledged`); (3) usar as ações novas
> `chat.send`/`prompt.ask`/`prompt.close` e o catálogo de botões (`1=Sim`,`0=Não`,
> `2..N`,`98`,`99`); (4) `payment.create` idempotente por `(session_id, offer_id)`;
> (5) `501 not_implemented` = variante B fora do escopo.

Esta onda entrega a plataforma **pronta** para o fluxo n8n ser o cérebro da
conversa, mas o fluxo ainda **não existe**. Este documento é o checklist do que o
fluxo precisa implementar e as perguntas em aberto (Apêndice D do spec) que o
próximo passo (construir o fluxo) tem que responder.

Enquanto o fluxo não existe, use o **engine stub** (`NEGOTIATION_ENGINE=stub`,
fora de produção) ou o endpoint de laboratório `/api/dev/n8n-stub`.

---

## 1. Receber o turno (papel A)

O fluxo é um **Webhook trigger** (n8n) + **Respond to Webhook**. Para cada turno
do chat, a plataforma faz `POST N8N_CHAT_FLOW_URL` com:

- Headers `x-alteapay-timestamp` e `x-alteapay-signature`
  (`sha256=` HMAC-SHA256 de `${timestamp}.${rawBody}` com `N8N_WEBHOOK_SECRET`).
- Body = payload `chat.turn` (ver `docs/N8N_INTEGRATION.md` §11.2).

O fluxo **deve**:

1. **Verificar a assinatura** antes de qualquer coisa (mesma fórmula, janela
   ±300s). Rejeitar 401 se não bater.
2. Ler `session.turn_index`, `session.verified`, `customer.first_name`,
   `debt.*` (centavos), `matrix.*`, `offers[]`.
3. Nunca inventar desconto/parcela fora de `matrix`/`offers` — o servidor valida
   e recusa (422) qualquer termo fora da matriz.
4. Responder o contrato A.2: `reply` (obrigatório) + `action` opcional +
   `n8n_execution_id` (string única por execução) + opcional `close_offer_id`
   (`avista`|`parc_N`, se preferir delegar o fechamento ao servidor).
5. Memória de conversa: o payload traz o estado a cada turno; para memória
   própria, usar `session.id`/`thread_id` como chave (AI Agent Memory node).

## 2. Executar ações de domínio (papel B)

Para efeitos que **mudam dados** (propor/aceitar oferta, criar/registrar
cobrança, contestação, "já paguei", handoff), o fluxo chama
`POST /api/webhooks/n8n` (assinado). Ações e respostas em `docs/N8N_INTEGRATION.md`
§11.3 e §5. Regras que o fluxo precisa respeitar:

- **Origem do pagamento = A (default):** chamar `payment.create` com o `offer_id`
  — a plataforma executa a cobrança e devolve o link (ou `processing`). O fluxo
  **não** cria cobrança no ASAAS.
- Se `payment_origin='n8n'` (variante B, desligada): o fluxo cria a cobrança e
  chama `payment.record` com as URLs — **sem status pago** (D6). Status pago vira
  claim.
- Tratar `409 already_charged` (dívida já com cobrança viva) e `422 <código>`
  (termo fora da matriz) como respostas normais do negócio, não como erro fatal.
- `payment.status` para obter o link quando `payment.create` respondeu
  `processing` (worker gerando a cobrança).

## 3. Fluxos auxiliares que o fluxo precisa cobrir

- Saudação → resumo da dívida (`debt.summary`).
- Listar/gerar ofertas (`offer.list`) e propor contraproposta (`offer.propose`).
- Aceitar (`offer.accept` **ou** `payment.create`).
- Contestação (`dispute.register`), "já paguei" (`payment_claim.register`),
  atendimento humano (`human.transfer`), encerramento (`session.close`).

## 4. Apêndice D — perguntas que o próximo prompt (construir o fluxo) precisa responder

1. **URL do fluxo por tenant:** um fluxo por tenant ou um multiplexado por
   `tenant.id`? Como popular `tenant_chat_config.n8n_chat_flow_url`.
2. **Assinatura de volta:** confirmar que o fluxo assina os callbacks async com o
   MESMO esquema (`${timestamp}.${body}`, `N8N_WEBHOOK_SECRET`).
3. **Formato exato da resposta** ao `chat.turn` (campos extras serão ignorados e
   logados 1x/sessão).
4. **LLM/custo:** qual modelo, custo por turno, limites de rate.
5. **Variante A/B:** confirmar A (plataforma executa) — B fica desligada.
6. **Latência típica/máxima:** para calibrar `N8N_TIMEOUT_MS` (default 20s) e o
   modo assíncrono.
7. **Tratamento de erro:** como o fluxo reage a `409`/`422`/`404` da plataforma.
8. **Memória:** `history_tail` da plataforma vs. estado próprio no n8n.
9. **`n8n_execution_id`:** garantir uma string única por execução (rastreio no
   painel super-admin).
10. **Fluxos auxiliares:** boas-vindas, re-engajamento, follow-up de cobrança
    `processing`.

## 5. Como testar sem o fluxo real

```bash
# Engine stub (in-process), fora de produção:
NEGOTIATION_ENGINE=stub CHAT_JOURNEY_ENABLED=true pnpm dev

# Fluxo n8n FALSO (HTTP), valida a assinatura e responde A.2:
NEGOTIATION_ENGINE=n8n \
N8N_CHAT_FLOW_URL=http://localhost:3000/api/dev/n8n-stub \
N8N_WEBHOOK_SECRET=<secret> \
MOCK_ALL_INTEGRATIONS=1 pnpm dev
```
