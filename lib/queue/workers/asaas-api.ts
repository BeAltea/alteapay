/**
 * Shared ASAAS API utilities for batch workers
 */

import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '../../supabase/url';
import { isMockMode } from '../../integrations/mock-mode';
import { mockAsaasRequest } from '../../integrations/asaas-mock';

const ASAAS_BASE_URL = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';

export interface AsaasResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export async function asaasRequest(
  endpoint: string,
  method: string = 'GET',
  body?: unknown
): Promise<AsaasResponse> {
  if (isMockMode('asaas')) {
    return { success: true, data: mockAsaasRequest(endpoint, method, body) };
  }

  const apiKey = process.env.ASAAS_API_KEY;

  if (!apiKey) {
    return { success: false, error: 'ASAAS_API_KEY not configured' };
  }

  const url = `${ASAAS_BASE_URL}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      access_token: apiKey.trim(),
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return { success: false, error: `ASAAS returned non-JSON: ${text.substring(0, 100)}` };
  }

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.errors?.[0]?.description || data.error || `HTTP ${response.status}`;
    return { success: false, error: errorMsg };
  }

  return { success: true, data };
}

// Supabase admin client for batch tracking
let _supabase: ReturnType<typeof createClient> | null = null;

export function getSupabaseAdmin() {
  if (!_supabase) {
    const url = getServerSupabaseUrl();
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      throw new Error('Supabase credentials not configured');
    }

    _supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

// Batch tracking functions
export async function incrementBatchCompleted(batchId: string, resultData?: Record<string, any>) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc('increment_batch_completed', {
    batch_id: batchId,
    result_data: resultData || null,
  } as any);

  if (error) {
    console.error(`[BATCH] Failed to increment completed for batch ${batchId}:`, error.message);
  }
}

export async function incrementBatchFailed(batchId: string, errorDetail: Record<string, any>) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc('increment_batch_failed', {
    batch_id: batchId,
    error_detail: errorDetail,
  } as any);

  if (error) {
    console.error(`[BATCH] Failed to increment failed for batch ${batchId}:`, error.message);
  }
}

export async function checkAndFinalizeBatch(batchId: string): Promise<{ isComplete: boolean; finalStatus: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('check_and_finalize_batch', {
    batch_id: batchId,
  } as any);

  if (error) {
    console.error(`[BATCH] Failed to check batch ${batchId}:`, error.message);
    return { isComplete: false, finalStatus: 'error' };
  }

  const result = (data as any)?.[0] || { is_complete: false, final_status: 'unknown' };
  return {
    isComplete: result.is_complete,
    finalStatus: result.final_status,
  };
}

export async function startBatchProcessing(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc('start_batch_processing', {
    batch_id: batchId,
  } as any);

  if (error) {
    console.error(`[BATCH] Failed to start batch ${batchId}:`, error.message);
  }
}
