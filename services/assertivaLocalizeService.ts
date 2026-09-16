"use server"

import { isMockMode, mockHex } from "@/lib/integrations/mock-mode"

/**
 * Assertiva Localize Service
 *
 * Provides data enrichment capabilities using Assertiva Localize API v3.
 * Used to find emails and phone numbers for customers/debtors based on CPF/CNPJ.
 *
 * API Documentation: https://api.assertivasolucoes.com.br/docs
 */

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface AssertivaTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

interface AssertivaEmail {
  email: string
}

interface AssertivaTelefone {
  numero: string
  relacao: string
  naoPerturbe: boolean
  hotphone?: boolean
  plus?: boolean
  ultimoContato?: string
  aplicativos?: {
    whatsApp?: boolean
  }
  temGoogleMeuNegocio?: boolean
}

interface AssertivaTelefones {
  fixos: AssertivaTelefone[]
  moveis: AssertivaTelefone[]
}

interface AssertivaLocalizeCPFResponse {
  cabecalho: {
    dataHora: string
    protocolo: string
    produto: string
    funcionalidade: string
    finalidade?: string
    descricaoFinalidade?: string
    reconsulta: boolean
    entrada: {
      cpf: string
      idFinalidade: number
    }
  }
  resposta: {
    dadosCadastrais: {
      cpf: string
      nome: string
      sexo?: string
      dataNascimento?: string
      idade?: number
      obitoProvavel?: boolean
      situacaoCadastral: string
      maeNome?: string
    }
    telefones: AssertivaTelefones
    emails: AssertivaEmail[]
    enderecos?: any[]
    participacoesEmpresas?: any[]
    redesSociais?: any[]
  }
  alerta: string
}

interface AssertivaLocalizeCNPJResponse {
  cabecalho: {
    dataHora: string
    protocolo: string
    produto: string
    funcionalidade: string
    finalidade?: string
    reconsulta: boolean
    entrada: {
      cnpj: string
      idFinalidade: number
    }
  }
  resposta: {
    dadosCadastrais: {
      cnpj: string
      razaoSocial: string
      nomeFantasia?: string
      dataAbertura?: string
      situacaoCadastral: string
      site?: string
    }
    telefones: AssertivaTelefones
    emails: AssertivaEmail[]
    socios?: any[]
    enderecos?: any[]
  }
  alerta: string
}

export interface LocalizeResult {
  success: boolean
  document: string
  documentType: 'cpf' | 'cnpj'
  name?: string
  protocolo?: string
  emails: string[]
  bestEmail: string | null
  phones: {
    best: {
      numero: string
      tipo: 'movel' | 'fixo'
      whatsapp: boolean
      hotphone: boolean
      relacao: string
    } | null
    allMoveis: Array<{
      numero: string
      whatsapp: boolean
      hotphone: boolean
      relacao: string
      naoPerturbe: boolean
    }>
    allFixos: Array<{
      numero: string
      relacao: string
      naoPerturbe: boolean
    }>
  }
  rawResponse?: any
  error?: string
}

// ============================================================================
// TOKEN MANAGEMENT (Reuses pattern from assertivaService.ts)
// ============================================================================

const tokenCache: {
  token: string | null
  expiresAt: number | null
} = {
  token: null,
  expiresAt: null,
}

async function getAssertivaToken(): Promise<string> {
  try {
    // Check if cached token is still valid (renew 60s before expiry)
    const now = Date.now()
    if (tokenCache.token && tokenCache.expiresAt && tokenCache.expiresAt - 60000 > now) {
      return tokenCache.token
    }

    const clientId = process.env.ASSERTIVA_CLIENT_ID
    const clientSecret = process.env.ASSERTIVA_CLIENT_SECRET
    const baseUrl = process.env.ASSERTIVA_BASE_URL || "https://api.assertivasolucoes.com.br"

    if (!clientId || !clientSecret) {
      throw new Error("ASSERTIVA_CLIENT_ID e ASSERTIVA_CLIENT_SECRET não configuradas")
    }

    // Basic Auth: base64(client_id:client_secret)
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
    const tokenUrl = `${baseUrl}/oauth2/v3/token`

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[LocalizeService] getToken Error:", errorText)

      if (response.status === 401) {
        throw new Error("Credenciais Assertiva inválidas")
      }
      if (response.status === 403) {
        throw new Error("Sem permissão para acessar a API Assertiva")
      }

      throw new Error(`Falha ao obter token: ${response.status}`)
    }

    const data: AssertivaTokenResponse = await response.json()

    // Cache token
    tokenCache.token = data.access_token
    tokenCache.expiresAt = now + data.expires_in * 1000

    return data.access_token
  } catch (error: any) {
    console.error("[LocalizeService] getToken Error:", error)
    throw error
  }
}

