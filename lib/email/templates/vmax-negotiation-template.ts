// Template OFICIAL de cobrança da VMAX COM dados do débito (§5.2 / Apêndices A+B).
//
// FONTE ÚNICA da casca HTML + texto do e-mail de negociação da VMAX. Consumido
// pelo seed idempotente (scripts/ops/seed-vmax-negotiation-template.ts) e pelos
// testes de render/snapshot. NÃO é gravado pela UI de template (a UI bloqueia
// dados do débito) — só o seed grava DIRETO no banco (service_role), por isso as
// variáveis de débito ({{valor_divida}}, {{documento_mascarado}}, …) só existem
// AQUI, num template marcado com allow_debt_fields=true.
//
// REGRAS FIXAS (§5.2 do prompt, decisões G0 do Fabio):
//   - Casca AlteaPay + VMAX identificada em TEXTO ("cobrança oficial em nome da
//     VMAX"). NÃO há cor/logo VMAX — só a marca dourada AlteaPay (#C4A747) + navy.
//   - Table-based, 600px, CSS 100% INLINE (sem <style>), sem imagem essencial,
//     sem JS/form. role="presentation" é nice-to-have (sanitizador estendido o
//     preserva; o estendido não é obrigatório porque o LAYOUT vem de style inline).
//   - Contraste AA em claro E escuro: todo bloco declara background-color explícito.
//   - PROIBIDO no corpo: nº contrato/fatura, linha digitável, código de barras,
//     dados bancários, multa/juros discriminados, negativação/protesto/ação
//     judicial, contagem regressiva.
//   - Remetente (config de envio, NÃO no HTML): relacionamento@alteapay.com em
//     nome da VMAX.
//
// Variáveis (combinadas com D1):
//   Básicas: primeiro_nome, credor, marca, link_negociacao, link_descadastro,
//            contato_suporte, ano.
//   Débito:  nome_cliente, documento_mascarado, valor_divida, vencimento_original,
//            qtd_faturas. (Só liberadas em templates allow_debt_fields=true.)

/** Nome canônico do template da VMAX (chave de idempotência do seed). */
export const VMAX_TEMPLATE_NAME = "VMAX — Cobrança oficial com dados do débito"

/** Assunto (Apêndice A): sem valor, sem a palavra "dívida", sem prazo/desconto. */
export const VMAX_TEMPLATE_SUBJECT = "{{credor}}: proposta para regularizar sua pendência"

/**
 * Pré-header (§5.2): curto, SEM valor e SEM a palavra "dívida". Aparece na prévia
 * da caixa de entrada.
 */
export const VMAX_TEMPLATE_PREHEADER =
  "Comunicação oficial em nome da {{credor}}. Veja a condição para regularizar sua pendência."

// Paleta (hex — clientes de e-mail não suportam oklch). Gold AlteaPay ~ #C4A747,
// navy do texto/rodapé. Todos os blocos declaram background-color explícito para
// manter contraste AA mesmo em clientes com dark-mode automático.
const GOLD = "#C4A747"
const NAVY = "#1A2340"
const INK = "#1A1D27" // texto corpo
const MUTED = "#5B6472" // texto secundário/legal
const PAGE_BG = "#F1F2F5"
const CARD_BG = "#FFFFFF"
const DATA_BG = "#F7F4EA" // bloco de dados: creme claro derivado do dourado
const DATA_BORDER = "#E4D9B4"

/**
 * HTML do e-mail. Estrutura fixa §5.2, na ordem:
 *   1. pré-header oculto (curto, sem valor/sem "dívida")
 *   2. cabeçalho: credor + assinatura AlteaPay
 *   3. saudação {{nome_cliente}}
 *   4. frase "comunicação oficial … operacionalizada pela AlteaPay"
 *   5. BLOCO DE DADOS (único lugar com dados do débito)
 *   6. CTA único "Negociar agora" + link em texto + linha de confirmação de CPF/CNPJ
 *   7. "Se você já pagou, desconsidere esta mensagem" + {{contato_suporte}}
 *   8. rodapé legal (credor + CNPJ, AlteaPay operadora, descadastro, ano)
 *
 * A frase de contagem de faturas ({{qtd_faturas}} > 1) sai renderizada só quando
 * há mais de uma fatura — o resolvedor de dados (D1) injeta a frase pronta em
 * {{qtd_faturas}} (string vazia quando é 1). Assim o HTML não precisa de lógica.
 */
