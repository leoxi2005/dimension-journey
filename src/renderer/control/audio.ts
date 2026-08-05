// ============================================================================
// Âm thanh — nền vũ trụ + chuông + tiếng cọ theo tốc độ tay. Port từ prototype.
//
// CHẠY Ở CỬA SỔ CONTROL, không phải cửa sổ chiếu. Lý do: Spout/NDI mở thêm 1-2
// cửa sổ offscreen chạy CÙNG renderer tường; để tiếng ở đó thì mỗi nốt phát 2-3
// lần chồng lên nhau. Control luôn chỉ có đúng một bản.
// ============================================================================
const NOTES = [220.0, 246.94, 277.18, 329.63, 369.99, 440.0]

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private send: GainNode | null = null
  private drawGain: GainNode | null = null
  private brushFil: BiquadFilterNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private twinkleTimer: number | null = null
  private on = true
  private drawAcc = 0

  get ready(): boolean {
    return !!this.ctx
  }

  /** Phải gọi từ trong một cử chỉ người dùng (autoplay policy). */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = (this.ctx = new AC())
    const master = (this.master = ctx.createGain())
    master.gain.value = this.on ? 0.7 : 0
    master.connect(ctx.destination)

    // Reverb bằng IR tự sinh + echo — không cần file mẫu kèm theo app.
    const conv = ctx.createConvolver()
    const rlen = Math.floor(ctx.sampleRate * 3.2)
    const ir = ctx.createBuffer(2, rlen, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch)
      for (let i = 0; i < rlen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rlen, 2.4)
    }
    conv.buffer = ir
    const rg = ctx.createGain(); rg.gain.value = 0.55
    conv.connect(rg); rg.connect(master)

    const delay = ctx.createDelay(1.2); delay.delayTime.value = 0.42
    const fb = ctx.createGain(); fb.gain.value = 0.34
    const wet = ctx.createGain(); wet.gain.value = 0.26
    delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master); wet.connect(conv)

    const fxIn = ctx.createGain()
    fxIn.connect(delay); fxIn.connect(conv)
    this.send = fxIn

    // Pad nền
    const padGain = ctx.createGain(); padGain.gain.value = 0
    const padFil = ctx.createBiquadFilter(); padFil.type = 'lowpass'; padFil.frequency.value = 380; padFil.Q.value = 0.7
    padGain.connect(padFil); padFil.connect(master)
    ;([[55, 'sine', 0.5], [82.41, 'sine', 0.32], [110, 'triangle', 0.16], [164.81, 'triangle', 0.09]] as [number, OscillatorType, number][])
      .forEach(([f, type, g]) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 7
        const gn = ctx.createGain(); gn.gain.value = g
        o.connect(gn); gn.connect(padGain); o.start()
      })
    padGain.gain.linearRampToValueAtTime(0.055, ctx.currentTime + 4)
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06
    const lg = ctx.createGain(); lg.gain.value = 150
    lfo.connect(lg); lg.connect(padFil.frequency); lfo.start()

    // Nhiễu cho whoosh + tiếng cọ
    const len = Math.floor(ctx.sampleRate * 2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuf = buf

    const brush = ctx.createBufferSource(); brush.buffer = buf; brush.loop = true
    this.brushFil = ctx.createBiquadFilter(); this.brushFil.type = 'bandpass'; this.brushFil.frequency.value = 900; this.brushFil.Q.value = 0.7
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320
    this.drawGain = ctx.createGain(); this.drawGain.gain.value = 0
    brush.connect(this.brushFil); this.brushFil.connect(hp); hp.connect(this.drawGain)
    this.drawGain.connect(master)
    const ds = ctx.createGain(); ds.gain.value = 0.45
    this.drawGain.connect(ds); ds.connect(this.send)
    brush.start()

    this.twinkleTimer = window.setInterval(() => {
      if (this.on && Math.random() < 0.85) {
        this.bell(NOTES[(Math.random() * 6) | 0] * 4, { vol: 0.016 + Math.random() * 0.018, dur: 3.5, ratio: 2.4 })
      }
    }, 5200)
  }

  setEnabled(on: boolean): void {
    this.on = on
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.04)
  }

  /** Cọ theo tốc độ tay — im lặng khi tay đứng yên, nên không bao giờ ù. */
  updateDraw(drawing: boolean, speed: number, heightNorm: number): void {
    if (!this.ctx || !this.drawGain || !this.brushFil) return
    const t = this.ctx.currentTime
    if (!drawing) {
      this.drawGain.gain.setTargetAtTime(0, t, 0.08)
      this.drawAcc = 0
      return
    }
    const s = Math.min(1, speed)
    this.drawGain.gain.setTargetAtTime(0.004 + s * 0.05, t, 0.07)
    this.brushFil.frequency.setTargetAtTime(520 + heightNorm * 1500 + s * 800, t, 0.05)
    this.drawAcc += speed
    if (this.drawAcc > 1.5) {
      this.drawAcc = 0
      this.pluck(NOTES[Math.max(0, Math.min(5, Math.round(heightNorm * 5)))] * 2, 0.028)
    }
  }

  strokeEnd(heightNorm: number, stage: number): void {
    if (stage === 0) {
      this.ping(NOTES[0] * 2, { vol: 0.05, dur: 0.45, glide: NOTES[0] })
      return
    }
    this.bell(NOTES[Math.max(0, Math.min(5, Math.round(heightNorm * 5)))] * 2, { vol: 0.1, dur: 1.6 })
    if (stage === 4) {
      for (let i = 0; i < 4; i++) this.bell(NOTES[(i * 2) % 6] * 2, { when: 0.25 + i * 0.3, vol: 0.045, dur: 1.4 })
    }
  }

  layerAdded(): void {
    this.bell(110, { vol: 0.15, dur: 2.6, ratio: 1.5 })
    this.bell(220, { when: 0.1, vol: 0.09, dur: 2.4 })
    this.bell(440, { when: 0.22, vol: 0.05, dur: 2.2 })
  }

  stageChanged(i: number): void {
    this.whoosh(0.13)
    this.bell(NOTES[i], { vol: 0.13, dur: 2.4 })
    this.bell(NOTES[i] * 2, { when: 0.16, vol: 0.08, dur: 2.6 })
    this.bell(NOTES[i] * 3, { when: 0.32, vol: 0.05, dur: 2.8 })
  }

  // ------------------------------------------------------------- nguyên âm
  private bell(freq: number, o: { when?: number; vol?: number; dur?: number; ratio?: number } = {}): void {
    if (!this.ctx || !this.on || !this.master || !this.send) return
    const ctx = this.ctx
    const t = ctx.currentTime + (o.when || 0)
    const dur = o.dur || 1.8
    const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = freq
    const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = freq * (o.ratio || 2.01)
    const mg = ctx.createGain()
    mg.gain.setValueAtTime(freq * 1.4, t)
    mg.gain.exponentialRampToValueAtTime(Math.max(0.01, freq * 0.01), t + dur * 0.8)
    mod.connect(mg); mg.connect(car.frequency)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(o.vol || 0.12, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0003, t + dur)
    car.connect(g); g.connect(this.master)
    const s = ctx.createGain(); s.gain.value = 0.85
    g.connect(s); s.connect(this.send)
    car.start(t); mod.start(t)
    car.stop(t + dur + 0.1); mod.stop(t + dur + 0.1)
  }

  private ping(freq: number, o: { when?: number; vol?: number; dur?: number; glide?: number } = {}): void {
    if (!this.ctx || !this.on || !this.master || !this.send) return
    const ctx = this.ctx
    const t = ctx.currentTime + (o.when || 0)
    const dur = o.dur || 0.8
    const osc = ctx.createOscillator(); osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t)
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(o.vol || 0.14, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur)
    osc.connect(g); g.connect(this.master)
    const s = ctx.createGain(); s.gain.value = 0.6
    g.connect(s); s.connect(this.send)
    osc.start(t); osc.stop(t + dur + 0.1)
  }

  private whoosh(vol: number): void {
    if (!this.ctx || !this.on || !this.noiseBuf || !this.master || !this.send) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1
    f.frequency.setValueAtTime(160, t)
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.7)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.12)
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.9)
    src.connect(f); f.connect(g); g.connect(this.master)
    const s = ctx.createGain(); s.gain.value = 0.5
    g.connect(s); s.connect(this.send)
    src.start(t); src.stop(t + 1.0)
  }

  private pluck(freq: number, vol: number): void {
    if (!this.ctx || !this.on || !this.master || !this.send) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2.01
    const o2g = ctx.createGain(); o2g.gain.value = 0.35; o2.connect(o2g)
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'
    f.frequency.setValueAtTime(2600, t)
    f.frequency.exponentialRampToValueAtTime(700, t + 0.4)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0003, t + 0.5)
    o.connect(f); o2g.connect(f); f.connect(g); g.connect(this.master)
    const s = ctx.createGain(); s.gain.value = 0.5
    g.connect(s); s.connect(this.send)
    o.start(t); o2.start(t); o.stop(t + 0.55); o2.stop(t + 0.55)
  }

  dispose(): void {
    if (this.twinkleTimer) clearInterval(this.twinkleTimer)
    try { void this.ctx?.close() } catch { /* đã đóng */ }
  }
}