// ============================================================================
// FETCH WITH RETRY
// ============================================================================

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)

      // Handle 401 - refresh token and retry
      if (response.status === 401 && attempt < maxRetries) {
        tokenCache.token = null
        tokenCache.expiresAt = null
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        const newToken = await getAssertivaToken()
        if (options.headers) {
          ;(options.headers as any).Authorization = `Bearer ${newToken}`
        }
        continue
      }

      // Handle rate limiting (429) or service unavailable (503)
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        console.log(`[LocalizeService] Rate limited or unavailable, waiting 5s before retry ${attempt}/${maxRetries}`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
        continue
      }

      // Handle timeout (504)
      if (response.status === 504 && attempt < maxRetries) {
        console.log(`[LocalizeService] Gateway timeout, waiting 3s before retry ${attempt}/${maxRetries}`)
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }

      return response
    } catch (error: any) {
      lastError = error
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  throw lastError || new Error("Max retries exceeded")
}

// ============================================================================
// PHONE SELECTION LOGIC
// ============================================================================

/**
 * Select the best phone number based on priority rules:
 * 1. Móvel with hotphone=true, whatsApp=true, relacao="Direto", naoPerturbe=false
 * 2. Móvel with hotphone=true, relacao="Direto", naoPerturbe=false
 * 3. Móvel with relacao="Direto", naoPerturbe=false
 * 4. Any móvel with naoPerturbe=false
 * 5. Fixo with relacao="Direto", naoPerturbe=false
 * 6. Any phone with naoPerturbe=false
 * 7. Any phone (last resort)
 */
function selectBestPhone(telefones: AssertivaTelefones): LocalizeResult['phones']['best'] {
  const moveis = telefones.moveis || []
  const fixos = telefones.fixos || []

  // Priority 1: Móvel + hotphone + whatsapp + direto + not no-perturbe
  const p1 = moveis.find(
    (t) => t.hotphone && t.aplicativos?.whatsApp && t.relacao === 'Direto' && !t.naoPerturbe
  )
  if (p1) {
    return {
      numero: p1.numero,
      tipo: 'movel',
      whatsapp: true,
      hotphone: true,
      relacao: p1.relacao,
    }
  }

  // Priority 2: Móvel + hotphone + direto + not no-perturbe
  const p2 = moveis.find((t) => t.hotphone && t.relacao === 'Direto' && !t.naoPerturbe)
  if (p2) {
    return {
      numero: p2.numero,
      tipo: 'movel',
      whatsapp: !!p2.aplicativos?.whatsApp,
      hotphone: true,
      relacao: p2.relacao,
    }
  }

  // Priority 3: Móvel + direto + not no-perturbe
  const p3 = moveis.find((t) => t.relacao === 'Direto' && !t.naoPerturbe)
  if (p3) {
    return {
      numero: p3.numero,
      tipo: 'movel',
      whatsapp: !!p3.aplicativos?.whatsApp,
      hotphone: !!p3.hotphone,
      relacao: p3.relacao,
    }
  }

  // Priority 4: Any móvel + not no-perturbe
  const p4 = moveis.find((t) => !t.naoPerturbe)
  if (p4) {
    return {
      numero: p4.numero,
      tipo: 'movel',
      whatsapp: !!p4.aplicativos?.whatsApp,
      hotphone: !!p4.hotphone,
      relacao: p4.relacao,
    }
  }

  // Priority 5: Fixo + direto + not no-perturbe
  const p5 = fixos.find((t) => t.relacao === 'Direto' && !t.naoPerturbe)
  if (p5) {
    return {
      numero: p5.numero,
      tipo: 'fixo',
      whatsapp: false,
      hotphone: false,
      relacao: p5.relacao,
    }
  }

  // Priority 6: Any phone + not no-perturbe
  const p6 = [...moveis, ...fixos].find((t) => !t.naoPerturbe)
  if (p6) {
    const isMovel = moveis.includes(p6 as any)
    return {
      numero: p6.numero,
      tipo: isMovel ? 'movel' : 'fixo',
      whatsapp: isMovel && !!(p6 as AssertivaTelefone).aplicativos?.whatsApp,
      hotphone: isMovel && !!(p6 as AssertivaTelefone).hotphone,
      relacao: p6.relacao,
    }
  }

  // Priority 7: Any phone (last resort)
  const anyPhone = moveis[0] || fixos[0]
  if (anyPhone) {
    const isMovel = moveis.includes(anyPhone as any)
    return {
      numero: anyPhone.numero,
      tipo: isMovel ? 'movel' : 'fixo',
      whatsapp: isMovel && !!(anyPhone as AssertivaTelefone).aplicativos?.whatsApp,
      hotphone: isMovel && !!(anyPhone as AssertivaTelefone).hotphone,
      relacao: anyPhone.relacao,
    }
  }

  return null
}

