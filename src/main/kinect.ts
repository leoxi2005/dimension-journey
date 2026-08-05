// ============================================================================
// KinectBridge — máy chủ WebSocket nhận dữ liệu từ app cầu nối Kinect v2.
//
// VÌ SAO PHẢI CÓ CẦU NỐI RIÊNG: Kinect v2 KHÔNG hiện ra như webcam UVC, bắt
// buộc phải qua Kinect SDK 2.0 (COM/.NET, chỉ Windows). Nhét SDK đó vào Electron
// bằng native addon là đường dài và dễ vỡ. Cách rẻ và chắc hơn: một app C# nhỏ
// đọc Kinect rồi đẩy sang đây qua WebSocket. Nguồn C# nằm ở kinect-bridge/.
//
// Giao thức (bridge -> app), mỗi frame một message JSON:
//   { "t": <ms>,
//     "ir": "<base64 JPEG ảnh hồng ngoại 512x424>",   // tuỳ chọn
//     "hands": [ { "x":0..1, "y":0..1, "state":"open|closed|lasso|unknown" } ] }
//
// Ảnh IR là thứ đáng giá nhất: phòng chiếu tối om thì webcam RGB mù, còn Kinect
// tự rọi hồng ngoại nên vẫn thấy rõ tay. App chạy MediaPipe TRÊN ảnh IR đó.
// ============================================================================
import { BrowserWindow } from 'electron'
import { KinectStatus } from '../shared/types'
import { log } from './log'

/* eslint-disable @typescript-eslint/no-explicit-any */
let WebSocketServer: any = null
let loadReason = ''
try {
  WebSocketServer = require('ws').WebSocketServer
} catch (e) {
  loadReason = `ws không nạp được: ${(e as Error).message}`
}

export class KinectBridge {
  private wss: any = null
  private port = 0
  private client: any = null
  private frames = 0
  private fps = 0
  private fpsMark = Date.now()
  private reason = ''
  /** Cửa sổ nhận frame — chỉ Control (nơi chạy MediaPipe). */
  target: (() => BrowserWindow | undefined) | null = null

  status(): KinectStatus {
    return {
      listening: !!this.wss,
      port: this.port,
      connected: !!this.client,
      fps: this.fps,
      reason: this.reason || loadReason
    }
  }

  /** Bật/tắt theo nguồn input đang chọn. Đổi cổng thì mở lại. */
  sync(enabled: boolean, port: number): void {
    if (!WebSocketServer) return
    if (enabled && this.wss && this.port === port) return
    if (this.wss) this.stop()
    if (!enabled) return

    try {
      this.wss = new WebSocketServer({ port, host: '127.0.0.1' })
      this.port = port
      this.reason = ''
      log('kinect', `đang nghe ws://127.0.0.1:${port} — chờ Kinect bridge kết nối`)
      this.wss.on('connection', (sock: any) => {
        // Một nguồn tại một thời điểm; kết nối mới thay kết nối cũ.
        if (this.client) { try { this.client.close() } catch { /* đã đóng */ } }
        this.client = sock
        log('kinect', 'bridge đã kết nối')
        sock.on('message', (raw: Buffer) => this.onMessage(raw))
        sock.on('close', () => {
          if (this.client === sock) this.client = null
          log('kinect', 'bridge ngắt kết nối')
        })
        sock.on('error', (e: Error) => log('kinect', `lỗi socket: ${e.message}`))
      })
      this.wss.on('error', (e: Error) => {
        this.reason = e.message
        log('kinect', `không mở được cổng ${port}: ${e.message}`)
      })
    } catch (e) {
      this.reason = (e as Error).message
      log('kinect', `mở server lỗi: ${this.reason}`)
    }
  }

  private onMessage(raw: Buffer): void {
    this.frames++
    const now = Date.now()
    if (now - this.fpsMark >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsMark))
      this.frames = 0
      this.fpsMark = now
    }
    const win = this.target?.()
    if (!win || win.isDestroyed()) return
    // Chuyển thẳng chuỗi JSON sang Control, không parse ở main: main thread
    // phải rảnh, và Control mới là nơi cần dữ liệu.
    win.webContents.send('dj:kinectFrame', raw.toString('utf8'))
  }

  stop(): void {
    try { if (this.client) this.client.close() } catch { /* đã đóng */ }
    try { if (this.wss) this.wss.close() } catch { /* đã đóng */ }
    this.client = null
    this.wss = null
    this.fps = 0
  }
}
