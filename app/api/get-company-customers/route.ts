import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getServerSupabaseUrl } from '@/lib/supabase/url'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  console.log('[v0] API get-company-customers - Request received')
  
  try {
    const { searchParams } = new URL(request.url)
    const companyId = searchParams.get('companyId')
    
    console.log('[v0] API - Company ID:', companyId)
    
    if (!companyId) {
      console.log('[v0] API - Missing company ID')
      return NextResponse.json(
        { success: false, error: 'Company ID é obrigatório', customers: [], total: 0 },
        { status: 400 }
      )
    }

    // Criar service role client para bypassar RLS
    const supabase = createClient(
      getServerSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )
    
    console.log('[v0] API - Service role client created')
    
    // Buscar TODOS os clientes VMAX
    console.log('[v0] API - Buscando clientes VMAX...')
    const { data: vmaxData, error: vmaxError } = await supabase
      .from('VMAX')
      .select('*')
    
    console.log('[v0] API - Query executada:', {
      total: vmaxData?.length || 0,
      error: vmaxError?.message
    })
    
    if (vmaxError) {
      console.error('[v0] API - Erro na query VMAX:', vmaxError)
      return NextResponse.json(
        { success: false, error: vmaxError.message, customers: [], total: 0 },
        { status: 500 }
      )
    }
    
    if (!vmaxData || vmaxData.length === 0) {
      console.log('[v0] API - Nenhum cliente encontrado')
      return NextResponse.json(
        { success: true, customers: [], total: 0 },
        { status: 200 }
      )
    }
    
    // Filtrar localmente por company_id
    console.log('[v0] API - Filtrando por company_id:', companyId)
    const filteredCustomers = vmaxData.filter((customer: any) => {
      const match = customer.id_company === companyId
      if (match) {
        console.log('[v0] API - ✓ Cliente encontrado:', customer.Cliente)
      }
      return match
    })
    
    console.log('[v0] API - Clientes filtrados:', filteredCustomers.length)
    
    // Buscar dados complementares da integration_logs
    if (filteredCustomers.length > 0) {
      const customerIds = filteredCustomers.map((c: any) => c.id)
      console.log('[v0] API - Buscando integration_logs para', customerIds.length, 'clientes')
      
      const { data: logsData } = await supabase
        .from('integration_logs')
        .select('*')
        .in('id', customerIds)
      
      console.log('[v0] API - Logs encontrados:', logsData?.length || 0)
      
      // Adicionar dados dos logs aos clientes
      filteredCustomers.forEach((customer: any) => {
        customer.integrationData = logsData?.filter((log: any) => log.id === customer.id) || []
      })
    }
    
    console.log('[v0] API - Retornando', filteredCustomers.length, 'clientes')
    
    return NextResponse.json(
      {
        success: true,
        customers: filteredCustomers,
        total: filteredCustomers.length
      },
      { status: 200 }
    )
    
  } catch (error: any) {
    console.error('[v0] API - Erro não esperado:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Erro interno do servidor',
        customers: [],
        total: 0
      },
      { status: 500 }
    )
  }
}
