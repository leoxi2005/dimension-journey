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

/** Bộ lọc One Euro — chuẩn cho dữ liệu tay. Lerp thô phải chọn một trong hai:
 *  mượt nhưng trễ, hoặc nhạy nhưng rung. One Euro tự nới tần số cắt theo tốc độ:
 *  tay đứng yên thì lọc mạnh (hết rung), tay quét nhanh thì gần như không lọc
 *  (hết trễ). Đây là lý do nét vẽ trước đây "đi theo không kịp" khi xoay tay. */
class OneEuro {
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev = 0
  constructor(private minCutoff = 2.3, private beta = 1.2, private dCutoff = 1.0) {}

  setMinCutoff(v: number): void {
    this.minCutoff = v
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x
      this.tPrev = t
      return x
    }
    const dt = Math.min(0.2, Math.max(1 / 240, t - this.tPrev))
    this.tPrev = t
    const dx = (x - this.xPrev) / dt
    const aD = this.alpha(this.dCutoff, dt)
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev
    const a = this.alpha(this.minCutoff + this.beta * Math.abs(this.dxPrev), dt)
    this.xPrev = a * x + (1 - a) * this.xPrev
    return this.xPrev
  }

  reset(): void {
    this.xPrev = null
    this.dxPrev = 0
  }
}

export interface TrackerCallbacks {
  onHand: (h: HandFrame) => void
  /** Số đo cử chỉ sống, hiện dưới ô xem trước để chỉnh ngưỡng tại venue. */
  onDebug: (text: string) => void
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
  private fistMiss = 0   // số frame liên tiếp KHÔNG thấy nắm đấm
  private pinchMiss = 0  // số frame liên tiếp thấy nhả chụm
  private ring = 0
  private dead = false
  private fx = new OneEuro()
  private fy = new OneEuro()

