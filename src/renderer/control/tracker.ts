// ============================================================================
// HandTracker — MediaPipe HandLandmarker, CHẠY DUY NHẤT ở cửa sổ Control rồi
// phát kết quả sang các cửa sổ chiếu. Nếu để mỗi cửa sổ tự chạy thì có 3 bản
// MediaPipe cùng ăn CPU trong khi kết quả y hệt nhau.
//
// Model + wasm lấy từ file đóng gói kèm app (main gửi qua IPC) rồi bọc thành
// blob URL — đúng đường mà bản standalone HTML đã chạy được. Không gọi CDN:
// venue thường không có mạng.
//
// Hai nguồn ảnh:
//   'camera' — webcam/UVC qua getUserMedia
//   'kinect' — ảnh hồng ngoại do Kinect bridge đẩy qua WebSocket. Phòng chiếu
//              tối om thì webcam RGB mù, còn Kinect tự rọi IR nên vẫn thấy tay.
// ============================================================================
import { HandFrame, AppState } from '../../shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Landmark = { x: number; y: number; z: number }

const CONN: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
]

const MIME: Record<string, string> = {
  bundle: 'text/javascript',
  wasmJs: 'text/javascript',
  wasmBin: 'application/wasm',
  model: 'application/octet-stream'
}

export interface TrackerCallbacks {
  onHand: (h: HandFrame) => void
  onStatus: (text: string, tone: 'ok' | 'warn' | 'bad') => void
  onStageAdvance: () => void
}

export class HandTracker {
  private landmarker: any = null
  private video: HTMLVideoElement
  private preview: HTMLCanvasElement
  private stream: MediaStream | null = null
  private cb: TrackerCallbacks
  private state: AppState

  private lastVideoTime = -1
  private pinched = false
  private handSeen = 0
  private fistTime = 0
  private fistArmed = true
  private ring = 0
  private dead = false

  /** Ảnh IR mới nhất từ Kinect bridge, đã giải mã. */
  private kinectBitmap: ImageBitmap | null = null
  private kinectCanvas = document.createElement('canvas')
  private kinectSeq = 0
  private lastKinectSeq = -1
  private kinectDecoding = false

  constructor(video: HTMLVideoElement, preview: HTMLCanvasElement, state: AppState, cb: TrackerCallbacks) {
    this.video = video
    this.preview = preview
    this.state = state
    this.cb = cb
  }

  setState(s: AppState): void {
    this.state = s
  }

  // ------------------------------------------------------------ khởi tạo
  async init(): Promise<void> {
    this.cb.onStatus('đang nạp mô hình tracking…', 'warn')
    let mp: any
    try {
      const [bundle, wasmJs, wasmBin, model] = await Promise.all(
        ['bundle', 'wasmJs', 'wasmBin', 'model'].map((n) => window.dj.mpAsset(n))
      )
      if (!bundle || !wasmJs || !wasmBin || !model) {
        this.cb.onStatus('thiếu file MediaPipe trong resources/ — không tracking được', 'bad')
        return
      }
      const url = (buf: Uint8Array, key: string): string =>
        // Cắt ra ArrayBuffer thường: Blob không nhận view trên SharedArrayBuffer.
        URL.createObjectURL(new Blob([new Uint8Array(buf).slice().buffer], { type: MIME[key] }))

      // Import module ES qua blob URL để không phụ thuộc MIME của file:// .
      mp = await import(/* @vite-ignore */ url(bundle, 'bundle'))
      this.landmarker = await this.makeLandmarker(mp, url(wasmJs, 'wasmJs'), url(wasmBin, 'wasmBin'), model)
    } catch (e) {
      this.cb.onStatus(`nạp MediaPipe lỗi: ${(e as Error).message}`, 'bad')
      return
    }
    this.cb.onStatus('mô hình sẵn sàng', 'ok')
  }

  private async makeLandmarker(mp: any, wasmJs: string, wasmBin: string, model: Uint8Array): Promise<any> {
    const resolver = { wasmLoaderPath: wasmJs, wasmBinaryPath: wasmBin }
    const make = (delegate: 'GPU' | 'CPU'): Promise<any> =>
      mp.HandLandmarker.createFromOptions(resolver, {
        baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
        runningMode: 'VIDEO',
        numHands: 1
      })
    try {
      return await make('GPU')
    } catch {
      // Máy không cho WebGL trong worker của MediaPipe → CPU vẫn đủ cho 1 tay.
      return await make('CPU')
    }
  }