// ============================================================================
// MOCK MODE
// ============================================================================

/**
 * Builds a deterministic, realistic LocalizeResult without calling the API.
 * Contact info is derived from a hash of the document and is intentionally
 * undeliverable (example.invalid email, synthetic phone number).
 */
function buildMockLocalizeResult(cleanDoc: string, documentType: 'cpf' | 'cnpj'): LocalizeResult {
  const hex = mockHex(cleanDoc, 8)
  const digits = String(parseInt(hex, 16) % 100000000).padStart(8, "0")
  const email = `mock.${hex}@example.invalid`
  const numero = `(11) 9${digits.slice(0, 4)}-${digits.slice(4)}`

  console.log(`[mock:assertiva] localize.${documentType}`, `doc=***${cleanDoc.slice(-4)}`)

  return {
    success: true,
    document: cleanDoc,
    documentType,
    name: documentType === 'cpf' ? `Cliente Mock ${hex.slice(0, 4).toUpperCase()}` : `Empresa Mock ${hex.slice(0, 4).toUpperCase()} LTDA`,
    protocolo: `mock-${mockHex(cleanDoc, 16)}`,
    emails: [email],
    bestEmail: email,
    phones: {
      best: {
        numero,
        tipo: 'movel',
        whatsapp: true,
        hotphone: true,
        relacao: 'Direto',
      },
      allMoveis: [
        {
          numero,
          whatsapp: true,
          hotphone: true,
          relacao: 'Direto',
          naoPerturbe: false,
        },
      ],
      allFixos: [],
    },
  }
}

// ============================================================================
// MAIN API FUNCTIONS
// ============================================================================

/**
 * Query Assertiva Localize API for CPF
 */
