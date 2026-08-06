// ============================================================================
// NdiService — ĐƯỜNG RA CHÍNH của show: app chạy ở một máy, Resolume Arena ở máy
// khác. Spout chia sẻ texture trong bộ nhớ GPU nên không bao giờ vượt được sang
// máy thứ hai; NDI đi qua mạng nên vượt được. Đó là toàn bộ lý do phải chọn NDI.
//
// NDI đi đường CPU: mỗi frame 10350×1080 = 44.7MB copy về RAM rồi nén SpeedHQ.
//
// SỐ ĐO THẬT của app này (M4 Max, Electron 33, MỘT bề mặt tường):
//   100% res, 30fps  → giữ đủ 30fps, copy 5-6ms/frame
//    50% res, 30fps  → giữ đủ 30fps, copy 1-2ms/frame
//   xin 60fps         → vẫn chỉ ra ~30fps (OSR trên macOS raster bằng CPU)
// Nhẹ hơn nhiều so với con số 33-52ms ở project DAY3 trước, vì ở đó có tới HAI
// bề mặt (tường + sàn) cùng copy trên một main thread.
//
// Mặc định BẬT. Chỉ tắt khi đổi sang setup một máy (lúc đó dùng Spout), vì bật
// cả hai đường nghĩa là render scene thêm một lần nữa mà chẳng để làm gì.
// ============================================================================
import { BrowserWindow, screen } from 'electron'
import { hostname } from 'os'
import { Output, OutputKey, NdiStatus } from '../shared/types'
import { PRELOAD_PATH, loadOutputRenderer } from './windows'
import { log } from './log'

/* eslint-disable @typescript-eslint/no-explicit-any */
let ndi: any = null
let loadReason = ''
try {
  // optionalDependency — thiếu thì app vẫn chạy, chỉ mất đường NDI.
  ndi = require('@stagetimerio/grandiose')
} catch (e) {
  loadReason = `@stagetimerio/grandiose không nạp được: ${(e as Error).message}`
}

const FOURCC_BGRA = 0x41524742 // 'BGRA' — NDIlib_FourCC_type_BGRA
const FORMAT_PROGRESSIVE = 1 // NDIlib_frame_format_type_progressive

interface Stream {
  win: BrowserWindow
  sender: any
  name: string
  resW: number
  resH: number
  reqFps: number
  sent: number
  fps: number
  fpsMark: number
  fpsCount: number
  copyMs: number
  inflight: boolean // KHÔNG BAO GIỜ cho >1 frame inflight: NDI SDK không thread-safe
  note: string
  starting: boolean
  slowMark: number // lần cuối kêu tụt fps — để không spam log
}

export class NdiService {
  private streams: Partial<Record<OutputKey, Stream>> = {}
  private lastError = ''

  available(): boolean {
    return !!(ndi && ndi.send)
  }

  /** Ghi thẳng vào log lúc khởi động. NDI là đường ra DUY NHẤT khi Resolume nằm ở
   *  máy khác — nếu addon không nạp được thì phải biết NGAY lúc mở app, chứ không
   *  phải lúc đứng ở venue nhìn Resolume trống trơn. */
  logAvailability(): void {
    if (this.available()) {
      log('ndi', 'addon @stagetimerio/grandiose nạp OK — sẵn sàng phát')
    } else {
      log('ndi', `ADDON KHÔNG NẠP ĐƯỢC: ${loadReason || 'không rõ'}`)
      log('ndi', 'không có addon thì KHÔNG có đường ra nào sang máy khác (Spout chỉ chạy trong cùng một máy)')
    }
  }

  status(): NdiStatus {
    const streams = (Object.entries(this.streams) as Array<[string, Stream]>).map(([role, s]) => ({
      role, name: s.name, w: s.resW, h: s.resH, fps: s.fps, sent: s.sent, copyMs: s.copyMs
    }))
    return {
      available: this.available(),
      reason: this.available() ? this.lastError : loadReason || 'chưa cài @stagetimerio/grandiose',
      streams
    }
  }

  broadcastWindows(): BrowserWindow[] {
    return Object.values(this.streams)
      .filter((s): s is Stream => !!s)
      .map((s) => s.win)
      .filter((w) => !w.isDestroyed())
  }

  private scaled(v: number, scale: number): number {
    const s = Math.min(100, Math.max(25, scale || 100))
    return Math.max(2, Math.round((v * s) / 100 / 2) * 2)
  }

