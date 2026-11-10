// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRINK_BY_ID, DRINK_IDS } from '../../src/catalog/drinks';
import { SodaFountainApp, initSodaFountainApp } from '../../src/main';
import {
  DEFAULT_GLASS_X,
  DEFAULT_GLASS_Y,
  GLASS_MAX_X,
  GLASS_MAX_Y,
  GLASS_MIN_X,
  GLASS_MIN_Y,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../../src/types/simulation';
import {
  clampWorldGlassCoords,
  clientToWorldCoords,
  ensureFountainDOM,
} from '../../src/ui/controls';

interface SyntheticPointerInit extends MouseEventInit {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

function createPointerEvent(
  type: string,
  init: SyntheticPointerInit = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(ev, 'pointerId', {
    value: init.pointerId ?? 1,
    configurable: true,
  });
  Object.defineProperty(ev, 'pointerType', {
    value: init.pointerType ?? 'mouse',
    configurable: true,
  });
  Object.defineProperty(ev, 'isPrimary', {
    value: init.isPrimary ?? (init.pointerId ?? 1) === 1,
    configurable: true,
  });
  return ev;
}

function createTouchEvent(
  type: string,
  target: EventTarget,
  touches: Array<{ identifier: number; clientX: number; clientY: number }>,
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const touchList = touches.map((t) => ({
    identifier: t.identifier,
    target,
    clientX: t.clientX,
    clientY: t.clientY,
    pageX: t.clientX,
    pageY: t.clientY,
  }));
  Object.defineProperty(ev, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : touchList,
    configurable: true,
  });
  Object.defineProperty(ev, 'targetTouches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : touchList,
    configurable: true,
  });
  Object.defineProperty(ev, 'changedTouches', {
    value: touchList,
    configurable: true,
  });
  return ev;
}

function worldToClient(
  canvas: HTMLCanvasElement,
  worldX: number,
  worldY: number,
): { clientX: number; clientY: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    clientX: rect.left + (worldX / WORLD_WIDTH) * rect.width,
    clientY: rect.top + (1 - worldY / WORLD_HEIGHT) * rect.height,
  };
}

