import * as THREE from 'three';

export const lineUniforms = {
  uResolution: { value: new THREE.Vector2(1, 1) },
  uWidth: { value: 1.6 },
  uDepthNear: { value: 4 },
  uDepthFar: { value: 8 },
  uFarFade: { value: 0.22 },
  uTime: { value: 0 },
  uPulse: { value: 0 },
  uClip: { value: new THREE.Vector4(0, 1, 0, 1e5) },
  uScanGlow: { value: 0 },
  uGhost: { value: 0 },
  uOccDepth: { value: null as THREE.DepthTexture | null },
  uNearFar: { value: new THREE.Vector2(0.1, 100) },
  uOcc: { value: new THREE.Vector4(0, 0.02, 0.06, 0) },
};

const vert = /* glsl */ `
uniform vec2 uResolution;
uniform float uWidth;
uniform float uWidthScale;
uniform float uDepthNear;
uniform float uDepthFar;
uniform float uFarFade;
uniform float uDepthBias;
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute float instanceIntensity;
attribute float instanceWeight;
varying float vSide;
varying float vHalfW;
varying float vIntensity;
varying float vFade;
varying vec3 vWorld;
void main() {
  vec4 wS = modelMatrix * vec4(instanceStart, 1.0);
  vec4 wE = modelMatrix * vec4(instanceEnd, 1.0);
  vec4 vS = viewMatrix * wS;
  vec4 vE = viewMatrix * wE;
  float nearZ = -0.06;
  if (vS.z > nearZ && vE.z > nearZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (vS.z > nearZ) vS.xyz = mix(vE.xyz, vS.xyz, (vE.z - nearZ) / (vE.z - vS.z));
  if (vE.z > nearZ) vE.xyz = mix(vS.xyz, vE.xyz, (vS.z - nearZ) / (vS.z - vE.z));
  vS.z += uDepthBias;
  vE.z += uDepthBias;
  vec4 cS = projectionMatrix * vS;
  vec4 cE = projectionMatrix * vE;
  vec2 half_res = 0.5 * uResolution;
  vec2 sS = cS.xy / cS.w * half_res;
  vec2 sE = cE.xy / cE.w * half_res;
  vec2 d = sE - sS;
  float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  bool isEnd = position.x > 0.5;
  vec4 c = isEnd ? cE : cS;
  float hw = 0.5 * uWidth * uWidthScale * instanceWeight;
  float ext = hw + 1.0;
  c.xy += nrm * position.y * ext / half_res * c.w;
  gl_Position = c;
  vSide = position.y * ext;
  vHalfW = hw;
  vIntensity = instanceIntensity;
  float z = -(isEnd ? vE.z : vS.z);
  vFade = mix(1.0, uFarFade, smoothstep(uDepthNear, uDepthFar, z));
#ifdef CAD_EDGES
  vFade = 1.0;
#endif
  vWorld = isEnd ? wE.xyz : wS.xyz;
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uPulse;
uniform vec4 uClip;
uniform float uClipSign;
uniform float uScanGlow;
uniform float uTime;
uniform float uFlicker;
uniform float uGhost;
uniform vec2 uFloor;
#ifdef OCCLUDE
uniform vec2 uResolution;
uniform sampler2D uOccDepth;
uniform vec2 uNearFar;
uniform vec4 uOcc;
float viewDepth(float d) {
  float n = uNearFar.x;
  float f = uNearFar.y;
  return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n));
}
#endif
varying float vSide;
varying float vHalfW;
varying float vIntensity;
varying float vFade;
varying vec3 vWorld;
void main() {
  float dist = dot(uClip.xyz, vWorld) + uClip.w;
  float ghost = 1.0;
  if (uClipSign * dist < 0.0) {
    if (uGhost <= 0.0) discard;
    ghost = uGhost;
  }
  float a = clamp(vHalfW + 0.5 - abs(vSide), 0.0, 1.0);
  if (uFloor.x >= 0.0) a *= smoothstep(uFloor.x, uFloor.x + uFloor.y, gl_FragCoord.y);
  if (a <= 0.0) discard;
  float k = vIntensity * vFade * uOpacity * a * (1.0 + uPulse) * ghost;
#ifdef OCCLUDE
  if (uOcc.x > 0.0) {
    float d = texture2D(uOccDepth, gl_FragCoord.xy / uResolution).x;
    if (d < 1.0) {
      float dz = viewDepth(gl_FragCoord.z) - viewDepth(d);
      float keep = (1.0 - uOcc.x) * exp(-max(0.0, dz - uOcc.y - uOcc.z) * uOcc.w);
      k *= mix(1.0, keep, smoothstep(uOcc.y, uOcc.y + uOcc.z, dz));
    }
  }
#endif
#ifdef CAD_EDGES
  gl_FragColor = vec4(uColor, clamp(pow(max(0.0, vIntensity), 0.7) * uOpacity * a, 0.0, 1.0));
  return;
#endif
  float scan = uScanGlow * exp(-pow(dist / 0.035, 2.0)) * 6.0;
  float flick = 1.0;
  if (uFlicker > 0.0) {
    float band = sin(vWorld.y * 60.0 - uTime * 7.0) * 0.5 + 0.5;
    flick = 1.0 - uFlicker * (0.35 * band + 0.15 * sin(uTime * 53.0));
  }
#ifdef NORMAL_BLEND
  gl_FragColor = vec4(uColor * (1.0 + scan), clamp(k * flick + scan * a, 0.0, 1.0));
#else
  vec3 col = uColor * k * flick + vec3(0.6, 0.95, 1.0) * scan * a * uOpacity;
  gl_FragColor = vec4(col, 1.0);
#endif
}
`;

export interface LineMaterialOptions {
  blend?: 'normal' | 'additive';
  opacity?: number;
  flicker?: number;
  depthBias?: number;
  widthScale?: number;
  cadEdges?: boolean;
  occlude?: boolean;
  depthTest?: boolean;
}

export function makeLineMaterial(color: THREE.ColorRepresentation, opts: LineMaterialOptions = {}): THREE.ShaderMaterial {
  const normal = opts.blend === 'normal';
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...lineUniforms,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opts.opacity ?? 1 },
      uClipSign: { value: 0 },
      uFlicker: { value: opts.flicker ?? 0 },
      uDepthBias: { value: opts.depthBias ?? 0 },
      uWidthScale: { value: opts.widthScale ?? 1 },
      uFloor: { value: new THREE.Vector2(-1, 1) },
    },
    defines: {
      ...(normal ? { NORMAL_BLEND: 1 } : {}),
      ...(opts.cadEdges ? { CAD_EDGES: 1 } : {}),
      ...(opts.occlude ? { OCCLUDE: 1 } : {}),
    },
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthTest: opts.depthTest ?? false,
    depthWrite: false,
    blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
  mat.toneMapped = false;
  return mat;
}

export function makeFatLines(
  segs: Float32Array,
  inten: Float32Array,
  material: THREE.ShaderMaterial,
  weights: Float32Array | null = null
): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
  geo.setIndex([0, 2, 1, 2, 3, 1]);
  const ib = new THREE.InstancedInterleavedBuffer(segs, 6, 1);
  geo.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  geo.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  geo.setAttribute('instanceIntensity', new THREE.InstancedBufferAttribute(inten, 1));
  geo.setAttribute('instanceWeight', new THREE.InstancedBufferAttribute(weights ?? new Float32Array(inten.length).fill(1), 1));
  geo.instanceCount = segs.length / 6;
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}
