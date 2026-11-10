import { expect, type Page } from '@playwright/test';

// ============================================================================
// 1. Opaque-Box Telemetry & Simulation Contracts (matching PROJECT.md § 1-3)
// ============================================================================

export type DrinkId = 'coca-cola' | 'fanta' | 'sprite' | 'cherry' | 'berry-blue';

export interface DrinkCatalogEntry {
  readonly id: DrinkId;
  readonly name: string;
  readonly hexColor: string;
  readonly rgb255: readonly [number, number, number];
  readonly color: readonly [number, number, number, number];
  readonly carbonation: number;
  readonly nozzleIndex: number;
  readonly nozzleX: number;
  readonly nozzleY: number;
  readonly keyShortcut: string;
}

export const ALL_DRINK_IDS: readonly DrinkId[] = [
  'coca-cola',
  'fanta',
  'sprite',
  'cherry',
  'berry-blue',
] as const;

export const DRINK_CATALOG_EXPECTED: Readonly<Record<DrinkId, DrinkCatalogEntry>> = {
  'coca-cola': {
    id: 'coca-cola',
    name: 'Coca-Cola',
    hexColor: '#3E160C',
    rgb255: [62, 22, 12],
    color: [0.243, 0.086, 0.047, 0.94],
    carbonation: 0.90,
    nozzleIndex: 0,
    nozzleX: 360,
    nozzleY: 490,
    keyShortcut: '1',
  },
  fanta: {
    id: 'fanta',
    name: 'Fanta',
    hexColor: '#FF7D00',
    rgb255: [255, 125, 0],
    color: [1.0, 0.49, 0.0, 0.90],
    carbonation: 0.65,
    nozzleIndex: 1,
    nozzleX: 380,
    nozzleY: 490,
    keyShortcut: '2',
  },
  sprite: {
    id: 'sprite',
    name: 'Sprite',
    hexColor: '#AAF5C3',
    rgb255: [170, 245, 195],
    color: [0.667, 0.961, 0.765, 0.75],
    carbonation: 0.95,
    nozzleIndex: 2,
    nozzleX: 400,
    nozzleY: 490,
    keyShortcut: '3',
  },
  cherry: {
    id: 'cherry',
    name: 'Cherry Soda',
    hexColor: '#E4183E',
    rgb255: [228, 24, 62],
    color: [0.894, 0.094, 0.243, 0.90],
    carbonation: 0.40,
    nozzleIndex: 3,
    nozzleX: 420,
    nozzleY: 490,
    keyShortcut: '4',
  },
  'berry-blue': {
    id: 'berry-blue',
    name: 'Blue Raspberry',
    hexColor: '#0098FF',
    rgb255: [0, 152, 255],
    color: [0.0, 0.596, 1.0, 0.88],
    carbonation: 0.55,
    nozzleIndex: 4,
    nozzleX: 440,
    nozzleY: 490,
    keyShortcut: '5',
  },
};

export const DRINK_CATALOG_RGB: Readonly<Record<DrinkId, readonly [number, number, number]>> = {
  'coca-cola': DRINK_CATALOG_EXPECTED['coca-cola'].rgb255,
  fanta: DRINK_CATALOG_EXPECTED.fanta.rgb255,
  sprite: DRINK_CATALOG_EXPECTED.sprite.rgb255,
  cherry: DRINK_CATALOG_EXPECTED.cherry.rgb255,
  'berry-blue': DRINK_CATALOG_EXPECTED['berry-blue'].rgb255,
};

export const WORLD_GEOMETRY = {
  WORLD_WIDTH: 800,
  WORLD_HEIGHT: 600,
  NOZZLE_Y: 490,
  DRIP_TRAY_TOP_Y: 45,
  DEFAULT_GLASS_X: 400,
  DEFAULT_GLASS_Y: 145,
  DEFAULT_GLASS_NORM_X: 0.5,
  DEFAULT_GLASS_NORM_Y: 145 / 600,
  GLASS_BOTTOM_Y: 55,
  GLASS_RIM_Y: 235,
  GLASS_BOTTOM_HALF_WIDTH: 55,
  GLASS_TOP_HALF_WIDTH: 75,
  GLASS_HEIGHT: 180,
  GLASS_MIN_X: 120,
  GLASS_MAX_X: 680,
  GLASS_MIN_NORM_X: 0.15,
  GLASS_MAX_NORM_X: 0.85,
  GLASS_MIN_Y: 135,
  GLASS_MAX_Y: 340,
  GLASS_MISS_LEFT_X: 200,
  GLASS_MISS_RIGHT_X: 600,
} as const;