  sync(running: boolean, fps: number, scale: number, outputs: Output[]): void {
    if (!this.available()) return
    for (const o of outputs) {
      const role = o.key
      const cur = this.streams[role]
      const w = this.scaled(o.resW, scale)
      const h = this.scaled(o.resH, scale)
      if (running && !cur) this.start(role, o.stream, fps, w, h)
      else if (!running && cur) this.stop(role)
      else if (running && cur) {
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

  private async start(role: OutputKey, name: string, fps: number, resW: number, resH: number): Promise<void> {
    // dpr: cửa sổ offscreen phải có device-pixel = đúng resW, nếu không trên màn
    // Retina (dpr 2) khung sẽ nhân đôi và vượt giới hạn texture 16384.
    const dpr = Math.min(3, Math.max(1, screen.getPrimaryDisplay().scaleFactor || 1))
    const win = new BrowserWindow({
      width: Math.round(resW / dpr),
      height: Math.round(resH / dpr),
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: false,
        offscreen: true, // CPU bitmap — NDI cần pixel, không dùng shared texture được
        backgroundThrottling: false,
        additionalArguments: [`--dj-role=${role}`]
      }
    })
    const st: Stream = {
      win, sender: null, name, resW, resH, reqFps: fps, sent: 0, fps: 0,
      fpsMark: Date.now(), fpsCount: 0, copyMs: 0, inflight: false, note: '', starting: true,
      slowMark: 0
    }
    this.streams[role] = st

    try {
      st.sender = await ndi.send({ name, clockVideo: false, clockAudio: false })
    } catch (e) {
      this.lastError = `tạo sender NDI thất bại: ${(e as Error).message}`
      log('ndi', this.lastError)
      this.stop(role)
      return
    }
    if (this.streams[role] !== st || win.isDestroyed()) return
    st.starting = false

    win.webContents.setFrameRate(fps)
    win.webContents.on('paint', (_e: any, _dirty: any, image: any) => {
      if (this.streams[role] !== st || st.starting || !st.sender) return
      // Bỏ frame khi frame trước chưa gửi xong. Hai lời gọi send song song trên
      // cùng một sender = crash (NDI SDK không có mutex ở tầng này).
      if (st.inflight) return
      if (!image || !image.getSize) return
      const sz = image.getSize()
      if (!sz.width || !sz.height) return

      const t0 = Date.now()
      // Phải copy: grandiose đọc buffer trên libuv thread sau khi callback đã
      // trả về, còn bitmap của Electron chỉ sống trong lời gọi này.
      const data = Buffer.from(image.getBitmap())
      st.copyMs = Date.now() - t0
      st.inflight = true
      Promise.resolve(
        // Bỏ hẳn timecode: để NDI tự sinh. Đưa số cố định vào là mọi frame trùng
        // dấu thời gian, phía nhận sẽ coi là frame lặp.
        st.sender.video({
          xres: sz.width,
          yres: sz.height,
          frameRateN: Math.round(st.reqFps * 1000),
          frameRateD: 1000,
          pictureAspectRatio: sz.width / sz.height,
          frameFormatType: FORMAT_PROGRESSIVE,
          lineStrideBytes: sz.width * 4,
          fourCC: FOURCC_BGRA,
          data
        })
      )
        .then(() => {
          if (st.sent === 0) {
            // Tên máy phát nằm trong tên nguồn NDI: bên Resolume sẽ thấy là
            // "TÊNMÁY (DimensionWall)". Ghi ra để lúc dò nguồn còn biết tìm gì.
            log('ndi', `${role}: ĐANG PHÁT "${name}" ${sz.width}x${sz.height} @${st.reqFps}fps` +
              ` — bên Resolume tìm nguồn "${hostname()} (${name})"`)
            // Quy đổi từ mốc thật của NDI High Bandwidth: 1080p60 (124 triệu
            // pixel/giây) ≈ 125 Mbps. Tức là xấp xỉ 1 Mbps cho mỗi triệu pixel
            // mỗi giây. Đừng tính theo "nén 1:10" — sai gấp ba lần.
            const mbps = Math.round((sz.width * sz.height * st.reqFps) / 1e6)
            log('ndi', `băng thông ước tính ~${mbps} Mbps — cần dây gigabit, KHÔNG dùng WiFi`)
            this.lastError = ''
          }
          st.sent++
          st.fpsCount++
          const now = Date.now()
          if (now - st.fpsMark >= 1000) {
            st.fps = Math.round((st.fpsCount * 1000) / (now - st.fpsMark))
            st.fpsMark = now
            st.fpsCount = 0
            // Tụt fps là thứ khán giả nhìn thấy trước cả khi operator kịp nhận ra.
            // Nói thẳng cả con số lẫn cách chữa, mỗi 10s một lần cho khỏi ngập log.
            // Bỏ qua vài giây đầu: giây đầu tiên luôn thiếu frame vì cửa sổ
            // offscreen còn đang dựng scene, kêu lúc đó là kêu oan.
            if (st.sent > st.reqFps * 3 && st.fps < st.reqFps * 0.7 && now - st.slowMark > 10000) {
              st.slowMark = now
              log('ndi', `${role}: CHỈ RA ${st.fps}/${st.reqFps}fps (copy ${st.copyMs}ms/frame)` +
                ' — hạ "Res gửi" xuống 75%/50%, hoặc tắt bớt bề mặt sàn')
            }
          }
        })
        .catch((err: Error) => {
          if (st.note !== err.message) {
            st.note = err.message
            this.lastError = err.message
            log('ndi', `${role}: gửi frame lỗi — ${err.message}`)
          }
        })
        .finally(() => {
          st.inflight = false
        })
    })

    loadOutputRenderer(win, role)
    log('ndi', `start "${name}" (${role}) @ ${resW}x${resH}, dpr=${dpr}`)
  }

  private stop(role: OutputKey): void {
    const st = this.streams[role]
    if (!st) return
    delete this.streams[role]
    try { if (st.sender && st.sender.destroy) st.sender.destroy() } catch { /* đã đóng */ }
    try { if (!st.win.isDestroyed()) st.win.destroy() } catch { /* đã chết */ }
    log('ndi', `stop "${st.name}" (${role}) — đã gửi ${st.sent} frame`)
  }

  stopAll(): void {
    for (const role of Object.keys(this.streams) as OutputKey[]) this.stop(role)
  }
}
