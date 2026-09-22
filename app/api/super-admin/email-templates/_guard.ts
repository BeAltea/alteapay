import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
}

export interface GuardOk {
  ok: true
  userId: string
}
export interface GuardFail {
  ok: false
  response: NextResponse
}

/** Exige super_admin autenticado. Retorna o userId ou uma resposta 401/403. */
export async function requireSuperAdmin(): Promise<GuardOk | GuardFail> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Não autorizado" }, { status: 401, headers: noCacheHeaders }),
    }
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (!profile || profile.role !== "super_admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Acesso negado. Apenas super admins gerenciam templates." },
        { status: 403, headers: noCacheHeaders },
      ),
    }
  }

  return { ok: true, userId: user.id }
}