export const SIM_FRAMES = {
  IN_FLIGHT: 20,
  SHORT_POUR: 65,
  MEDIUM_POUR: 100,
  SETTLE: 50,
  OVERFLOW_POUR: 260,
  AGITATE_STEP: 15,
} as const;

export const SELECTORS = {
  canvas: '#fountain-canvas[data-testid="fountain-canvas"]',
  canvasByTestId: '[data-testid="fountain-canvas"]',
  controlsBar: '[data-testid="fountain-controls"]',
  drinkBtn: (id: DrinkId) => `[data-testid="drink-btn-${id}"]`,
  allDrinkBtns: '[data-testid^="drink-btn-"]',
  resetBtn: '[data-testid="reset-button"]',
  statusBar: '[data-testid="status-bar"]',
  mixedColorSwatch: '[data-testid="mixed-color-swatch"]',
  fillReadout: '[data-testid="fill-readout"]',
} as const;

export interface GlassScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlassState {
  x: number;
  y: number;
  normX: number;
  normY: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  readonly bottomHalfWidth: number;
  readonly topHalfWidth: number;
  readonly worldHeight: number;
  readonly maxCapacityParticles: number;
  isDragging: boolean;
  screenRect: GlassScreenRect;
}

export interface GlassLiquidSummary {
  readonly pooledParticleCount: number;
  readonly fillLevel: number;
  readonly fillRatio: number;
  readonly isOverflowing: boolean;
  readonly mixedColorRGBA: readonly [number, number, number, number];
  readonly averageColorRGB: readonly [number, number, number];
  readonly mixedColorHex: string | null;
  readonly drinkComposition: Readonly<Record<DrinkId, number>>;
  readonly colorHistory: ReadonlyArray<DrinkId>;
  readonly mixingVariance: number;
  readonly effectiveCarbonation: number;
}

export interface SimulationSnapshot {
  readonly isReady: boolean;
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly activeNozzles: ReadonlyArray<DrinkId>;
  readonly activeDrinks: ReadonlyArray<DrinkId>;
  readonly totalParticleCount: number;
  readonly fallingParticleCount: number;
  readonly pooledParticleCount: number;
  readonly spilledParticleCount: number;
  readonly bubbleCount: number;
  readonly glass: Readonly<GlassState>;
  readonly liquid: GlassLiquidSummary;
  readonly fluid: GlassLiquidSummary & {
    readonly particleOrMassCount: number;
    readonly mixingEntropyOrVariance: number;
  };
  readonly webglVersion: 1 | 2;
  readonly frameCount: number;
}

export interface SodaSimulationAPI {
  readonly isReady: boolean;
  readonly frameCount: number;
  readonly activeDrinks: ReadonlyArray<DrinkId>;
  readonly glass: Readonly<GlassState>;
  readonly fluid: SimulationSnapshot['fluid'];
  readonly liquid: GlassLiquidSummary;
  getSnapshot(): SimulationSnapshot;
  startPouring(drinkId: DrinkId): void;
  stopPouring(drinkId?: DrinkId): void;
  moveGlassTo(x: number, y?: number): void;
  emptyGlass(): void;
  reset(): void;
  stepFrames(count?: number, dtSeconds?: number): void;
  samplePixelAtWorld(worldX: number, worldY: number): [number, number, number, number];
  sampleGlassLiquidPixel(): [number, number, number, number];
}

export type SodaWindow = Window & {
  __SODA_SIM__?: SodaSimulationAPI;
  __SODA_FOUNTAIN__?: SodaSimulationAPI;
};

export interface CanvasDomAttributes {
  ready: string | null;
  webglVersion: string | null;
  glassX: number;
  fillRatio: number;
  avgRgb: [number, number, number];
  activeDrinks: string[];
}

