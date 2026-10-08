import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AppRow, Board, Check, Tab, Ticket, Usage } from '../types'
import {
  STAGES,
  STAGE_WORDS,
  ago,
  fit,
  nextStage,
  plainTitle,
  stageTickets,
  ticketMatches,
  appRow,
  isComingSoon,
  money,
  moldRow,
  openTickets,
  parseTasks,
  parseUsage,
  plus,
  productRows,
  short,
  sparkline,
  ticketsForApp,
  verdict,
} from './board'

const PANE = 'factory-board'
const FALLBACK_ROOT = '/root/software-factory'
const EVERY_MS = 5 * 60_000
const USAGE_EVERY_MS = 30 * 60_000
const PROBE_MS = 10_000
const COLLECT_MS = 5 * 60_000

const board = atom({ plugin: 'factory-board', key: 'board' } as const, null)
const isRefreshing = atom({ plugin: 'factory-board', key: 'isRefreshing' } as const, false)
const tab = atom({ plugin: 'factory-board', key: 'tab' } as const, 'products')
const selectedApp = atom({ plugin: 'factory-board', key: 'selectedApp' } as const, '')
const usage = atom({ plugin: 'factory-board', key: 'usage' } as const, {})
const isCollecting = atom({ plugin: 'factory-board', key: 'isCollecting' } as const, false)
const collectError = atom({ plugin: 'factory-board', key: 'collectError' } as const, '')
const openTicket = atom({ plugin: 'factory-board', key: 'openTicket' } as const, '')
const ticketFilter = atom({ plugin: 'factory-board', key: 'ticketFilter' } as const, 'all')

type $ = EngineInterface

let root = FALLBACK_ROOT

async function readJson($: $, path: string): Promise<any> {
  return JSON.parse(await $.fs.read(path))
}

/* ---- the factory's records ------------------------------------------------------------------------------------ */

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
    $.http.fetch(check.url).then(r => r.status).catch(() => 'down' as const),
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
    if (!(await read($, selectedApp))) {
      const first = apps.find(a => a.status !== 'retired')
      if (first) await update($, selectedApp, () => first.id)
    }
    await readUsage($, apps)
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

/* ---- usage analytics: reports/usage/<app>.json, written by .claude/scripts/app_usage.py -------------------------- */

async function readUsage($: $, apps: readonly AppRow[]): Promise<void> {
  const found: Record<string, Usage> = {}
  for (const app of apps) {
    const raw = await readJson($, `${root}/reports/usage/${app.id}.json`).catch(() => null)
    if (raw) found[app.id] = parseUsage(raw)
  }
  await update($, usage, () => found)
}

