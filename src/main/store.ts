// ============================================================================
// Store sống ở MAIN process — là nguồn sự thật duy nhất. Control gửi Action,
// main áp dụng rồi broadcast state cho mọi cửa sổ (Wall hiện hình, Wall offscreen
// của Spout/NDI). Nhờ vậy 3 bản render luôn khớp nhau tuyệt đối.
// ============================================================================
import { AppState, Action, Stage, Output } from '../shared/types'

// Số chốt cho Bali Day 3: tường 10350×1080. Sàn 3840×2160 để dành, mặc định tắt.
const WALL: Output = {
  key: 'wall', stream: 'DimensionWall', resW: 10350, resH: 1080,
  open: false, display: 0, mode: 'windowed'
}
const FLOOR: Output = {
  key: 'floor', stream: 'DimensionFloor', resW: 3840, resH: 2160,
  open: false, display: 0, mode: 'windowed'
}

export function initialState(): AppState {
  return {
    stage: 0,
    clearNonce: 0,
    sound: true,
    outputs: [WALL, FLOOR],
    // Spout = đường ra chính (cùng máy Windows với Resolume Arena).
    spout: { running: true, fps: 60, scale: 100 },
    // NDI mặc định TẮT: 10350×1080 ≈ 45MB/frame, copy trên main thread sẽ kéo
    // giật cả show. Chỉ bật khi Resolume nằm ở máy khác.
    ndi: { running: false, fps: 30, scale: 100 },
    input: {
      source: 'camera', deviceId: '', reach: 100, smooth: 0.3,
      mirror: true, fistHold: 1, pinchThreshold: 0.36, kinectPort: 9010
    },
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
    default:
      return s
  }
}
