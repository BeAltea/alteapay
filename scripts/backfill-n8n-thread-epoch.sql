-- N8N-9 — backfill de thread_epoch das linhas gravadas SEM época depois de um reset de 24h.
--
-- Antes da correção, chat.send do n8n (e o turno livre de chat-turn) gravavam chat_messages sem
-- thread_epoch. Numa sessão que já passou pelo reset (negotiation_sessions.thread_epoch > 0) essas
-- linhas ficam invisíveis na thread corrente (NULL = época 0).
--
-- Regra: uma linha NÃO arquivada, sem época, criada depois do último reset da sessão (o maior
-- archived_at da sessão) pertence à época corrente. Exceção: resposta atrasada — a mesma
-- n8n_execution_id já tem linha arquivada na sessão (a execução começou na thread velha); essas
-- linhas NÃO são tocadas (a correção as recusaria com 409 thread_epoch_stale).
--
-- Idempotente: só toca linhas com thread_epoch IS NULL. Rodar de novo = 0 linhas.
-- NÃO roda sozinho. Rodar no SQL editor do Supabase: primeiro o PREVIEW, depois o bloco UPDATE.
-- Medido em 2026-09-28T00:02Z (leitura): 1 sessão com época > 0; 4 linhas engine='n8n' afetadas.

-- ---------------------------------------------------------------------------
-- PREVIEW (só leitura): linhas que o UPDATE vai carimbar, por tabela/engine/papel.
-- ---------------------------------------------------------------------------
with last_reset as (
  select m.session_id, max(m.archived_at) as reset_at
  from public.chat_messages m
  join public.negotiation_sessions s on s.id = m.session_id and s.thread_epoch > 0
  where m.archived_at is not null
  group by m.session_id
)
select 'chat_messages' as tbl, m.engine, m.role, count(*) as rows_to_stamp
from public.chat_messages m
join public.negotiation_sessions s on s.id = m.session_id and s.thread_epoch > 0
join last_reset r on r.session_id = m.session_id
where m.archived_at is null
  and m.thread_epoch is null
  and m.created_at >= r.reset_at
  and not (
    m.n8n_execution_id is not null and exists (
      select 1 from public.chat_messages o
      where o.session_id = m.session_id
        and o.n8n_execution_id = m.n8n_execution_id
        and o.archived_at is not null
    )
  )
group by m.engine, m.role
union all
select 'chat_prompts', p.created_by, p.status, count(*)
from public.chat_prompts p
join public.negotiation_sessions s on s.id = p.session_id and s.thread_epoch > 0
join last_reset r on r.session_id = p.session_id
where p.archived_at is null
  and p.thread_epoch is null
  and p.created_at >= r.reset_at
group by p.created_by, p.status;

-- ---------------------------------------------------------------------------
-- UPDATE (escrita). Mesmo filtro do preview.
-- ---------------------------------------------------------------------------
begin;

with last_reset as (
  select m.session_id, max(m.archived_at) as reset_at
  from public.chat_messages m
  join public.negotiation_sessions s on s.id = m.session_id and s.thread_epoch > 0
  where m.archived_at is not null
  group by m.session_id
)
update public.chat_messages m
set thread_epoch = s.thread_epoch
from public.negotiation_sessions s, last_reset r
where s.id = m.session_id
  and s.thread_epoch > 0
  and r.session_id = m.session_id
  and m.archived_at is null
  and m.thread_epoch is null
  and m.created_at >= r.reset_at
  and not (
    m.n8n_execution_id is not null and exists (
      select 1 from public.chat_messages o
      where o.session_id = m.session_id
        and o.n8n_execution_id = m.n8n_execution_id
        and o.archived_at is not null
    )
  );

with last_reset as (
  select m.session_id, max(m.archived_at) as reset_at
  from public.chat_messages m
  join public.negotiation_sessions s on s.id = m.session_id and s.thread_epoch > 0
  where m.archived_at is not null
  group by m.session_id
)
update public.chat_prompts p
set thread_epoch = s.thread_epoch
from public.negotiation_sessions s, last_reset r
where s.id = p.session_id
  and s.thread_epoch > 0
  and r.session_id = p.session_id
  and p.archived_at is null
  and p.thread_epoch is null
  and p.created_at >= r.reset_at;

commit;
