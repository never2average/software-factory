import type { AgentUsage, AppRow, Check, CostBasis, MoldRow, ProductRow, Ticket, Usage, UsageNumbers, UserUsage } from '../types'

// Pure readers of the factory's own state files (state/factory.json, state/products.json,
// state/application/<id>/*.json, state/tasks/<mold>.jsonl). No I/O here, so the tests drive them directly.

type Json = Record<string, any>

const OPEN = new Set(['todo', 'in_progress', 'blocked'])

/** The latest record per task id: a task file may carry the same id more than once. */
export function parseTasks(jsonl: string): Ticket[] {
  const byId = new Map<string, Ticket>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let row: Json
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row.task_id !== 'string') continue
    byId.set(row.task_id, {
      id: row.task_id,
      mold: String(row.mold_id ?? ''),
      title: String(row.title ?? ''),
      status: String(row.status ?? ''),
      priority: Number(row.priority ?? 9),
      ...(row.type ? { type: String(row.type) } : {}),
      ...(row.owner ? { owner: String(row.owner) } : {}),
      ...(row.product_id ? { product: String(row.product_id) } : {}),
      ...(row.created ? { created: String(row.created) } : {}),
      ...(row.updated ? { updated: String(row.updated) } : {}),
      ...(row.advances_stage ? { advancesStage: String(row.advances_stage) } : {}),
      ...(Array.isArray(row.deps ?? row.depends_on) ? { dependsOn: (row.deps ?? row.depends_on).map(String) } : {}),
      ...(Array.isArray(row.acceptance) ? { acceptance: row.acceptance.map(String) } : {}),
      ...(Array.isArray(row.evidence) ? { evidence: row.evidence.map(String) } : {}),
      ...(row.detail ? { detail: String(row.detail) } : {}),
      ...(row.lane ? { lane: String(row.lane) } : {}),
    })
  }
  return [...byId.values()]
}

export function moldRow(id: string, status: string, snapshot: string, tasks: readonly Ticket[]): MoldRow {
  return {
    id,
    status,
    snapshot: snapshot.slice(0, 7),
    open: tasks.filter(t => t.status === 'todo' || t.status === 'blocked').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    done: tasks.filter(t => t.status === 'done').length,
  }
}

export function openTickets(tasks: readonly Ticket[]): Ticket[] {
  return tasks
    .filter(t => OPEN.has(t.status))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}

/** The health pages to probe for one app, by where it runs; none for a retired app. */
export function healthChecks(application: Json, infrastructure: Json): Check[] {
  if (application.status === 'retired') return []
  const target = String(infrastructure.target ?? '')
  const vercel = infrastructure.vercel ?? {}
  const remote = infrastructure.vm_remote ?? {}
  const web = target === 'vm_remote' ? remote.production_url : vercel.production_url
  const checks: Check[] = []
  if (web) checks.push({ name: 'web', url: `${web}/api/ops/health`, status: 'pending' })
  if (target === 'vm_remote' && web) checks.push({ name: 'api', url: `${web}/eve/v1/health`, status: 'pending' })
  if (target !== 'vm_remote' && vercel.api_url) checks.push({ name: 'api', url: `${vercel.api_url}/eve/v1/health`, status: 'pending' })
  if (target !== 'vm_remote' && vercel.workflow_url) {
    checks.push({ name: 'workflow', url: `${vercel.workflow_url}/api/health`, status: 'pending' })
  }
  return checks
}

export function appRow(id: string, application: Json, infrastructure: Json, datastores: Json, moldSnapshots: Map<string, string>): AppRow {
  const target = String(infrastructure.target ?? '?')
  const url = target === 'vm_remote' ? infrastructure.vm_remote?.production_url : infrastructure.vercel?.production_url
  const rls = datastores.postgres?.rls_verified
  const moldId = String(application.mold_id ?? '')
  const moldCommit = String(application.mold_commit ?? '')
  const snapshot = moldSnapshots.get(moldId) ?? ''
  return {
    id,
    product: String(application.product_id ?? ''),
    target,
    status: String(application.status ?? '?'),
    moldId,
    moldCommit: moldCommit.slice(0, 7),
    isCurrent: moldCommit !== '' && moldCommit === snapshot,
    url: String(url ?? ''),
    deployedAt: String(infrastructure.deployed_at ?? ''),
    rls: rls ? `${rls.protected ?? '?'}/${rls.org_scoped_tables ?? '?'}` : '',
    checks: healthChecks(application, infrastructure),
  }
}

