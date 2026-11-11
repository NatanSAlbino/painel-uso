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

const INICIO = Date.parse('2026-11-11T12:00:00Z')

const USO_AO_VIVO = JSON.stringify({
  five_hour: { utilization: 32.5, resets_at: '2026-11-11T15:30:00Z' },
  seven_day: { utilization: 8, resets_at: '2026-11-17T11:00:00Z' },
})

type Resposta = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const OK: Resposta = { status: 200, ok: true, headers: {}, text: USO_AO_VIVO }

// The engine beneath the plugin: a store kept in a map, a clock the test moves.
function motor(on: any, opts: { respostas?: Resposta[]; store?: Record<string, unknown>; rateLimits?: unknown[] } = {}) {
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const relogio = { agora: INICIO }
  const pedidos: number[] = []
  const fila = [...(opts.respostas ?? [])]
  on('command.register', () => ({ value: { command: 'uso' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: opts.rateLimits ?? [] } }))
  on('session.id', () => ({ value: 'sessao-a' }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: relogio.agora }))
  on('clock.every', () => ({ value: {} }))
  on('ui.status', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    pedidos.push(relogio.agora)
    return { value: fila.shift() ?? OK }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  return { store, pedidos, relogio }
}

declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown
const espera = () => new Promise(r => setTimeout(r, 20))
const iniciar = async ($: any) => {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await espera()
}

test('busca o uso ao vivo ao abrir a conversa, em todas as superfícies', async ($, on) => {
  const { pedidos } = motor(on)
  await iniciar($)
  expect(pedidos.length).toBe(1)

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

test('não mostra a leitura que outra conversa (outra conta) deixou guardada', async ($, on) => {
  const deOutraConta = {
    janelas: [{ kind: 'five_hour', percentUsed: 94, resetsAt: '2026-11-11T16:20:00Z' }],
    medidoEm: INICIO,
  }
  motor(on, { store: { 'leitura-compartilhada': deOutraConta } })
  await iniciar($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /94%/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /33%/ })).toBeTruthy()
  await ui.unmount()
})

test('depois de um 429, nenhuma conversa consulta até a pausa acabar', async ($, on) => {
  const { pedidos, store, relogio } = motor(on, {
    respostas: [{ status: 429, ok: false, headers: {}, text: '' }],
  })
  await iniciar($)
  expect(pedidos.length).toBe(1)
  expect(store.get('pausa-ate')).toBe(INICIO + 5 * 60_000)

  // Within the pause: no new request, even after the 3-minute spacing.
  relogio.agora = INICIO + 4 * 60_000
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await espera()
  expect(pedidos.length).toBe(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /carregando/ })).toBeTruthy()
  await ui.unmount()
})

test('a leitura das respostas mostra a idade quando a consulta falha', async ($, on) => {
  const { relogio } = motor(on, {
    respostas: [{ status: 500, ok: false, headers: {}, text: '' }, { status: 500, ok: false, headers: {}, text: '' }],
    rateLimits: [{ kind: 'seven_day', percentUsed: 47, resetsAt: '2026-11-17T11:00:00Z' }],
  })
  await iniciar($)
  relogio.agora = INICIO + 40 * 60_000

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /47%/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /atrás/ }))?.text).toBe('Leitura de 40 min atrás')
  await ui.unmount()
})

test('guarda diagnóstico por conversa, sem dados de login', async ($, on) => {
  const { store } = motor(on)
  await iniciar($)
  const diag = store.get('diag') as Record<string, { aoVivo?: { cinco?: number; semana?: number } }>
  expect(diag['sessao-a']?.aoVivo?.cinco).toBe(32.5)
  expect(diag['sessao-a']?.aoVivo?.semana).toBe(8)
})

test('sem nenhuma leitura, o painel diz que está carregando', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /carregando/ })).toBeTruthy()
  await ui.unmount()
})
