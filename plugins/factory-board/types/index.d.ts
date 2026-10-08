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
    }
  }
}
