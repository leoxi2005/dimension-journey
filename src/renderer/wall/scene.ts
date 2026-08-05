// ============================================================================
// Scene 0D→5D cho tường 10350×1080 (tỉ lệ 9.58:1).
//
// BẢN GỐC được thiết kế cho màn 16:9. Đưa thẳng lên tường dài thì hỏng 4 chỗ,
// đây là cách xử lý từng chỗ:
//
// 1. KHUNG HÌNH. Giữ nguyên PerspectiveCamera fov dọc 50° thì góc ngang phọt lên
//    154° — rìa tường méo như gương cầu. Nên đảo tham số: chọn GÓC NGANG (hFov,
//    mặc định 100°) rồi suy ra fov dọc + khoảng cách camera sao cho chiều cao thế
//    giới luôn = 13 đơn vị. Nhờ vậy mọi kích thước tính theo pixel giữ nguyên như
//    bản gốc, chỉ có bề ngang là nở ra (~125 đơn vị).
//
// 2. CỠ HẠT. three.js tính gl_PointSize = size × (cao_canvas/2) / khoảng_cách,
//    KHÔNG kể fov. Camera lùi từ 14 ra 52 nên hạt sẽ nhỏ đi 3.7 lần. Phải nhân
//    mọi PointsMaterial.size với PT_K = dist/14. (Sprite là quad trong không gian
//    thế giới nên không dính lỗi này.)
//
// 3. GIỚI HẠN TEXTURE 16384px. 10350 × devicePixelRatio 2 = 20700 → WebGL chết,
//    và Chromium lặng lẽ bỏ shared texture làm Spout mất tín hiệu. pixelRatio
//    luôn phải kẹp theo 16384/W.
//
// 4. XOAY TRÒN KHÔNG DÙNG ĐƯỢC. Trường rộng 125 đơn vị mà quay 360° thì hầu hết
//    thời gian khán giả nhìn nó nghiêng cạnh. Quỹ đạo 3D/4D và cú xoay 5D đều đổi
//    thành đung đưa có biên.
// ============================================================================
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { AppState, HandFrame, EMPTY_HAND, Stage } from '../../shared/types'

const HALF_H = 6.5 // nửa chiều cao thế giới — HẰNG SỐ, giữ mọi tỉ lệ pixel như bản gốc
const REF_DIST = 14 // khoảng cách camera của bản gốc, dùng làm mốc quy đổi cỡ hạt
const MAX_TEX = 16384
const MAX_STROKE_PTS = 900 // sức chứa buffer nét đang vẽ
const MAX_TRAIL = 2400     // sức chứa buffer vệt sáng

interface Framing {
  dist: number
  halfW: number
  vFovDeg: number
  ptK: number
}

function framing(aspect: number, hFovDeg: number): Framing {
  const tanH = Math.tan(THREE.MathUtils.degToRad(hFovDeg) / 2)
  const tanV = tanH / Math.max(0.0001, aspect)
  const dist = HALF_H / tanV
  return {
    dist,
    halfW: dist * tanH,
    vFovDeg: THREE.MathUtils.radToDeg(2 * Math.atan(tanV)),
    ptK: dist / REF_DIST
  }
}

const NOTES = [220.0, 246.94, 277.18, 329.63, 369.99, 440.0]

export class WallScene {
  private canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private composer: EffectComposer | null = null
  private bloom: UnrealBloomPass | null = null
  private renderPass: RenderPass | null = null

  private f: Framing
  private state: AppState
  private hand: HandFrame = { ...EMPTY_HAND }
  private lastClearNonce = 0
  private lastStage: Stage = 0
  private lastHFov = 0
  private lastDensity = 0

  private glowTex!: THREE.Texture
  private bgGroup = new THREE.Group()
  private strokeGroup = new THREE.Group()
  private stackGroup = new THREE.Group()
  private grid!: THREE.GridHelper
  private polar!: THREE.PolarGridHelper
  private centerHalo!: THREE.Sprite
  private centerCore!: THREE.Sprite
  private cursor!: THREE.Sprite
  private liveGeo = new THREE.BufferGeometry()
  private liveLine!: THREE.Line
  private trailGeo = new THREE.BufferGeometry()
  private trailPoints!: THREE.Points

  private trail: { x: number; y: number; z: number; t: number }[] = []
  private echoes: { mesh: THREE.Object3D; born: number; target: number }[] = []
  private twinkles: { mat: THREE.Material & { opacity: number }; phase: number }[] = []
  private pulses: { mat: THREE.MeshPhysicalMaterial; phase: number }[] = []

  private drawing = false
  private strokePts: THREE.Vector3[] = []
  private pointer = new THREE.Vector3()
  private pointerTarget: THREE.Vector3 | null = null
  private cursorActive = false
  private layerCount = 0
  private orbitPhase = 0
  private stackYaw = 0
  private stackPitch = 0
  private palmPrev: { x: number; y: number } | null = null
  private prevPinch = false