export interface DrinkButtonDomState {
  drink: string | null;
  color: string | null;
  active: boolean;
  ariaPressed: boolean;
}

export interface WebGLContextInfo {
  hasContext: boolean;
  webglVersion: 1 | 2;
  isContextLost: boolean;
  preserveDrawingBuffer: boolean;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  clientWidth: number;
  clientHeight: number;
}

export interface ErrorTracker {
  consoleErrors: string[];
  pageErrors: string[];
  assertNoErrors: () => void;
  clear: () => void;
}

// ============================================================================
// 2. Navigation, Readiness & Error Tracking
// ============================================================================

export function attachErrorTracker(page: Page): ErrorTracker {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });

  return {
    consoleErrors,
    pageErrors,
    assertNoErrors: () => {
      expect(consoleErrors, `Unexpected console.error: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(pageErrors, `Unexpected pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
    },
    clear: () => {
      consoleErrors.length = 0;
      pageErrors.length = 0;
    },
  };
}

export const attachErrorTracking = attachErrorTracker;

export async function gotoAndWaitForReady(
  page: Page,
  options?: { viewport?: { width: number; height: number } }
): Promise<ErrorTracker> {
  if (options?.viewport) {
    await page.setViewportSize(options.viewport);
  }
  const tracker = attachErrorTracker(page);
  await page.goto('/');

  const canvas = page.locator(SELECTORS.canvas);
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-ready', 'true');

  await page.waitForFunction(() => {
    const w = window as unknown as SodaWindow;
    return Boolean(w.__SODA_SIM__?.isReady && w.__SODA_FOUNTAIN__?.isReady);
  });

  await stepSimulationFrames(page, 1);
  return tracker;
}

export async function waitForSimulationReady(
  page: Page,
  options?: { viewport?: { width: number; height: number } }
): Promise<void> {
  if (options?.viewport) {
    await page.setViewportSize(options.viewport);
  }
  await page.goto('/');

  const canvas = page.locator(SELECTORS.canvas);
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-ready', 'true');

  await page.waitForFunction(() => {
    const w = window as unknown as SodaWindow;
    return Boolean(w.__SODA_SIM__?.isReady && w.__SODA_FOUNTAIN__?.isReady);
  });

  await stepSimulationFrames(page, 1);
}

export const waitForSimReady = waitForSimulationReady;

// ============================================================================
// 3. Deterministic Frame Stepping & Telemetry Inspection
// ============================================================================

export async function stepSimulationFrames(
  page: Page,
  count = 30,
  dtSeconds = 1 / 60
): Promise<SimulationSnapshot> {
  const steppedViaApi = await page.evaluate(
    ({ n, dt }) => {
      const w = window as unknown as SodaWindow;
      if (w.__SODA_SIM__ && typeof w.__SODA_SIM__.stepFrames === 'function') {
        w.__SODA_SIM__.stepFrames(n, dt);
        return true;
      }
      return false;
    },
    { n: count, dt: dtSeconds }
  );

  if (!steppedViaApi) {
    await page.waitForTimeout(Math.ceil(count * dtSeconds * 1000));
  }

  return getSimulationSnapshot(page);
}

export const stepFrames = stepSimulationFrames;

export async function getSimulationSnapshot(page: Page): Promise<SimulationSnapshot> {
  return page.evaluate(() => {
    const w = window as unknown as SodaWindow;
    if (!w.__SODA_SIM__) {
      throw new Error('window.__SODA_SIM__ is not defined');
    }
    return w.__SODA_SIM__.getSnapshot();
  });
}

export const getSnapshot = getSimulationSnapshot;

