-- Seed LOCAL de tenant_chat_config (ambiente de desenvolvimento/treino).
-- Altea-Test: modo A (AlteaPay emite cobrança, portal próprio).
-- VMAX: modo B white-label (redirecionamento a canal oficial mock).
-- Aplicar: docker exec -i supabase_db_alteapay-v2 psql -U postgres -d postgres < scripts/seed_tenant_chat_config_local.sql

insert into public.tenant_chat_config
  (company_id, fulfillment_mode, official_channel_url, official_channel_label,
   branding, allowed_origins, widget_enabled, privacy_policy_url, dpo_contact)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', null, null,
   '{"displayName":"AlteaPay","primaryColor":"#0A0F1E","secondaryColor":"#EAB308","logoUrl":null,"welcomeMessage":"Olá! Estou aqui para ajudar você a resolver sua pendência de forma simples e segura."}',
   '{}', false,
   'https://alteapay.com/privacidade', 'dpo@alteapay.com'),
  ('1f7729ee-a537-43fc-a27f-5747c177988d', 'B',
   'https://mock.prefeitura.invalid/pagamentos', 'Portal da Prefeitura (mock)',
   '{"displayName":"Prefeitura Demo","primaryColor":"#14532D","secondaryColor":"#FACC15","logoUrl":null,"welcomeMessage":"Bem-vindo ao atendimento de negociação de débitos."}',
   '{http://localhost:3000,http://192.168.139.2:3000}', true,
   'https://mock.prefeitura.invalid/privacidade', 'dpo@prefeitura-demo.invalid')
on conflict (company_id) do update set
  fulfillment_mode = excluded.fulfillment_mode,
  official_channel_url = excluded.official_channel_url,
  official_channel_label = excluded.official_channel_label,
  branding = excluded.branding,
  allowed_origins = excluded.allowed_origins,
  widget_enabled = excluded.widget_enabled,
  privacy_policy_url = excluded.privacy_policy_url,
  dpo_contact = excluded.dpo_contact;