describe('M3 UI Controls, DOM Synchronization & Full App Integration', () => {
  let app: SodaFountainApp;

  beforeEach(() => {
    document.body.innerHTML = '';
    const dom = ensureFountainDOM(document);
    dom.canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 60,
        right: 800,
        bottom: 660,
        width: 800,
        height: 600,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      }) as DOMRect;

    app = initSodaFountainApp({
      doc: document,
      win: window,
      autoStartLoop: false,
    });
  });

  afterEach(() => {
    app.dispose();
  });

  it('scaffolds all required DOM elements and sets initial resting state attributes', () => {
    const canvas = document.querySelector(
      '#fountain-canvas[data-testid="fountain-canvas"]',
    ) as HTMLCanvasElement | null;
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('data-ready')).toBe('true');
    expect(canvas!.getAttribute('data-webgl-version')).toBe('2');
    expect(canvas!.getAttribute('data-glass-x')).toBe('0.50');
    expect(canvas!.getAttribute('data-fill-ratio')).toBe('0.00');
    expect(canvas!.getAttribute('data-avg-rgb')).toBe('0,0,0');
    expect(canvas!.getAttribute('data-active-drinks')).toBe('');
    expect(canvas!.style.touchAction).toBe('none');

    const controlsBar = document.querySelector(
      '#fountain-controls[data-testid="fountain-controls"]',
    );
    expect(controlsBar).not.toBeNull();

    for (const id of DRINK_IDS) {
      const btn = document.querySelector(
        `[data-testid="drink-btn-${id}"]`,
      ) as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn!.getAttribute('data-drink')).toBe(id);
      expect(btn!.getAttribute('data-color')).toBe(DRINK_BY_ID[id].hexColor);
      expect(btn!.getAttribute('data-active')).toBe('false');
      expect(btn!.getAttribute('aria-pressed')).toBe('false');
      expect(btn!.style.touchAction).toBe('none');
    }

    const resetBtn = document.querySelector(
      '#reset-btn[data-testid="reset-button"]',
    );
    expect(resetBtn).not.toBeNull();
    expect(resetBtn!.getAttribute('data-action')).toBe('empty-glass');

    const statusBar = document.querySelector(
      '#status-bar[data-testid="status-bar"]',
    );
    expect(statusBar).not.toBeNull();

    const swatch = document.querySelector(
      '#mixed-color-swatch[data-testid="mixed-color-swatch"]',
    );
    expect(swatch).not.toBeNull();
    expect(swatch!.getAttribute('data-rgb')).toBe('0,0,0');
    expect(swatch!.getAttribute('data-fill-percent')).toBe('0');

    const readout = document.querySelector(
      '#fill-readout[data-testid="fill-readout"]',
    );
    expect(readout).not.toBeNull();
    expect(readout!.textContent).toBe('0%');
  });

  it('exposes identical SodaSimulationAPI on window.__SODA_SIM__ and window.__SODA_FOUNTAIN__', () => {
    expect(window.__SODA_SIM__).toBeDefined();
    expect(window.__SODA_FOUNTAIN__).toBeDefined();
    expect(window.__SODA_SIM__).toBe(window.__SODA_FOUNTAIN__);

    const sim = window.__SODA_SIM__!;
    expect(sim.isReady).toBe(true);
    expect(sim.frameCount).toBe(0);
    expect(sim.activeDrinks).toEqual([]);
    expect(sim.glass.x).toBe(DEFAULT_GLASS_X);
    expect(sim.glass.y).toBe(DEFAULT_GLASS_Y);
    expect(sim.liquid.fillLevel).toBe(0);
    expect(sim.fluid.particleOrMassCount).toBe(0);

    // stepFrames(0) must not advance frameCount
    sim.stepFrames(0);
    expect(sim.frameCount).toBe(0);
  });

  it('starts and stops pouring via Pointer, Mouse, Touch (dual-dispatched), and Keyboard (1-5)', () => {
    const sim = window.__SODA_SIM__!;
    const canvas = app.controls.dom.canvas;
    const colaBtn = app.controls.dom.drinkButtons.get('coca-cola')!;
    const fantaBtn = app.controls.dom.drinkButtons.get('fanta')!;
    const spriteBtn = app.controls.dom.drinkButtons.get('sprite')!;

    // 1. Pointer hold & release on Coca-Cola
    colaBtn.dispatchEvent(
      createPointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse' }),
    );
    expect(colaBtn.getAttribute('data-active')).toBe('true');
    expect(colaBtn.getAttribute('aria-pressed')).toBe('true');
    expect(canvas.getAttribute('data-active-drinks')).toBe('coca-cola');
    expect(sim.activeDrinks).toEqual(['coca-cola']);

    sim.stepFrames(35);
    expect(sim.getSnapshot().pooledParticleCount).toBeGreaterThan(10);

    colaBtn.dispatchEvent(
      createPointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse' }),
    );
    expect(colaBtn.getAttribute('data-active')).toBe('false');
    expect(colaBtn.getAttribute('aria-pressed')).toBe('false');
    expect(canvas.getAttribute('data-active-drinks')).toBe('');

    // 2. Touch dual-dispatch (pointerdown + touchstart & pointerup + touchend) on Fanta
    fantaBtn.dispatchEvent(
      createPointerEvent('pointerdown', { pointerId: 4, pointerType: 'touch' }),
    );
    fantaBtn.dispatchEvent(
      createTouchEvent('touchstart', fantaBtn, [
        { identifier: 4, clientX: 50, clientY: 20 },
      ]),
    );
    expect(fantaBtn.getAttribute('data-active')).toBe('true');
    expect(sim.activeDrinks).toEqual(['fanta']);

    fantaBtn.dispatchEvent(
      createPointerEvent('pointerup', { pointerId: 4, pointerType: 'touch' }),
    );
    fantaBtn.dispatchEvent(
      createTouchEvent('touchend', fantaBtn, [
        { identifier: 4, clientX: 50, clientY: 20 },
      ]),
    );
    expect(fantaBtn.getAttribute('data-active')).toBe('false');
    expect(sim.activeDrinks).toEqual([]);

    // 3. Keyboard shortcut '3' (Sprite) hold & release
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '3', code: 'Digit3', bubbles: true }),
    );
    expect(spriteBtn.getAttribute('data-active')).toBe('true');
    expect(sim.activeDrinks).toEqual(['sprite']);

    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '3', code: 'Digit3', bubbles: true }),
    );
    expect(spriteBtn.getAttribute('data-active')).toBe('false');
    expect(sim.activeDrinks).toEqual([]);
  });

  it('handles off-button release (EC1), pointercancel, plain Event(touchcancel) (EC6), window blur, and ignores unbound keys', () => {
    const sim = window.__SODA_SIM__!;
    const canvas = app.controls.dom.canvas;
    const colaBtn = app.controls.dom.drinkButtons.get('coca-cola')!;
    const cherryBtn = app.controls.dom.drinkButtons.get('cherry')!;
    const blueBtn = app.controls.dom.drinkButtons.get('berry-blue')!;

    // EC1: Press on button, move onto canvas, release on canvas
    colaBtn.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 1 }));
    expect(colaBtn.getAttribute('data-active')).toBe('true');
    canvas.dispatchEvent(
      createPointerEvent('pointermove', {
        pointerId: 1,
        clientX: 400,
        clientY: 360,
      }),
    );
    canvas.dispatchEvent(
      createPointerEvent('pointerup', {
        pointerId: 1,
        clientX: 400,
        clientY: 360,
      }),
    );
    expect(colaBtn.getAttribute('data-active')).toBe('false');
    expect(sim.activeDrinks).toEqual([]);

    // EC6: pointercancel + plain Event('touchcancel') without changedTouches
    cherryBtn.dispatchEvent(
      createPointerEvent('pointerdown', { pointerId: 11, pointerType: 'touch' }),
    );
    expect(cherryBtn.getAttribute('data-active')).toBe('true');
    cherryBtn.dispatchEvent(
      createPointerEvent('pointercancel', {
        pointerId: 11,
        pointerType: 'touch',
      }),
    );
    window.dispatchEvent(new Event('touchcancel'));
    expect(cherryBtn.getAttribute('data-active')).toBe('false');
    expect(sim.activeDrinks).toEqual([]);

    // Window blur while holding keyboard + pointer
    blueBtn.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 5 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    expect(sim.activeDrinks).toEqual(['coca-cola', 'berry-blue']);

    window.dispatchEvent(new Event('blur'));
    expect(sim.activeDrinks).toEqual([]);
    expect(blueBtn.getAttribute('data-active')).toBe('false');
    expect(colaBtn.getAttribute('data-active')).toBe('false');

    // Unbound keys and contextmenu must not start pouring
    const beforeFrames = sim.frameCount;
    for (const key of ['0', '6', 'a', ' ', 'Escape']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    }
    colaBtn.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(sim.activeDrinks).toEqual([]);
    expect(sim.frameCount).toBe(beforeFrames);
  });

  it('maps client coordinates to world coordinates, drags glass smoothly, clamps bounds, and zeroes velocity on release', () => {
    const sim = window.__SODA_SIM__!;
    const canvas = app.controls.dom.canvas;

    // Verify coordinate conversion math
    const centerWorld = clientToWorldCoords(canvas, 400, 360);
    expect(centerWorld.worldX).toBeCloseTo(400, 2);
    expect(centerWorld.worldY).toBeCloseTo(300, 2);

    const clampedLow = clampWorldGlassCoords(-50, 10);
    expect(clampedLow.worldX).toBe(GLASS_MIN_X);
    expect(clampedLow.worldY).toBe(GLASS_MIN_Y);

    const clampedHigh = clampWorldGlassCoords(950, 580);
    expect(clampedHigh.worldX).toBe(GLASS_MAX_X);
    expect(clampedHigh.worldY).toBe(GLASS_MAX_Y);

    // Start glass drag on canvas
    const startClient = worldToClient(canvas, DEFAULT_GLASS_X, DEFAULT_GLASS_Y);
    canvas.dispatchEvent(
      createPointerEvent('pointerdown', {
        pointerId: 2,
        clientX: startClient.clientX,
        clientY: startClient.clientY,
      }),
    );
    expect(sim.glass.isDragging).toBe(true);

    // Move glass toward worldX = 260, worldY = 210
    const midClient = worldToClient(canvas, 260, 210);
    window.dispatchEvent(
      createPointerEvent('pointermove', {
        pointerId: 2,
        clientX: midClient.clientX,
        clientY: midClient.clientY,
      }),
    );
    // Also dispatch duplicate touchmove at identical coords to verify vx is NOT overwritten with 0
    window.dispatchEvent(
      createTouchEvent('touchmove', canvas, [
        {
          identifier: 2,
          clientX: midClient.clientX,
          clientY: midClient.clientY,
        },
      ]),
    );

    expect(sim.glass.x).toBeCloseTo(260, 1);
    expect(sim.glass.y).toBeCloseTo(210, 1);
    expect(Math.abs(sim.glass.vx)).toBeGreaterThan(100);
    expect(canvas.getAttribute('data-glass-x')).toBe((260 / 800).toFixed(2));

    // Release drag -> isDragging = false and vx/vy = 0
    window.dispatchEvent(
      createPointerEvent('pointerup', {
        pointerId: 2,
        clientX: midClient.clientX,
        clientY: midClient.clientY,
      }),
    );
    expect(sim.glass.isDragging).toBe(false);
    expect(sim.glass.vx).toBe(0);
    expect(sim.glass.vy).toBe(0);
  });

  it('supports simultaneous drink hold + canvas glass drag for both shared (T1-F4-05) and distinct (T3-11) pointer IDs', () => {
    const sim = window.__SODA_SIM__!;
    const canvas = app.controls.dom.canvas;
    const fantaBtn = app.controls.dom.drinkButtons.get('fanta')!;

    // Pattern A (T1-F4-05): pointerdown(1) on fantaBtn, then mouse drag(1) on canvas
    fantaBtn.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 1 }));
    expect(fantaBtn.getAttribute('data-active')).toBe('true');

    const startPos = worldToClient(canvas, sim.glass.x, sim.glass.y);
    const nextPos = worldToClient(canvas, 350, sim.glass.y);

    canvas.dispatchEvent(
      createPointerEvent('pointerdown', {
        pointerId: 1,
        clientX: startPos.clientX,
        clientY: startPos.clientY,
      }),
    );
    canvas.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        clientX: startPos.clientX,
        clientY: startPos.clientY,
      }),
    );

    window.dispatchEvent(
      createPointerEvent('pointermove', {
        pointerId: 1,
        clientX: nextPos.clientX,
        clientY: nextPos.clientY,
      }),
    );
    window.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: nextPos.clientX,
        clientY: nextPos.clientY,
      }),
    );

    canvas.dispatchEvent(
      createPointerEvent('pointerup', {
        pointerId: 1,
        clientX: nextPos.clientX,
        clientY: nextPos.clientY,
      }),
    );
    canvas.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: nextPos.clientX,
        clientY: nextPos.clientY,
      }),
    );

    // Glass moved, drag ended, AND fantaBtn is STILL pouring!
    expect(sim.glass.x).toBeCloseTo(350, 1);
    expect(sim.glass.isDragging).toBe(false);
    expect(fantaBtn.getAttribute('data-active')).toBe('true');
    expect(sim.activeDrinks).toEqual(['fanta']);

    // Releasing on fantaBtn stops the pour
    fantaBtn.dispatchEvent(createPointerEvent('pointerup', { pointerId: 1 }));
    expect(fantaBtn.getAttribute('data-active')).toBe('false');
    expect(sim.activeDrinks).toEqual([]);

    // Pattern C (T3-11): pointerId=1 on fantaBtn + pointerId=2 dragging glass on canvas
    fantaBtn.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 1 }));
    canvas.dispatchEvent(
      createPointerEvent('pointerdown', {
        pointerId: 2,
        clientX: nextPos.clientX,
        clientY: nextPos.clientY,
      }),
    );
    const rightPos = worldToClient(canvas, 430, sim.glass.y);
    window.dispatchEvent(
      createPointerEvent('pointermove', {
        pointerId: 2,
        clientX: rightPos.clientX,
        clientY: rightPos.clientY,
      }),
    );
    expect(sim.glass.isDragging).toBe(true);
    expect(sim.activeDrinks).toEqual(['fanta']);

    // Release pointerId=1 on window -> stops fanta while pointerId=2 keeps dragging
    window.dispatchEvent(createPointerEvent('pointerup', { pointerId: 1 }));
    expect(sim.activeDrinks).toEqual([]);
    expect(sim.glass.isDragging).toBe(true);

    // Cancel pointerId=2 on window -> ends drag and zeroes velocity
    window.dispatchEvent(createPointerEvent('pointercancel', { pointerId: 2 }));
    expect(sim.glass.isDragging).toBe(false);
    expect(sim.glass.vx).toBe(0);
  });

  it('mixes multiple drinks, updates DOM swatch/readout, and supports emptyGlass() and #reset-btn click', () => {
    const sim = window.__SODA_SIM__!;
    const canvas = app.controls.dom.canvas;
    const swatch = app.controls.dom.mixedColorSwatch;
    const readout = app.controls.dom.fillReadout;
    const resetBtn = app.controls.dom.resetButton;

    // Pour Coca-Cola and Fanta and step simulation
    sim.startPouring('coca-cola');
    sim.startPouring('fanta');
    expect(canvas.getAttribute('data-active-drinks')).toBe('coca-cola,fanta');

    sim.stepFrames(50);
    sim.stopPouring();
    sim.stepFrames(30);

    const snap = sim.getSnapshot();
    expect(snap.pooledParticleCount).toBeGreaterThan(40);
    expect(snap.liquid.fillLevel).toBeGreaterThan(0.1);
    expect(snap.liquid.colorHistory).toEqual(['coca-cola', 'fanta']);

    const expectedPercent = Math.round(snap.liquid.fillLevel * 100);
    expect(swatch.getAttribute('data-fill-percent')).toBe(
      String(expectedPercent),
    );
    expect(readout.textContent).toBe(`${expectedPercent}%`);
    expect(canvas.getAttribute('data-avg-rgb')).toBe(
      snap.liquid.averageColorRGB.join(','),
    );

    // Sample rendered pixel inside liquid
    const liquidPx = sim.sampleGlassLiquidPixel();
    expect(liquidPx[3]).toBe(255);
    expect(liquidPx[0]).toBeGreaterThan(40);

    // Move glass to 280 and call emptyGlass() -> empties liquid but preserves glass.x = 280
    sim.moveGlassTo(280);
    expect(sim.glass.x).toBeCloseTo(280, 1);
    sim.emptyGlass();
    expect(sim.getSnapshot().pooledParticleCount).toBe(0);
    expect(sim.glass.x).toBeCloseTo(280, 1);
    expect(readout.textContent).toBe('0%');

    // Pour again, then click #reset-btn -> empties liquid AND resets glass to (400, 145)
    sim.startPouring('cherry');
    sim.stepFrames(40);
    expect(sim.getSnapshot().totalParticleCount).toBeGreaterThan(20);

    resetBtn.click();
    const afterReset = sim.getSnapshot();
    expect(afterReset.totalParticleCount).toBe(0);
    expect(afterReset.pooledParticleCount).toBe(0);
    expect(afterReset.activeDrinks).toEqual([]);
    expect(afterReset.glass.x).toBe(DEFAULT_GLASS_X);
    expect(afterReset.glass.y).toBe(DEFAULT_GLASS_Y);
    expect(canvas.getAttribute('data-glass-x')).toBe('0.50');
    expect(canvas.getAttribute('data-fill-ratio')).toBe('0.00');
    expect(canvas.getAttribute('data-avg-rgb')).toBe('0,0,0');
    expect(readout.textContent).toBe('0%');
  });

  it('handles responsive window resize, document visibilitychange hidden, and rAF vs manualStepMode', () => {
    const sim = window.__SODA_SIM__!;
    const canvas = app.controls.dom.canvas;

    // 1. Resize viewport to mobile 375x667
    canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 64,
        right: 375,
        bottom: 667,
        width: 375,
        height: 603,
        x: 0,
        y: 64,
        toJSON: () => ({}),
      }) as DOMRect;
    window.dispatchEvent(new Event('resize'));

    const resizedSnap = sim.getSnapshot();
    expect(resizedSnap.glass.screenRect.width).toBeGreaterThan(10);
    expect(
      resizedSnap.glass.screenRect.x + resizedSnap.glass.screenRect.width,
    ).toBeLessThanOrEqual(375);

    // 2. Document visibilitychange -> hidden stops active pours and drags
    const spriteBtn = app.controls.dom.drinkButtons.get('sprite')!;
    spriteBtn.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 3 }));
    expect(sim.activeDrinks).toEqual(['sprite']);

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sim.activeDrinks).toEqual([]);
    expect(spriteBtn.getAttribute('data-active')).toBe('false');

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });

    // 3. Verify requestAnimationFrame auto-steps until stepFrames() enables manualStepMode
    let rafCallback: FrameRequestCallback | null = null;
    const origRaf = window.requestAnimationFrame;
    const origCaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 101;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;

    try {
      const loopApp = initSodaFountainApp({
        doc: document,
        win: window,
        autoStartLoop: true,
      });
      expect(rafCallback).not.toBeNull();
      expect(loopApp.api.frameCount).toBe(0);

      // First rAF tick in interactive mode auto-steps 1 frame
      rafCallback!(16.67);
      expect(loopApp.api.frameCount).toBe(1);

      // Calling stepFrames switches to deterministic manualStepMode
      loopApp.api.stepFrames(4);
      expect(loopApp.api.frameCount).toBe(5);

      // Subsequent rAF ticks do not auto-increment frameCount
      rafCallback!(33.34);
      expect(loopApp.api.frameCount).toBe(5);

      loopApp.dispose();
    } finally {
      window.requestAnimationFrame = origRaf;
      window.cancelAnimationFrame = origCaf;
    }
  });
});

