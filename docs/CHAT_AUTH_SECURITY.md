# Segurança da autenticação do chat (CPF/CNPJ)

**Última atualização:** 2026-09-18 · Cobre o endpoint genérico
`/t/{tenantSlug}/negociar` e o link de campanha `/c/{token}`.

O único fator de autenticação hoje é o **documento** (CPF/CNPJ). A data de
nascimento continua implementada e **desligada** por tenant
(`auth_require_birth_date=false`, só no fluxo `/c/{token}`). O endpoint genérico
fica **fechado ao público** (`journey_public_enabled=false`) → só admin/super_admin
enquanto o gate de abertura pública não for aprovado.

---

## 1. Mitigações §3 (TODAS implementadas)

| # | Mitigação | Onde |
|---|---|---|
| 1 | Chat fechado ao público enquanto `journey_public_enabled=false` (só admin) | `lib/supabase/middleware.ts` `journeyGate` (gate para `/c/*` e `/t/*`) |
| 2 | Link tokenizado `/c/{token}` é o caminho preferencial; genérico é fallback | rotas |
| 3 | **Resposta uniforme:** inexistente, sem-dívida-aberta e bloqueado devolvem a MESMA mensagem, MESMO status HTTP e **timing equalizado** (padding ~600ms). Nunca confirma que um CPF existe | `app/api/chat/auth/route.ts` (padding) + `lib/journey/generic-auth.ts` (mesma `GENERIC_AUTH_MESSAGE`) |
| 4 | **Rate-limit/lockout em 2 dimensões INDEPENDENTES:** por IP (5 tent/10min → 30min bloqueio) **E** por documento (3 erros → 30min) | `lib/journey/generic-auth.ts` (`chat_auth_generic_attempts`/`_locks`); campanha usa `chat_auth_attempts`/`chat_auth_locks` |
| 5 | **Nada antes de autenticar** (sem valor/credor/faturas na página de auth) | `app/t/[tenantSlug]/negociar/page.tsx` só renderiza o formulário |
| 6 | **Auditoria de toda tentativa** com `doc_hash` + `ip_hash` — **nunca o documento** | tabelas `*_attempts` (só hashes) + `journey_events` (`auth.attempt/failed/locked/success`) |
| 7 | **Captcha atrás de flag** (`CHAT_CAPTCHA_ENABLED` default false, Turnstile sugerido) | `verifyCaptcha` em `lib/journey/generic-auth.ts` |

Notas:

- A validação de DV (CPF módulo 11 / CNPJ pesos 5432987654321) e a rejeição de
  sequências repetidas ficam em `isValidCpfCnpj` (`lib/journey/auth.ts`),
  reusada por `lib/journey/document.ts`. Documento inválido responde a mesma
  mensagem uniforme (não revela "documento mal formado").
- O `company_id` é **sempre derivado no servidor** (slug → company_id via
  `resolveCompanyBySlug`; token → `chat_access_tokens.company_id`). Nunca vem do
  cliente. A resolução **nunca cruza tenant**.
- Sucesso emite cookie assinado (`httpOnly`, `Secure`, `SameSite=Lax`, TTL
  deslizante) com apenas `session_id`+`company_id` (JWT HS256,
  `lib/negotiation/crypto.ts`).
- Locks são checados **antes** de contabilizar nova tentativa e retornam a mesma
  resposta uniforme (sem revelar o bloqueio).

## 2. Fluxo de decisão (ordem no genérico)

```
valida formato/DV → captcha (se flag) → lock por IP → lock por documento →
resolve (customers, consolidado) → cria sessão + cookie
```

Falha em qualquer ponto → `GENERIC_AUTH_MESSAGE` + padding de tempo. As duas
dimensões de lock são independentes: 3 erros do MESMO documento (em IPs
diferentes) bloqueiam o documento; 5 erros do MESMO IP (com documentos
diferentes) bloqueiam o IP.

## 3. Zero PII

- Documento **nunca** é gravado em claro: só `doc_hash` (SHA-256) e, na sessão,
  `document_hash`. Logs/URLs/eventos nunca carregam o documento.
- `ip_hash` = SHA-256 truncado; o IP cru nunca é persistido.
- O documento em claro só chega ao n8n com as **duas** flags
  (`send_document_to_engine=true` E `payment_origin='n8n'`); ver
  `lib/journey/context.ts`. Fora disso, `customer.document = null`.

## 4. Segundo fator antes da abertura pública (pendência, NÃO é desta onda)

O endpoint genérico só deve ser aberto ao público (`journey_public_enabled=true`)
**depois** de um segundo fator. A infra já está preparada:

- `tenant_chat_config.auth_require_otp` (default `false`) — flag para exigir OTP.
- `auth_require_birth_date` — 2º fator alternativo já implementado (fluxo de
  campanha), desligado.
- Antes de abrir ao público, o próximo passo deve:
  1. Implementar o OTP (SMS/e-mail) atrás de `auth_require_otp`.
  2. Ligar o captcha (`CHAT_CAPTCHA_ENABLED=true` + provider/secret).
  3. Revisar os limites de lock por tenant.
  4. Só então avaliar `journey_public_enabled=true` por tenant, com canário.

Até lá, o genérico é **admin-only** e nada muda no comportamento de produção.
