// ============================================================================
// Bảng điều khiển của operator. Nắm giữ ba thứ mà chỉ được tồn tại MỘT bản:
// camera, MediaPipe, và âm thanh. Mọi thay đổi đều gửi Action lên main; main
// broadcast lại nên cửa sổ chiếu + luồng Spout/NDI luôn khớp.
// ============================================================================
import { AppState, HandFrame, SecondHand, Stage, SpoutStatus, NdiStatus, KinectStatus } from '../../shared/types'
import { STAGES } from '../shared/stages'
import { HandTracker } from './tracker'
import { AudioEngine } from './audio'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

let state: AppState
let tracker: HandTracker | null = null
const audio = new AudioEngine()

// Trạng thái nét vẽ dùng cho âm thanh (wall lo phần hình, control lo phần tiếng).
let drawing = false
let lastPos: { x: number; y: number } | null = null
let strokeFrames = 0

// ------------------------------------------------------------------ helpers
function setToggle(el: HTMLElement, on: boolean, onText: string, offText: string): void {
  el.classList.toggle('on', on)
  el.textContent = on ? onText : offText
}

function setDot(id: string, tone: 'ok' | 'warn' | 'bad'): void {
  const d = $(id)
  d.className = `dot ${tone}`
}

// -------------------------------------------------------------------- render
function render(): void {
  const wall = state.outputs.find((o) => o.key === 'wall')!

  $('wallLabel').textContent = `${wall.resW}×${wall.resH}`
  $('stageNote').textContent = `${STAGES[state.stage].title} — ${STAGES[state.stage].hint}`

  // dãy nút 0D..5D
  const dims = $('dims')
  if (dims.children.length !== 6) {
    dims.innerHTML = ''
    STAGES.forEach((s, i) => {
      const b = document.createElement('button')
      b.textContent = s.key
      b.onclick = (): void => window.dj.send({ type: 'setStage', stage: i as Stage })
      dims.appendChild(b)
    })
  }
  Array.from(dims.children).forEach((b, i) => b.classList.toggle('on', i === state.stage))

  const sndEl = $('btnSound')
  if (!audio.ready) {
    sndEl.classList.remove('on')
    sndEl.textContent = 'tiếng: chưa mở'
  } else {
    setToggle(sndEl, state.sound, 'tiếng: bật', 'tiếng: tắt')
  }

  // nguồn tương tác
  document.querySelectorAll<HTMLButtonElement>('#srcSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.src === state.input.source)
  })
  $('kinectBox').style.display = state.input.source === 'kinect' ? 'block' : 'none'
  ;($('kinectPort') as HTMLInputElement).value = String(state.input.kinectPort)

  const setRange = (id: string, v: number, text: string): void => {
    const el = $(id) as HTMLInputElement
    if (document.activeElement !== el) el.value = String(v)
    $(id + 'Val').textContent = text
  }
  setRange('reach', state.input.reach, `${state.input.reach}%`)
  setRange('smooth', state.input.smooth, state.input.smooth.toFixed(2))
  setRange('pinch', state.input.pinchThreshold, state.input.pinchThreshold.toFixed(2))
  setRange('fistHold', state.input.fistHold, `${state.input.fistHold.toFixed(1)}s`)
  setToggle($('btnMirror'), state.input.mirror, 'lật gương: BẬT', 'lật gương: tắt')
  // Video xem trước phải lật cùng chiều với dữ liệu, không thì mắt và tay đá nhau.
  ;($('cam') as HTMLVideoElement).style.transform = state.input.mirror ? 'scaleX(-1)' : 'none'
  setRange('hfov', state.look.hFov, `${state.look.hFov}°`)
  setRange('stars', state.look.starDensity, `${state.look.starDensity}%`)
  setRange('strokeScale', state.look.strokeScale, `${state.look.strokeScale.toFixed(1)}×`)
  setRange('hudScale', state.look.hudScale, `${state.look.hudScale.toFixed(1)}×`)
  setRange('bloomS', state.look.bloomStrength, state.look.bloomStrength.toFixed(2))

  const resW = $('resW') as HTMLInputElement
  const resH = $('resH') as HTMLInputElement
  if (document.activeElement !== resW) resW.value = String(wall.resW)
  if (document.activeElement !== resH) resH.value = String(wall.resH)

  setToggle($('btnOpen'), wall.open, 'đóng cửa sổ', 'mở cửa sổ')
  setToggle($('btnFs'), wall.mode === 'fullscreen', 'toàn màn hình: bật', 'toàn màn hình')
  // Cảnh báo render 2 lần áp cho CẢ hai đường ra, không riêng Spout.
  $('dupWarn').style.display = wall.open && (state.spout.running || state.ndi.running) ? 'block' : 'none'

  setToggle($('btnSpout'), state.spout.running, 'Spout: ĐANG PHÁT', 'bật Spout')
  setToggle($('btnNdi'), state.ndi.running, 'NDI: ĐANG PHÁT', 'bật NDI')
  document.querySelectorAll<HTMLButtonElement>('button.fps').forEach((b) => {
    const t = b.dataset.t as 'spout' | 'ndi'
    b.classList.toggle('on', +b.dataset.fps! === state[t].fps)
  })
  document.querySelectorAll<HTMLButtonElement>('button.scale').forEach((b) => {
    const t = b.dataset.t as 'spout' | 'ndi'
    b.classList.toggle('on', +b.dataset.scale! === state[t].scale)
  })

  // ---- sàn ----
  const floor = state.outputs.find((o) => o.key === 'floor')!
  const fw = $('fResW') as HTMLInputElement
  const fh = $('fResH') as HTMLInputElement
  if (document.activeElement !== fw) fw.value = String(floor.resW)
  if (document.activeElement !== fh) fh.value = String(floor.resH)
  document.querySelectorAll<HTMLButtonElement>('#fRotSeg button').forEach((b) => {
    b.classList.toggle('on', +b.dataset.rot! === state.floor.rotation)
  })
  setRange('fBright', state.floor.brightness, `${state.floor.brightness}%`)
  setToggle($('btnFOpen'), floor.open, 'đóng cửa sổ', 'mở cửa sổ')
  setToggle($('btnFFs'), floor.mode === 'fullscreen', 'toàn màn hình: bật', 'toàn màn hình')
  setToggle($('btnFSend'), floor.send, 'sàn: ĐANG GỬI', 'gửi sàn ra Spout/NDI')
  $('fSendWarn').style.display = floor.send ? 'block' : 'none'

  setToggle($('btnHud'), state.look.hud, 'chữ HUD: hiện', 'chữ HUD: ẩn')
  setToggle($('btnBloom'), state.look.bloom, 'bloom: bật', 'bloom: tắt')
}

