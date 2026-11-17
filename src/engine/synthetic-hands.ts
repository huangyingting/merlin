import * as THREE from 'three';
import type { HandDetectionResult, Landmark3D } from './hands';

const MCP: [number, number, number][] = [
  [0.038, 0.086, 0.0],
  [0.012, 0.093, 0.0],
  [-0.014, 0.088, 0.0],
  [-0.038, 0.075, 0.0],
];
const SEG: [number, number, number][] = [
  [0.044, 0.027, 0.022],
  [0.049, 0.031, 0.023],
  [0.045, 0.029, 0.022],
  [0.036, 0.022, 0.02],
];

function fingerPoints(open: number): THREE.Vector3[] {
  const curl = 1 - open;
  const pts: THREE.Vector3[] = [];
  for (let f = 0; f < 4; f++) {
    const base = new THREE.Vector3(...MCP[f]);
    pts.push(base.clone());
    let dir = new THREE.Vector3(0, 1, 0);
    let p = base.clone();
    const spread = (f - 1.5) * 0.24 * open;
    dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), spread);
    const angles = [1.45 * curl, 1.75 * curl, 1.2 * curl];
    for (let s = 0; s < 3; s++) {
      dir = dir.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -angles[s]);
      p = p.clone().addScaledVector(dir, SEG[f][s]);
      pts.push(p.clone());
    }
  }
  return pts;
}

function thumbPoints(open: number): THREE.Vector3[] {
  const c = 1 - open;
  return [
    new THREE.Vector3(0.026, 0.024, -0.008),
    new THREE.Vector3(0.052 - 0.016 * c, 0.045, -0.016 - 0.01 * c),
    new THREE.Vector3(0.074 - 0.036 * c, 0.066 - 0.005 * c, -0.022 - 0.02 * c),
    new THREE.Vector3(0.094 - 0.058 * c, 0.086 - 0.016 * c, -0.026 - 0.03 * c),
  ];
}

let seed = 12345;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
export function seedNoise(s: number): void {
  seed = s | 0;
}

export interface SynthHandSpec {
  center: [number, number];
  quat?: THREE.Quaternion | [number, number, number, number];
  euler?: [number, number, number];
  open?: number;
  scale?: number;
  handed?: 'Right' | 'Left';
  noise?: { world?: number; image?: number };
  residual?: { world: [number, number, number][]; image: [number, number][]; scale?: number };
}

export function synthHand(spec: SynthHandSpec, aspect = 16 / 9): { lm: Landmark3D[]; world: Landmark3D[]; handed: string } {
  const q = Array.isArray(spec.quat) ? new THREE.Quaternion(...spec.quat) : spec.quat || new THREE.Quaternion();
  const open = spec.open ?? 1;
  const s = spec.scale ?? 1;
  const local = [new THREE.Vector3(0, 0, 0), ...thumbPoints(open)];
  const f = fingerPoints(open);
  for (let i = 0; i < 4; i++) local.push(f[i * 4], f[i * 4 + 1], f[i * 4 + 2], f[i * 4 + 3]);
  if (spec.handed === 'Left') local.forEach((p) => (p.x = -p.x));
  const pc = new THREE.Vector3();
  for (const i of [0, 5, 9, 13, 17]) pc.add(local[i]);
  pc.multiplyScalar(1 / 5);
  const app = local.map((p) => p.clone().sub(pc).multiplyScalar(s).applyQuaternion(q));
  const nw = spec.noise?.world ?? 0;
  const ni = spec.noise?.image ?? 0;
  const world = app.map((p) => ({ x: -p.x + nw * gauss(), y: -p.y + nw * gauss(), z: p.z + nw * gauss() }));
  const rs = spec.residual;
  if (rs) {
    const k = rs.scale ?? 1;
    world.forEach((p, i) => {
      p.x += rs.world[i][0] * k;
      p.y += rs.world[i][1] * k;
      p.z += rs.world[i][2] * k;
    });
  }
  const k = 1.75;
  const [X, Y] = spec.center;
  const lm = app.map((p) => ({ x: 1 - (X + (p.x * k) / aspect) + ni * gauss(), y: Y - p.y * k + ni * gauss(), z: p.z * k }));
  if (rs) {
    const hs = 0.093 * k * s * (rs.scale ?? 1);
    lm.forEach((p, i) => {
      p.x += (rs.image[i][0] * hs) / aspect;
      p.y += rs.image[i][1] * hs;
    });
  }
  return { lm, world, handed: spec.handed || 'Right' };
}

export function synthResult(specs: SynthHandSpec[], aspect = 16 / 9): HandDetectionResult {
  const hands = specs.map((sp) => synthHand(sp, aspect));
  return {
    landmarks: hands.map((h) => h.lm),
    worldLandmarks: hands.map((h) => h.world),
    handedness: hands.map((h) => [{ categoryName: h.handed, score: 0.98, index: 0 }]),
  };
}

export function eulerQuat(x: number, y: number, z: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
}
