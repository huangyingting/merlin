import * as THREE from 'three';
import { OneEuro, PoseFilterQuat, PoseFilterVec, integrateQuat } from './filters';

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';
export const MP_BASE = `${BASE_PATH}/mediapipe`;
export const MODEL_URL = `${MP_BASE}/hand_landmarker.task`;
export const WORKER_URL = `${BASE_PATH}/detector-worker.js`;

const PALM = [0, 5, 9, 13, 17];
const FINGERS: [number, number, number, number][] = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
export const TIPS = [4, 8, 12, 16, 20];

export interface Landmark3D {
  x: number;
  y: number;
  z: number;
}

export interface HandCategory {
  categoryName?: string;
  score?: number;
  index?: number;
}

export interface HandDetectionResult {
  landmarks?: Landmark3D[][];
  worldLandmarks?: Landmark3D[][];
  handedness?: HandCategory[][];
  handednesses?: HandCategory[][];
  failed?: boolean;
}

export interface HandFeatures {
  center: [number, number];
  quat: THREE.Quaternion;
  open: number;
  size: number;
  tips: [number, number][];
  points: [number, number][];
  handed: string;
  score: number;
}

export const tuning = {
  openOn: 0.62,
  openOff: 0.45,
  debounce: 0.03,
  reach: 1.3,
  oriStill: 0.22,
  oriFast: 0.025,
  oriDetect: 0.4,
  oriT0: 0.85,
  oriT1: 0.6,
  oriTCut: 4.5,
  oriS0: 0.45,
  oriS1: 0.3,
  oriSTau: 0.025,
  oriNMax: 2.2,
  oriJump: 0.45,
  oriJumpRate: 12,
  refitGap: 0.15,
  refitN: 3,
  posStill: 0.2,
  posFast: 0.022,
  predictMax: 0.055,
  grace: 0.16,
  steadySpeed: 2.5,
  steadyTurn: 6.0,
  armSteady: 0.0,
  armMax: 0.0,
  exitSpeed: 1.2,
};

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const attempts: (MediaTrackConstraints | boolean)[] = [
    { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, min: 24 } },
    { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    true,
  ];
  let stream: MediaStream | null = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: attempts[i] });
      break;
    } catch (err) {
      const name = (err as DOMException | undefined)?.name;
      const retry = name === 'OverconstrainedError' || name === 'NotReadableError' || name === 'AbortError' || name === 'TypeError';
      if (!retry || i === attempts.length - 1) throw err;
    }
  }
  if (!stream) throw new Error('No camera stream');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) await new Promise<void>((r) => video.addEventListener('loadeddata', () => r(), { once: true }));
  return stream;
}

let quieted = false;
function quietNativeLogs(): void {
  if (quieted) return;
  quieted = true;
  const noise = /^(INFO: |[IW]\d{4} \d\d:\d\d:\d\d)/;
  for (const k of ['error', 'warn', 'info', 'log'] as const) {
    const orig = console[k].bind(console);
    console[k] = (...a: unknown[]) => {
      if (typeof a[0] === 'string' && noise.test(a[0])) return;
      orig(...a);
    };
  }
}

interface MainLandmarkerCtx {
  lm: { detectForVideo(video: HTMLVideoElement, ts: number): HandDetectionResult; close(): void };
  delegate: 'GPU' | 'CPU';
  make: (delegate: 'GPU' | 'CPU') => Promise<MainLandmarkerCtx['lm']>;
}

async function createLandmarker(prefer: 'GPU' | 'CPU' = 'GPU'): Promise<MainLandmarkerCtx> {
  quietNativeLogs();
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const make = (delegate: 'GPU' | 'CPU') =>
    vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    });
  if (prefer === 'CPU') return { lm: await make('CPU'), delegate: 'CPU', make };
  try {
    return { lm: await make('GPU'), delegate: 'GPU', make };
  } catch (err) {
    console.warn('GPU delegate unavailable, using CPU', err);
    return { lm: await make('CPU'), delegate: 'CPU', make };
  }
}

