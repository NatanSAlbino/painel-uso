import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Janela, Leitura } from '../types'

const VAZIA: Leitura = { janelas: [], medidoEm: 0 }
const leitura = atom({ plugin: 'painel-uso', key: 'leitura' } as const, VAZIA, {
  shape: 'leitura-1',
})
// Bumped once a minute so the countdown and the reading's age redraw.
const minuto = atom({ plugin: 'painel-uso', key: 'minuto' } as const, 0)
const isHidden = atom({ plugin: 'painel-uso', key: 'isHidden' } as const, false)

// Each session shows its own account's figures: sessions may be signed in to
// different accounts, so a reading is never shared between them.
const URL_USO = 'https://api.anthropic.com/api/oauth/usage'
const TICK_MS = 30_000
// At most one live fetch per session in this window; responses fill the gaps.
const AO_VIVO_MS = 3 * 60_000
// After a 429 every session waits; the wait doubles up to the cap.
const PAUSA_MIN_MS = 5 * 60_000
const PAUSA_MAX_MS = 30 * 60_000
const MAX_DIAG = 12
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

const limpar = (lista: readonly Janela[]): Janela[] =>
  lista.map(j => ({ kind: j.kind, percentUsed: j.percentUsed, resetsAt: j.resetsAt }))

type Fonte = 'ao-vivo' | 'resposta'
type Registro = { cinco?: number; semana?: number; reinicia5h?: string; em: number }
type Diag = Record<string, { atualizado: number; aoVivo?: Registro; resposta?: Registro; falha?: { motivo: string; em: number } }>

const resumir = (l: Leitura): Registro => ({
  cinco: l.janelas.find(j => j.kind === 'five_hour')?.percentUsed,
  semana: l.janelas.find(j => j.kind === 'seven_day')?.percentUsed,
  reinicia5h: l.janelas.find(j => j.kind === 'five_hour')?.resetsAt,
  em: l.medidoEm,
})

// Per-session diagnostics, figures only (no credential, no response body),
// kept for the last few sessions so their readings can be compared.
async function diagnosticar(
  $: EngineInterface,
  mudar: (d: Diag[string]) => Diag[string],
) {
  const id = await $.session.id()
  const agora = await $.clock.now()
  const bruto = await $.store.get('diag')
  const diag: Diag = typeof bruto === 'object' && bruto !== null ? (bruto as Diag) : {}
  diag[id] = { ...mudar(diag[id] ?? { atualizado: agora }), atualizado: agora }
  const recentes = Object.entries(diag)
    .sort((a, b) => b[1].atualizado - a[1].atualizado)
    .slice(0, MAX_DIAG)
  await $.store.set('diag', Object.fromEntries(recentes))
}

// Keeps `nova` only where it is newer than this session's reading.
async function aplicar($: EngineInterface, nova: Leitura, fonte: Fonte) {
  const atualSessao = await read($, leitura)
  if (nova.medidoEm > atualSessao.medidoEm) {
    await update($, leitura, () => nova)
    const agora = await $.clock.now()
    const resumo = ordenar(nova.janelas)
      .map(j => atual(j, agora))
      .map(j => `${j.kind === 'five_hour' ? '5h' : j.kind === 'seven_day' ? 'Semana' : j.kind} ${fmtPct(j.percentUsed)}`)
      .join(' · ')
    $.ui.status(resumo ? `Uso: ${resumo}` : undefined)
  }
  await diagnosticar($, d => (fonte === 'ao-vivo' ? { ...d, aoVivo: resumir(nova) } : { ...d, resposta: resumir(nova) }))
}

async function falhar($: EngineInterface, motivo: string) {
  const em = await $.clock.now()
  await diagnosticar($, d => ({ ...d, falha: { motivo, em } }))
}

