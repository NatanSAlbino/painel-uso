export type Janela = { kind: string; percentUsed: number; resetsAt?: string }
export type Leitura = { janelas: Janela[]; medidoEm: number }

declare module 'claude-code' {
  interface PluginState {
    'painel-uso': { leitura: Shaped<Leitura>; minuto: number; isHidden: boolean }
  }
}
