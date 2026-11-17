import * as THREE from 'three';
import { damp, integrateQuat, quatPow, quatToRotVec, rotVecToQuat } from './filters';

export const controlTuning = {
  gain: 1.35,
  holdWn: 50,
  pointerWn: 90,
  spinTau: 6.0,
  catchTau: 0.1,
  maxSpin: 12.0,
  minSpin: 0.45,
  glideTau: 0.09,
  stopSpin: 0.015,
  rampIn: 0.12,
  zoomExp: 1.2,
  scaleMin: 0.3,
  scaleMax: 3.0,
  scaleTau: 0.04,
  posTau: 0.04,
  settleTau: 0.07,
  bounds: 0.7,
  margin: 0.03,
  boundsTau: 0.14,
};

const AXES = ['x', 'y'] as const;
type Axis = (typeof AXES)[number];
const Z = new THREE.Vector3(0, 0, 1);

export interface Bounds2D {
  x: number;
  y: number;
}

export interface FitRange {
  x: [number, number];
  y: [number, number];
  big: { x: boolean; y: boolean };
}

export interface TrailEntry {
  t: number;
  q: THREE.Quaternion;
  pos: THREE.Vector3;
  scale: number;
}

export interface ResetState {
  t: number;
  dur: number;
  gentle: boolean;
  q0: THREE.Quaternion;
  s0: number;
  p0: THREE.Vector3;
}

export class ModelControl {
  home: { q: THREE.Quaternion; scale: number; pos: THREE.Vector3 };
  q: THREE.Quaternion;
  omega = new THREE.Vector3();
  held = false;
  anchorHand = new THREE.Quaternion();
  anchorModel = new THREE.Quaternion();
  handQ = new THREE.Quaternion();
  handT = 0;
  heldGain = 1;
  wn = controlTuning.holdWn;
  glide = false;
  limbo = false;
  catchW = new THREE.Vector3();
  ramp = 1;
  scale = 1;
  scaleTarget = 1;
  pos = new THREE.Vector3();
  posTarget = new THREE.Vector3();
  reset: ResetState | null = null;
  caught = false;
  now = 0;
  trail: TrailEntry[] = [];
  grabT = -Infinity;
  settleQ: THREE.Quaternion | null = null;
  bounds: Bounds2D | null = null;
  fit: FitRange | null = null;
  dragging = false;
  dragRaw = new THREE.Vector3();
  shownW = new THREE.Vector3();

  constructor(homeQuat: THREE.Quaternion) {
    this.home = { q: homeQuat.clone(), scale: 1, pos: new THREE.Vector3() };
    this.q = homeQuat.clone();
  }

  get spinSpeed(): number {
    return this.omega.length();
  }

  grab(handQ: THREE.Quaternion, t: number, gain = controlTuning.gain, opts: { wn?: number; resume?: boolean } = {}): boolean {
    const spinning = this.omega.length();
    this.caught = !opts.resume && spinning > 0.3;
    this.catchW.copy(this.caught ? this.omega : ZERO);
    this.shownW.copy(this.omega);
    this.omega.set(0, 0, 0);
    this.glide = false;
    this.limbo = false;
    this.held = true;
    this.heldGain = gain;
    this.wn = opts.wn ?? controlTuning.holdWn;
    this.anchorHand.copy(handQ);
    this.anchorModel.copy(this.settleQ ?? this.q);
    if (this.settleQ) this.shownW.set(0, 0, 0);
    this.settleQ = null;
    this.handQ.copy(handQ);
    this.handT = t;
    this.ramp = opts.resume ? 1 : 0;
    this.reset = null;
    this.grabT = t;
    this.trail.length = 0;
    this.record(t, this.anchorModel);
    return this.caught;
  }

  record(t: number, q: THREE.Quaternion): void {
    this.trail.push({ t, q: q.clone(), pos: this.posTarget.clone(), scale: this.scaleTarget });
    while (this.trail.length > 2 && t - this.trail[0].t > 0.8) this.trail.shift();
  }

  heldDelta(handQ: THREE.Quaternion, out = new THREE.Quaternion()): THREE.Quaternion {
    const delta = _hd.copy(handQ).multiply(_hi.copy(this.anchorHand).invert());
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    return quatPow(delta, this.heldGain * easeOut(this.ramp), out);
  }

  heldTarget(handQ: THREE.Quaternion): THREE.Quaternion {
    return this.heldDelta(handQ).multiply(this.anchorModel);
  }