export function productRows(products: Json): ProductRow[] {
  return (products.products ?? []).map((p: Json) => ({
    id: String(p.product_id ?? ''),
    name: String(p.name ?? p.product_id ?? ''),
    stage: String(p.stage ?? ''),
    apps: Array.isArray(p.app_ids) ? p.app_ids.length : 0,
    moldId: String(p.mold_id ?? ''),
    appIds: Array.isArray(p.app_ids) ? p.app_ids.map(String) : [],
  }))
}

/** "3h ago" from an ISO time and now. */
export function ago(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Healthy when every probe answered 2xx; down when any did not; pending until probed. */
export function verdict(checks: readonly Check[]): 'healthy' | 'down' | 'pending' | 'n/a' {
  if (checks.length === 0) return 'n/a'
  if (checks.some(c => c.status === 'pending')) return 'pending'
  return checks.every(c => typeof c.status === 'number' && c.status >= 200 && c.status < 300) ? 'healthy' : 'down'
}

/** A mold that is announced but not yet buildable. */
export const isComingSoon = (status: string): boolean => status === 'coming_soon'

const BARS = '▁▂▃▄▅▆▇█'

/** A one-line bar chart of the values, scaled to the largest; all zero draws the lowest bar. */
export function sparkline(values: readonly (number | null)[]): string {
  const top = Math.max(0, ...values.map(v => v ?? 0))
  return values.map(v => (v === null ? ' ' : BARS[top === 0 ? 0 : Math.min(7, Math.round((v / top) * 7))])).join('')
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A report's cost_basis, or null when it says none (an older report, or nothing to cost). */
export const costBasis = (v: unknown): CostBasis | null => (v === 'recorded' || v === 'estimated' || v === 'mixed' ? v : null)

/** Is this figure (at least partly) an estimate? Then it is shown as one, never as measured. */
export const isEstimate = (basis: CostBasis | null | undefined): boolean => basis === 'estimated' || basis === 'mixed'

function numbers(raw: Json | undefined): UsageNumbers {
  const t = raw?.tickets ?? {}
  return {
    people_active: num(raw?.people_active),
    chats: num(raw?.chats),
    chat_turns: num(raw?.chat_turns),
    input_tokens: num(raw?.input_tokens),
    output_tokens: num(raw?.output_tokens),
    cost_usd: num(raw?.cost_usd),
    workflow_runs: num(raw?.workflow_runs),
    workflow_cost_usd: num(raw?.workflow_cost_usd),
    workflow_cost_basis: costBasis(raw?.workflow_cost_basis),
    tickets: { open: num(t.open), in_progress: num(t.in_progress), done: num(t.done), total: num(t.total) },
  }
}

/** The app_usage.py report, tolerant of missing fields (a missing number reads 0 and the report says what it did not measure). */
export function parseUsage(raw: Json): Usage {
  return {
    app_id: String(raw.app_id ?? ''),
    generated_at: String(raw.generated_at ?? ''),
    days: num(raw.days) ?? 30,
    totals: numbers(raw.totals),
    workspaces: (Array.isArray(raw.workspaces) ? raw.workspaces : []).map((w: Json) => ({
      ...numbers(w),
      org_id: String(w.org_id ?? ''),
      name: String(w.name ?? w.org_id ?? ''),
    })),
    daily: (Array.isArray(raw.daily) ? raw.daily : []).map((d: Json) => ({
      date: String(d.date ?? ''),
      chat_turns: num(d.chat_turns),
      people_active: num(d.people_active),
    })),
    not_measured: (Array.isArray(raw.not_measured) ? raw.not_measured : []).map(String),
    by_agent: (Array.isArray(raw.by_agent) ? raw.by_agent : []).map(
      (a: Json): AgentUsage => ({
        agent: String(a.agent ?? ''),
        kind: a.kind === 'main' ? 'main' : 'specialist',
        workspace: String(a.workspace ?? ''),
        turns: num(a.turns),
        runs: num(a.runs),
        input_tokens: num(a.input_tokens),
        output_tokens: num(a.output_tokens),
        cost_usd: num(a.cost_usd),
        cost_basis: costBasis(a.cost_basis),
        estimated_from: typeof a.estimated_from === 'string' && a.estimated_from ? a.estimated_from : null,
        last_active: String(a.last_active ?? ''),
      }),
    ),
    by_user: (Array.isArray(raw.by_user) ? raw.by_user : []).map(
      (u: Json): UserUsage => ({
        user: String(u.user ?? ''),
        workspace: String(u.workspace ?? ''),
        chats: num(u.chats),
        chat_turns: num(u.chat_turns),
        input_tokens: num(u.input_tokens),
        output_tokens: num(u.output_tokens),
        cost_usd: num(u.cost_usd),
        workflow_runs: num(u.workflow_runs),
        last_active: String(u.last_active ?? ''),
      }),
    ),
    ...(raw.error ? { error: String(raw.error) } : {}),
  }
}

/** The factory's open tickets that name this app. */
export function ticketsForApp(tickets: readonly Ticket[], appId: string): Ticket[] {
  const word = new RegExp(`(^|[^a-z0-9_])${appId.replace(/[^a-z0-9_]/gi, '')}($|[^a-z0-9_])`, 'i')
  return tickets.filter(t => word.test(t.title))
}

/** 1234567 -> "1.2M", 1234 -> "1.2k"; not measured -> "—". */
export function short(n: number | null): string {
  if (n === null) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** "$13.56", "$1,204"; not measured -> "not measured". */
export function money(n: number | null): string {
  if (n === null) return 'not measured'
  return `$${n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`
}

/** money(), and an estimate as "~$1.23 est." so it never reads as a measured figure (the board also dims it). */
export function cost(n: number | null, basis?: CostBasis | null): string {
  if (n === null || !isEstimate(basis)) return money(n)
  return `~${money(n)} est.`
}

/** a + b, null when either is not measured. */
export const plus = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

/** A product's stages, in order (state/products.json, docs/PRODUCTS.md). */
export const STAGES = ['defined', 'stamped', 'lanes_passing', 'deployed', 'released'] as const

/** The words the board shows for each stage. */
export const STAGE_WORDS: Record<string, string> = {
  defined: 'defined',
  stamped: 'built',
  lanes_passing: 'tested',
  deployed: 'deployed',
  released: 'released',
}

/** The stage after this one, or undefined at the last (or an unknown) stage. */
export function nextStage(stage: string): string | undefined {
  const at = STAGES.indexOf(stage as (typeof STAGES)[number])
  return at < 0 ? undefined : STAGES[at + 1]
}

/** The open tickets that stand between a product and the given stage. */
export function stageTickets(tickets: readonly Ticket[], productId: string, stage: string): Ticket[] {
  return tickets.filter(t => t.product === productId && t.advancesStage === stage)
}

/** Cuts text to `width` cells with an ellipsis. */
export function fit(text: string, width: number): string {
  const room = Math.max(4, Math.floor(width))
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`
}

/** Whether a ticket passes the tickets tab's filter: "all", "p1", "p2", "p3" or "app:<id>". */
export function ticketMatches(ticket: Ticket, filter: string): boolean {
  if (filter === 'all' || filter === '') return true
  if (/^p\d$/.test(filter)) return ticket.priority === Number(filter.slice(1))
  if (filter.startsWith('app:')) return ticketsForApp([ticket], filter.slice(4)).length > 0
  return true
}

/** A product-gate ticket's title without the "<product> <stage> gate: " lead the board already shows. */
export function plainTitle(t: Ticket): string {
  if (!t.product) return t.title
  const lead = new RegExp(`^${t.product.replace(/[^a-z0-9_]/gi, '')}\\s+[a-z_]+\\s+gate:\\s*`, 'i')
  const cut = t.title.replace(lead, '')
  return cut ? cut.charAt(0).toUpperCase() + cut.slice(1) : t.title
}
