import { expect, mock, test } from 'claude-code/testing'

// mold_v0-185: a small factory with the audit app (mold_v0, Vercel) and a mold_v1 app, and the spend heartbeat's last beat:
// the "Lane check" account at its $50 allowance (it ran
// out that day), the "Customer A" account at $200 of $250 (80%: amber), and a live build.
const ROOT = '/root/software-factory'
const T = Date.parse('2026-10-31T07:30:00Z')

const LANE_LIMIT =
  'sample_app: the Lane check account has used all of its $50.00 allowance for 2026-10 ($50.01 spent): no run can start until it is raised or the month ends'

const beat = (limit: boolean, ageMs = 30_000) => ({
  generated_at: new Date(T - ageMs).toISOString(),
  apps: {
    sample_app: {
      app_id: 'sample_app',
      measured_at: new Date(T - ageMs).toISOString(),
      month: '2026-10',
      source: 'runs',
      today_usd: 41.1539,
      month_usd: 50.0089,
      month_recorded_usd: 49.9143,
      today_runs: 6,
      month_runs: 18,
      in_flight: 0,
      last_run: { workspace: 'Lane check', kind: 'sample_app/probe_agent_graph', status: 'failed', cost_usd: 2.2866, at: '2026-10-31T04:18:09+00:00' },
      last_activity: '2026-10-31T04:18:09+00:00',
      accounts: [
        limit
          ? { workspace: 'Lane check', org_id: 3, used_usd: 50.0089, limit_usd: 50, source: 'override', pct: 100, level: 'limit', prev_month: { month: '2026-09', used_usd: 0, runs: 0, level: 'ok' } }
          : { workspace: 'Lane check', org_id: 3, used_usd: 20, limit_usd: 50, source: 'override', pct: 40, level: 'ok', prev_month: null },
        { workspace: 'Customer A', org_id: 1, used_usd: 200, limit_usd: 250, source: 'override', pct: 80, level: 'warn', prev_month: null },
      ],
      kinds: [{ workspace: 'Lane check', pack: 'sample_app', kind: 'probe_cicd_env', month_runs: 1, used_usd: 16.6332, limit_usd: 500, pct: 3.3, level: 'ok' }],
      not_measured: [],
      warnings: limit ? [{ workspace: 'Lane check', level: 'limit', pct: 100, text: LANE_LIMIT }] : [],
      active: true,
      building: true,
      cached: false,
      build: { cost_usd: 34.0, uncounted_est_usd: 2.5, basis: 'own', live_sessions: ['9129ce07'], unreported_sessions: [], live_from: null },
    },
    hfc: {
      app_id: 'hfc',
      measured_at: new Date(T - ageMs).toISOString(),
      today_usd: null,
      month_usd: null,
      accounts: [],
      kinds: [],
      error: "not measured by the heartbeat: a mold_v1 app's spend is in its usage report (chat turns are priced with its own price table)",
      active: true,
      building: true,
    },
  },
})

const files = (limit: boolean): Record<string, string> => ({
  [`${ROOT}/state/factory.json`]: JSON.stringify({
    molds: [
      { mold_id: 'mold_v0', status: 'active', source: { commit: 'abc1234def' } },
      { mold_id: 'mold_v1', status: 'active', source: { commit: 'fff1234def' } },
    ],
  }),
  [`${ROOT}/state/products.json`]: JSON.stringify({ products: [{ product_id: 'shell', name: 'MCP product shell', stage: 'deployed', mold_id: 'mold_v0', app_ids: ['sample_app'] }] }),
  [`${ROOT}/state/application/sample_app/application.json`]: JSON.stringify({ mold_id: 'mold_v0', status: 'stamped', product_id: 'shell' }),
  [`${ROOT}/state/application/sample_app/infrastructure.json`]: JSON.stringify({
    target: 'vercel',
    vercel: { production_url: 'https://sample-app.example.test', api_url: 'https://sample-app-api.example.test', projects: { api: 'sample-app-api', web: 'sample-app' } },
  }),
  [`${ROOT}/state/application/hfc/application.json`]: JSON.stringify({ mold_id: 'mold_v1', status: 'stamped' }),
  [`${ROOT}/state/application/hfc/infrastructure.json`]: JSON.stringify({ target: 'vercel', vercel: { production_url: 'https://hfc.example.test' } }),
  [`${ROOT}/.claude/scripts/app_usage.py`]: '# stand-in',
  [`${ROOT}/reports/mint/sample_app.json`]: JSON.stringify({ generated_at: '2026-10-31T07:00:00Z', summary: { build_cost_usd: 29, build_cost_basis: 'own', deploys: 3 } }),
  [`${ROOT}/reports/spend/heartbeat.json`]: JSON.stringify(beat(limit)),
})

