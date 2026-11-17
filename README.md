# Merlin 1D — Hand Control (Next.js)

Interactive 3D SpaceX Merlin 1D rocket engine viewer with webcam MediaPipe hand tracking, procedural CAD geometry, custom X-ray wireframe & hologram shaders, rotational spring/inertia physics, holographic 2D HUD, and procedural Web Audio sound synthesis — built with **Next.js 16.4.6** (App Router, React 19, TypeScript) and **Three.js**.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For an optimized static production export (`./out`):

```bash
npm run build
npx serve out
```

When deploying under a subpath (such as GitHub Pages `/merlin`), set `NEXT_PUBLIC_BASE_PATH=/merlin` at build time (configured automatically in `.github/workflows/deploy.yml`).

## Controls

- **Webcam Hands** (`C` or **Enable camera**):
  - **Open hand**: Move or tilt to rotate
  - **Closed fist**: Disengage and reposition
  - **Flick & close fist**: Spin with momentum
  - **Open hand on a spin**: Catch
  - **Two open hands**: Spread to zoom, move to pan, twist to roll
- **Mouse / Touch**: Drag to rotate, flick to spin, click/tap to catch, scroll/pinch to zoom, right-drag / two-finger drag to pan.
- **Keyboard**: `1` `2` `3` Look (`Wireframe` / `CAD` / `Hologram`), `E` Explode, `R` Reset, `H` Hide overlays, `M` Mute/unmute sound, `Space` Stop spin, `?` Help.
- **Query Flags**: `?demo=1` (synthetic hand choreography), `?mode=wire|cad|holo`, `?ui=model`, `?debug=1`, `?dev=1` (`D` readout, `A` auto-rotate, `G` tuning GUI), `?delegate=cpu`.