export interface DetectorOptions {
  prefer?: 'GPU' | 'CPU';
  watchdogMs?: number;
  gpuSetupMs?: number;
  slowMs?: number;
  onLost?: (why: 'camera' | 'tracking') => void;
  stallMs?: number;
  stuckMs?: number;
}

export class Detector {
  onResult: (res: HandDetectionResult, t: number) => void;
  onError: (err: unknown) => void;
  onLost: (why: 'camera' | 'tracking') => void;
  stallMs: number;
  stuckMs: number;
  prefer: 'GPU' | 'CPU';
  watchdogMs: number;
  gpuSetupMs: number;
  slowMs: number;
  pace: { t0: number; n: number; sum: number } | null = null;
  paced = false;
  gotResult = false;
  kind: 'worker' | 'main' | null = null;
  delegate: 'GPU' | 'CPU' | null = null;
  fps = 0;
  inferMs = 0;
  private _count = 0;
  private _countT = performance.now();
  private _lastTs = 0;
  stopped = false;
  worker: Worker | null = null;
  ctx: MainLandmarkerCtx | null = null;
  gpuMs = 0;
  swapping = false;
  busy = false;
  watchdog: ReturnType<typeof setTimeout> | undefined;
  video: HTMLVideoElement | null = null;
  frameAt = 0;
  sentAt = 0;
  onVisible: (() => void) | null = null;

  constructor(
    onResult: (res: HandDetectionResult, t: number) => void,
    onError: (err: unknown) => void = () => {},
    {
      prefer = 'GPU',
      watchdogMs = 6000,
      gpuSetupMs = 8000,
      slowMs = 100,
      onLost = () => {},
      stallMs = 2000,
      stuckMs = 10000,
    }: DetectorOptions = {}
  ) {
    this.onResult = onResult;
    this.onError = onError;
    this.onLost = onLost;
    this.stallMs = stallMs;
    this.stuckMs = stuckMs;
    this.prefer = prefer;
    this.watchdogMs = watchdogMs;
    this.gpuSetupMs = gpuSetupMs;
    this.slowMs = slowMs;
  }

  async init(): Promise<this> {
    try {
      await this.initWorker();
      this.kind = 'worker';
    } catch (err) {
      if (this.stopped) return this;
      console.warn('Worker hand tracking unavailable, using main thread:', (err as Error)?.message || err);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.ctx = await createLandmarker(this.prefer);
      this.delegate = this.ctx.delegate;
      this.kind = 'main';
    }
    return this;
  }