for (const surface of ['terminal', 'desktop'] as const) {
  for (const limit of [true, false]) {
    test(`the spend heartbeat: status line, allowance bars and the limit banner (${surface}, ${limit ? 'an allowance reached' : 'under it'})`, async ($, on) => {
      mock.clock(on, { now: T })
      const FILES = files(limit)
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
      on('fs.list', async () => ({
        value: ['sample_app', 'hfc'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
      }))
      on('fs.exists', async (_$, e) => ({ value: e.path in FILES }))
      on('ui.open', async () => ({ value: { isPlaced: true as const } }))
      on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }))
      on('process.run', async (_$, e) => {
        runs.push([...((e as any).argv ?? (e as any).command ?? [])].map(String))
        return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })

      await $.command.run({ command: 'factory', args: 'analytics sample_app' } as any)
      const props = { title: 'Factory board', isFocused: true, bodyColumns: 170, placement: 'dock' } as any
      const ui = await $.ui.mount({ plugin: 'factory-board', surface, component: 'Pane', requestId: 'factory-board', props })

      // opening the board starts the heartbeat, which may file one ticket at a reached allowance
      expect(runs.some(r => r.join(' ') === `python3 ${ROOT}/.claude/scripts/app_usage.py --spend --json --file-tickets`), 'check 1').toBe(true)
      // the status line: each active app's spend today / this month; an unmeasured one says so, never $0
      expect(statuses.some(s => s.includes('hfc spend not measured; sample_app $41.15 today · $50.01 Oct')), 'check 2').toBe(true)
      expect(statuses.some(s => s.includes('hfc $0.00'))).toBe(false)

      // Analytics: spend now, then one bar per account: red at the limit, amber at 80%
      const line = String((await ui.find({ key: 'spend-line' }))?.text ?? '')
      expect(line.includes('$41.15 today · $50.01 in Oct (runs recorded $49.91) · last run sample_app/probe_agent_graph $2.29 failed 3h ago'), 'check 3').toBe(true)
      const bar = async (text: string) => (await ui.findAll({ type: 'Text' })).find(t => t.text === text)
      const ofa = await bar('████████████████░░░░ 80%')
      expect(ofa?.props.color).toBe('warning')
      expect(String((await ui.find({ key: 'allowance-Customer A' }))?.text).includes('$200.00 of $250.00 in Oct · 80% used'), 'check 4').toBe(true)
      expect(String((await ui.find({ key: 'kind-Lane check-sample_app/probe_cicd_env' }))?.text).includes('$16.63 of $500.00 · 1 runs'), 'check 8').toBe(true)
      if (limit) {
        expect((await bar('████████████████████ 100%'))?.props.color).toBe('error')
        expect(String((await ui.find({ key: 'allowance-Lane check' }))?.text).includes('$50.01 of $50.00 in Oct · LIMIT REACHED: no run can start'), 'check 5').toBe(true)
        const banner = String((await ui.find({ key: 'spend-banner' }))?.text ?? '')
        expect(banner.includes('An account has used its whole allowance'), 'check 6').toBe(true)
        expect(banner.includes(LANE_LIMIT), 'check 7').toBe(true)
        // the banner stays on every tab
        await ui.press({ key: 'tab-tickets' })
        expect(await ui.find({ key: 'spend-banner' })).toBeDefined()
      } else {
        const lane = await bar('████████░░░░░░░░░░░░ 40%')
        expect(lane).toBeDefined()
        expect(lane?.props.color).toBeUndefined()
        expect(await ui.find({ key: 'spend-banner' })).toBeUndefined()
      }

      // the mold_v1 app: not measured, and why
      await ui.press({ key: 'tab-analytics' })
      await ui.press({ key: 'app-hfc' })
      expect(String((await ui.find({ key: 'spend-error' }))?.text).includes('not measured: not measured by the heartbeat'), 'check 9').toBe(true)

      // Products & apps: the build line is the heartbeat's live figure over the hourly report; the estimate stays ~ est.
      await ui.press({ key: 'tab-products' })
      expect(await ui.find({ text: 'built: $34.00' })).toBeDefined()
      expect(await ui.find({ text: '+ ~$2.50 est.' })).toBeDefined()
      expect(await ui.find({ text: '· live (1 session now)' })).toBeDefined()
    })
  }
}

// Before the board is opened in a session the heartbeat queries nothing (the status line reads the last beat); a beat
// older than five minutes says when it was measured.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a stale beat says when it was measured (${surface})`, async ($, on) => {
    mock.clock(on, { now: T })
    const FILES: Record<string, string> = { ...files(false), [`${ROOT}/reports/spend/heartbeat.json`]: JSON.stringify(beat(false, 2 * 3_600_000)) }
    const statuses: string[] = []
    on('ui.status', async (_$, e) => {
      statuses.push(String((e as any).text ?? (e as any).value ?? e))
      return { value: undefined }
    })
    on('fs.read', async (_$, e) => {
      const text = FILES[e.path]
      return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
    })
    on('fs.list', async () => ({ value: ['sample_app', 'hfc'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
    on('fs.exists', async (_$, e) => ({ value: e.path in FILES }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }))
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    await $.command.run({ command: 'factory', args: '' } as any)
    const props = { title: 'Factory board', isFocused: true, bodyColumns: 170, placement: 'dock' } as any
    await $.ui.mount({ plugin: 'factory-board', surface, component: 'Pane', requestId: 'factory-board', props })
    expect(statuses.some(s => s.includes('sample_app $41.15 today · $50.01 Oct (as of 2h ago)')), 'check 10').toBe(true)
  })
}
