// ============================================================================
// SpoutService (Windows) — ĐƯỜNG RA DUY NHẤT của app. Render offscreen với
// useSharedTexture:true → lấy shared D3D11 handle → addon gửi qua SpoutDX.
// Resolume Arena / TouchDesigner nhận bằng "Spout In".
//
// Toàn bộ đường đi nằm trên GPU: không đọc pixel về RAM, không copy trên main
// thread, không nén. (Bản cũ dùng NDI phải copy 47MB+67MB mỗi frame trên main
// thread → 12-26fps và giật cả show; đã bỏ hẳn.)
//
// Addon nạp theo thứ tự: resources/djspout.node (bản đóng gói, extraResources)
// → package dj-spout (lúc dev). Mọi lý do fail đều ghi log file + hiện lên Control.
//
// BẪY ĐÃ ĐO ĐƯỢC (probe Electron 33): nếu khung vượt 16384px một chiều thì Chromium
// KHÔNG cấp shared texture nữa mà âm thầm rơi về bitmap CPU → paint không có
// `event.texture` → Spout im lặng không có tín hiệu. Vì vậy phải tự đo kích thước
// frame thật rồi hiệu chỉnh cửa sổ (DPR Windows 125/150% làm lệch).
// ============================================================================
import { join } from 'path'
import { existsSync } from 'fs'
import { app, BrowserWindow, screen } from 'electron'
import { Output, OutputKey, SpoutStatus } from '../shared/types'
import { PRELOAD_PATH, loadOutputRenderer } from './windows'
import { log, logFile } from './log'

const MAX_TEX = 16384 // giới hạn cạnh texture của Chromium/D3D11

/* eslint-disable @typescript-eslint/no-explicit-any */
let spout: any = null
let loadReason = ''

function loadAddon(): void {
  if (process.platform !== 'win32') {
    loadReason = 'chỉ chạy trên Windows'
    return
  }
  const tried: string[] = []
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'djspout.node') : ''
  const candidates = [packaged, join(app.getAppPath(), 'native/spout/build/Release/djspout.node')]
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue
    try {
      spout = require(p)
      if (spout && spout.available && spout.available()) return
      spout = null
      tried.push(`${p}: available()=false`)
    } catch (e) {
      tried.push(`${p}: ${(e as Error).message}`)
    }
  }
  try {
    const mod = require('dj-spout')
    if (mod && mod.available && mod.available()) {
      spout = mod
      return
    }
    tried.push(`dj-spout: ${mod && mod.lastError ? mod.lastError() : 'available()=false'}`)
  } catch (e) {
    tried.push(`dj-spout: ${(e as Error).message}`)
  }
  loadReason = tried.length ? tried.join(' | ') : 'không tìm thấy djspout.node'
}
loadAddon()

type Role = OutputKey

interface Stream {
  win: BrowserWindow
  streamName: string
  resW: number
  resH: number
  opened: boolean
  reqFps: number // fps đang yêu cầu (setFrameRate) — chỉ gọi lại khi đổi
  frames: number // số paint nhận được
  sent: number // số frame gửi Spout thành công
  noTexture: number // số paint KHÔNG có shared texture
  fps: number // fps gửi thật, tính mỗi giây
  fpsMark: number
  fpsCount: number
  locked: boolean // đã đo đúng kích thước, hết hiệu chỉnh
  attempts: number
  note: string
  settleUntil: number // bỏ qua frame tạm lúc khởi động tới mốc này
  mode: 'gpu' | 'cpu' // cpu = Chromium không cấp shared texture, phải upload pixel
  sendMs: number // thời gian gửi frame gần nhất (chỉ có nghĩa ở mode cpu)
}

export class SpoutService {
  private streams: Partial<Record<Role, Stream>> = {}
  private lastError = ''

  available(): boolean {
    return !!(spout && spout.available && spout.available())
  }

