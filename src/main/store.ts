// ============================================================================
// Store sống ở MAIN process — là nguồn sự thật duy nhất. Control gửi Action,
// main áp dụng rồi broadcast state cho mọi cửa sổ (Wall hiện hình, Wall offscreen
// của Spout/NDI). Nhờ vậy 3 bản render luôn khớp nhau tuyệt đối.
// ============================================================================
import { AppState, Action, Stage, Output } from '../shared/types'

// Số chốt cho Bali Day 3: tường 10350×1080. Sàn 3840×2160 để dành, mặc định tắt.
const WALL: Output = {
  key: 'wall', stream: 'DimensionWall', resW: 10350, resH: 1080,
  open: false, display: 0, mode: 'windowed', send: true
}
const FLOOR: Output = {
  key: 'floor', stream: 'DimensionFloor', resW: 3840, resH: 2160,
  open: false, display: 0, mode: 'windowed', send: false
}

export function initialState(): AppState {
  return {
    stage: 0,
    clearNonce: 0,
    sound: true,
    outputs: [WALL, FLOOR],
    // Spout mặc định TẮT: Spout chia sẻ TEXTURE GPU nên chỉ chạy được khi app và
    // Resolume ở CÙNG một máy Windows. Setup thật của show là hai máy khác nhau,
    // nên bật Spout chỉ tổ render scene thêm một lần vô ích.
    spout: { running: false, fps: 60, scale: 100 },
    // NDI = đường ra chính: đi qua mạng nên vượt được sang máy chạy Resolume.
    // 30fps chứ không 60: mỗi frame 10350×1080 là 44.7MB copy về RAM, và đo thật
    // thì xin 60 vẫn chỉ ra ~30 (offscreen render raster bằng CPU).
    ndi: { running: true, fps: 30, scale: 100 },
    input: {
      source: 'camera', deviceId: '', reach: 45, smooth: 0.3,
      mirror: true, fistHold: 0.5, pinchThreshold: 0.55, kinectPort: 9010,
      // MÀU là mặc định: đó chính là 'dùng Kinect như một camera thường', và
      // MediaPipe chính xác nhất trên ảnh màu. IR chỉ để dành cho phòng tối om.
      kinectSource: 'color'
    },
    floor: { rotation: 0, brightness: 85 },
    look: {
      hFov: 100, hud: true, hudScale: 1.8, bloom: true, bloomStrength: 0.85,
      starDensity: 100, strokeScale: 1.8
    }
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function reduce(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'setStage':
      return { ...s, stage: clamp(a.stage, 0, 5) as Stage }
    case 'nextStage':
      return { ...s, stage: (((s.stage + 1) % 6) as Stage) }
    case 'prevStage':
      return { ...s, stage: (((s.stage + 5) % 6) as Stage) }
    case 'clear':
      return { ...s, clearNonce: s.clearNonce + 1 }
    case 'setSound':
      return { ...s, sound: a.on }
    case 'setOutput':
      return {
        ...s,
        outputs: s.outputs.map((o) =>
          o.key === a.key
            ? {
                ...o,
                ...a.patch,
                resW: clamp(Math.round(a.patch.resW ?? o.resW), 64, 16384),
                resH: clamp(Math.round(a.patch.resH ?? o.resH), 64, 16384)
              }
            : o
        )
      }
    case 'setSpout':
      return { ...s, spout: { ...s.spout, ...a.patch } }
    case 'setNdi':
      return { ...s, ndi: { ...s.ndi, ...a.patch } }
    case 'setInput':
      return { ...s, input: { ...s.input, ...a.patch } }
    case 'setLook':
      return { ...s, look: { ...s.look, ...a.patch } }
    case 'setFloor':
      return { ...s, floor: { ...s.floor, ...a.patch } }
    default:
      return s
  }
}
