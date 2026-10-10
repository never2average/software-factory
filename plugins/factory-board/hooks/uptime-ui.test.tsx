import { expect, mock, test } from 'claude-code/testing'

// A small factory whose uptime monitor (.claude/scripts/uptime.py) has marked one app down.
const ROOT = '/root/software-factory'

const files = (down: boolean): Record<string, string> => ({
  [`${ROOT}/state/factory.json`]: JSON.stringify({ molds: [{ mold_id: 'mold_v1', status: 'active', source: { commit: 'abc1234def' } }] }),
  [`${ROOT}/state/products.json`]: JSON.stringify({ products: [] }),
  [`${ROOT}/state/application/demo_vm/application.json`]: JSON.stringify({ mold_id: 'mold_v1', status: 'stamped' }),
  [`${ROOT}/state/application/demo_vm/infrastructure.json`]: JSON.stringify({
    target: 'vm_remote',
    vm_remote: { production_url: 'https://vm.example.test' },
  }),
  [`${ROOT}/.runs/uptime/state.json`]: JSON.stringify({
    checked_at: new Date(Date.now()).toISOString(),
    email: { configured: true, why: '' },
    apps: {
      demo_vm: down
        ? {
            status: 'down',
            since: new Date(Date.now() - 35 * 60_000).toISOString(),
            address: 'https://vm.example.test',
            last_error: 'web: an error page (HTTP 502 Bad Gateway)',
            email: { sent: true },
          }
        : { status: 'up', since: new Date(Date.now() - 60 * 60_000).toISOString(), address: 'https://vm.example.test' },
    },
  }),
})

for (const surface of ['terminal', 'desktop'] as const) {
  for (const down of [true, false]) {
    test(`the board shows a red banner only while an app is down (${surface}, ${down ? 'down' : 'up'})`, async ($, on) => {
      mock.clock(on)
      const FILES = files(down)
      const statuses: string[] = []
      on('ui.status', async (_$, e) => {
        statuses.push(String((e as any).text ?? (e as any).value ?? e))
        return { value: undefined }
      })
      on('fs.read', async (_$, e) => {
        const text = FILES[e.path]
        return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
      })
      on('fs.list', async () => ({ value: [{ name: 'demo_vm', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
      on('fs.exists', async (_$, e) => ({ value: e.path in FILES }))
      on('ui.open', async () => ({ value: { isPlaced: true as const } }))
      on('http.fetch', async () => ({ value: { status: down ? 502 : 200, ok: !down, headers: {}, text: '' } }))
      on('process.run', async () => ({
        value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }))

      await $.command.run({ command: 'factory', args: 'products' } as any)
      const props = { title: 'Factory board', isFocused: true, bodyColumns: 160, placement: 'dock' } as any
      const ui = await $.ui.mount({ plugin: 'factory-board', surface, component: 'Pane', requestId: 'factory-board', props })

      if (down) {
        expect(await ui.find({ key: 'uptime-banner' })).toBeDefined()
        expect(await ui.find({ text: '✕ An app is down. The factory is looking at it.' })).toBeDefined()
        const line = String((await ui.find({ key: 'uptime-banner' }))?.text ?? '').replace('✕ An app is down. The factory is looking at it.', '')
        expect(line.startsWith('demo_vm is DOWN since ')).toBe(true)
        expect(line.includes('https://vm.example.test · web: an error page (HTTP 502 Bad Gateway) · the operator was emailed')).toBe(true)
        // the banner stays on every tab
        await ui.press({ key: 'tab-tickets' })
        expect(await ui.find({ key: 'uptime-banner' })).toBeDefined()
        expect(statuses.some(s => s.includes('✕ DOWN: demo_vm'))).toBe(true)
      } else {
        expect(await ui.find({ key: 'uptime-banner' })).toBeUndefined()
        expect(await ui.find({ key: 'uptime-stale' })).toBeUndefined()
        expect(statuses.some(s => s.includes('DOWN'))).toBe(false)
      }
    })
  }
}
