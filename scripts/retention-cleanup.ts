/**
 * Retenção de dados do chatbot (LGPD art. 15/16 — término do tratamento).
 *
 * - whatsapp_inbound_events: payloads brutos apagados após 90 dias.
 * - conversation_messages: retidas pelo prazo de auditoria/prescrição do
 *   contrato (default 5 anos; configurável por env). Sessões associadas são
 *   mantidas (métricas agregadas, sem conteúdo).
 *
 * Execução manual/agendável (produção: cron; local: sob demanda):
 *   npx tsx scripts/retention-cleanup.ts [--dry-run]
 */

import { Client } from "pg"

const WA_RETENTION_DAYS = Number(process.env.WHATSAPP_EVENTS_RETENTION_DAYS || "90")
const MESSAGES_RETENTION_DAYS = Number(process.env.CONVERSATION_RETENTION_DAYS || String(5 * 365))

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const url =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    const waCount = await client.query(
      `select count(*)::int as n from whatsapp_inbound_events
       where created_at < now() - make_interval(days => $1)`,
      [WA_RETENTION_DAYS],
    )
    const msgCount = await client.query(
      `select count(*)::int as n from conversation_messages
       where created_at < now() - make_interval(days => $1)`,
      [MESSAGES_RETENTION_DAYS],
    )
    console.log(
      `candidatos: ${waCount.rows[0].n} eventos WhatsApp (> ${WA_RETENTION_DAYS}d), ` +
        `${msgCount.rows[0].n} mensagens (> ${MESSAGES_RETENTION_DAYS}d)${dryRun ? " [dry-run]" : ""}`,
    )
    if (dryRun) return

    await client.query("begin")
    const wa = await client.query(
      `delete from whatsapp_inbound_events
       where created_at < now() - make_interval(days => $1) returning id`,
      [WA_RETENTION_DAYS],
    )
    await client.query("set local \"alteapay.allow_redaction\" = 'on'")
    const msgs = await client.query(
      `delete from conversation_messages
       where created_at < now() - make_interval(days => $1) returning id`,
      [MESSAGES_RETENTION_DAYS],
    )
    await client.query(
      `insert into security_events (event_type, severity, action, resource_type, metadata, status)
       values ('data_delete', 'low', 'lgpd_retention_cleanup', 'chatbot_data',
               jsonb_build_object('whatsapp_events_deleted', $1::int, 'messages_deleted', $2::int,
                                  'wa_retention_days', $3::int, 'msg_retention_days', $4::int),
               'success')`,
      [wa.rowCount, msgs.rowCount, WA_RETENTION_DAYS, MESSAGES_RETENTION_DAYS],
    )
    await client.query("commit")
    console.log(`apagados: ${wa.rowCount} eventos WhatsApp, ${msgs.rowCount} mensagens`)
  } catch (err) {
    await client.query("rollback")
    throw err
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error("falha:", err instanceof Error ? err.message : err)
  process.exit(1)
})
