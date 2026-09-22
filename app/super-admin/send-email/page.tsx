import { redirect } from "next/navigation"

// "Enviar Email" foi renomeado para "Gerenciamento de E-mails" (F3). A rota
// antiga redireciona para a nova (a aba "Comunicações" contém o envio avulso
// que antes vivia aqui). Preserva bookmarks/links antigos.
export const dynamic = "force-dynamic"

export default function SendEmailRedirect() {
  redirect("/super-admin/emails")
}
