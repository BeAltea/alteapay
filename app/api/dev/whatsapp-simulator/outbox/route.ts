// Simulador dev: lê a outbox do provider mock (compartilhada via Redis entre
// o pod web e o pod de workers). SOMENTE dev/mock.

import { NextResponse } from "next/server"
import IORedis from "ioredis"

export const dynamic = "force-dynamic"

let client: IORedis | null = null
function redis(): IORedis {
  if (!client) {
    client = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    })
    client.on("error", () => {})
  }
  return client
}

export async function GET(request: Request) {
  if (process.env.MOCK_ALL_INTEGRATIONS !== "1" && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ success: false, error: "não encontrado" }, { status: 404 })
  }
  const phone = new URL(request.url).searchParams.get("phone")?.replace(/\D/g, "")
  if (!phone) {
    return NextResponse.json({ success: false, error: "phone obrigatório" }, { status: 422 })
  }
  try {
    const items = await redis().lrange(`wa:mock:outbox:${phone}`, 0, -1)
    return NextResponse.json({ success: true, messages: items.map((i) => JSON.parse(i)) })
  } catch {
    return NextResponse.json({ success: true, messages: [] })
  }
}