// -------------------------------------------------------------------- status
function renderStatus(s: { spout: SpoutStatus; ndi: NdiStatus; kinect: KinectStatus }): void {
  const sp = s.spout
  const st = sp.streams[0]
  if (!sp.available) {
    setDot('spoutDot', 'bad')
    $('spoutText').textContent = 'không dùng được'
  } else if (st && st.sent > 0) {
    setDot('spoutDot', 'ok')
    $('spoutText').textContent =
      `${st.name} · ${st.w}×${st.h} · ${st.fps}fps · ${st.mode.toUpperCase()}` +
      (st.mode === 'cpu' ? ` · ${st.sendMs}ms/frame` : '')
  } else {
    setDot('spoutDot', 'warn')
    $('spoutText').textContent = state.spout.running ? 'đang chờ frame đầu tiên…' : 'đang tắt'
  }
  $('spoutReason').textContent = sp.reason || ''

  const nd = s.ndi
  const ns = nd.streams[0]
  if (!nd.available) {
    setDot('ndiDot', 'bad')
    // Mất NDI là mất đường ra DUY NHẤT sang máy Resolume — không được nói nhẹ.
    $('ndiText').textContent = 'KHÔNG phát được: addon NDI không nạp'
  } else if (ns && ns.sent > 0) {
    // fps thật so với fps xin: tụt là thấy ngay ở đây, không phải đợi khán giả thấy.
    const slow = ns.fps > 0 && ns.fps < state.ndi.fps * 0.7
    setDot('ndiDot', slow ? 'warn' : 'ok')
    $('ndiText').textContent =
      `${ns.name} · ${ns.w}×${ns.h} · ${ns.fps}/${state.ndi.fps}fps · copy ${ns.copyMs}ms` +
      (slow ? ' · TỤT — hạ Res gửi' : '')
  } else {
    setDot('ndiDot', 'warn')
    $('ndiText').textContent = state.ndi.running ? 'đang chờ frame đầu tiên…' : 'đang tắt'
  }

  const k = s.kinect
  setDot('kinectDot', k.connected ? 'ok' : k.listening ? 'warn' : 'bad')
  $('kinectText').textContent = k.connected
    ? `bridge đã nối · ${k.fps}fps`
    : k.listening
      ? `đang nghe cổng ${k.port}`
      : k.reason || 'chưa bật'
}

