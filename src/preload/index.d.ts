import type { AppState, Action, HandsFrame } from '../shared/types'

export interface DjApi {
  role: string
  getState(): Promise<AppState>
  displays(): Promise<{ id: number; label: string }[]>
  status(): Promise<unknown>
  mpAsset(name: string): Promise<Uint8Array | null>
  openLog(): Promise<void>
  send(a: Action): void
  sendHand(h: HandsFrame): void
  log(tag: string, msg: string): void
  onState(fn: (s: AppState) => void): void
  onHand(fn: (h: HandsFrame) => void): void
  onStatus(fn: (s: unknown) => void): void
  onKinectFrame(fn: (frame: string | Uint8Array) => void): void
}

declare global {
  interface Window {
    dj: DjApi
  }
}
