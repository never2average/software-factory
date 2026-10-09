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

import { cost, isEstimate, money, parseUsage, plus, short, sparkline, ticketsForApp } from './board'

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
  expect(u.by_agent).toEqual([])
  const v = parseUsage({ by_agent: [{ agent: 'main agent', kind: 'main', turns: 5 }], by_user: [{ user: 'Member 1', chats: 2 }] })
  expect(v.by_agent[0]?.turns).toBe(5)
  expect(v.by_agent[0]?.runs).toBe(null)
  expect(v.by_user[0]?.user).toBe('Member 1')
  expect(v.by_user[0]?.cost_usd).toBe(null)
  // cost_basis is optional: an older report has none, and its costs read as recorded
  expect(v.by_agent[0]?.cost_basis).toBe(null)
  expect(v.totals.workflow_cost_basis).toBe(null)
  const e = parseUsage({
    totals: { workflow_cost_usd: 6.2364, workflow_cost_basis: 'estimated' },
    workspaces: [{ org_id: 'o', workflow_cost_usd: 1, workflow_cost_basis: 'mixed' }],
    by_agent: [
      { agent: 'lodr-filings', kind: 'specialist', runs: 66, cost_usd: 2.4266, cost_basis: 'estimated', estimated_from: '@cf/zai-org/glm-5.3' },
      { agent: 'research', kind: 'specialist', runs: 2, cost_usd: 0.04, cost_basis: 'recorded', estimated_from: null },
      { agent: 'odd', kind: 'specialist', runs: 1, cost_usd: 1, cost_basis: 'guessed' },
    ],
  })
  expect(e.totals.workflow_cost_basis).toBe('estimated')
  expect(e.workspaces[0]?.workflow_cost_basis).toBe('mixed')
  expect(e.by_agent.map(a => [a.cost_basis, a.estimated_from])).toEqual([
    ['estimated', '@cf/zai-org/glm-5.3'],
    ['recorded', null],
    [null, null],
  ])
  expect(cost(e.by_agent[0]!.cost_usd, e.by_agent[0]!.cost_basis)).toBe('~$2.43 est.')
  expect(cost(e.totals.workflow_cost_usd, 'mixed')).toBe('~$6.24 est.')
  expect(cost(0.04, 'recorded')).toBe('$0.04')
  expect(cost(0.04, null)).toBe('$0.04')
  expect(cost(null, 'estimated')).toBe('not measured')
  expect([isEstimate('estimated'), isEstimate('mixed'), isEstimate('recorded'), isEstimate(null)]).toEqual([true, true, false, false])
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

import { buildParts, duration, parseBuild, sumBuilds } from './board'

const SUMMARY = {
  build_cost_usd: 1298.66,
  build_cost_basis: 'apportioned',
  build_cost_uncounted_est_usd: 37.62,
  build_cost_shares: [{ session: '9129ce07', basis: 'apportioned', share: 0.3318 }],
  agent_model_s: 60935,
  agent_tool_s: 147470,
  active_s: 45553,
  first_message: '2026-09-18T12:16:38.506Z',
  first_deploy: '2026-09-19T09:49:59+00:00',
  latest_deploy: '2026-10-09T09:14:15+00:00',
  deploys: 70,
  calendar_to_first_deploy_s: 77600,
  sessions: 1,
}

test('build cost: a mint report reads with its basis, and what is missing stays not measured', async () => {
  const b = parseBuild({ generated_at: '2026-10-09T12:00:00Z', summary: SUMMARY })
  expect([b.cost_usd, b.basis, b.uncounted_est_usd, b.deploys, b.shares[0]?.share]).toEqual([1298.66, 'apportioned', 37.62, 70, 0.3318])
  // an older report has no summary: every figure is null (not measured), never 0
  const old = parseBuild({ app_id: 'x', sessions: [] })
  expect([old.cost_usd, old.basis, old.agent_model_s, old.deploys, old.first_message]).toEqual([null, null, null, null, ''])
  expect(parseBuild({ summary: { build_cost_basis: 'guessed', first_message: 'not a time' } }).basis).toBe(null)
  expect(duration(300)).toBe('5m')
  expect(duration(18720)).toBe('5h 12m')
  expect(duration(187200)).toBe('2d 4h')
  expect(duration(null)).toBe('not measured')
  // apportioned and estimated parts are dimmed and marked; first message → live and deploys are not
  expect(buildParts(b)).toEqual([
    { text: 'built: $1,299 (shared)', dim: true },
    { text: '+ ~$37.62 est.', dim: true },
    { text: '· agent 16h 55m', dim: true },
    { text: '· active 12h 39m', dim: true },
    { text: '· first message → live 21h 33m', dim: false },
    { text: '· 70 deploys', dim: false },
  ])
  const own = parseBuild({ summary: { ...SUMMARY, build_cost_usd: 12.5, build_cost_basis: 'own', build_cost_uncounted_est_usd: null, deploys: 1 } })
  expect(buildParts(own).map(p => p.text)).toEqual([
    'built: $12.50',
    '· agent 16h 55m',
    '· active 12h 39m',
    '· first message → live 21h 33m',
    '· 1 deploy',
  ])
  expect(buildParts(own).some(p => p.dim)).toBe(false)
  expect(buildParts(old).map(p => p.text)).toEqual([
    'built: not measured',
    '· agent not measured',
    '· active not measured',
    '· first message → live not measured',
    '· deploys not measured',
  ])
  expect(buildParts(undefined)).toEqual([{ text: 'built: not measured', dim: true }])
})

test('a product total sums its apps, is apportioned when any part is, and counts a shared session once', async () => {
  const hfc = parseBuild({ summary: SUMMARY })
  const vm = parseBuild({
    summary: {
      ...SUMMARY,
      build_cost_usd: 243.12,
      build_cost_uncounted_est_usd: 19.16,
      agent_model_s: 11407,
      active_s: 8528,
      first_message: '2026-10-03T12:38:58.837Z',
      first_deploy: '2026-10-04T10:39:12+00:00',
      latest_deploy: '2026-10-09T10:41:04+00:00',
      deploys: 24,
    },
  })
  const total = sumBuilds([hfc, vm])!
  expect(Math.round(total.cost_usd! * 100) / 100).toBe(1541.78)
  expect(Math.round(total.uncounted_est_usd! * 100) / 100).toBe(56.78)
  expect([total.basis, total.deploys, total.sessions, total.agent_model_s]).toEqual(['apportioned', 94, 1, 72342])
  expect([total.first_message, total.first_deploy, total.latest_deploy]).toEqual([SUMMARY.first_message, SUMMARY.first_deploy, '2026-10-09T10:41:04+00:00'])
  expect(total.calendar_to_first_deploy_s).toBe(77600.494)
  expect(sumBuilds([])).toBe(null)
  // an app without figures adds nothing, and is not read as 0 when it is the only one
  const blank = parseBuild({})
  expect(sumBuilds([blank])!.cost_usd).toBe(null)
  expect(sumBuilds([blank, hfc])!.cost_usd).toBe(1298.66)
  expect(sumBuilds([parseBuild({ summary: { ...SUMMARY, build_cost_basis: 'own' } })])!.basis).toBe('own')
})