  initWorker(prefer: 'GPU' | 'CPU' = this.prefer): Promise<void> {
    return new Promise((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(WORKER_URL, { type: 'module' });
      } catch (err) {
        reject(err);
        return;
      }
      this.worker = w;
      let gpuTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(timer);
        clearTimeout(gpuTimer);
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error('worker init timeout'));
      }, 90000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'stage' && m.stage === 'gpu') {
          gpuTimer = setTimeout(() => {
            settle();
            w.terminate();
            if (this.stopped) {
              reject(new Error('stopped'));
              return;
            }
            console.debug('GPU hand tracking is slow to start; switching to CPU');
            this.initWorker('CPU').then(resolve, reject);
          }, this.gpuSetupMs);
        } else if (m.type === 'ready') {
          settle();
          this.delegate = m.delegate;
          w.onmessage = (ev) => this.onWorkerMessage(ev.data);
          resolve();
        } else if (m.type === 'error') {
          settle();
          reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        settle();
        e.preventDefault?.();
        reject(new Error(e.message || 'worker error'));
      };
      w.postMessage({ type: 'init', prefer });
    });
  }

  nextTs(): number {
    let ts = performance.now();
    if (ts <= this._lastTs) ts = this._lastTs + 0.5;
    this._lastTs = ts;
    return ts;
  }

  tick(ms: number): void {
    this.inferMs = this.inferMs * 0.9 + ms * 0.1;
    this._count++;
    const now = performance.now();
    if (now - this._countT >= 1000) {
      this.fps = (this._count * 1000) / (now - this._countT);
      this._count = 0;
      this._countT = now;
    }
  }

  checkPace(ms: number): void {
    if (this.paced || this.kind !== 'worker' || !this.worker) return;
    const now = performance.now();
    const P = this.pace || (this.pace = { t0: now, n: 0, sum: 0 });
    if (now - P.t0 < 500) return;
    P.n++;
    P.sum += ms;
    if (now - P.t0 < 2500 || P.n < 5) return;
    const avg = P.sum / P.n;
    this.pace = null;
    if (this.delegate === 'GPU' && !this.gpuMs && avg > this.slowMs) {
      this.gpuMs = avg;
      this.swap('CPU', 'GPU hand tracking is slow; trying the CPU');
    } else {
      this.paced = true;
      if (this.delegate === 'CPU' && this.gpuMs && avg > this.gpuMs * 1.2) this.swap('GPU', 'CPU hand tracking is slower; back to the GPU');
    }
  }

  async swap(delegate: 'GPU' | 'CPU', why: string): Promise<void> {
    if (this.stopped || this.swapping) return;
    this.swapping = true;
    console.debug(why);
    this.worker?.terminate();
    this.worker = null;
    try {
      await this.initWorker(delegate);
    } catch (err) {
      if (!this.stopped) {
        this.onError(err);
        this.stop();
        this.onLost('tracking');
      }
    }
    this.swapping = false;
    this.busy = false;
  }

  armWatchdog(): void {
    if (this.gotResult || this.watchdog || this.delegate !== 'GPU' || this.kind !== 'worker') return;
    this.watchdog = setTimeout(() => {
      if (this.gotResult || this.stopped) return;
      this.swap('CPU', 'GPU hand tracking is slow to start; switching to CPU');
    }, this.watchdogMs);
  }

  onWorkerMessage(m: HandDetectionResult & { type: string; ts: number; ms?: number; delegate?: 'GPU' | 'CPU'; message?: string }): void {
    if (m.type === 'result') {
      this.gotResult = true;
      clearTimeout(this.watchdog);
      this.busy = false;
      this.tick(m.ms || 0);
      if (!m.failed) this.checkPace(m.ms || 0);
      if (!this.stopped) this.onResult(m, m.ts / 1000);
    } else if (m.type === 'delegate' && m.delegate) {
      this.delegate = m.delegate;
      this.pace = null;
    } else if (m.type === 'error') {
      this.onError(new Error(m.message));
    }
  }

  start(video: HTMLVideoElement): void {
    this.video = video;
    let lastVideoTime = -1;
    let seenTime = -1;
    this.frameAt = performance.now();
    this.onVisible = () => {
      if (document.visibilityState === 'visible') this.frameAt = performance.now();
    };
    document.addEventListener('visibilitychange', this.onVisible);
    const pump = () => {
      if (this.stopped) return;
      const now = performance.now();
      if (video.readyState >= 2 && video.currentTime !== seenTime) {
        seenTime = video.currentTime;
        this.frameAt = now;
      }
      const stream = video.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks?.()[0];
      if (!track || track.readyState === 'ended' || (document.visibilityState === 'visible' && now - this.frameAt > this.stallMs)) {
        this.stop();
        this.onLost('camera');
        return;
      }
      if (this.kind === 'worker' && this.busy && this.gotResult && !this.swapping && now - this.sentAt > this.stuckMs) {
        this.swap(this.delegate || this.prefer, 'hand tracking stopped answering; restarting it');
      }
      if (!this.busy && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const ts = this.nextTs();
        if (this.kind === 'worker') {
          if (!this.worker || this.swapping) {
            requestAnimationFrame(pump);
            return;
          }
          this.busy = true;
          this.sentAt = now;
          this.armWatchdog();
          createImageBitmap(video)
            .then((bmp) => this.worker?.postMessage({ type: 'frame', bitmap: bmp, ts }, [bmp]))
            .catch(() => {
              this.busy = false;
            });
        } else if (this.ctx) {
          const ctx = this.ctx;
          const t0 = performance.now();
          try {
            const res = ctx.lm.detectForVideo(video, ts);
            this.tick(performance.now() - t0);
            this.onResult(res, ts / 1000);
          } catch (err) {
            if (ctx.delegate === 'GPU') {
              ctx.delegate = 'CPU';
              this.delegate = 'CPU';
              ctx.make('CPU').then((lm) => (ctx.lm = lm)).catch(this.onError);
            } else this.onError(err);
          }
        }
      }
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.watchdog);
    if (this.worker) this.worker.terminate();
    this.worker = null;
    if (this.ctx) {
      try {
        this.ctx.lm.close();
      } catch {}
      this.ctx = null;
    }
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
  }
}

