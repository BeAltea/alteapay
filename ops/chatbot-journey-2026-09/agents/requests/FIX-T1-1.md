## FIX-T1 pede: emitir `channel` (e origem do status) nos eventos para popular a projeção

- **Contexto:** ao corrigir o BLOQUEANTE de domínio fora de ordem (chronology gate em
  `applyEventToState`), avaliei o bônus não-bloqueante: hoje `channel` e
  `provider_status_source` ficam SEMPRE nulos (`channel: null`, `provider_status_source:
  "none"`) na projeção `negotiation_state`. A causa está FORA do meu ownership
  (`lib/journey/negotiation-state.ts`), então NÃO alterei — registro aqui.

- **Por que não dá para resolver só no meu arquivo:**
  1. **O payload não chega à projeção.** `applyJourneyEventToState` é chamado de
     `recordEvent` (ver request `T1-1.md`) SEM `payload`. O `ApplyJourneyEventInput`
     nem repassa `payload` hoje.
  2. **Os eventos `message.*` não carregam `channel`.** Em `lib/journey/campaigns.ts`
     (`recordEvent({ ... type: "message.queued", actor: "system" })`, ~linha 258) o canal
     é conhecido no envio (`e.channel` / `r.channel` ∈ {whatsapp,email}) mas NÃO é
     colocado no `payload` do evento. Sem isso, não há de onde a projeção ler `channel`.
  3. **O rebuild nem lê `payload`.** `rebuildNegotiationState` faz
     `.select("customer_id, event_type, occurred_at, campaign_id, session_id, agreement_id")`
     — precisaria incluir `payload` para o rebuild também preencher `channel`.

- **Mudança proposta (fora do meu ownership):**
  - `lib/journey/campaigns.ts`: incluir `payload: { channel }` nos `recordEvent` de
    `message.queued`/`message.sent`/… com o canal já resolvido (`whatsapp` | `email`).
  - `lib/journey/events.ts`: no gancho de projeção (request T1-1), repassar
    `payload: input.payload ?? null` para `applyJourneyEventToState`.
  - `lib/journey/negotiation-state.ts` (MEU arquivo, faço quando as 2 acima existirem):
    (a) `rebuildNegotiationState` passa a `select(... , payload)` e a repassar `payload`
        no `JourneyEventLike`;
    (b) `applyEventToState` grava `next.channel = payload.channel` (quando presente) e
        `next.provider_status_source` a partir da origem (ex.: `payload.provider` ou
        `event_type`), mantendo tudo order-independent (último por occurred_at ou
        primeira ocorrência, a definir junto com T5 que consome a coluna).

- **Bloqueia?** NÃO. `channel`/`provider_status_source` são colunas informativas; o funil
  (stage/stage_rank/marks/has_live_charge) já está correto sem elas. Quando os eventos
  passarem a carregar `channel` no payload, faço a parte (a)/(b) dentro do meu arquivo em
  um passo trivial.
