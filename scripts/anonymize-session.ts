/**
 * Anonimização de sessão de negociação (LGPD art. 18 — pedido do titular).
 *
 * Substitui o conteúdo das mensagens por "[removido a pedido do titular]",
 * apaga hashes de contato/documento e desvincula o customer, preservando as
 * métricas agregadas (outcome, funil, valores de redirect).
 *
 * A tabela conversation_messages é imutável por trigger; a única via de escrita
 * é o GUC de sessão alteapay.allow_redaction (setado dentro da transação).
 *
 * Execução manual (o encarregado roda após validar o pedido do titular):
 *   npx tsx scripts/anonymize-session.ts <session_id>
 */

import { Client } from "pg"

const REDACTED = "[removido a pedido do titular]"

async function main() {
  const sessionId = process.argv[2]
  if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    console.error("uso: npx tsx scripts/anonymize-session.ts <session_id (uuid)>")
    process.exit(1)
  }

  const url =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    await client.query("begin")
    await client.query("set local \"alteapay.allow_redaction\" = 'on'")

    const messages = await client.query(
      `update conversation_messages
         set content = $2, content_redacted = $2, tool_calls = null, provider_message_id = null
       where session_id = $1
       returning id`,
      [sessionId, REDACTED],
    )

    const session = await client.query(
      `update negotiation_sessions
         set document_hash = 'anonymized', ip_hash = null, user_agent = null,
             customer_id = null, handoff_token_hash = null, thread_id = null
       where id = $1
       returning id, outcome`,
      [sessionId],
    )
    if (session.rowCount === 0) {
      throw new Error(`sessão ${sessionId} não encontrada`)
    }

    const waEvents = await client.query(
      `update whatsapp_inbound_events
         set payload = '{"anonymized": true}'::jsonb, phone_hash = null
       where session_id = $1
       returning id`,
      [sessionId],
    )

    // trilha de auditoria do próprio ato de anonimização
    await client.query(
      `insert into security_events (event_type, severity, action, resource_type, resource_id, metadata, status)
       values ('data_delete', 'medium', 'lgpd_anonymize_session', 'negotiation_session', $1,
               jsonb_build_object('messages', $2::int, 'whatsapp_events', $3::int), 'success')`,
      [sessionId, messages.rowCount, waEvents.rowCount],
    )

    await client.query("commit")
    console.log(
      `sessão ${sessionId} anonimizada: ${messages.rowCount} mensagens, ` +
        `${waEvents.rowCount} eventos WhatsApp. Outcome preservado: ${session.rows[0].outcome}`,
    )
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
