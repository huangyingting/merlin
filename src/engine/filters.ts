import * as THREE from 'three';

const alpha = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  x: number | null = null;
  dx = 0;
  t: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  filter(value: number, t: number): number {
    if (this.x === null || this.t === null) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      return value;
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const dRaw = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (dRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export class OneEuroVec {
  dim: number;
  minCutoff: number;
  beta: number;
  dCutoff: number;
  x: number[] | null = null;
  prev: number[] | null = null;
  dx: number[] | null = null;
  speed = 0;
  t: number | null = null;

  constructor(dim: number, minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.dim = dim;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset(): void {
    this.x = null;
    this.prev = null;
    this.dx = null;
    this.speed = 0;
    this.t = null;
  }

  filter(v: number[], t: number): number[] {
    if (this.x === null || this.prev === null || this.dx === null || this.t === null) {
      this.x = Array.from(v);
      this.prev = Array.from(v);
      this.dx = new Array(this.dim).fill(0);
      this.speed = 0;
      this.t = t;
      return this.x.slice();
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const ad = alpha(this.dCutoff, dt);
    let s2 = 0;
    for (let i = 0; i < this.dim; i++) {
      this.dx[i] += ad * ((v[i] - this.prev[i]) / dt - this.dx[i]);
      s2 += this.dx[i] * this.dx[i];
      this.prev[i] = v[i];
    }
    this.speed = Math.sqrt(s2);
    const a = alpha(this.minCutoff + this.beta * this.speed, dt);
    for (let i = 0; i < this.dim; i++) this.x[i] += a * (v[i] - this.x[i]);
    return this.x.slice();
  }
}

export class OneEuroQuat {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  speedFloor: number;
  q = new THREE.Quaternion();
  prev = new THREE.Quaternion();
  w = new THREE.Vector3();
  has = false;
  speed = 0;
  t: number | null = null;
  private _dq = new THREE.Quaternion();
  private _inv = new THREE.Quaternion();
  private _v = new THREE.Vector3();

  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0, speedFloor = 0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.speedFloor = speedFloor;
    this.reset();
  }

  reset(): void {
    this.has = false;
    this.speed = 0;
    this.t = null;
    this.w.set(0, 0, 0);
  }

  filter(qIn: THREE.Quaternion, t: number): THREE.Quaternion {
    if (!this.has || this.t === null) {
      this.q.copy(qIn);
      this.prev.copy(qIn);
      this.has = true;
      this.t = t;
      this.speed = 0;
      this.w.set(0, 0, 0);
      return this.q.clone();
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const q = qIn.clone();
    if (q.dot(this.prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    this._dq.copy(q).multiply(this._inv.copy(this.prev).invert());
    quatToRotVec(this._dq, this._v).multiplyScalar(1 / dt);
    this.w.lerp(this._v, alpha(this.dCutoff, dt));
    this.speed = this.w.length();
    this.prev.copy(q);
    if (q.dot(this.q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const fast = Math.max(0, this.speed - this.speedFloor);
    this.q.slerp(q, alpha(this.minCutoff + this.beta * fast, dt));
    return this.q.clone();
  }
}

export function quatToRotVec(q: THREE.Quaternion, out = new THREE.Vector3()): THREE.Vector3 {
  let { x, y, z, w } = q;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(0, 0, 0);
  const ang = 2 * Math.atan2(s, w);
  return out.set((x / s) * ang, (y / s) * ang, (z / s) * ang);
}

export function rotVecToQuat(v: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const ang = v.length();
  if (ang < 1e-9) return out.set(0, 0, 0, 1);
  const s = Math.sin(ang / 2) / ang;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(ang / 2));
}

export function quatPow(q: THREE.Quaternion, k: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const v = quatToRotVec(q);
  v.multiplyScalar(k);
  return rotVecToQuat(v, out);
}

export function integrateQuat(q: THREE.Quaternion, w: THREE.Vector3, dt: number): THREE.Quaternion {
  const dq = rotVecToQuat(new THREE.Vector3().copy(w).multiplyScalar(dt));
  return q.premultiply(dq).normalize();
}

export const damp = (dt: number, tau: number): number => 1 - Math.exp(-dt / Math.max(1e-5, tau));

export interface PoseFilterQuatOptions {
  readonly still: number;
  readonly fast: number;
  readonly detect: number;
  readonly t0: number;
  readonly t1: number;
  readonly tCutoff: number;
  readonly s0: number;
  readonly s1: number;
  readonly sTau: number;
  readonly nCutoff: number;
  readonly gate: number;
  readonly nRef: number;
  readonly nPow: number;
  readonly nMax: number;
  readonly jump: number;
  readonly jumpRate: number;
}

export class PoseFilterQuat {
  o: PoseFilterQuatOptions;
  shared: { n: number };
  q = new THREE.Quaternion();
  v = new THREE.Vector3();
  qd = new THREE.Quaternion();
  vd = new THREE.Vector3();
  z1 = new THREE.Quaternion();
  z2 = new THREE.Quaternion();
  rv = new THREE.Vector3();
  has = 0;
  t: number | null = null;
  held: { q: THREE.Quaternion; t: number; n: number } | null = null;
  heldCount = 0;
  memory = 0;

  private _p = new THREE.Quaternion();
  private _r = new THREE.Vector3();
  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _dq = new THREE.Quaternion();
  private _z = new THREE.Quaternion();
  private _pq = new THREE.Quaternion();
  private _zin = new THREE.Quaternion();

  constructor(opts: PoseFilterQuatOptions, shared = { n: 0 }) {
    this.o = opts;
    this.shared = shared;
    this.reset();
  }

  reset(): void {
    this.has = 0;
    this.t = null;
    this.held = null;
    this.v.set(0, 0, 0);
    this.vd.set(0, 0, 0);
    this.rv.set(0, 0, 0);
    this.memory = this.o.fast;
  }

  get speed(): number {
    return this.v.length();
  }

  resid(z: THREE.Quaternion, p: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
    this._dq.copy(z).multiply(this._p.copy(p).invert());
    return quatToRotVec(this._dq, out);
  }

  filter(qIn: THREE.Quaternion, t: number): THREE.Quaternion {
    const o = this.o;
    const z = this._zin.copy(qIn);
    const dt = this.t !== null ? t - this.t : 0;
    if (this.has >= 2 && o.jump > 0 && dt > 1e-4 && dt <= 0.25) {
      if (z.dot(this.z1) < 0) z.set(-z.x, -z.y, -z.z, -z.w);
      const pq = this._pq.copy(this.q);
      integrateQuat(pq, this.v, dt);
      const off = this.resid(z, pq, this._a).length();
      if (off > Math.max(o.jump, o.jumpRate * dt)) {
        const H = this.held;
        if (H && this.resid(z, H.q, this._b).length() < off) {
          this.held = null;
          this.update(H.q, H.t);
          return this.update(z, t);
        }
        if (!H || H.n < 2) {
          this.held = { q: z.clone(), t, n: (H?.n ?? 0) + 1 };
          this.heldCount++;
          return pq.clone();
        }
      }
    }
    this.held = null;
    return this.update(z, t);
  }

  update(qIn: THREE.Quaternion, t: number): THREE.Quaternion {
    const o = this.o;
    const z = this._z.copy(qIn);
    if (!this.has || this.t === null) {
      this.q.copy(z);
      this.qd.copy(z);
      this.z1.copy(z);
      this.has = 1;
      this.t = t;
      return this.q.clone();
    }
    if (z.dot(this.z1) < 0) z.set(-z.x, -z.y, -z.z, -z.w);
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    if (dt > 0.25) {
      this.v.set(0, 0, 0);
      this.vd.set(0, 0, 0);
      this.rv.set(0, 0, 0);
      this.has = 1;
    }
    if (this.has >= 2 && this.vd.length() < o.gate) {
      this.resid(z, this.z1, this._a);
      this.resid(this.z1, this.z2, this._b);
      const e = Math.min(this._a.sub(this._b).length() / Math.sqrt(6), 3 * this.shared.n + 0.004);
      this.shared.n += alpha(o.nCutoff, dt) * (e - this.shared.n);
    }
    this.z2.copy(this.z1);
    this.z1.copy(z);
    this.has = Math.min(2, this.has + 1);
    const thd = Math.exp(-dt / o.detect);
    integrateQuat(this.qd, this.vd, dt);
    this.resid(z, this.qd, this._r);
    integrateQuat(this.qd, this._r, 1 - thd * thd);
    this.vd.addScaledVector(this._r, ((1 - thd) * (1 - thd)) / dt);

    const sig = this.shared.n + 1e-7;
    integrateQuat(this.q, this.v, dt);
    this.resid(z, this.q, this._r);
    this.rv.lerp(this._r, alpha(o.tCutoff, dt));
    const u = Math.max(0, this.rv.length() / sig - o.t0) / o.t1;
    const sp = this.v.length();
    const lag = sp > 1e-6 ? -this.rv.dot(this.v) / sp : 0;
    const brake = Math.max(0, lag / sig - o.s0) / o.s1;
    const still = o.still * Math.min(o.nMax, Math.max(1, Math.pow(sig / o.nRef, o.nPow)));
    this.memory = o.fast + (still - o.fast) / (1 + u * u);
    const th = Math.exp(-dt / this.memory);
    integrateQuat(this.q, this._r, 1 - th * th);
    this.v.addScaledVector(this._r, ((1 - th) * (1 - th)) / dt);
    if (brake > 0) {
      const s2 = this.v.length();
      const gf = 1 - Math.exp(-dt / o.fast);
      const room = Math.max(0, 1 - ((1 - th) * (1 - th)) / (gf * gf));
      const cut = room * Math.min(1 - Math.exp((-dt * brake) / o.sTau), s2 > 1e-9 ? lag / (dt * s2) : 1);
      this.v.multiplyScalar(1 - cut);
    }
    return this.q.clone();
  }
}

export interface PoseFilterVecOptions {
  readonly still: number;
  readonly fast: number;
  readonly detect: number;
  readonly m0: number;
  readonly m1: number;
  readonly rCutoff: number;
  readonly nCutoff: number;
  readonly gate: number;
  readonly nRef: number;
  readonly nPow: number;
  readonly nMax: number;
}

export class PoseFilterVec {
  dim: number;
  o: PoseFilterVecOptions;
  shared: { n: number };
  x: number[];
  v: number[];
  xd: number[];
  vd: number[];
  z1: number[];
  z2: number[];
  has = 0;
  t: number | null = null;
  rlp = 0;
  memory = 0;

  constructor(dim: number, opts: PoseFilterVecOptions, shared = { n: 0 }) {
    this.dim = dim;
    this.o = opts;
    this.shared = shared;
    this.x = new Array(dim).fill(0);
    this.v = new Array(dim).fill(0);
    this.xd = new Array(dim).fill(0);
    this.vd = new Array(dim).fill(0);
    this.z1 = new Array(dim).fill(0);
    this.z2 = new Array(dim).fill(0);
    this.reset();
  }

  reset(): void {
    this.has = 0;
    this.t = null;
    this.v.fill(0);
    this.vd.fill(0);
    this.rlp = 0;
    this.memory = this.o.fast;
  }

  filter(z: number[], t: number): number[] {
    const o = this.o;
    const D = this.dim;
    if (!this.has || this.t === null) {
      for (let i = 0; i < D; i++) this.x[i] = this.xd[i] = this.z1[i] = z[i];
      this.has = 1;
      this.t = t;
      return this.x.slice();
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    if (dt > 0.25) {
      this.v.fill(0);
      this.vd.fill(0);
      this.has = 1;
    }
    let vds = 0;
    for (let i = 0; i < D; i++) vds += this.vd[i] * this.vd[i];
    if (this.has >= 2 && Math.sqrt(vds) < o.gate) {
      let e2 = 0;
      for (let i = 0; i < D; i++) {
        const d = z[i] - 2 * this.z1[i] + this.z2[i];
        e2 += d * d;
      }
      const e = Math.min(Math.sqrt(e2) / Math.sqrt(6), 3 * this.shared.n + o.nRef * 0.5);
      this.shared.n += alpha(o.nCutoff, dt) * (e - this.shared.n);
    }
    for (let i = 0; i < D; i++) {
      this.z2[i] = this.z1[i];
      this.z1[i] = z[i];
    }
    this.has = Math.min(2, this.has + 1);
    const thd = Math.exp(-dt / o.detect);
    const gd = 1 - thd * thd;
    const hd = ((1 - thd) * (1 - thd)) / dt;
    let r2 = 0;
    for (let i = 0; i < D; i++) {
      this.xd[i] += this.vd[i] * dt;
      const r = z[i] - this.xd[i];
      r2 += r * r;
      this.xd[i] += gd * r;
      this.vd[i] += hd * r;
    }
    this.rlp += alpha(o.rCutoff, dt) * (Math.sqrt(r2) - this.rlp);
    const sig = this.shared.n + 1e-9;
    const u = Math.max(0, this.rlp / sig - o.m0) / o.m1;
    const still = o.still * Math.min(o.nMax, Math.max(1, Math.pow(sig / o.nRef, o.nPow)));
    this.memory = o.fast + (still - o.fast) / (1 + u * u);
    const th = Math.exp(-dt / this.memory);
    const g = 1 - th * th;
    const h = ((1 - th) * (1 - th)) / dt;
    for (let i = 0; i < D; i++) {
      this.x[i] += this.v[i] * dt;
      const r = z[i] - this.x[i];
      this.x[i] += g * r;
      this.v[i] += h * r;
    }
    return this.x.slice();
  }
}