export function parseRgbAttribute(attr: string | null): [number, number, number] {
  if (!attr) return [0, 0, 0];
  const parts = attr.split(',').map((s) => Number(s.trim()));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export async function getCanvasDomAttributes(page: Page): Promise<CanvasDomAttributes> {
  const canvas = page.locator(SELECTORS.canvas);
  const [ready, webglVersion, glassXStr, fillRatioStr, avgRgbStr, activeDrinksStr] =
    await Promise.all([
      canvas.getAttribute('data-ready'),
      canvas.getAttribute('data-webgl-version'),
      canvas.getAttribute('data-glass-x'),
      canvas.getAttribute('data-fill-ratio'),
      canvas.getAttribute('data-avg-rgb'),
      canvas.getAttribute('data-active-drinks'),
    ]);

  return {
    ready,
    webglVersion,
    glassX: Number(glassXStr ?? '0.5'),
    fillRatio: Number(fillRatioStr ?? '0'),
    avgRgb: parseRgbAttribute(avgRgbStr),
    activeDrinks: activeDrinksStr
      ? activeDrinksStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

export async function getDrinkButtonState(
  page: Page,
  drinkId: DrinkId
): Promise<DrinkButtonDomState> {
  const btn = page.locator(SELECTORS.drinkBtn(drinkId));
  const [drink, color, active, ariaPressed] = await Promise.all([
    btn.getAttribute('data-drink'),
    btn.getAttribute('data-color'),
    btn.getAttribute('data-active'),
    btn.getAttribute('aria-pressed'),
  ]);
  return {
    drink,
    color,
    active: active === 'true',
    ariaPressed: ariaPressed === 'true',
  };
}

export async function getSwatchAndReadoutState(page: Page): Promise<{
  swatchRgb: [number, number, number];
  swatchFillPercent: number;
  readoutText: string;
}> {
  const swatch = page.locator(SELECTORS.mixedColorSwatch);
  const readout = page.locator(SELECTORS.fillReadout);
  const [rgbAttr, fillPercentAttr, readoutText] = await Promise.all([
    swatch.getAttribute('data-rgb'),
    swatch.getAttribute('data-fill-percent'),
    readout.innerText(),
  ]);
  return {
    swatchRgb: parseRgbAttribute(rgbAttr),
    swatchFillPercent: Number(fillPercentAttr ?? '0'),
    readoutText: readoutText.trim(),
  };
}

// ============================================================================
// 4. Real DOM / Mouse / Touch / Pointer / Keyboard Interaction Helpers
// ============================================================================

export async function worldToClientCoords(
  page: Page,
  worldX: number,
  worldY: number
): Promise<{ clientX: number; clientY: number }> {
  const box = await page.locator(SELECTORS.canvas).boundingBox();
  if (!box) {
    throw new Error('Canvas bounding box not available');
  }
  const clientX = box.x + (worldX / WORLD_GEOMETRY.WORLD_WIDTH) * box.width;
  const clientY = box.y + (1 - worldY / WORLD_GEOMETRY.WORLD_HEIGHT) * box.height;
  return { clientX, clientY };
}

export async function pressAndHoldDrinkMouse(page: Page, drinkId: DrinkId): Promise<void> {
  const btn = page.locator(SELECTORS.drinkBtn(drinkId));
  const box = await btn.boundingBox();
  if (!box) {
    throw new Error(`Bounding box for drink button ${drinkId} not found`);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

export async function releaseDrinkMouse(page: Page): Promise<void> {
  await page.mouse.up();
}

export async function pressAndHoldDrinkTouch(
  page: Page,
  drinkId: DrinkId,
  pointerId = 1
): Promise<void> {
  const selector = SELECTORS.drinkBtn(drinkId);
  await page.evaluate(
    ({ sel, pid }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${sel}`);
      const rect = el.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;

      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'touch',
          isPrimary: pid === 1,
          clientX,
          clientY,
          buttons: 1,
        })
      );

      if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
        const touch = new Touch({
          identifier: pid,
          target: el,
          clientX,
          clientY,
          pageX: clientX,
          pageY: clientY,
        });
        el.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            touches: [touch],
            targetTouches: [touch],
            changedTouches: [touch],
          })
        );
      }
    },
    { sel: selector, pid: pointerId }
  );
}

export async function releaseDrinkTouch(
  page: Page,
  drinkId: DrinkId,
  pointerId = 1,
  releaseOnWindow = false
): Promise<void> {
  const selector = SELECTORS.drinkBtn(drinkId);
  await page.evaluate(
    ({ sel, pid, onWin }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const target: EventTarget = onWin || !el ? window : el;
      const rect = el ? el.getBoundingClientRect() : { left: 10, top: 10, width: 10, height: 10 };
      const clientX = onWin ? 5 : rect.left + rect.width / 2;
      const clientY = onWin ? 5 : rect.top + rect.height / 2;

      target.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'touch',
          isPrimary: pid === 1,
          clientX,
          clientY,
          buttons: 0,
        })
      );

      if (el && typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
        const touch = new Touch({
          identifier: pid,
          target: el,
          clientX,
          clientY,
          pageX: clientX,
          pageY: clientY,
        });
        target.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [touch],
          })
        );
      }
    },
    { sel: selector, pid: pointerId, onWin: releaseOnWindow }
  );
}

export async function startPourButton(
  page: Page,
  drinkId: DrinkId,
  mode: 'pointer' | 'mouse' | 'touch' = 'pointer',
  pointerId = 1
): Promise<void> {
  if (mode === 'mouse') {
    await pressAndHoldDrinkMouse(page, drinkId);
    return;
  }
  if (mode === 'touch') {
    await pressAndHoldDrinkTouch(page, drinkId, pointerId);
    return;
  }
  const selector = SELECTORS.drinkBtn(drinkId);
  await page.evaluate(
    ({ sel, pid }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${sel}`);
      const rect = el.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'mouse',
          isPrimary: pid === 1,
          clientX,
          clientY,
          buttons: 1,
        })
      );
    },
    { sel: selector, pid: pointerId }
  );
}

export async function stopPourButton(
  page: Page,
  drinkId: DrinkId,
  mode: 'pointer' | 'mouse' | 'touch' = 'pointer',
  pointerId = 1,
  releaseOnWindow = false
): Promise<void> {
  if (mode === 'mouse') {
    await releaseDrinkMouse(page);
    return;
  }
  if (mode === 'touch') {
    await releaseDrinkTouch(page, drinkId, pointerId, releaseOnWindow);
    return;
  }
  const selector = SELECTORS.drinkBtn(drinkId);
  await page.evaluate(
    ({ sel, pid, onWin }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const target: EventTarget = onWin || !el ? window : el;
      const rect = el ? el.getBoundingClientRect() : { left: 10, top: 10, width: 10, height: 10 };
      const clientX = onWin ? 5 : rect.left + rect.width / 2;
      const clientY = onWin ? 5 : rect.top + rect.height / 2;
      target.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'mouse',
          isPrimary: pid === 1,
          clientX,
          clientY,
          buttons: 0,
        })
      );
    },
    { sel: selector, pid: pointerId, onWin: releaseOnWindow }
  );
}

