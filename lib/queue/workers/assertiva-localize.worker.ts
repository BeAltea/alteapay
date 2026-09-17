import { Job } from 'bullmq';
import { WorkerManager } from '../worker-manager';
import { QUEUE_CONFIG } from '../config';
import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '../../supabase/url';

// Import the service (needs to be dynamic to avoid "use server" issues)
// The consultarDocumento function handles token management internally

export interface AssertivaLocalizeJobData {
  batchId: string;
  companyId: string;
  clientIds: string[];
  filterUsed: 'no_email' | 'no_phone' | 'incomplete' | 'manual';
  createdBy?: string;
  totalClients: number;
  autoApply: boolean;
}

export interface AssertivaLocalizeProgress {
  processed: number;
  total: number;
  percentage: number;
  emailsFound: number;
  phonesFound: number;
  emailsApplied: number;
  phonesApplied: number;
  notFound: number;
  errors: number;
  currentClientName?: string;
}

function getSupabaseAdmin() {
  return createClient(
    getServerSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const assertivaLocalizeWorker = WorkerManager.registerWorker<AssertivaLocalizeJobData>(
  QUEUE_CONFIG.assertivaLocalize.name,
  async (job: Job<AssertivaLocalizeJobData>) => {
    const { batchId, companyId, clientIds, autoApply, createdBy } = job.data;
    const supabase = getSupabaseAdmin();

    console.log(`[ASSERTIVA-LOCALIZE] Starting job ${job.id} for batch ${batchId}`);
    console.log(`[ASSERTIVA-LOCALIZE] Processing ${clientIds.length} clients, autoApply: ${autoApply}`);

    // Import the service dynamically to avoid "use server" issues in worker context
    const { consultarDocumento } = await import('@/services/assertivaLocalizeService');

    const progress: AssertivaLocalizeProgress = {
      processed: 0,
      total: clientIds.length,
      percentage: 0,
      emailsFound: 0,
      phonesFound: 0,
      emailsApplied: 0,
      phonesApplied: 0,
      notFound: 0,
      errors: 0,
    };

    const CHUNK_SIZE = 5;
    const DELAY_BETWEEN_REQUESTS = 300; // ms
    const DELAY_BETWEEN_CHUNKS = 1000; // ms

    // Fetch all clients in batch
    const { data: clients, error: fetchError } = await supabase
      .from('VMAX')
      .select('id, Cliente, "CPF/CNPJ", Email, "Telefone 1", "Telefone 2", id_company')
      .in('id', clientIds)
      .eq('id_company', companyId);

    if (fetchError || !clients) {
      console.error('[ASSERTIVA-LOCALIZE] Failed to fetch clients:', fetchError);
      throw new Error('Failed to fetch clients from database');
    }

    // Create a map for quick lookup
    const clientMap = new Map(clients.map((c) => [c.id, c]));

    for (let i = 0; i < clientIds.length; i += CHUNK_SIZE) {
      const chunkIds = clientIds.slice(i, i + CHUNK_SIZE);

      for (const clientId of chunkIds) {
        const client = clientMap.get(clientId);

        if (!client) {
          progress.errors++;
          progress.processed++;
          continue;
        }

        const cpfCnpj = client['CPF/CNPJ'] || '';
        const cleanDoc = cpfCnpj.replace(/\D/g, '');

        progress.currentClientName = client.Cliente || 'Cliente';

        if (!cleanDoc) {
          // Log error - no document
          await supabase.from('assertiva_localize_logs').insert({
            company_id: companyId,
            client_id: clientId,
            cpf_cnpj: '',
            document_type: 'cpf',
            query_status: 'error',
            error_message: 'CPF/CNPJ não informado',
            created_by: createdBy,
          });
          progress.errors++;
          progress.processed++;
          continue;
        }

        try {
          // Query Assertiva
          const result = await consultarDocumento(cleanDoc);

          // Save log
          await supabase.from('assertiva_localize_logs').insert({
            company_id: companyId,
            client_id: clientId,
            cpf_cnpj: cleanDoc,
            document_type: result.documentType,
            assertiva_protocolo: result.protocolo,
            query_status: result.success ? (result.bestEmail || result.phones.best ? 'success' : 'not_found') : 'error',
            error_message: result.error,
            response_payload: result.rawResponse,
            emails_found: result.emails,
            phones_found: {
              moveis: result.phones.allMoveis,
              fixos: result.phones.allFixos,
            },
            best_email: result.bestEmail,
            best_phone: result.phones.best?.numero || null,
            best_phone_whatsapp: result.phones.best?.whatsapp || false,
            email_before: client.Email || null,
            phone_before: client['Telefone 1'] || null,
            created_by: createdBy,
          });

          // Track stats
          if (!result.success || (!result.bestEmail && !result.phones.best)) {
            progress.notFound++;
          } else {
            if (result.bestEmail) progress.emailsFound++;
            if (result.phones.best) progress.phonesFound++;
          }

          // Auto-apply if enabled and data was found
          if (autoApply && result.success) {
            const updates: Record<string, any> = {};
            const currentEmail = client.Email?.trim() || '';
            const currentPhone = (client['Telefone 1'] || '').trim();

            console.log(`[ASSERTIVA-LOCALIZE] Client ${clientId} (${client.Cliente}): checking auto-apply`);
            console.log(`[ASSERTIVA-LOCALIZE]   - Current email: "${currentEmail}", Found email: "${result.bestEmail}"`);
            console.log(`[ASSERTIVA-LOCALIZE]   - Current phone: "${currentPhone}", Found phone: "${result.phones.best?.numero}"`);

            // Only update empty fields
            if (!currentEmail && result.bestEmail) {
              updates.Email = result.bestEmail;
              progress.emailsApplied++;
              console.log(`[ASSERTIVA-LOCALIZE]   - Will apply email: ${result.bestEmail}`);
            }
            if (!currentPhone && result.phones.best?.numero) {
              updates['Telefone 1'] = result.phones.best.numero;
              progress.phonesApplied++;
              console.log(`[ASSERTIVA-LOCALIZE]   - Will apply phone: ${result.phones.best.numero}`);
            }

            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString();

              console.log(`[ASSERTIVA-LOCALIZE]   - Executing UPDATE on VMAX for ${clientId}:`, updates);
              const { data: updateData, error: updateError } = await supabase
                .from('VMAX')
                .update(updates)
                .eq('id', clientId)
                .select('id, Email, "Telefone 1"');

              if (updateError) {
                console.error(`[ASSERTIVA-LOCALIZE]   - UPDATE FAILED for ${clientId}:`, updateError);
              } else if (!updateData || updateData.length === 0) {
                console.error(`[ASSERTIVA-LOCALIZE]   - UPDATE returned empty (RLS blocked or ID not found)`);
              } else {
                console.log(`[ASSERTIVA-LOCALIZE]   - UPDATE SUCCESS: ${clientId} ->`, updateData[0]);
                // Update the log with applied data
                await supabase
                  .from('assertiva_localize_logs')
                  .update({
                    email_applied: updates.Email || null,
                    phone_applied: updates['Telefone 1'] || null,
                    applied_at: new Date().toISOString(),
                  })
                  .eq('client_id', clientId)
                  .eq('company_id', companyId)
                  .order('created_at', { ascending: false })
                  .limit(1);
              }
            } else {
              console.log(`[ASSERTIVA-LOCALIZE]   - Nothing to apply (fields already filled or no data found)`);
            }
          } else if (!autoApply) {
            console.log(`[ASSERTIVA-LOCALIZE] Client ${clientId}: autoApply is FALSE, skipping auto-apply`);
          }
        } catch (error: any) {
          console.error(`[ASSERTIVA-LOCALIZE] Error querying ${cleanDoc}:`, error.message);

          // Log the error
          await supabase.from('assertiva_localize_logs').insert({
            company_id: companyId,
            client_id: clientId,
            cpf_cnpj: cleanDoc,
            document_type: cleanDoc.length === 14 ? 'cnpj' : 'cpf',
            query_status: 'error',
            error_message: error.message,
            created_by: createdBy,
          });

          progress.errors++;
        }

        progress.processed++;
        await sleep(DELAY_BETWEEN_REQUESTS);
      }

      // Update job progress after each chunk
      progress.percentage = Math.round((progress.processed / progress.total) * 100);
      await job.updateProgress(progress);

      console.log(
        `[ASSERTIVA-LOCALIZE] Progress: ${progress.processed}/${progress.total} (${progress.percentage}%)`
      );

      // Delay between chunks
      if (i + CHUNK_SIZE < clientIds.length) {
        await sleep(DELAY_BETWEEN_CHUNKS);
      }
    }

    // Final progress update
    progress.percentage = 100;
    await job.updateProgress(progress);

    console.log(`[ASSERTIVA-LOCALIZE] Job ${job.id} completed:`, progress);

    return progress;
  },
  {
    concurrency: 1, // Only 1 job at a time to respect Assertiva rate limits
  }
);

assertivaLocalizeWorker.on('completed', (job, result) => {
  console.log(
    `[ASSERTIVA-LOCALIZE] Job ${job.id} completed - Emails: ${result.emailsFound}, Phones: ${result.phonesFound}`
  );
});

assertivaLocalizeWorker.on('failed', (job, err) => {
  console.error(`[ASSERTIVA-LOCALIZE] Job ${job?.id} failed: ${err.message}`);
});

assertivaLocalizeWorker.on('error', (err) => {
  console.error('[ASSERTIVA-LOCALIZE] Worker error:', err.message);
});