// --------------------------------------------------------------------- input
function wire(): void {
  $('btnPrev').onclick = (): void => window.dj.send({ type: 'prevStage' })
  $('btnNext').onclick = (): void => window.dj.send({ type: 'nextStage' })
  $('btnClear').onclick = (): void => window.dj.send({ type: 'clear' })
  $('btnSound').onclick = (): void => {
    audio.ensure()
    window.dj.send({ type: 'setSound', on: !state.sound })
  }

  document.querySelectorAll<HTMLButtonElement>('#srcSeg button').forEach((b) => {
    b.onclick = (): void => {
      const src = b.dataset.src as AppState['input']['source']
      window.dj.send({ type: 'setInput', patch: { source: src } })
      if (src === 'camera') void tracker?.openCamera(state.input.deviceId).then(() => listCameras())
      else tracker?.closeCamera()
    }
  })

  $('camSel').onchange = (e): void => {
    const el = e.target as HTMLSelectElement
    const id = el.value
    // Nhớ lựa chọn: operator chỉnh camera ở venue một lần, các lần chạy sau phải
    // vào đúng camera đó chứ không quay về mặc định của hệ điều hành.
    saveCam(id, el.selectedOptions[0]?.textContent || '')
    window.dj.send({ type: 'setInput', patch: { deviceId: id } })
    void tracker?.openCamera(id).then(() => listCameras())
  }
  $('btnRecam').onclick = (): void => void listCameras()
  $('btnCalib').onclick = (): void => {
    const b = $('btnCalib')
    b.textContent = 'chụm tay và giữ…'
    b.classList.add('on')
    tracker?.startCalibration(3)
  }

  const range = (id: string, apply: (v: number) => void): void => {
    ;($(id) as HTMLInputElement).oninput = (e): void => apply(+(e.target as HTMLInputElement).value)
  }
  range('reach', (v) => window.dj.send({ type: 'setInput', patch: { reach: v } }))
  range('smooth', (v) => window.dj.send({ type: 'setInput', patch: { smooth: v } }))
  range('pinch', (v) => window.dj.send({ type: 'setInput', patch: { pinchThreshold: v } }))
  range('fistHold', (v) => window.dj.send({ type: 'setInput', patch: { fistHold: v } }))
  $('btnMirror').onclick = (): void =>
    window.dj.send({ type: 'setInput', patch: { mirror: !state.input.mirror } })
  range('hfov', (v) => window.dj.send({ type: 'setLook', patch: { hFov: v } }))
  range('stars', (v) => window.dj.send({ type: 'setLook', patch: { starDensity: v } }))
  range('strokeScale', (v) => window.dj.send({ type: 'setLook', patch: { strokeScale: v } }))
  range('hudScale', (v) => window.dj.send({ type: 'setLook', patch: { hudScale: v } }))
  range('bloomS', (v) => window.dj.send({ type: 'setLook', patch: { bloomStrength: v } }))

  $('kinectPort').onchange = (e): void =>
    window.dj.send({ type: 'setInput', patch: { kinectPort: +(e.target as HTMLInputElement).value } })

  const commitRes = (): void => {
    window.dj.send({
      type: 'setOutput',
      key: 'wall',
      patch: { resW: +($('resW') as HTMLInputElement).value, resH: +($('resH') as HTMLInputElement).value }
    })
  }
  $('resW').onchange = commitRes
  $('resH').onchange = commitRes
  $('btnResNative').onclick = (): void =>
    window.dj.send({ type: 'setOutput', key: 'wall', patch: { resW: 10350, resH: 1080 } })

  $('displaySel').onchange = (e): void =>
    window.dj.send({ type: 'setOutput', key: 'wall', patch: { display: +(e.target as HTMLSelectElement).value } })

  $('btnOpen').onclick = (): void => {
    const wall = state.outputs.find((o) => o.key === 'wall')!
    window.dj.send({ type: 'setOutput', key: 'wall', patch: { open: !wall.open } })
  }
  $('btnFs').onclick = (): void => {
    const wall = state.outputs.find((o) => o.key === 'wall')!
    window.dj.send({
      type: 'setOutput', key: 'wall',
      patch: { mode: wall.mode === 'fullscreen' ? 'windowed' : 'fullscreen', open: true }
    })
  }

  $('btnSpout').onclick = (): void => window.dj.send({ type: 'setSpout', patch: { running: !state.spout.running } })
  $('btnNdi').onclick = (): void => window.dj.send({ type: 'setNdi', patch: { running: !state.ndi.running } })
  document.querySelectorAll<HTMLButtonElement>('button.fps').forEach((b) => {
    b.onclick = (): void => {
      const fps = +b.dataset.fps!
      if (b.dataset.t === 'spout') window.dj.send({ type: 'setSpout', patch: { fps } })
      else window.dj.send({ type: 'setNdi', patch: { fps } })
    }
  })
  document.querySelectorAll<HTMLButtonElement>('button.scale').forEach((b) => {
    b.onclick = (): void => {
      const scale = +b.dataset.scale!
      if (b.dataset.t === 'spout') window.dj.send({ type: 'setSpout', patch: { scale } })
      else window.dj.send({ type: 'setNdi', patch: { scale } })
    }
  })

  // ---- sàn ----
  const commitFRes = (): void => {
    window.dj.send({
      type: 'setOutput', key: 'floor',
      patch: { resW: +($('fResW') as HTMLInputElement).value, resH: +($('fResH') as HTMLInputElement).value }
    })
  }
  $('fResW').onchange = commitFRes
  $('fResH').onchange = commitFRes
  document.querySelectorAll<HTMLButtonElement>('#fRotSeg button').forEach((b) => {
    b.onclick = (): void => window.dj.send({ type: 'setFloor', patch: { rotation: +b.dataset.rot! } })
  })
  range('fBright', (v) => window.dj.send({ type: 'setFloor', patch: { brightness: v } }))
  $('btnFOpen').onclick = (): void => {
    const f = state.outputs.find((o) => o.key === 'floor')!
    window.dj.send({ type: 'setOutput', key: 'floor', patch: { open: !f.open } })
  }
  $('btnFFs').onclick = (): void => {
    const f = state.outputs.find((o) => o.key === 'floor')!
    window.dj.send({
      type: 'setOutput', key: 'floor',
      patch: { mode: f.mode === 'fullscreen' ? 'windowed' : 'fullscreen', open: true }
    })
  }
  $('btnFSend').onclick = (): void => {
    const f = state.outputs.find((o) => o.key === 'floor')!
    window.dj.send({ type: 'setOutput', key: 'floor', patch: { send: !f.send } })
  }

  $('btnHud').onclick = (): void => window.dj.send({ type: 'setLook', patch: { hud: !state.look.hud } })
  $('btnBloom').onclick = (): void => window.dj.send({ type: 'setLook', patch: { bloom: !state.look.bloom } })
  $('btnLog').onclick = (): void => void window.dj.openLog()

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    audio.ensure()
    if (e.key === 'ArrowRight') window.dj.send({ type: 'nextStage' })
    else if (e.key === 'ArrowLeft') window.dj.send({ type: 'prevStage' })
    else if (e.key >= '0' && e.key <= '5') window.dj.send({ type: 'setStage', stage: +e.key as Stage })
    else if (e.key === 'c' || e.key === 'C') window.dj.send({ type: 'clear' })
    else if (e.key === 'm' || e.key === 'M') window.dj.send({ type: 'setSound', on: !state.sound })
  })
  // Autoplay policy: AudioContext chỉ mở được từ trong một cử chỉ người dùng.
  window.addEventListener('pointerdown', () => audio.ensure(), { once: false })
}