export const VMAX_TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};color:${INK};font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE_BG};font-size:1px;line-height:1px;">{{primeiro_nome}}, comunicação oficial em nome da {{credor}}. Veja a condição para regularizar sua pendência.</div>
<table role="presentation" width="100%" bgcolor="${PAGE_BG}" style="background-color:${PAGE_BG};border-collapse:collapse;margin:0;padding:0;width:100%;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" bgcolor="${CARD_BG}" style="background-color:${CARD_BG};border-collapse:collapse;width:600px;max-width:600px;border-radius:8px;">
<tr>
<td style="background-color:${NAVY};border-radius:8px 8px 0 0;padding:20px 32px;">
<div style="color:#FFFFFF;font-size:18px;font-weight:bold;line-height:1.3;">{{credor}}</div>
<div style="color:${GOLD};font-size:12px;font-weight:bold;letter-spacing:0.5px;padding-top:4px;">Cobrança oficial operada pela {{marca}}</div>
</td>
</tr>
<tr>
<td style="background-color:${CARD_BG};padding:32px 32px 8px 32px;color:${INK};">
<p style="margin:0 0 16px 0;font-size:16px;line-height:1.5;color:${INK};">Olá, <strong>{{nome_cliente}}</strong>.</p>
<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${INK};">Esta é uma comunicação oficial de cobrança em nome da <strong>{{credor}}</strong>, operacionalizada pela {{marca}}. Preparamos uma condição para você regularizar sua pendência de forma simples e segura.</p>
</td>
</tr>
<tr>
<td style="background-color:${CARD_BG};padding:8px 32px;">
<table role="presentation" width="100%" bgcolor="${DATA_BG}" style="background-color:${DATA_BG};border:1px solid ${DATA_BORDER};border-radius:6px;border-collapse:separate;width:100%;">
<tr>
<td style="padding:20px 24px;color:${INK};">
<div style="font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${MUTED};padding-bottom:12px;">Sua pendência</div>
<table role="presentation" width="100%" style="border-collapse:collapse;width:100%;">
<tr>
<td style="padding:4px 0;font-size:14px;color:${MUTED};">Cliente</td>
<td align="right" style="padding:4px 0;font-size:14px;font-weight:bold;color:${INK};">{{nome_cliente}}</td>
</tr>
<tr>
<td style="padding:4px 0;font-size:14px;color:${MUTED};">Documento</td>
<td align="right" style="padding:4px 0;font-size:14px;font-weight:bold;color:${INK};">{{documento_mascarado}}</td>
</tr>
<tr>
<td style="padding:4px 0;font-size:14px;color:${MUTED};">Valor atualizado</td>
<td align="right" style="padding:4px 0;font-size:18px;font-weight:bold;color:${NAVY};">{{valor_divida}}</td>
</tr>
<tr>
<td style="padding:4px 0;font-size:14px;color:${MUTED};">Vencimento original</td>
<td align="right" style="padding:4px 0;font-size:14px;font-weight:bold;color:${INK};">{{vencimento_original}}</td>
</tr>
</table>
{{qtd_faturas}}
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" style="background-color:${CARD_BG};padding:28px 32px 8px 32px;">
<table role="presentation" style="border-collapse:collapse;">
<tr>
<td align="center" bgcolor="${GOLD}" style="background-color:${GOLD};border-radius:6px;">
<a href="{{link_negociacao}}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:bold;color:${NAVY};text-decoration:none;">Negociar agora</a>
</td>
</tr>
</table>
<p style="margin:14px 0 0 0;font-size:13px;line-height:1.5;color:${MUTED};word-break:break-all;">Ou acesse: <a href="{{link_negociacao}}" target="_blank" rel="noopener noreferrer" style="color:${NAVY};text-decoration:underline;">{{link_negociacao}}</a></p>
<p style="margin:8px 0 0 0;font-size:12px;line-height:1.5;color:${MUTED};">Ao clicar, você confirma o seu CPF/CNPJ e vê as condições disponíveis.</p>
</td>
</tr>
<tr>
<td style="background-color:${CARD_BG};padding:20px 32px 28px 32px;color:${INK};">
<p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">Se você já pagou, desconsidere esta mensagem. Em caso de dúvida, fale com o suporte em <a href="mailto:{{contato_suporte}}" style="color:${NAVY};text-decoration:underline;">{{contato_suporte}}</a>.</p>
</td>
</tr>
<tr>
<td style="background-color:${PAGE_BG};border-radius:0 0 8px 8px;padding:20px 32px;color:${MUTED};">
<p style="margin:0 0 8px 0;font-size:11px;line-height:1.5;color:${MUTED};">Cobrança oficial em nome de <strong>{{credor}}</strong> — CNPJ 07.685.452/0001-01, operacionalizada pela {{marca}}, sua operadora de cobrança e negociação.</p>
<p style="margin:0;font-size:11px;line-height:1.5;color:${MUTED};">Você recebeu este e-mail por constar uma pendência em seu nome. Para não receber mais estas comunicações, <a href="{{link_descadastro}}" target="_blank" rel="noopener noreferrer" style="color:${MUTED};text-decoration:underline;">descadastre-se aqui</a>. {{marca}} — {{ano}}.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`

/**
 * Versão PLAIN TEXT (obrigatória, §5.2). Mesmos dados e o link em texto puro.
 * A frase de contagem de faturas vem pronta em {{qtd_faturas}} (vazia se 1).
 */
export const VMAX_TEMPLATE_TEXT = `Olá, {{nome_cliente}}.

