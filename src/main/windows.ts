// ============================================================================
// WindowManager — Control (operator) + các cửa sổ chiếu (Wall/Floor).
// Cửa sổ chiếu chỉ để NGƯỜI xem/canh; đường ra thật cho Resolume là Spout/NDI,
// vốn render offscreen độc lập nên không cần mở cửa sổ chiếu lúc chạy show.
// ============================================================================
import { join } from 'path'
import { BrowserWindow, screen, shell } from 'electron'
import { Output, OutputKey } from '../shared/types'

type Role = 'control' | OutputKey

const isDev = !!process.env['ELECTRON_RENDERER_URL']

export const PRELOAD_PATH = join(__dirname, '../preload/index.js')

function rendererFor(role: Role): { url?: string; file?: string } {
  // Wall và Floor dùng CHUNG một renderer; vai trò truyền qua additionalArguments.
  const page = role === 'control' ? 'control' : 'wall'
  if (isDev) return { url: `${process.env['ELECTRON_RENDERER_URL']}/${page}/index.html` }
  return { file: join(__dirname, `../renderer/${page}/index.html`) }
}

function load(win: BrowserWindow, role: Role): void {
  const r = rendererFor(role)
  if (r.url) win.loadURL(r.url)
  else if (r.file) win.loadFile(r.file)
}

/** Dùng cho cửa sổ offscreen của Spout/NDI. */
export function loadOutputRenderer(win: BrowserWindow, role: OutputKey): void {
  load(win, role)
}

// Cửa sổ chiếu ở chế độ windowed: thu nhỏ giữ đúng tỉ lệ để lọt màn hình.
// 10350×1080 mà mở nguyên cỡ thì tràn ra ngoài mọi màn hình.
function windowedSize(o: Output, display: Electron.Display): [number, number] {
  const wa = display.workAreaSize
  const s = Math.min(1, (wa.width - 80) / o.resW, (wa.height - 120) / o.resH)
  return [Math.max(320, Math.round(o.resW * s)), Math.max(90, Math.round(o.resH * s))]
}

function forwardConsole(win: BrowserWindow, role: Role): void {
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[${role}] ${message} (${source}:${line})`)
  })
}

export class WindowManager {
  private wins: Partial<Record<Role, BrowserWindow>> = {}
  onOutputClosed: ((role: OutputKey) => void) | null = null

  getAll(): BrowserWindow[] {
    return Object.values(this.wins).filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
  }

  getControl(): BrowserWindow | undefined {
    const w = this.wins.control
    return w && !w.isDestroyed() ? w : undefined
  }

  createControl(): BrowserWindow {
    const cur = this.wins.control
    if (cur && !cur.isDestroyed()) return cur
    const win = new BrowserWindow({
      width: 1480,
      height: 920,
      minWidth: 1180,
      minHeight: 760,
      backgroundColor: '#07060c',
      title: 'DIMENSION JOURNEY · Operator',
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: false,
        backgroundThrottling: false,
        additionalArguments: ['--dj-role=control']
      }
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    forwardConsole(win, 'control')
    load(win, 'control')
    this.wins.control = win
    return win
  }

  syncOutputs(outputs: Output[]): void {
    for (const o of outputs) {
      if (o.open) this.openOutput(o)
      else this.closeOutput(o.key)
    }
  }

  private openOutput(o: Output): void {
    const role = o.key
    const cur = this.wins[role]
    if (cur && !cur.isDestroyed()) {
      this.place(cur, o)
      return
    }
    const target = screen.getAllDisplays().find((d) => d.id === o.display) ?? screen.getPrimaryDisplay()
    const [ww, wh] = windowedSize(o, target)
    const win = new BrowserWindow({
      x: target.bounds.x + 40,
      y: target.bounds.y + 40,
      width: ww,
      height: wh,
      backgroundColor: '#07060c',
      title: `DIMENSION · ${role.toUpperCase()}`,
      autoHideMenuBar: true,
      fullscreen: o.mode === 'fullscreen',
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: false,
        backgroundThrottling: false,
        additionalArguments: [`--dj-role=${role}`]
      }
    })
    forwardConsole(win, role)
    win.on('closed', () => {
      if (this.wins[role] === win) {
        delete this.wins[role]
        this.onOutputClosed?.(role)
      }
    })
    load(win, role)
    this.place(win, o)
    this.wins[role] = win
  }

  private place(win: BrowserWindow, o: Output): void {
    const target = screen.getAllDisplays().find((d) => d.id === o.display) ?? screen.getPrimaryDisplay()
    if (o.mode === 'fullscreen') {
      win.setBounds(target.bounds)
      if (!win.isFullScreen()) win.setFullScreen(true)
    } else {
      if (win.isFullScreen()) win.setFullScreen(false)
      const [ww, wh] = windowedSize(o, target)
      win.setContentSize(ww, wh)
    }
  }

  private closeOutput(role: OutputKey): void {
    const win = this.wins[role]
    if (win && !win.isDestroyed()) win.close()
    delete this.wins[role]
  }

  static listDisplays(): { id: number; label: string }[] {
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `Display ${i + 1} · ${d.size.width}×${d.size.height}${d.id === primary ? ' · chính' : ''}`
    }))
  }
}