const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _m = new THREE.Matrix4();

function P(world: Landmark3D[], i: number, out: THREE.Vector3): THREE.Vector3 {
  const p = world[i];
  return out.set(-p.x, -p.y, p.z);
}

export function palmQuat(world: Landmark3D[], out = new THREE.Quaternion()): THREE.Quaternion {
  const w = P(world, 0, _v[0]);
  const up = _v[1].set(0, 0, 0);
  for (const i of [5, 9, 13]) up.add(P(world, i, _v[2]));
  up.multiplyScalar(1 / 3).sub(w).normalize();
  const across = P(world, 5, _v[2]).sub(P(world, 17, _v[3]));
  const z = new THREE.Vector3().crossVectors(across, up).normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  _m.makeBasis(x, up, z);
  return out.setFromRotationMatrix(_m);
}

export function openness(world: Landmark3D[]): number {
  const W = world[0];
  const scores: number[] = [];
  for (const [a, b, c, d] of FINGERS) {
    const A = world[a];
    const B = world[b];
    const C = world[c];
    const D = world[d];
    const chain = dist3(A, B) + dist3(B, C) + dist3(C, D);
    const straight = chain > 1e-6 ? dist3(A, D) / chain : 0;
    const mcp = W ? dist3(W, A) : 0;
    const ext = mcp > 1e-6 ? Math.min(1, Math.max(0, (dist3(W, D) / mcp - 0.95) / 0.95)) : 0;
    scores.push(Math.max(straight, 0.55 * straight + 0.45 * ext));
  }
  scores.sort((x, y) => x - y);
  return (0.4 * scores[0] + scores[1] + scores[2] + scores[3]) / 3.4;
}

