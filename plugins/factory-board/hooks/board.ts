import type { AppRow, Check, MoldRow, ProductRow, Ticket } from '../types'

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
