/**
 * seed-vmax-negotiation-template — cria/atualiza o template OFICIAL de cobrança da
 * VMAX COM dados do débito e o define como PADRÃO da VMAX (C10 / Apêndices A+B).
 *
 * O que faz (idempotente, read-then-write):
 *   1. Garante o template em public.email_templates (company_id = VMAX,
 *      purpose='negotiation', allow_debt_fields=true, status='active',
 *      name = VMAX_TEMPLATE_NAME). Cria se não existir; atualiza os metadados se
 *      já existir (sem duplicar).
 *   2. Grava a versão 1 em public.email_template_versions com o assunto/preheader/
 *      html/texto/variáveis do módulo lib/email/templates/vmax-negotiation-template.
 *      Se a versão corrente já bate byte-a-byte com a canônica, NÃO cria versão nova
 *      (rodar 2x não gera lixo). Se difere, cria a próxima versão e reaponta
 *      current_version_id.
 *   3. Define o template como PADRÃO da VMAX em public.email_template_defaults
 *      (company_id = VMAX, purpose='negotiation') via upsert (1 por par).
 *
 * Este template contém variáveis de DÉBITO ({{valor_divida}}, {{documento_mascarado}},
 * {{vencimento_original}}, {{nome_cliente}}, {{qtd_faturas}}) — que a UI de template
 * BLOQUEIA. Por isso o seed grava DIRETO no banco (não passa pelo validador de
 * allowlist); a liberação é a flag allow_debt_fields=true na linha do template.
 *
 * Conexão: POSTGRES_URL_NON_POOLING do .env.local (mesmo esquema dos demais scripts
 * ops do repo). NÃO usa dados reais; só constantes do módulo do template.
 *
 * PII: NUNCA loga documento/valor/e-mail — só ids (uuid) e o que mudou.
 *
 * Uso:
 *   pnpm exec tsx scripts/ops/seed-vmax-negotiation-template.ts            # aplica
 *   pnpm exec tsx scripts/ops/seed-vmax-negotiation-template.ts --dry-run  # só reporta
 *
 * ⚠️ NÃO rodar em produção (gate G4). Só deixe o script pronto — o orquestrador
 * roda contra o cluster local seeded após a revisão.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Client } from "pg"
import {
  VMAX_TEMPLATE_NAME,
  VMAX_TEMPLATE_SUBJECT,
  VMAX_TEMPLATE_PREHEADER,
  VMAX_TEMPLATE_HTML,
  VMAX_TEMPLATE_TEXT,
  VMAX_TEMPLATE_VARIABLES,
} from "../../lib/email/templates/vmax-negotiation-template"

const DRY_RUN = process.argv.includes("--dry-run")

/** company_id da VMAX (Fase 0). Fixo — o seed é específico da VMAX. */
const VMAX_COMPANY_ID = "1f7729ee-a537-43fc-a27f-5747c177988d"
const PURPOSE = "negotiation"

/** Lê POSTGRES_URL_NON_POOLING do .env.local sem depender de dotenv. */
function readDbUrl(): string {
  const envPath = resolve(process.cwd(), ".env.local")
  let raw: string
  try {
    raw = readFileSync(envPath, "utf8")
  } catch {
    console.error("[seed-vmax] .env.local não encontrado no cwd")
    process.exit(1)
  }
  const line = raw.split("\n").find((l) => l.startsWith("POSTGRES_URL_NON_POOLING="))
  if (!line) {
    console.error("[seed-vmax] POSTGRES_URL_NON_POOLING ausente no .env.local")
    process.exit(1)
  }
  return line
    .slice("POSTGRES_URL_NON_POOLING=".length)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[?&]sslmode=[^&]*/g, "") // remove sslmode; usamos ssl abaixo
}

interface TemplateRow {
  id: string
  status: string
  allow_debt_fields: boolean | null
  current_version_id: string | null
}
interface VersionRow {
  id: string
  version: number
  subject: string
  preheader: string | null
  html: string
  text_fallback: string | null
}

/** Conteúdo canônico da versão (o que a versão 1 deve conter). */
const CANONICAL = {
  subject: VMAX_TEMPLATE_SUBJECT,
  preheader: VMAX_TEMPLATE_PREHEADER,
  html: VMAX_TEMPLATE_HTML,
  text_fallback: VMAX_TEMPLATE_TEXT,
  variables_used: [...VMAX_TEMPLATE_VARIABLES],
}