export async function cancelDrinkPointer(
  page: Page,
  drinkId: DrinkId,
  pointerId = 1
): Promise<void> {
  const selector = SELECTORS.drinkBtn(drinkId);
  await page.evaluate(
    ({ sel, pid }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const target: EventTarget = el ?? window;
      target.dispatchEvent(
        new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'touch',
        })
      );
      if (el && typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
        const touch = new Touch({
          identifier: pid,
          target: el,
          clientX: 0,
          clientY: 0,
        });
        target.dispatchEvent(
          new TouchEvent('touchcancel', {
            bubbles: true,
            cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [touch],
          })
        );
      }
    },
    { sel: selector, pid: pointerId }
  );
}

export async function pourDrinkForFrames(
  page: Page,
  drinkId: DrinkId,
  pourFrames: number = SIM_FRAMES.SHORT_POUR,
  settleFrames = 0,
  mode: 'pointer' | 'mouse' | 'touch' = 'pointer'
): Promise<SimulationSnapshot> {
  await startPourButton(page, drinkId, mode);
  await stepSimulationFrames(page, pourFrames);
  await stopPourButton(page, drinkId, mode);
  if (settleFrames > 0) {
    return stepSimulationFrames(page, settleFrames);
  }
  return getSimulationSnapshot(page);
}

export async function pourDrinkWithMouse(
  page: Page,
  drinkId: DrinkId,
  pourFrames: number = SIM_FRAMES.SHORT_POUR,
  settleFrames: number = SIM_FRAMES.SETTLE
): Promise<SimulationSnapshot> {
  return pourDrinkForFrames(page, drinkId, pourFrames, settleFrames, 'mouse');
}

