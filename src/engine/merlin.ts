import * as THREE from 'three';
import { Part, V, TAU, shapeFromPoints, circleHole, quatFromY, type ProfilePoint } from './cadkit';

export const MERLIN_CENTER = V(-0.035, 1.12, 0.0);
export const MERLIN_HEIGHT = 2.32;

const Y = V(0, 1, 0);
const PUMP = V(-0.245, 0, -0.02);
const MAIN_X = 0.035;
const PLATE_Y = 1.950;
const MAJOR = 2.25;

function bezierProfile(points: [number, number][], steps = 40): [number, number][] {
  const curve = new THREE.CubicBezierCurve(
    new THREE.Vector2(points[0][0], points[0][1]),
    new THREE.Vector2(points[1][0], points[1][1]),
    new THREE.Vector2(points[2][0], points[2][1]),
    new THREE.Vector2(points[3][0], points[3][1])
  );
  return curve.getPoints(steps).map((p) => [p.x, p.y]);
}

const BELL = bezierProfile(
  [
    [0.460, 0.000],
    [0.410, 0.170],
    [0.335, 0.355],
    [0.285, 0.525],
  ],
  54
);

function radialSeamAngles(count: number, offset = 0): number[] {
  const arr: number[] = [];
  for (let i = 0; i < count; i++) arr.push(offset + (i / count) * TAU);
  return arr;
}

function nozzle(): Part {
  const p = new Part('nozzle', { label: 'NOZZLE EXTENSION', explode: [0, -0.55, 0], anchor: [0.33, 0.26, 0.16] });

  p.withCadK(0, () => {
    p.lathe(BELL, {
      mat: 'bell',
      segs: 120,
      rings: [0, 19, 38],
      seams: [Math.PI / 2, -Math.PI / 2],
      ringWeight: MAJOR,
      seamWeight: 1.95,
      seamK: 1.45,
      ringK: 1.60,
    });

    for (const [idx, dy, w, k] of [
      [0, 0.013, 1.95, 1.35],
      [19, 0.012, 1.80, 1.25],
      [38, 0.011, 1.75, 1.20],
    ] as const) {
      const [r, y] = BELL[idx];
      p.withWeight(w, () => {
        p.circle(V(0, y + dy, 0), Y, r * 0.988, k, 96);
        p.circle(V(0, y, 0), Y, r * 0.968, k * 0.80, 80);
      });
    }

    const [r0, y0] = BELL[0];
    p.seg(V(-r0, y0, 0), V(r0, y0, 0), 1.55, MAJOR);
    p.seg(V(-r0 * 0.99, y0 + 0.011, 0), V(r0 * 0.99, y0 + 0.011, 0), 1.00, 1.45);
  });

  p.lathe(
    BELL.map(([r, y]) => [r - 0.008, y] as ProfilePoint),
    { mat: 'bellInside', segs: 96, rings: [], seams: [] }
  );
  p.band(0.452, 0.464, 0, 0.010, {
    mat: 'metal',
    segs: 96,
    rings: [0, 1],
    ringWeight: MAJOR,
    k: 1.25,
  });

  return p;
}

function manifold(): Part {
  const p = new Part('manifold', { label: 'REGEN MANIFOLD', explode: [0, -0.26, 0], anchor: [0.28, 0.59, 0.12] });

  p.band(0.185, 0.302, 0.532, 0.578, {
    mat: 'copper',
    segs: 72,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(12),
    ringWeight: MAJOR,
    k: 1.42,
  });
  p.band(0.182, 0.296, 0.586, 0.642, {
    mat: 'metal',
    segs: 72,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(12, Math.PI / 12),
    ringWeight: MAJOR,
    k: 1.40,
  });
  p.band(0.175, 0.258, 0.642, 0.668, {
    mat: 'metalDark',
    segs: 64,
    rings: [1, 2],
    seams: radialSeamAngles(8),
    ringWeight: 1.65,
    k: 1.15,
  });

  p.seg(V(-0.285, 0.582, 0), V(0.285, 0.582, 0), 1.15, 1.55);
  p.seg(V(0, 0.582, -0.285), V(0, 0.582, 0.285), 0.95, 1.30);

  return p;
}

