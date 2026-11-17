// detector-worker.js - MediaPipe Hand Landmarker off the main thread, so hand
// tracking never stalls rendering. Frames arrive as transferred ImageBitmaps.
import { FilesetResolver, HandLandmarker } from './mediapipe/vision_bundle.mjs';

const NATIVE_NOISE = /^(INFO: |[IW]\d{4} \d\d:\d\d:\d\d|Graph successfully started running)/;
for (const k of ['error', 'warn', 'info', 'log']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    if (typeof a[0] === 'string' && NATIVE_NOISE.test(a[0])) return;
    orig(...a);
  };
}

const BASE = new URL('./mediapipe/wasm', self.location.href).href;
const MODEL = new URL('./mediapipe/hand_landmarker.task', self.location.href).href;

let lm = null;
let delegate = null;
let fileset = null;
let model = null;

const options = (d) => ({
  baseOptions: { modelAssetBuffer: model, delegate: d },
  runningMode: 'VIDEO',
  numHands: 2,
  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.55,
  minTrackingConfidence: 0.5,
});

async function make(d) {
  const opts = options(d);
  if (d === 'GPU' && typeof OffscreenCanvas !== 'undefined') opts.canvas = new OffscreenCanvas(1, 1);
  return HandLandmarker.createFromOptions(fileset, opts);
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function init(prefer) {
  fileset = await FilesetResolver.forVisionTasks(BASE, true);
  const loads = [fetchBytes(MODEL)];
  if (prefer !== 'CPU') loads.push(fetchBytes(fileset.wasmLoaderPath), fetchBytes(fileset.wasmBinaryPath));
  [model] = await Promise.all(loads);
  if (prefer !== 'CPU') {
    self.postMessage({ type: 'stage', stage: 'gpu' });
    try {
      lm = await make('GPU');
      delegate = 'GPU';
      return;
    } catch {
      // fall through to CPU
    }
  }
  lm = await make('CPU');
  delegate = 'CPU';
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      await init(m.prefer);
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    const bmp = m.bitmap;
    try {
      const t0 = performance.now();
      const res = lm.detectForVideo(bmp, m.ts);
      const ms = performance.now() - t0;
      self.postMessage({
        type: 'result',
        ts: m.ts,
        ms,
        landmarks: res.landmarks,
        worldLandmarks: res.worldLandmarks,
        handedness: res.handedness ?? res.handednesses,
      });
    } catch {
      if (delegate === 'GPU') {
        try {
          lm.close();
        } catch {}
        try {
          lm = await make('CPU');
          delegate = 'CPU';
          self.postMessage({ type: 'delegate', delegate });
        } catch (err2) {
          self.postMessage({ type: 'error', message: String(err2?.message || err2) });
        }
      }
      self.postMessage({ type: 'result', ts: m.ts, ms: 0, landmarks: [], worldLandmarks: [], handedness: [], failed: true });
    } finally {
      bmp.close?.();
    }
  }
};