export async function pourDrinkWithTouch(
  page: Page,
  drinkId: DrinkId,
  pourFrames: number = SIM_FRAMES.SHORT_POUR,
  settleFrames: number = SIM_FRAMES.SETTLE,
  pointerId = 1
): Promise<SimulationSnapshot> {
  await pressAndHoldDrinkTouch(page, drinkId, pointerId);
  await stepSimulationFrames(page, pourFrames);
  await releaseDrinkTouch(page, drinkId, pointerId);
  if (settleFrames > 0) {
    return stepSimulationFrames(page, settleFrames);
  }
  return getSimulationSnapshot(page);
}

export async function pourDrinkWithKeyboard(
  page: Page,
  drinkId: DrinkId,
  pourFrames: number = SIM_FRAMES.SHORT_POUR,
  settleFrames: number = SIM_FRAMES.SETTLE
): Promise<SimulationSnapshot> {
  const key = DRINK_CATALOG_EXPECTED[drinkId].keyShortcut;
  await page.keyboard.down(key);
  await stepSimulationFrames(page, pourFrames);
  await page.keyboard.up(key);
  if (settleFrames > 0) {
    return stepSimulationFrames(page, settleFrames);
  }
  return getSimulationSnapshot(page);
}

export async function dragGlassMouseToWorld(
  page: Page,
  targetWorldX: number,
  targetWorldY?: number,
  steps = 12,
  framesPerStep = 2
): Promise<SimulationSnapshot> {
  const snap = await getSimulationSnapshot(page);
  const startWorldX = snap.glass.x;
  const startWorldY = snap.glass.y;
  const endWorldY = targetWorldY ?? startWorldY;

  const startClient = await worldToClientCoords(page, startWorldX, startWorldY);
  const endClient = await worldToClientCoords(page, targetWorldX, endWorldY);

  await page.mouse.move(startClient.clientX, startClient.clientY);
  await page.mouse.down();

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = startClient.clientX + (endClient.clientX - startClient.clientX) * t;
    const cy = startClient.clientY + (endClient.clientY - startClient.clientY) * t;
    await page.mouse.move(cx, cy);
    if (framesPerStep > 0) {
      await stepSimulationFrames(page, framesPerStep);
    }
  }

  await page.mouse.up();
  return stepSimulationFrames(page, 2);
}

export async function dragGlassTouchToWorld(
  page: Page,
  targetWorldX: number,
  targetWorldY?: number,
  steps = 12,
  framesPerStep = 2,
  pointerId = 2
): Promise<SimulationSnapshot> {
  const snap = await getSimulationSnapshot(page);
  const startWorldX = snap.glass.x;
  const startWorldY = snap.glass.y;
  const endWorldY = targetWorldY ?? startWorldY;

  const startClient = await worldToClientCoords(page, startWorldX, startWorldY);
  const endClient = await worldToClientCoords(page, targetWorldX, endWorldY);

  await page.evaluate(
    ({ x, y, pid }) => {
      const canvas = document.querySelector('[data-testid="fountain-canvas"]') as HTMLElement;
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'touch',
          isPrimary: false,
          clientX: x,
          clientY: y,
          buttons: 1,
        })
      );
      if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
        const touch = new Touch({ identifier: pid, target: canvas, clientX: x, clientY: y });
        canvas.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            touches: [touch],
            targetTouches: [touch],
            changedTouches: [touch],
          })
        );
      }
    },
    { x: startClient.clientX, y: startClient.clientY, pid: pointerId }
  );

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = startClient.clientX + (endClient.clientX - startClient.clientX) * t;
    const cy = startClient.clientY + (endClient.clientY - startClient.clientY) * t;
    await page.evaluate(
      ({ x, y, pid }) => {
        const canvas = document.querySelector('[data-testid="fountain-canvas"]') as HTMLElement;
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerId: pid,
            pointerType: 'touch',
            isPrimary: false,
            clientX: x,
            clientY: y,
            buttons: 1,
          })
        );
        if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
          const touch = new Touch({ identifier: pid, target: canvas, clientX: x, clientY: y });
          canvas.dispatchEvent(
            new TouchEvent('touchmove', {
              bubbles: true,
              cancelable: true,
              touches: [touch],
              targetTouches: [touch],
              changedTouches: [touch],
            })
          );
        }
      },
      { x: cx, y: cy, pid: pointerId }
    );
    if (framesPerStep > 0) {
      await stepSimulationFrames(page, framesPerStep);
    }
  }

  await page.evaluate(
    ({ x, y, pid }) => {
      const canvas = document.querySelector('[data-testid="fountain-canvas"]') as HTMLElement;
      canvas.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'touch',
          isPrimary: false,
          clientX: x,
          clientY: y,
          buttons: 0,
        })
      );
      if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
        const touch = new Touch({ identifier: pid, target: canvas, clientX: x, clientY: y });
        canvas.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [touch],
          })
        );
      }
    },
    { x: endClient.clientX, y: endClient.clientY, pid: pointerId }
  );

  return stepSimulationFrames(page, 2);
}

