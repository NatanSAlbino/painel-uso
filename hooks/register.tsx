import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Janela } from '../types'

const janelas = atom({ plugin: 'painel-uso', key: 'janelas' } as const, [], {
  shape: 'janelas-1',
})
const isHidden = atom({ plugin: 'painel-uso', key: 'isHidden' } as const, false)

const STORE_KEY = 'ultimas-janelas'
const DIAS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']
const ROTULO: Record<string, string> = {
  five_hour: 'Limite de 5 horas',
  seven_day: 'Semanal · todos os modelos',
  spend_limit: 'Limite de gastos',
}

const pad = (n: number) => String(n).padStart(2, '0')

// A window whose reset time has passed is back to zero.
const atual = (j: Janela, agora: number): Janela =>
  j.resetsAt && Date.parse(j.resetsAt) <= agora ? { kind: j.kind, percentUsed: 0 } : j

const reinicio = (j: Janela, agora: number) => {
  if (!j.resetsAt) return 'Começa com sua primeira mensagem'
  const d = new Date(j.resetsAt)
  const hora = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const hoje = new Date(agora)
  const mesmoDia = d.toDateString() === hoje.toDateString()
  if (j.kind === 'five_hour') {
    const min = Math.max(0, Math.round((d.getTime() - agora) / 60000))
    const falta = min >= 60 ? `${Math.floor(min / 60)}h ${pad(min % 60)}min` : `${min} min`
    return `Reinicia ${mesmoDia ? '' : 'amanhã '}às ${hora} (em ${falta})`
  }
  return `Reinicia ${DIAS[d.getDay()]}, ${hora}`
}

const limitar = (pct: number) => Math.min(100, Math.max(0, pct))
const fmtPct = (pct: number) => `${pct > 0 && pct < 1 ? '<1' : Math.round(pct)}%`

// Meter: the fill carries severity (accent -> warning -> critical); the track
// is the same hue as the fill, faded, so the state reads across the whole bar.
type Tom = { de: string; ate: string; claro: string }
const TONS: Record<'normal' | 'alerta' | 'critico', Tom> = {
  normal: { de: '#1f9d55', ate: '#3ccf7a', claro: '#13803f' },
  alerta: { de: '#e0731a', ate: '#f59a3a', claro: '#b85a0a' },
  critico: { de: '#c23232', ate: '#e05555', claro: '#b02828' },
}
const nivel = (pct: number) => (pct >= 90 ? 'critico' : pct >= 75 ? 'alerta' : 'normal')

const LARGURA_SVG = 280
const ALTURA_SVG = 6

function medidor(pct: number): string {
  const w = LARGURA_SVG
  const h = ALTURA_SVG
  const r = h / 2
  const n = nivel(pct)
  const t = TONS[n]
  // A reading above zero always shows at least a round dot.
  const cheio = pct <= 0 ? 0 : Math.max(h, (limitar(pct) / 100) * w)
  const preenchimento =
    cheio === 0 ? '' : `<rect class="f" x="0" y="0" width="${cheio.toFixed(1)}" height="${h}" rx="${r}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g-${n}" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="${t.de}"/><stop offset="1" stop-color="${t.ate}"/></linearGradient></defs>` +
    `<style>.t{fill:${t.ate};fill-opacity:.16}.f{fill:url(#g-${n})}` +
    `@media (prefers-color-scheme: light){.t{fill:${t.claro};fill-opacity:.14}}</style>` +
    `<rect class="t" x="0" y="0" width="${w}" height="${h}" rx="${r}"/>${preenchimento}</svg>`
  )
}

// Terminal: a hairline meter instead of heavy blocks.
const linha = (pct: number, largura: number) => {
  const cheio = pct <= 0 ? 0 : Math.max(1, Math.round((limitar(pct) / 100) * largura))
  return { cheio: '━'.repeat(cheio), vazio: '─'.repeat(largura - cheio) }
}
const corTerminal = (pct: number) =>
  ({ normal: 'success', alerta: 'warning', critico: 'error' } as const)[nivel(pct)]