  /** Ghi cấu hình GPU vào log — chẩn đoán máy 2 GPU / GPU tắt từ xa.
   *  LƯU Ý: getGPUFeatureStatus() gọi ngay lúc ready trả toàn "disabled_software"
   *  vì GPU process chưa báo cáo xong → phải đợi getGPUInfo() resolve rồi mới đọc,
   *  và đọc lại lần nữa sau 6s (GPU có thể chết giữa chừng và rơi về software). */
  logGpu(): void {
    if (this.available()) log('spout', 'addon OK')
    else log('spout', `addon KHÔNG dùng được: ${loadReason}`)

    const dump = (tag: string): void => {
      try {
        const st = app.getGPUFeatureStatus() as unknown as Record<string, string>
        const keys = ['gpu_compositing', 'rasterization', '2d_canvas', 'webgl', 'video_decode']
        log('gpu', `${tag}: ${keys.filter((k) => st[k]).map((k) => `${k}=${st[k]}`).join(' · ')}`)
        if (st.gpu_compositing && st.gpu_compositing !== 'enabled') {
          log('gpu', `CẢNH BÁO: gpu_compositing=${st.gpu_compositing} → Chromium KHÔNG cấp shared texture, Spout phải chạy CPU fallback`)
        }
      } catch (e) {
        log('gpu', `không đọc được GPUFeatureStatus: ${(e as Error).message}`)
      }
    }

    app
      .getGPUInfo('basic')
      .then((info: any) => {
        const gs = (info && info.gpuDevice) || []
        for (const g of gs) {
          log('gpu', `adapter vendor=0x${Number(g.vendorId).toString(16)} device=0x${Number(g.deviceId).toString(16)}${g.active ? ' ACTIVE' : ''}`)
        }
      })
      .catch(() => { /* không lấy được danh sách adapter */ })

    // CHỈ đọc sau khi GPU process đã báo cáo xong. Đọc sớm luôn ra
    // "disabled_software" dù GPU vẫn chạy tốt → báo động giả, đã dính một lần.
    setTimeout(() => dump('GPU'), 6000)
    setTimeout(() => dump('GPU (kiểm lại)'), 20000)
  }

  status(): SpoutStatus {
    const streams = (Object.entries(this.streams) as Array<[string, Stream]>).map(([role, s]) => ({
      role, name: s.streamName, w: s.resW, h: s.resH, fps: s.fps, sent: s.sent, mode: s.mode, sendMs: s.sendMs
    }))
    let reason = this.available() ? this.lastError : loadReason
    if (!reason && streams.length && streams.every((s) => s.sent === 0)) reason = 'đang chờ frame đầu tiên…'
    return { available: this.available(), reason, logPath: logFile(), streams }
  }

  broadcastWindows(): BrowserWindow[] {
    return Object.values(this.streams)
      .filter((s): s is Stream => !!s)
      .map((s) => s.win)
      .filter((w) => !w.isDestroyed())
  }

  /** Res render thật = res output × scale, làm tròn số CHẴN. */
  private scaled(v: number, scale: number): number {
    const s = Math.min(100, Math.max(25, scale || 100))
    return Math.max(2, Math.round((v * s) / 100 / 2) * 2)
  }

  /** Reconcile theo spout.running. */
  sync(running: boolean, fps: number, scale: number, outputs: Output[]): void {
    if (!this.available()) return
    for (const o of outputs) {
      const role = o.key
      const cur = this.streams[role]
      const w = this.scaled(o.resW, scale)
      const h = this.scaled(o.resH, scale)
      if (running && !cur) {
        this.start(role, o.stream, fps, w, h)
      } else if (!running && cur) {
        this.stop(role)
      } else if (running && cur) {
        if (cur.resW !== w || cur.resH !== h) {
          this.stop(role)
          this.start(role, o.stream, fps, w, h)
        } else if (cur.reqFps !== fps) {
          cur.reqFps = fps
          cur.win.webContents.setFrameRate(fps)
        }
      }
    }
  }