  rebase(handQ: THREE.Quaternion): void {
    if (!this.held) return;
    this.anchorModel.copy(this.heldTarget(this.handQ));
    this.anchorHand.copy(handQ);
    this.handQ.copy(handQ);
  }

  drive(handQ: THREE.Quaternion, t: number): void {
    if (!this.held) return;
    this.handQ.copy(handQ);
    this.handT = t;
    this.record(t, this.heldTarget(handQ));
  }

  rollback(tc: number): boolean {
    const T = Math.max(tc, this.grabT);
    let s = this.trail[0];
    if (!s) return false;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      if (this.trail[i].t <= T + 1e-6) {
        s = this.trail[i];
        break;
      }
    }
    this.settleQ = s.q.clone();
    this.posTarget.copy(s.pos);
    this.scaleTarget = s.scale;
    if (this.dragging) this.dragRaw.copy(s.pos);
    return true;
  }

  release(w: THREE.Vector3 | null = null): number {
    if (!this.held) return 0;
    this.limbo = false;
    if (!w) {
      this.held = false;
      this.catchW.set(0, 0, 0);
      this.settleQ = null;
      this.omega.set(0, 0, 0);
      this.glide = false;
      return 0;
    }
    return this.letFly(w.clone().multiplyScalar(this.heldGain));
  }

  coast(opts: { limbo?: boolean } = {}): number {
    if (!this.held) return 0;
    const speed = this.letFly(this.shownW.clone());
    this.limbo = !!opts.limbo;
    return speed;
  }

  letFly(om: THREE.Vector3): number {
    this.held = false;
    this.catchW.set(0, 0, 0);
    this.settleQ = null;
    const s = om.length();
    if (s > controlTuning.maxSpin) om.multiplyScalar(controlTuning.maxSpin / s);
    this.glide = om.length() < controlTuning.minSpin;
    this.omega.copy(om);
    return this.glide ? 0 : this.omega.length();
  }

  settleTwo(): void {
    this.scaleTarget = this.scale + (this.scaleTarget - this.scale) * 0.35;
    this.posTarget.lerpVectors(this.pos, this.posTarget, 0.35);
    this.dragRaw.copy(this.posTarget);
  }

  setTwoHand(scale: number, pos: THREE.Vector3): void {
    this.scaleTarget = THREE.MathUtils.clamp(scale, controlTuning.scaleMin, controlTuning.scaleMax);
    this.dragRaw.copy(pos);
    this.rubberBand(pos, this.posTarget);
  }

  zoomBy(f: number): void {
    this.scaleTarget = THREE.MathUtils.clamp(this.scaleTarget * f, controlTuning.scaleMin, controlTuning.scaleMax);
  }

  beginDrag(): void {
    this.dragging = true;
    this.dragRaw.copy(this.posTarget);
  }

  endDrag(): void {
    this.dragging = false;
  }

  panBy(v: THREE.Vector3): void {
    if (!this.dragging) this.beginDrag();
    this.dragRaw.add(v);
    this.rubberBand(this.dragRaw, this.posTarget);
  }

  rubberBand(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(p);
    if (!this.bounds) return out;
    for (const ax of AXES) {
      const [lo, hi] = this.moveRange(ax);
      const R = 0.15 * (hi - lo);
      const v = p[ax];
      if (v > hi) out[ax] = hi + R * (1 - Math.exp(-(v - hi) / R));
      else if (v < lo) out[ax] = lo - R * (1 - Math.exp(-(lo - v) / R));
    }
    return out;
  }

  moveRange(ax: Axis): [number, number] {
    const b = this.bounds![ax];
    const f = this.fit?.[ax];
    return f && !this.fit!.big[ax] ? [Math.min(-b, f[0]), Math.max(b, f[1])] : [-b, b];
  }

  restRange(ax: Axis): [number, number] {
    const b = this.bounds![ax];
    const f = this.fit?.[ax];
    if (!f) return [-b, b];
    const lo = Math.min(0, f[0]);
    const hi = Math.max(0, f[1]);
    return this.fit!.big[ax] ? [Math.max(-b, lo), Math.min(b, hi)] : [lo, hi];
  }

  stop(): void {
    this.omega.set(0, 0, 0);
    this.glide = false;
    this.limbo = false;
  }

  frame(): void {
    if (this.reset) return;
    this.posTarget.set(0, 0, 0);
    this.scaleTarget = THREE.MathUtils.clamp(this.scaleTarget, 0.7, 1.0);
  }

  goHome(dur = 0.8, gentle = false): void {
    this.held = false;
    this.dragging = false;
    this.settleQ = null;
    this.omega.set(0, 0, 0);
    this.glide = false;
    this.limbo = false;
    this.reset = { t: 0, dur, gentle, q0: this.q.clone(), s0: this.scaleTarget, p0: this.posTarget.clone() };
  }

  step(dt: number, now: number): void {
    this.now = now;
    if (this.reset) {
      const r = this.reset;
      r.t += dt / r.dur;
      const u = Math.min(1, r.t);
      const e = r.gentle ? u * u * u * (u * (u * 6 - 15) + 10) : 1 - Math.pow(1 - u, 3);
      this.q.slerpQuaternions(r.q0, this.home.q, e);
      this.scaleTarget = THREE.MathUtils.lerp(r.s0, 1, e);
      this.posTarget.lerpVectors(r.p0, this.home.pos, e);
      if (r.t >= 1) this.reset = null;
    } else if (this.held) {
      this.ramp = Math.min(1, this.ramp + dt / controlTuning.rampIn);
      if (this.catchW.lengthSq() > 1e-8) {
        const D = this.heldDelta(this.handQ, _D);
        const t0 = _t0.copy(D).multiply(this.anchorModel);
        this.shownW.sub(_wT.copy(this.catchW).applyQuaternion(D));
        integrateQuat(this.anchorModel, this.catchW, dt);
        this.catchW.multiplyScalar(Math.exp(-dt / controlTuning.catchTau));
        if (this.catchW.length() < 0.01) this.catchW.set(0, 0, 0);
        springTo(this.q, this.shownW, t0, this.wn, dt, _t1.copy(D).multiply(this.anchorModel));
        this.shownW.add(_wT.copy(this.catchW).applyQuaternion(D));
      } else {
        springTo(this.q, this.shownW, this.heldTarget(this.handQ), this.wn, dt);
      }
    } else {
      const s = this.omega.length();
      if (s > 0) {
        integrateQuat(this.q, this.omega, dt);
        this.omega.multiplyScalar(Math.exp(-dt / (this.glide ? controlTuning.glideTau : controlTuning.spinTau)));
        if (this.omega.length() < controlTuning.stopSpin) {
          this.omega.set(0, 0, 0);
          this.glide = false;
        }
      } else if (this.settleQ) {
        this.q.slerp(this.settleQ, damp(dt, controlTuning.settleTau));
        if (this.q.angleTo(this.settleQ) < 1e-3) this.settleQ = null;
      }
    }
    if (this.bounds && !this.dragging && !this.reset) {
      const k = damp(dt, controlTuning.boundsTau);
      for (const ax of AXES) {
        const [lo, hi] = this.restRange(ax);
        const v = this.posTarget[ax];
        if (v > hi) this.posTarget[ax] += (hi - v) * k;
        else if (v < lo) this.posTarget[ax] += (lo - v) * k;
      }
    }
    this.scale += (this.scaleTarget - this.scale) * damp(dt, controlTuning.scaleTau);
    this.pos.lerp(this.posTarget, damp(dt, controlTuning.posTau));
    this.q.normalize();
  }
}

const ZERO = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _e = new THREE.Vector3();
const _c = new THREE.Vector3();
const _eq = new THREE.Quaternion();
const _hd = new THREE.Quaternion();
const _hi = new THREE.Quaternion();
const _D = new THREE.Quaternion();
const _t0 = new THREE.Quaternion();
const _t1 = new THREE.Quaternion();
const _wT = new THREE.Vector3();

function springTo(
  q: THREE.Quaternion,
  w: THREE.Vector3,
  target: THREE.Quaternion,
  wn: number,
  dt: number,
  targetNext: THREE.Quaternion = target
): void {
  if (dt <= 0) return;
  _eq.copy(q).multiply(_inv.copy(target).invert());
  quatToRotVec(_eq, _e);
  const k = Math.exp(-wn * dt);
  _c.copy(w).addScaledVector(_e, wn);
  _e.addScaledVector(_c, dt).multiplyScalar(k);
  w.addScaledVector(_c, -wn * dt).multiplyScalar(k);
  q.copy(rotVecToQuat(_e, _eq)).multiply(targetNext).normalize();
}

export function rollQuat(angle: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(Z, angle);
}

function easeOut(x: number): number {
  return 1 - (1 - x) * (1 - x);
}