const ordenar = (lista: Janela[]) => {
  const ordem = ['five_hour', 'seven_day']
  const pos = (k: string) => (ordem.indexOf(k) === -1 ? 9 : ordem.indexOf(k))
  return [...lista].sort((a, b) => pos(a.kind) - pos(b.kind))
}

async function guardar($: EngineInterface, lista: Janela[]) {
  const limpas = lista.map(j => ({ kind: j.kind, percentUsed: j.percentUsed, resetsAt: j.resetsAt }))
  await update($, janelas, () => limpas)
  await $.store.set(STORE_KEY, limpas)
  const agora = await $.clock.now()
  const resumo = ordenar(limpas)
    .map(j => atual(j, agora))
    .map(j => `${j.kind === 'five_hour' ? '5h' : j.kind === 'seven_day' ? 'Semana' : j.kind} ${j.percentUsed}%`)
    .join(' · ')
  $.ui.status(resumo ? `Uso: ${resumo}` : undefined)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'uso',
      description: 'Mostra ou esconde o painel de uso (5 horas e semanal)',
    })
    const { rateLimits } = await $.session.usage()
    if (rateLimits.length > 0) {
      await guardar($, rateLimits)
    } else {
      // No reading yet in this session: show the last one from any session.
      const salvo = await $.store.get(STORE_KEY)
      if (Array.isArray(salvo)) await guardar($, salvo as Janela[])
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await guardar($, e.rateLimits)
    }
    return next(e)
  })

  on('command.run', { command: 'uso' }, async $ => {
    await update($, isHidden, v => !v)
    const escondido = await read($, isHidden)
    return { text: escondido ? 'Painel de uso escondido. Use /uso para mostrar.' : 'Painel de uso visível.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const agora = await $.clock.now()
    const lista = ordenar(await read($, janelas)).map(j => atual(j, agora))
    const aviso = (pct: number) =>
      nivel(pct) === 'critico' ? ' · perto do limite' : nivel(pct) === 'alerta' ? ' · atenção' : ''

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const colunas = e.props.bodyColumns || 60
      const largura = Math.max(12, Math.min(48, colunas - 8))

      if (lista.length === 0) {
        return <Text dimColor>Uso do plano · aparece após a primeira resposta</Text>
      }

      return (
        <Box flexDirection="column" gap={0}>
          {lista.map(j => {
            const l = linha(j.percentUsed, largura)
            return (
              <Box flexDirection="column">
                <Box justifyContent="space-between" width={largura + 6}>
                  <Text bold>{ROTULO[j.kind] ?? j.kind}</Text>
                  <Text dimColor>{reinicio(j, agora)}</Text>
                </Box>
                <Box>
                  <Text color={corTerminal(j.percentUsed)}>{l.cheio}</Text>
                  <Text dimColor>{l.vazio}</Text>
                  <Text bold>{' '}{fmtPct(j.percentUsed).padStart(4)}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    // Desktop and the other graphical surfaces: an SVG meter per window.
    const { Box, Text, Svg } = $.ui.resolve(e)

    if (lista.length === 0) {
      return <Text dimColor>Uso do plano · aparece após a primeira resposta</Text>
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap="lg" rowGap="sm">
        {lista.map(j => (
          <Box flexDirection="column" rowGap="xs">
            <Box justifyContent="space-between" columnGap="md">
              <Text bold>{ROTULO[j.kind] ?? j.kind}</Text>
              <Text bold>{fmtPct(j.percentUsed)}</Text>
            </Box>
            <Svg
              source={medidor(j.percentUsed)}
              alt={`${ROTULO[j.kind] ?? j.kind}: ${fmtPct(j.percentUsed)} usado`}
              width={LARGURA_SVG}
              height={ALTURA_SVG}
            />
            <Text dimColor>
              {reinicio(j, agora)}
              {aviso(j.percentUsed)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
