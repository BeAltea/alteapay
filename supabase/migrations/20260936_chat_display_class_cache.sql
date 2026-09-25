-- Onda "ciclo de negociação" — trilha D2 (§10.1 / C4 CLASSES DE EXIBIÇÃO). Cache
-- OPCIONAL da classe de exibição de cada mensagem, para telemetria/painel.
--
-- NÃO É AUTORIDADE: a classe é DERIVADA por lib/journey/display-class.ts
-- (classifyMessage), a partir de sinais que a linha já carrega (role, button_id,
-- engine, offers_snapshot, prompt_id). Esta coluna é só um cache best-effort
-- preenchido na escrita nova; NULL cai na função (zero backfill do histórico VMAX,
-- que é classificado de graça pela derivação). A poda §10.1 é de APRESENTAÇÃO (C2)
-- e roda no client (chat-display.ts) — nunca lê esta coluna como verdade.
--
-- DISPENSÁVEL: se D2 concluir que o cache não agrega (a derivação basta), a coluna
-- pode nem ser preenchida — o comportamento é idêntico. Deixada aqui por
-- completude do design (telemetria do painel de atendimento).
--
-- journey_events INTACTO (C2/R-09). 100% ADITIVA/IDEMPOTENTE: ADD COLUMN IF NOT
-- EXISTS; CHECK criado só se ausente. Sem backfill, sem remoção/rename.
-- Próximo número livre da série: 20260936.
--
-- NÃO aplicar em produção por este arquivo: o orquestrador aplica com backup no
-- gate correspondente. Todas as flags seguem OFF até lá.

alter table public.chat_messages
  add column if not exists display_class text;

do $$
begin
  -- CHECK do domínio das 7 classes (§10.1). Idempotente: só cria se ausente.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_display_class_check'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_display_class_check
      check (
        display_class is null or display_class in (
          'pinned',
          'decision',
          'outcome',
          'guidance',
          'ephemeral',
          'superseded',
          'system'
        )
      );
  end if;
end $$;

comment on column public.chat_messages.display_class is
  'Cache OPCIONAL da classe de exibição (§10.1, trilha D2). NÃO é autoridade: a '
  'classe é derivada por lib/journey/display-class.ts; NULL cai na função. '
  'Best-effort na escrita nova, telemetria do painel. A poda de apresentação (C2) '
  'roda no client e nunca lê esta coluna como verdade.';
