import { FluidSimulation } from './physics/fluidSim';
import { computeViewportTransform, ViewportTransform } from './types';
import { FountainUI } from './ui';
import { FountainRenderer } from './webgl/renderer';

declare global {
  interface Window {
    __fountain?: {
      sim: FluidSimulation;
      renderer: FountainRenderer;
      ui: FountainUI;
      stepFrames: (frames: number, dt?: number) => void;
    };
  }
}

function initApp(): void {
  const canvas = document.getElementById('fountain-canvas') as HTMLCanvasElement | null;
  const overlay = document.getElementById('fountain-overlay') as HTMLElement | null;

  if (!canvas || !overlay) {
    throw new Error('Missing #fountain-canvas or #fountain-overlay elements.');
  }

  const sim = new FluidSimulation();
  const renderer = new FountainRenderer(canvas);
  const ui = new FountainUI(canvas, overlay, {
    setDispensing: (id, active) => sim.setDispensing(id, active),
    stopAllDispensing: () => sim.stopAllDispensing(),
    isPointNearGlass: (wx, wy) => sim.isPointNearGlass(wx, wy),
    beginGlassDrag: (wx, wy) => sim.beginGlassDrag(wx, wy),
    updateGlassDrag: (wx, wy) => sim.updateGlassDrag(wx, wy),
    endGlassDrag: () => sim.endGlassDrag(),
    emptyGlass: () => sim.emptyGlass(),
  });

  let currentVp: ViewportTransform = computeViewportTransform(
    window.innerWidth,
    window.innerHeight,
    Math.min(window.devicePixelRatio || 1, 2)
  );

  const syncViewport = (): void => {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || window.innerWidth);
    const cssH = Math.max(1, rect.height || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    currentVp = computeViewportTransform(cssW, cssH, dpr);
    renderer.resize(currentVp);
    ui.layout(currentVp);
  };

  syncViewport();

  const resizeObserver = new ResizeObserver(() => {
    syncViewport();
  });
  resizeObserver.observe(canvas);
  window.addEventListener('resize', syncViewport);

  let rafId = 0;
  let lastTimestamp = 0;

  const frame = (timestamp: number): void => {
    const dt =
      lastTimestamp > 0
        ? Math.min(Math.max((timestamp - lastTimestamp) / 1000, 1 / 240), 1 / 30)
        : 1 / 60;
    lastTimestamp = timestamp;

    sim.step(dt);
    const snapshot = sim.getSnapshot();
    ui.updateStatus(snapshot);
    renderer.render(snapshot, currentVp, ui.isGlassHovered());

    rafId = window.requestAnimationFrame(frame);
  };

  // Render initial frame immediately before first rAF tick
  const initialSnapshot = sim.getSnapshot();
  ui.updateStatus(initialSnapshot);
  renderer.render(initialSnapshot, currentVp, false);

  rafId = window.requestAnimationFrame(frame);

  window.__fountain = {
    sim,
    renderer,
    ui,
    stepFrames(frames: number, dt = 1 / 60): void {
      for (let i = 0; i < frames; i++) {
        sim.step(dt);
      }
      const snap = sim.getSnapshot();
      ui.updateStatus(snap);
      renderer.render(snap, currentVp, ui.isGlassHovered());
    },
  };

  window.addEventListener('beforeunload', () => {
    window.cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    ui.dispose();
    renderer.dispose();
  });
}

initApp();