function chamber(): Part {
  const p = new Part('chamber', { label: 'THRUST CHAMBER', explode: [0, -0.10, 0], anchor: [0.22, 1.04, 0.14] });

  const neckProf: ProfilePoint[] = [
    [0.215, 0.668],
    [0.142, 0.712],
    [0.112, 0.765],
    [0.112, 0.845],
    [0.145, 0.895],
  ];
  p.lathe(neckProf, {
    mat: 'metalDark',
    segs: 64,
    rings: [0, 1, 2, 3, 4],
    seams: radialSeamAngles(10),
    ringWeight: 1.60,
    seamWeight: 1.25,
    ringK: 1.18,
    seamK: 0.92,
  });

  for (const s of [-1, 1]) {
    const a = V(s * 0.112, 0.808, 0.01);
    const b = V(s * 0.192, 0.758, 0.02);
    p.cyl(a, b, 0.015, { mat: 'steel', k: 1.28, ringWeight: 1.55, seams: [0, Math.PI] });
  }

  const chaliceProf: ProfilePoint[] = [
    [0.145, 0.895],
    [0.204, 0.942],
    [0.228, 1.012],
    [0.244, 1.090],
    [0.256, 1.168],
  ];
  p.lathe(chaliceProf, {
    mat: 'metal',
    segs: 72,
    rings: [0, 1, 2, 3, 4],
    seams: radialSeamAngles(12),
    ringWeight: MAJOR,
    seamWeight: 1.38,
    ringK: 1.38,
    seamK: 0.90,
  });

  p.band(0.138, 0.260, 1.128, 1.168, {
    mat: 'steel',
    segs: 72,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(12),
    ringWeight: MAJOR,
    k: 1.45,
  });

  for (const s of [-1, 1]) {
    p.box(V(s * 0.268, 1.118, 0), [0.040, 0.044, 0.050], { mat: 'steel', k: 1.28 });
    p.cyl(V(s * 0.285, 1.086, 0), V(s * 0.308, 1.148, 0), 0.017, { mat: 'metal', k: 1.30, ringWeight: 1.55 });
  }

  p.withK(0, () => {
    p.withCadK(1, () => {
      p.cyl(V(0, 1.165, 0), V(MAIN_X, 1.285, 0), 0.055, { mat: 'joint', k: 0.85 });
    });
  });

  return p;
}

function exhaust(): Part {
  const p = new Part('exhaust', { label: 'TURBINE EXHAUST', explode: [-0.36, -0.06, 0], anchor: [-0.35, 1.18, 0.02] });

  const cx = -0.348;
  const cz = -0.01;
  for (const yRing of [1.258, 1.148]) {
    p.pushAt(V(cx, 0, cz));
    p.band(0.045, 0.072, yRing - 0.012, yRing + 0.012, {
      mat: 'metal',
      segs: 44,
      rings: [0, 1, 2, 3],
      seams: [],
      ringWeight: MAJOR,
      k: 1.45,
    });
    p.pop();
    p.torus(V(cx, yRing, cz), V(0.18, 0.96, 0.20).normalize(), 0.058, 0.0085, {
      mat: 'steel',
      k: 1.30,
    });
  }

  for (const [dx, dz] of [
    [-0.038, 0.0],
    [0.038, 0.0],
    [0.0, -0.038],
  ] as const) {
    p.cyl(V(cx + dx, 1.148, cz + dz), V(cx + dx * 0.85, 1.435, cz + dz), 0.008, {
      mat: 'steel',
      k: 1.22,
      ringWeight: 1.38,
      seams: [0],
    });
  }

  return p;
}

