import { test, expect } from '@playwright/test';
import {
  type SodaWindow,
  waitForSimulationReady,
  stepFrames,
  getSnapshot,
  startPourButton,
  stopPourButton,
  pourDrinkForFrames,
  dragGlassByWorldDelta,
  dragGlassToWorld,
  sampleWorldPixel,
  sampleLiquidPixel,
  attachErrorTracking,
} from './helpers';

const CATALOG_DRINKS = [
  { id: 'coca-cola', hex: '#3E160C', rgb: [62, 22, 12], nozzleX: 360, carbonation: 0.90, key: '1' },
  { id: 'fanta', hex: '#FF7D00', rgb: [255, 125, 0], nozzleX: 380, carbonation: 0.65, key: '2' },
  { id: 'sprite', hex: '#AAF5C3', rgb: [170, 245, 195], nozzleX: 400, carbonation: 0.95, key: '3' },
  { id: 'cherry', hex: '#E4183E', rgb: [228, 24, 62], nozzleX: 420, carbonation: 0.40, key: '4' },
  { id: 'berry-blue', hex: '#0098FF', rgb: [0, 152, 255], nozzleX: 440, carbonation: 0.55, key: '5' },
] as const;

test.describe('Tier 1: Feature Coverage (F1–F6)', () => {
  test.describe('F1: Minimal Website & WebGL2/WebGL1 Multi-Pass Canvas', () => {
    test('T1-F1-01: Single-viewport minimal UI layout loads with zero console or page errors and no scrollbars', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      const controls = page.getByTestId('fountain-controls');
      const canvas = page.getByTestId('fountain-canvas');
      const statusBar = page.getByTestId('status-bar');

      await expect(controls).toBeVisible();
      await expect(canvas).toBeVisible();
      await expect(statusBar).toBeVisible();

      const layoutMetrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const bodyStyle = window.getComputedStyle(document.body);
        const canvasRect = document.querySelector('[data-testid="fountain-canvas"]')!.getBoundingClientRect();
        return {
          scrollWidth: doc.scrollWidth,
          scrollHeight: doc.scrollHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          overflow: bodyStyle.overflow,
          canvasWidth: canvasRect.width,
          canvasHeight: canvasRect.height,
        };
      });

      expect(layoutMetrics.scrollWidth).toBeLessThanOrEqual(layoutMetrics.innerWidth);
      expect(layoutMetrics.scrollHeight).toBeLessThanOrEqual(layoutMetrics.innerHeight);
      expect(layoutMetrics.canvasWidth).toBeGreaterThan(300);
      expect(layoutMetrics.canvasHeight).toBeGreaterThan(250);
      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    });

    test('T1-F1-02: WebGL2/WebGL1 context initializes with preserveDrawingBuffer: true and valid data-webgl-version', async ({ page }) => {
      await waitForSimulationReady(page);
      const canvas = page.getByTestId('fountain-canvas');
      const versionAttr = await canvas.getAttribute('data-webgl-version');
      expect(['1', '2']).toContain(versionAttr);

      const glInfo = await page.evaluate(() => {
        const w = window as unknown as SodaWindow;
        const c = document.querySelector('[data-testid="fountain-canvas"]') as HTMLCanvasElement;
        const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
        if (!gl || !w.__SODA_SIM__) return null;
        const attrs = gl.getContextAttributes();
        return {
          isContextLost: gl.isContextLost(),
          preserveDrawingBuffer: attrs?.preserveDrawingBuffer ?? false,
          drawingBufferWidth: gl.drawingBufferWidth,
          drawingBufferHeight: gl.drawingBufferHeight,
          simVersion: w.__SODA_SIM__.getSnapshot().webglVersion,
        };
      });

      expect(glInfo).not.toBeNull();
      expect(glInfo!.isContextLost).toBe(false);
      expect(glInfo!.preserveDrawingBuffer).toBe(true);
      expect(glInfo!.drawingBufferWidth).toBeGreaterThan(0);
      expect(glInfo!.drawingBufferHeight).toBeGreaterThan(0);
      expect(String(glInfo!.simVersion)).toBe(versionAttr);
    });

    test('T1-F1-03: Initial DOM data-* telemetry attributes on canvas, swatch, and readout match default resting state', async ({ page }) => {
      await waitForSimulationReady(page);
      const canvas = page.getByTestId('fountain-canvas');
      const swatch = page.getByTestId('mixed-color-swatch');
      const readout = page.getByTestId('fill-readout');

      await expect(canvas).toHaveAttribute('data-ready', 'true');
      await expect(canvas).toHaveAttribute('data-glass-x', '0.50');
      await expect(canvas).toHaveAttribute('data-fill-ratio', '0.00');
      await expect(canvas).toHaveAttribute('data-avg-rgb', '0,0,0');
      await expect(canvas).toHaveAttribute('data-active-drinks', '');

      await expect(swatch).toHaveAttribute('data-rgb', '0,0,0');
      await expect(swatch).toHaveAttribute('data-fill-percent', '0');
      await expect(readout).toHaveText('0%');
    });

    test('T1-F1-04: window.__SODA_SIM__ and window.__SODA_FOUNTAIN__ expose identical initial SimulationSnapshot in 800x600 world space', async ({ page }) => {
      await waitForSimulationReady(page);
      const telemetry = await page.evaluate(() => {
        const w = window as unknown as SodaWindow;
        const sim = w.__SODA_SIM__!;
        const fountain = w.__SODA_FOUNTAIN__!;
        return {
          hasSim: Boolean(sim),
          hasFountain: Boolean(fountain),
          simSnap: sim.getSnapshot(),
          fountainSnap: fountain.getSnapshot(),
        };
      });

      expect(telemetry.hasSim).toBe(true);
      expect(telemetry.hasFountain).toBe(true);
      expect(telemetry.simSnap.isReady).toBe(true);
      expect(telemetry.simSnap.worldWidth).toBe(800);
      expect(telemetry.simSnap.worldHeight).toBe(600);
      expect(telemetry.simSnap.glass.x).toBe(400);
      expect(telemetry.simSnap.glass.y).toBe(145);
      expect(telemetry.simSnap.glass.normX).toBeCloseTo(0.5, 2);
      expect(telemetry.simSnap.glass.bottomHalfWidth).toBe(55);
      expect(telemetry.simSnap.glass.topHalfWidth).toBe(75);
      expect(telemetry.simSnap.glass.worldHeight).toBe(180);
      expect(telemetry.simSnap.pooledParticleCount).toBe(0);
      expect(telemetry.simSnap.liquid.fillLevel).toBe(0);
      expect(telemetry.fountainSnap.glass.x).toBe(telemetry.simSnap.glass.x);
      expect(telemetry.fountainSnap.fluid.fillRatio).toBe(0);
    });

    test('T1-F1-05: Multi-pass WebGL renderer draws non-empty pixels for studio background, dispenser header, nozzles, and glass walls', async ({ page }) => {
      await waitForSimulationReady(page);
      await stepFrames(page, 2);

      const bgPixel = await sampleWorldPixel(page, 100, 300);
      const headerPixel = await sampleWorldPixel(page, 400, 540);
      const nozzle0Pixel = await sampleWorldPixel(page, 360, 490);
      const nozzle2Pixel = await sampleWorldPixel(page, 400, 490);
      const glassBasePixel = await sampleWorldPixel(page, 400, 58);

      for (const px of [bgPixel, headerPixel, nozzle0Pixel, nozzle2Pixel, glassBasePixel]) {
        expect(px[3]).toBe(255);
        expect(px[0] + px[1] + px[2]).toBeGreaterThan(0);
      }

      const headerDiff =
        Math.abs(headerPixel[0] - bgPixel[0]) +
        Math.abs(headerPixel[1] - bgPixel[1]) +
        Math.abs(headerPixel[2] - bgPixel[2]);
      expect(headerDiff).toBeGreaterThan(10);
    });
  });

  test.describe('F2: Soda Fountain & Multi-Drink Dispenser Controls', () => {
    test('T1-F2-01: All 5 drink buttons and Reset button render with accurate data-drink, data-color, data-active="false", and aria-pressed="false"', async ({ page }) => {
      await waitForSimulationReady(page);

      for (const drink of CATALOG_DRINKS) {
        const btn = page.getByTestId(`drink-btn-${drink.id}`);
        await expect(btn).toBeVisible();
        await expect(btn).toHaveAttribute('data-drink', drink.id);
        const colorAttr = await btn.getAttribute('data-color');
        expect(colorAttr?.toUpperCase()).toBe(drink.hex.toUpperCase());
        await expect(btn).toHaveAttribute('data-active', 'false');
        await expect(btn).toHaveAttribute('aria-pressed', 'false');
      }

      const resetBtn = page.getByTestId('reset-button');
      await expect(resetBtn).toBeVisible();
      await expect(resetBtn).toHaveAttribute('data-action', 'empty-glass');
    });

    test('T1-F2-02: Mouse hold (mousedown / mouseup) on Coca-Cola button toggles data-active, aria-pressed, data-active-drinks, and activeDrinks', async ({ page }) => {
      await waitForSimulationReady(page);
      const colaBtn = page.getByTestId('drink-btn-coca-cola');
      const canvas = page.getByTestId('fountain-canvas');

      const box = await colaBtn.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();

      await expect(colaBtn).toHaveAttribute('data-active', 'true');
      await expect(colaBtn).toHaveAttribute('aria-pressed', 'true');
      await expect(canvas).toHaveAttribute('data-active-drinks', /coca-cola/);

      await stepFrames(page, 18);
      const activeSnap = await getSnapshot(page);
      expect(activeSnap.activeDrinks).toContain('coca-cola');
      expect(activeSnap.activeNozzles).toContain('coca-cola');
      expect(activeSnap.totalParticleCount).toBeGreaterThan(0);

      await page.mouse.up();
      await stepFrames(page, 2);

      await expect(colaBtn).toHaveAttribute('data-active', 'false');
      await expect(colaBtn).toHaveAttribute('aria-pressed', 'false');
      await expect(canvas).toHaveAttribute('data-active-drinks', '');
      const stoppedSnap = await getSnapshot(page);
      expect(stoppedSnap.activeDrinks).toEqual([]);
    });

    test('T1-F2-03: Touch hold (touchstart / touchend) on Fanta button activates and deactivates pouring cleanly', async ({ page }) => {
      await waitForSimulationReady(page);
      const fantaBtn = page.getByTestId('drink-btn-fanta');

      await startPourButton(page, 'fanta', 'touch');
      await expect(fantaBtn).toHaveAttribute('data-active', 'true');
      await expect(fantaBtn).toHaveAttribute('aria-pressed', 'true');

      await stepFrames(page, 18);
      const midSnap = await getSnapshot(page);
      expect(midSnap.activeDrinks).toContain('fanta');
      expect(midSnap.totalParticleCount).toBeGreaterThan(0);

      await stopPourButton(page, 'fanta', 'touch');
      await stepFrames(page, 2);
      await expect(fantaBtn).toHaveAttribute('data-active', 'false');
      await expect(fantaBtn).toHaveAttribute('aria-pressed', 'false');
      const endSnap = await getSnapshot(page);
      expect(endSnap.activeDrinks).toEqual([]);
    });

    test('T1-F2-04: Pointer events (pointerdown / pointerup) on each of the 5 drink buttons individually dispense their respective drink', async ({ page }) => {
      await waitForSimulationReady(page);

      for (const drink of CATALOG_DRINKS) {
        await startPourButton(page, drink.id, 'pointer');
        await stepFrames(page, 25);
        const midSnap = await getSnapshot(page);
        expect(midSnap.activeNozzles).toEqual([drink.id]);

        await stopPourButton(page, drink.id, 'pointer');
        await stepFrames(page, 30);

        const settledSnap = await getSnapshot(page);
        expect(settledSnap.pooledParticleCount).toBeGreaterThan(10);
        expect(settledSnap.liquid.colorHistory).toContain(drink.id);

        await page.getByTestId('reset-button').click();
        await stepFrames(page, 2);
      }
    });

    test('T1-F2-05: Keyboard shortcuts (1–5) activate and deactivate pouring for corresponding drinks 1 through 5', async ({ page }) => {
      await waitForSimulationReady(page);

      for (const drink of CATALOG_DRINKS) {
        const btn = page.getByTestId(`drink-btn-${drink.id}`);
        await page.keyboard.down(drink.key);
        await stepFrames(page, 10);

        await expect(btn).toHaveAttribute('data-active', 'true');
        const activeSnap = await getSnapshot(page);
        expect(activeSnap.activeDrinks).toContain(drink.id);

        await page.keyboard.up(drink.key);
        await stepFrames(page, 2);

        await expect(btn).toHaveAttribute('data-active', 'false');
        const releasedSnap = await getSnapshot(page);
        expect(releasedSnap.activeDrinks).not.toContain(drink.id);
      }
    });
  });

  test.describe('F3: Pouring Fluid Stream & 2D SPH Physics Engine', () => {
    test('T1-F3-01: Holding a drink button emits falling fluid particles from the nozzle at (nozzleX, 490) that accelerate downward under gravity', async ({ page }) => {
      await waitForSimulationReady(page);
      await startPourButton(page, 'sprite', 'pointer');

      await stepFrames(page, 5);
      const earlySnap = await getSnapshot(page);
      expect(earlySnap.fallingParticleCount).toBeGreaterThan(0);
      expect(earlySnap.totalParticleCount).toBeGreaterThan(0);

      await stepFrames(page, 30);
      const pooledSnap = await getSnapshot(page);
      expect(pooledSnap.pooledParticleCount).toBeGreaterThan(0);
      expect(pooledSnap.liquid.fillLevel).toBeGreaterThan(0);

      await stopPourButton(page, 'sprite', 'pointer');
    });

    test('T1-F3-02: Active nozzle emits visible WebGL stream pixels along the falling trajectory below nozzle (380, 490)', async ({ page }) => {
      await waitForSimulationReady(page);
      const bgBefore = await sampleWorldPixel(page, 380, 410);

      await startPourButton(page, 'fanta', 'pointer');
      await stepFrames(page, 14);

      const streamSamples = await Promise.all([
        sampleWorldPixel(page, 380, 440),
        sampleWorldPixel(page, 380, 410),
        sampleWorldPixel(page, 380, 380),
      ]);
      await stopPourButton(page, 'fanta', 'pointer');

      const maxRedDiff = Math.max(...streamSamples.map((px) => px[0] - bgBefore[0]));
      expect(maxRedDiff).toBeGreaterThan(25);
    });

    test('T1-F3-03: SPH pressure, viscosity, and cohesion settle poured fluid into a stable pool at the bottom of the glass after pouring stops', async ({ page }) => {
      await waitForSimulationReady(page);
      const emptyInteriorPixel = await sampleWorldPixel(page, 400, 90);

      await pourDrinkForFrames(page, 'coca-cola', 60, 45);
      const snap = await getSnapshot(page);

      expect(snap.fallingParticleCount).toBe(0);
      expect(snap.pooledParticleCount).toBeGreaterThan(40);
      expect(snap.liquid.fillLevel).toBeGreaterThan(0.05);

      const pooledInteriorPixel = await sampleWorldPixel(page, 400, 90);
      const diff =
        Math.abs(pooledInteriorPixel[0] - emptyInteriorPixel[0]) +
        Math.abs(pooledInteriorPixel[1] - emptyInteriorPixel[1]) +
        Math.abs(pooledInteriorPixel[2] - emptyInteriorPixel[2]);
      expect(diff).toBeGreaterThan(15);
    });

    test('T1-F3-04: Carbonation generates buoyant CO2 micro-bubbles (bubbleCount > 0) proportional to catalog carbonation (sprite 0.95 vs cherry 0.40)', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'sprite', 70, 15);
      const spriteSnap = await getSnapshot(page);
      expect(spriteSnap.bubbleCount).toBeGreaterThan(0);
      expect(spriteSnap.liquid.effectiveCarbonation).toBeGreaterThan(0.85);

      await page.getByTestId('reset-button').click();
      await stepFrames(page, 2);

      await pourDrinkForFrames(page, 'cherry', 70, 15);
      const cherrySnap = await getSnapshot(page);
      expect(cherrySnap.liquid.effectiveCarbonation).toBeLessThan(0.50);
      expect(spriteSnap.liquid.effectiveCarbonation).toBeGreaterThan(cherrySnap.liquid.effectiveCarbonation + 0.35);
    });

    test('T1-F3-05: Spilled fluid falling outside the glass drains into the drip tray (y < 45) and is removed over time', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, 160, 145);

      await startPourButton(page, 'berry-blue', 'pointer');
      await stepFrames(page, 25);
      await stopPourButton(page, 'berry-blue', 'pointer');

      await stepFrames(page, 20);
      const midSnap = await getSnapshot(page);
      expect(midSnap.pooledParticleCount).toBe(0);
      expect(midSnap.spilledParticleCount + midSnap.fallingParticleCount).toBeGreaterThan(0);

      await stepFrames(page, 160);
      const drainedSnap = await getSnapshot(page);
      expect(drainedSnap.pooledParticleCount).toBe(0);
      expect(drainedSnap.spilledParticleCount).toBe(0);
      expect(drainedSnap.totalParticleCount).toBe(0);
    });
  });

  test.describe('F4: Interactive Movable Glass Container', () => {
    test('T1-F4-01: Dragging the glass horizontally via mouse updates glass.x, glass.normX, glass.screenRect, and canvas data-glass-x', async ({ page }) => {
      await waitForSimulationReady(page);
      const initialSnap = await getSnapshot(page);
      expect(initialSnap.glass.x).toBe(400);

      await dragGlassByWorldDelta(page, 120, 0, 'mouse');
      await stepFrames(page, 5);

      const movedSnap = await getSnapshot(page);
      expect(movedSnap.glass.x).toBeGreaterThan(460);
      expect(movedSnap.glass.normX).toBeGreaterThan(0.57);
      expect(movedSnap.glass.screenRect.x).toBeGreaterThan(initialSnap.glass.screenRect.x + 20);

      const canvas = page.getByTestId('fountain-canvas');
      await expect(canvas).toHaveAttribute('data-glass-x', movedSnap.glass.normX.toFixed(2));
    });

    test('T1-F4-02: Dragging the glass horizontally via touch/pointer events smoothly translates the glass left', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassByWorldDelta(page, -130, 0, 'touch');
      await stepFrames(page, 5);

      const movedSnap = await getSnapshot(page);
      expect(movedSnap.glass.x).toBeLessThan(340);
      expect(movedSnap.glass.normX).toBeLessThan(0.43);
      expect(movedSnap.glass.isDragging).toBe(false);
    });

    test('T1-F4-03: Dragging the glass vertically within allowed bounds (y in [135, 340]) updates glass.y and glass.normY', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassByWorldDelta(page, 0, 90, 'mouse');
      await stepFrames(page, 5);

      const movedSnap = await getSnapshot(page);
      expect(movedSnap.glass.y).toBeGreaterThan(175);
      expect(movedSnap.glass.y).toBeLessThanOrEqual(340);
      expect(movedSnap.glass.normY).toBeCloseTo(movedSnap.glass.y / 600, 2);
    });

    test('T1-F4-04: Moving the glass shifts the rendered WebGL glass base/wall pixels to the new world coordinates', async ({ page }) => {
      await waitForSimulationReady(page);
      await stepFrames(page, 2);

      const emptyAt220Before = await sampleWorldPixel(page, 220, 58);

      await dragGlassToWorld(page, 220, 145);
      await stepFrames(page, 5);

      const glassBaseAt220After = await sampleWorldPixel(page, 220, 58);
      const diff =
        Math.abs(glassBaseAt220After[0] - emptyAt220Before[0]) +
        Math.abs(glassBaseAt220After[1] - emptyAt220Before[1]) +
        Math.abs(glassBaseAt220After[2] - emptyAt220Before[2]);
      expect(diff).toBeGreaterThan(10);
    });

    test('T1-F4-05: Simultaneous drink button hold and canvas glass drag (independent pointer tracking) pours liquid while moving the glass', async ({ page }) => {
      await waitForSimulationReady(page);
      const fantaBtn = page.getByTestId('drink-btn-fanta');

      await startPourButton(page, 'fanta', 'pointer');
      await expect(fantaBtn).toHaveAttribute('data-active', 'true');

      await dragGlassByWorldDelta(page, -40, 0, 'mouse', 15);
      await expect(fantaBtn).toHaveAttribute('data-active', 'true');

      await dragGlassByWorldDelta(page, 80, 0, 'mouse', 15);
      await expect(fantaBtn).toHaveAttribute('data-active', 'true');

      await stopPourButton(page, 'fanta', 'pointer');
      await stepFrames(page, 25);

      const snap = await getSnapshot(page);
      expect(snap.glass.x).toBeGreaterThan(410);
      expect(snap.pooledParticleCount).toBeGreaterThan(30);
    });
  });

  test.describe('F5: Fluid-Glass Containment, Sloshing, Overflow & Reset', () => {
    test('T1-F5-01: Tapered glass at default center (x=400, opening [325, 475]) captures streams from outer nozzles (360 and 440) without spilling', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'coca-cola', 45, 30);
      const afterCola = await getSnapshot(page);
      expect(afterCola.pooledParticleCount).toBeGreaterThan(30);
      expect(afterCola.spilledParticleCount).toBe(0);

      await pourDrinkForFrames(page, 'berry-blue', 45, 30);
      const afterBlue = await getSnapshot(page);
      expect(afterBlue.pooledParticleCount).toBeGreaterThan(afterCola.pooledParticleCount + 25);
      expect(afterBlue.spilledParticleCount).toBe(0);
    });

    test('T1-F5-02: Translating a partially filled glass co-translates the contained fluid pool and preserves pooledParticleCount and fillLevel', async ({ page }) => {
      await waitForSimulationReady(page);
      await pourDrinkForFrames(page, 'cherry', 65, 35);

      const beforeMove = await getSnapshot(page);
      expect(beforeMove.pooledParticleCount).toBeGreaterThan(45);

      await dragGlassToWorld(page, 520, 145, 20);
      await stepFrames(page, 20);

      const afterMove = await getSnapshot(page);
      expect(afterMove.glass.x).toBeCloseTo(520, -1);
      expect(afterMove.pooledParticleCount).toBeGreaterThanOrEqual(Math.floor(beforeMove.pooledParticleCount * 0.9));
      expect(afterMove.liquid.fillLevel).toBeCloseTo(beforeMove.liquid.fillLevel, 1);

      const pixelAtNewGlass = await sampleWorldPixel(page, 520, 90);
      const pixelAtOldCenter = await sampleWorldPixel(page, 400, 90);
      expect(pixelAtNewGlass[0]).toBeGreaterThan(pixelAtOldCenter[0] + 30);
    });

    test('T1-F5-03: Moving the glass horizontally imparts lateral sloshing impulses and accelerates fluid mixing', async ({ page }) => {
      await waitForSimulationReady(page);
      await pourDrinkForFrames(page, 'coca-cola', 45, 15);
      await pourDrinkForFrames(page, 'fanta', 45, 5);

      const beforeSlosh = await getSnapshot(page);
      const initialVariance = beforeSlosh.liquid.mixingVariance;

      await dragGlassToWorld(page, 340, 145, 10);
      await dragGlassToWorld(page, 460, 145, 10);
      await dragGlassToWorld(page, 400, 145, 10);
      await stepFrames(page, 20);

      const afterSlosh = await getSnapshot(page);
      expect(afterSlosh.liquid.mixingVariance).toBeLessThanOrEqual(initialVariance);
      expect(afterSlosh.pooledParticleCount).toBeGreaterThan(50);
    });

    test('T1-F5-04: Fill level telemetry (liquid.fillLevel, data-fill-ratio, data-fill-percent, #fill-readout) increases monotonically during pouring', async ({ page }) => {
      await waitForSimulationReady(page);
      const canvas = page.getByTestId('fountain-canvas');
      const swatch = page.getByTestId('mixed-color-swatch');
      const readout = page.getByTestId('fill-readout');

      await startPourButton(page, 'berry-blue', 'pointer');

      await stepFrames(page, 35);
      const snap1 = await getSnapshot(page);

      await stepFrames(page, 35);
      const snap2 = await getSnapshot(page);

      await stepFrames(page, 35);
      const snap3 = await getSnapshot(page);

      await stopPourButton(page, 'berry-blue', 'pointer');
      await stepFrames(page, 20);
      const finalSnap = await getSnapshot(page);

      expect(snap1.liquid.fillLevel).toBeGreaterThan(0);
      expect(snap2.liquid.fillLevel).toBeGreaterThan(snap1.liquid.fillLevel);
      expect(snap3.liquid.fillLevel).toBeGreaterThan(snap2.liquid.fillLevel);

      const expectedRatio = finalSnap.liquid.fillLevel.toFixed(2);
      const expectedPercent = String(Math.round(finalSnap.liquid.fillLevel * 100));
      await expect(canvas).toHaveAttribute('data-fill-ratio', expectedRatio);
      await expect(swatch).toHaveAttribute('data-fill-percent', expectedPercent);
      await expect(readout).toHaveText(`${expectedPercent}%`);
    });

    test('T1-F5-05: Clicking [data-testid="reset-button"] empties all fluid particles, resets glass to (400, 145), and restores initial state', async ({ page }) => {
      await waitForSimulationReady(page);
      await pourDrinkForFrames(page, 'fanta', 60, 20);
      await dragGlassToWorld(page, 500, 145, 10);

      const beforeReset = await getSnapshot(page);
      expect(beforeReset.pooledParticleCount).toBeGreaterThan(30);
      expect(beforeReset.glass.x).toBeGreaterThan(450);

      await page.getByTestId('reset-button').click();
      await stepFrames(page, 2);

      const afterReset = await getSnapshot(page);
      expect(afterReset.totalParticleCount).toBe(0);
      expect(afterReset.pooledParticleCount).toBe(0);
      expect(afterReset.liquid.fillLevel).toBe(0);
      expect(afterReset.liquid.mixedColorHex).toBeNull();
      expect(afterReset.glass.x).toBe(400);
      expect(afterReset.glass.y).toBe(145);

      const canvas = page.getByTestId('fountain-canvas');
      await expect(canvas).toHaveAttribute('data-glass-x', '0.50');
      await expect(canvas).toHaveAttribute('data-fill-ratio', '0.00');
      await expect(canvas).toHaveAttribute('data-avg-rgb', '0,0,0');
      await expect(page.getByTestId('fill-readout')).toHaveText('0%');
    });
  });

  test.describe('F6: Dynamic Multi-Drink Color Mixing & Blending', () => {
    test('T1-F6-01: Pouring a single pure drink (fanta orange vs berry-blue) sets averageColorRGB, DOM swatch, and WebGL sampleGlassLiquidPixel to that drink color', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'fanta', 75, 30);
      const fantaSnap = await getSnapshot(page);
      const [fR, fG, fB] = fantaSnap.liquid.averageColorRGB;
      expect(fR).toBeGreaterThan(220);
      expect(fG).toBeGreaterThan(95);
      expect(fG).toBeLessThan(155);
      expect(fB).toBeLessThan(25);

      const fantaPixel = await sampleLiquidPixel(page);
      expect(fantaPixel[0]).toBeGreaterThan(fantaPixel[1]);
      expect(fantaPixel[1]).toBeGreaterThan(fantaPixel[2] + 25);

      await page.getByTestId('reset-button').click();
      await stepFrames(page, 2);

      await pourDrinkForFrames(page, 'berry-blue', 75, 30);
      const blueSnap = await getSnapshot(page);
      const [bR, bG, bB] = blueSnap.liquid.averageColorRGB;
      expect(bB).toBeGreaterThan(210);
      expect(bG).toBeGreaterThan(115);
      expect(bR).toBeLessThan(30);

      const bluePixel = await sampleLiquidPixel(page);
      expect(bluePixel[2]).toBeGreaterThan(bluePixel[1]);
      expect(bluePixel[1]).toBeGreaterThan(bluePixel[0] + 25);
    });

    test('T1-F6-02: Equal 50/50 pour of coca-cola ([62, 22, 12]) and fanta ([255, 125, 0]) blends to intermediate bronze-amber (~[158, 74, 6])', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'coca-cola', 50, 25);
      const colaOnlyPixel = await sampleLiquidPixel(page);

      await pourDrinkForFrames(page, 'fanta', 50, 60);
      const mixSnap = await getSnapshot(page);

      expect(mixSnap.liquid.colorHistory).toEqual(['coca-cola', 'fanta']);
      expect(mixSnap.liquid.drinkComposition['coca-cola']).toBeGreaterThan(0.35);
      expect(mixSnap.liquid.drinkComposition['fanta']).toBeGreaterThan(0.35);

      const [mR, mG, mB] = mixSnap.liquid.averageColorRGB;
      expect(mR).toBeGreaterThan(115);
      expect(mR).toBeLessThan(200);
      expect(mG).toBeGreaterThan(48);
      expect(mG).toBeLessThan(100);
      expect(mB).toBeLessThan(20);

      const mixPixel = await sampleLiquidPixel(page);
      expect(mixPixel[0]).toBeGreaterThan(colaOnlyPixel[0] + 20);
      expect(mixPixel[0]).toBeGreaterThan(mixPixel[1]);
      expect(mixPixel[1]).toBeGreaterThan(mixPixel[2]);
    });

    test('T1-F6-03: Equal 50/50 pour of cherry ([228, 24, 62]) and berry-blue ([0, 152, 255]) blends into purple/violet (~[114, 88, 158])', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'cherry', 50, 25);
      await pourDrinkForFrames(page, 'berry-blue', 50, 60);

      const mixSnap = await getSnapshot(page);
      expect(mixSnap.liquid.colorHistory).toEqual(['cherry', 'berry-blue']);

      const [mR, mG, mB] = mixSnap.liquid.averageColorRGB;
      expect(mR).toBeGreaterThan(80);
      expect(mR).toBeLessThan(150);
      expect(mG).toBeGreaterThan(60);
      expect(mG).toBeLessThan(120);
      expect(mB).toBeGreaterThan(120);
      expect(mB).toBeLessThan(195);

      const purplePixel = await sampleLiquidPixel(page);
      expect(purplePixel[0]).toBeGreaterThan(50);
      expect(purplePixel[2]).toBeGreaterThan(80);
    });

    test('T1-F6-04: Asymmetric volume ratios (75% sprite + 25% cherry vs 25% sprite + 75% cherry) weight averageColorRGB and drinkComposition proportionally', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'sprite', 60, 20);
      await pourDrinkForFrames(page, 'cherry', 20, 50);
      const snapA = await getSnapshot(page);
      expect(snapA.liquid.drinkComposition['sprite']).toBeGreaterThan(0.65);

      await page.getByTestId('reset-button').click();
      await stepFrames(page, 2);

      await pourDrinkForFrames(page, 'sprite', 20, 20);
      await pourDrinkForFrames(page, 'cherry', 60, 50);
      const snapB = await getSnapshot(page);
      expect(snapB.liquid.drinkComposition['cherry']).toBeGreaterThan(0.65);

      expect(snapA.liquid.averageColorRGB[1]).toBeGreaterThan(snapB.liquid.averageColorRGB[1] + 60);
      expect(snapB.liquid.averageColorRGB[0]).toBeGreaterThan(snapA.liquid.averageColorRGB[0] + 15);
    });

    test('T1-F6-05: Two-stage color mixing reduces mixingVariance toward zero over frames and accelerates under glass agitation', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'fanta', 45, 20);
      await startPourButton(page, 'berry-blue', 'pointer');
      await stepFrames(page, 45);
      await stopPourButton(page, 'berry-blue', 'pointer');
      await stepFrames(page, 5);

      const unmixedSnap = await getSnapshot(page);
      const initialVariance = unmixedSnap.liquid.mixingVariance;
      expect(initialVariance).toBeGreaterThan(0);

      await dragGlassToWorld(page, 350, 145, 15);
      await dragGlassToWorld(page, 450, 145, 15);
      await dragGlassToWorld(page, 400, 145, 15);
      await stepFrames(page, 30);

      const homogenizedSnap = await getSnapshot(page);
      expect(homogenizedSnap.liquid.mixingVariance).toBeLessThan(initialVariance * 0.5);
      expect(homogenizedSnap.liquid.mixingVariance).toBeLessThan(0.05);
    });
  });
});
