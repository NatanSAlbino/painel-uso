export type Janela = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'painel-uso': { janelas: Shaped<Janela[]>; isHidden: boolean }
  }
}