// ------------------------------------------------------------------- camera
// Lựa chọn camera được nhớ Ở ĐÂY chứ không ở store của main: state trong main
// dựng lại từ đầu mỗi lần chạy, nên không nhớ thì mỗi lần khởi động app lại
// quay về camera mặc định của hệ điều hành — trên macOS là "Camera iPhone".
const CAM_KEY = 'dj.camera'

function savedCam(): { id: string; label: string } | null {
  try {
    const raw = localStorage.getItem(CAM_KEY)
    return raw ? (JSON.parse(raw) as { id: string; label: string }) : null
  } catch { return null }
}

function saveCam(id: string, label: string): void {
  try { localStorage.setItem(CAM_KEY, JSON.stringify({ id, label })) } catch { /* không nhớ được cũng không sao */ }
}

async function listCameras(): Promise<MediaDeviceInfo[]> {
  let cams: MediaDeviceInfo[] = []
  try {
    cams = await HandTracker.listVideoInputs()
    const sel = $('camSel') as HTMLSelectElement
    sel.innerHTML = ''
    const def = document.createElement('option')
    def.value = ''
    def.textContent = 'Camera mặc định'
    sel.appendChild(def)
    cams.forEach((c, i) => {
      const o = document.createElement('option')
      o.value = c.deviceId
      o.textContent = c.label || `Camera ${i + 1}`
      sel.appendChild(o)
    })
    // Hiện đúng camera ĐANG chạy, không phải cái mình xin: nếu deviceId cũ không
    // còn thì tracker đã lùi về camera khác, và ô chọn phải nói thật.
    const live = tracker?.currentDeviceId || ''
    sel.value = cams.some((c) => c.deviceId === live) ? live : state.input.deviceId
  } catch { /* chưa có quyền camera thì danh sách rỗng, không sao */ }
  return cams
}

