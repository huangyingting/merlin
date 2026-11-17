import * as THREE from 'three';
import { quatToRotVec } from './filters';
import { controlTuning, type ModelControl } from './control';
import type { Viewer } from './scene';

const RAD_PER_PX = 0.0085;

export interface AppClock {
  manual: boolean;
  sim: number;
  now: () => number;
}

export class MouseInput {
  el: HTMLElement;
  control: ModelControl;
  viewer: Viewer;
  clock: AppClock;
  emit: (type: string, data: { speed?: number; x: number; y: number }) => void;
  enabled = true;
  pointers = new Map<number, { x: number; y: number }>();
  vq = new THREE.Quaternion();
  hist: { t: number; q: THREE.Quaternion }[] = [];
  mode: 'rotate' | 'pan' | 'pinch' | 'pinch-end' | null = null;
  pinch: { d0: number; m0: [number, number]; s0: number; p0: THREE.Vector3 } | null = null;
  last = { x: 0, y: 0 };
  private _cleanup: () => void;

  constructor(
    el: HTMLElement,
    control: ModelControl,
    viewer: Viewer,
    clock: AppClock,
    emit: (type: string, data: { speed?: number; x: number; y: number }) => void = () => {}
  ) {
    this.el = el;
    this.control = control;
    this.viewer = viewer;
    this.clock = clock;
    this.emit = emit;

    const onDown = (e: PointerEvent) => this.down(e);
    const onMove = (e: PointerEvent) => this.move(e);
    const onUp = (e: PointerEvent) => this.up(e);
    const onWheel = (e: WheelEvent) => this.wheel(e);
    const onContext = (e: MouseEvent) => e.preventDefault();

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);

    this._cleanup = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
    };
  }

  get busy(): boolean {
    return this.pointers.size > 0;
  }

  stamp(e: PointerEvent): number {
    const ts = e.timeStamp / 1000;
    if (this.clock.manual || !(ts > 0)) return this.clock.now();
    return Math.min(ts, this.clock.now());
  }

  down(e: PointerEvent): void {
    if (!this.enabled) return;
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore NotFoundError/InvalidStateError on synthetic or already-released pointers
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = this.stamp(e);
    if (this.pointers.size === 2) {
      if (this.mode === 'rotate') this.control.release(null);
      const [a, b] = [...this.pointers.values()];
      this.mode = 'pinch';
      this.control.beginDrag();
      this.pinch = {
        d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)),
        m0: [(a.x + b.x) / 2, (a.y + b.y) / 2],
        s0: this.control.scaleTarget,
        p0: this.control.posTarget.clone(),
      };
      return;
    }
    if (this.pointers.size > 2) return;
    const pan = e.button === 2 || e.button === 1 || e.shiftKey;
    if (pan) {
      this.mode = 'pan';
      this.control.beginDrag();
      this.last = { x: e.clientX, y: e.clientY };
      return;
    }
    this.mode = 'rotate';
    this.vq.identity();
    this.hist = [{ t, q: this.vq.clone() }];
    const caught = this.control.grab(this.vq, t, 1, { wn: controlTuning.pointerWn });
    this.emit(caught ? 'catch' : 'grab', { x: e.clientX, y: e.clientY });
    this.last = { x: e.clientX, y: e.clientY };
  }

  move(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = this.stamp(e);
    if (this.mode === 'rotate') {
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const axis = new THREE.Vector3(dy / len, dx / len, 0);
        const dq = new THREE.Quaternion().setFromAxisAngle(axis, len * RAD_PER_PX);
        this.vq.premultiply(dq).normalize();
      }
      this.control.drive(this.vq, t);
      this.hist.push({ t, q: this.vq.clone() });
      while (this.hist.length > 2 && t - this.hist[0].t > 0.25) this.hist.shift();
    } else if (this.mode === 'pan') {
      const wpp = this.viewer.worldPerPixel();
      this.control.panBy(new THREE.Vector3((e.clientX - this.last.x) * wpp, -(e.clientY - this.last.y) * wpp, 0));
      this.last = { x: e.clientX, y: e.clientY };
    } else if (this.mode === 'pinch' && this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const P = this.pinch;
      const d = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
      const m: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const wpp = this.viewer.worldPerPixel();
      this.control.setTwoHand(P.s0 * (d / P.d0), P.p0.clone().add(new THREE.Vector3((m[0] - P.m0[0]) * wpp, -(m[1] - P.m0[1]) * wpp, 0)));
    }
  }

  up(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const t = this.stamp(e);
    if (this.mode === 'rotate') {
      const recent = this.hist.filter((h) => t - h.t <= 0.09);
      let w = new THREE.Vector3();
      if (recent.length >= 2 && t - recent[recent.length - 1].t < 0.05) {
        const a = recent[0];
        const b = recent[recent.length - 1];
        const dt = Math.max(0.016, b.t - a.t);
        const dq = b.q.clone().multiply(a.q.clone().invert());
        w = quatToRotVec(dq).multiplyScalar(1 / dt);
      }
      const speed = this.control.release(w);
      this.emit('release', { speed, x: e.clientX, y: e.clientY });
    }
    if (this.pointers.size === 0) {
      if (this.mode !== 'rotate') this.control.endDrag();
      this.mode = null;
    } else if (this.mode === 'pinch') this.mode = 'pinch-end';
  }

  wheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.control.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.001)));
  }

  dispose(): void {
    this._cleanup();
  }
}
