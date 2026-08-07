// ============================================================================
// Main process — vòng đời app, store, IPC, và ba đường render song song:
//   1. cửa sổ Wall hiện hình (để operator canh)
//   2. cửa sổ offscreen của Spout (GPU shared texture -> Resolume Arena)
//   3. cửa sổ offscreen của NDI (CPU, chỉ khi bật)
// Cả ba nhận CÙNG một state + CÙNG luồng dữ liệu tay nên hình luôn khớp.
// ============================================================================
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AppState, Action, HandsFrame, Output } from '../shared/types'
import { initialState, reduce } from './store'
import { WindowManager } from './windows'
import { SpoutService } from './spout'
import { NdiService } from './ndi'
import { KinectBridge } from './kinect'
import { log, logEnvironment, logFile, recentLog } from './log'

// Không có switch này thì AudioContext bị chặn tới khi có người bấm chuột vào
// cửa sổ. Người tham gia điều khiển bằng TAY, không ai bấm gì cả — nên nhạc nền
// và hiệu ứng sẽ im lặng suốt cả show.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Chromium mặc định bóp rAF của cửa sổ bị che/ẩn. Cửa sổ offscreen của Spout
// và cửa sổ chiếu bị Resolume che LÀ trường hợp đó — không tắt sẽ "đứng hình".
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
if (process.platform === 'win32') {
  // Ép GPU + ANGLE d3d11: cần cho shared texture của Spout.
  // CHỈ trên Windows — trên macOS mấy switch này làm sập GPU process (đã dính).
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('use-angle', 'd3d11')
}

let state: AppState = initialState()
const wm = new WindowManager()
const spout = new SpoutService()
const ndi = new NdiService()
const kinect = new KinectBridge()

// Bề mặt nào có cờ send thì mới đẩy ra Spout/NDI. Mỗi bề mặt là một lần render
// offscreen nữa, nên bật sàn là gần gấp đôi tải GPU — phải để người vận hành chủ
// động bật, không bật ngầm.
const streamedOutputs = (): Output[] => state.outputs.filter((o) => o.send)

function allWindows(): BrowserWindow[] {
  return [...wm.getAll(), ...spout.broadcastWindows(), ...ndi.broadcastWindows()]
}

/** Cửa sổ hiển thị nội dung (nhận state + dữ liệu tay). Không gồm Control. */
function outputWindows(): BrowserWindow[] {
  const control = wm.getControl()
  return allWindows().filter((w) => w !== control)
}

function broadcast(): void {
  for (const w of allWindows()) {
    if (!w.isDestroyed()) w.webContents.send('dj:state', state)
  }
}

function applyServices(): void {
  wm.syncOutputs(state.outputs)
  spout.sync(state.spout.running, state.spout.fps, state.spout.scale, streamedOutputs())
  ndi.sync(state.ndi.running, state.ndi.fps, state.ndi.scale, streamedOutputs())
  kinect.sync(state.input.source === 'kinect', state.input.kinectPort, state.input.kinectSource)
}

function dispatch(a: Action): void {
  const next = reduce(state, a)
  if (next === state) return
  state = next
  applyServices()
  broadcast()
}

// ---------------------------------------------------------------- MediaPipe
// Model + wasm đóng gói kèm app: venue thường không có mạng, và nếu tải từ CDN
// thì phiên bản có thể đổi dưới chân mình giữa hai buổi diễn.
const MP_FILES: Record<string, string> = {
  bundle: 'vision_bundle.mjs',
  wasmJs: 'vision_wasm_internal.js',
  wasmBin: 'vision_wasm_internal.wasm',
  model: 'hand_landmarker.task'
}

let mpDirCache = ''

/** Tìm thư mục MediaPipe. Đường dẫn khác nhau tuỳ cách chạy (electron-vite dev,
 *  `electron .`, `electron out/main/index.js`, bản .exe đóng gói) — thử lần lượt
 *  rồi ghi log chỗ tìm thấy, để lúc hỏng còn biết nó đã ngó những đâu. */
function mpDir(): string {
  if (mpDirCache) return mpDirCache
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'mediapipe') : '',
    join(app.getAppPath(), 'resources/mediapipe'),
    join(__dirname, '../../resources/mediapipe'),
    join(__dirname, '../../../resources/mediapipe')
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, MP_FILES.model))) {
      mpDirCache = c
      log('mediapipe', `dùng ${c}`)
      return c
    }
  }
  log('mediapipe', `KHÔNG tìm thấy thư mục mediapipe. Đã thử: ${candidates.join(' | ')}`)
  mpDirCache = candidates[0]
  return mpDirCache
}