/** Chọn camera cho lần mở đầu tiên, theo thứ tự: cái operator đã chọn lần trước
 *  (khớp deviceId, không khớp thì khớp theo TÊN — deviceId đổi khi cắm cổng USB
 *  khác) → webcam thật đầu tiên → thôi thì camera nào cũng được.
 *  Chạy SAU khi đã mở camera một lần, vì trước đó enumerateDevices không có tên. */
async function autoPickCamera(): Promise<void> {
  const cams = await listCameras()
  if (cams.length === 0) return
  const saved = savedCam()
  let want = ''
  if (saved) {
    const byId = cams.find((c) => c.deviceId === saved.id)
    const byLabel = cams.find((c) => c.label && c.label === saved.label)
    want = (byId || byLabel)?.deviceId || ''
    if (!byId && byLabel) window.dj.log('camera', `deviceId đổi nhưng tìm lại được theo tên: ${saved.label}`)
    if (!byId && !byLabel) window.dj.log('camera', `camera đã lưu ("${saved.label}") không còn — chọn lại`)
  }
  if (!want) {
    // Điểm cao nhất thắng; bằng điểm thì giữ thứ tự hệ điều hành trả về.
    const best = cams.reduce((a, b) =>
      HandTracker.camRank(b.label) > HandTracker.camRank(a.label) ? b : a
    )
    want = best.deviceId
    if (best.deviceId !== cams[0].deviceId) {
      window.dj.log('camera', `tự chọn "${best.label}" thay vì mặc định "${cams[0].label}"`)
    }
  }
  const chosen = cams.find((c) => c.deviceId === want)
  if (want && want !== tracker?.currentDeviceId) {
    window.dj.send({ type: 'setInput', patch: { deviceId: want } })
    await tracker?.openCamera(want)
    await listCameras()
  }
  saveCam(want, chosen?.label || '')
}

