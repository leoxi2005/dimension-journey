// ============================================================================
// Cầu nối renderer <-> main. Renderer không chạm thẳng vào Node.
// ============================================================================
import { contextBridge, ipcRenderer } from 'electron'
import { AppState, Action, HandFrame } from '../shared/types'

// Vai trò truyền qua additionalArguments lúc tạo cửa sổ (--dj-role=wall).
const roleArg = process.argv.find((a) => a.startsWith('--dj-role='))
const role = roleArg ? roleArg.split('=')[1] : 'control'

const api = {
  role,
  getState: (): Promise<AppState> => ipcRenderer.invoke('dj:getState'),
  displays: (): Promise<{ id: number; label: string }[]> => ipcRenderer.invoke('dj:displays'),
  status: (): Promise<unknown> => ipcRenderer.invoke('dj:status'),
  mpAsset: (name: string): Promise<Uint8Array | null> => ipcRenderer.invoke('dj:mpAsset', name),
  openLog: (): Promise<void> => ipcRenderer.invoke('dj:openLog'),

  send: (a: Action): void => ipcRenderer.send('dj:action', a),
  sendHand: (h: HandFrame): void => ipcRenderer.send('dj:hand', h),
  log: (tag: string, msg: string): void => ipcRenderer.send('dj:log', tag, msg),

  onState: (fn: (s: AppState) => void): void => {
    ipcRenderer.on('dj:state', (_e, s) => fn(s))
  },
  onHand: (fn: (h: HandFrame) => void): void => {
    ipcRenderer.on('dj:hand', (_e, h) => fn(h))
  },
  onStatus: (fn: (s: unknown) => void): void => {
    ipcRenderer.on('dj:status', (_e, s) => fn(s))
  },
  onKinectFrame: (fn: (frame: string | Uint8Array) => void): void => {
    ipcRenderer.on('dj:kinectFrame', (_e, j) => fn(j))
  }
}

contextBridge.exposeInMainWorld('dj', api)

export type DjApi = typeof api
