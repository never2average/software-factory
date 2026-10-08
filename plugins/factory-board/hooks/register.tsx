import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AppRow, Board, Check } from '../types'
import { ago, appRow, isComingSoon, moldRow, openTickets, parseTasks, productRows, verdict } from './board'

const PANE = 'factory-board'
const FALLBACK_ROOT = '/root/software-factory'
const EVERY_MS = 5 * 60_000
const PROBE_MS = 10_000

const board = atom({ plugin: 'factory-board', key: 'board' } as const, null)
const isRefreshing = atom({ plugin: 'factory-board', key: 'isRefreshing' } as const, false)

type $ = EngineInterface

let root = FALLBACK_ROOT

async function readJson($: $, path: string): Promise<any> {
  return JSON.parse(await $.fs.read(path))
}

/** Reads the factory's state files into a board; health probes stay pending until `probe`. */
async function load($: $): Promise<Board> {
  const now = await $.clock.now()
  const factory = await readJson($, `${root}/state/factory.json`)
  const snapshots = new Map<string, string>(
    (factory.molds ?? []).map((m: any) => [String(m.mold_id), String(m.source?.commit ?? '')]),
  )
  const statuses = new Map<string, string>((factory.molds ?? []).map((m: any) => [String(m.mold_id), String(m.status ?? '')]))

  const apps: AppRow[] = []
  for (const entry of await $.fs.list(`${root}/state/application`)) {
    if (entry.kind !== 'dir' || entry.name === 'app_id') continue
    const dir = `${root}/state/application/${entry.name}`
    try {
      const [application, infrastructure, datastores] = await Promise.all([
        readJson($, `${dir}/application.json`),
        readJson($, `${dir}/infrastructure.json`),
        readJson($, `${dir}/datastores.json`).catch(() => ({})),
      ])
      apps.push(appRow(entry.name, application, infrastructure, datastores, snapshots))
    } catch {
      // an app folder without its state files is not an app yet
    }
  }

  const tickets = []
  const molds = []
  for (const [id, snapshot] of snapshots) {
    const text = await $.fs.read(`${root}/state/tasks/${id}.jsonl`).catch(() => '')
    const tasks = parseTasks(text)
    const status = statuses.get(id) ?? ''
    molds.push(moldRow(id, status, snapshot, tasks))
    if (!isComingSoon(status)) tickets.push(...openTickets(tasks))
  }

  const products = productRows(await readJson($, `${root}/state/products.json`).catch(() => ({})))

  return { root, loadedAt: now, checkedAt: 0, apps, products, molds, tickets }
}

/** One health page, given up on after PROBE_MS. */
async function probe($: $, check: Check): Promise<Check> {
  const answer = await Promise.race([
    $.http.fetch(check.url).then((r: { status: number }) => r.status).catch(() => 'down' as const),
    $.clock.sleep(PROBE_MS).then(() => 'down' as const),
  ])
  return { ...check, status: answer }
}

async function refresh($: $): Promise<void> {
  if (await read($, isRefreshing)) return
  await update($, isRefreshing, () => true)
  try {
    const loaded = await load($)
    await update($, board, () => loaded)
    const apps = await Promise.all(
      loaded.apps.map(async app => ({ ...app, checks: await Promise.all(app.checks.map(c => probe($, c))) })),
    )
    const checkedAt = await $.clock.now()
    await update($, board, current => (current ? { ...current, apps, checkedAt } : current))
    $.ui.status(summary(apps, loaded.tickets.length))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, board, current => ({
      ...(current ?? { root, loadedAt: 0, checkedAt: 0, apps: [], products: [], molds: [], tickets: [] }),
      error: message,
    }))
    $.ui.status('factory: could not read state')
  } finally {
    await update($, isRefreshing, () => false)
  }
}

function summary(apps: readonly AppRow[], open: number): string {
  const live = apps.filter(a => a.checks.length > 0)
  const healthy = live.filter(a => verdict(a.checks) === 'healthy').length
  const down = live.length - healthy
  return `factory: ${healthy}/${live.length} apps healthy${down ? ` · ${down} down` : ''} · ${open} open ticket${open === 1 ? '' : 's'}`
}

const COLOR = { healthy: 'success', down: 'error', pending: 'subtle', 'n/a': 'inactive' } as const

