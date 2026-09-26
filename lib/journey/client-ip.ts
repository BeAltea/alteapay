// IP do cliente para rate limit / auditoria (QA rodada 5, Q1-5).
//
// NUNCA confiar no 1º elemento de X-Forwarded-For: ele é escrito pelo cliente
// (qualquer um envia `X-Forwarded-For: 203.0.113.9`) e o proxy só ANEXA o IP
// real no fim. Ordem de confiança:
//   1. `x-nf-client-connection-ip` — setado pela borda da Netlify a partir da
//      conexão TCP; a Netlify sobrescreve o valor enviado pelo cliente.
//   2. O ÚLTIMO elemento de `X-Forwarded-For` — anexado pelo proxy confiável
//      imediatamente à frente da função (o cliente não controla o fim da lista).
//   3. null (sem IP confiável → a dimensão IP do rate limit simplesmente não
//      entra; o lock por documento e o teto por cedente continuam valendo).
// Valores que não parecem IP (lixo, texto, vazio) são descartados.

export interface HeaderReader {
  get(name: string): string | null
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-f:.]+$/i

/** Normaliza e valida um candidato a IP; null se não for um IP plausível. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null
  let v = raw.trim()
  if (!v || v.length > 45 + 2) return null
  // [v6]:porta ou [v6]
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v)
  if (bracket) v = bracket[1]
  // v4:porta
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"))
  if (IPV4.test(v)) return v
  if (v.includes(":") && IPV6.test(v) && v.length <= 45) return v.toLowerCase()
  return null
}

/** IP do cliente a partir de cabeçalhos definidos por proxy confiável. */
export function clientIpFromHeaders(headers: HeaderReader): string | null {
  const edge = normalizeIp(headers.get("x-nf-client-connection-ip"))
  if (edge) return edge
  const xff = headers.get("x-forwarded-for")
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean)
    const last = normalizeIp(parts[parts.length - 1])
    if (last) return last
  }
  return null
}