// ---------------------------------------------------------------- IPC
function wireIpc(): void {
  ipcMain.handle('dj:getState', () => state)
  ipcMain.handle('dj:displays', () => WindowManager.listDisplays())
  ipcMain.handle('dj:status', () => ({
    spout: spout.status(),
    ndi: ndi.status(),
    kinect: kinect.status(),
    log: recentLog(40)
  }))
  ipcMain.handle('dj:mpAsset', (_e, name: string) => {
    const file = MP_FILES[name]
    if (!file) return null
    const p = join(mpDir(), file)
    if (!existsSync(p)) {
      log('mediapipe', `THIẾU ${p} — tracking sẽ không chạy`)
      return null
    }
    return readFileSync(p)
  })
  ipcMain.handle('dj:openLog', () => shell.showItemInFolder(logFile()))

  ipcMain.on('dj:action', (_e, a: Action) => dispatch(a))

  // Renderer ghi vào dimension.log. Không có kênh này thì trạng thái camera,
  // MediaPipe và âm thanh hoàn toàn vô hình trong bản .exe (không có terminal),
  // mà đó đúng là ba thứ hay hỏng nhất ở venue.
  ipcMain.on('dj:log', (_e, tag: string, msg: string) => log(tag, msg))

  // Dữ liệu tay: Control -> main -> các cửa sổ hiển thị. Gói nhỏ (< 100 byte)
  // nên 60fps qua IPC không đáng kể; đổi lại camera + MediaPipe chỉ chạy ĐÚNG
  // MỘT chỗ thay vì mỗi cửa sổ một bản (3 bản MediaPipe sẽ giết CPU).
  ipcMain.on('dj:hand', (_e, h: HandsFrame) => {
    for (const w of outputWindows()) {
      if (!w.isDestroyed()) w.webContents.send('dj:hand', h)
    }
  })
}

// ---------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  // Bản cũ còn sống sẽ nuốt lần chạy mới và log vẫn ra từ bản CŨ — rất dễ tưởng
  // là code không đổi. Thoát dứt khoát, nhưng ghi lại một dòng: không có nó thì
  // lần chạy mới "không hiện gì" mà chẳng để lại dấu vết nào để lần ra.
  log('app', 'đã có một bản đang chạy — nhường cho bản cũ (nó sẽ hiện cửa sổ Control lên) và thoát')
  app.quit()
} else {
  // Bảng Control là cách DUY NHẤT điều khiển show. Đóng nhầm nó thì app vẫn phải
  // sống — cửa sổ offscreen của NDI vẫn đang phát, cắt hình giữa show là hỏng —
  // nhưng bắt buộc phải có đường lấy lại.
  //
  // Đây chính là lỗi "tắt app rồi mở lại không được": đóng cửa sổ Control xong,
  // app KHÔNG thoát (cửa sổ offscreen của NDI vẫn tính là cửa sổ, nên
  // window-all-closed không bao giờ bắn). Lần chạy sau bị khoá một-bản-duy-nhất
  // nuốt mất, mà bản cũ thì không còn cửa sổ nào để hiện ra — app thành bóng ma:
  // vẫn phát NDI, vẫn giữ camera, mà không thấy đâu để bấm.
  const showControl = (): void => {
    const c = wm.getControl()
    if (c) {
      if (c.isMinimized()) c.restore()
      c.focus()
      return
    }
    log('app', 'cửa sổ Control đã bị đóng — mở lại (app vẫn đang chạy nền)')
    wm.createControl()
  }

  app.on('second-instance', () => showControl())

  app.whenReady().then(() => {
    logEnvironment()
    log('app', `DIMENSION JOURNEY ${app.getVersion()} — tường ${state.outputs[0].resW}×${state.outputs[0].resH}`)
    spout.logGpu()
    ndi.logAvailability()

    kinect.target = () => wm.getControl()
    wm.onOutputClosed = (role) => {
      state = reduce(state, { type: 'setOutput', key: role, patch: { open: false } })
      broadcast()
    }

    // Tiện lúc dev/demo: DJ_OPEN_WALL=1 thì mở sẵn cửa sổ chiếu, khỏi phải bấm.
    // Mặc định vẫn ĐÓNG, vì ở venue cửa sổ này bật lên là scene render 2 lần.
    if (process.env.DJ_OPEN_WALL) {
      state = reduce(state, { type: 'setOutput', key: 'wall', patch: { open: true } })
    }

    wireIpc()
    wm.createControl()
    applyServices()

    // Nhịp tim vào log mỗi 5s. Bản .exe không có terminal, đây là cách duy nhất
    // để biết ở venue nó thực sự chạy bao nhiêu fps chứ không phải đoán.
    setInterval(() => {
      const parts: string[] = []
      for (const s of spout.status().streams) parts.push(`spout ${s.name} ${s.w}x${s.h} ${s.fps}fps ${s.mode}`)
      for (const s of ndi.status().streams) parts.push(`ndi ${s.name} ${s.w}x${s.h} ${s.fps}fps copy ${s.copyMs}ms`)
      if (parts.length) log('fps', parts.join(' · '))
    }, 5000)

    // Đẩy trạng thái output cho Control mỗi giây (fps thật, lý do fail).
    setInterval(() => {
      const c = wm.getControl()
      if (c && !c.isDestroyed()) {
        c.webContents.send('dj:status', {
          spout: spout.status(), ndi: ndi.status(), kinect: kinect.status()
        })
      }
    }, 1000)

    // Bấm icon ở Dock. KHÔNG đếm getAllWindows() như trước: cửa sổ offscreen của
    // NDI/Spout cũng là BrowserWindow, nên số đó gần như không bao giờ về 0 và
    // Control sẽ không bao giờ được mở lại.
    app.on('activate', () => showControl())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    spout.stopAll()
    ndi.stopAll()
    kinect.stop()
  })
}