function injector(): Part {
  const p = new Part('injector', { label: 'MAIN INJECTOR', explode: [0.08, 0.18, 0], anchor: [0.20, 1.65, 0.15] });

  p.pushAt(V(MAIN_X, 0, 0));
  p.band(0.122, 0.228, 1.282, 1.352, {
    mat: 'metal',
    segs: 72,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(12),
    ringWeight: MAJOR,
    k: 1.45,
  });

  const colProf: ProfilePoint[] = [
    [0.192, 1.352],
    [0.184, 1.445],
    [0.184, 1.545],
    [0.184, 1.650],
    [0.184, 1.755],
    [0.188, 1.855],
    [0.198, 1.950],
  ];
  p.lathe(colProf, {
    mat: 'metal',
    segs: 72,
    rings: [0, 1, 2, 3, 4, 5, 6],
    seams: radialSeamAngles(12),
    ringWeight: 1.82,
    seamWeight: 1.32,
    ringK: 1.30,
    seamK: 0.85,
  });

  for (const [y0, y1] of [
    [1.480, 1.520],
    [1.675, 1.715],
    [1.835, 1.875],
  ] as const) {
    p.band(0.128, 0.204, y0, y1, {
      mat: 'steel',
      segs: 64,
      rings: [0, 1, 2, 3],
      seams: radialSeamAngles(8),
      ringWeight: 1.78,
      k: 1.30,
    });
  }
  p.pop();

  const actBot = V(0.295, 1.480, 0.02);
  const actTop = V(0.415, 1.760, 0.02);
  const actDir = actTop.clone().sub(actBot).normalize();
  p.cyl(actBot, actTop, 0.048, {
    mat: 'white',
    k: 1.38,
    ringWeight: 1.82,
    ringsAt: [0.25, 0.55, 0.82],
    seams: radialSeamAngles(6),
  });
  p.pushAt(actTop, quatFromY(actDir));
  p.band(0.025, 0.064, -0.018, 0.022, {
    mat: 'metal',
    segs: 40,
    rings: [0, 1, 2, 3],
    ringWeight: MAJOR,
    k: 1.40,
  });
  p.pop();
  p.cyl(V(0.265, 1.465, 0.05), V(0.325, 1.665, 0.05), 0.036, {
    mat: 'teal',
    k: 1.28,
    ringWeight: 1.68,
    ringsAt: [0.5],
    seams: radialSeamAngles(4),
  });
  p.cyl(V(0.215, 1.720, 0.02), V(0.385, 1.710, 0.02), 0.018, { mat: 'joint', k: 1.22, seams: [0, Math.PI] });
  p.cyl(V(0.215, 1.545, 0.02), V(0.305, 1.525, 0.02), 0.018, { mat: 'joint', k: 1.22, seams: [0, Math.PI] });

  const fBot = V(0.020, 1.615, 0.365);
  const fTop = V(0.055, 1.825, 0.435);
  p.cyl(fBot, fTop, 0.062, {
    mat: 'white',
    r2: 0.048,
    k: 1.32,
    ringWeight: 1.78,
    ringsAt: [0.25, 0.55, 0.85],
    seams: radialSeamAngles(8),
  });
  p.cyl(V(-0.015, 1.745, 0.195), V(0.015, 1.745, 0.365), 0.016, { mat: 'joint', k: 1.18, seams: [0, Math.PI] });
  p.cyl(V(0.075, 1.685, 0.195), V(0.065, 1.685, 0.365), 0.016, { mat: 'joint', k: 1.18, seams: [0, Math.PI] });

  return p;
}

function turbopump(): Part {
  const p = new Part('turbopump', { label: 'TURBOPUMP', explode: [-0.32, 0.12, 0], anchor: [-0.28, 1.72, 0.12] });

  p.pushAt(PUMP);
  p.band(0.078, 0.148, 1.435, 1.485, {
    mat: 'metal',
    segs: 56,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(10),
    ringWeight: MAJOR,
    k: 1.40,
  });

  const pumpProf: ProfilePoint[] = [
    [0.138, 1.485],
    [0.136, 1.595],
    [0.136, 1.710],
    [0.140, 1.825],
    [0.150, 1.945],
  ];
  p.lathe(pumpProf, {
    mat: 'teal',
    segs: 56,
    rings: [0, 1, 2, 3, 4],
    seams: radialSeamAngles(10),
    ringWeight: 1.78,
    seamWeight: 1.28,
    ringK: 1.30,
    seamK: 0.82,
  });

  p.band(0.088, 0.150, 1.685, 1.725, {
    mat: 'steel',
    segs: 56,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(8),
    ringWeight: 1.72,
    k: 1.30,
  });
  p.pop();

  const wc = V(-0.340, 1.945, -0.160);
  const wr = 0.125;
  p.withWeight(2.05, () => {
    p.circle(wc, Y, wr, 1.52, 48);
    p.circle(wc, Y, wr * 0.78, 1.25, 40);
    p.circle(wc, Y, wr * 0.28, 1.45, 28);
  });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    p.seg(
      V(wc.x + Math.cos(a) * wr * 0.28, wc.y, wc.z + Math.sin(a) * wr * 0.28),
      V(wc.x + Math.cos(a) * wr * 0.98, wc.y, wc.z + Math.sin(a) * wr * 0.98),
      1.32,
      1.65
    );
  }

  return p;
}

