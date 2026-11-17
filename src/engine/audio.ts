export class Sfx {
  ctx: AudioContext | null = null;
  muted = false;
  master: GainNode | null = null;
  noise: AudioBuffer | null = null;
  hum: GainNode | null = null;
  humOsc: [OscillatorNode, OscillatorNode] | null = null;
  humLp: BiquadFilterNode | null = null;
  whir: GainNode | null = null;
  whirBp: BiquadFilterNode | null = null;
  air: GainNode | null = null;
  airBp: BiquadFilterNode | null = null;
  servo: GainNode | null = null;
  servoOsc: OscillatorNode | null = null;
  zoom: GainNode | null = null;
  zoomOsc: [OscillatorNode, OscillatorNode] | null = null;
  zoomAir: GainNode | null = null;
  zoomBp: BiquadFilterNode | null = null;
  slide: GainNode | null = null;
  slidePan: StereoPannerNode | null = null;
  private _onVis: (() => void) | null = null;

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.42;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    this.humOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.humOsc[0].frequency.value = 55;
    this.humOsc[1].type = 'triangle';
    this.humOsc[1].frequency.value = 110.6;
    this.humOsc.forEach((o) => {
      o.connect(lp);
      o.start();
    });
    lp.connect(this.hum).connect(this.master);
    this.humLp = lp;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 2.5;
    this.whir = ctx.createGain();
    this.whir.gain.value = 0;
    src.connect(bp).connect(this.whir).connect(this.master);
    src.start();
    this.whirBp = bp;

    this.initMotion(ctx, buf);

    this._onVis = () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  initMotion(ctx: AudioContext, buf: AudioBuffer): void {
    if (!this.master) return;
    const loop = (offset: number) => {
      const n = ctx.createBufferSource();
      n.buffer = buf;
      n.loop = true;
      n.start(0, offset);
      return n;
    };
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const silent = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };

    this.air = silent();
    this.airBp = filter('bandpass', 400, 0.8);
    loop(0.31).connect(this.airBp).connect(this.air).connect(this.master);

    this.servo = silent();
    this.servoOsc = ctx.createOscillator();
    this.servoOsc.type = 'sawtooth';
    this.servoOsc.frequency.value = 70;
    this.servoOsc.connect(filter('lowpass', 520, 0.7)).connect(this.servo).connect(this.master);
    this.servoOsc.start();

    this.zoom = silent();
    const zLp = filter('lowpass', 1800, 0.7);
    zLp.connect(this.zoom).connect(this.master);
    this.zoomOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.zoomOsc[1].type = 'triangle';
    const fifth = ctx.createGain();
    fifth.gain.value = 0.35;
    this.zoomOsc[0].connect(zLp);
    this.zoomOsc[1].connect(fifth).connect(zLp);
    for (const o of this.zoomOsc) o.start();
    this.zoomAir = silent();
    this.zoomBp = filter('bandpass', 2000, 4);
    loop(0.77).connect(this.zoomBp).connect(this.zoomAir).connect(this.master);

    this.slide = silent();
    const slideOut = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.slidePan = slideOut;
    loop(1.13).connect(filter('highpass', 1200, 0.7)).connect(filter('lowpass', 6000, 0.7)).connect(this.slide);
    if (slideOut) this.slide.connect(slideOut).connect(this.master);
    else this.slide.connect(this.master);
  }

  motion(turn: number, zoomRate: number, scale: number, slide: number, pan: number): void {
    if (!this.ctx || !this.air || !this.airBp || !this.servo || !this.servoOsc || !this.zoom || !this.zoomOsc || !this.zoomAir || !this.zoomBp || !this.slide) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, turn / 5);
    this.air.gain.setTargetAtTime(0.2 * Math.pow(s, 0.9), t, 0.05);
    this.airBp.frequency.setTargetAtTime(400 + 2100 * s, t, 0.06);
    this.servo.gain.setTargetAtTime(0.03 * s, t, 0.06);
    this.servoOsc.frequency.setTargetAtTime(70 + 120 * s, t, 0.08);
    const z = Math.min(1, Math.abs(zoomRate) / 1.5);
    const f = 260 * Math.pow(Math.max(0.1, scale), 0.6);
    this.zoom.gain.setTargetAtTime(0.045 * z, t, 0.05);
    this.zoomOsc[0].frequency.setTargetAtTime(f, t, 0.05);
    this.zoomOsc[1].frequency.setTargetAtTime(f * 1.5, t, 0.05);
    this.zoomAir.gain.setTargetAtTime(0.12 * z, t, 0.05);
    this.zoomBp.frequency.setTargetAtTime(f * 8, t, 0.05);
    const m = Math.min(1, slide / 2);
    this.slide.gain.setTargetAtTime(0.16 * m, t, 0.05);
    if (this.slidePan) this.slidePan.pan.setTargetAtTime(Math.max(-0.7, Math.min(0.7, pan)), t, 0.08);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.42, this.ctx.currentTime, 0.05);
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  env(node: GainNode, t0: number, a: number, peak: number, dur: number): void {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, 0.006, peak, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noiseBurst(type: BiquadFilterType, f0: number, f1: number, q: number, dur: number, peak: number, delay = 0): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, Math.min(0.03, dur * 0.25), peak, dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  grab(): void {
    this.tone('sine', 190, 120, 0.09, 0.22);
    this.noiseBurst('bandpass', 5200, 3800, 6, 0.035, 0.12);
  }

  catch(): void {
    this.tone('sine', 240, 140, 0.08, 0.22);
    this.noiseBurst('bandpass', 6000, 4000, 6, 0.03, 0.12);
    this.noiseBurst('bandpass', 5000, 3500, 6, 0.03, 0.1, 0.06);
  }

  release(speed: number): void {
    const s = Math.min(1, speed / 6);
    if (s < 0.03) {
      this.tone('sine', 150, 110, 0.06, 0.1);
      return;
    }
    this.noiseBurst('bandpass', 700 + 1800 * s, 260, 1.4, 0.25 + 0.35 * s, 0.12 + 0.25 * s);
  }

  mode(): void {
    this.tone('sine', 420, 980, 0.22, 0.08);
    this.noiseBurst('bandpass', 2600, 500, 3, 0.9, 0.05);
  }

  explode(out: boolean): void {
    this.tone('sawtooth', out ? 70 : 140, out ? 150 : 65, 0.42, 0.05);
    this.noiseBurst('lowpass', out ? 600 : 1400, out ? 1800 : 400, 0.8, 0.45, 0.07);
  }

  boot(): void {
    this.tone('sine', 90, 360, 1.1, 0.07);
    this.noiseBurst('bandpass', 400, 3200, 2, 1.3, 0.04);
  }

  stretch(amount: number, rate: number): void {
    if (!this.ctx || !this.whir || !this.whirBp) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.abs(rate) / 2.5);
    this.whir.gain.setTargetAtTime(s * 0.09, t, 0.05);
    this.whirBp.frequency.setTargetAtTime(260 + 900 * Math.min(1, Math.max(0, amount)), t, 0.06);
  }

  spin(speed: number): void {
    if (!this.ctx || !this.hum || !this.humOsc || !this.humLp) return;
    const s = Math.min(1, speed / 7);
    const t = this.ctx.currentTime;
    this.hum.gain.setTargetAtTime(s * 0.08, t, 0.08);
    this.humOsc[0].frequency.setTargetAtTime(50 + 40 * s, t, 0.1);
    this.humOsc[1].frequency.setTargetAtTime(100 + 80 * s, t, 0.1);
    this.humLp.frequency.setTargetAtTime(300 + 900 * s, t, 0.1);
  }

  dispose(): void {
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