function dist3(a: Landmark3D, b: Landmark3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function reachMap(x: number, y: number, reach = tuning.reach): [number, number] {
  return [0.5 + (x - 0.5) * reach, 0.5 + (y - 0.5) * reach];
}

function features(lm: Landmark3D[], world: Landmark3D[], handed: HandCategory | undefined, aspect: number): HandFeatures {
  let cx = 0;
  let cy = 0;
  for (const i of PALM) {
    cx += lm[i].x;
    cy += lm[i].y;
  }
  cx /= PALM.length;
  cy /= PALM.length;
  const X = 1 - cx;
  const Y = cy;
  const dx = (lm[9].x - lm[0].x) * aspect;
  const dy = lm[9].y - lm[0].y;
  const size = Math.hypot(dx, dy);
  return {
    center: [X, Y],
    quat: palmQuat(world),
    open: openness(world),
    size,
    tips: TIPS.map((i) => [1 - lm[i].x, lm[i].y] as [number, number]),
    points: lm.map((p) => [1 - p.x, p.y] as [number, number]),
    handed: handed?.categoryName ?? '',
    score: handed?.score ?? 1,
  };
}

export const poseNoise = { n: 0.0087 };
export const centerNoise = { n: 0.0004 };
const centerOpts = {
  get still() {
    return tuning.posStill;
  },
  get fast() {
    return tuning.posFast;
  },
  detect: 0.5,
  m0: 2.0,
  m1: 1.5,
  rCutoff: 2.0,
  nCutoff: 0.5,
  gate: 0.1,
  nRef: 0.0004,
  nPow: 1.0,
  nMax: 1.4,
};
const poseOpts = {
  get still() {
    return tuning.oriStill;
  },
  get fast() {
    return tuning.oriFast;
  },
  get detect() {
    return tuning.oriDetect;
  },
  get t0() {
    return tuning.oriT0;
  },
  get t1() {
    return tuning.oriT1;
  },
  get tCutoff() {
    return tuning.oriTCut;
  },
  get s0() {
    return tuning.oriS0;
  },
  get s1() {
    return tuning.oriS1;
  },
  get sTau() {
    return tuning.oriSTau;
  },
  nCutoff: 0.5,
  gate: 0.6,
  nRef: 0.0087,
  nPow: 1.0,
  get nMax() {
    return tuning.oriNMax;
  },
  get jump() {
    return tuning.oriJump;
  },
  get jumpRate() {
    return tuning.oriJumpRate;
  },
};

export interface TrackHistoryEntry {
  t: number;
  q: THREE.Quaternion;
  open: number;
  raw: number;
  c: number[];
}

export class Track {
  id: number;
  born: number;
  lastSeen: number;
  fCenter: PoseFilterVec;
  fQuat: PoseFilterQuat;
  fOpen: OneEuro;
  w: THREE.Vector3;
  vc: number[];
  dtDet = 1 / 30;
  refit = 0;
  isOpen: boolean;
  pendingOpen: boolean;
  pendingSince: number;
  openSince: number | null;
  steadySince: number | null = null;
  history: TrackHistoryEntry[] = [];
  raw!: HandFeatures;
  center!: [number, number];
  quat!: THREE.Quaternion;
  open!: number;
  size!: number;
  tips!: [number, number][];
  points!: [number, number][];
  handed!: string;

  constructor(id: number, f: HandFeatures, t: number) {
    this.id = id;
    this.born = t;
    this.lastSeen = t;
    this.fCenter = new PoseFilterVec(2, centerOpts, centerNoise);
    this.fQuat = new PoseFilterQuat(poseOpts, poseNoise);
    this.fOpen = new OneEuro(5.0, 1.0, 1.0);
    this.w = this.fQuat.v;
    this.vc = this.fCenter.v;
    this.isOpen = f.open > tuning.openOn;
    this.pendingOpen = this.isOpen;
    this.pendingSince = t;
    this.openSince = this.isOpen ? t : null;
    this.apply(f, t);
  }

  apply(f: HandFeatures, t: number, dtRes = 1 / 30): void {
    const prevT = this.lastSeen;
    this.raw = f;
    this.lastSeen = t;
    const gap = t - prevT;
    this.refit = gap > Math.max(tuning.refitGap, 2.5 * dtRes) ? tuning.refitN : Math.max(0, this.refit - 1);
    if (this.refit > 0) {
      this.fQuat.reset();
      this.fCenter.reset();
    }
    const c = this.fCenter.filter(f.center, t);
    this.center = [c[0], c[1]];
    this.quat = this.fQuat.filter(f.quat, t);
    this.open = this.fOpen.filter(f.open, t);
    const dt = t - prevT;
    if (dt > 1e-4 && dt < 0.25) this.dtDet += 0.2 * (dt - this.dtDet);
    this.size = f.size;
    this.tips = f.tips;
    this.points = f.points;
    this.handed = f.handed;
    const want = this.isOpen ? this.open > tuning.openOff : this.open > tuning.openOn;
    if (want !== this.isOpen) {
      if (this.pendingOpen !== want) {
        this.pendingOpen = want;
        this.pendingSince = t;
      }
      if (t - this.pendingSince >= tuning.debounce) {
        this.isOpen = want;
        this.openSince = want ? t : null;
      }
    } else {
      this.pendingOpen = this.isOpen;
      this.pendingSince = t;
    }
    this.history.push({ t, q: this.quat.clone(), open: this.open, raw: f.open, c: f.center.slice() });
    while (this.history.length > 2 && t - this.history[0].t > 0.6) this.history.shift();
    const m = this.isOpen ? this.motion(t) : null;
    if (!m || m.speed > tuning.steadySpeed || m.turn > tuning.steadyTurn) this.steadySince = null;
    else if (this.steadySince === null) this.steadySince = t;
  }

  motion(tEnd = this.lastSeen, window = 0.1): { vx: number; vy: number; speed: number; turn: number } | null {
    const h = this.history;
    let j = h.length - 1;
    while (j >= 0 && h[j].t > tEnd + 1e-6) j--;
    if (j < 1) return null;
    const b = h[j];
    let i = j - 1;
    while (i > 0 && b.t - h[i].t < window - 1e-6) i--;
    const a = h[i];
    const dt = b.t - a.t;
    if (dt < 0.03) return null;
    const vx = (b.c[0] - a.c[0]) / dt;
    const vy = (b.c[1] - a.c[1]) / dt;
    return { vx, vy, speed: Math.hypot(vx, vy), turn: a.q.angleTo(b.q) / dt };
  }

  armed(t: number): boolean {
    if (!this.isOpen) return false;
    const [sx, sy] = this.screen;
    if (sx < 0.02 || sx > 0.98 || sy < 0.02 || sy > 0.97) return false;
    if (this.steadySince !== null && t - this.steadySince >= tuning.armSteady - 1e-6) return true;
    return this.openSince !== null && t - this.openSince >= tuning.armMax;
  }

  closeStartTime(window = 0.5): number {
    const h = this.history;
    if (!h.length) return this.lastSeen;
    const tEnd = h[h.length - 1].t;
    let plateau = 0;
    for (const s of h) if (tEnd - s.t <= window && s.open > plateau) plateau = s.open;
    for (let j = h.length - 1; j >= 0; j--) if (h[j].open >= plateau - 0.05) return h[j].t;
    return h[0].t;
  }

  closing(drop: number, rate = Infinity, window = 0.4): boolean {
    const h = this.history;
    const n = h.length;
    if (n < 2) return false;
    const tEnd = h[n - 1].t;
    let plateau = 0;
    for (let j = n - 1; j >= 0 && tEnd - h[j].t <= window + 1e-6; j--) plateau = Math.max(plateau, h[j].raw);
    const [b, c] = [h[n - 2].raw, h[n - 1].raw];
    const fell = plateau - c;
    if (fell >= drop && c < b) return true;
    const dt = tEnd - h[n - 2].t;
    return dt > 0 && dt < 0.1 && (b - c) / dt >= rate && fell >= drop / 2;
  }

  exitStart(): number | null {
    const h = this.history;
    const m = this.motion(this.lastSeen);
    if (!m) return null;
    const last = h[h.length - 1];
    const [sx, sy] = reachMap(last.c[0], last.c[1]);
    const outward = (sy > 0.85 && m.vy > 0) || (sy < 0.1 && m.vy < 0) || (sx < 0.1 && m.vx < 0) || (sx > 0.9 && m.vx > 0);
    if (m.speed < tuning.exitSpeed && !(outward && m.speed > 0.2)) return null;
    let j = h.length - 1;
    while (j > 0) {
      const mj = this.motion(h[j].t, 0.066);
      if (!mj || mj.speed < 0.25 || mj.vx * m.vx + mj.vy * m.vy <= 0) break;
      j--;
    }
    return h[j].t;
  }

  get age(): number {
    return this.lastSeen - this.born;
  }

  angularVelocity(tEnd: number, window = 0.1): THREE.Vector3 {
    const h = this.history.filter((s) => s.t <= tEnd + 1e-6 && s.t >= tEnd - window - 1e-6);
    if (h.length < 2) return new THREE.Vector3();
    const a = h[0];
    const b = h[h.length - 1];
    const dt = b.t - a.t;
    if (dt < 0.03) return new THREE.Vector3();
    const dq = b.q.clone().multiply(a.q.clone().invert());
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const s = Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
    if (s < 1e-9) return new THREE.Vector3();
    const ang = 2 * Math.atan2(s, dq.w);
    return new THREE.Vector3(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(ang / dt);
  }

  flickVelocity(tEnd: number, window = 0.15, span = 0.06): THREE.Vector3 {
    const h = this.history.filter((s) => s.t <= tEnd + 1e-6 && s.t >= tEnd - window - span - 1e-6);
    let best = new THREE.Vector3();
    let bestLen = 0;
    for (let j = h.length - 1; j > 0; j--) {
      const b = h[j];
      if (b.t < tEnd - window - 1e-6) break;
      let i = j - 1;
      while (i > 0 && b.t - h[i].t < span) i--;
      const a = h[i];
      const dt = b.t - a.t;
      if (dt < 0.03) continue;
      const dq = b.q.clone().multiply(a.q.clone().invert());
      if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
      const sn = Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
      if (sn < 1e-9) continue;
      const ang = (2 * Math.atan2(sn, dq.w)) / dt;
      if (ang > bestLen) {
        bestLen = ang;
        best = new THREE.Vector3(dq.x / sn, dq.y / sn, dq.z / sn).multiplyScalar(ang);
      }
    }
    return best;
  }

  lastOpenTime(): number {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].open >= tuning.openOn) return this.history[i].t;
    }
    return this.history.length ? this.history[0].t : this.lastSeen;
  }

  get screen(): [number, number] {
    return reachMap(this.center[0], this.center[1]);
  }

  ahead(t: number): number {
    return Math.min(Math.max(0, t - this.lastSeen), Math.min(this.dtDet, tuning.predictMax));
  }

  quatAt(t: number, out = new THREE.Quaternion()): THREE.Quaternion {
    out.copy(this.quat);
    const a = this.ahead(t);
    if (a > 0) integrateQuat(out, this.w.clone().multiplyScalar(a), 1);
    return out;
  }

  centerAt(t: number): [number, number] {
    const a = this.ahead(t);
    return [this.center[0] + this.vc[0] * a, this.center[1] + this.vc[1] * a];
  }

  screenAt(t: number): [number, number] {
    const [x, y] = this.centerAt(t);
    return reachMap(x, y);
  }
}