  /** Khung IR mới nhất từ Kinect bridge, đã vẽ sẵn vào canvas cho MediaPipe đọc. */
  private kinectCanvas = document.createElement('canvas')
  private kinectRgba: ImageData | null = null
  private kinectReady = false
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
        // Xin 60fps: mỗi frame camera thiếu là thêm ~33ms trễ mà không cách nào
        // bù lại được ở phía sau. 'ideal' nên camera 30fps vẫn nhận bình thường.
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: 640, height: 480, frameRate: { ideal: 60 } }
          : { width: 640, height: 480, facingMode: 'user', frameRate: { ideal: 60 } }
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

  /** Frame từ Kinect bridge — nhị phân (nhanh) hoặc JSON+JPEG (tương thích). */
  onKinectFrame(frame: string | Uint8Array): void {
    if (typeof frame === 'string') this.onKinectJson(frame)
    else this.onKinectBinary(frame)
  }

  /** Đường NHANH — gói nhị phân thô, không nén:
   *    'DJIR' + w:uint16 + h:uint16 + channels:uint8 + reserved:uint8 + pixel
   *    channels = 1 (xám, nguồn IR) hoặc 3 (RGB, nguồn camera màu).
   *  Ghi thẳng vào canvas mà MediaPipe sẽ đọc — bỏ được cả giải nén lẫn bước
   *  createImageBitmap bất đồng bộ. */
  private onKinectBinary(buf: Uint8Array): void {
    if (buf.length < 10) return
    if (buf[0] !== 0x44 || buf[1] !== 0x4a || buf[2] !== 0x49 || buf[3] !== 0x52) return // 'DJIR'
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const w = dv.getUint16(4, true)
    const h = dv.getUint16(6, true)
    const ch = buf[8] || 1
    if (w <= 0 || h <= 0 || (ch !== 1 && ch !== 3)) return
    if (buf.length < 10 + w * h * ch) return

    const c = this.kinectCanvas
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
      this.kinectRgba = null
    }
    const g = c.getContext('2d', { willReadFrequently: false })
    if (!g) return
    if (!this.kinectRgba || this.kinectRgba.width !== w) {
      this.kinectRgba = g.createImageData(w, h)
    }
    // Ghi qua khung nhìn 32-bit: một lần ghi mỗi pixel thay vì bốn.
    // (Little endian nên thứ tự byte trong ô 32-bit là A,B,G,R ngược lại.)
    const out = new Uint32Array(this.kinectRgba.data.buffer)
    const n = w * h
    if (ch === 1) {
      for (let i = 0; i < n; i++) {
        const v = buf[10 + i]
        out[i] = 0xff000000 | (v << 16) | (v << 8) | v
      }
    } else {
      for (let i = 0, o = 10; i < n; i++, o += 3) {
        out[i] = 0xff000000 | (buf[o + 2] << 16) | (buf[o + 1] << 8) | buf[o]
      }
    }
    g.putImageData(this.kinectRgba, 0, 0)
    if (!this.kinectReady) {
      window.dj.log('kinect', `frame đầu tiên: ${w}x${h} ${ch === 3 ? 'MÀU' : 'XÁM/IR'} nhị phân thô`)
    }
    this.kinectReady = true
    this.kinectSeq++
  }

  /** Đường TƯƠNG THÍCH: JSON + JPEG base64. Giải mã bất đồng bộ; bỏ frame nếu
   *  frame trước còn đang giải mã — thà rớt frame còn hơn dồn hàng đợi. */
  private onKinectJson(json: string): void {
    if (this.kinectDecoding) return
    let msg: any
    try { msg = JSON.parse(json) } catch { return }
    if (!msg || !msg.ir) return
    this.kinectDecoding = true
    fetch(`data:image/jpeg;base64,${msg.ir}`)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        const c = this.kinectCanvas
        if (c.width !== bmp.width || c.height !== bmp.height) {
          c.width = bmp.width
          c.height = bmp.height
        }
        c.getContext('2d')?.drawImage(bmp, 0, 0)
        bmp.close()
        if (!this.kinectReady) window.dj.log('kinect', `frame đầu tiên: ${c.width}x${c.height} JPEG`)
        this.kinectReady = true
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
      // Chỉ chạy khi có frame MỚI: detectForVideo trên cùng một ảnh hai lần vừa
      // phí CPU vừa làm MediaPipe hiểu sai vận tốc giữa các frame.
      if (!this.kinectReady || this.kinectSeq === this.lastKinectSeq) return
      this.lastKinectSeq = this.kinectSeq
      image = this.kinectCanvas
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
    const world: Landmark[] | undefined = result?.worldLandmarks?.[0]
    this.drawPreview(lms)
    this.emit(lms, world, dt)
  }

  private emit(lms: Landmark[] | undefined, world: Landmark[] | undefined, dt: number): void {
    if (!lms) {
      this.handSeen = Math.max(0, this.handSeen - 1)
      if (this.handSeen === 0) {
        this.pinched = false
        this.pinchMiss = 0
        this.fistTime = 0
        this.fistMiss = 0
        this.ring = 0
        // Không reset thì tay bước vào khung sẽ bị kéo lê một vệt từ chỗ cũ.
        this.fx.reset()
        this.fy.reset()
          this.cb.onDebug('không thấy tay')
        this.cb.onHand({ present: false, nx: 0.5, ny: 0.5, pinch: false, palm: false, fist: false, ring: 0, label: 'đưa tay vào khung' })
      }
      return
    }
    this.handSeen = 4

    const d = (a: Landmark, b: Landmark): number => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))

    // Đo cử chỉ trên worldLandmarks — toạ độ 3D thật (mét) do MediaPipe dựng lại,
    // KHÔNG bị co khi xoay cổ tay. Toạ độ ảnh thì bị, và đó chính là gốc của lỗi
    // nét đứt giữa chừng. Vị trí con trỏ vẫn lấy từ toạ độ ẢNH ở dưới, vì con trỏ
    // phải bám khung hình chứ không bám bàn tay.
    const g = world && world.length === 21 ? world : lms
    const gw = g[0]
    const ext = ([[8, 6], [12, 10], [16, 14], [20, 18]] as [number, number][])
      .map(([tip, pip]) => d(g[tip], gw) > d(g[pip], gw) * 1.08)
    const extCount = ext.filter(Boolean).length

    const handScale = Math.max(d(g[0], g[5]), d(g[0], g[9]), d(g[0], g[13]), d(g[0], g[17]), 1e-6)
    const pinchD = d(g[4], g[8]) / handScale

    // NGÓN TRỎ DUỖI HAY CUỘN — đây mới là thứ tách "chụm ngón" khỏi "nắm đấm".
    // Nắm đấm cũng làm ngón cái nằm sát ngón trỏ, nên chỉ đo khoảng cách cái-trỏ
    // là KHÔNG đủ: nắm tay sẽ bị hiểu thành chụm ngón, rồi tự khoá luôn việc nhận
    // nắm tay (và còn vẽ ra nét). Tỉ lệ (đầu ngón → khớp gốc)/(tổng chiều dài đốt)
    // ≈ 1 khi duỗi, ≈ 0.3 khi cuộn — không phụ thuộc cỡ tay.
    const bones = d(g[5], g[6]) + d(g[6], g[7]) + d(g[7], g[8])
    const straight = bones > 1e-6 ? d(g[5], g[8]) / bones : 1
    const CURLED = 0.65
    const STRAIGHT = 0.72 // khe hở giữa hai ngưỡng = vùng đệm, không cử chỉ nào ăn

    const thr = this.state.input.pinchThreshold
    const fistNow = extCount === 0 && straight < CURLED

    if (fistNow) {
      // Nắm đấm được ưu tiên và cắt luôn nét đang vẽ — không debounce, vì người
      // ta nắm tay là có ý dừng vẽ.
      this.pinched = false
      this.pinchMiss = 0
    } else if (pinchD < thr && straight > STRAIGHT) {
      this.pinched = true
      this.pinchMiss = 0
    } else if (this.pinched && (pinchD > thr * 1.45 || straight < CURLED)) {
      // Chống rớt: phải thấy nhả liên tiếp vài frame mới thật sự nhấc bút.
      this.pinchMiss++
      if (this.pinchMiss >= 3) this.pinched = false
    } else if (!this.pinched) {
      this.pinchMiss = 0
    }

    const palm = extCount >= 4 && !this.pinched

    this.cb.onDebug(
      `ngón duỗi ${extCount}/4 · chụm ${pinchD.toFixed(2)}/${thr.toFixed(2)} · trỏ ${straight.toFixed(2)}` +
      ` · ${fistNow ? 'NẮM ĐẤM' : this.pinched ? 'CHỤM' : palm ? 'XOÈ' : '—'}` +
      (world ? '' : ' · (world 3D thiếu)')
    )

    // Đầu bút = trung điểm ngón cái + ngón trỏ.
    let nx = (lms[4].x + lms[8].x) / 2
    const nyRaw = (lms[4].y + lms[8].y) / 2
    if (this.state.input.mirror) nx = 1 - nx

    // Lọc One Euro. Đặt Ở ĐÂY chứ không phải lerp ở scene: chỉ chỗ này mới biết
    // dấu thời gian thật của từng frame camera, mà One Euro cần dt để hoạt động.
    const cutoff = 0.6 + (1 - Math.min(0.95, Math.max(0, this.state.input.smooth))) * 2.4
    this.fx.setMinCutoff(cutoff)
    this.fy.setMinCutoff(cutoff)
    const t = performance.now() / 1000
    const fnx = this.fx.filter(nx, t)
    const fny = this.fy.filter(nyRaw, t)

    // Nắm đấm: cho phép RỚT vài frame mà không mất tiến độ. MediaPipe đọc nắm
    // đấm hay chớp (thỉnh thoảng một ngón bị tính là duỗi); bản cũ reset bộ đếm
    // về 0 ngay khi có MỘT frame như vậy, nên giữ mãi cũng không bao giờ đủ.
    const hold = Math.max(0.4, this.state.input.fistHold)
    if (fistNow) this.fistMiss = 0
    else this.fistMiss++
    const fistHeld = fistNow || (this.fistTime > 0 && this.fistMiss <= 6)

    let label = this.pinched ? 'đang vẽ' : 'chụm ngón để vẽ'
    if (fistHeld && this.fistArmed) {
      this.fistTime += dt
      this.ring = Math.min(1, this.fistTime / hold)
      label = `nắm đấm — giữ ${(hold - this.fistTime).toFixed(1)}s nữa`
      if (this.ring >= 1) {
        this.fistArmed = false
        this.fistTime = 0
        this.ring = 0
        this.fistMiss = 0
        this.cb.onStageAdvance()
      }
    } else if (fistNow) {
      label = 'thả nắm đấm ra'
    } else {
      // Chỉ nhả hẳn khi đã mất nắm đấm đủ lâu.
      this.fistArmed = true
      this.fistTime = 0
      this.ring = 0
      if (palm) label = 'xoè bàn tay — xoay trường (5D)'
    }

    this.cb.onHand({
      present: true, nx: fnx, ny: fny,
      pinch: this.pinched && !fistNow,
      palm, fist: fistNow,
      ring: this.ring,
      label
    })
  }

  private drawPreview(lms: Landmark[] | undefined): void {
    const cv = this.preview
    const g = cv.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, cv.width, cv.height)
    // Nguồn Kinect không đi qua thẻ <video> (không có UVC), nên ô xem trước sẽ
    // đen thui nếu không tự vẽ. Không thấy hình thì operator chỉnh góc trong mù.
    if (this.state.input.source === 'kinect' && this.kinectReady) {
      g.save()
      if (this.state.input.mirror) {
        g.translate(cv.width, 0)
        g.scale(-1, 1)
      }
      g.globalAlpha = 0.6
      g.drawImage(this.kinectCanvas, 0, 0, cv.width, cv.height)
      g.restore()
      g.globalAlpha = 1
    }
    if (!lms) return
    const mir = this.state.input.mirror
    const X = (p: Landmark): number => (mir ? 1 - p.x : p.x) * cv.width
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
    try { this.landmarker?.close?.() } catch { /* đã đóng */ }
  }
}