Esta é uma comunicação oficial de cobrança em nome da {{credor}}, operacionalizada pela {{marca}}. Preparamos uma condição para você regularizar sua pendência de forma simples e segura.

SUA PENDÊNCIA
Cliente: {{nome_cliente}}
Documento: {{documento_mascarado}}
Valor atualizado: {{valor_divida}}
Vencimento original: {{vencimento_original}}
{{qtd_faturas}}
Negociar agora: {{link_negociacao}}
Ao clicar, você confirma o seu CPF/CNPJ e vê as condições disponíveis.

Se você já pagou, desconsidere esta mensagem. Em caso de dúvida, fale com o suporte em {{contato_suporte}}.

---
Cobrança oficial em nome de {{credor}} — CNPJ 07.685.452/0001-01, operacionalizada pela {{marca}}, sua operadora de cobrança e negociação.
Você recebeu este e-mail por constar uma pendência em seu nome. Para não receber mais estas comunicações, descadastre-se: {{link_descadastro}}
{{marca}} — {{ano}}.`

/** Variáveis usadas pelo template (persistidas em variables_used da versão 1). */
export const VMAX_TEMPLATE_VARIABLES = [
  "primeiro_nome",
  "credor",
  "marca",
  "nome_cliente",
  "documento_mascarado",
  "valor_divida",
  "vencimento_original",
  "qtd_faturas",
  "link_negociacao",
  "link_descadastro",
  "contato_suporte",
  "ano",
] as const

/**
 * Frase de contagem para {{qtd_faturas}} quando há MAIS DE UMA fatura (C5). O
 * resolvedor de dados (D1) monta a string final; esta função é o texto canônico
 * a reutilizar. Retorna "" quando count <= 1 (não renderiza nada).
 * `variant`: "html" injeta um parágrafo estilizado; "text" injeta uma linha.
 */
export function invoiceCountPhrase(count: number, variant: "html" | "text"): string {
  if (!Number.isFinite(count) || count <= 1) return ""
  if (variant === "text") {
    return `Este valor reúne ${count} faturas em aberto.\n`
  }
  return `<p style="margin:12px 0 0 0;font-size:13px;line-height:1.5;color:${MUTED};">Este valor reúne <strong>${count}</strong> faturas em aberto.</p>`
}
