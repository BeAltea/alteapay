-- Canal n8n: sessões criadas por fluxos do n8n (webhook /api/webhooks/n8n)
-- e mensagens trocadas server-to-server por esse canal. Constraints inline
-- da 20260702 têm nome default <tabela>_<coluna>_check.

alter table public.negotiation_sessions
  drop constraint if exists negotiation_sessions_channel_origin_check;
alter table public.negotiation_sessions
  add constraint negotiation_sessions_channel_origin_check
  check (channel_origin in ('whatsapp','direct','mock','n8n'));

alter table public.conversation_messages
  drop constraint if exists conversation_messages_channel_check;
alter table public.conversation_messages
  add constraint conversation_messages_channel_check
  check (channel in ('whatsapp','webchat','n8n'));