  // ------------------------------------------------------------ nguồn ảnh
  async openCamera(deviceId: string): Promise<void> {
    this.closeCamera()
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: 640, height: 480 }
          : { width: 640, height: 480, facingMode: 'user' }
      })
      this.video.muted = true
      this.video.playsInline = true
      this.video.autoplay = true
      this.video.srcObject = this.stream
      await this.video.play()
      this.cb.onStatus('camera đang chạy', 'ok')
    } catch (e) {
      this.cb.onStatus(`không mở được camera: ${(e as Error).message}`, 'bad')
    }
  }

  closeCamera(): void {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
  }

  /** Frame JSON từ Kinect bridge. Giải mã ảnh IR không đồng bộ, bỏ frame nếu
   *  frame trước còn đang giải mã — thà rớt frame còn hơn dồn hàng đợi. */
  onKinectJson(json: string): void {
    if (this.kinectDecoding) return
    let msg: any
    try { msg = JSON.parse(json) } catch { return }
    if (!msg || !msg.ir) return
    this.kinectDecoding = true
    fetch(`data:image/jpeg;base64,${msg.ir}`)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        this.kinectBitmap?.close()
        this.kinectBitmap = bmp
        this.kinectSeq++
      })
      .catch(() => { /* frame hỏng, bỏ qua */ })
      .finally(() => { this.kinectDecoding = false })
  }

  // ------------------------------------------------------------- mỗi frame
  tick(dt: number): void {
    if (this.dead || !this.landmarker) return
    const src = this.state.input.source
    if (src === 'mouse') return

    let image: HTMLVideoElement | HTMLCanvasElement | null = null
    if (src === 'kinect') {
      if (!this.kinectBitmap || this.kinectSeq === this.lastKinectSeq) return
      this.lastKinectSeq = this.kinectSeq
      const c = this.kinectCanvas
      if (c.width !== this.kinectBitmap.width) {
        c.width = this.kinectBitmap.width
        c.height = this.kinectBitmap.height
      }
      c.getContext('2d')!.drawImage(this.kinectBitmap, 0, 0)
      image = c
    } else {
      if (this.video.readyState < 2) return
      if (this.lastVideoTime === this.video.currentTime) return
      this.lastVideoTime = this.video.currentTime
      image = this.video
    }

    let result: any
    try {
      result = this.landmarker.detectForVideo(image, performance.now())
    } catch {
      return
    }
    const lms: Landmark[] | undefined = result?.landmarks?.[0]
    this.drawPreview(lms)
    this.emit(lms, dt)
  }

  private emit(lms: Landmark[] | undefined, dt: number): void {
    if (!lms) {
      this.handSeen = Math.max(0, this.handSeen - 1)
      if (this.handSeen === 0) {
        this.pinched = false
        this.fistTime = 0
        this.ring = 0
        this.cb.onHand({ present: false, nx: 0.5, ny: 0.5, pinch: false, palm: false, fist: false, ring: 0, label: 'đưa tay vào khung' })
      }
      return
    }
    this.handSeen = 4

    const w = lms[0]
    const d = (a: Landmark, b: Landmark): number => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))
    const ext = ([[8, 6], [12, 10], [16, 14], [20, 18]] as [number, number][])
      .map(([tip, pip]) => d(lms[tip], w) > d(lms[pip], w) * 1.08)
    const extCount = ext.filter(Boolean).length

    // Chụm ngón có TRỄ HAI NGƯỠNG: mở ra phải rộng hơn ngưỡng đóng, nếu không
    // tay run một chút là nét đứt thành hàng chục mẩu.
    const handScale = d(lms[0], lms[9]) || 0.001
    const pinchD = d(lms[4], lms[8]) / handScale
    const indexReach = d(lms[8], lms[0]) / handScale
    const thr = this.state.input.pinchThreshold
    if (!this.pinched && pinchD < thr && indexReach > 1.2) this.pinched = true
    else if (this.pinched && (pinchD > thr * 1.45 || indexReach < 1.05)) this.pinched = false

    const palm = extCount >= 4 && !this.pinched
    const fist = extCount === 0 && !this.pinched

    // Đầu bút = trung điểm ngón cái + ngón trỏ, lật gương cho khớp cảm giác soi gương.
    const nx = 1 - (lms[4].x + lms[8].x) / 2
    const ny = (lms[4].y + lms[8].y) / 2

    let label = this.pinched ? 'đang vẽ' : 'chụm ngón để vẽ'
    if (fist && this.fistArmed) {
      this.fistTime += dt
      this.ring = Math.min(1, this.fistTime / 1.0)
      label = 'nắm đấm — giữ để chuyển chiều'
      if (this.ring >= 1) {
        this.fistArmed = false
        this.fistTime = 0
        this.ring = 0
        this.cb.onStageAdvance()
      }
    } else if (fist) {
      label = 'thả nắm đấm ra'
    } else {
      this.fistArmed = true
      this.fistTime = 0
      this.ring = 0
      if (palm) label = 'xoè bàn tay — xoay trường (5D)'
    }

    this.cb.onHand({
      present: true, nx, ny,
      pinch: this.pinched && !fist,
      palm, fist,
      ring: this.ring,
      label
    })
  }

  private drawPreview(lms: Landmark[] | undefined): void {
    const cv = this.preview
    const g = cv.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, cv.width, cv.height)
    if (!lms) return
    const X = (p: Landmark): number => (1 - p.x) * cv.width
    const Y = (p: Landmark): number => p.y * cv.height
    g.strokeStyle = 'rgba(167,139,250,0.75)'
    g.lineWidth = 1.5
    g.beginPath()
    for (const [a, b] of CONN) { g.moveTo(X(lms[a]), Y(lms[a])); g.lineTo(X(lms[b]), Y(lms[b])) }
    g.stroke()
    g.fillStyle = '#e9d5ff'
    for (const p of lms) { g.beginPath(); g.arc(X(p), Y(p), 2, 0, 7); g.fill() }
    const pc = this.pinched ? '#5ee6a8' : 'rgba(94,230,168,0.45)'
    g.strokeStyle = pc
    g.lineWidth = 2
    g.beginPath(); g.moveTo(X(lms[4]), Y(lms[4])); g.lineTo(X(lms[8]), Y(lms[8])); g.stroke()
    g.fillStyle = pc
    for (const i of [4, 8]) { g.beginPath(); g.arc(X(lms[i]), Y(lms[i]), 4, 0, 7); g.fill() }
  }

  dispose(): void {
    this.dead = true
    this.closeCamera()
    this.kinectBitmap?.close()
    try { this.landmarker?.close?.() } catch { /* đã đóng */ }
  }
}
