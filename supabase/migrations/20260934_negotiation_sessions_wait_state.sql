-- Onda "3 opções" — trilha D2 (ESPERA CONFIÁVEL / §6.3 / M11 / M12). Migration
-- M-4 (aditiva). Duas colunas novas em negotiation_sessions para SOBREVIVER AO
-- RELOAD (M11) e alimentar os ANTEPAROS de resposta tardia (M12).
--
-- Por que colunas novas e não `outcome`: o `outcome` de negotiation_sessions é um
-- enum FECHADO (in_progress|agreement_closed|redirected_official|handoff_human|
-- abandoned|identity_failed|expired) que NÃO comporta o estado de espera do chat
-- ("aguardando_motor" etc.) — ver 01-diagnostico.md item 9. Persistir a espera no
-- outcome poluiria o desfecho de negócio. Colunas dedicadas mantêm as duas coisas
-- separadas.
--
-- M-4a: wait_state — nome do estado DECIDIDO da espera (não o degrau, que é função
--       pura do tempo no client). NULL = 'idle' (sem espera ativa). O CHECK aceita
--       só os estados persistíveis; 'negociando'/'quitada'/'idle' NÃO entram — eles
--       derivam de sinais que já existem (mensagem engine='n8n' no poll; outcome/
--       pagamento conciliado) e não precisam de linha de wait.
--
-- M-4b: wait_started_at — âncora ÚNICA de tempo de que o client deriva TODOS os
--       degraus (1,2/4/10/15s). Setada no clique NEGOCIAR; reabrir aos 8s cai
--       direto no degrau >=4s. NÃO é reescrita entre degraus (o degrau é do
--       relógio, não do servidor) — só quando começa uma nova espera.
--
-- 100% ADITIVA e IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + CHECK criado só se ausente.
-- Nenhuma linha existente é tocada (ambas nascem NULL = 'idle', o comportamento de
-- hoje). Sem índice novo: a leitura da espera é pela PK/sid da sessão, já indexada.
--
-- NÃO aplicar em produção por este arquivo: o orquestrador aplica com backup no
-- gate correspondente (G6). Todas as flags seguem OFF até lá.

-- ============================================================
-- M-4a: coluna wait_state (nullable; NULL = idle).
-- ============================================================
alter table public.negotiation_sessions
  add column if not exists wait_state text;

do $$
begin
  -- CHECK do domínio de wait_state (só os estados persistíveis do design §4).
  -- Idempotente: só cria se ainda não existir.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.negotiation_sessions'::regclass
      and conname = 'negotiation_sessions_wait_state_check'
  ) then
    alter table public.negotiation_sessions
      add constraint negotiation_sessions_wait_state_check
      check (
        wait_state is null or wait_state in (
          'aguardando_motor',
          'menu_degradado',
          'gerando_cobranca',
          'link_entregue',
          'erro_cobranca',
          'nao_reconhecida'
        )
      );
  end if;
end $$;

comment on column public.negotiation_sessions.wait_state is
  'Estado de espera do chat de 3 opções (onda "3 opções", trilha D2). NULL = idle '
  '(sem espera). aguardando_motor = esperando a 1ª resposta do n8n; menu_degradado '
  '= 15s sem resposta (visual encerrado, menu acionável); gerando_cobranca = '
  'payment.create em curso; link_entregue/erro_cobranca = desfecho do PAGAR; '
  'nao_reconhecida = "Não reconheço". link_entregue/quitada/nao_reconhecida são '
  'ABSORVENTES para a resposta tardia do motor (M12). O degrau visual (1,2/4/10/15s) '
  'NÃO é persistido — o client o deriva de wait_started_at.';

-- ============================================================
-- M-4b: coluna wait_started_at (âncora de tempo dos degraus).
-- ============================================================
alter table public.negotiation_sessions
  add column if not exists wait_started_at timestamptz;

comment on column public.negotiation_sessions.wait_started_at is
  'Instante em que a espera começou (clique NEGOCIAR). Âncora ÚNICA de que o client '
  'deriva os degraus 1,2/4/10/15s (M11: reabrir aos 8s cai no degrau >=4s). Não é '
  'reescrita entre degraus — só ao iniciar uma nova espera.';
