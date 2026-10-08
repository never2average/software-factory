import { expect, mock, test } from 'claude-code/testing'

// A small factory on a pretend disk: the hooks beneath the plugin answer its file reads and health probes.
const ROOT = '/root/software-factory'
const TASKS = [
  {
    task_id: 'mold_v1-9',
    mold_id: 'mold_v1',
    title: 'Fix the card test on demo_app',
    product_id: 'demo',
    advances_stage: 'lanes_passing',
    status: 'todo',
    priority: 1,
    acceptance: ['test:cards passes'],
    detail: 'Two specs assume the default profile.',
    depends_on: ['mold_v1-8'],
  },
  { task_id: 'mold_v1-8', mold_id: 'mold_v1', title: 'Pin the profile', status: 'todo', priority: 2 },
  { task_id: 'mold_v1-1', mold_id: 'mold_v1', title: 'Old work', status: 'done', priority: 1 },
]
  .map(t => JSON.stringify(t))
  .join('\n')

const FILES: Record<string, string> = {
  [`${ROOT}/state/factory.json`]: JSON.stringify({
    molds: [
      { mold_id: 'mold_v1', status: 'active', source: { commit: 'abc1234def' } },
      { mold_id: 'mold_v2', status: 'coming_soon', source: {} },
    ],
  }),
  [`${ROOT}/state/products.json`]: JSON.stringify({
    products: [{ product_id: 'demo', name: 'Demo', stage: 'stamped', mold_id: 'mold_v1', app_ids: ['demo_app'] }],
  }),
  [`${ROOT}/state/tasks/mold_v1.jsonl`]: TASKS,
  [`${ROOT}/state/application/demo_app/application.json`]: JSON.stringify({ mold_id: 'mold_v1', status: 'stamped' }),
  [`${ROOT}/state/application/demo_app/infrastructure.json`]: JSON.stringify({ target: 'vercel', vercel: {} }),
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a ticket opens its details and links to what it waits on (${surface})`, async ($, on) => {
    mock.clock(on)
    on('ui.status', async () => ({ value: undefined }))
    on('fs.read', async (_$, e) => {
      const text = FILES[e.path]
      return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
    })
    on('fs.list', async () => ({ value: [{ name: 'demo_app', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
    on('fs.exists', async (_$, e) => ({ value: e.path in FILES }))
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: '' } }))

    // the command as a person types it; the test fills the engine-stamped fields the types require
    await $.command.run({ command: 'factory', args: 'tickets' } as any)
    const props = { title: 'Factory board', isFocused: true, bodyColumns: 100, placement: 'dock' } as any
    const ui = await $.ui.mount({ plugin: 'factory-board', surface, component: 'Pane', requestId: 'factory-board', props })

    expect(await ui.find({ key: 'ticket-mold_v1-9' })).toBeDefined()
    expect(await ui.find({ key: 'ticket-mold_v1-1' })).toBeUndefined()

    await ui.press({ key: 'ticket-mold_v1-9' })
    expect(await ui.find({ key: 'ticket-work' })).toBeDefined()
    expect(await ui.find({ text: '☐ test:cards passes' })).toBeDefined()
    expect(await ui.find({ text: 'Two specs assume the default profile.' })).toBeDefined()

    await ui.press({ key: 'dep-mold_v1-8' })
    expect(await ui.find({ text: 'Pin the profile' })).toBeDefined()

    await ui.press({ key: 'ticket-back' })
    expect(await ui.find({ key: 'ticket-work' })).toBeUndefined()
    expect(await ui.find({ key: 'ticket-mold_v1-8' })).toBeDefined()

    // filters: P1 hides the P2 ticket, the app chip keeps only tickets naming that app
    await ui.press({ key: 'filter-p1' })
    expect(await ui.find({ key: 'ticket-mold_v1-9' })).toBeDefined()
    expect(await ui.find({ key: 'ticket-mold_v1-8' })).toBeUndefined()
    await ui.press({ key: 'filter-app:demo_app' })
    expect(await ui.find({ key: 'ticket-mold_v1-9' })).toBeDefined()
    expect(await ui.find({ key: 'ticket-mold_v1-8' })).toBeUndefined()
    await ui.press({ key: 'filter-all' })
    expect(await ui.find({ key: 'ticket-mold_v1-8' })).toBeDefined()

    // the products tab shows the stage path and what is left for the next stage, clickable
    await ui.press({ key: 'tab-products' })
    expect(await ui.find({ text: '● built' })).toBeDefined()
    await ui.press({ key: 'pticket-demo-mold_v1-9' })
    expect(await ui.find({ key: 'ticket-work' })).toBeDefined()
  })
}
