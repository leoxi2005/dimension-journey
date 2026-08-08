// ============================================================================
// Renderer của cửa sổ chiếu (Wall — và sau này Floor). Ba bản chạy song song:
// cửa sổ hiện hình, cửa sổ offscreen Spout, cửa sổ offscreen NDI. Cả ba đều
// KHÔNG có camera và KHÔNG phát tiếng — hai thứ đó nằm ở cửa sổ Control để chỉ
// tồn tại đúng một bản.
// ============================================================================
import { WallScene } from './scene'
import { AppState, HandsFrame } from '../../shared/types'
import { STAGES } from '../shared/stages'
import { wallSpan } from '../shared/walls'

const canvas = document.getElementById('gl') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLDivElement
const layersEl = document.getElementById('layers') as HTMLDivElement
const ringEl = document.getElementById('ring') as HTMLDivElement
const ringArc = document.getElementById('ringArc') as unknown as SVGCircleElement

const els = {
  key: document.getElementById('stageKey') as HTMLDivElement,
  title: document.getElementById('stageTitle') as HTMLDivElement,
  caption: document.getElementById('stageCaption') as HTMLDivElement,
  hint: document.getElementById('stageHint') as HTMLDivElement
}

let scene: WallScene | null = null
let layerCount = 0

function applyHud(s: AppState): void {
  hud.classList.toggle('off', !s.look.hud)
  const k = s.look.hudScale
  hud.style.transform = `scale(${k})`
  layersEl.style.transform = `scale(${k})`
  // Chữ HUD nằm GỌN TRONG TƯỜNG 3, không vắt qua mối nối giữa hai tường. Khung
  // 10350×1080 không phải một mặt phẳng liền: nó là 5 mặt tường của phòng pentagon
  // ghép lại, mỗi mặt một máy chiếu warp riêng bên Resolume. Chữ nằm vắt qua mối
  // nối là gãy làm đôi ở góc phòng — không đọc được từ bất kỳ chỗ đứng nào.
  // Bản trước neo theo (100-reach)/2 = 27.5% = px 2846, tức bắt đầu từ TƯỜNG 2
  // rồi mới tràn sang tường 3. Giờ neo cứng vào mép trái tường 3.
  const w3 = wallSpan(2)
  hud.style.left = `${w3.x0 * 100}%`
  // Ô đếm layer 5D neo vào TƯỜNG 4, cũng vì lý do mối nối như HUD. Trước đây nó
  // bám theo (100-reach)/2; từ khi reach mặc định lên 100 để vẽ được hết bề
  // ngang thì công thức đó cho ra 0%, tức đẩy ô đếm ra sát mép tường 5 — góc
  // phòng, chỗ khó đọc nhất.
  const w4 = wallSpan(3)
  layersEl.style.right = `${(1 - (w4.x0 + w4.w)) * 100}%`
  // Chặn bề ngang để chữ KHÔNG tràn khỏi tường 3 kể cả khi kéo "cỡ chữ HUD" lên
  // 4×. Trừ hai lần PAD: #hud có padding-left 56px, chừa nốt 56px bên phải cho
  // cân. Cả padding lẫn max-width đều bị scale(k) nhân lên, nên phải chia lại cho
  // k mới ra số CSS đúng. Chốt thêm ở MEASURE để dòng phụ đề 17px không kéo dài
  // thành một hàng 1800px không ai đọc nổi.
  const PAD = 56
  const MEASURE = 620
  const w3Css = window.innerWidth * w3.w
  hud.style.maxWidth = `${Math.max(200, Math.min(MEASURE, w3Css / k - PAD * 2))}px`
  const st = STAGES[s.stage]
  els.key.textContent = st.key
  els.title.textContent = st.title
  els.caption.textContent = st.caption
  els.hint.textContent = st.hint
  layersEl.style.display = s.stage === 5 && s.look.hud ? 'block' : 'none'
  layersEl.textContent = `layers stacked: ${layerCount}`
}

async function boot(): Promise<void> {
  const state = await window.dj.getState()
  scene = new WallScene(canvas, state)
  // Móc chẩn đoán: mở DevTools trên cửa sổ chiếu rồi gõ __djScene để soi trạng
  // thái thật (số nét, khung hình, con trỏ) khi có sự cố ở venue.
  ;(window as unknown as { __djScene: WallScene }).__djScene = scene
  scene.onLayerCount = (n): void => {
    layerCount = n
    layersEl.textContent = `layers stacked: ${n}`
  }
  applyHud(state)

  window.dj.onState((s) => {
    scene?.setState(s)
    applyHud(s)
  })

  window.dj.onHand((h: HandsFrame) => {
    scene?.setHand(h)
    // Vòng tròn "shifting dimension" khi giữ nắm đấm.
    const show = h.primary.ring > 0.03
    ringEl.style.display = show ? 'flex' : 'none'
    if (show) ringArc.setAttribute('stroke-dashoffset', String(351.86 * (1 - h.primary.ring)))
  })

  // Chuột: đường dự phòng, dùng được ngay trên cửa sổ chiếu khi camera hỏng.
  let dragging = false
  let stackDrag: { x: number; y: number } | null = null
  const norm = (e: PointerEvent): { x: number; y: number } => ({
    x: e.clientX / window.innerWidth,
    y: e.clientY / window.innerHeight
  })
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2 || e.ctrlKey) { stackDrag = { x: e.clientX, y: e.clientY }; return }
    dragging = true
    const n = norm(e)
    scene?.setMouse(n.x, n.y, true)
  })
  window.addEventListener('pointermove', (e) => {
    if (stackDrag) {
      scene?.dragStack((e.clientX - stackDrag.x) / window.innerWidth, (e.clientY - stackDrag.y) / window.innerHeight)
      stackDrag = { x: e.clientX, y: e.clientY }
      return
    }
    const n = norm(e)
    scene?.setMouse(n.x, n.y, dragging)
  })
  window.addEventListener('pointerup', () => {
    stackDrag = null
    if (dragging) {
      dragging = false
      scene?.setMouse(0, 0, false)
    }
  })
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  // Phím tắt ngay trên cửa sổ chiếu (tiện lúc canh máy chiếu một mình).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') window.dj.send({ type: 'nextStage' })
    else if (e.key === 'ArrowLeft') window.dj.send({ type: 'prevStage' })
    else if (e.key >= '0' && e.key <= '5') window.dj.send({ type: 'setStage', stage: +e.key as AppState['stage'] })
    else if (e.key === 'c' || e.key === 'C') window.dj.send({ type: 'clear' })
  })

  // Gộp sự kiện resize: mỗi lần resize là dựng lại cả starfield (hàng nghìn hạt)
  // và khung hình. Kéo cửa sổ bằng tay sẽ bắn hàng trăm sự kiện liên tiếp.
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
  console.error('[wall] boot lỗi', e)
  document.body.innerHTML = `<pre style="color:#f4587a;padding:40px;font-size:20px">WALL boot lỗi: ${String(e)}</pre>`
})
