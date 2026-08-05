import type { AppState, Action, HandFrame } from '../shared/types'

export interface DjApi {
  role: string
  getState(): Promise<AppState>
  displays(): Promise<{ id: number; label: string }[]>
  status(): Promise<unknown>
  mpAsset(name: string): Promise<Uint8Array | null>
  openLog(): Promise<void>
  send(a: Action): void
  sendHand(h: HandFrame): void
  log(tag: string, msg: string): void
  onState(fn: (s: AppState) => void): void
  onHand(fn: (h: HandFrame) => void): void
  onStatus(fn: (s: unknown) => void): void
  onKinectFrame(fn: (json: string) => void): void
}

declare global {
  interface Window {
    dj: DjApi
  }
}
