// ============================================================================
// Kiểu dữ liệu dùng chung giữa main / preload / renderer.
// State "chậm" (cấu hình, stage) đi qua broadcast; dữ liệu bàn tay 60fps đi
// kênh riêng để không kéo theo cả state mỗi frame.
// ============================================================================

export type Stage = 0 | 1 | 2 | 3 | 4 | 5

/** Nguồn điều khiển con trỏ vẽ. */
export type InputSource =
  | 'mouse' // chuột — test, và là đường dự phòng tại venue
  | 'camera' // webcam/UVC + MediaPipe HandLandmarker (mặc định)
  | 'kinect' // Kinect v2 qua bridge WebSocket (ảnh IR + skeleton)

export type OutputKey = 'wall' | 'floor'

/** Một khung dữ liệu tay — gửi mỗi frame từ cửa sổ Control tới các cửa sổ Wall. */
export interface HandFrame {
  present: boolean
  /** Toạ độ đầu bút, đã chuẩn hoá 0..1 theo khung hình và ĐÃ lật gương. */
  nx: number
  ny: number
  pinch: boolean // chụm ngón cái + trỏ = hạ bút
  palm: boolean // xoè 5 ngón = xoay trường 5D
  fist: boolean // nắm đấm = giữ 1s để chuyển chiều
  /** 0..1 — tiến độ giữ nắm đấm, để vẽ vòng tròn "shifting dimension". */
  ring: number
  /** Nhãn cử chỉ hiện tại, hiện trên Control + HUD tường. */
  label: string
}

export const EMPTY_HAND: HandFrame = {
  present: false, nx: 0.5, ny: 0.5, pinch: false, palm: false, fist: false, ring: 0, label: ''
}

export interface Output {
  key: OutputKey
  /** Tên sender Spout / NDI. */
  stream: string
  resW: number
  resH: number
  open: boolean
  display: number
  mode: 'windowed' | 'fullscreen'
}

export interface AppState {
  stage: Stage
  /** Bấm để xoá nét đang có — renderer theo dõi số này đổi thì xoá. */
  clearNonce: number
  sound: boolean

  outputs: Output[]

  spout: { running: boolean; fps: number; scale: number }
  ndi: { running: boolean; fps: number; scale: number }

  input: {
    source: InputSource
    /** deviceId của camera đang dùng (rỗng = camera mặc định). */
    deviceId: string
    /** % bề ngang tường mà bàn tay với tới được (40..100). */
    reach: number
    /** Làm mượt con trỏ 0..0.95 — cao = mượt nhưng trễ. */
    smooth: number
    /** Ngưỡng chụm ngón (0.20..0.60) — chỉnh theo tay người + khoảng cách. */
    pinchThreshold: number
    /** Cổng WebSocket cho Kinect bridge. */
    kinectPort: number
  }

  look: {
    /** Góc nhìn ngang (độ). Tường siêu rộng nên đây là tham số khung hình chính. */
    hFov: number
    hud: boolean
    hudScale: number
    bloom: boolean
    bloomStrength: number
    /** Mật độ sao 50..200 (%). */
    starDensity: number
    /** Hệ số dày nét vẽ. Bản gốc tính cho màn 16:9 gần mắt; chiếu lên tường
     *  10m thì nét mảnh như sợi tóc, nên cần nhân lên. */
    strokeScale: number
  }
}

export interface SpoutStatus {
  available: boolean
  reason: string
  logPath: string
  streams: Array<{
    role: string; name: string; w: number; h: number
    fps: number; sent: number; mode: 'gpu' | 'cpu'; sendMs: number
  }>
}

export interface NdiStatus {
  available: boolean
  reason: string
  streams: Array<{ role: string; name: string; w: number; h: number; fps: number; sent: number; copyMs: number }>
}

export interface KinectStatus {
  listening: boolean
  port: number
  connected: boolean
  fps: number
  reason: string
}

export interface DisplayInfo {
  id: number
  label: string
}

/** Một message từ Kinect bridge (xem kinect-bridge/README.md). */
export interface KinectFrame {
  t: number
  /** JPEG ảnh hồng ngoại, base64 — MediaPipe chạy trên ảnh này. */
  ir: string
  /** Hand state thô của Kinect SDK. Để sẵn cho đường dự phòng, app chưa dùng:
   *  open/closed/lasso quá thô để tách "chụm ngón" khỏi "nắm đấm". */
  hand?: { x: number; y: number; z: number; state: string } | null
}

export type Action =
  | { type: 'setStage'; stage: Stage }
  | { type: 'nextStage' }
  | { type: 'prevStage' }
  | { type: 'clear' }
  | { type: 'setSound'; on: boolean }
  | { type: 'setOutput'; key: OutputKey; patch: Partial<Output> }
  | { type: 'setSpout'; patch: Partial<AppState['spout']> }
  | { type: 'setNdi'; patch: Partial<AppState['ndi']> }
  | { type: 'setInput'; patch: Partial<AppState['input']> }
  | { type: 'setLook'; patch: Partial<AppState['look']> }
