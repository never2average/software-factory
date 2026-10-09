export type Check = { name: string; url: string; status: number | 'down' | 'pending' }

export type AppRow = {
  id: string
  product: string
  target: string
  status: string
  moldId: string
  moldCommit: string
  isCurrent: boolean
  url: string
  deployedAt: string
  rls: string
  checks: Check[]
}

export type ProductRow = { id: string; name: string; stage: string; apps: number; moldId: string; appIds: string[] }

export type MoldRow = { id: string; status: string; snapshot: string; open: number; inProgress: number; done: number }

export type Ticket = {
  id: string
  mold: string
  title: string
  status: string
  priority: number
  type?: string
  owner?: string
  product?: string
  created?: string
  updated?: string
  advancesStage?: string
  dependsOn?: string[]
  acceptance?: string[]
  evidence?: string[]
  detail?: string
  lane?: string
}

export type Board = {
  root: string
  loadedAt: number
  checkedAt: number
  apps: AppRow[]
  products: ProductRow[]
  molds: MoldRow[]
  tickets: Ticket[]
  error?: string
}

/** null: not measured (the report's not_measured says why); a number is a measured value, 0 included. */
export type Measured = number | null

/** How a cost was arrived at (app_usage.py): recorded by the app; estimated from tokens at the configured model; or both. */
export type CostBasis = 'recorded' | 'estimated' | 'mixed'

export type TicketCounts = { open: Measured; in_progress: Measured; done: Measured; total: Measured }

export type UsageNumbers = {
  people_active: Measured
  chats: Measured
  chat_turns: Measured
  input_tokens: Measured
  output_tokens: Measured
  cost_usd: Measured
  workflow_runs: Measured
  workflow_cost_usd: Measured
  /** Absent in an older report: read as recorded. */
  workflow_cost_basis?: CostBasis | null
  tickets: TicketCounts
}

export type AgentUsage = {
  agent: string
  kind: 'main' | 'specialist'
  workspace: string
  turns: Measured
  runs: Measured
  input_tokens: Measured
  output_tokens: Measured
  cost_usd: Measured
  /** Absent in an older report: read as recorded. estimated / mixed: shown as an estimate, never as measured. */
  cost_basis?: CostBasis | null
  /** The model an estimate was priced at, when there is one. */
  estimated_from?: string | null
  last_active: string
}

export type UserUsage = {
  user: string
  workspace: string
  chats: Measured
  chat_turns: Measured
  input_tokens: Measured
  output_tokens: Measured
  cost_usd: Measured
  workflow_runs: Measured
  last_active: string
}

export type Usage = {
  app_id: string
  generated_at: string
  days: number
  totals: UsageNumbers
  workspaces: (UsageNumbers & { org_id: string; name: string })[]
  daily: { date: string; chat_turns: Measured; people_active: Measured }[]
  not_measured: string[]
  by_agent: AgentUsage[]
  by_user: UserUsage[]
  error?: string
}

/** How an app's build figures were arrived at (mint_report.py): own, every session that names the app names no other;
 * apportioned, a session shared with other apps was split and this is the app's share (shown as "shared", dimmed). */
export type BuildBasis = 'own' | 'apportioned'

/** What it took to build one app, or the sum over a product's apps: reports/mint/<app>.json's summary. */
export type Build = {
  /** Measured by the sessions' own cost counters (then apportioned when basis says so); null: not measured. */
  cost_usd: Measured
  basis: BuildBasis | null
  /** Agent work after a session's last cost record: always an estimate, never added into cost_usd. */
  uncounted_est_usd: Measured
  agent_model_s: Measured
  agent_tool_s: Measured
  active_s: Measured
  first_message: string
  first_deploy: string
  latest_deploy: string
  deploys: Measured
  calendar_to_first_deploy_s: Measured
  sessions: Measured
  /** Each session's share of it, when apportioned. */
  shares: { session: string; basis: BuildBasis | null; share: Measured }[]
  generated_at: string
}

export type Tab = 'products' | 'molds' | 'tickets' | 'analytics'

declare module 'claude-code' {
  interface PluginState {
    'factory-board': {
      board: Board | null
      isRefreshing: boolean
      tab: Tab
      selectedApp: string
      usage: Record<string, Usage>
      isCollecting: boolean
      collectError: string
      openTicket: string
      ticketFilter: string
      builds: Record<string, Build>
      isComputing: boolean
      computeError: string
    }
  }
}