export async function consultarCPF(cpf: string): Promise<LocalizeResult> {
  const cleanDoc = cpf.replace(/\D/g, '')

  if (cleanDoc.length !== 11) {
    return {
      success: false,
      document: cleanDoc,
      documentType: 'cpf',
      emails: [],
      bestEmail: null,
      phones: { best: null, allMoveis: [], allFixos: [] },
      error: 'CPF inválido: deve ter 11 dígitos',
    }
  }

  if (isMockMode("assertiva")) {
    return buildMockLocalizeResult(cleanDoc, 'cpf')
  }

  try {
    const token = await getAssertivaToken()
    const baseUrl = process.env.ASSERTIVA_BASE_URL || "https://api.assertivasolucoes.com.br"
    const idFinalidade = process.env.ASSERTIVA_FINALIDADE_ID || "2"

    const url = `${baseUrl}/localize/v3/cpf?cpf=${cleanDoc}&idFinalidade=${idFinalidade}`

    console.log(`[LocalizeService] Consulting CPF: ${cleanDoc.substring(0, 3)}***`)

    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[LocalizeService] CPF query failed: ${response.status}`, errorText)

      if (response.status === 422) {
        return {
          success: false,
          document: cleanDoc,
          documentType: 'cpf',
          emails: [],
          bestEmail: null,
          phones: { best: null, allMoveis: [], allFixos: [] },
          error: 'CPF não encontrado na base Assertiva',
        }
      }

      return {
        success: false,
        document: cleanDoc,
        documentType: 'cpf',
        emails: [],
        bestEmail: null,
        phones: { best: null, allMoveis: [], allFixos: [] },
        error: `Erro na API: ${response.status}`,
      }
    }

    const data: AssertivaLocalizeCPFResponse = await response.json()

    // Extract data
    const emails = (data.resposta?.emails || []).map((e) => e.email).filter(Boolean)
    const telefones = data.resposta?.telefones || { fixos: [], moveis: [] }

    const allMoveis = (telefones.moveis || []).map((t) => ({
      numero: t.numero,
      whatsapp: !!t.aplicativos?.whatsApp,
      hotphone: !!t.hotphone,
      relacao: t.relacao,
      naoPerturbe: t.naoPerturbe,
    }))

    const allFixos = (telefones.fixos || []).map((t) => ({
      numero: t.numero,
      relacao: t.relacao,
      naoPerturbe: t.naoPerturbe,
    }))

    return {
      success: true,
      document: cleanDoc,
      documentType: 'cpf',
      name: data.resposta?.dadosCadastrais?.nome,
      protocolo: data.cabecalho?.protocolo,
      emails,
      bestEmail: emails[0] || null,
      phones: {
        best: selectBestPhone(telefones),
        allMoveis,
        allFixos,
      },
      rawResponse: data,
    }
  } catch (error: any) {
    console.error(`[LocalizeService] CPF query error:`, error)
    return {
      success: false,
      document: cleanDoc,
      documentType: 'cpf',
      emails: [],
      bestEmail: null,
      phones: { best: null, allMoveis: [], allFixos: [] },
      error: error.message,
    }
  }
}

/**
 * Query Assertiva Localize API for CNPJ
 */
export async function consultarCNPJ(cnpj: string): Promise<LocalizeResult> {
  const cleanDoc = cnpj.replace(/\D/g, '')

  if (cleanDoc.length !== 14) {
    return {
      success: false,
      document: cleanDoc,
      documentType: 'cnpj',
      emails: [],
      bestEmail: null,
      phones: { best: null, allMoveis: [], allFixos: [] },
      error: 'CNPJ inválido: deve ter 14 dígitos',
    }
  }

  if (isMockMode("assertiva")) {
    return buildMockLocalizeResult(cleanDoc, 'cnpj')
  }

  try {
    const token = await getAssertivaToken()
    const baseUrl = process.env.ASSERTIVA_BASE_URL || "https://api.assertivasolucoes.com.br"
    const idFinalidade = process.env.ASSERTIVA_FINALIDADE_ID || "2"

    const url = `${baseUrl}/localize/v3/cnpj?cnpj=${cleanDoc}&idFinalidade=${idFinalidade}`

    console.log(`[LocalizeService] Consulting CNPJ: ${cleanDoc.substring(0, 8)}***`)

    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[LocalizeService] CNPJ query failed: ${response.status}`, errorText)

      if (response.status === 422) {
        return {
          success: false,
          document: cleanDoc,
          documentType: 'cnpj',
          emails: [],
          bestEmail: null,
          phones: { best: null, allMoveis: [], allFixos: [] },
          error: 'CNPJ não encontrado na base Assertiva',
        }
      }

      return {
        success: false,
        document: cleanDoc,
        documentType: 'cnpj',
        emails: [],
        bestEmail: null,
        phones: { best: null, allMoveis: [], allFixos: [] },
        error: `Erro na API: ${response.status}`,
      }
    }

    const data: AssertivaLocalizeCNPJResponse = await response.json()

    // Extract data
    const emails = (data.resposta?.emails || []).map((e) => e.email).filter(Boolean)
    const telefones = data.resposta?.telefones || { fixos: [], moveis: [] }

    const allMoveis = (telefones.moveis || []).map((t) => ({
      numero: t.numero,
      whatsapp: !!t.aplicativos?.whatsApp,
      hotphone: !!t.hotphone,
      relacao: t.relacao,
      naoPerturbe: t.naoPerturbe,
    }))

    const allFixos = (telefones.fixos || []).map((t) => ({
      numero: t.numero,
      relacao: t.relacao,
      naoPerturbe: t.naoPerturbe,
    }))

    return {
      success: true,
      document: cleanDoc,
      documentType: 'cnpj',
      name: data.resposta?.dadosCadastrais?.razaoSocial || data.resposta?.dadosCadastrais?.nomeFantasia,
      protocolo: data.cabecalho?.protocolo,
      emails,
      bestEmail: emails[0] || null,
      phones: {
        best: selectBestPhone(telefones),
        allMoveis,
        allFixos,
      },
      rawResponse: data,
    }
  } catch (error: any) {
    console.error(`[LocalizeService] CNPJ query error:`, error)
    return {
      success: false,
      document: cleanDoc,
      documentType: 'cnpj',
      emails: [],
      bestEmail: null,
      phones: { best: null, allMoveis: [], allFixos: [] },
      error: error.message,
    }
  }
}

/**
 * Auto-detect document type and query appropriate endpoint
 */
export async function consultarDocumento(documento: string): Promise<LocalizeResult> {
  const cleanDoc = documento.replace(/\D/g, '')

  if (cleanDoc.length === 11) {
    return consultarCPF(cleanDoc)
  } else if (cleanDoc.length === 14) {
    return consultarCNPJ(cleanDoc)
  } else {
    return {
      success: false,
      document: cleanDoc,
      documentType: cleanDoc.length > 11 ? 'cnpj' : 'cpf',
      emails: [],
      bestEmail: null,
      phones: { best: null, allMoveis: [], allFixos: [] },
      error: `Documento inválido: ${cleanDoc.length} dígitos (esperado 11 para CPF ou 14 para CNPJ)`,
    }
  }
}

/**
 * Batch query multiple documents with rate limiting
 */
export async function consultarLote(
  documentos: string[],
  delayMs: number = 300,
  onProgress?: (current: number, total: number, result: LocalizeResult) => void
): Promise<LocalizeResult[]> {
  const results: LocalizeResult[] = []

  for (let i = 0; i < documentos.length; i++) {
    const result = await consultarDocumento(documentos[i])
    results.push(result)

    if (onProgress) {
      onProgress(i + 1, documentos.length, result)
    }

    // Delay between requests to avoid rate limiting
    if (i < documentos.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return results
}