/** Cắm/rút camera lúc app đang chạy. Người dùng vừa mua webcam mới thì cắm vào là
 *  phải thấy ngay trong danh sách, không phải khởi động lại app. */
async function onDeviceChange(): Promise<void> {
  const cams = await listCameras()
  const live = tracker?.currentDeviceId || ''
  window.dj.log('camera', `danh sách camera đổi (${cams.length}): ${cams.map((c) => c.label || '?').join(' | ')}`)
  if (state.input.source !== 'camera') return
  const cur = cams.find((c) => c.deviceId === live)
  if (cur) {
    // Vừa cắm webcam rời trong khi đang chạy bằng camera laptop: KHÔNG tự đổi
    // (đang diễn mà hình nhảy sang camera khác thì hỏng), chỉ mách một câu.
    const better = cams.find((c) => HandTracker.camRank(c.label) > HandTracker.camRank(cur.label))
    if (better) window.dj.log('camera', `có camera phù hợp hơn: "${better.label}" — chọn trong danh sách nếu muốn dùng`)
  }
  if (live && !cams.some((c) => c.deviceId === live)) {
    // Camera đang dùng vừa bị rút. Track 'ended' cũng bắt được, nhưng không phải
    // driver nào cũng bắn 'ended' — đây là lưới thứ hai.
    window.dj.log('camera', 'camera đang dùng đã bị rút — chọn lại camera khác')
    await autoPickCamera()
  } else if (!live) {
    await autoPickCamera()
  }
}

// ---------------------------------------------------------------- vòng chạy
function onHand(h: HandFrame, second: SecondHand): void {
  window.dj.sendHand({ primary: h, second })
  // Lưới an toàn: nếu ctx vẫn bị treo (autoplay policy đổi, thiết bị ra âm thanh
  // đổi giữa chừng), lần đầu thấy tay là mở lại.
  if (h.present && !audio.ready) {
    audio.ensure()
    audio.setEnabled(state.sound)
    render()
  }
  $('gesture').textContent = h.label || (h.present ? '' : 'chưa có tay')

  // Âm thanh bám theo nét vẽ.
  const heightNorm = 1 - h.ny
  if (h.pinch && !drawing) {
    drawing = true
    strokeFrames = 0
    lastPos = null
  } else if (!h.pinch && drawing) {
    drawing = false
    audio.updateDraw(false, 0, heightNorm)
    audio.strokeEnd(heightNorm, state.stage)
    if (state.stage === 5 && strokeFrames > 3) audio.layerAdded()
  }
  if (drawing) {
    strokeFrames++
    const speed = lastPos ? Math.hypot(h.nx - lastPos.x, h.ny - lastPos.y) * 12 : 0
    lastPos = { x: h.nx, y: h.ny }
    audio.updateDraw(true, speed, heightNorm)
  }
}

