import { describe, it, expect } from "vitest"

/**
 * INV: Supabase silently caps result sets at 1000 rows; business queries over
 * VMAX/agreements/customers/debts MUST paginate (page loop or .range(0, 99999))
 * or data is silently dropped. This contract locks the page-loop semantics.
 */
async function paginate<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  let page = 0
  for (;;) {
    const rows = await fetchPage(page * pageSize, (page + 1) * pageSize - 1)
    all.push(...rows)
    if (rows.length < pageSize) break
    page++
  }
  return all
}

describe("characterization: pagination beyond the 1000-row cap", () => {
  it("fetches all rows across pages (1500 > 1000 cap)", async () => {
    const total = 1500
    const data = Array.from({ length: total }, (_, i) => i)
    const fetchPage = async (from: number, to: number) => data.slice(from, to + 1)
    const out = await paginate(fetchPage)
    expect(out.length).toBe(total)
    expect(out[1499]).toBe(1499)
  })
})
