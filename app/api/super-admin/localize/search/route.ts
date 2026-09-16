import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { consultarDocumento, LocalizeResult } from "@/services/assertivaLocalizeService"
import { assertivaLocalizeQueue } from "@/lib/queue/queues"
import { randomUUID } from "crypto"
import { getServerSupabaseUrl } from "@/lib/supabase/url"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes max for small batch processing

interface SearchRequest {
  client_ids?: string[]
  company_id: string
  auto_apply?: boolean
  use_queue?: boolean // Force queue processing
  select_all?: boolean // Select all clients matching filter
  filter?: string // Filter to use when select_all is true
}

interface SearchResultItem {
  client_id: string
  client_name: string
  cpf_cnpj: string
  document_type: "cpf" | "cnpj"
  current_email: string | null
  current_phone: string | null
  found_email: string | null
  found_phones: {
    best: LocalizeResult["phones"]["best"]
    all_moveis: LocalizeResult["phones"]["allMoveis"]
    all_fixos: LocalizeResult["phones"]["allFixos"]
  }
  all_emails: string[]
  status: "success" | "not_found" | "error"
  error_message?: string
  assertiva_protocolo: string | null
}

/**
 * POST /api/super-admin/localize/search
 *
 * Execute Assertiva Localize queries for a list of clients.
 *
 * For batches > 50 clients or when use_queue=true, uses BullMQ queue
 * and returns a job_id for polling status.
 *
 * For small batches (<= 50), processes synchronously and returns results.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    const body: SearchRequest = await request.json()
    const { client_ids, company_id, auto_apply = false, use_queue = false, select_all = false, filter = "all" } = body

    if (!company_id) {
      return NextResponse.json(
        { error: "company_id é obrigatório" },
        { status: 400 }
      )
    }

    // Verify company exists
    const { data: company, error: companyError } = await supabase
      .from("companies")
      .select("id, name")
      .eq("id", company_id)
      .single()

    if (companyError || !company) {
      return NextResponse.json(
        { error: "Empresa não encontrada" },
        { status: 404 }
      )
    }

    // Determine which client IDs to process
    let idsToProcess: string[] = []

    if (select_all && filter) {
      // Fetch ALL client IDs matching the filter using RPC
      console.log(`[Localize Search] select_all=true, fetching all IDs for filter="${filter}"`)

      const { data: rpcIds, error: rpcError } = await supabase.rpc(
        "get_localize_client_ids",
        { p_company_id: company_id, p_filter: filter }
      )

      if (rpcError) {
        console.error("[Localize Search] RPC error, falling back to manual query:", rpcError)
        // Fallback: fetch all and filter manually
        const { data: allClients } = await supabase
          .from("VMAX")
          .select("id")
          .eq("id_company", company_id)

        idsToProcess = (allClients || []).map((c: any) => c.id)
      } else {
        idsToProcess = (rpcIds || []).map((r: any) => r.id)
      }

      console.log(`[Localize Search] Found ${idsToProcess.length} clients for filter "${filter}"`)
    } else if (client_ids && Array.isArray(client_ids) && client_ids.length > 0) {
      idsToProcess = client_ids
    } else {
      return NextResponse.json(
        { error: "client_ids deve ser um array não vazio ou select_all deve ser true" },
        { status: 400 }
      )
    }

    if (idsToProcess.length === 0) {
      return NextResponse.json(
        { error: "Nenhum cliente encontrado para o filtro selecionado" },
        { status: 404 }
      )
    }

    // For large batches or when explicitly requested, use queue
    // Threshold lowered to 30 to avoid serverless timeout (Netlify ~10s limit)
    // At 5 clients/chunk with 300ms delay + 1s between chunks, 30 clients = ~9s
    const QUEUE_THRESHOLD = 30
    const shouldUseQueue = use_queue || idsToProcess.length >= QUEUE_THRESHOLD

    if (shouldUseQueue) {
      // Create a batch ID for tracking
      const batchId = randomUUID()

      // Add job to queue
      const job = await assertivaLocalizeQueue.add(
        "localize-batch",
        {
          batchId,
          companyId: company_id,
          clientIds: idsToProcess,
          filterUsed: select_all ? filter : "manual",
          totalClients: idsToProcess.length,
          autoApply: auto_apply,
        },
        {
          jobId: batchId,
        }
      )

      console.log(`[Localize Search] Created queue job ${job.id} for ${idsToProcess.length} clients`)

      return NextResponse.json({
        queued: true,
        job_id: job.id,
        batch_id: batchId,
        total_clients: idsToProcess.length,
        message: `Processamento de ${idsToProcess.length} clientes iniciado. Use /status?job_id=${job.id} para acompanhar.`,
      })
    }

    // For small batches, process synchronously (original behavior)
    // Fetch clients from VMAX
    const { data: clients, error: clientsError } = await supabase
      .from("VMAX")
      .select(`id, Cliente, "CPF/CNPJ", Email, "Telefone 1", id_company`)
      .in("id", idsToProcess)
      .eq("id_company", company_id)

    if (clientsError) {
      console.error("[Localize Search] Error fetching clients:", clientsError)
      return NextResponse.json(
        { error: "Erro ao buscar clientes" },
        { status: 500 }
      )
    }

    if (!clients || clients.length === 0) {
      return NextResponse.json(
        { error: "Nenhum cliente encontrado" },
        { status: 404 }
      )
    }

    // Process clients in chunks with rate limiting
    const results: SearchResultItem[] = []
    const chunkSize = 5
    const delayBetweenRequests = 300
    const delayBetweenChunks = 1000

    console.log(`[Localize Search] Processing ${clients.length} clients synchronously`)

    for (let i = 0; i < clients.length; i += chunkSize) {
      const chunk = clients.slice(i, i + chunkSize)

      for (let j = 0; j < chunk.length; j++) {
        const client = chunk[j]
        const cpfCnpj = client["CPF/CNPJ"] || ""
        const cleanDoc = cpfCnpj.replace(/\D/g, "")

        if (!cleanDoc) {
          results.push({
            client_id: client.id,
            client_name: client.Cliente || "",
            cpf_cnpj: cpfCnpj,
            document_type: "cpf",
            current_email: client.Email || null,
            current_phone: client["Telefone 1"] || null,
            found_email: null,
            found_phones: {
              best: null,
              all_moveis: [],
              all_fixos: [],
            },
            all_emails: [],
            status: "error",
            error_message: "CPF/CNPJ não informado",
            assertiva_protocolo: null,
          })
          continue
        }

        try {
          const localizeResult = await consultarDocumento(cleanDoc)

          const resultItem: SearchResultItem = {
            client_id: client.id,
            client_name: client.Cliente || "",
            cpf_cnpj: cpfCnpj,
            document_type: localizeResult.documentType,
            current_email: client.Email || null,
            current_phone: client["Telefone 1"] || null,
            found_email: localizeResult.bestEmail,
            found_phones: {
              best: localizeResult.phones.best,
              all_moveis: localizeResult.phones.allMoveis,
              all_fixos: localizeResult.phones.allFixos,
            },
            all_emails: localizeResult.emails,
            status: localizeResult.success
              ? localizeResult.bestEmail || localizeResult.phones.best
                ? "success"
                : "not_found"
              : "error",
            error_message: localizeResult.error,
            assertiva_protocolo: localizeResult.protocolo || null,
          }

          results.push(resultItem)

          // Log the query
          await supabase.from("assertiva_localize_logs").insert({
            company_id,
            client_id: client.id,
            cpf_cnpj: cleanDoc,
            document_type: localizeResult.documentType,
            assertiva_protocolo: localizeResult.protocolo,
            query_status: resultItem.status,
            error_message: localizeResult.error,
            response_payload: localizeResult.rawResponse || null,
            emails_found: localizeResult.emails,
            phones_found: {
              moveis: localizeResult.phones.allMoveis,
              fixos: localizeResult.phones.allFixos,
            },
            best_email: localizeResult.bestEmail,
            best_phone: localizeResult.phones.best?.numero || null,
            best_phone_whatsapp: localizeResult.phones.best?.whatsapp || false,
            email_before: client.Email || null,
            phone_before: client["Telefone 1"] || null,
          })

          // Auto-apply found data to client record (sync processing)
          if (auto_apply && localizeResult.success) {
            const updates: Record<string, any> = {}
            const currentEmail = (client.Email || "").trim()
            const currentPhone = (client["Telefone 1"] || "").trim()

            if (!currentEmail && localizeResult.bestEmail) {
              updates.Email = localizeResult.bestEmail
            }
            if (!currentPhone && localizeResult.phones.best?.numero) {
              updates["Telefone 1"] = localizeResult.phones.best.numero
            }

            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString()
              console.log(`[Localize Search] Auto-applying to ${client.id}:`, updates)

              const { error: updateError } = await supabase
                .from("VMAX")
                .update(updates)
                .eq("id", client.id)

              if (updateError) {
                console.error(`[Localize Search] Auto-apply failed for ${client.id}:`, updateError)
              } else {
                // Update the log with applied data
                await supabase
                  .from("assertiva_localize_logs")
                  .update({
                    email_applied: updates.Email || null,
                    phone_applied: updates["Telefone 1"] || null,
                    applied_at: new Date().toISOString(),
                  })
                  .eq("client_id", client.id)
                  .eq("company_id", company_id)
                  .order("created_at", { ascending: false })
                  .limit(1)
              }
            }
          }
        } catch (error: any) {
          console.error(`[Localize Search] Error querying ${cleanDoc}:`, error)
          results.push({
            client_id: client.id,
            client_name: client.Cliente || "",
            cpf_cnpj: cpfCnpj,
            document_type: cleanDoc.length === 14 ? "cnpj" : "cpf",
            current_email: client.Email || null,
            current_phone: client["Telefone 1"] || null,
            found_email: null,
            found_phones: {
              best: null,
              all_moveis: [],
              all_fixos: [],
            },
            all_emails: [],
            status: "error",
            error_message: error.message,
            assertiva_protocolo: null,
          })
        }

        if (j < chunk.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayBetweenRequests))
        }
      }

      if (i + chunkSize < clients.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenChunks))
      }
    }

    const summary = {
      total_consulted: results.length,
      success: results.filter((r) => r.status === "success").length,
      emails_found: results.filter((r) => r.found_email).length,
      phones_found: results.filter((r) => r.found_phones.best).length,
      not_found: results.filter((r) => r.status === "not_found").length,
      errors: results.filter((r) => r.status === "error").length,
    }

    console.log(`[Localize Search] Completed:`, summary)

    return NextResponse.json({
      queued: false,
      results,
      summary,
    })
  } catch (error: any) {
    console.error("[Localize Search] Error:", error)
    return NextResponse.json(
      { error: "Erro interno do servidor", details: error.message },
      { status: 500 }
    )
  }
}
