# Achados consolidados — onda Hub + Voxuy API + link único (H6)

**Data:** 2026-09-21 · **Base validada:** `4e1aab4..071b32f` · **Estado:** 417 testes verdes, build verde.
Formato §7.4. **Regra de subida:** nenhum BLOQUEANTE aberto passa ao GATE H1 → **todos os BLOQUEANTES foram CORRIGIDOS** (commit `071b32f`).

## Placar final

| Severidade | Achado | Trilha | Estado |
|---|---|---|---|
| 🔴 BLOQUEANTE | Contrato hub UI↔API não casava (`/send`,`/send-preview`) → diálogo quebrava, "todos os N" dava 400 | T5×T2 | **corrigido** (rotas emitem a forma rica + aceitam `allFiltered`; teste de integração) |
| 🔴 BLOQUEANTE | "Copiar link" copiava placeholder falso (`/n/{companyId[:8]}`) | T5 | **corrigido** (usa `public_link_code`; botão desabilita sem code) |
| 🔴 BLOQUEANTE (latente) | `rebuild ≠ incremental` p/ evento de domínio fora de ordem (contrato afirmava "diferença zero") | T1 | **corrigido** (chronology-gate; contrato honesto; teste do cenário) |
| 🟠 ALTO | Doc não registrava regras da template Meta (Utilidade, sem valor, não iniciar/terminar com variável, opt-out) | T3 | **corrigido** (§2.1 do doc) |
| 🟡 MÉDIO | `enterprise_v1` não envia `optout_url` — depende do template Meta | T3 | **documentado** (§2.1) |
| 🟡 MÉDIO | Convite de e-mail sem descadastro/List-Unsubscribe | T4/T2 | **corrigido** (rodapé + header; limitação do header custom registrada) |
| 🟢 vn-cobranca | Não cobra 2x; caminho antigo intacto; ASAAS fonte da verdade; ofertas da matriz | T2/T6 | **APROVADO** |
| 🟢 vt-security | PII, URL-credencial, resposta uniforme, RLS, rate-limit, captcha funcional, cookie, CPF-não-sai | todas | **APROVADO** (2 baixos cosméticos) |

## Follow-ups NÃO-bloqueantes — IMPLEMENTADOS (commits `7e54374..093ef39`)
- ✅ **Paginação server-side** na lista: `range()` no `negotiation_state` (usa `idx_company_rank`/`_updated`) + contadores por agregação separada (mesmo predicado → soma fecha); filtros satélite pré-resolvidos a ids. Não materializa mais as ~3196 linhas.
- ✅ **`channel`/`provider_status_source`** na projeção: gancho global `applyJourneyEventToState` no `recordEvent` (best-effort) → projeção reflete TODOS os eventos ao vivo (resolve T1-1) e grava `channel` do payload dos `message.*` (resolve FIX-T1-1). `rebuild==incremental` preservado.
- ✅ **Rate-limit captcha:** captcha falho no link público agora registra tentativa (alimenta o teto/cedente-hora) + comentário corrigido.
- ✅ **`List-Unsubscribe`:** headers custom fim-a-fim (`sendEmail`→fila→worker→SendGrid); convite passa `List-Unsubscribe` + `-Post` one-click; corpo segue neutro.
- ⏸️ **`both` mode**: parte de cobrança é nota não-executada (conservador, sem duplo disparo) — **decisão de produto**, não é bug.

Estado: **444 testes verdes** (após follow-ups), build verde.

## Confirmações-chave (o que a validação PROVOU correto)
- Botão "Enviar negociação" (`whatsapp_chat`) **não cria cobrança nem e-mail de cobrança**; `charge_email` (caminho antigo) intacto.
- `payment.create` idempotente por `(session_id,offer_id)`; `already_charged`→reenvia link vivo via `payment.status`.
- Link `/n/{code}`: resposta **idêntica** p/ inexistente vs sem-dívida (HTTP 200, timing equalizado); captcha Turnstile funcional; rate-limit IP+doc+teto/hora na ordem certa; janela liga/desliga; marca do credor só pós-login.
- `VOXUY_WEBHOOK_URL` (credencial) nunca logada; CPF não sai ao n8n (mascarado+hash); RLS em `negotiation_state`; `super_admin`/vínculo de tenant nas rotas novas.
- Migration `20260922` aditiva/idempotente/aplicável do zero; provider `mock` default; `public_link_enabled=false`.