export async function dragGlassToWorld(
  page: Page,
  targetWorldX: number,
  targetWorldY?: number,
  steps = 12,
  mode: 'mouse' | 'touch' | 'pointer' = 'mouse',
  framesPerStep = 2,
  pointerId = 2
): Promise<SimulationSnapshot> {
  if (mode === 'touch') {
    return dragGlassTouchToWorld(page, targetWorldX, targetWorldY, steps, framesPerStep, pointerId);
  }
  return dragGlassMouseToWorld(page, targetWorldX, targetWorldY, steps, framesPerStep);
}

export async function dragGlassByWorldCoords(
  page: Page,
  targetWorldX: number,
  targetWorldY?: number,
  steps = 12
): Promise<SimulationSnapshot> {
  return dragGlassToWorld(page, targetWorldX, targetWorldY, steps, 'mouse', 2);
}

export async function dragGlassByWorldDelta(
  page: Page,
  deltaWorldX: number,
  deltaWorldY = 0,
  mode: 'mouse' | 'touch' | 'pointer' = 'mouse',
  steps = 12,
  framesPerStep = 2,
  pointerId = 2
): Promise<SimulationSnapshot> {
  const snap = await getSimulationSnapshot(page);
  const targetX = snap.glass.x + deltaWorldX;
  const targetY = snap.glass.y + deltaWorldY;
  return dragGlassToWorld(page, targetX, targetY, steps, mode, framesPerStep, pointerId);
}

export async function agitateGlassWithMouse(
  page: Page,
  swings = 3,
  deltaWorldX = 65,
  stepsPerSwing = 8
): Promise<SimulationSnapshot> {
  const initial = await getSimulationSnapshot(page);
  const centerX = initial.glass.x;
  const centerY = initial.glass.y;

  for (let s = 0; s < swings; s++) {
    const leftX = Math.max(WORLD_GEOMETRY.GLASS_MIN_X, centerX - deltaWorldX);
    const rightX = Math.min(WORLD_GEOMETRY.GLASS_MAX_X, centerX + deltaWorldX);
    await dragGlassMouseToWorld(page, leftX, centerY, stepsPerSwing, 2);
    await dragGlassMouseToWorld(page, rightX, centerY, stepsPerSwing, 2);
  }

  await dragGlassMouseToWorld(page, centerX, centerY, stepsPerSwing, 2);
  return stepSimulationFrames(page, SIM_FRAMES.SETTLE);
}

export async function clickResetButton(page: Page): Promise<SimulationSnapshot> {
  await page.locator(SELECTORS.resetBtn).click();
  return stepSimulationFrames(page, 2);
}

// ============================================================================
// 5. WebGL Context & Framebuffer Pixel Readback Helpers
// ============================================================================

export async function inspectWebGLContext(page: Page): Promise<WebGLContextInfo> {
  return page.evaluate(() => {
    const canvas = document.querySelector(
      '#fountain-canvas[data-testid="fountain-canvas"]'
    ) as HTMLCanvasElement | null;
    if (!canvas) {
      throw new Error('Fountain canvas not found');
    }
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 || canvas.getContext('webgl');
    if (!gl) {
      return {
        hasContext: false,
        webglVersion: 1,
        isContextLost: true,
        preserveDrawingBuffer: false,
        drawingBufferWidth: 0,
        drawingBufferHeight: 0,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
      };
    }
    const attrs = gl.getContextAttributes();
    return {
      hasContext: true,
      webglVersion: gl2 ? 2 : 1,
      isContextLost: gl.isContextLost(),
      preserveDrawingBuffer: Boolean(attrs?.preserveDrawingBuffer),
      drawingBufferWidth: gl.drawingBufferWidth,
      drawingBufferHeight: gl.drawingBufferHeight,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
    };
  });
}

