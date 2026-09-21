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

## Follow-ups NÃO-bloqueantes (registrados, não travam GATE H1)
- **Paginação em memória** na lista de negociações: funciona no volume 3196 (documentado), mas full-scan filtrado + slice — não escala. `idx_neg_state_company_rank` não usado (ordenação em memória). Otimizar quando o volume crescer.
- **`channel`/`provider_status_source` sempre nulos na projeção** (`FIX-T1-1.md`): exige `message.*` carregarem `channel` no payload (fora do arquivo do T1). Filtro "canal" da lista não casa até isso. Informativo, não afeta o funil.
- **Rate-limit do link público** não conta tentativas de captcha/DV-inválido para o teto/hora (vt-security baixo): IP-lock já barra rajada antes; defesa redundante.
- **`both` mode**: a parte de cobrança é uma nota não-executada (conservador — sem duplo disparo; produto decide se fecha o ciclo).
- **`List-Unsubscribe` header**: `sendEmail`/worker SendGrid não expõem headers custom hoje; opt-out efetivo é o link do rodapé até o helper suportar.

## Confirmações-chave (o que a validação PROVOU correto)
- Botão "Enviar negociação" (`whatsapp_chat`) **não cria cobrança nem e-mail de cobrança**; `charge_email` (caminho antigo) intacto.
- `payment.create` idempotente por `(session_id,offer_id)`; `already_charged`→reenvia link vivo via `payment.status`.
- Link `/n/{code}`: resposta **idêntica** p/ inexistente vs sem-dívida (HTTP 200, timing equalizado); captcha Turnstile funcional; rate-limit IP+doc+teto/hora na ordem certa; janela liga/desliga; marca do credor só pós-login.
- `VOXUY_WEBHOOK_URL` (credencial) nunca logada; CPF não sai ao n8n (mascarado+hash); RLS em `negotiation_state`; `super_admin`/vínculo de tenant nas rotas novas.
- Migration `20260922` aditiva/idempotente/aplicável do zero; provider `mock` default; `public_link_enabled=false`.
