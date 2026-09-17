-- F5 E2E seed: synthetic customers + open debts in Altea-Test tenant.
-- Idempotent: safe to re-run. Uses fixed UUIDs with an e2e marker so the
-- driver script and cleanup can find them. NADA em produção — banco local.

\set company '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''

-- enable the public journey for the test tenant
update tenant_chat_config
set journey_public_enabled = true
where company_id = :company;

-- clean any previous e2e run for these ids (children first)
delete from debts     where id in (
  'e2e00001-0000-0000-0000-000000000001',
  'e2e00001-0000-0000-0000-000000000002',
  'e2e00001-0000-0000-0000-000000000003',
  'e2e00001-0000-0000-0000-000000000004');
delete from customers where id in (
  'e2e00000-0000-0000-0000-000000000001',
  'e2e00000-0000-0000-0000-000000000002',
  'e2e00000-0000-0000-0000-000000000003',
  'e2e00000-0000-0000-0000-000000000004');

-- 4 customers: 3 for the happy/idempotency/paid paths + 1 for opt-out.
insert into customers (id, company_id, name, document, document_type, phone, email, source_system, birth_date)
values
  ('e2e00000-0000-0000-0000-000000000001', :company, 'E2E Cliente Um',    '39053344705', 'CPF', '11987650001', 'e2e1@example.test', 'e2e', '1990-01-10'),
  ('e2e00000-0000-0000-0000-000000000002', :company, 'E2E Cliente Dois',  '11144477735', 'CPF', '11987650002', 'e2e2@example.test', 'e2e', '1985-05-20'),
  ('e2e00000-0000-0000-0000-000000000003', :company, 'E2E Cliente Tres',  '52998224725', 'CPF', '11987650003', 'e2e3@example.test', 'e2e', '1978-11-30'),
  ('e2e00000-0000-0000-0000-000000000004', :company, 'E2E Cliente Optout','78901234505', 'CPF', '11987650004', 'e2e4@example.test', 'e2e', '1995-07-15');

-- open debts (pending, value > 20), aged so they fall in the 0..∞ matrix band.
insert into debts (id, company_id, customer_id, amount, due_date, description, status, source_system)
values
  ('e2e00001-0000-0000-0000-000000000001', :company, 'e2e00000-0000-0000-0000-000000000001', 1000.00, current_date - 120, 'E2E divida um',   'pending', 'e2e'),
  ('e2e00001-0000-0000-0000-000000000002', :company, 'e2e00000-0000-0000-0000-000000000002',  850.50, current_date - 200, 'E2E divida dois', 'pending', 'e2e'),
  ('e2e00001-0000-0000-0000-000000000003', :company, 'e2e00000-0000-0000-0000-000000000003',  300.00, current_date -  60, 'E2E divida tres', 'pending', 'e2e'),
  ('e2e00001-0000-0000-0000-000000000004', :company, 'e2e00000-0000-0000-0000-000000000004',  500.00, current_date -  90, 'E2E divida optout','pending','e2e');

select 'seeded' as status,
       (select count(*) from customers where source_system='e2e' and company_id = :company) as customers,
       (select count(*) from debts     where source_system='e2e' and company_id = :company) as debts,
       (select journey_public_enabled from tenant_chat_config where company_id = :company) as journey_enabled;