export async function sampleGlassLiquidPixel(
  page: Page
): Promise<[number, number, number, number]> {
  return page.evaluate(() => {
    const w = window as unknown as SodaWindow;
    if (!w.__SODA_SIM__) {
      throw new Error('window.__SODA_SIM__ is not defined');
    }
    return w.__SODA_SIM__.sampleGlassLiquidPixel();
  });
}

export const sampleLiquidPixel = sampleGlassLiquidPixel;

export async function sampleWorldPixel(
  page: Page,
  worldX: number,
  worldY: number
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const w = window as unknown as SodaWindow;
      if (w.__SODA_SIM__ && typeof w.__SODA_SIM__.samplePixelAtWorld === 'function') {
        return w.__SODA_SIM__.samplePixelAtWorld(x, y);
      }
      const canvas = document.querySelector(
        '#fountain-canvas[data-testid="fountain-canvas"]'
      ) as HTMLCanvasElement | null;
      if (!canvas) return [0, 0, 0, 0];
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return [0, 0, 0, 0];
      const px = Math.min(
        gl.drawingBufferWidth - 1,
        Math.max(0, Math.round((x / 800) * gl.drawingBufferWidth))
      );
      const py = Math.min(
        gl.drawingBufferHeight - 1,
        Math.max(0, Math.round((y / 600) * gl.drawingBufferHeight))
      );
      const buf = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2], buf[3]];
    },
    { x: worldX, y: worldY }
  );
}

export async function readRawCanvasPixelAtWorld(
  page: Page,
  worldX: number,
  worldY: number
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector(
        '#fountain-canvas[data-testid="fountain-canvas"]'
      ) as HTMLCanvasElement | null;
      if (!canvas) throw new Error('Canvas not found');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) throw new Error('WebGL context not found');
      const px = Math.min(
        gl.drawingBufferWidth - 1,
        Math.max(0, Math.round((x / 800) * gl.drawingBufferWidth))
      );
      const py = Math.min(
        gl.drawingBufferHeight - 1,
        Math.max(0, Math.round((y / 600) * gl.drawingBufferHeight))
      );
      const buf = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2], buf[3]];
    },
    { x: worldX, y: worldY }
  );
}

// ============================================================================
// 6. Color Math & Assertion Utilities
// ============================================================================

export function colorDistanceRGB(
  rgbA: readonly [number, number, number] | [number, number, number, number],
  rgbB: readonly [number, number, number] | [number, number, number, number]
): number {
  const dr = rgbA[0] - rgbB[0];
  const dg = rgbA[1] - rgbB[1];
  const db = rgbA[2] - rgbB[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function computeExpectedVolumeWeightedRGB(
  weights: Partial<Record<DrinkId, number>>
): [number, number, number] {
  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const id of ALL_DRINK_IDS) {
    const w = weights[id] ?? 0;
    if (w > 0) {
      totalWeight += w;
      const spec = DRINK_CATALOG_EXPECTED[id];
      r += spec.rgb255[0] * w;
      g += spec.rgb255[1] * w;
      b += spec.rgb255[2] * w;
    }
  }
  if (totalWeight <= 0) return [0, 0, 0];
  return [
    Math.round(r / totalWeight),
    Math.round(g / totalWeight),
    Math.round(b / totalWeight),
  ];
}

export const computeExpectedWeightedRGB = computeExpectedVolumeWeightedRGB;

export function assertRgbCloseTo(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
  maxChannelDelta = 20,
  maxEuclideanDistance = 35
): void {
  const dist = colorDistanceRGB(actual, expected);
  expect(
    dist,
    `Expected RGB [${actual.join(',')}] to be within distance ${maxEuclideanDistance} of [${expected.join(',')}] (actual dist=${dist.toFixed(1)})`
  ).toBeLessThanOrEqual(maxEuclideanDistance);
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(maxChannelDelta);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(maxChannelDelta);
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(maxChannelDelta);
}

export const expectRGBCloseTo = assertRgbCloseTo;
