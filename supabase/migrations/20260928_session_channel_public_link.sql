-- Fix: o CHECK de negotiation_sessions.channel não incluía 'web_public_link',
-- mas o fluxo do link único público (/n/{code}) grava exatamente esse valor
-- (generic-auth establishSession, channel: "web_public_link").
--
-- Efeito do bug: TODO enrichment/reopen de sessão do link público violava o CHECK.
-- Antes do fix de reuso o erro era silencioso (sessão ficava com channel/debt_ids
-- não gravados). Com o reuso ativo, reopenSession passou a LANÇAR nessa violação,
-- e o route (defesa D14) converte a exceção em resposta no_debt — o devedor que
-- reentrava via o mesmo link recebia "não encontramos dívidas".
--
-- Correção: incluir 'web_public_link' no CHECK. Aditiva, sem tocar dados.

alter table public.negotiation_sessions
  drop constraint if exists negotiation_sessions_channel_check;

alter table public.negotiation_sessions
  add constraint negotiation_sessions_channel_check
  check (
    channel is null
    or channel = any (array['web_campaign','web_generic','admin_preview','web_public_link'])
  );

notify pgrst, 'reload schema';
