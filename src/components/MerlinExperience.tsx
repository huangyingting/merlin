'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GUI } from 'lil-gui';
import { Viewer, MODES, look, BG, type LookMode } from '@/engine/scene';
import { ModelControl, controlTuning } from '@/engine/control';
import { Gestures, gestureTuning, type GestureEventData, type HudState } from '@/engine/gestures';
import {
  HandTracker,
  Detector,
  startCamera,
  tuning as handTuning,
  poseNoise,
  type HandDetectionResult,
} from '@/engine/hands';
import { Hud } from '@/engine/hud';
import { Sfx } from '@/engine/audio';
import { MouseInput, type AppClock } from '@/engine/mouse';
import { synthResult, eulerQuat, seedNoise, type SynthHandSpec } from '@/engine/synthetic-hands';
import { demoHands } from '@/engine/demo';

type TestHandSpec = SynthHandSpec & { euler?: [number, number, number] };

interface MerlinSnapshot {
  mode: LookMode;
  input: 'none' | 'camera' | 'demo';
  hudState: HudState;
  gesture: string;
  hands: {
    id: number;
    open: number;
    isOpen: boolean;
    screen: number[];
    role: string;
  }[];
  quat: number[];
  scale: number;
  pos: number[];
  omega: number[];
  spinRevPerSec: number;
  explode: number;
  held: boolean;
}

interface MerlinDebugApi {
  viewer: Viewer;
  control: ModelControl;
  gestures: Gestures;
  tracker: HandTracker;
  hud: Hud;
  sfx: Sfx;
  clock: AppClock;
  state: {
    input: 'none' | 'camera' | 'demo';
    camera: 'off' | 'starting' | 'loading' | 'on' | 'error';
    warming: boolean;
    hudState: HudState;
    ui: 'full' | 'model';
    autoRotate: boolean;
    debug: boolean;
    demo: { t0: number; lastPush: number; loop?: number } | null;
    touched: boolean;
    t0: number;
  };
  mouse: MouseInput;
  snapshot: () => MerlinSnapshot;
  look: typeof look;
  BG: typeof BG;
  tuning: {
    control: typeof controlTuning;
    gesture: typeof gestureTuning;
    hands: typeof handTuning;
  };
  poseNoise: typeof poseNoise;
  readonly detector: Detector | null;
  test: {
    pushHands: (specs: TestHandSpec[], t?: number) => void;
    clearHands: (t?: number) => void;
    pause: () => void;
    resume: () => void;
    hidePanel: () => void;
    seedNoise: (s: number) => void;
  };
}

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number, opts?: { render?: boolean }) => void;
    __merlin?: MerlinDebugApi;
  }
}

const LOOK_LABELS: Record<LookMode, string> = {
  wire: 'wireframe',
  cad: 'CAD model',
  holo: 'hologram',
};

const EXPECTED_CAMERA_ERRORS = [
  'NotAllowedError',
  'SecurityError',
  'NotFoundError',
  'OverconstrainedError',
  'NotReadableError',
  'AbortError',
];

const SHORTCUTS = new Set(['1', '2', '3', 'e', 'r', 'h', 'm', 'c', ' ']);
const IDLE_S = 3;

function isLookMode(v: string | null): v is LookMode {
  return v === 'wire' || v === 'cad' || v === 'holo';
}

function normSpec(s: TestHandSpec): SynthHandSpec {
  const out: SynthHandSpec = { ...s };
  if (s.euler) out.quat = eulerQuat(s.euler[0], s.euler[1], s.euler[2]);
  return out;
}