/** Runs the read-only collector for every app, then reads what it wrote. */
async function collect($: $): Promise<void> {
  if (await read($, isCollecting)) return
  await update($, isCollecting, () => true)
  await update($, collectError, () => '')
  try {
    const script = `${root}/.claude/scripts/app_usage.py`
    if (!(await $.fs.exists(script))) {
      await update($, collectError, () => 'The usage collector (.claude/scripts/app_usage.py) is not in this factory yet.')
      return
    }
    const ran = await $.process.run(['python3', script, '--all'], { cwd: root, timeoutMs: COLLECT_MS })
    if (ran.exitCode !== 0) {
      const why = (ran.stderr || ran.stdout).trim().split('\n').slice(-1)[0] ?? ''
      await update($, collectError, () => `The usage collector stopped (exit ${ran.exitCode}). ${why}`.trim())
    }
    const current = await read($, board)
    if (current) await readUsage($, current.apps)
  } catch (error) {
    await update($, collectError, () => (error instanceof Error ? error.message : String(error)))
  } finally {
    await update($, isCollecting, () => false)
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

const TABS: { id: Tab; label: string }[] = [
  { id: 'products', label: 'Products' },
  { id: 'apps', label: 'Apps' },
  { id: 'molds', label: 'Molds' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'analytics', label: 'Analytics' },
]


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (e.cwd && (await $.fs.exists(`${e.cwd}/state/factory.json`))) root = e.cwd
    await $.command.register({
      name: 'factory',
      description: 'Factory board: products, apps, molds, tickets, analytics (/factory products|apps|molds|tickets|analytics [app]|refresh|<ticket id>)',
    })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    $.clock.every(USAGE_EVERY_MS, () => void collect($))
    return started
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    const [word = '', target = ''] = e.args.trim().split(/\s+/)
    const arg = word
    if (word === 'analytics' && target) await update($, selectedApp, () => target)
    if (arg === 'products' || arg === 'apps' || arg === 'molds' || arg === 'tickets' || arg === 'analytics') await update($, tab, () => arg)
    else if (/^[a-z0-9_]+-\d+$/i.test(arg)) {
      await update($, openTicket, () => arg)
      await update($, tab, () => 'tickets')
    }
    await $.ui.open({ id: PANE, title: 'Factory board' })
    if (arg === 'refresh' || !(await read($, board))) await refresh($)
    else void refresh($)
    if (arg === 'analytics' && Object.keys(await read($, usage)).length === 0) void collect($)
    const current = await read($, board)
    return { text: current ? summary(current.apps, current.tickets.length) : 'Factory board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, board)
    const busy = await read($, isRefreshing)
    const shown = await read($, tab)
    const now = await $.clock.now()

    if (!current) return <Text dimColor>{busy ? 'Reading the factory state…' : 'No data yet. Run /factory refresh.'}</Text>

    const tabs = (
      <Box flexDirection="row" gap={1}>
        {TABS.map(t => (
          <Button
            key={`tab-${t.id}`}
            label={t.label}
            variant={t.id === shown ? 'primary' : 'secondary'}
            onPress={() => void update($, tab, () => t.id)}
          />
        ))}
      </Box>
    )

    /* -- Apps ----------------------------------------------------------------------------------------------------- */
    const appsTab = (
      <Box flexDirection="column">
        {current.apps.length === 0 && <Text dimColor>No apps in state/application.</Text>}
        {current.apps.map(app => {
          const health = verdict(app.checks)
          return (
            <Box flexDirection="column" key={app.id} marginBottom={1}>
              <Box flexDirection="row" gap={1}>
                <Text bold>{app.id}</Text>
                <Text color={COLOR[health]}>{health}</Text>
                <Text color={stageColor(app.status)}>{app.status}</Text>
                <Text dimColor>{app.target}</Text>
              </Box>
              <Box flexDirection="row" gap={1} paddingLeft={2}>
                {app.checks.map(c => (
                  <Text
                    key={c.name}
                    color={typeof c.status === 'number' && c.status < 300 ? 'success' : c.status === 'pending' ? 'subtle' : 'error'}
                  >
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
                <Text dimColor>{app.product}</Text>
              </Box>
              {app.url && <Text dimColor wrap="truncate">  {app.url}</Text>}
            </Box>
          )
        })}
      </Box>
    )

    /* -- shared --------------------------------------------------------------------------------------------------- */
    const width = Math.max(40, (e.props as { bodyColumns?: number } | undefined)?.bodyColumns ?? 100)
    const priorityColor = (p: number) => (p <= 1 ? 'error' : p === 2 ? 'warning' : 'subtle')
    const appOf = (t: Ticket) => current.apps.find(a => ticketsForApp([t], a.id).length > 0)?.id
    const shortId = (id: string) => id.replace(/^mold_v\d+-/, '#')
    const showTicket = async (id: string) => {
      await update($, openTicket, () => id)
      await update($, tab, () => 'tickets')
    }
    const showApps = () => void update($, tab, () => 'apps')

    /* One ticket as one line: priority, number, app, then the title as the thing to click. */
    const ticketRow = (t: Ticket, keyPrefix = 'ticket') => {
      const app = appOf(t)
      const used = 4 + 6 + (app ? app.length + 2 : 0) + (t.status === 'in_progress' ? 13 : 0) + 4
      return (
        <Box key={`${keyPrefix}-row-${t.id}`} flexDirection="row" gap={1}>
          <Text bold color={priorityColor(t.priority)}>
            P{t.priority}
          </Text>
          <Text dimColor>{shortId(t.id).padEnd(5)}</Text>
          {t.status === 'in_progress' && <Text color="suggestion">in progress</Text>}
          {t.status === 'blocked' && <Text color="error">blocked</Text>}
          {app && <Text color="claude">{app}</Text>}
          <Button key={`${keyPrefix}-${t.id}`} plain label={fit(plainTitle(t), width - used)} onPress={() => void showTicket(t.id)} />
        </Box>
      )
    }

    /* -- Products ------------------------------------------------------------------------------------------------- */
    const productsTab = (
      <Box flexDirection="column" gap={1}>
        {current.products.map(p => {
          const soon = isComingSoon(current.molds.find(m => m.id === p.moldId)?.status ?? '')
          const next = nextStage(p.stage)
          const left = next ? stageTickets(current.tickets, p.id, next) : []
          const apps = current.apps.filter(a => p.appIds.includes(a.id))
          return (
            <Box key={`product-${p.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text bold>{p.name}</Text>
                {soon && <Text color="claude">coming soon</Text>}
                <Text dimColor>{p.moldId}</Text>
              </Box>
              {!soon && (
                <Box flexDirection="row">
                  {STAGES.map((s, i) => {
                    const at = STAGES.indexOf(p.stage as (typeof STAGES)[number])
                    const done = i <= at
                    return (
                      <Text key={`stage-${p.id}-${s}`} color={i === at ? 'success' : done ? 'text' : 'inactive'} bold={i === at}>
                        {i > 0 ? ' → ' : ''}
                        {i === at ? '● ' : done ? '✓ ' : '○ '}
                        {STAGE_WORDS[s]}
                      </Text>
                    )
                  })}
                </Box>
              )}
              {apps.length > 0 && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>apps</Text>
                  {apps.map(a => {
                    const health = verdict(a.checks)
                    const mark = health === 'healthy' ? '●' : health === 'down' ? '✕' : '○'
                    return (
                      <Button key={`papp-${p.id}-${a.id}`} plain label={`${mark} ${a.id} ${health}`} onPress={showApps} />
                    )
                  })}
                </Box>
              )}
              {!soon && next && (
                <Box flexDirection="column">
                  <Text dimColor>
                    {left.length === 0
                      ? `nothing open for ${STAGE_WORDS[next]}`
                      : `${left.length} left for ${STAGE_WORDS[next]}:`}
                  </Text>
                  {left.map(t => ticketRow(t, `pticket-${p.id}`))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )

    /* -- Molds ---------------------------------------------------------------------------------------------------- */
    const moldsTab = (
      <Box flexDirection="column">
        {current.molds.map(m =>
          isComingSoon(m.status) ? (
            <Box key={`mold-${m.id}`} flexDirection="row" gap={1}>
              <Text bold>{m.id}</Text>
              <Text color="claude">coming soon</Text>
              <Text dimColor>{m.open + m.inProgress} planned tickets</Text>
            </Box>
          ) : (
            <Box key={`mold-${m.id}`} flexDirection="row" gap={1}>
              <Text bold>{m.id}</Text>
              <Text dimColor>@{m.snapshot}</Text>
              <Text color={m.open + m.inProgress ? 'warning' : 'success'}>{m.open} open</Text>
              <Text>{m.inProgress} in progress</Text>
              <Text dimColor>{m.done} done</Text>
            </Box>
          ),
        )}
      </Box>
    )

    /* -- One ticket ----------------------------------------------------------------------------------------------- */
    const openId = await read($, openTicket)
    const opened: Ticket | undefined = current.tickets.find(t => t.id === openId)
    const rule = '─'.repeat(Math.min(width - 2, 72))

    const detail = opened && (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="ticket-back" label="← Back" onPress={() => void update($, openTicket, () => '')} />
          <Button
            key="ticket-work"
            label="Work on this"
            variant="primary"
            onPress={() =>
              void $.prompt.fill({
                text: `Work on factory ticket ${opened.id} (${opened.mold}): ${opened.title}`,
                mode: 'replace',
              })
            }
          />
        </Box>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold color={priorityColor(opened.priority)}>
              P{opened.priority}
            </Text>
            <Text>{opened.status.replace('_', ' ')}</Text>
            {appOf(opened) && <Text color="claude">{appOf(opened)}</Text>}
            <Text dimColor>{opened.id}</Text>
          </Box>
          <Text bold wrap="wrap">
            {opened.title}
          </Text>
          <Text dimColor>{rule}</Text>
          <Text dimColor wrap="wrap">
            {[
              opened.type,
              opened.lane ? `${opened.lane} lane` : '',
              opened.product ? `product ${opened.product}` : '',
              opened.advancesStage ? `moves it to ${STAGE_WORDS[opened.advancesStage] ?? opened.advancesStage}` : '',
              opened.owner ? `owner ${opened.owner}` : '',
              opened.created ? `filed ${opened.created}` : '',
              opened.updated && opened.updated !== opened.created ? `updated ${opened.updated}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
        {opened.detail && (
          <Box flexDirection="column">
            <Text bold>What happened</Text>
            <Text wrap="wrap">{opened.detail}</Text>
          </Box>
        )}
        {opened.acceptance && opened.acceptance.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Done when</Text>
            {opened.acceptance.map((a, i) => (
              <Text key={`acc-${i}`} wrap="wrap">
                ☐ {a}
              </Text>
            ))}
          </Box>
        )}
        {opened.dependsOn && opened.dependsOn.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Waits on</Text>
            {opened.dependsOn.map(d => {
              const other = current.tickets.find(t => t.id === d)
              return other ? (
                ticketRow(other, 'dep')
              ) : (
                <Text key={`dep-done-${d}`} color="success">
                  ✓ {d} done
                </Text>
              )
            })}
          </Box>
        )}
        {opened.evidence && opened.evidence.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Evidence so far</Text>
            {opened.evidence.map((a, i) => (
              <Text key={`ev-${i}`} dimColor wrap="wrap">
                · {a}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )

    /* -- Open tickets --------------------------------------------------------------------------------------------- */
    const filter = (await read($, ticketFilter)) || 'all'
    const shownTickets = current.tickets.filter(t => ticketMatches(t, filter))
    const priorities = [...new Set(current.tickets.map(t => t.priority))].sort()
    const ticketApps = current.apps.filter(a => ticketsForApp(current.tickets, a.id).length > 0)
    const chip = (id: string, label: string) => (
      <Button
        key={`filter-${id}`}
        label={label}
        variant={filter === id ? 'primary' : 'secondary'}
        onPress={() => void update($, ticketFilter, () => id)}
      />
    )
    const activeMolds = current.molds.filter(m => !isComingSoon(m.status))
    const ticketsTab = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {chip('all', `All ${current.tickets.length}`)}
          {priorities.map(p => chip(`p${p}`, `P${p} ${current.tickets.filter(t => t.priority === p).length}`))}
          {ticketApps.map(a => chip(`app:${a.id}`, `${a.id} ${ticketsForApp(current.tickets, a.id).length}`))}
        </Box>
        {shownTickets.length === 0 && <Text color="success">Nothing open{filter === 'all' ? '' : ' for this filter'}.</Text>}
        {activeMolds.map(m => {
          const mine = shownTickets.filter(t => t.mold === m.id)
          if (mine.length === 0) return null
          return (
            <Box flexDirection="column" key={`tickets-${m.id}`}>
              <Text dimColor>
                {m.id} · {mine.length} open
              </Text>
              {mine.map(t => ticketRow(t))}
            </Box>
          )
        })}
        {current.molds.some(m => isComingSoon(m.status)) && (
          <Text dimColor>
            Coming-soon molds' planned tickets are not listed (
            {current.molds
              .filter(m => isComingSoon(m.status))
              .map(m => `${m.id} ${m.open + m.inProgress}`)
              .join(', ')}
            ).
          </Text>
        )}
      </Box>
    )

    /* -- Analytics ------------------------------------------------------------------------------------------------ */
    const reports = await read($, usage)
    const collecting = await read($, isCollecting)
    const collectProblem = await read($, collectError)
    const liveApps = current.apps.filter(a => a.status !== 'retired')
    const chosenId = (await read($, selectedApp)) || liveApps[0]?.id || ''
    const chosen = reports[chosenId]
    const factoryTickets = ticketsForApp(current.tickets, chosenId)

    const analyticsTab = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {liveApps.map(a => (
            <Button
              key={`app-${a.id}`}
              label={a.id}
              variant={a.id === chosenId ? 'primary' : 'secondary'}
              onPress={() => void update($, selectedApp, () => a.id)}
            />
          ))}
        </Box>

        {!chosen && (
          <Text dimColor>
            {collecting ? 'Collecting usage from the apps…' : 'No usage report for this app yet. Press Collect usage.'}
          </Text>
        )}

        {chosen && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>
              Last {chosen.days} days · collected {ago(chosen.generated_at, now)}
            </Text>
            {chosen.error && <Text color="error">{chosen.error}</Text>}

            <Box flexDirection="column">
              <Text bold>Usage</Text>
              <Text>
                <Text color="suggestion">{short(chosen.totals.people_active)}</Text> people active ·{' '}
                <Text color="suggestion">{short(chosen.totals.chats)}</Text> chats ·{' '}
                <Text color="suggestion">{short(chosen.totals.chat_turns)}</Text> chat turns
              </Text>
              <Text>
                {short(chosen.totals.input_tokens)} tokens in · {short(chosen.totals.output_tokens)} out · chat cost{' '}
                {money(chosen.totals.cost_usd)}
              </Text>
              <Text>
                {short(chosen.totals.workflow_runs)} workflow runs · workflow cost {money(chosen.totals.workflow_cost_usd)}
              </Text>
            </Box>

            {chosen.daily.length > 0 && (
              <Box flexDirection="column">
                <Text bold>Chat turns per day</Text>
                <Text color="suggestion">{sparkline(chosen.daily.map(d => d.chat_turns))}</Text>
                <Text dimColor>
                  {chosen.daily[0]?.date} → {chosen.daily[chosen.daily.length - 1]?.date} · busiest day{' '}
                  {Math.max(0, ...chosen.daily.map(d => d.chat_turns ?? 0))} turns
                </Text>
              </Box>
            )}

            <Box flexDirection="column">
              <Text bold>Tickets in the app</Text>
              <Text>
                <Text color={chosen.totals.tickets.open ? 'warning' : 'success'}>{short(chosen.totals.tickets.open)} open</Text> ·{' '}
                {short(chosen.totals.tickets.in_progress)} in progress · {short(chosen.totals.tickets.done)} done{' '}
                <Text dimColor>({short(chosen.totals.tickets.total)} in all)</Text>
              </Text>
            </Box>

            {chosen.workspaces.length > 0 && (
              <Box flexDirection="column">
                <Text bold>By workspace</Text>
                {chosen.workspaces.map(w => (
                  <Text key={w.org_id} wrap="truncate">
                    {w.name}: {short(w.people_active)} people · {short(w.chats)} chats · {short(w.chat_turns)} turns · chat{' '}
                    {money(w.cost_usd)} · {short(w.workflow_runs)} workflow runs · {short(w.tickets.open)} open tickets
                  </Text>
                ))}
              </Box>
            )}

            {chosen.not_measured.length > 0 && (
              <Box flexDirection="column">
                <Text bold>About these numbers</Text>
                {chosen.not_measured.map(n => (
                  <Text key={n} dimColor wrap="truncate">
                    • {n}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>Factory tickets for this app</Text>
          {factoryTickets.length === 0 && <Text color="success">None open.</Text>}
          {factoryTickets.map(t => ticketRow(t, 'aticket'))}
        </Box>

        {collectProblem && <Text color="error">{collectProblem}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {current.error && <Text color="error">Could not read {current.root}/state: {current.error}</Text>}
        {shown === 'products' && productsTab}
        {shown === 'apps' && appsTab}
        {shown === 'molds' && moldsTab}
        {shown === 'tickets' && (detail || ticketsTab)}
        {shown === 'analytics' && analyticsTab}
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label={busy ? 'Refreshing…' : 'Refresh'} onPress={() => void refresh($)} />
          {shown === 'analytics' && (
            <Button key="collect" label={collecting ? 'Collecting…' : 'Collect usage'} onPress={() => void collect($)} />
          )}
          <Text dimColor>
            health checked {current.checkedAt ? ago(new Date(current.checkedAt).toISOString(), now) : 'pending'} · every 5 min
          </Text>
        </Box>
      </Box>
    )
  })
}
