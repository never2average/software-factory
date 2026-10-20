import { expect, mock, test } from 'claude-code/testing'

// A small factory with one Vercel app whose database (Neon, free plan) is at 85% of its compute limit, and whose health
// page answers 503 with the app's parts' state because the database refused work: what happened on 2026-10-19.
const ROOT = '/root/software-factory'

const HEALTH_503 = JSON.stringify({
  ok: false,
  checkedAt: 't',
  db: { ok: false, detail: 'Your project has exceeded the compute time quota. Upgrade your plan to increase limits.', ms: 40 },
  blob: { ok: true, detail: 'write → head → delete ok', ms: 9 },
  inference: { ok: true, detail: 'agent ready', ms: 5 },
  taskWorkflow: { ok: true, detail: 'ready', ms: 3 },
})

const WARNING =
  "demo: database at 85.2% of the Neon Free plan's compute time limit (85.25 of 100 CU-hours). Change the Neon plan from Free to Launch (paid) in Vercel (Integrations → Neon → change plan)."

/** The board's clock in these tests; a report measured `ageMs` before it. */
const T = Date.parse('2026-10-20T08:00:00Z')

const files = (warn: boolean, ageMs = 5 * 60_000): Record<string, string> => ({
  [`${ROOT}/state/factory.json`]: JSON.stringify({ molds: [{ mold_id: 'mold_v1', status: 'active', source: { commit: 'abc1234def' } }] }),
  [`${ROOT}/state/products.json`]: JSON.stringify({ products: [] }),
  [`${ROOT}/state/application/demo/application.json`]: JSON.stringify({ mold_id: 'mold_v1', status: 'stamped' }),
  [`${ROOT}/state/application/demo/infrastructure.json`]: JSON.stringify({
    target: 'vercel',
    vercel: { production_url: 'https://demo.example.test' },
  }),
  [`${ROOT}/.claude/scripts/lib/db_usage.py`]: '# stand-in',
  [`${ROOT}/reports/db-usage/demo.json`]: JSON.stringify({
    app_id: 'demo',
    generated_at: new Date(T - ageMs).toISOString(),
    provider: 'neon',
    resource: 'demo-db',
    plan: { id: 'free_v3', name: 'Free', paid: false },
    quota_exceeded: false,
    limits: [{ name: 'Compute time', limit: 100, unit: 'CU-hours', used: warn ? 85.25 : 40, pct: warn ? 85.2 : 40, source: 'vercel' }],
    usage: [{ name: 'Compute', value: warn ? 85.25 : 40, unit: 'hours' }],
    not_measured: ['Storage (1 GB per project): the provider reports no figure for it'],
    warnings: warn ? [{ limit: 'Compute time', pct: 85.2, level: 'warn', text: WARNING }] : [],
    upgrade: '',
  }),
})