  private start(role: Role, streamName: string, fps: number, resW: number, resH: number): void {
    try {
      if (resW > MAX_TEX || resH > MAX_TEX) {
        this.lastError = `${resW}x${resH} vượt giới hạn texture ${MAX_TEX}px — Spout không chạy được ở res này`
        log('spout', `${role}: ${this.lastError}`)
        return
      }
      const dpr = Math.min(3, Math.max(1, screen.getPrimaryDisplay().scaleFactor || 1))
      const win = new BrowserWindow({
        width: Math.round(resW / dpr),
        height: Math.round(resH / dpr),
        show: false,
        webPreferences: {
          preload: PRELOAD_PATH,
          sandbox: false,
          offscreen: { useSharedTexture: true } as any, // GPU offscreen → shared texture
          backgroundThrottling: false,
          additionalArguments: [`--dj-role=${role}`]
        }
      })
      const st: Stream = {
        win, streamName, resW, resH, opened: false, reqFps: fps, frames: 0, sent: 0, noTexture: 0,
        fps: 0, fpsMark: Date.now(), fpsCount: 0, locked: false, attempts: 0, note: '',
        settleUntil: Date.now() + 2000, mode: 'gpu', sendMs: 0
      }
      this.streams[role] = st

      win.webContents.setFrameRate(fps)
      win.webContents.on('paint', (e: any, _dirty: any, image: any) => {
        if (this.streams[role] !== st) return
        st.frames++
        const tex = e && e.texture
        if (!tex) {
          // Chromium không cấp shared texture (GPU compositing tắt / khung quá lớn).
          // Không bỏ cuộc: chuyển sang upload pixel từ CPU để VẪN CÓ tín hiệu Spout.
          st.noTexture++
          // Ngưỡng cao + chỉ sau khi hết thời gian ổn định: lúc mới mở / vừa đổi
          // kích thước, Chromium có thể hụt texture vài frame rồi cấp lại bình thường.
          if (st.mode !== 'cpu' && st.noTexture >= 30 && Date.now() > st.settleUntil) {
            st.mode = 'cpu'
            const sz = image && image.getSize ? image.getSize() : null
            log('spout', `${role}: KHÔNG có shared texture (frame ${sz ? sz.width + 'x' + sz.height : '?'}) → chuyển CPU FALLBACK (upload pixel). Chậm hơn GPU nhưng vẫn ra hình.`)
          }
          if (st.mode === 'cpu') this.sendCpuFrame(st, role, win, image)
          return
        }
        try {
          // Texture quay lại sau khi đã rơi xuống CPU → trả về đường GPU.
          if (st.mode === 'cpu') {
            st.mode = 'gpu'
            st.noTexture = 0
            log('spout', `${role}: có shared texture trở lại → quay về đường GPU`)
          }
          const info = tex.textureInfo
          const r = (info && info.visibleRect) || { x: 0, y: 0, width: 0, height: 0 }

          if (!this.sizeReady(st, role, win, r.width, r.height)) return

          const handle = info && info.sharedTextureHandle
          if (!handle) {
            this.fail(st, 'textureInfo thiếu sharedTextureHandle')
            return
          }
          if (!st.opened) st.opened = !!spout.open(streamName)
          if (!st.opened) {
            this.fail(st, 'spout.open thất bại')
            return
          }
          const ok = spout.sendHandle(streamName, handle, r.x | 0, r.y | 0, r.width | 0, r.height | 0)
          if (ok) {
            if (st.sent === 0) {
              const adapter = spout.adapterOf ? spout.adapterOf(streamName) : -1
              log('spout', `${role}: ĐANG PHÁT "${streamName}" ${r.width}x${r.height} qua GPU adapter ${adapter}`)
              this.lastError = ''
              st.note = ''
            }
            this.countFrame(st)
          } else if (st.sent === 0 && st.frames > 20) {
            this.fail(st, spout.lastError ? spout.lastError() : 'sendHandle thất bại')
          }
        } catch (err) {
          this.fail(st, (err as Error).message)
        } finally {
          try { tex.release() } catch { /* đã release */ }
        }
      })
      loadOutputRenderer(win, role)
      log('spout', `start "${streamName}" (${role}) @ ${resW}x${resH}, dpr=${dpr}, css=${Math.round(resW / dpr)}x${Math.round(resH / dpr)}`)
    } catch (e) {
      this.lastError = (e as Error).message
      log('spout', `start lỗi (${role}): ${this.lastError}`)
    }
  }