function stageColor(status: string): string {
  if (status === 'reverted') return 'error'
  if (status === 'retired') return 'inactive'
  return 'text'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (e.cwd && (await $.fs.exists(`${e.cwd}/state/factory.json`))) root = e.cwd
    await $.command.register({
      name: 'factory',
      description: 'Show the factory board: app health, deploys, product stages, open tickets (/factory refresh)',
    })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Factory board' })
    if (e.args.trim() === 'refresh' || !(await read($, board))) await refresh($)
    else void refresh($)
    const current = await read($, board)
    return { text: current ? summary(current.apps, current.tickets.length) : 'Factory board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, board)
    const busy = await read($, isRefreshing)
    const now = await $.clock.now()

    if (!current) return <Text dimColor>{busy ? 'Reading the factory state…' : 'No data yet. Run /factory refresh.'}</Text>

    return (
      <Box flexDirection="column" gap={1}>
        {current.error && <Text color="error">Could not read {current.root}/state: {current.error}</Text>}

        <Box flexDirection="column">
          <Text bold>Apps</Text>
          {current.apps.length === 0 && <Text dimColor>No apps in state/application.</Text>}
          {current.apps.map(app => {
            const health = verdict(app.checks)
            return (
              <Box flexDirection="column" key={app.id}>
                <Box flexDirection="row" gap={1}>
                  <Text bold>{app.id}</Text>
                  <Text color={COLOR[health]}>{health}</Text>
                  <Text color={stageColor(app.status)}>{app.status}</Text>
                  <Text dimColor>{app.target}</Text>
                </Box>
                <Box flexDirection="row" gap={1} paddingLeft={2}>
                  {app.checks.map(c => (
                    <Text key={c.name} color={typeof c.status === 'number' && c.status < 300 ? 'success' : c.status === 'pending' ? 'subtle' : 'error'}>
                      {c.name} {String(c.status)}
                    </Text>
                  ))}
                  {app.rls && <Text dimColor>RLS {app.rls}</Text>}
                </Box>
                <Box flexDirection="row" gap={1} paddingLeft={2}>
                  <Text dimColor>deployed {ago(app.deployedAt, now)}</Text>
                  <Text color={app.isCurrent ? 'success' : 'warning'}>
                    {app.moldId}@{app.moldCommit || '?'} {app.isCurrent ? 'current' : 'behind snapshot'}
                  </Text>
                </Box>
                {app.url && <Text dimColor wrap="truncate">  {app.url}</Text>}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Products</Text>
          {current.products.map(p => {
            const soon = isComingSoon(current.molds.find(m => m.id === p.moldId)?.status ?? '')
            return (
              <Text key={p.id}>
                {p.name}{' '}
                {soon ? <Text color="claude">coming soon</Text> : <Text color="suggestion">{p.stage}</Text>}{' '}
                <Text dimColor>({p.apps} app{p.apps === 1 ? '' : 's'})</Text>
              </Text>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Molds and tickets</Text>
          {current.molds.map(m =>
            isComingSoon(m.status) ? (
              <Text key={m.id}>
                {m.id} <Text color="claude">coming soon</Text> <Text dimColor>({m.open + m.inProgress} planned tickets)</Text>
              </Text>
            ) : (
              <Text key={m.id}>
                {m.id} <Text dimColor>@{m.snapshot}</Text>{' '}
                <Text color={m.open + m.inProgress ? 'warning' : 'success'}>
                  {m.open} open, {m.inProgress} in progress
                </Text>{' '}
                <Text dimColor>{m.done} done</Text>
              </Text>
            ),
          )}
          {current.tickets.slice(0, 12).map(t => (
            <Text key={t.id} wrap="truncate">
              <Text dimColor>{t.id}</Text> P{t.priority} {t.status === 'in_progress' ? '▶ ' : ''}{t.title}
            </Text>
          ))}
          {current.tickets.length > 12 && <Text dimColor>…and {current.tickets.length - 12} more</Text>}
        </Box>

        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label={busy ? 'Refreshing…' : 'Refresh'} onPress={() => void refresh($)} />
          <Text dimColor>
            health checked {current.checkedAt ? ago(new Date(current.checkedAt).toISOString(), now) : 'pending'} · every 5 min
          </Text>
        </Box>
      </Box>
    )
  })
}
