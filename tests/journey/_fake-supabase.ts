// Fake Supabase (service role) em memória para os testes da onda chat/n8n.
// Suporta o subconjunto de operações que o código da jornada usa. Cada tabela é
// um array de linhas; a cadeia de filtros é aplicada no final (select/maybeSingle
// /single) ou imediatamente (insert/update, que retornam um builder próprio).
//
// Suficiente para resolver/context/generic-auth/history/payment-actions sem tocar
// um Postgres real. Não é um clone do PostgREST — só o que os testes exercitam.

export type Row = Record<string, any>
export interface FakeDb {
  [table: string]: Row[]
}

interface Filter {
  op: "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "notNull" | "isNull" | "filterEq"
  col: string
  val?: any
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col]
  switch (f.op) {
    case "eq":
    case "filterEq":
      return v === f.val
    case "neq":
      return v !== f.val
    case "in":
      return Array.isArray(f.val) && f.val.includes(v)
    case "gt":
      return v != null && v > f.val
    case "gte":
      return v != null && v >= f.val
    case "lt":
      return v != null && v < f.val
    case "notNull":
      return v != null
    case "isNull":
      return v == null
    default:
      return true
  }
}

class QueryBuilder {
  private filters: Filter[] = []
  private orderCol: string | null = null
  private orderAsc = true
  private limitN: number | null = null
  private pendingInsert: Row[] | null = null
  private pendingUpdate: Row | null = null
  private selecting = false

  constructor(
    private db: FakeDb,
    private table: string,
    private onWrite?: () => void,
  ) {}

  select(_cols?: string) {
    this.selecting = true
    return this
  }
  eq(col: string, val: any) {
    this.filters.push({ op: "eq", col, val })
    return this
  }
  neq(col: string, val: any) {
    this.filters.push({ op: "neq", col, val })
    return this
  }
  in(col: string, val: any[]) {
    this.filters.push({ op: "in", col, val })
    return this
  }
  gt(col: string, val: any) {
    this.filters.push({ op: "gt", col, val })
    return this
  }
  gte(col: string, val: any) {
    this.filters.push({ op: "gte", col, val })
    return this
  }
  lt(col: string, val: any) {
    this.filters.push({ op: "lt", col, val })
    return this
  }
  not(col: string, _op: string, _val: any) {
    this.filters.push({ op: "notNull", col })
    return this
  }
  is(col: string, val: any) {
    this.filters.push(val === null ? { op: "isNull", col } : { op: "eq", col, val })
    return this
  }
  filter(col: string, op: string, val: any) {
    if (op === "not.is") this.filters.push({ op: "notNull", col })
    else this.filters.push({ op: "filterEq", col, val })
    return this
  }
  or(_expr: string) {
    // usado por listOffers/context (valid_until null ou > now) — no fake,
    // ignoramos o OR e deixamos as ofertas presented passarem.
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col
    this.orderAsc = opts?.ascending !== false
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }

  insert(rows: Row | Row[]) {
    this.pendingInsert = Array.isArray(rows) ? rows : [rows]
    return this
  }
  update(patch: Row) {
    this.pendingUpdate = patch
    return this
  }

  private applyFilters(rows: Row[]): Row[] {
    let out = rows.filter((r) => this.filters.every((f) => matches(r, f)))
    if (this.orderCol) {
      const col = this.orderCol
      out = [...out].sort((a, b) => {
        const av = a[col], bv = b[col]
        if (av === bv) return 0
        const cmp = av < bv ? -1 : 1
        return this.orderAsc ? cmp : -cmp
      })
    }
    if (this.limitN != null) out = out.slice(0, this.limitN)
    return out
  }

  private run(): { data: Row[]; error: null } {
    const table = (this.db[this.table] ??= [])
    if (this.pendingInsert) {
      const inserted = this.pendingInsert.map((r) => ({
        id: r.id ?? `id_${Math.random().toString(36).slice(2, 10)}`,
        created_at: new Date().toISOString(),
        ...r,
      }))
      table.push(...inserted)
      this.onWrite?.()
      return { data: inserted, error: null }
    }
    if (this.pendingUpdate) {
      const target = this.applyFilters(table)
      for (const row of target) Object.assign(row, this.pendingUpdate)
      this.onWrite?.()
      return { data: target, error: null }
    }
    return { data: this.applyFilters(table), error: null }
  }

  async maybeSingle() {
    const { data } = this.run()
    return { data: data[0] ?? null, error: null }
  }
  async single() {
    const { data } = this.run()
    return { data: data[0] ?? null, error: data[0] ? null : { message: "no rows" } }
  }
  then(resolve: (r: { data: Row[]; error: null }) => void) {
    resolve(this.run())
  }
}

export function makeFakeSupabase(db: FakeDb) {
  return {
    from(table: string) {
      return new QueryBuilder(db, table)
    },
  }
}