for (const surface of ['terminal', 'desktop'] as const) {
  for (const warn of [true, false]) {
    test(`database usage and why an app is down (${surface}, ${warn ? '85% of a limit, down' : '40%, up'})`, async ($, on) => {
      mock.clock(on, { now: T })
      const FILES = files(warn)
      const statuses: string[] = []
      const runs: string[][] = []
      on('ui.status', async (_$, e) => {
        statuses.push(String((e as any).text ?? (e as any).value ?? e))
        return { value: undefined }
      })
      on('fs.read', async (_$, e) => {
        const text = FILES[e.path]
        return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
      })
      on('fs.list', async () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
      on('fs.exists', async (_$, e) => ({ value: e.path in FILES }))
      on('ui.open', async () => ({ value: { isPlaced: true as const } }))
      on('http.fetch', async () => ({
        value: warn ? { status: 503, ok: false, headers: {}, text: HEALTH_503 } : { status: 200, ok: true, headers: {}, text: '{"ok":true}' },
      }))
      on('process.run', async (_$, e) => {
        runs.push([...((e as any).argv ?? (e as any).command ?? [])].map(String))
        return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })

      await $.command.run({ command: 'factory', args: 'refresh' } as any)
      const props = { title: 'Factory board', isFocused: true, bodyColumns: 160, placement: 'dock' } as any
      const ui = await $.ui.mount({ plugin: 'factory-board', surface, component: 'Pane', requestId: 'factory-board', props })

      // /factory refresh runs the read-only usage check, which may file a ticket at 80%
      expect(runs.some(r => r.join(' ').includes('db_usage.py --all --write --file-tickets'))).toBe(true)
      const dbText = String((await ui.find({ key: 'db-demo' }))?.text ?? '')
      if (warn) {
        expect(dbText.includes('database: Neon Free · compute time 85.25/100 CU-hours (85%) · not measured: Storage')).toBe(true)
        expect(await ui.find({ key: 'db-usage-banner' })).toBeDefined()
        const banner = String((await ui.find({ key: 'db-usage-banner' }))?.text ?? '')
        expect(banner.includes('! A database is near its plan limit.')).toBe(true)
        expect(banner.includes(WARNING)).toBe(true)
        // down, and why: the failing part and its cause from the health page, not only "down"
        const why = String((await ui.find({ key: 'why-demo' }))?.text ?? '')
        expect(why.includes('why: web 503: database: the request was refused (usage limit?)')).toBe(true)
        expect(why.includes('exceeded the compute time quota')).toBe(false)
        expect(statuses.some(s => s.includes('1 down: demo (database: the request was refused (usage limit?))'))).toBe(true)
        // the banner stays on every tab
        await ui.press({ key: 'tab-tickets' })
        expect(await ui.find({ key: 'db-usage-banner' })).toBeDefined()
      } else {
        expect(dbText.includes('database: Neon Free · compute time 40/100 CU-hours (40%)')).toBe(true)
        expect(dbText.includes('measured 5m ago')).toBe(true)
        expect(await ui.find({ key: 'db-usage-banner' })).toBeUndefined()
        expect(await ui.find({ key: 'why-demo' })).toBeUndefined()
        expect(statuses.some(s => s.includes('down'))).toBe(false)
      }
    })
  }
}

// Opening the board without "refresh": a report from three days ago that said 40% is not shown as a calm ok, and the board
// measures again at once; a fresh report is left alone (the systemd timer and the 30-minute tick keep it fresh).
for (const surface of ['terminal', 'desktop'] as const) {
  for (const stale of [true, false]) {
    test(`opening the board re-measures a stale database report (${surface}, ${stale ? '3 days old' : '5 minutes old'})`, async ($, on) => {
      mock.clock(on, { now: T })
      const FILES = files(false, stale ? 3 * 24 * 3_600_000 : 5 * 60_000)
      const runs: string[][] = []
      on('ui.status', async () => ({ value: undefined }))
      on('fs.read', async (_$, e) => {
        const text = FILES[e.path]
        return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
      })
      on('fs.list', async () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
      on('fs.exists', async (_$, e) => ({ value: e.path in FILES || e.path === `${ROOT}/reports/db-usage` }))
      on('ui.open', async () => ({ value: { isPlaced: true as const } }))
      on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }))
      on('process.run', async (_$, e) => {
        runs.push([...((e as any).argv ?? (e as any).command ?? [])].map(String))
        return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })

      await $.command.run({ command: 'factory', args: '' } as any)
      const props = { title: 'Factory board', isFocused: true, bodyColumns: 160, placement: 'dock' } as any
      const ui = await $.ui.mount({ plugin: 'factory-board', surface, component: 'Pane', requestId: 'factory-board', props })

      const measured = runs.some(r => r.join(' ').includes('db_usage.py --all --write --file-tickets'))
      expect(measured).toBe(stale)
      const dbText = String((await ui.find({ key: 'db-demo' }))?.text ?? '')
      if (stale) {
        expect(dbText.includes('database: not measured since 3d ago (stale) · last: Neon Free · compute time 40/100 CU-hours (40%)')).toBe(true)
      } else {
        expect(dbText.includes('database: Neon Free · compute time 40/100 CU-hours (40%)')).toBe(true)
        expect(dbText.includes('stale')).toBe(false)
      }
    })
  }
}
