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

export type ProductRow = { id: string; name: string; stage: string; apps: number; moldId: string }

export type MoldRow = { id: string; status: string; snapshot: string; open: number; inProgress: number; done: number }

export type Ticket = { id: string; mold: string; title: string; status: string; priority: number }

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

declare module 'claude-code' {
  interface PluginState {
    'factory-board': { board: Board | null; isRefreshing: boolean }
  }
}
