// ============================================================================
// Scene SÀN 3840×2160 — nền theo chiều, KHÔNG bám cử chỉ.
//
// VÌ SAO SÀN LÀM VIỆC KHÁC TƯỜNG: tường trả lời "tôi vừa vẽ gì", sàn trả lời
// "tôi đang đứng trong chiều nào". Nếu sàn cũng chiếu nét vẽ thì thành hai màn
// hình kể một chuyện, mà người xem chỉ nhìn được một chỗ tại một thời điểm.
//
// VÌ SAO DÙNG MỘT SHADER TOÀN MÀN HÌNH, KHÔNG DÙNG HÌNH HỌC:
//   - Sàn là 8.3 triệu pixel, cộng với tường 11.2 triệu là 19.5 triệu mỗi frame.
//     Dựng lưới bằng geometry (hàng nghìn đoạn thẳng) tốn vô ích; shader chỉ có
//     đúng một hình chữ nhật và vài phép toán mỗi pixel.
//   - Đường kẻ vẽ bằng fwidth nên nét luôn mảnh đều 1px thật, không răng cưa,
//     bất kể lưới thưa hay dày.
//
// NGƯỜI SẼ ĐỨNG LÊN SÀN và che mất phần giữa, nên nội dung phải đọc được ở dạng
// MẢNG LỚN — lưới, vòng, dải sáng — không phải nét mảnh hay chữ.
// ============================================================================
import * as THREE from 'three'
import { AppState } from '../../shared/types'

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uStage;   // 0..5, đã nội suy nên chuyển chiều là tan chứ không nhảy
  uniform float uAspect;
  uniform float uRot;     // radian — máy chiếu sàn gắn hướng nào cũng xoay theo được
  uniform float uBright;

  const vec3 VIOLET = vec3(0.545, 0.361, 0.965);
  const vec3 PALE   = vec3(0.769, 0.710, 0.992);
  const vec3 WARM   = vec3(0.914, 0.835, 1.0);

  // Đường kẻ dày đúng 1 pixel thật nhờ fwidth, không phụ thuộc mật độ lưới.
  float lineGrid(vec2 p, float cell, float w) {
    vec2 q = p / cell;
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), 1e-5);
    return 1.0 - smoothstep(0.0, w, min(g.x, g.y));
  }

  float ring(float r, float period, float w) {
    float q = r / period;
    float g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), 1e-5);
    return 1.0 - smoothstep(0.0, w, g);
  }

  // Một chiều = một lớp. Trả về màu đã nhân cường độ.
  vec3 layer(int st, vec2 p, float t) {
    float r = length(p);

    // 0D — một điểm. Không có không gian nào để đứng.
    if (st == 0) {
      float core = exp(-r * r * 900.0);
      float halo = exp(-r * r * 40.0) * 0.28;
      return WARM * core + VIOLET * halo * (0.85 + 0.15 * sin(t * 2.4));
    }
    // 1D — đúng MỘT đường. Chỉ có một chiều để đi.
    if (st == 1) {
      float line = exp(-abs(p.y) * 260.0) + exp(-abs(p.y) * 26.0) * 0.16;
      float pulse = 0.8 + 0.2 * sin(t * 1.1 - p.x * 2.0);
      return PALE * line * pulse;
    }
    // 2D — mặt phẳng. Sàn CHÍNH LÀ flatland mà tường đang nói tới.
    if (st == 2) {
      float g = lineGrid(p, 0.11, 1.4) * 0.5 + lineGrid(p, 0.55, 1.6) * 0.5;
      return VIOLET * g * (0.75 + 0.25 * sin(t * 0.6));
    }
    // 3D — mặt phẳng có bề dày: lưới cộng vòng đồng tâm gợi khối.
    if (st == 3) {
      float g = lineGrid(p, 0.14, 1.3) * 0.42;
      float rings = ring(r, 0.16, 1.5) * exp(-r * 0.7) * 0.75;
      return VIOLET * g + PALE * rings;
    }
    // 4D — thời gian: vòng sóng toả ra liên tục, quá khứ chồng lên hiện tại.
    if (st == 4) {
      float g = lineGrid(p, 0.14, 1.3) * 0.3;
      float e = 0.0;
      for (int i = 0; i < 3; i++) {
        float ph = fract(t * 0.22 + float(i) * 0.333);
        e += smoothstep(0.05, 0.0, abs(r - ph * 1.5)) * (1.0 - ph);
      }
      return VIOLET * g + PALE * e * 0.8;
    }
    // 5D — mọi lớp cùng tồn tại: ba lưới lệch góc chồng lên nhau.
    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
      float a = float(i) * 1.0472 + t * 0.035;      // 60° lệch nhau, xoay rất chậm
      vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
      acc += lineGrid(q, 0.13 + float(i) * 0.05, 1.3) * (0.34 - float(i) * 0.06);
    }
    return mix(VIOLET, PALE, 0.35) * acc;
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= uAspect;                                  // ô lưới luôn vuông
    float c = cos(uRot), s = sin(uRot);
    p = mat2(c, -s, s, c) * p;

    // Nội suy giữa hai chiều liền kề → đổi chiều là TAN vào nhau, không nhảy giật.
    float f = clamp(uStage, 0.0, 5.0);
    int a = int(floor(f));
    int b = int(min(floor(f) + 1.0, 5.0));
    float k = fract(f);
    vec3 col = mix(layer(a, p, uTime), layer(b, p, uTime), k);

    // Tối dần ra rìa: mép sàn là chỗ máy chiếu yếu nhất và cũng là chỗ ít ai đứng.
    col *= 1.0 - 0.35 * smoothstep(0.55, 1.25, length(p));
    gl_FragColor = vec4(col * uBright, 1.0);
  }
`

export class FloorScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private mat: THREE.ShaderMaterial
  private canvas: HTMLCanvasElement
  private state: AppState
  private stageMix = 0

  constructor(canvas: HTMLCanvasElement, state: AppState) {
    this.canvas = canvas
    this.state = state
    this.stageMix = state.stage
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uStage: { value: state.stage },
        uAspect: { value: 1 },
        uRot: { value: 0 },
        uBright: { value: state.floor.brightness / 100 }
      },
      depthTest: false,
      depthWrite: false
    })
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat))
    this.resize()
  }

  setState(s: AppState): void {
    this.state = s
    this.mat.uniforms.uRot.value = (s.floor.rotation * Math.PI) / 180
    this.mat.uniforms.uBright.value = s.floor.brightness / 100
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth)
    const h = Math.max(1, this.canvas.clientHeight)
    // Kẹp như bên tường: vượt 16384px một chiều là Chromium bỏ shared texture và
    // Spout im lặng mất tín hiệu.
    const pr = Math.min(window.devicePixelRatio || 1, 2, 16384 / w, 16384 / h)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this.mat.uniforms.uAspect.value = w / h
  }

  frame(dt: number, t: number): void {
    // Chuyển chiều mượt: chạy dần tới chiều đích thay vì nhảy cái rụp.
    const target = this.state.stage
    const k = 1 - Math.pow(0.06, Math.min(3, dt * 60) / 60)
    this.stageMix += (target - this.stageMix) * Math.min(1, k * 60 * dt + 0.02)
    if (Math.abs(target - this.stageMix) < 0.002) this.stageMix = target
    this.mat.uniforms.uStage.value = this.stageMix
    this.mat.uniforms.uTime.value = t
    this.renderer.render(this.scene, this.camera)
  }
}
