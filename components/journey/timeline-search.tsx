"use client"

// Busca da jornada (super-admin): o operador digita o documento; enviamos só a
// forma MASCARADA ao servidor (nunca o CPF em claro na query/URL).
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function maskCpf(document: string): string {
  const digits = document.replace(/\D/g, "")
  if (!digits) return ""
  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`
  }
  if (digits.length === 14) {
    return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/****-**`
  }
  return ""
}

export function TimelineSearch({ initial }: { initial: string }) {
  const router = useRouter()
  const [doc, setDoc] = useState("")

  function search() {
    const masked = maskCpf(doc)
    if (!masked) return
    router.push(`/super-admin/negociacao-ia/jornada?doc=${encodeURIComponent(masked)}`)
  }

  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <Label>Documento do cliente (CPF/CNPJ)</Label>
        <Input
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search()
          }}
          placeholder="Digite o documento; enviamos só a forma mascarada"
          inputMode="numeric"
          autoComplete="off"
        />
      </div>
      <Button onClick={search}>Buscar</Button>
      {initial ? (
        <span className="pb-2 text-sm text-muted-foreground">
          Filtro: <span className="font-mono">{initial}</span>
        </span>
      ) : null}
    </div>
  )
}
