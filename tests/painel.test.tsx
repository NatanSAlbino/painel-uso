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

test('o painel mostra 5 horas e semanal após uma medição', async ($, on) => {
  on('command.register', () => ({ value: { command: 'uso' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-11T12:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { window: 200000 },
    changed: ['rateLimits'],
    rateLimits: [
      { kind: 'seven_day', percentUsed: 8, resetsAt: '2026-11-17T11:00:00Z' },
      { kind: 'five_hour', percentUsed: 32.5, resetsAt: '2026-11-11T15:30:00Z' },
    ],
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Limite de 5 horas/ }))?.text).toBe('Limite de 5 horas')
    expect((await ui.find({ type: 'Text', text: /Semanal/ }))?.text).toBe('Semanal · todos os modelos')
    expect((await ui.find({ type: 'Text', text: /^33%$|^━+$|33%/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /em 3h 30min/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('sem leitura, o painel avisa', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /primeira resposta/}))).toBeTruthy()
  await ui.unmount()
})
