// ============================================================================
// Renderer cửa sổ SÀN. Không camera, không tiếng, không nhận dữ liệu tay —
// sàn là nền theo chiều, cố tình KHÔNG bám cử chỉ (xem đầu scene.ts).
// ============================================================================
import { FloorScene } from './scene'

const canvas = document.getElementById('gl') as HTMLCanvasElement
let scene: FloorScene | null = null

async function boot(): Promise<void> {
  const state = await window.dj.getState()
  scene = new FloorScene(canvas, state)
  ;(window as unknown as { __djFloor: FloorScene }).__djFloor = scene

  window.dj.onState((s) => scene?.setState(s))

  let resizeTimer = 0
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => scene?.resize(), 150)
  })

  let last = performance.now()
  const loop = (t: number): void => {
    requestAnimationFrame(loop)
    const dt = Math.min(0.05, (t - last) / 1000)
    last = t
    scene?.frame(dt, t / 1000)
  }
  requestAnimationFrame(loop)
}

boot().catch((e) => {
  console.error('[floor] boot lỗi', e)
  document.body.innerHTML = `<pre style="color:#f4587a;padding:40px;font-size:20px">FLOOR boot lỗi: ${String(e)}</pre>`
})
