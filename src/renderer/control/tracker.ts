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
import { HandFrame, SecondHand, AppState } from '../../shared/types'

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
  onHand: (primary: HandFrame, second: SecondHand) => void
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
  private fistMiss = 0   // GIÂY liên tiếp không thấy nắm đấm
  private pinchMiss = 0  // GIÂY liên tiếp thấy nhả chụm
  private ring = 0
  private dead = false
  private fx = new OneEuro()
  private fy = new OneEuro()
  /** Nhãn tay (Left/Right) đã được giao việc VẼ. Giữ dính cho tới khi cả hai tay
   *  rời khung một lúc — nếu đổi vai giữa chừng thì người dùng mất phương hướng. */
  private drawLabel: string | null = null
  private bothGone = 0
  private loggedWorld = false
  private lastEmit = 0
  /** Nhịp nhận diện THẬT (lần/giây). Đây là con số quyết định cảm giác nhạy —
   *  không phải fps màn hình. */
  fps = 0
  camInfo = ''
  delegate = ''
  private secondPrev: SecondHand = { present: false, nx: 0.5, ny: 0.5 }
  /** Giá trị chụm nhỏ nhất trong ~3s gần đây — để biết tay NGƯỜI DÙNG thật sự
   *  chụm được tới đâu, thay vì mình ngồi đoán ngưỡng. */
  private recentMin = 9
  private recentMinAt = 0
  private calibUntil = 0
  private calibMin = 9
  onCalibrated: ((value: number) => void) | null = null

  /** Bắt đầu tự chỉnh: người dùng chụm tay giữ vài giây, app lấy mức chụm chặt
   *  nhất đo được rồi đặt ngưỡng cao hơn mức đó một chút. */
  startCalibration(seconds: number): void {
    this.calibMin = 9
    this.calibUntil = performance.now() + seconds * 1000
  }
  private second: SecondHand = { present: false, nx: 0.5, ny: 0.5 }
  private sx = new OneEuro()
  private sy = new OneEuro()

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
        // HAI tay: tay xuất hiện trước lo vẽ, tay thứ hai lo xoay trường 5D.
        numHands: 2,
        // Ba ngưỡng này trước đây để MẶC ĐỊNH 0.5 — chặt quá cho một tác phẩm
        // tương tác. Hạ ngưỡng BÁM (tracking/presence) làm MediaPipe lì hơn: tay
        // hơi mờ, hơi nghiêng, hay bị chính mình che thì vẫn bám tiếp thay vì
        // buông ra rồi phải dò lại từ đầu — mỗi lần buông là một lần nét đứt.
        // Ngưỡng PHÁT HIỆN giữ cao hơn để không bắt nhầm vật thể thành bàn tay.
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35
      })
    try {
      const l = await make('GPU')
      this.delegate = 'GPU'
      window.dj.log('tracking', 'MediaPipe chạy trên GPU')
      return l
    } catch (e) {
      // Máy không cho WebGL trong worker của MediaPipe → CPU chậm hơn nhiều, và
      // chậm là kém nhạy. Phải ghi ra để biết mà xử lý.
      this.delegate = 'CPU'
      window.dj.log('tracking', `MediaPipe RƠI VỀ CPU (chậm hơn): ${(e as Error).message}`)
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
      const tr0 = this.stream.getVideoTracks()[0]
      const st = tr0 && tr0.getSettings ? tr0.getSettings() : ({} as MediaTrackSettings)
      this.camInfo = `${st.width || '?'}×${st.height || '?'} @${Math.round(st.frameRate || 0)}fps`
      // fps camera là con số quyết định cảm giác nhạy. Webcam Windows hay chỉ cho
      // 30fps, và tụt còn 15fps khi phòng thiếu sáng — phải biết chắc, không đoán.
      window.dj.log('camera', `${tr0 ? tr0.label : '?'} — ${this.camInfo}`)
      if ((st.frameRate || 0) < 25) {
        window.dj.log('camera', `CẢNH BÁO: camera chỉ ${Math.round(st.frameRate || 0)}fps — cử chỉ sẽ kém nhạy. Thêm đèn hoặc đổi webcam 60fps.`)
      }
      this.cb.onStatus(`camera đang chạy · ${this.camInfo}`, 'ok')
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
    const all: Landmark[][] = result?.landmarks || []
    const worlds: Landmark[][] = result?.worldLandmarks || []
    // Nhãn tay của MediaPipe (Left/Right) là thứ ỔN ĐỊNH duy nhất giữa các frame
    // — thứ tự trong mảng thì không. Dùng nó làm danh tính để giao việc.
    const labels: string[] = (result?.handedness || []).map(
      (h: any) => (h && h[0] && h[0].categoryName) || ''
    )

    if (all.length === 0) {
      this.bothGone++
      if (this.bothGone > 45) this.drawLabel = null // ~1.5s vắng cả hai tay thì giao lại vai
    } else {
      this.bothGone = 0
      if (this.drawLabel === null) this.drawLabel = labels[0] || 'H0'
    }

    let pi = -1
    for (let i = 0; i < all.length; i++) {
      if ((labels[i] || 'H0') === this.drawLabel) { pi = i; break }
    }
    // Chỉ thấy một tay mà không khớp nhãn (MediaPipe đọc nhầm chiều) → vẫn cho vẽ,
    // thà vẽ được còn hơn đứng im chờ đúng nhãn.
    if (pi < 0 && all.length === 1) pi = 0
    const si = all.findIndex((_, i) => i !== pi)

    this.drawPreview(all, pi)
    if (si >= 0) {
      // Tay thứ hai cũng phải lọc nhiễu: nó lái cú xoay trường 5D, dữ liệu thô
      // rung thì cả trường rung theo.
      const raw = all[si][9]
      const cut = 0.6 + (1 - Math.min(0.95, Math.max(0, this.state.input.smooth))) * 2.4
      this.sx.setMinCutoff(cut)
      this.sy.setMinCutoff(cut)
      const ts = performance.now() / 1000
      this.second = {
        present: true,
        nx: this.sx.filter(this.state.input.mirror ? 1 - raw.x : raw.x, ts),
        ny: this.sy.filter(raw.y, ts)
      }
    } else {
      this.second = { present: false, nx: 0.5, ny: 0.5 }
      this.sx.reset()
      this.sy.reset()
    }
    this.emit(pi >= 0 ? all[pi] : undefined, pi >= 0 ? worlds[pi] : undefined, dt)
  }

  private emit(lms: Landmark[] | undefined, world: Landmark[] | undefined, _dtDisplay: number): void {
    // Đo thời gian THẬT giữa hai frame CAMERA. KHÔNG dùng dt của vòng lặp màn hình:
    // emit chỉ chạy khi có frame camera mới, nên cộng dt màn hình vào là bộ đếm
    // chạy theo tỉ lệ (fps camera / fps màn hình). Mac camera 60fps thì trùng khớp
    // và mọi thứ có vẻ đúng; Windows webcam 30fps thì chậm gấp ĐÔI, 15fps (phòng
    // thiếu sáng, camera tự kéo dài phơi sáng) thì chậm gấp BỐN.
    const tNow = performance.now()
    const dt = this.lastEmit ? Math.min(0.25, (tNow - this.lastEmit) / 1000) : 1 / 30
    this.lastEmit = tNow
    this.fps = this.fps ? this.fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1 : 1 / dt
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
        this.cb.onHand({ present: false, nx: 0.5, ny: 0.5, pinch: false, palm: false, fist: false, ring: 0, label: 'đưa tay vào khung' }, this.second)
      }
      return
    }
    this.handSeen = 4

    const d = (a: Landmark, b: Landmark): number => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))

    // Đo cử chỉ trên worldLandmarks — toạ độ 3D thật (mét) do MediaPipe dựng lại,
    // KHÔNG bị co khi xoay cổ tay. Toạ độ ảnh thì bị, và đó chính là gốc của lỗi
    // nét đứt giữa chừng. Vị trí con trỏ vẫn lấy từ toạ độ ẢNH ở dưới, vì con trỏ
    // phải bám khung hình chứ không bám bàn tay.
    if (!this.loggedWorld) {
      this.loggedWorld = true
      // Toàn bộ thang đo cử chỉ dựa trên worldLandmarks. Nếu thiếu thì rơi về
      // toạ độ ảnh và mọi ngưỡng lệch đi — phải biết chắc, không đoán.
      window.dj.log('tracking', world && world.length === 21
        ? 'dùng worldLandmarks 3D (chuẩn, không đổi khi xoay tay)'
        : 'THIẾU worldLandmarks — rơi về toạ độ ảnh, ngưỡng cử chỉ sẽ lệch')
    }
    const g = world && world.length === 21 ? world : lms
    const gw = g[0]
    const ext = ([[8, 6], [12, 10], [16, 14], [20, 18]] as [number, number][])
      .map(([tip, pip]) => d(g[tip], gw) > d(g[pip], gw) * 1.08)
    const extCount = ext.filter(Boolean).length

    const handScale = Math.max(d(g[0], g[5]), d(g[0], g[9]), d(g[0], g[13]), d(g[0], g[17]), 1e-6)
    const pinchD = d(g[4], g[8]) / handScale

    // Phân biệt CHỤM với NẮM ĐẤM bằng "đầu ngón trỏ có tụt vào lòng bàn tay
    // không", đo trên worldLandmarks nên không đổi khi xoay cổ tay.
    //
    // KHÔNG dùng "ngón trỏ có duỗi thẳng không" như bản trước: chụm CHẶT thì
    // ngón trỏ phải cong lại để đầu ngón chạm ngón cái, độ duỗi tụt xuống ~0.66
    // và rơi đúng vào vùng chết giữa hai ngưỡng — không ra cử chỉ nào. Chụm nhẹ
    // thì ăn, chụm chặt thì không. Đo được, chính là lỗi "thử mấy lần mới vẽ được".
    const reach = d(g[8], g[0]) / handScale

    const now = performance.now()
    if (pinchD < this.recentMin || now - this.recentMinAt > 3000) {
      this.recentMin = pinchD
      this.recentMinAt = now
    }
    if (this.calibUntil) {
      if (pinchD < this.calibMin) this.calibMin = pinchD
      if (now > this.calibUntil) {
        this.calibUntil = 0
        // Ngưỡng đặt cao hơn mức chụm chặt nhất 40% để còn dư địa cho tay run.
        if (this.calibMin < 5) this.onCalibrated?.(Math.min(0.85, Math.max(0.25, this.calibMin * 1.4)))
      }
    }

    const thr = this.state.input.pinchThreshold
    // Nắm đấm nhận bằng ĐỘ VƯƠN của đầu ngón trỏ, không dính gì tới ngưỡng chụm.
    // Số đo thật: nắm đấm ~0.79 · chụm rất chặt ~1.00 · chụm thường 1.3-1.7.
    // Tách rời như vậy thì ngưỡng chụm có nới rộng bao nhiêu cũng không bao giờ
    // ăn tranh mất cú nắm đấm.
    const fistNow = extCount === 0 && reach < 0.92

    if (fistNow) {
      // Nắm đấm cắt nét ngay, không debounce — nắm tay là có ý dừng vẽ.
      this.pinched = false
      this.pinchMiss = 0
    } else if (pinchD < thr) {
      // Chỉ cần đầu ngón cái gần đầu ngón trỏ. Không đòi thêm điều kiện nào nữa:
      // mỗi điều kiện phụ là một cách nữa để cử chỉ đúng bị từ chối.
      this.pinched = true
      this.pinchMiss = 0
    } else if (this.pinched && pinchD > Math.min(thr * 1.6, 0.68)) {
      // Kẹp mức nhả ở 0.68: bàn tay thả lỏng đo được ~0.73, để ngưỡng nhả bò lên
      // sát đó thì tay buông xuôi cũng bị coi là vẫn đang vẽ.
      // Nhả rộng tay hơn ngưỡng bắt (1.6×) và phải thấy liên tiếp 3 frame mới
      // nhấc bút — giữ nét liền mạch khi tay hơi rung.
      this.pinchMiss++
      if (this.pinchMiss >= 3) this.pinched = false
    } else if (!this.pinched) {
      this.pinchMiss = 0
    }

    const palm = extCount >= 4 && !this.pinched

    this.cb.onDebug(
      `nhận diện ${Math.round(this.fps)}/s ${this.delegate} · ngón duỗi ${extCount}/4 · chụm ${pinchD.toFixed(2)}/${thr.toFixed(2)}` +
      ` (chặt nhất 3s: ${this.recentMin.toFixed(2)}) · với ${reach.toFixed(2)}` +
      (this.calibUntil ? ' · ĐANG TỰ CHỈNH…' : '') +
      ` · ${fistNow ? 'NẮM ĐẤM' : this.pinched ? 'CHỤM' : palm ? 'XOÈ' : '—'}` +
      (this.second.present ? ' · tay 2: XOAY' : '') +
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
    else this.fistMiss += dt
    // Cho phép mất dấu nắm đấm tới 0.2 GIÂY mà không mất tiến độ (trước đây đếm
    // 6 frame — ở camera 15fps thành 0.4s, ở 60fps chỉ 0.1s).
    const fistHeld = fistNow || (this.fistTime > 0 && this.fistMiss <= 0.2)

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
    }, this.second)
  }

  private drawPreview(all: Landmark[][], pi: number): void {
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
    const mir = this.state.input.mirror
    const X = (p: Landmark): number => (mir ? 1 - p.x : p.x) * cv.width
    const Y = (p: Landmark): number => p.y * cv.height
    for (let h = 0; h < all.length; h++) {
      const lms = all[h]
      const isDraw = h === pi
      // Tay VẼ màu tím, tay XOAY màu hổ phách — operator phải nhìn ra ngay tay
      // nào đang giữ việc gì.
      g.strokeStyle = isDraw ? 'rgba(167,139,250,0.8)' : 'rgba(245,192,68,0.7)'
      g.lineWidth = 1.5
      g.beginPath()
      for (const [a, b] of CONN) { g.moveTo(X(lms[a]), Y(lms[a])); g.lineTo(X(lms[b]), Y(lms[b])) }
      g.stroke()
      g.fillStyle = isDraw ? '#e9d5ff' : '#f5c044'
      for (const p of lms) { g.beginPath(); g.arc(X(p), Y(p), 2, 0, 7); g.fill() }
      if (isDraw) {
        const pc = this.pinched ? '#5ee6a8' : 'rgba(94,230,168,0.45)'
        g.strokeStyle = pc
        g.lineWidth = 2
        g.beginPath(); g.moveTo(X(lms[4]), Y(lms[4])); g.lineTo(X(lms[8]), Y(lms[8])); g.stroke()
        g.fillStyle = pc
        for (const i of [4, 8]) { g.beginPath(); g.arc(X(lms[i]), Y(lms[i]), 4, 0, 7); g.fill() }
      }
    }
  }

  dispose(): void {
    this.dead = true
    this.closeCamera()
    try { this.landmarker?.close?.() } catch { /* đã đóng */ }
  }
}
