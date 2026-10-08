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
    { id: 'p', name: 'P', stage: 'released', apps: 1, moldId: 'mold_v2', appIds: ['a'] },
  ])
  expect(isComingSoon('coming_soon')).toBe(true)
  expect(isComingSoon('active')).toBe(false)
  const now = Date.parse('2026-10-08T12:00:00Z')
  expect(ago('2026-10-08T11:30:00Z', now)).toBe('30m ago')
  expect(ago('2026-10-08T06:00:00Z', now)).toBe('6h ago')
  expect(ago('2026-10-01T12:00:00Z', now)).toBe('7d ago')
  expect(ago('', now)).toBe('—')
})

import { money, parseUsage, plus, short, sparkline, ticketsForApp } from './board'

test('analytics helpers: sparkline, usage report, tickets per app, short numbers', async () => {
  expect(sparkline([0, 5, 10])).toBe('▁▅█')
  expect(sparkline([0, 0])).toBe('▁▁')
  const u = parseUsage({
    app_id: 'a',
    generated_at: '2026-10-08T12:00:00Z',
    days: 7,
    totals: { people_active: 3, chats: 4, chat_turns: 20, tickets: { open: 1, in_progress: 2, done: 3, total: 6 } },
    workspaces: [{ org_id: 'o', chats: 4 }],
    daily: [{ date: '2026-10-08', chat_turns: 20 }],
    not_measured: ['cost_usd: no table'],
  })
  expect(u.totals.cost_usd).toBe(null)
  expect(u.totals.tickets).toEqual({ open: 1, in_progress: 2, done: 3, total: 6 })
  expect(u.workspaces[0]?.name).toBe('o')
  expect(u.daily[0]?.people_active).toBe(null)
  expect(u.not_measured).toEqual(['cost_usd: no table'])
  const tickets = [
    { id: '1', mold: 'm', title: 'Lane fail: functional on onfinance_hfc — 1 check', status: 'todo', priority: 1 },
    { id: '2', mold: 'm', title: 'Lane fail: functional on onfinance_hfc_vm — 1 check', status: 'todo', priority: 1 },
  ]
  expect(ticketsForApp(tickets, 'onfinance_hfc').map(t => t.id)).toEqual(['1'])
  expect(ticketsForApp(tickets, 'onfinance_hfc_vm').map(t => t.id)).toEqual(['2'])
  expect(short(1234)).toBe('1.2k')
  expect(short(2_500_000)).toBe('2.5M')
  expect(short(42)).toBe('42')
  expect(short(null)).toBe('—')
  expect(money(null)).toBe('not measured')
  expect(money(13.564)).toBe('$13.56')
  expect(money(0)).toBe('$0.00')
  expect(plus(1, null)).toBe(null)
  expect(sparkline([1, null, 2])).toBe('▅ █')
})

import { fit, nextStage, stageTickets, ticketMatches } from './board'

test('stages, the tickets standing before the next one, filters and fitting', async () => {
  expect(nextStage('stamped')).toBe('lanes_passing')
  expect(nextStage('released')).toBe(undefined)
  const t = [
    { id: 'a', mold: 'm', title: 'on demo_app', status: 'todo', priority: 1, product: 'p', advancesStage: 'deployed' },
    { id: 'b', mold: 'm', title: 'other', status: 'todo', priority: 2, product: 'p', advancesStage: 'released' },
  ]
  expect(stageTickets(t, 'p', 'deployed').map(x => x.id)).toEqual(['a'])
  expect(t.filter(x => ticketMatches(x, 'p2')).map(x => x.id)).toEqual(['b'])
  expect(t.filter(x => ticketMatches(x, 'app:demo_app')).map(x => x.id)).toEqual(['a'])
  expect(t.filter(x => ticketMatches(x, 'all')).length).toBe(2)
  expect(fit('abcdefghij', 6)).toBe('abcde…')
  expect(fit('abc', 6)).toBe('abc')
})

import { plainTitle } from './board'

test('a gate ticket drops its product and stage lead', async () => {
  const t = { id: 'x', mold: 'm', title: 'onfinance_hfc_research released gate: docs + pricing decided', status: 'todo', priority: 2, product: 'onfinance_hfc_research' }
  expect(plainTitle(t)).toBe('Docs + pricing decided')
  expect(plainTitle({ ...t, product: undefined })).toBe(t.title)
})