/** Versão corrente já bate byte-a-byte com o canônico? (evita versão duplicada). */
function versionMatches(v: VersionRow): boolean {
  return (
    v.subject === CANONICAL.subject &&
    (v.preheader ?? "") === CANONICAL.preheader &&
    v.html === CANONICAL.html &&
    (v.text_fallback ?? "") === CANONICAL.text_fallback
  )
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: readDbUrl(), ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    // 0. VMAX existe? (falha cedo com mensagem clara em vez de FK error).
    const company = await client.query<{ id: string }>(
      `select id from public.companies where id = $1`,
      [VMAX_COMPANY_ID],
    )
    if (company.rowCount === 0) {
      console.error(`[seed-vmax] company VMAX ${VMAX_COMPANY_ID} não existe neste banco`)
      process.exit(1)
    }

    // 1. Template existe? (chave: company_id + name).
    const existing = await client.query<TemplateRow>(
      `select id, status, allow_debt_fields, current_version_id
         from public.email_templates
        where company_id = $1 and name = $2`,
      [VMAX_COMPANY_ID, VMAX_TEMPLATE_NAME],
    )

    let templateId: string
    let currentVersionId: string | null
    let createdTemplate = false

    if (existing.rowCount === 0) {
      if (DRY_RUN) {
        console.log(`[seed-vmax] (dry-run) CRIARIA template "${VMAX_TEMPLATE_NAME}" para VMAX`)
        console.log(`[seed-vmax] (dry-run) CRIARIA versão 1 + definiria como padrão da VMAX`)
        return
      }
      const ins = await client.query<{ id: string }>(
        `insert into public.email_templates
           (company_id, name, purpose, status, allow_debt_fields, created_by)
         values ($1, $2, $3, 'active', true, null)
         returning id`,
        [VMAX_COMPANY_ID, VMAX_TEMPLATE_NAME, PURPOSE],
      )
      templateId = ins.rows[0].id
      currentVersionId = null
      createdTemplate = true
      console.log(`[seed-vmax] template criado id=${templateId}`)
    } else {
      const row = existing.rows[0]
      templateId = row.id
      currentVersionId = row.current_version_id
      // Reafirma metadados (idempotente): active + allow_debt_fields + purpose.
      const needsUpdate = row.status !== "active" || row.allow_debt_fields !== true
      if (needsUpdate) {
        if (DRY_RUN) {
          console.log(`[seed-vmax] (dry-run) ATUALIZARIA metadados do template ${templateId} (status/allow_debt_fields)`)
        } else {
          await client.query(
            `update public.email_templates
                set status = 'active', allow_debt_fields = true, purpose = $2, updated_at = now()
              where id = $1`,
            [templateId, PURPOSE],
          )
          console.log(`[seed-vmax] metadados do template ${templateId} reafirmados`)
        }
      } else {
        console.log(`[seed-vmax] template já existe id=${templateId} (metadados ok)`)
      }
    }

    // 2. Versão corrente já bate com o canônico?
    let needNewVersion = true
    if (currentVersionId) {
      const cur = await client.query<VersionRow>(
        `select id, version, subject, preheader, html, text_fallback
           from public.email_template_versions where id = $1`,
        [currentVersionId],
      )
      if (cur.rowCount && versionMatches(cur.rows[0])) {
        needNewVersion = false
        console.log(`[seed-vmax] versão corrente v${cur.rows[0].version} já é a canônica (nada a fazer)`)
      }
    }

    if (needNewVersion) {
      if (DRY_RUN) {
        console.log(`[seed-vmax] (dry-run) GRAVARIA nova versão canônica para o template ${templateId}`)
      } else {
        const nextV = await client.query<{ next: number }>(
          `select coalesce(max(version), 0) + 1 as next
             from public.email_template_versions where template_id = $1`,
          [templateId],
        )
        const version = nextV.rows[0].next
        const vIns = await client.query<{ id: string }>(
          `insert into public.email_template_versions
             (template_id, version, subject, preheader, html, text_fallback, variables_used, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, null)
           returning id`,
          [
            templateId,
            version,
            CANONICAL.subject,
            CANONICAL.preheader,
            CANONICAL.html,
            CANONICAL.text_fallback,
            CANONICAL.variables_used,
          ],
        )
        currentVersionId = vIns.rows[0].id
        await client.query(
          `update public.email_templates
              set current_version_id = $2, updated_at = now()
            where id = $1`,
          [templateId, currentVersionId],
        )
        console.log(`[seed-vmax] versão v${version} gravada id=${currentVersionId} e apontada como corrente`)
      }
    }

    // 3. Define como padrão da VMAX (upsert 1-por-(company,purpose)).
    const def = await client.query<{ template_id: string }>(
      `select template_id from public.email_template_defaults
        where company_id = $1 and purpose = $2`,
      [VMAX_COMPANY_ID, PURPOSE],
    )
    const alreadyDefault = def.rowCount ? def.rows[0].template_id === templateId : false
    if (alreadyDefault) {
      console.log(`[seed-vmax] template já é o padrão de negociação da VMAX`)
    } else if (DRY_RUN) {
      console.log(`[seed-vmax] (dry-run) DEFINIRIA o template ${templateId} como padrão de negociação da VMAX`)
    } else {
      await client.query(
        `insert into public.email_template_defaults (company_id, template_id, purpose, updated_by, updated_at)
         values ($1, $2, $3, null, now())
         on conflict (company_id, purpose)
         do update set template_id = excluded.template_id, updated_at = now()`,
        [VMAX_COMPANY_ID, templateId, PURPOSE],
      )
      console.log(`[seed-vmax] template ${templateId} definido como padrão de negociação da VMAX`)
    }

    console.log(
      `[seed-vmax] concluído${DRY_RUN ? " (dry-run)" : ""}: template=${templateId}` +
        (createdTemplate ? " (novo)" : "") +
        (currentVersionId ? ` version=${currentVersionId}` : ""),
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error("[seed-vmax] erro:", err instanceof Error ? err.message : err)
  process.exit(1)
})