// The same figures as the app's usage menu, fetched live with the session's
// own Claude login; the credential stays on the host. Null when it fails.
async function buscarAoVivo($: EngineInterface): Promise<Leitura | null> {
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      await falhar($, auth ? 'sem login de assinatura' : 'sem credencial')
      return null
    }
    const r = await $.http.fetch(URL_USO, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    })
    if (r.status === 429) {
      // Too many requests: every session backs off, longer each time.
      const anterior = Number(await $.store.get('pausa-ms')) || 0
      const pedida = Number(r.headers['retry-after'] ?? r.headers['Retry-After']) * 1000 || 0
      const pausa = Math.min(PAUSA_MAX_MS, Math.max(PAUSA_MIN_MS, anterior * 2, pedida))
      await $.store.set('pausa-ms', pausa)
      await $.store.set('pausa-ate', (await $.clock.now()) + pausa)
      await falhar($, 'HTTP 429')
      return null
    }
    if (!r.ok) {
      // Only the status code: the body is never stored.
      await falhar($, `HTTP ${r.status}`)
      return null
    }
    const dados = JSON.parse(r.text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null>
    const janelas: Janela[] = []
    for (const kind of ['five_hour', 'seven_day']) {
      const j = dados[kind]
      if (j && typeof j.utilization === 'number') {
        janelas.push({ kind, percentUsed: Math.round(j.utilization * 10) / 10, resetsAt: j.resets_at ?? undefined })
      }
    }
    if (janelas.length === 0) {
      await falhar($, `resposta sem limites (${Object.keys(dados).join(',')})`)
      return null
    }
    await $.store.delete('pausa-ms')
    return { janelas, medidoEm: await $.clock.now() }
  } catch (erro) {
    await falhar($, `erro: ${String((erro as Error)?.message ?? erro).slice(0, 120)}`)
    return null
  }
}

// When this session last asked the server; module state is fine here, as a
// reload only means one extra fetch.
let ultimaBusca = 0

async function sincronizar($: EngineInterface, forcar = false) {
  const agora = await $.clock.now()
  await update($, minuto, m => (Math.floor(agora / 60_000) === m ? m : Math.floor(agora / 60_000)))
  const pausaAte = Number(await $.store.get('pausa-ate')) || 0
  if (agora < pausaAte) return
  const recente = agora - (await read($, leitura)).medidoEm < AO_VIVO_MS
  if ((forcar || !recente) && agora - ultimaBusca >= AO_VIVO_MS) {
    ultimaBusca = agora
    const viva = await buscarAoVivo($)
    if (viva) await aplicar($, viva, 'ao-vivo')
  }
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
      await aplicar($, { janelas: limpar(rateLimits), medidoEm: await $.clock.now() }, 'resposta')
    }
    void sincronizar($, true)
    $.clock.every(TICK_MS, () => void sincronizar($))
    return ran
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await aplicar($, { janelas: limpar(e.rateLimits), medidoEm: await $.clock.now() }, 'resposta')
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

    await read($, minuto)
    const agora = await $.clock.now()
    const { janelas, medidoEm } = await read($, leitura)
    const lista = ordenar(janelas).map(j => atual(j, agora))
    const aviso = (pct: number) =>
      nivel(pct) === 'critico' ? ' · perto do limite' : nivel(pct) === 'alerta' ? ' · atenção' : ''
    // Said only when the reading is not fresh, so a stale figure never passes as live.
    const idadeMin = Math.floor((agora - medidoEm) / 60_000)
    const idade =
      lista.length > 0 && idadeMin >= 3
        ? `Leitura de ${idadeMin >= 60 ? `${Math.floor(idadeMin / 60)}h ${pad(idadeMin % 60)}min` : `${idadeMin} min`} atrás`
        : ''
    const vazio = 'Uso do plano · carregando…'

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const colunas = e.props.bodyColumns || 60
      const largura = Math.max(12, Math.min(48, colunas - 8))

      if (lista.length === 0) {
        return <Text dimColor>{vazio}</Text>
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
          {idade !== '' && <Text dimColor>{idade}</Text>}
        </Box>
      )
    }

    // Desktop and the other graphical surfaces: an SVG meter per window.
    const { Box, Text, Svg } = $.ui.resolve(e)

    if (lista.length === 0) {
      return <Text dimColor>{vazio}</Text>
    }

    return (
      <Box flexDirection="column" rowGap="xs">
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
      {idade !== '' && <Text dimColor>{idade}</Text>}
      </Box>
    )
  })
}