function returnDuct(): Part {
  const p = new Part('returnDuct', { label: 'HIGH-PRESSURE DUCT', explode: [-0.12, 0.24, 0.22], anchor: [-0.08, 1.66, 0.10] });

  p.pipe(
    [
      V(PUMP.x + 0.11, 1.535, 0.04),
      V(-0.08, 1.635, 0.08),
      V(MAIN_X - 0.12, 1.735, 0.05),
    ],
    0.035,
    {
      mat: 'steel',
      smooth: true,
      k: 1.28,
      ringWeight: 1.62,
      ringsAt: [0.2, 0.4, 0.6, 0.8],
      seams: [0, Math.PI / 2, Math.PI, -Math.PI / 2],
    }
  );

  p.pipe(
    [
      V(PUMP.x + 0.11, 1.815, -0.04),
      V(-0.08, 1.745, -0.06),
      V(MAIN_X - 0.12, 1.665, -0.04),
    ],
    0.028,
    {
      mat: 'metal',
      smooth: true,
      k: 1.20,
      ringWeight: 1.52,
      ringsAt: [0.25, 0.5, 0.75],
      seams: [0, Math.PI],
    }
  );

  return p;
}

function mount(): Part {
  const p = new Part('mount', { label: 'GIMBAL MOUNT PLATE', explode: [-0.08, 0.52, 0], anchor: [-0.22, 1.96, 0.18] });

  const outline: [number, number][] = [
    [-0.43, -0.17],
    [-0.36, -0.26],
    [0.16, -0.25],
    [0.32, -0.11],
    [0.32, 0.15],
    [0.15, 0.25],
    [-0.36, 0.25],
    [-0.43, 0.15],
  ];
  const shape = shapeFromPoints(outline);
  shape.holes.push(circleHole(MAIN_X, 0.0, 0.152));
  shape.holes.push(circleHole(PUMP.x, PUMP.z, 0.118));

  p.pushAt(V(0, PLATE_Y, 0));
  p.withWeight(1.85, () => {
    p.plate(shape, 0.032, { mat: 'plate', k: 1.40, curveSegments: 36, holeK: 1.32 });
  });
  p.pop();

  const yTop = PLATE_Y + 0.033;
  const innerPts = outline.map(([x, z]) => V(x * 0.90, yTop, z * 0.90));
  p.withWeight(1.48, () => p.poly(innerPts, true, 1.18));

  p.withWeight(1.58, () => {
    p.circle(V(MAIN_X, yTop, 0.0), Y, 0.178, 1.25, 48);
    p.circle(V(PUMP.x, yTop, PUMP.z), Y, 0.142, 1.25, 40);
  });
  for (const [x, z] of outline) {
    const useMain = x > -0.08;
    const cx = useMain ? MAIN_X : PUMP.x;
    const cz = useMain ? 0.0 : PUMP.z;
    const r0 = useMain ? 0.178 : 0.142;
    const dx = x * 0.90 - cx;
    const dz = z * 0.90 - cz;
    const len = Math.hypot(dx, dz) || 1;
    p.seg(V(cx + (dx / len) * r0, yTop, cz + (dz / len) * r0), V(x * 0.90, yTop, z * 0.90), 1.08, 1.32);
  }

  p.cyl(V(-0.18, 1.94, -0.22), V(-0.12, 1.97, -0.52), 0.011, {
    mat: 'steel',
    k: 1.45,
    ringWeight: 1.68,
    seams: [0, Math.PI],
  });
  p.cyl(V(-0.13, 1.92, -0.22), V(-0.07, 1.95, -0.51), 0.011, {
    mat: 'steel',
    k: 1.45,
    ringWeight: 1.68,
    seams: [0, Math.PI],
  });
  for (const [x0, y0, z0, x1, y1, z1] of [
    [-0.17, 1.84, -0.20, -0.12, 1.84, -0.44],
    [-0.14, 1.79, -0.20, -0.09, 1.79, -0.42],
    [-0.11, 1.74, -0.20, -0.06, 1.74, -0.40],
  ] as const) {
    p.cyl(V(x0, y0, z0), V(x1, y1, z1), 0.0085, {
      mat: 'metal',
      k: 1.30,
      ringWeight: 1.48,
      seams: [0],
    });
  }

  return p;
}