export class HandTracker {
  tracks: Track[] = [];
  nextId = 1;
  aspect = 16 / 9;
  lastResultT = 0;
  dtRes = 1 / 30;
  steps: number[] = [];

  clear(): void {
    this.tracks = [];
    this.lastResultT = 0;
    this.steps = [];
  }

  update(result: HandDetectionResult | null | undefined, t: number): Track[] {
    const dtRes = this.dtRes;
    const step = t - this.lastResultT;
    if (this.lastResultT > 0 && step > 1e-4) {
      this.steps.push(step);
      if (this.steps.length > 9) this.steps.shift();
      const sorted = this.steps.slice().sort((a, b) => a - b);
      this.dtRes = sorted[sorted.length >> 1];
    }
    this.lastResultT = t;
    const lms = result?.landmarks ?? [];
    const worlds = result?.worldLandmarks ?? [];
    const hands = result?.handedness ?? result?.handednesses ?? [];
    const dets: HandFeatures[] = [];
    for (let i = 0; i < lms.length; i++) {
      if (!lms[i] || !worlds[i] || lms[i].length < 21 || worlds[i].length < 21) continue;
      dets.push(features(lms[i], worlds[i], hands[i]?.[0], this.aspect));
    }
    const pairs: [number, number, number][] = [];
    this.tracks.forEach((tr, ti) => {
      dets.forEach((d, di) => {
        const dd = Math.hypot(tr.center[0] - d.center[0], tr.center[1] - d.center[1]);
        pairs.push([dd, ti, di]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const [dd, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di) || dd > 0.35) continue;
      usedT.add(ti);
      usedD.add(di);
      this.tracks[ti].apply(dets[di], t, dtRes);
    }
    dets.forEach((d, di) => {
      if (!usedD.has(di)) this.tracks.push(new Track(this.nextId++, d, t));
    });
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen <= tuning.grace);
    return this.tracks;
  }

  visible(): Track[] {
    return this.tracks.filter((tr) => tr.lastSeen === this.lastResultT);
  }

  reset(): void {
    this.tracks = [];
  }
}
