import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'painel-uso',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const AGORA = Date.parse('2026-11-11T12:00:00Z')

const USO_AO_VIVO = JSON.stringify({
  five_hour: { utilization: 32.5, resets_at: '2026-11-11T15:30:00Z' },
  seven_day: { utilization: 8, resets_at: '2026-11-17T11:00:00Z' },
})

// The engine beneath the plugin: a store kept in a map, a clock fixed at AGORA.
function motor(on: any, opts: { http?: () => unknown; salvo?: unknown } = {}) {
  const store = new Map<string, unknown>()
  if (opts.salvo !== undefined) store.set('leitura-compartilhada', opts.salvo)
  const pedidos: string[] = []
  on('command.register', () => ({ value: { command: 'uso' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: AGORA }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', (_: unknown, e: { url: string }) => {
    pedidos.push(e.url)
    return { value: opts.http ? opts.http() : { status: 200, ok: true, headers: {}, text: USO_AO_VIVO } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  return { store, pedidos }
}

declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown
const espera = () => new Promise(r => setTimeout(r, 20))

test('busca o uso ao vivo ao abrir a conversa, em todas as superfícies', async ($, on) => {
  const { pedidos, store } = motor(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await espera()

  expect(pedidos).toEqual(['https://api.anthropic.com/api/oauth/usage'])
  expect((store.get('leitura-compartilhada') as { medidoEm: number }).medidoEm).toBe(AGORA)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Limite de 5 horas/ }))?.text).toBe('Limite de 5 horas')
    expect((await ui.find({ type: 'Text', text: /Semanal/ }))?.text).toBe('Semanal · todos os modelos')
    expect(await ui.find({ type: 'Text', text: /33%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /em 3h 30min/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /atrás/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('ao abrir, busca ao vivo mesmo com leitura recente de outra conversa', async ($, on) => {
  const salvo = { janelas: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2026-11-11T15:30:00Z' }], medidoEm: AGORA - 10_000 }
  const { pedidos } = motor(on, { salvo })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await espera()

  expect(pedidos.length).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /33%/ })).toBeTruthy()
  await ui.unmount()
})

test('se a busca falha, mostra a última leitura dizendo a idade', async ($, on) => {
  const salvo = { janelas: [{ kind: 'seven_day', percentUsed: 47, resetsAt: '2026-11-17T11:00:00Z' }], medidoEm: AGORA - 40 * 60_000 }
  motor(on, { salvo, http: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await espera()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /47%/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /atrás/ }))?.text).toBe('Leitura de 40 min atrás')
  await ui.unmount()
})

test('sem nenhuma leitura, o painel diz que está carregando', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /carregando/ })).toBeTruthy()
  await ui.unmount()
})
