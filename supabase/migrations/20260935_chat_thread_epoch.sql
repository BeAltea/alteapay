-- Onda "ciclo de negociação" — trilha D2 (C3 PRESERVANDO / Decisão G3 D.3). Fim do
-- DELETE físico do reset de 24h: a thread atual é ENCERRADA e outra é aberta,
-- PRESERVANDO as linhas antigas (arquivadas), de modo que auditoria e itens C8
-- (link, escolha, "já paguei", reconhecimento) permaneçam consultáveis.
--
-- Como funciona (ver lib/journey/acknowledgement.ts:resetStaleChatIfInactive):
--   - reset 24h = negotiation_sessions.thread_epoch + 1 (NÃO delete);
--   - as linhas da época anterior recebem archived_at=now() (UPDATE, não DELETE) e
--     os prompts 'active' viram 'superseded';
--   - as inserts novas gravam thread_epoch = época corrente;
--   - GET /api/chat/messages filtra a época corrente (ou thread_epoch IS NULL =
--     época 0, compat) e archived_at IS NULL → a tela nova começa limpa, mas o
--     banco preserva tudo. Painel/recap/reconstrução (R-42) leem TODAS as épocas.
--
-- journey_events INTACTO (C2/R-09): esta migration NÃO o toca. Nenhuma linha
-- existente é alterada (thread_epoch default 0 = comportamento atual; as colunas
-- novas nascem NULL = época 0/não-arquivada).
--
-- 100% ADITIVA e IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + índices IF NOT EXISTS.
-- Próximo número livre da série: 20260935.
--
-- NÃO aplicar em produção por este arquivo: o orquestrador aplica com backup no
-- gate correspondente. Todas as flags seguem OFF até lá.

-- ============================================================
-- 1. negotiation_sessions.thread_epoch — época (thread) corrente da sessão.
--    int monotônico; default 0 = comportamento de hoje (uma única thread).
--    Incrementado pelo reset 24h para encerrar a thread atual e abrir outra.
-- ============================================================
alter table public.negotiation_sessions
  add column if not exists thread_epoch int not null default 0;

comment on column public.negotiation_sessions.thread_epoch is
  'Época (thread) corrente do chat de negociação (trilha D2, C3). int monotônico, '
  'default 0. O reset de 24h faz thread_epoch+1 (NÃO delete) para encerrar a thread '
  'atual e abrir outra; as linhas da época anterior são arquivadas (archived_at). O '
  'render filtra a época corrente; auditoria/painel/recap leem todas as épocas.';

-- ============================================================
-- 2. chat_messages — carimbo de época + arquivamento (nunca DELETE).
--    thread_epoch nullable (NULL = época 0, compat com linhas legadas);
--    archived_at nullable (NULL = linha viva; setado no encerramento da thread).
-- ============================================================
alter table public.chat_messages
  add column if not exists thread_epoch int;
alter table public.chat_messages
  add column if not exists archived_at timestamptz;

comment on column public.chat_messages.thread_epoch is
  'Época (thread) em que a mensagem foi gravada (trilha D2, C3). NULL = época 0 '
  '(compat). O GET /api/chat/messages filtra a época corrente da sessão.';
comment on column public.chat_messages.archived_at is
  'Instante em que a mensagem foi arquivada pelo reset de 24h (encerramento da '
  'thread). NULL = viva. UPDATE (nunca DELETE): auditoria e itens C8 preservados.';

-- ============================================================
-- 3. chat_prompts — carimbo de época + arquivamento (nunca DELETE).
-- ============================================================
alter table public.chat_prompts
  add column if not exists thread_epoch int;
alter table public.chat_prompts
  add column if not exists archived_at timestamptz;

comment on column public.chat_prompts.thread_epoch is
  'Época (thread) em que o prompt foi criado (trilha D2, C3). NULL = época 0 (compat).';
comment on column public.chat_prompts.archived_at is
  'Instante em que o prompt foi arquivado pelo reset de 24h (thread encerrada). O '
  'reset também marca status=superseded. NULL = vivo. UPDATE, nunca DELETE.';

-- ============================================================
-- 4. Índices parciais para o filtro barato (session_id, thread_epoch) do render.
-- ============================================================
create index if not exists idx_chat_messages_session_epoch
  on public.chat_messages (session_id, thread_epoch);
create index if not exists idx_chat_prompts_session_epoch
  on public.chat_prompts (session_id, thread_epoch);
