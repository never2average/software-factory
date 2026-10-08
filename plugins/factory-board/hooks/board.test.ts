import { expect, test } from 'claude-code/testing'

import { ago, appRow, healthChecks, isComingSoon, moldRow, openTickets, parseTasks, productRows, verdict } from './board'

const TASKS = [
  { task_id: 'm-1', mold_id: 'mold_v1', title: 'old', status: 'todo', priority: 2 },
  { task_id: 'm-1', mold_id: 'mold_v1', title: 'old', status: 'done', priority: 2 },
  { task_id: 'm-2', mold_id: 'mold_v1', title: 'second', status: 'in_progress', priority: 3 },
  { task_id: 'm-3', mold_id: 'mold_v1', title: 'first', status: 'todo', priority: 1 },
]
  .map(t => JSON.stringify(t))
  .join('\n')

test('the latest record of a task wins, and open tickets sort by priority', async () => {
  const tasks = parseTasks(`${TASKS}\nnot json\n`)
  expect(tasks.length).toBe(3)
  expect(openTickets(tasks).map(t => t.id)).toEqual(['m-3', 'm-2'])
  expect(moldRow('mold_v1', 'active', 'abcdef0123', tasks)).toEqual({
    id: 'mold_v1',
    status: 'active',
    snapshot: 'abcdef0',
    open: 1,
    inProgress: 1,
    done: 1,
  })
})

test('a Vercel app probes web, api and workflow; a self-hosted one web and api; a retired one nothing', async () => {
  const vercel = { target: 'vercel', vercel: { production_url: 'https://a.app', api_url: 'https://a-api.app', workflow_url: 'https://a-wf.app' } }
  expect(healthChecks({ status: 'stamped' }, vercel).map(c => c.url)).toEqual([
    'https://a.app/api/ops/health',
    'https://a-api.app/eve/v1/health',
    'https://a-wf.app/api/health',
  ])
  const remote = { target: 'vm_remote', vm_remote: { production_url: 'https://h.example' } }
  expect(healthChecks({ status: 'stamped' }, remote).map(c => c.name)).toEqual(['web', 'api'])
  expect(healthChecks({ status: 'retired' }, vercel)).toEqual([])
})

test('an app row says whether it runs the current mold snapshot, and its RLS proof', async () => {
  const row = appRow(
    'x',
    { mold_id: 'mold_v1', mold_commit: 'abc1234ffff', status: 'stamped', product_id: 'p' },
    { target: 'vm_remote', deployed_at: '2026-10-07T10:00:00Z', vm_remote: { production_url: 'https://h.example' } },
    { postgres: { rls_verified: { protected: 62, org_scoped_tables: 62 } } },
    new Map([['mold_v1', 'abc1234ffff']]),
  )
  expect(row.isCurrent).toBe(true)
  expect(row.moldCommit).toBe('abc1234')
  expect(row.rls).toBe('62/62')
  expect(row.url).toBe('https://h.example')
})

test('health verdicts, products, coming soon and ages', async () => {
  expect(verdict([])).toBe('n/a')
  expect(verdict([{ name: 'web', url: '', status: 'pending' }])).toBe('pending')
  expect(verdict([{ name: 'web', url: '', status: 200 }, { name: 'api', url: '', status: 200 }])).toBe('healthy')
  expect(verdict([{ name: 'web', url: '', status: 200 }, { name: 'api', url: '', status: 'down' }])).toBe('down')
  expect(verdict([{ name: 'web', url: '', status: 503 }])).toBe('down')
  expect(productRows({ products: [{ product_id: 'p', name: 'P', stage: 'released', app_ids: ['a'], mold_id: 'mold_v2' }] })).toEqual([
    { id: 'p', name: 'P', stage: 'released', apps: 1, moldId: 'mold_v2' },
  ])
  expect(isComingSoon('coming_soon')).toBe(true)
  expect(isComingSoon('active')).toBe(false)
  const now = Date.parse('2026-10-08T12:00:00Z')
  expect(ago('2026-10-08T11:30:00Z', now)).toBe('30m ago')
  expect(ago('2026-10-08T06:00:00Z', now)).toBe('6h ago')
  expect(ago('2026-10-01T12:00:00Z', now)).toBe('7d ago')
  expect(ago('', now)).toBe('—')
})