export default function MerlinExperience() {
  const posterRef = useRef<HTMLImageElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const msgRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const lookBtnRef = useRef<HTMLButtonElement>(null);
  const explodeBtnRef = useRef<HTMLButtonElement>(null);
  const resetBtnRef = useRef<HTMLButtonElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLElement>(null);
  const helpMouseRef = useRef<HTMLElement>(null);
  const helpTouchRef = useRef<HTMLElement>(null);
  const debugRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const glCanvas = glRef.current;
    const hudCanvas = hudRef.current;
    const videoEl = camRef.current;
    const dockEl = dockRef.current;
    const msgEl = msgRef.current;
    const ctaEl = ctaRef.current;
    const statusEl = statusRef.current;
    const lookBtn = lookBtnRef.current;
    const explodeBtn = explodeBtnRef.current;
    const resetBtn = resetBtnRef.current;
    const helpBtn = helpBtnRef.current;
    const helpEl = helpRef.current;
    const helpMouseEl = helpMouseRef.current;
    const helpTouchEl = helpTouchRef.current;
    const debugEl = debugRef.current;
    const posterEl = posterRef.current;

    if (
      !glCanvas ||
      !hudCanvas ||
      !videoEl ||
      !dockEl ||
      !msgEl ||
      !ctaEl ||
      !statusEl ||
      !lookBtn ||
      !explodeBtn ||
      !resetBtn ||
      !helpBtn ||
      !helpEl ||
      !helpMouseEl ||
      !helpTouchEl ||
      !debugEl
    ) {
      return;
    }

    let disposed = false;
    document.body.dataset.ui = 'full';
    document.body.classList.add('booting');
    document.body.classList.remove('ready', 'idle');

    const params = new URLSearchParams(window.location.search);
    const DEV = params.get('dev') === '1' || params.get('debug') === '1';
    const dprParam = Number(params.get('dpr') || 0);

    // Place the poster where the first frame will draw the engine: centered above the dock
    if (posterEl) {
      if (params.get('mode') || params.get('poster') === '0') {
        posterEl.hidden = true;
      } else {
        posterEl.hidden = false;
        const h = window.innerHeight;
        const top = dockEl.getBoundingClientRect().top;
        const bare = params.get('ui') === 'model' || params.get('ui') === 'clean';
        const reserve = bare ? 0 : Math.max(0, Math.min(h - top + 8, h * 0.3));
        posterEl.style.setProperty('--lift', `${reserve / 2}px`);
      }
    }

    const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (TOUCH) {
      helpMouseEl.hidden = true;
      helpTouchEl.hidden = false;
    } else {
      helpMouseEl.hidden = false;
      helpTouchEl.hidden = true;
    }

    const HOVER = window.matchMedia('(hover: hover)').matches;

    const clock: AppClock = {
      manual: false,
      sim: 0,
      now() {
        return this.manual ? this.sim : performance.now() / 1000;
      },
    };

    const HOME = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.33, 0.5, 0, 'XYZ'));
    const control = new ModelControl(HOME);
    const viewer = new Viewer(glCanvas, control, Number.isFinite(dprParam) ? dprParam : 0);
    const hud = new Hud(hudCanvas, () => clock.now());
    const sfx = new Sfx();
    const tracker = new HandTracker();

    const state: MerlinDebugApi['state'] = {
      input: 'none',
      camera: 'off',
      warming: false,
      hudState: 'idle',
      ui: 'full',
      autoRotate: params.get('auto') === '1',
      debug: params.get('debug') === '1',
      demo: null,
      touched: false,
      t0: performance.now() / 1000,
    };

    function settleExplode(on: boolean, changed: boolean) {
      viewer.toggleExplode(on);
      if (!changed) return;
      if (on) control.frame();
      sfx.explode(on);
      viewer.flash(0.6);
      hud.burst(on);
    }

    function onEvent(type: string, data: GestureEventData & { source?: string }) {
      state.touched = true;
      if (type === 'grab') {
        sfx.grab();
        viewer.flash(0.5);
        viewer.sweepGlow();
      } else if (type === 'catch') {
        sfx.catch();
        viewer.flash(1.0);
        hud.shockwave();
      } else if (type === 'release') {
        const speed = data.speed ?? 0;
        sfx.release(speed);
        if (speed > 0.3) viewer.flash(0.35);
        hud.pulse(speed);
      } else if (type === 'two') {
        sfx.grab();
        viewer.flash(0.4);
      } else if (type === 'explode') {
        settleExplode(Boolean(data.on), true);
      } else if (type === 'fists') {
        if (data.phase === 'pull' && data.toward === 1) control.frame();
        else if (data.phase === 'end') settleExplode(data.end === 1, Boolean(data.changed));
      }
    }

    const gestures = new Gestures(
      control,
      {
        width: () => window.innerWidth,
        height: () => window.innerHeight,
        worldPerPixel: () => viewer.worldPerPixel(),
        originPx: () => viewer.originPx(),
        exploded: () => viewer.explodeTarget > 0.5,
        camAspect: () => tracker.aspect,
      },
      (type, data) => onEvent(type, { ...data, source: 'hand' })
    );

    const mouse = new MouseInput(hudCanvas, control, viewer, clock, (type, data) =>
      onEvent(type, { ...data, source: 'mouse' })
    );

    function onDetections(result: HandDetectionResult, t: number) {
      const tracks = tracker.update(result, t);
      state.hudState = gestures.update(tracks, t);
    }

    let detector: Detector | null = null;
    let camPermission: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((p) => {
        if (!disposed) camPermission = p;
      })
      .catch(() => {});

    function embeddedPage(): boolean {
      try {
        return window.origin === 'null' || window.self !== window.top;
      } catch {
        return true;
      }
    }

    function measureDock(instant = false) {
      const r = dockEl!.getBoundingClientRect();
      document.documentElement.style.setProperty('--dock-h', `${Math.round(r.height)}px`);
      viewer.setReserve(state.ui === 'model' ? 0 : window.innerHeight - r.top + 8, instant);
      viewer.controlsTop =
        state.ui === 'model' || document.body.classList.contains('booting') ? null : r.top;
    }

    function setCta(status: string, busy: boolean) {
      ctaEl!.setAttribute('aria-busy', busy ? 'true' : 'false');
      statusEl!.textContent = status;
    }

    function hideCta() {
      ctaEl!.hidden = true;
      ctaEl!.setAttribute('aria-busy', 'false');
      measureDock();
    }

    function cameraError(msg: string) {
      state.camera = 'error';
      msgEl!.textContent = msg;
      msgEl!.hidden = false;
      ctaEl!.hidden = false;
      setCta('', false);
      measureDock();
    }

    function trackingLive() {
      state.warming = false;
      sfx.boot();
      viewer.sweepGlow();
      msgEl!.hidden = true;
      hideCta();
      statusEl!.textContent = 'Hand tracking on';
    }

    function stopVideoTracks() {
      const stream = videoEl!.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      videoEl!.srcObject = null;
    }

    function cameraLost(why = 'camera') {
      if (disposed || state.camera !== 'on') return;
      detector?.stop();
      detector = null;
      stopVideoTracks();
      gestures.endFists();
      gestures.reset();
      tracker.clear();
      state.input = 'none';
      state.warming = false;
      const other = TOUCH ? 'use touch' : 'use the mouse';
      cameraError(
        why === 'tracking'
          ? `Hand tracking stopped. Check the connection and press Enable camera, or ${other}.`
          : `The camera disconnected. Reconnect it and press Enable camera, or ${other}.`
      );
      statusEl!.textContent = why === 'tracking' ? 'Hand tracking stopped' : 'Camera disconnected';
    }

    async function enableCamera() {
      sfx.init();
      if (state.camera === 'starting' || state.camera === 'loading' || state.camera === 'on') return;
      const other = TOUCH ? 'use touch' : 'use the mouse';
      if (!navigator.mediaDevices?.getUserMedia) {
        cameraError(`Camera is not available in this browser. You can still ${other}.`);
        return;
      }
      if (camPermission?.state === 'denied') {
        cameraError(
          embeddedPage()
            ? `Camera access is blocked in this preview. Open the published link, or ${other}.`
            : `Camera permission was denied. Allow it in your browser's site settings, or ${other}.`
        );
        return;
      }
      state.camera = 'starting';
      setCta('Starting camera', true);
      const nextDetector = new Detector(
        (res, t) => {
          if (disposed) return;
          if (state.warming) trackingLive();
          if (state.input === 'camera') onDetections(res, t);
        },
        (err) => console.warn('hand tracking error', err),
        { prefer: params.get('delegate') === 'cpu' ? 'CPU' : 'GPU', onLost: cameraLost }
      );
      detector = nextDetector;
      const camP = startCamera(videoEl!);
      const detP = nextDetector.init();
      detP.catch(() => {});
      try {
        await camP;
      } catch (err) {
        if (disposed) return;
        const name = (err as { name?: string } | null)?.name ?? '';
        if (!EXPECTED_CAMERA_ERRORS.includes(name)) console.warn(err);
        nextDetector.stop();
        if (detector === nextDetector) detector = null;
        const blocked = name === 'NotAllowedError' || name === 'SecurityError';
        const busy = name === 'NotReadableError' || name === 'AbortError';
        cameraError(
          blocked
            ? embeddedPage()
              ? `Camera access is blocked in this preview. Open the published link, or ${other}.`
              : `Camera permission was denied. Allow it in your browser's site settings, or ${other}.`
            : busy
              ? `The camera is in use by another app. Close it and try again, or ${other}.`
              : `No camera found. You can still ${other}.`
        );
        return;
      }
      if (disposed) {
        stopVideoTracks();
        nextDetector.stop();
        return;
      }
      tracker.aspect = videoEl!.videoWidth / videoEl!.videoHeight || 16 / 9;
      state.camera = 'loading';
      setCta('Loading hand tracking', true);
      try {
        await detP;
      } catch (err) {
        if (disposed) return;
        console.warn(err);
        nextDetector.stop();
        if (detector === nextDetector) detector = null;
        stopVideoTracks();
        cameraError(`Hand tracking failed to load. Check the connection, or ${other}.`);
        return;
      }
      if (disposed) {
        stopVideoTracks();
        nextDetector.stop();
        return;
      }
      state.camera = 'on';
      state.input = 'camera';
      state.warming = true;
      nextDetector.start(videoEl!);
    }

    function startDemo() {
      state.input = 'demo';
      state.demo = { t0: clock.now(), lastPush: 0 };
      tracker.aspect = 16 / 9;
      hideCta();
    }

    function runDemo(now: number) {
      const D = state.demo;
      if (!D || now - D.lastPush < 1 / 30 - 0.003) return;
      D.lastPush = now;
      const { hands, loop } = demoHands(now - D.t0);
      if (D.loop != null && loop !== D.loop) {
        gestures.reset();
        control.goHome(1e-3);
        viewer.toggleExplode(false);
        viewer.rescan();
      }
      D.loop = loop;
      onDetections(synthResult(hands, tracker.aspect), now);
    }

    let lastMs = performance.now();
    let fps = 60;
    const Y = new THREE.Vector3(0, 1, 0);
    const X = new THREE.Vector3(1, 0, 0);
    const _q = new THREE.Quaternion();
    const _qp = new THREE.Quaternion();
    let steps = 0;
    let domT = 0;

    const heard = { has: false, ls: 0, x: 0, y: 0, zoom: 0, slide: 0 };
    function motionSound(dt: number) {
      if (!sfx.ctx || !(dt > 0)) return;
      const ls = Math.log(control.scale);
      const { x, y } = control.pos;
      if (!heard.has) Object.assign(heard, { has: true, ls, x, y });
      const viewH = Math.max(1e-6, viewer.worldPerPixel() * viewer.h);
      const zoomRate = (ls - heard.ls) / dt;
      const slide = Math.hypot(x - heard.x, y - heard.y) / dt / viewH;
      Object.assign(heard, { ls, x, y });
      const k = 1 - Math.exp(-dt / 0.06);
      heard.zoom += (zoomRate - heard.zoom) * k;
      heard.slide += (slide - heard.slide) * k;
      const turn = control.held ? control.shownW.length() : 0;
      const pan = x / Math.max(1e-6, (viewH * viewer.camera.aspect) / 2);
      sfx.motion(turn, heard.zoom, control.scale, heard.slide, pan);
    }

    function idleDrift(now: number) {
      const t = now - state.t0;
      const ramp = THREE.MathUtils.smoothstep(t, 1.0, 3.5);
      const ph = (Math.PI * 2 * Math.max(0, t - 1.0)) / 14;
      _q.setFromAxisAngle(Y, 0.16 * ramp * Math.sin(ph));
      _qp.setFromAxisAngle(X, 0.035 * ramp * Math.sin(ph * 0.5 + 0.6) - 0.035 * ramp * Math.sin(0.6));
      control.q.copy(HOME).premultiply(_qp).premultiply(_q);
    }

    function endBoot() {
      if (!document.body.classList.contains('booting')) return;
      document.body.classList.remove('booting');
      measureDock();
    }

    function updateDom(dt: number) {
      domT += dt;
      if (domT < 0.1) return;
      domT = 0;
      const pressed = viewer.explodeTarget > 0.5 ? 'true' : 'false';
      if (explodeBtn!.getAttribute('aria-pressed') !== pressed) {
        explodeBtn!.setAttribute('aria-pressed', pressed);
      }
      const label = `Look: ${LOOK_LABELS[viewer.mode] ?? viewer.mode}`;
      if (lookBtn!.getAttribute('aria-label') !== label) {
        lookBtn!.setAttribute('aria-label', label);
      }
      if (lookBtn!.dataset.look !== viewer.mode) {
        lookBtn!.dataset.look = viewer.mode;
      }
      if (state.debug) {
        const d = detector;
        const lines = [
          `render ${fps.toFixed(0)} fps  dpr ${viewer.dpr.toFixed(2)}`,
          d
            ? `track ${d.fps.toFixed(0)} fps  ${d.inferMs.toFixed(1)} ms  ${d.kind ?? '-'} ${d.delegate ?? ''}`
            : 'track -',
          `state ${state.hudState}  input ${state.input}  camera ${state.camera}`,
          ...tracker.tracks.map(
            (t) =>
              `hand ${t.id} ${t.handed || '?'} open ${t.open.toFixed(2)} ${t.isOpen ? 'OPEN' : 'closed'} age ${t.age.toFixed(2)}`
          ),
          `omega ${control.omega.x.toFixed(2)} ${control.omega.y.toFixed(2)} ${control.omega.z.toFixed(2)}`,
          `spin ${(control.spinSpeed / (Math.PI * 2)).toFixed(2)} rev/s  scale ${control.scale.toFixed(2)}`,
          `segments ${viewer.stats.segments}  tris ${Math.round(viewer.stats.triangles)}`,
        ];
        debugEl!.textContent = lines.join('\n');
      }
    }

    function step(dt: number, render = true) {
      steps++;
      const now = clock.now();
      if (state.input === 'demo') runDemo(now);
      if (state.input === 'none') {
        state.hudState = mouse.busy
          ? mouse.mode === 'pinch' || mouse.mode === 'pan'
            ? 'two'
            : 'grab'
          : control.spinSpeed > 0.3
            ? 'spin'
            : 'idle';
      }
      if (state.autoRotate && !control.held && control.spinSpeed < 0.05 && !control.reset) {
        control.q.premultiply(_q.setFromAxisAngle(Y, 0.22 * dt));
      } else if (
        !state.touched &&
        !state.autoRotate &&
        !control.held &&
        !control.reset &&
        control.spinSpeed === 0
      ) {
        idleDrift(now);
      }
      gestures.follow(now);
      const fist = gestures.fist?.armed ? gestures.fist : null;
      viewer.explodeLive = !!fist;
      if (fist) viewer.explodeTarget = fist.amount;
      control.bounds = viewer.centerBounds(controlTuning.bounds);
      control.fit = viewer.fitRange(controlTuning.margin);
      control.step(dt, now);
      viewer.update(dt);
      if (!viewer.trans) endBoot();
      updateDom(dt);
      if (!render) return;
      hud.draw(dt, {
        tracks: state.input === 'camera' || state.input === 'demo' ? tracker.tracks : [],
        gestures,
        viewer,
        control,
        now,
        resultT: tracker.lastResultT,
        aspect: tracker.aspect,
      });
      viewer.render(dt);
      sfx.spin(control.spinSpeed);
      sfx.stretch(viewer.explode, fist ? viewer.explodeVel : 0);
      motionSound(dt);
    }

    let rafId = 0;
    function frame(ms: number) {
      if (disposed) return;
      rafId = requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0, (ms - lastMs) / 1000));
      lastMs = ms;
      if (clock.manual) return;
      if (dt > 0) fps = fps * 0.95 + (1 / dt) * 0.05;
      step(dt);
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let helpHideTimer: ReturnType<typeof setTimeout> | null = null;
    let posterTimer: ReturnType<typeof setTimeout> | null = null;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;

    function goIdle() {
      if (disposed) return;
      if (
        !helpEl!.hidden ||
        dockEl!.querySelector(':focus-visible') ||
        (HOVER && dockEl!.matches(':hover'))
      ) {
        wake();
        return;
      }
      document.body.classList.add('idle');
    }

    function wake() {
      if (disposed) return;
      document.body.classList.remove('idle');
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(goIdle, IDLE_S * 1000);
    }

    function showHelp() {
      if (helpHideTimer !== null) {
        clearTimeout(helpHideTimer);
        helpHideTimer = null;
      }
      measureDock();
      helpEl!.hidden = false;
      helpBtn!.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => {
        if (!disposed) helpEl!.classList.add('show');
      });
      wake();
    }

    function hideHelp() {
      helpEl!.classList.remove('show');
      helpBtn!.setAttribute('aria-expanded', 'false');
      if (helpHideTimer !== null) clearTimeout(helpHideTimer);
      helpHideTimer = setTimeout(() => {
        if (!disposed && !helpEl!.classList.contains('show')) helpEl!.hidden = true;
      }, 260);
      wake();
    }

    const onOutsidePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (helpEl.hidden || (target && (helpEl.contains(target) || helpBtn.contains(target)))) return;
      hideHelp();
      if (e.target === mouse.el) e.stopPropagation();
    };
    window.addEventListener('pointerdown', onOutsidePointerDown, true);

    const wakeEvents = ['pointermove', 'pointerdown', 'wheel', 'touchstart'] as const;
    for (const type of wakeEvents) {
      window.addEventListener(type, wake, { passive: true });
    }

    const onControl = () =>
      Boolean(
        document.activeElement?.closest?.('button, a, input, .help') &&
          document.activeElement !== document.body
      );

    const onWakeKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !SHORTCUTS.has(e.key.toLowerCase()) || onControl()) {
        wake();
      }
    };
    window.addEventListener('keydown', onWakeKeyDown, { passive: true });

    function applyUi() {
      document.body.dataset.ui = state.ui;
      hud.visible = state.ui !== 'model';
      if (state.ui === 'model' && !helpEl!.hidden) hideHelp();
      measureDock();
    }

    function setMode(m: LookMode) {
      if (viewer.setMode(m)) sfx.mode();
    }

    function act(name: string) {
      if (name === 'explode' || name === 'reset') state.touched = true;
      if (name === 'look') setMode(MODES[(MODES.indexOf(viewer.mode) + 1) % MODES.length]);
      else if (name === 'explode') {
        const was = viewer.explodeTarget > 0.5;
        gestures.fist = null;
        const out = viewer.toggleExplode(!was);
        if (out) control.frame();
        sfx.explode(out);
      } else if (name === 'reset') {
        control.goHome();
        gestures.reset();
        const was = viewer.explodeTarget > 0.5;
        viewer.toggleExplode(false);
        if (was) sfx.explode(false);
      } else if (name === 'hide') {
        state.ui = state.ui === 'full' ? 'model' : 'full';
        applyUi();
        if (state.ui === 'full') wake();
      } else if (name === 'help') {
        if (helpEl!.hidden) showHelp();
        else hideHelp();
      }
    }

    const ctlButtons: [HTMLButtonElement, string][] = [
      [lookBtn, 'look'],
      [explodeBtn, 'explode'],
      [resetBtn, 'reset'],
      [helpBtn, 'help'],
    ];
    const ctlListeners = ctlButtons.map(([btn, actionName]) => {
      const handler = (e: MouseEvent) => {
        sfx.init();
        act(actionName);
        if (e.detail > 0) btn.blur();
      };
      btn.addEventListener('click', handler);
      return [btn, handler] as const;
    });

    let gui: GUI | null = null;
    async function openTuning() {
      if (gui) {
        gui.show(gui._hidden);
        return;
      }
      const { GUI: LilGUI } = await import('lil-gui');
      if (disposed) return;
      gui = new LilGUI({ title: 'Tuning' });
      const h = gui.addFolder('Hands');
      h.add(handTuning, 'openOn', 0.4, 0.95, 0.01);
      h.add(handTuning, 'openOff', 0.3, 0.9, 0.01);
      h.add(handTuning, 'reach', 1, 2, 0.01);
      h.add(handTuning, 'oriStill', 0.05, 1, 0.01).name('rotation memory (s)');
      h.add(handTuning, 'oriFast', 0.005, 0.2, 0.005).name('manoeuvre memory (s)');
      h.add(handTuning, 'oriT0', 0.2, 4, 0.05).name('manoeuvre threshold');
      h.add(handTuning, 'oriS0', 0.1, 3, 0.05).name('stop threshold');
      h.add(handTuning, 'oriNMax', 1, 4, 0.1).name('still smoothing');
      h.add(handTuning, 'predictMax', 0, 0.1, 0.005).name('prediction (s)');
      h.add(handTuning, 'posStill', 0.05, 1, 0.01);
      h.add(handTuning, 'posFast', 0.005, 0.2, 0.005);
      const c = gui.addFolder('Physics');
      c.add(controlTuning, 'gain', 0.5, 3, 0.01).name('rotation gain');
      c.add(controlTuning, 'holdWn', 10, 120, 1).name('hold stiffness');
      c.add(controlTuning, 'spinTau', 0.5, 30, 0.1).name('spin decay (s)');
      c.add(controlTuning, 'maxSpin', 1, 20, 0.1);
      c.add(controlTuning, 'minSpin', 0, 1, 0.01);
      c.add(controlTuning, 'zoomExp', 0.5, 2.5, 0.01);
      c.add(gestureTuning, 'releaseWindow', 0.04, 0.3, 0.005);
      const l = gui.addFolder('Look');
      l.add(look, 'lineWidth', 0.5, 4, 0.05).onChange(() => viewer.resize());
      l.add(look.bloom.wire, '0', 0, 3, 0.01).name('wire bloom');
      l.add(look.bloom.wire, '1', 0, 1, 0.01).name('wire bloom radius');
      l.add(look.bloom.wire, '2', 0, 1, 0.01).name('wire bloom threshold');
      l.add(look.bloom.holo, '0', 0, 3, 0.01).name('holo bloom');
      l.add(look, 'occluded', 0, 1, 0.01).name('hidden lines');
      l.add(look, 'occludedDeep', 0, 30, 0.5).name('hidden lines depth fade');
      l.add(viewer.renderer, 'toneMappingExposure', 0.3, 3, 0.01).name('exposure');
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === '1' || k === '2' || k === '3') setMode(MODES[Number(k) - 1]);
      else if (k === 'e') act('explode');
      else if (k === 'r') act('reset');
      else if (k === 'h') act('hide');
      else if (k === 'c' && !ctaEl.hidden) void enableCamera();
      else if (k === 'm') {
        sfx.init();
        sfx.toggleMute();
      } else if (DEV && k === 'd') {
        state.debug = !state.debug;
        debugEl.hidden = !state.debug;
      } else if (DEV && k === 'a') {
        state.autoRotate = !state.autoRotate;
      } else if (DEV && k === 'g') {
        void openTuning();
      } else if (k === '?' || k === '/') {
        act('help');
      } else if (k === 'escape' && !helpEl.hidden) {
        hideHelp();
      } else if (k === ' ' && !onControl()) {
        state.touched = true;
        control.stop();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    const onResize = () => {
      viewer.resize();
      hud.resize();
      measureDock();
    };
    window.addEventListener('resize', onResize);

    const onCtaClick = () => {
      void enableCamera();
    };
    ctaEl.addEventListener('click', onCtaClick);

    const unlockAudio = () => sfx.init();
    window.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
    window.addEventListener('keydown', unlockAudio, { once: true, passive: true });

    debugEl.hidden = !state.debug;
    applyUi();
    const modeParam = params.get('mode');
    if (isLookMode(modeParam)) viewer.setMode(modeParam);
    else viewer.boot();
    if (params.get('ui') === 'model' || params.get('ui') === 'clean') {
      state.ui = 'model';
      applyUi();
    }
    if (params.get('demo') === '1') startDemo();
    else if (params.get('input') === 'mouse') hideCta();
    measureDock(true);

    rafId = requestAnimationFrame((ms) => {
      if (disposed) return;
      frame(ms);
      document.body.classList.add('ready');
      posterTimer = setTimeout(() => {
        if (!disposed && posterEl) posterEl.hidden = true;
      }, 600);
      let seen = steps;
      const bootFallback = () => {
        if (disposed || !document.body.classList.contains('booting')) return;
        if (viewer.trans && (steps > seen || clock.manual)) {
          seen = steps;
          bootTimer = setTimeout(bootFallback, 1000);
        } else {
          endBoot();
        }
      };
      bootTimer = setTimeout(bootFallback, 4000);
      wake();
    });

    function snapshot(): MerlinSnapshot {
      const q = control.q;
      return {
        mode: viewer.mode,
        input: state.input,
        hudState: state.hudState,
        gesture: gestures.state,
        hands: tracker.tracks.map((t) => ({
          id: t.id,
          open: +t.open.toFixed(3),
          isOpen: t.isOpen,
          screen: t.screen.map((v) => +v.toFixed(3)),
          role: gestures.roleOf(t.id),
        })),
        quat: [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(4)),
        scale: +control.scale.toFixed(3),
        pos: control.pos.toArray().map((v) => +v.toFixed(3)),
        omega: control.omega.toArray().map((v) => +v.toFixed(3)),
        spinRevPerSec: +(control.spinSpeed / (Math.PI * 2)).toFixed(3),
        explode: +viewer.explode.toFixed(3),
        held: control.held,
      };
    }

    window.render_game_to_text = () => JSON.stringify(snapshot());
    window.advanceTime = (ms: number, opts: { render?: boolean } = {}) => {
      if (!clock.manual) {
        clock.manual = true;
        clock.sim = performance.now() / 1000;
      }
      const n = Math.max(1, Math.round(ms / (1000 / 60)));
      for (let i = 0; i < n; i++) {
        clock.sim += 1 / 60;
        step(1 / 60, i === n - 1 && opts.render !== false);
      }
    };
    window.__merlin = {
      viewer,
      control,
      gestures,
      tracker,
      hud,
      sfx,
      clock,
      state,
      mouse,
      snapshot,
      look,
      BG,
      tuning: { control: controlTuning, gesture: gestureTuning, hands: handTuning },
      poseNoise,
      get detector() {
        return detector;
      },
      test: {
        pushHands(specs: TestHandSpec[], t = clock.now()) {
          if (state.input !== 'demo') state.input = 'camera';
          onDetections(synthResult(specs.map(normSpec), tracker.aspect), t);
        },
        clearHands(t = clock.now()) {
          onDetections({ landmarks: [], worldLandmarks: [], handedness: [] }, t);
        },
        pause() {
          clock.manual = true;
          clock.sim = performance.now() / 1000;
        },
        resume() {
          clock.manual = false;
        },
        hidePanel: hideCta,
        seedNoise,
      },
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (helpHideTimer !== null) clearTimeout(helpHideTimer);
      if (posterTimer !== null) clearTimeout(posterTimer);
      if (bootTimer !== null) clearTimeout(bootTimer);

      window.removeEventListener('pointerdown', onOutsidePointerDown, true);
      for (const type of wakeEvents) {
        window.removeEventListener(type, wake);
      }
      window.removeEventListener('keydown', onWakeKeyDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      ctaEl.removeEventListener('click', onCtaClick);
      for (const [btn, handler] of ctlListeners) {
        btn.removeEventListener('click', handler);
      }

      detector?.stop();
      detector = null;
      stopVideoTracks();
      gui?.destroy();
      gui = null;
      mouse.dispose();
      sfx.dispose();
      viewer.dispose();

      delete window.render_game_to_text;
      delete window.advanceTime;
      delete window.__merlin;
    };
  }, []);

  return (
    <>
      <h1 className="sr-only">Merlin 1D hand control</h1>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={posterRef}
        id="poster"
        src="/poster.webp"
        alt=""
        aria-hidden="true"
        fetchPriority="high"
      />
      <canvas ref={glRef} id="gl" role="img" aria-label="Merlin 1D rocket engine model" />
      <canvas ref={hudRef} id="hud" aria-hidden="true" />
      <video ref={camRef} id="cam" playsInline muted aria-hidden="true" />

      <div ref={dockRef} className="dock" id="dock">
        <p ref={msgRef} className="msg" id="cam-msg" role="alert" hidden />
        <button ref={ctaRef} id="btn-camera" className="cta" type="button">
          Enable camera
        </button>
        <p ref={statusRef} className="sr-only" id="cam-status" aria-live="polite" />
        <nav className="controls" id="controls" aria-label="Model controls">
          <button
            ref={lookBtnRef}
            type="button"
            className="ctl look-btn"
            data-act="look"
            data-look="wire"
            aria-label="Look: wireframe"
          >
            Look
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </button>
          <button
            ref={explodeBtnRef}
            type="button"
            className="ctl"
            data-act="explode"
            aria-pressed="false"
          >
            Explode
          </button>
          <button ref={resetBtnRef} type="button" className="ctl" data-act="reset">
            Reset
          </button>
          <button
            ref={helpBtnRef}
            type="button"
            className="ctl help-btn"
            data-act="help"
            aria-label="Controls help"
            aria-expanded="false"
            aria-controls="help"
          >
            ?
          </button>
        </nav>
      </div>

      <aside ref={helpRef} className="help" id="help" aria-label="Controls help" hidden>
        <section>
          <h2>Hands</h2>
          <dl>
            <div>
              <dt>Open hand (active)</dt>
              <dd>Move or tilt to rotate</dd>
            </div>
            <div>
              <dt>Closed fist (inactive)</dt>
              <dd>Disengage and reposition</dd>
            </div>
            <div>
              <dt>Flick and close fist</dt>
              <dd>Spin with momentum</dd>
            </div>
            <div>
              <dt>Open hand on a spin</dt>
              <dd>Catch</dd>
            </div>
            <div>
              <dt>Two open hands</dt>
              <dd>Zoom, move, roll</dd>
            </div>
          </dl>
        </section>
        <section ref={helpMouseRef} id="help-mouse">
          <h2>Mouse</h2>
          <dl>
            <div>
              <dt>Drag</dt>
              <dd>Turn</dd>
            </div>
            <div>
              <dt>Flick and let go</dt>
              <dd>Spin</dd>
            </div>
            <div>
              <dt>Click a spin</dt>
              <dd>Catch</dd>
            </div>
            <div>
              <dt>Scroll</dt>
              <dd>Zoom</dd>
            </div>
            <div>
              <dt>Right-drag</dt>
              <dd>Move</dd>
            </div>
          </dl>
        </section>
        <section ref={helpTouchRef} id="help-touch" hidden>
          <h2>Touch</h2>
          <dl>
            <div>
              <dt>Drag</dt>
              <dd>Turn</dd>
            </div>
            <div>
              <dt>Flick and let go</dt>
              <dd>Spin</dd>
            </div>
            <div>
              <dt>Tap a spin</dt>
              <dd>Catch</dd>
            </div>
            <div>
              <dt>Pinch</dt>
              <dd>Zoom</dd>
            </div>
            <div>
              <dt>Two-finger drag</dt>
              <dd>Move</dd>
            </div>
          </dl>
        </section>
        <section id="help-keys">
          <h2>Keys</h2>
          <dl>
            <div>
              <dt>
                <kbd>C</kbd>
              </dt>
              <dd>Enable camera</dd>
            </div>
            <div>
              <dt>
                <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>
              </dt>
              <dd>Look</dd>
            </div>
            <div>
              <dt>
                <kbd>E</kbd>
              </dt>
              <dd>Explode</dd>
            </div>
            <div>
              <dt>
                <kbd>R</kbd>
              </dt>
              <dd>Reset</dd>
            </div>
            <div>
              <dt>
                <kbd>H</kbd>
              </dt>
              <dd>Hide overlays</dd>
            </div>
            <div>
              <dt>
                <kbd>M</kbd>
              </dt>
              <dd>Sound on or off</dd>
            </div>
            <div>
              <dt>
                <kbd>Space</kbd>
              </dt>
              <dd>Stop a spin</dd>
            </div>
          </dl>
        </section>
        <p className="note">Camera video stays on this device.</p>
      </aside>

      <pre ref={debugRef} className="debug" id="debug" hidden />
    </>
  );
}