async function boot(): Promise<void> {
  state = await window.dj.getState()
  wire()
  render()

  const displays = await window.dj.displays()
  const sel = $('displaySel') as HTMLSelectElement
  sel.innerHTML = ''
  displays.forEach((d) => {
    const o = document.createElement('option')
    o.value = String(d.id)
    o.textContent = d.label
    sel.appendChild(o)
  })
  const wall = state.outputs.find((o) => o.key === 'wall')!
  sel.value = String(wall.display || displays[0]?.id || 0)
  if (!wall.display && displays[0]) {
    window.dj.send({ type: 'setOutput', key: 'wall', patch: { display: displays[0].id } })
  }

  // Mở AudioContext NGAY. Trước đây chỉ mở khi có người bấm chuột/gõ phím vào
  // cửa sổ này — mà người tham gia điều khiển bằng tay, không ai bấm gì, nên cả
  // nhạc nền lẫn hiệu ứng im suốt show. Main đã bật switch autoplay-policy nên
  // Chromium không chặn nữa.
  audio.ensure()
  audio.setEnabled(state.sound)
  // Móc chẩn đoán, giống __djScene bên cửa sổ tường.
  ;(window as unknown as { __djAudio: AudioEngine }).__djAudio = audio
  window.dj.log('audio', `AudioContext = ${audio.ctxState}, master gain = ${audio.masterGainValue}`)
  // 'suspended' nghĩa là Chromium vẫn chặn — cả show sẽ im tiếng.
  setTimeout(() => window.dj.log('audio', `sau 3s: ${audio.ctxState}`), 3000)

  tracker = new HandTracker(
    $('cam') as HTMLVideoElement,
    $('skel') as HTMLCanvasElement,
    state,
    {
      onHand,
      onStatus: (text, tone) => {
        $('trackText').textContent = text
        setDot('trackDot', tone)
        window.dj.log('tracking', text)
      },
      onDebug: (text) => { $('gestDebug').textContent = text },
      onStageAdvance: () => window.dj.send({ type: 'nextStage' })
    }
  )
  // Móc chẩn đoán (giống __djScene) — soi trạng thái cử chỉ thật khi ở venue.
  ;(window as unknown as { __djTracker: HandTracker }).__djTracker = tracker
  tracker.onCalibrated = (v): void => {
    window.dj.send({ type: 'setInput', patch: { pinchThreshold: +v.toFixed(2) } })
    const b = $('btnCalib')
    b.textContent = `đã đặt ngưỡng ${v.toFixed(2)} — chỉnh lại`
    b.classList.remove('on')
  }
  await tracker.init()
  if (state.input.source === 'camera') {
    // Mở phát đầu bằng camera đã lưu (nếu có) — vừa xin quyền, vừa làm
    // enumerateDevices hiện được TÊN camera cho bước chọn lại ngay sau đó.
    await tracker.openCamera(savedCam()?.id || '')
    await autoPickCamera()
  } else {
    await listCameras()
  }
  navigator.mediaDevices.addEventListener('devicechange', () => void onDeviceChange())

  window.dj.onKinectFrame((frame) => tracker?.onKinectFrame(frame))

  let lastStage = state.stage
  window.dj.onState((s) => {
    state = s
    tracker?.setState(s)
    audio.setEnabled(s.sound)
    if (s.stage !== lastStage) {
      lastStage = s.stage
      audio.stageChanged(s.stage)
    }
    render()
  })

  window.dj.onStatus((s) => renderStatus(s as { spout: SpoutStatus; ndi: NdiStatus; kinect: KinectStatus }))
  const st = (await window.dj.status()) as { log: string[] }
  $('logbox').textContent = st.log.join('\n')
  setInterval(async () => {
    const s = (await window.dj.status()) as { log: string[] }
    const box = $('logbox')
    box.textContent = s.log.join('\n')
    box.scrollTop = box.scrollHeight
  }, 3000)

  let last = performance.now()
  const loop = (t: number): void => {
    requestAnimationFrame(loop)
    const dt = Math.min(0.1, (t - last) / 1000)
    last = t
    tracker?.tick(dt)
  }
  requestAnimationFrame(loop)
}

boot().catch((e) => {
  console.error('[control] boot lỗi', e)
  document.body.innerHTML = `<pre style="color:#f4587a;padding:30px">CONTROL boot lỗi: ${String(e)}</pre>`
})