  /** Control hiển thị số layer 5D và phát tiếng; scene báo ngược ra đây. */
  onLayerCount: ((n: number) => void) | null = null

  constructor(canvas: HTMLCanvasElement, state: AppState) {
    this.canvas = canvas
    this.state = state
    this.lastClearNonce = state.clearNonce
    this.lastStage = state.stage

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600)
    this.f = framing(1, state.look.hFov)

    this.build()
    this.resize()
  }

  // ------------------------------------------------------------------ build
  private build(): void {
    this.scene.background = new THREE.Color('#07060c')
    // Sương mù mỏng hơn bản gốc: trường sâu gấp ~4 lần nên mật độ cũ sẽ nuốt sạch
    // mọi thứ ở xa.
    this.scene.fog = new THREE.FogExp2(0x07060c, 0.0032)

    this.scene.add(new THREE.AmbientLight(0x49406e, 1.1))
    const dir = new THREE.DirectionalLight(0xc4b5fd, 0.9)
    dir.position.set(6, 9, 12)
    this.scene.add(dir)
    const pt = new THREE.PointLight(0x8b5cf6, 0.7, 200)
    pt.position.set(0, 2, 20)
    this.scene.add(pt)
    this.scene.add(new THREE.HemisphereLight(0x7c6bd8, 0x150a28, 0.55))

    this.glowTex = this.makeGlowTexture()
    this.scene.add(this.bgGroup)
    this.scene.add(this.strokeGroup)
    this.stackGroup.visible = false
    this.scene.add(this.stackGroup)

    this.centerHalo = this.makeSprite(0x8b5cf6, 3.2, 0.5)
    this.centerCore = this.makeSprite(0xe9d5ff, 0.9, 1.0)
    this.scene.add(this.centerHalo, this.centerCore)

    this.cursor = this.makeSprite(0xc4b5fd, 0.7, 0.85)
    this.cursor.visible = false
    this.scene.add(this.cursor)

    // Nét đang vẽ. KHÔNG dùng setFromPoints: lần gọi đầu tiên (lúc đó 0 điểm)
    // tạo ra buffer count=0, mọi lần sau chỉ ghi được đúng 0 điểm và three chỉ
    // in cảnh báo — nét live sẽ không bao giờ hiện. Cấp phát sẵn sức chứa tối
    // đa rồi điều khiển bằng drawRange.
    this.liveGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_STROKE_PTS * 3), 3))
    this.liveGeo.setDrawRange(0, 0)
    this.liveGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
    this.liveGeo.computeBoundingSphere = (): void => { /* giữ quả cầu cố định */ }
    this.liveLine = new THREE.Line(
      this.liveGeo,
      new THREE.LineBasicMaterial({ color: 0xc4b5fd, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    this.liveLine.frustumCulled = false
    this.scene.add(this.liveLine)

    // Vệt sáng cũng cấp phát sẵn: tạo BufferAttribute mới mỗi frame ở 60fps là
    // rác cho GC ngay giữa show.
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3))
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3))
    this.trailGeo.setDrawRange(0, 0)
    this.trailPoints = new THREE.Points(
      this.trailGeo,
      new THREE.PointsMaterial({ size: 0.42, map: this.glowTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    this.trailPoints.frustumCulled = false
    // Vệt sáng đổi toàn bộ đỉnh mỗi frame nên tính lại bounding sphere là phí.
    // KHÔNG được vô hiệu hoá computeBoundingSphere suông (prototype gốc làm vậy):
    // nhánh sortObjects của WebGLRenderer đọc boundingSphere.center KỂ CẢ khi
    // frustumCulled=false, gặp null là ném lỗi và chết cả vòng render.
    // Cách đúng: gán sẵn một quả cầu to vô tận rồi cho computeBoundingSphere
    // giữ nguyên nó.
    this.trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
    this.trailGeo.computeBoundingSphere = (): void => { /* giữ quả cầu cố định */ }
    this.scene.add(this.trailPoints)

    this.grid = new THREE.GridHelper(1, 1, 0x7c5cf0, 0x2a1f55)
    this.polar = new THREE.PolarGridHelper(1, 16, 8, 64, 0x7c5cf0, 0x2a1f55)
    for (const g of [this.grid, this.polar]) {
      const m = g.material as THREE.Material & { opacity: number }
      m.transparent = true
      m.opacity = 0
      m.blending = THREE.AdditiveBlending
      m.depthWrite = false
      g.visible = false
      this.scene.add(g)
    }
    this.grid.rotation.x = Math.PI / 2 // GridHelper nằm ở mặt XZ; xoay về mặt XY
  }

  private makeGlowTexture(): THREE.Texture {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.6)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  }

  private makeSprite(color: number, scale: number, opacity: number): THREE.Sprite {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    s.scale.setScalar(scale)
    return s
  }

  /** Sao rải ĐẦY hình chóp cụt của camera thay vì trên mặt cầu như bản gốc —
   *  mặt cầu bán kính cố định để lại hai mảng trống to đùng ở hai đầu tường. */
  private buildStars(): void {
    const old = this.bgGroup.children.slice()
    for (const c of old) {
      this.bgGroup.remove(c)
      const anyC = c as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material }
      anyC.geometry?.dispose()
      anyC.material?.dispose()
    }

    const { dist, halfW } = this.f
    const tanH = halfW / dist
    const tanV = HALF_H / dist
    const density = Math.max(0.25, this.state.look.starDensity / 100)
    const N = Math.min(24000, Math.round(1300 * (halfW / (HALF_H * 16 / 9)) * density))

    // BA LỚP khác cỡ. Vì đã tắt sizeAttenuation nên mọi sao cùng cỡ pixel, nền
    // sẽ phẳng như nhiễu hạt; chia lớp lấy lại chiều sâu mà vẫn phủ đều.
    // Cỡ sao tính theo PIXEL nên phải nhân theo chiều cao khung render thật, nếu
    // không thì cửa sổ xem trước nhỏ sẽ hiện sao to gấp mấy lần tường thật và
    // mình tự đánh lừa mình khi ngắm. Mốc là tường 1080 pixel chiều cao.
    const hPx = Math.max(120, this.renderer.domElement.height)
    const sizeK = hPx / 1080
    const LAYERS = [
      // dim chọn sao cho độ sáng mỗi sao rơi đúng dải 0.25–0.75 của bản gốc,
      // không phải áng chừng bằng mắt trên ảnh đã thu nhỏ.
      { frac: 0.62, size: 1.3, dim: 0.85 },
      { frac: 0.29, size: 2.0, dim: 0.95 },
      { frac: 0.09, size: 2.9, dim: 1.0 }
    ]
    const palette = [new THREE.Color(0x8b5cf6), new THREE.Color(0xc4b5fd), new THREE.Color(0xffffff), new THREE.Color(0x6d8bfa)]
    const zSpan = dist * 0.25
    for (const L of LAYERS) {
      const n = Math.max(1, Math.round(N * L.frac))
      const pos = new Float32Array(n * 3)
      const col = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        // Sinh toạ độ TRONG KHÔNG GIAN MÀN HÌNH rồi chiếu ngược ra thế giới.
        // Rải thẳng trong hộp thế giới thì ở z xa khung hình rộng hơn nên hai
        // đầu tường bị hụt sao.
        const z = -zSpan * Math.random()
        const d = dist - z
        pos[i * 3] = (Math.random() * 2 - 1) * d * tanH * 1.02
        pos[i * 3 + 1] = (Math.random() * 2 - 1) * d * tanV * 1.06
        pos[i * 3 + 2] = z
        const c = palette[(Math.random() * palette.length) | 0].clone()
          .multiplyScalar((0.3 + Math.random() * 0.55) * L.dim)
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      // sizeAttenuation TẮT: trường rộng 125 đơn vị nên góc màn hình xa camera
      // gấp 1.55 lần tâm — bật attenuation thì sao ở hai đầu tường tự nhỏ và tối
      // đi, ra đúng vệt sáng hình thấu kính. Tắt đi thì phủ đều tuyệt đối.
      const mat = new THREE.PointsMaterial({
        size: L.size * sizeK, sizeAttenuation: false, vertexColors: true,
        map: this.glowTex, // không có map thì GL point ra hình VUÔNG, thấy rõ khi sao to
        transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false
      })
      const pts = new THREE.Points(geo, mat)
      pts.frustumCulled = false
      this.bgGroup.add(pts)
    }

    // Quầng tinh vân. Cỡ phải tính theo PHẦN CHIỀU CAO MÀN HÌNH nó chiếm, chứ
    // không phải một hằng số thế giới: bản trước nhân sai, ra sprite to gấp 4.3
    // lần chiều cao khung — chính là quầng tím khổng lồ nuốt hết nền.
    const nebCols = [0x4c1d95, 0x1e2a6e, 0x6d28d9, 0x312e81, 0x86198f, 0x155e75]
    const nebCount = Math.max(4, Math.round(halfW / 9))
    for (let i = 0; i < nebCount; i++) {
      const z = -dist * (0.3 + Math.random() * 0.5)
      const d = dist - z
      const frac = 0.35 + Math.random() * 0.5 // phần chiều cao khung mà quầng chiếm
      const neb = this.makeSprite(nebCols[i % nebCols.length], frac * 2 * d * tanV, 0.035 + Math.random() * 0.04)
      neb.position.set(
        (Math.random() * 2 - 1) * d * tanH * 0.92,
        (Math.random() * 2 - 1) * d * tanV * 0.55,
        z
      )
      this.bgGroup.add(neb)
    }
  }

  /** Hình học phụ thuộc bề ngang — dựng lại khi đổi khung hình. */
  private layoutForFraming(): void {
    const { halfW, ptK } = this.f
    const gridSize = halfW * 2.4
    this.grid.geometry.dispose()
    const newGrid = new THREE.GridHelper(gridSize, Math.max(8, Math.round(gridSize / 2.6)), 0x7c5cf0, 0x2a1f55)
    this.grid.geometry = newGrid.geometry
    this.grid.position.z = -0.06

    this.polar.geometry.dispose()
    const newPolar = new THREE.PolarGridHelper(halfW * 1.1, 16, 8, 64, 0x7c5cf0, 0x2a1f55)
    this.polar.geometry = newPolar.geometry
    this.polar.position.y = -HALF_H * 0.95

    ;(this.trailPoints.material as THREE.PointsMaterial).size = 0.42 * ptK
    this.buildStars()
  }

  // ----------------------------------------------------------------- resize
  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth)
    const h = Math.max(1, this.canvas.clientHeight)
    // BẮT BUỘC kẹp: 10350 × dpr 2 = 20700 > 16384 → WebGL chết và Spout mất tín hiệu.
    const pr = Math.min(window.devicePixelRatio || 1, 2, MAX_TEX / w, MAX_TEX / h)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)

    const aspect = w / h
    this.f = framing(aspect, this.state.look.hFov)
    this.camera.aspect = aspect
    this.camera.fov = this.f.vFovDeg
    this.camera.far = this.f.dist * 4
    this.camera.updateProjectionMatrix()
    this.lastHFov = this.state.look.hFov
    this.lastDensity = this.state.look.starDensity

    this.layoutForFraming()
    this.syncComposer(w, h, pr)
  }

  private syncComposer(w: number, h: number, pr: number): void {
    const want = this.state.look.bloom
    if (want && !this.composer) {
      this.composer = new EffectComposer(this.renderer)
      this.composer.setPixelRatio(pr)
      this.renderPass = new RenderPass(this.scene, this.camera)
      this.composer.addPass(this.renderPass)
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), this.state.look.bloomStrength, 0.7, 0.22)
      this.composer.addPass(this.bloom)
    } else if (!want && this.composer) {
      this.composer.dispose()
      this.composer = null
      this.bloom = null
      this.renderPass = null
    }
    if (this.composer) {
      this.composer.setPixelRatio(pr)
      this.composer.setSize(w, h)
      if (this.bloom) this.bloom.strength = this.state.look.bloomStrength
    }
  }

  // ------------------------------------------------------------------ state
  setState(s: AppState): void {
    const prev = this.state
    this.state = s
    if (s.clearNonce !== this.lastClearNonce) {
      this.lastClearNonce = s.clearNonce
      this.clearStage()
    }
    if (s.stage !== this.lastStage) {
      this.lastStage = s.stage
      this.enterStage(s.stage)
    }
    if (s.look.hFov !== this.lastHFov || s.look.starDensity !== this.lastDensity) {
      this.resize()
    }
    if (s.look.bloom !== prev.look.bloom || s.look.bloomStrength !== prev.look.bloomStrength) {
      this.syncComposer(this.canvas.clientWidth, this.canvas.clientHeight, this.renderer.getPixelRatio())
    }
  }

  setHand(h: HandFrame): void {
    this.hand = h
  }

  /** Chuột — đường dự phòng khi camera hỏng giữa show. */
  setMouse(nx: number, ny: number, down: boolean): void {
    this.pointerTarget = this.screenToWorld(nx, ny)
    this.cursorActive = true
    if (down && !this.drawing) {
      this.pointer.copy(this.pointerTarget)
      this.beginStroke()
    } else if (!down && this.drawing) {
      this.endStroke()
    }
  }

  dragStack(dx: number, dy: number): void {
    this.rotateStack(dx, dy)
  }

  // ------------------------------------------------------------------ input
  private applyHand(): void {
    const h = this.hand
    if (!h.present) {
      if (this.drawing) this.endStroke()
      this.cursorActive = false
      this.palmPrev = null
      this.prevPinch = false
      return
    }
    const reach = Math.max(0.4, Math.min(1, this.state.input.reach / 100))
    // reach < 100% thu vùng với tới về giữa tường — bàn tay không quét nổi 10m
    // thì thà cho nó điều khiển đúng phần giữa còn hơn giật cục ở hai đầu.
    const nx = 0.5 + (h.nx - 0.5) * reach
    const ny = 0.5 + (h.ny - 0.5) * reach
    this.pointerTarget = this.screenToWorld(nx, ny)
    this.cursorActive = true

    // Xoè bàn tay ở 5D = xoay trường.
    if (h.palm && this.state.stage === 5 && !this.drawing) {
      if (this.palmPrev) this.rotateStack((h.nx - this.palmPrev.x) * 1.6, (h.ny - this.palmPrev.y) * 1.6)
      this.palmPrev = { x: h.nx, y: h.ny }
      this.prevPinch = false
      return
    }
    this.palmPrev = null

    if (h.pinch && !this.prevPinch) {
      this.pointer.copy(this.pointerTarget)
      this.beginStroke()
    } else if (!h.pinch && this.prevPinch && this.drawing) {
      this.endStroke()
    }
    this.prevPinch = h.pinch
  }

  /** Ghi nét đang vẽ vào buffer cấp phát sẵn, điều khiển bằng drawRange. */
  private setLive(pts: THREE.Vector3[]): void {
    const attr = this.liveGeo.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const n = Math.min(pts.length, MAX_STROKE_PTS)
    for (let i = 0; i < n; i++) {
      arr[i * 3] = pts[i].x; arr[i * 3 + 1] = pts[i].y; arr[i * 3 + 2] = pts[i].z
    }
    attr.needsUpdate = true
    this.liveGeo.setDrawRange(0, n)
  }

  /** Bán kính nét đã nhân hệ số dày. */
  private sw(r: number): number {
    return r * Math.max(0.3, this.state.look.strokeScale)
  }

  /** Bắn tia từ điểm trên màn hình xuống mặt phẳng đi qua gốc, vuông góc hướng nhìn. */
  private screenToWorld(nx: number, ny: number): THREE.Vector3 {
    const v = new THREE.Vector3(nx * 2 - 1, -(ny * 2 - 1), 0.5).unproject(this.camera)
    const dir = v.sub(this.camera.position).normalize()
    const fwd = new THREE.Vector3()
    this.camera.getWorldDirection(fwd)
    const denom = dir.dot(fwd)
    const t = Math.abs(denom) < 1e-4
      ? this.camera.position.length()
      : -this.camera.position.dot(fwd) / denom
    return this.camera.position.clone().add(dir.multiplyScalar(t))
  }

  // ---------------------------------------------------------------- drawing
  private beginStroke(): void {
    this.drawing = true
    this.strokePts = [this.pointer.clone()]
  }

  private extendStroke(p: THREE.Vector3): void {
    const pts = this.strokePts
    const last = pts[pts.length - 1]
    if (!last) return
    const d = last.distanceTo(p)
    // Ngưỡng theo bề rộng thế giới, không phải hằng số: trường rộng gấp 5 lần thì
    // ngưỡng 0.06 của bản gốc sẽ nhồi hàng nghìn điểm thừa cho mỗi nét.
    const minStep = this.f.dist * 0.0043
    if (d < minStep) return
    const steps = Math.min(6, Math.ceil(d / (minStep * 2)))
    for (let i = 1; i <= steps; i++) this.addTrail(last.clone().lerp(p, i / steps))
    if (pts.length < MAX_STROKE_PTS) pts.push(p.clone())
  }

  private addTrail(p: THREE.Vector3): void {
    this.trail.push({ x: p.x, y: p.y, z: p.z, t: performance.now() / 1000 })
    if (this.trail.length > MAX_TRAIL) this.trail.splice(0, this.trail.length - MAX_TRAIL)
  }

  private endStroke(): void {
    this.drawing = false
    const pts = this.strokePts
    this.strokePts = []
    this.setLive([])
    const stage = this.state.stage
    if (stage === 0 || pts.length < 2) return

    this.burst(pts[pts.length - 1], 14)

    if (stage === 1) {
      const a = pts[0]
      const b = pts[pts.length - 1]
      if (a.distanceTo(b) < this.f.dist * 0.02) return
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 2, this.sw(0.045), 8, false),
        new THREE.MeshBasicMaterial({ color: 0xb79bfa, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false })
      )
      const e1 = this.makeSprite(0xe9d5ff, this.sw(0.5), 0.9); e1.position.copy(a)
      const e2 = this.makeSprite(0xe9d5ff, this.sw(0.5), 0.9); e2.position.copy(b)
      const grp = new THREE.Group()
      grp.add(mesh, e1, e2)
      this.strokeGroup.add(grp)
      return
    }

    if (pts.length < 3) return

    if (stage === 2) {
      const flat = pts.map((p) => new THREE.Vector3(p.x, p.y, 0))
      const mesh = this.tubeFrom(flat, this.sw(0.05), new THREE.MeshBasicMaterial({ color: 0xb79bfa, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false }))
      if (mesh) this.strokeGroup.add(mesh)
      return
    }

    if (stage === 3 || stage === 4) {
      const seed = Math.random() * 10
      const deep = pts.map((p, i) => new THREE.Vector3(p.x, p.y, p.z + (Math.sin(i * 0.32 + seed) + Math.sin(i * 0.11 + seed * 2)) * 0.9))
      const grp = this.makeSolidStroke(deep)
      if (!grp) return
      this.strokeGroup.add(grp)

      if (stage === 4) {
        const now = performance.now() / 1000
        // Tiếng vọng 4D rải theo BỀ NGANG tường, không quây tròn quanh gốc như
        // bản gốc — quây tròn thì 10m tường chỉ có cục sáng ở giữa.
        for (let i = 0; i < 5; i++) {
          const clone = this.makeSolidStroke(deep)
          if (!clone) continue
          clone.position.set(
            (Math.random() * 2 - 1) * this.f.halfW * 0.85,
            (Math.random() - 0.5) * HALF_H * 1.6,
            -this.f.dist * (0.05 + Math.random() * 0.5)
          )
          clone.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28)
          clone.scale.setScalar(0.001)
          this.strokeGroup.add(clone)
          this.echoes.push({ mesh: clone, born: now + 0.25 + i * 0.28, target: 0.35 + Math.random() * 1.0 })
        }
      }
      return
    }

    if (stage === 5) {
      const base = (0.62 + this.layerCount * 0.13) % 1
      const hueFn = (t: number): number => base + 0.5 * t
      const col = new THREE.Color().setHSL(base, 0.8, 0.66)
      const flat = pts.map((p) => {
        const lp = this.stackGroup.worldToLocal(p.clone())
        lp.z = 0
        return lp
      })
      const mesh = this.gradTube(flat, this.sw(0.06), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false }), hueFn, 0.85, 0.62)
      if (!mesh) return
      const gap = this.f.dist * 0.075
      for (const child of this.stackGroup.children) child.position.z -= gap
      const layer = new THREE.Group()
      layer.add(mesh)
      layer.add(this.makeLayerFrame(col))
      this.stackGroup.add(layer)
      this.layerCount++
      this.onLayerCount?.(this.layerCount)
    }
  }

  private gradTube(
    pts: THREE.Vector3[], radius: number, material: THREE.Material,
    hueFn: (t: number) => number, sat: number, light: number
  ): THREE.Mesh | null {
    try {
      const curve = new THREE.CatmullRomCurve3(pts)
      const tubular = Math.min(380, Math.max(8, pts.length * 3))
      const radial = 8
      const geo = new THREE.TubeGeometry(curve, tubular, radius, radial, false)
      const count = geo.attributes.position.count
      const colors = new Float32Array(count * 3)
      const c = new THREE.Color()
      const ring = radial + 1
      for (let i = 0; i < count; i++) {
        const tt = Math.floor(i / ring) / tubular
        let h = hueFn(tt)
        h = ((h % 1) + 1) % 1
        c.setHSL(h, sat, light)
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      ;(material as THREE.MeshBasicMaterial).vertexColors = true
      const m = new THREE.Mesh(geo, material)
      m.frustumCulled = false
      return m
    } catch {
      return null
    }
  }

  private tubeFrom(pts: THREE.Vector3[], radius: number, material: THREE.Material): THREE.Mesh | null {
    try {
      const curve = new THREE.CatmullRomCurve3(pts)
      const geo = new THREE.TubeGeometry(curve, Math.min(380, Math.max(8, pts.length * 3)), radius, 8, false)
      const m = new THREE.Mesh(geo, material)
      m.frustumCulled = false
      return m
    } catch {
      return null
    }
  }

  private makeSolidStroke(deep: THREE.Vector3[]): THREE.Group | null {
    const base = Math.random()
    const flow = (Math.random() < 0.5 ? 1 : -1) * (0.28 + Math.random() * 0.4)
    const hueFn = (t: number): number => base + flow * t
    const grp = new THREE.Group()

    const bodyMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.55,
      roughness: 0.18, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.25
    })
    const body = this.gradTube(deep, this.sw(0.2), bodyMat, hueFn, 0.85, 0.55)
    if (!body) return null
    const midHue = (((base + flow * 0.5) % 1) + 1) % 1
    bodyMat.emissive = new THREE.Color().setHSL(midHue, 0.85, 0.32)
    grp.add(body)
    this.pulses.push({ mat: bodyMat, phase: Math.random() * 6.28 })

    const core = this.gradTube(deep, this.sw(0.06), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), hueFn, 0.9, 0.82)
    if (core) grp.add(core)

    try {
      const curve = new THREE.CatmullRomCurve3(deep)
      const n = 34
      const pos = new Float32Array(n * 3)
      const cols = new Float32Array(n * 3)
      const c = new THREE.Color()
      for (let i = 0; i < n; i++) {
        const tt = Math.random()
        const p = curve.getPoint(tt)
        pos[i * 3] = p.x + (Math.random() - 0.5) * 0.6
        pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * 0.6
        pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.6
        c.setHSL((((hueFn(tt) % 1) + 1) % 1), 0.9, 0.72)
        cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3))
      const m = new THREE.PointsMaterial({ size: this.sw(0.34) * this.f.ptK, map: this.glowTex, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
      const sp = new THREE.Points(geo, m)
      sp.frustumCulled = false
      grp.add(sp)
      this.twinkles.push({ mat: m, phase: Math.random() * 6.28 })
    } catch { /* bụi lấp lánh là phần trang trí, thiếu cũng không sao */ }
    return grp
  }

  private makeLayerFrame(color: THREE.Color): THREE.Group {
    const w = this.f.halfW * 0.94
    const h = HALF_H * 0.88
    const pts = [
      new THREE.Vector3(-w, -h, 0), new THREE.Vector3(w, -h, 0),
      new THREE.Vector3(w, h, 0), new THREE.Vector3(-w, h, 0), new THREE.Vector3(-w, -h, 0)
    ]
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 2, h * 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.025, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    )
    const g = new THREE.Group()
    g.add(line, plane)
    return g
  }

  /** Xoay trường 5D — CÓ BIÊN. Quay tự do như bản gốc thì tấm rộng 125 đơn vị sẽ
   *  quay đến lúc nhìn nghiêng cạnh, trên tường chỉ còn một vạch sáng. */
  private rotateStack(dx: number, dy: number): void {
    if (this.state.stage !== 5) return
    this.stackYaw = THREE.MathUtils.clamp(this.stackYaw + dx * 1.1, -0.42, 0.42)
    this.stackPitch = THREE.MathUtils.clamp(this.stackPitch + dy * 1.4, -0.5, 0.5)
  }

  // ----------------------------------------------------------------- stages
  private enterStage(i: Stage): void {
    if (this.drawing) this.endStroke()
    this.clearGroup(this.strokeGroup)
    this.echoes = []
    this.twinkles = []
    this.pulses = []
    this.trail = []
    this.burst(new THREE.Vector3(0, 0, 0), 26)
    if (i !== 5) {
      this.clearGroup(this.stackGroup)
      this.stackYaw = 0
      this.stackPitch = 0
      this.layerCount = 0
      this.onLayerCount?.(0)
    }
  }

  private clearStage(): void {
    this.clearGroup(this.strokeGroup)
    this.echoes = []
    this.twinkles = []
    this.pulses = []
    this.trail = []
    if (this.state.stage === 5) {
      this.clearGroup(this.stackGroup)
      this.layerCount = 0
      this.onLayerCount?.(0)
    }
  }

  private clearGroup(g: THREE.Group): void {
    while (g.children.length) {
      const c = g.children[0]
      g.remove(c)
      c.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
        any.geometry?.dispose()
        if (any.material) {
          if (Array.isArray(any.material)) any.material.forEach((m) => m.dispose())
          else any.material.dispose()
        }
      })
    }
  }

  private burst(p: { x: number; y: number; z: number }, n: number): void {
    const now = performance.now() / 1000
    const r = this.f.dist * 0.04
    for (let i = 0; i < n; i++) {
      this.trail.push({
        x: p.x + (Math.random() - 0.5) * r,
        y: p.y + (Math.random() - 0.5) * r,
        z: p.z + (Math.random() - 0.5) * r,
        t: now
      })
    }
  }

  // ------------------------------------------------------------------ frame
  frame(dt: number, t: number): void {
    const stage = this.state.stage
    if (this.state.input.source !== 'mouse') this.applyHand()

    // KHÔNG xoay bgGroup. Trường sao rộng ±62 đơn vị mà xoay quanh Z thì sau ~3
    // phút hai đầu bị nâng quá nửa chiều cao khung (6.5) và trôi hẳn ra ngoài —
    // đó là lý do nền không phủ liền. Chuyển động đã có sẵn từ camera drift.

    // Trường sao hiện ở MỌI chiều, kể cả 0D — đúng như file gốc (bgGroup không
    // bao giờ bị ẩn hay làm mờ theo stage). Lý do 0D từng trông như một dải ngân
    // hà là bốn lỗi khác đã sửa: vignette, xoay nền, sizeAttenuation, và sprite
    // tinh vân to gấp 4.3 lần khung — KHÔNG phải do có sao.

    const gridMat = this.grid.material as THREE.Material & { opacity: number }
    gridMat.opacity += ((stage === 2 ? 0.14 : 0) - gridMat.opacity) * 0.05
    this.grid.visible = gridMat.opacity > 0.004

    const polarMat = this.polar.material as THREE.Material & { opacity: number }
    polarMat.opacity += ((stage === 3 || stage === 4 ? 0.16 : 0) - polarMat.opacity) * 0.05
    this.polar.visible = polarMat.opacity > 0.004

    for (const tw of this.twinkles) tw.mat.opacity = 0.55 + Math.sin(t * 2.6 + tw.phase) * 0.35
    for (const pu of this.pulses) pu.mat.emissiveIntensity = 0.5 + Math.sin(t * 1.6 + pu.phase) * 0.32

    // Camera: đung đưa có biên. Quay tròn 360° như bản gốc sẽ cho khán giả nhìn
    // trường rộng 125 đơn vị theo cạnh — trên tường chỉ còn một vệt.
    const { dist, halfW } = this.f
    if (stage === 3 || stage === 4) {
      this.orbitPhase += dt * 0.12
      const a = Math.sin(this.orbitPhase) * 0.1
      this.camera.position.lerp(
        new THREE.Vector3(Math.sin(a) * dist, Math.sin(this.orbitPhase * 0.62) * HALF_H * 0.42, Math.cos(a) * dist),
        0.04
      )
    } else {
      this.orbitPhase = 0
      this.camera.position.lerp(
        new THREE.Vector3(Math.sin(t * 0.1) * halfW * 0.012, Math.cos(t * 0.13) * HALF_H * 0.05, dist),
        0.06
      )
    }
    this.camera.lookAt(0, 0, 0)

    const is0 = stage === 0
    this.centerHalo.visible = is0
    this.centerCore.visible = is0
    if (is0) {
      const pulse = 1 + Math.sin(t * 2.4) * 0.18
      this.centerHalo.scale.setScalar(3.2 * pulse)
      this.centerCore.scale.setScalar(0.9 * (1 + Math.sin(t * 2.4 + 0.6) * 0.1))
    }

    this.stackGroup.visible = stage === 5
    if (stage === 5) {
      if (!this.palmPrev) this.stackYaw += Math.sin(t * 0.16) * dt * 0.06 // thở nhẹ khi không ai chạm
      this.stackGroup.rotation.y += (this.stackYaw - this.stackGroup.rotation.y) * 0.06
      this.stackGroup.rotation.x += (this.stackPitch - this.stackGroup.rotation.x) * 0.06
    }

    if (this.pointerTarget) {
      // Làm mượt THẬT nằm ở bộ lọc One Euro trong tracker, nơi biết dấu thời gian
      // của từng frame camera. Ở đây chỉ nội suy 30Hz (camera) lên 60Hz (màn hình)
      // cho đỡ giật bậc thang — nên hệ số cố định và cao, không lấy theo slider
      // "mượt" nữa (lerp chồng lên lọc chỉ tổ thêm trễ).
      this.pointer.lerp(this.pointerTarget, 0.65)
      this.cursor.position.copy(this.pointer)
    }
    this.cursor.visible = this.cursorActive && !!this.pointerTarget
    if (this.cursor.visible) {
      const m = this.cursor.material as THREE.SpriteMaterial
      m.opacity = this.drawing ? 1.0 : 0.35
      this.cursor.scale.setScalar(this.drawing ? 0.85 : 0.55)
    }

    if (this.drawing && this.pointerTarget) this.extendStroke(this.pointer)

    if (this.drawing && stage !== 0 && this.strokePts.length > 1) {
      const pts = stage === 1 ? [this.strokePts[0], this.strokePts[this.strokePts.length - 1]] : this.strokePts
      this.setLive(pts)
    } else {
      this.setLive([])
    }

    // Vệt sáng tan dần. Đây mới là phản hồi live mà người vẽ nhìn thấy từ xa:
    // liveLine chỉ dày đúng 1px vì WebGL không hỗ trợ linewidth, trên tường 10m
    // coi như vô hình. Nên cho hạt vệt nở theo cùng hệ số dày nét.
    ;(this.trailPoints.material as THREE.PointsMaterial).size = this.sw(0.42) * this.f.ptK
    const life = stage === 0 ? 0.45 : 0.6
    this.trail = this.trail.filter((p) => t - p.t < life)
    const n = Math.min(this.trail.length, MAX_TRAIL)
    const posAttr = this.trailGeo.getAttribute('position') as THREE.BufferAttribute
    const colAttr = this.trailGeo.getAttribute('color') as THREE.BufferAttribute
    const pos = posAttr.array as Float32Array
    const col = colAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      const p = this.trail[i]
      const a = Math.max(0, 1 - (t - p.t) / life)
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
      col[i * 3] = 0.78 * a; col[i * 3 + 1] = 0.62 * a; col[i * 3 + 2] = 1.0 * a
    }
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
    this.trailGeo.setDrawRange(0, n)

    for (const e of this.echoes) {
      const k = Math.min(1, Math.max(0, (t - e.born) / 0.6))
      const ease = 1 - Math.pow(1 - k, 3)
      e.mesh.scale.setScalar(Math.max(0.001, ease * e.target))
      e.mesh.rotation.y += dt * 0.15
    }

    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  noteFor(y: number): number {
    const idx = Math.max(0, Math.min(5, Math.round(((y + HALF_H) / (HALF_H * 2)) * 5)))
    return NOTES[idx]
  }
}
