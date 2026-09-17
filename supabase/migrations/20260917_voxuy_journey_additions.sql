-- Voxuy — ajustes ADITIVOS de modelo de dados (fase V3 do PROMPT_VOXUY_2026-09-17).
-- 100% aditiva: só ALTER ... ADD COLUMN / CREATE INDEX / ajuste de CHECK.
-- NÃO aplicar em produção nesta onda (produção intocada; WHATSAPP_PROVIDER=mock).
-- Convenções do repo (idênticas a 20260916_chat_journey_core.sql).

-- ============================================================
-- 1. whatsapp_messages: status honesto (V7) + rastreio do provider (V3)
-- ============================================================
-- 'accepted' = aceito pela Voxuy para AGENDAMENTO (200), NÃO entregue ao cliente.
-- Recria o CHECK incluindo 'accepted'. delivered/read continuam válidos, mas só
-- são preenchidos quando houver fonte real (provider_status_source != 'none').
alter table public.whatsapp_messages
  drop constraint if exists whatsapp_messages_status_check;
alter table public.whatsapp_messages
  add constraint whatsapp_messages_status_check
  check (status in ('queued','accepted','sent','delivered','read','failed','suppressed'));

-- o `id` que enviamos à Voxuy (whatsapp_messages.id em texto) para cruzar com o
-- relatório da conta; procedência do status; traceId de erro 400; carimbo do stop.
alter table public.whatsapp_messages
  add column if not exists provider_transaction_id text;
alter table public.whatsapp_messages
  add column if not exists provider_status_source text not null default 'none'
    check (provider_status_source in ('none','voxuy_webhook','manual'));
alter table public.whatsapp_messages
  add column if not exists provider_trace_id text;
alter table public.whatsapp_messages
  add column if not exists stop_signal_sent_at timestamptz;
alter table public.whatsapp_messages
  add column if not exists accepted_at timestamptz;

-- Índice p/ cooldown e dedupe POR TELEFONE (V10).
create index if not exists idx_wa_messages_company_phone_created
  on public.whatsapp_messages (company_id, phone_e164, created_at desc);

-- ============================================================
-- 2. chat_access_tokens: tokens de AÇÃO (V4)
-- ============================================================
-- purpose distingue o link de consulta dos tokens de opt-out/bloqueio.
-- consumed_at marca uso único das ações destrutivas (opt-out/bloqueio).
alter table public.chat_access_tokens
  add column if not exists purpose text not null default 'consult'
    check (purpose in ('consult','optout','block'));
alter table public.chat_access_tokens
  add column if not exists consumed_at timestamptz;

-- ============================================================
-- 3. tenant_chat_config: eventos Voxuy por finalidade (V1/V4)
-- ============================================================
-- voxuy_plan_id e whatsapp_provider já existem (20260916). Aqui adicionamos
-- voxuy_events (approach/stop/receipt). voxuy_custom_event (texto legado) fica
-- como está; voxuy_events (jsonb) é a fonte nova e tipada.
alter table public.tenant_chat_config
  add column if not exists voxuy_events jsonb not null default '{}'::jsonb;

-- ============================================================
-- 4. whatsapp_campaigns.counts: 'accepted' entra; delivered/read NÃO são
--    prometidos (ficam 0 quando não há fonte). Nada de schema a mudar
--    (counts é jsonb livre); documentado aqui para o painel (V6):
--    counts = { eligible, queued, accepted, clicked, suppressed, failed }.
-- ============================================================
-- (sem DDL: counts é jsonb; a semântica é aplicada no código)