  /** Frame đã đúng kích thước chưa? Trả false = bỏ frame này, chờ tiếp.
   *
   *  BẢN CŨ SAI CHẾT NGƯỜI: nó lấy frame ĐẦU TIÊN (Chromium hay phát vài frame
   *  tạm ở kích thước màn hình, vd 2560x1080) rồi nhân tỉ lệ để "sửa" cửa sổ →
   *  phóng CSS 8792 lên 37744 → khung 47180px, vượt xa giới hạn 16384 → Chromium
   *  bỏ shared texture VÀ làm GPU process crash 3 lần → Chromium tắt luôn GPU
   *  compositing cả phiên. Chính nó gây ra "không có tín hiệu Spout" + lag.
   *
   *  Bản này: (1) chờ 2 giây cho kích thước ổn định, (2) chỉ sửa MỘT lần,
   *  (3) CSS không bao giờ vượt quá res đích — vì dpr >= 1 nên CSS luôn <= res.
   */
  private sizeReady(st: Stream, role: Role, win: BrowserWindow, w: number, h: number): boolean {
    if (st.locked) return true
    if (Math.abs(w - st.resW) <= 2 && Math.abs(h - st.resH) <= 2) {
      st.locked = true
      return true
    }
    if (Date.now() < st.settleUntil) return false // frame tạm lúc khởi động, bỏ qua

    if (st.attempts === 0 && !win.isDestroyed() && w > 0 && h > 0) {
      st.attempts++
      const [cw, ch] = win.getContentSize()
      // CSS = res / dpr_đo_được, KẸP trong (res/4 .. res] — dpr < 1 là vô lý.
      const clamp = (v: number, target: number): number =>
        Math.max(Math.round(target / 4), Math.min(target, Math.max(1, v)))
      const nw = clamp(Math.round(st.resW / (w / cw)), st.resW)
      const nh = clamp(Math.round(st.resH / (h / ch)), st.resH)
      if (nw !== cw || nh !== ch) {
        log('spout', `${role}: frame ${w}x${h} != ${st.resW}x${st.resH} → chỉnh cửa sổ ${cw}x${ch}→${nw}x${nh} (1 lần duy nhất)`)
        win.setContentSize(nw, nh)
        st.settleUntil = Date.now() + 2000
        return false
      }
    }

    // Chỉnh rồi vẫn lệch → CHẤP NHẬN kích thước thật, không đụng vào cửa sổ nữa.
    st.locked = true
    log('spout', `${role}: phát ở ${w}x${h} (khác ${st.resW}x${st.resH} đã đặt) — không chỉnh thêm để khỏi làm chết GPU`)
    return true
  }

  /** Đường dự phòng: lấy bitmap BGRA từ paint rồi upload thẳng lên texture Spout.
   *  KHÔNG Buffer.from — sendImage copy đồng bộ ngay trong lời gọi nên dùng
   *  thẳng bitmap của Electron, tiết kiệm hẳn một lần memcpy cỡ 47MB. */
  private sendCpuFrame(st: Stream, role: Role, win: BrowserWindow, image: any): void {
    if (!image || !image.getSize) return
    const sz = image.getSize()
    if (!sz.width || !sz.height) return

    if (!this.sizeReady(st, role, win, sz.width, sz.height)) return

    if (!st.opened) st.opened = !!spout.open(st.streamName)
    if (!st.opened) { this.fail(st, 'spout.open thất bại'); return }

    const t0 = Date.now()
    const ok = spout.sendImage(st.streamName, image.getBitmap(), sz.width, sz.height)
    st.sendMs = Date.now() - t0
    if (ok) {
      if (st.sent === 0) {
        const adapter = spout.adapterOf ? spout.adapterOf(st.streamName) : -1
        log('spout', `${role}: ĐANG PHÁT "${st.streamName}" ${sz.width}x${sz.height} (CPU fallback, GPU adapter ${adapter})`)
        this.lastError = ''
        st.note = ''
      }
      this.countFrame(st)
    } else if (st.sent === 0 && st.frames > 20) {
      this.fail(st, spout.lastError ? spout.lastError() : 'sendImage thất bại')
    }
  }

  private countFrame(st: Stream): void {
    st.sent++
    st.fpsCount++
    const now = Date.now()
    if (now - st.fpsMark >= 1000) {
      st.fps = Math.round((st.fpsCount * 1000) / (now - st.fpsMark))
      st.fpsMark = now
      st.fpsCount = 0
    }
  }

  /** Ghi 1 lần cho mỗi lý do (paint chạy 30-60 lần/giây, không spam log). */
  private fail(st: Stream, msg: string): void {
    this.lastError = msg
    if (st.note === msg) return
    st.note = msg
    log('spout', `${st.streamName}: ${msg}`)
  }

  private stop(role: Role): void {
    const st = this.streams[role]
    if (!st) return
    delete this.streams[role]
    try { if (spout && spout.close) spout.close(st.streamName) } catch { /* ignore */ }
    try { if (!st.win.isDestroyed()) st.win.destroy() } catch { /* đã chết */ }
    log('spout', `stop "${st.streamName}" (${role}) — đã gửi ${st.sent} frame, ${st.noTexture} paint không có texture`)
  }

  stopAll(): void {
    for (const role of Object.keys(this.streams) as Role[]) this.stop(role)
  }
}