function gimbal(): Part {
  const p = new Part('gimbal', { label: 'GIMBAL BEARING & CAGE', explode: [0, 0.78, 0], anchor: [0.05, 2.12, 0.14] });

  const cx = 0.042;
  const cz = 0.0;
  const rCage = 0.158;
  const y0 = PLATE_Y + 0.032;
  const y1 = 2.155;

  p.pushAt(V(cx, 0, cz));
  p.band(0.098, rCage, y1 - 0.020, y1, {
    mat: 'box',
    segs: 56,
    rings: [0, 1, 2, 3],
    seams: radialSeamAngles(16),
    ringWeight: MAJOR,
    k: 1.45,
  });
  p.band(0.098, rCage, y0, y0 + 0.018, {
    mat: 'metal',
    segs: 56,
    rings: [0, 1, 2, 3],
    ringWeight: 1.78,
    k: 1.35,
  });
  p.withWeight(1.58, () => p.circle(V(0, (y0 + y1) * 0.5, 0), Y, rCage * 0.99, 1.18, 56));
  p.pop();

  const nBars = 16;
  for (let i = 0; i < nBars; i++) {
    const a = (i / nBars) * TAU;
    const bx = cx + Math.cos(a) * rCage;
    const bz = cz + Math.sin(a) * rCage;
    p.seg(V(bx, y0, bz), V(bx, y1, bz), 1.32, 1.52);
  }
  p.withK(0, () => {
    p.withCadK(1, () => {
      p.cyl(V(cx, y0, cz), V(cx, y1 - 0.020, cz), rCage * 0.95, { mat: 'box', k: 0.85 });
    });
  });

  p.pushAt(V(-0.180, 0, 0.02));
  p.band(0.025, 0.058, y0, y0 + 0.028, {
    mat: 'metal',
    segs: 32,
    rings: [0, 1, 2, 3],
    ringWeight: 1.68,
    k: 1.30,
  });
  p.pop();
  p.cyl(V(-0.205, y0, 0.02), V(-0.185, 2.275, 0.02), 0.0115, {
    mat: 'steel',
    k: 1.48,
    ringWeight: 1.78,
    seams: [0, Math.PI],
  });
  p.cyl(V(-0.155, y0, 0.00), V(-0.088, 2.260, 0.00), 0.0115, {
    mat: 'steel',
    k: 1.48,
    ringWeight: 1.78,
    seams: [0, Math.PI],
  });

  const oc = V(0.225, 2.045, 0.245);
  p.torus(oc, V(0.35, 0.88, 0.30).normalize(), 0.044, 0.009, {
    mat: 'metal',
    k: 1.45,
  });
  p.seg(V(cx + rCage * 0.72, 2.045, cz + rCage * 0.68), V(oc.x - 0.030, oc.y, oc.z - 0.025), 1.18, 1.38);

  return p;
}

function harness(): Part {
  const p = new Part('harness', { label: 'SENSOR HARNESS', explode: [0.35, 0.05, 0.25], fadeOnExplode: true });
  p.withK(0, () => {
    p.withCadK(1, () => {
      p.pipe([V(0.18, 1.42, 0.10), V(0.22, 1.12, 0.08), V(0.22, 0.64, 0.05)], 0.008, {
        mat: 'copper',
        smooth: true,
        k: 0.75,
      });
    });
  });
  return p;
}

export function buildMerlin(): Part[] {
  return [
    nozzle(),
    manifold(),
    chamber(),
    exhaust(),
    injector(),
    turbopump(),
    returnDuct(),
    mount(),
    gimbal(),
    harness(),
  ];
}
