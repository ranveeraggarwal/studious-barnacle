import { test, expect } from '@playwright/test';
import {
  type SodaWindow,
  ALL_DRINK_IDS,
  waitForSimulationReady,
  stepFrames,
  getSnapshot,
  startPourButton,
  stopPourButton,
  pourDrinkForFrames,
  dragGlassToWorld,
  sampleWorldPixel,
  sampleLiquidPixel,
  attachErrorTracking,
} from './helpers';

test.describe('Tier 2: Boundary & Corner Cases (F1–F6, EC1–EC7)', () => {
  test.describe('F1 Boundaries: Viewport Resizing (EC7), Context & Coordinate Clamping', () => {
    test('T2-F1-01 (EC7): Resizing viewport to mobile portrait (375x667) during active simulation preserves WebGL context, pooled fluid, and normalized coordinates', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'coca-cola', 45, 20);
      const beforeResize = await getSnapshot(page);
      expect(beforeResize.pooledParticleCount).toBeGreaterThan(30);

      await page.setViewportSize({ width: 375, height: 667 });
      await stepFrames(page, 10);

      const afterResize = await getSnapshot(page);
      expect(afterResize.isReady).toBe(true);
      expect(afterResize.pooledParticleCount).toBeGreaterThanOrEqual(Math.floor(beforeResize.pooledParticleCount * 0.9));
      expect(afterResize.glass.normX).toBeCloseTo(0.5, 2);
      expect(afterResize.glass.screenRect.width).toBeGreaterThan(10);
      expect(afterResize.glass.screenRect.x + afterResize.glass.screenRect.width).toBeLessThanOrEqual(375);

      const px = await sampleLiquidPixel(page);
      expect(px[3]).toBe(255);
      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    });

    test('T2-F1-02 (EC7): Resizing viewport across tablet (768x1024), desktop (1280x800), and ultrawide (1920x1080) updates canvas resolution and glass.screenRect', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      const viewports = [
        { width: 768, height: 1024 },
        { width: 1280, height: 800 },
        { width: 1920, height: 1080 },
      ];

      for (const vp of viewports) {
        await page.setViewportSize(vp);
        await stepFrames(page, 5);

        const metrics = await page.evaluate(() => {
          const w = window as unknown as SodaWindow;
          const c = document.querySelector('[data-testid="fountain-canvas"]') as HTMLCanvasElement;
          const gl = (c.getContext('webgl2') || c.getContext('webgl'))!;
          const snap = w.__SODA_SIM__!.getSnapshot();
          return {
            canvasWidth: c.width,
            canvasHeight: c.height,
            isLost: gl.isContextLost(),
            normX: snap.glass.normX,
            screenRect: snap.glass.screenRect,
          };
        });

        expect(metrics.isLost).toBe(false);
        expect(metrics.canvasWidth).toBeGreaterThan(400);
        expect(metrics.canvasHeight).toBeGreaterThan(300);
        expect(metrics.normX).toBeCloseTo(0.5, 2);
        expect(metrics.screenRect.width).toBeGreaterThan(20);
      }

      expect(errors.consoleErrors).toEqual([]);
    });

    test('T2-F1-03: Out-of-bounds world coordinate queries to samplePixelAtWorld ((-100, -100) and (9999, 9999)) clamp safely without throwing or NaN', async ({ page }) => {
      await waitForSimulationReady(page);
      await stepFrames(page, 2);

      const negPixel = await sampleWorldPixel(page, -100, -100);
      const hugePixel = await sampleWorldPixel(page, 9999, 9999);

      for (const px of [negPixel, hugePixel]) {
        expect(px).toHaveLength(4);
        for (const ch of px) {
          expect(Number.isFinite(ch)).toBe(true);
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    });

    test('T2-F1-04: Calling sampleGlassLiquidPixel() when the glass is completely empty (pooledParticleCount === 0) returns a valid fallback pixel without dividing by zero', async ({ page }) => {
      await waitForSimulationReady(page);
      const snap = await getSnapshot(page);
      expect(snap.pooledParticleCount).toBe(0);

      const emptyPixel = await sampleLiquidPixel(page);
      expect(emptyPixel).toHaveLength(4);
      for (const ch of emptyPixel) {
        expect(Number.isFinite(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    });

    test('T2-F1-05: Deterministic stepFrames boundary inputs (stepFrames(0), stepFrames(1, 0.0005), stepFrames(1, 0.1)) maintain finite simulation state', async ({ page }) => {
      await waitForSimulationReady(page);
      const snap0 = await getSnapshot(page);

      await page.evaluate(() => {
        const w = window as unknown as SodaWindow;
        w.__SODA_SIM__!.stepFrames(0);
      });
      const snapAfterZero = await getSnapshot(page);
      expect(snapAfterZero.frameCount).toBe(snap0.frameCount);

      await startPourButton(page, 'coca-cola', 'pointer');
      await page.evaluate(() => {
        const w = window as unknown as SodaWindow;
        w.__SODA_SIM__!.stepFrames(1, 0.0005);
        w.__SODA_SIM__!.stepFrames(1, 0.1);
      });
      await stopPourButton(page, 'coca-cola', 'pointer');

      const snapAfterExtremeDt = await getSnapshot(page);
      expect(snapAfterExtremeDt.frameCount).toBeGreaterThanOrEqual(snap0.frameCount + 2);
      expect(Number.isFinite(snapAfterExtremeDt.glass.x)).toBe(true);
      expect(Number.isFinite(snapAfterExtremeDt.liquid.fillLevel)).toBe(true);
    });
  });

  test.describe('F2 Boundaries: Off-Button Release (EC1), Rapid Switching (EC2), Cancellation & Blur (EC6)', () => {
    test('T2-F2-01 (EC1): Pressing pointerdown/mousedown on a drink button, dragging cursor onto the canvas, and releasing outside stops pouring immediately', async ({ page }) => {
      await waitForSimulationReady(page);
      const colaBtn = page.getByTestId('drink-btn-coca-cola');
      const canvas = page.getByTestId('fountain-canvas');

      const btnBox = await colaBtn.boundingBox();
      const canvasBox = await canvas.boundingBox();
      expect(btnBox).not.toBeNull();
      expect(canvasBox).not.toBeNull();

      await page.mouse.move(btnBox!.x + btnBox!.width / 2, btnBox!.y + btnBox!.height / 2);
      await page.mouse.down();
      await expect(colaBtn).toHaveAttribute('data-active', 'true');

      await stepFrames(page, 15);
      await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
      await page.mouse.up();
      await stepFrames(page, 2);

      await expect(colaBtn).toHaveAttribute('data-active', 'false');
      await expect(colaBtn).toHaveAttribute('aria-pressed', 'false');
      await expect(canvas).toHaveAttribute('data-active-drinks', '');
      const snap = await getSnapshot(page);
      expect(snap.activeDrinks).toEqual([]);
    });

    test('T2-F2-02 (EC2): Rapidly clicking and switching across all 5 drink buttons in a tight 15-tap loop leaves zero stuck states or NaN values', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      for (let cycle = 0; cycle < 3; cycle++) {
        for (const drinkId of ALL_DRINK_IDS) {
          await startPourButton(page, drinkId, 'pointer');
          await stepFrames(page, 2);
          await stopPourButton(page, drinkId, 'pointer');
        }
      }

      await stepFrames(page, 30);
      for (const drinkId of ALL_DRINK_IDS) {
        const btn = page.getByTestId(`drink-btn-${drinkId}`);
        await expect(btn).toHaveAttribute('data-active', 'false');
        await expect(btn).toHaveAttribute('aria-pressed', 'false');
      }

      const snap = await getSnapshot(page);
      expect(snap.activeDrinks).toEqual([]);
      expect(snap.pooledParticleCount).toBeGreaterThan(15);
      for (const ch of snap.liquid.averageColorRGB) {
        expect(Number.isFinite(ch)).toBe(true);
      }
      expect(errors.consoleErrors).toEqual([]);
    });

    test('T2-F2-03 (EC6): Firing pointercancel and touchcancel while a drink button is actively pouring immediately terminates the pour', async ({ page }) => {
      await waitForSimulationReady(page);
      const cherryBtn = page.getByTestId('drink-btn-cherry');

      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="drink-btn-cherry"]') as HTMLElement;
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, pointerType: 'touch' }));
      });

      await stepFrames(page, 10);
      await expect(cherryBtn).toHaveAttribute('data-active', 'true');

      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="drink-btn-cherry"]') as HTMLElement;
        btn.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 11, pointerType: 'touch' }));
        window.dispatchEvent(new Event('touchcancel'));
      });
      await stepFrames(page, 2);

      await expect(cherryBtn).toHaveAttribute('data-active', 'false');
      await expect(cherryBtn).toHaveAttribute('aria-pressed', 'false');
      const snap = await getSnapshot(page);
      expect(snap.activeDrinks).toEqual([]);
    });

    test('T2-F2-04 (EC6): Firing window blur event while holding both a drink button and a keyboard shortcut cleanly resets all active pours', async ({ page }) => {
      await waitForSimulationReady(page);
      await startPourButton(page, 'fanta', 'pointer');
      await page.keyboard.down('3');
      await stepFrames(page, 10);

      const midSnap = await getSnapshot(page);
      expect(midSnap.activeDrinks).toContain('fanta');
      expect(midSnap.activeDrinks).toContain('sprite');

      await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
      });
      await stepFrames(page, 2);

      const afterBlur = await getSnapshot(page);
      expect(afterBlur.activeDrinks).toEqual([]);
      await expect(page.getByTestId('drink-btn-fanta')).toHaveAttribute('data-active', 'false');
      await expect(page.getByTestId('drink-btn-sprite')).toHaveAttribute('data-active', 'false');
      await page.keyboard.up('3');
    });

    test('T2-F2-05: Pressing unbound keyboard keys (0, 6, a, Space, Escape) or dispatching contextmenu on a drink button does not leave stuck pours', async ({ page }) => {
      await waitForSimulationReady(page);

      for (const key of ['0', '6', 'a', ' ', 'Escape']) {
        await page.keyboard.down(key);
        await stepFrames(page, 2);
        await page.keyboard.up(key);
      }

      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="drink-btn-berry-blue"]') as HTMLElement;
        btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      await stepFrames(page, 2);

      const snap = await getSnapshot(page);
      expect(snap.activeDrinks).toEqual([]);
      expect(snap.totalParticleCount).toBe(0);
    });
  });

  test.describe('F3 Boundaries: Extreme Pouring Miss (EC4), Multi-Nozzle Stress & Micro-Taps', () => {
    test('T2-F3-01 (EC4): Pouring when glass is moved far left (glass.x = 180, normX = 0.225 <= 0.31) misses the glass completely (pooledParticleCount === 0)', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, 180, 145, 10);

      const movedSnap = await getSnapshot(page);
      expect(movedSnap.glass.x).toBeLessThanOrEqual(250);
      expect(movedSnap.glass.normX).toBeLessThanOrEqual(0.31);

      await pourDrinkForFrames(page, 'coca-cola', 60, 30);
      const afterPour = await getSnapshot(page);

      expect(afterPour.pooledParticleCount).toBe(0);
      expect(afterPour.liquid.fillLevel).toBe(0);
      await expect(page.getByTestId('fountain-canvas')).toHaveAttribute('data-fill-ratio', '0.00');
    });

    test('T2-F3-02 (EC4): Pouring when glass is moved far right (glass.x = 620, normX = 0.775 >= 0.69) misses the glass completely (pooledParticleCount === 0)', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, 620, 145, 10);

      const movedSnap = await getSnapshot(page);
      expect(movedSnap.glass.x).toBeGreaterThanOrEqual(550);
      expect(movedSnap.glass.normX).toBeGreaterThanOrEqual(0.69);

      await pourDrinkForFrames(page, 'berry-blue', 60, 30);
      const afterPour = await getSnapshot(page);

      expect(afterPour.pooledParticleCount).toBe(0);
      expect(afterPour.liquid.fillLevel).toBe(0);
      await expect(page.getByTestId('fountain-canvas')).toHaveAttribute('data-fill-ratio', '0.00');
    });

    test('T2-F3-03: Simultaneous 5-nozzle maximum emission (holding keys 1 through 5 together) maintains finite SPH state and bounded particle count', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      for (const k of ['1', '2', '3', '4', '5']) {
        await page.keyboard.down(k);
      }

      await stepFrames(page, 45);
      const midSnap = await getSnapshot(page);
      expect(midSnap.activeNozzles).toHaveLength(5);

      await stepFrames(page, 45);
      for (const k of ['1', '2', '3', '4', '5']) {
        await page.keyboard.up(k);
      }
      await stepFrames(page, 30);

      const finalSnap = await getSnapshot(page);
      expect(finalSnap.pooledParticleCount).toBeGreaterThan(100);
      expect(finalSnap.totalParticleCount).toBeLessThanOrEqual(2500);
      expect(errors.consoleErrors).toEqual([]);
    });

    test('T2-F3-04: Ultra-short micro-tap (1-frame pour) emits a small droplet burst that falls cleanly into the glass', async ({ page }) => {
      await waitForSimulationReady(page);

      await startPourButton(page, 'cherry', 'pointer');
      await stepFrames(page, 1);
      await stopPourButton(page, 'cherry', 'pointer');

      const burstSnap = await getSnapshot(page);
      expect(burstSnap.fallingParticleCount).toBeGreaterThan(0);

      await stepFrames(page, 60);
      const settledSnap = await getSnapshot(page);
      expect(settledSnap.fallingParticleCount).toBe(0);
      expect(settledSnap.pooledParticleCount).toBeGreaterThan(0);
    });

    test('T2-F3-05: Staccato start/stop pulsing of a drink button creates separate falling stream bursts that merge cleanly in the glass', async ({ page }) => {
      await waitForSimulationReady(page);

      for (let i = 0; i < 3; i++) {
        await startPourButton(page, 'fanta', 'pointer');
        await stepFrames(page, 10);
        await stopPourButton(page, 'fanta', 'pointer');
        await stepFrames(page, 10);
      }

      await stepFrames(page, 50);
      const snap = await getSnapshot(page);
      expect(snap.fallingParticleCount).toBe(0);
      expect(snap.pooledParticleCount).toBeGreaterThan(25);
      expect(Number.isFinite(snap.liquid.averageColorRGB[0])).toBe(true);
    });
  });

  test.describe('F4 Boundaries: Coordinate Clamping, High-Speed Drag (EC5) & Drag Cancellation (EC6)', () => {
    test('T2-F4-01: Dragging glass far past the left canvas edge (worldX = -500) clamps glass.x at minimum bound 120 (normX = 0.15)', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, -500, 145, 12);

      const snap = await getSnapshot(page);
      expect(snap.glass.x).toBeGreaterThanOrEqual(119);
      expect(snap.glass.x).toBeLessThanOrEqual(125);
      expect(snap.glass.normX).toBeCloseTo(0.15, 2);
      await expect(page.getByTestId('fountain-canvas')).toHaveAttribute('data-glass-x', '0.15');
    });

    test('T2-F4-02: Dragging glass far past the right canvas edge (worldX = 2000) clamps glass.x at maximum bound 680 (normX = 0.85)', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, 2000, 145, 12);

      const snap = await getSnapshot(page);
      expect(snap.glass.x).toBeGreaterThanOrEqual(675);
      expect(snap.glass.x).toBeLessThanOrEqual(681);
      expect(snap.glass.normX).toBeCloseTo(0.85, 2);
      await expect(page.getByTestId('fountain-canvas')).toHaveAttribute('data-glass-x', '0.85');
    });

    test('T2-F4-03: Dragging glass beyond vertical limits (worldY = 900 top and worldY = -200 bottom) clamps glass.y strictly within [135, 340]', async ({ page }) => {
      await waitForSimulationReady(page);

      await dragGlassToWorld(page, 400, 900, 12);
      const topSnap = await getSnapshot(page);
      expect(topSnap.glass.y).toBeLessThanOrEqual(341);
      expect(topSnap.glass.y).toBeGreaterThanOrEqual(330);

      await dragGlassToWorld(page, 400, -200, 12);
      const bottomSnap = await getSnapshot(page);
      expect(bottomSnap.glass.y).toBeGreaterThanOrEqual(134);
      expect(bottomSnap.glass.y).toBeLessThanOrEqual(142);
    });

    test('T2-F4-04 (EC5): High-speed back-and-forth glass dragging while containing liquid clamps velocity and prevents fluid wall tunneling', async ({ page }) => {
      await waitForSimulationReady(page);
      await pourDrinkForFrames(page, 'coca-cola', 85, 30);

      const beforeDrag = await getSnapshot(page);
      const initialPooled = beforeDrag.pooledParticleCount;
      expect(initialPooled).toBeGreaterThan(50);

      for (let i = 0; i < 5; i++) {
        await dragGlassToWorld(page, 220, 145, 3);
        await dragGlassToWorld(page, 580, 145, 3);
      }
      await dragGlassToWorld(page, 400, 145, 4);
      await stepFrames(page, 25);

      const afterDrag = await getSnapshot(page);
      expect(afterDrag.pooledParticleCount).toBeGreaterThanOrEqual(Math.floor(initialPooled * 0.85));
      expect(afterDrag.glass.vx).toBe(0);
    });

    test('T2-F4-05 (EC6): Firing pointercancel or window blur during an active glass drag terminates glass.isDragging and zeroes glass velocity', async ({ page }) => {
      await waitForSimulationReady(page);
      const canvas = page.getByTestId('fountain-canvas');
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const startX = box!.x + box!.width * 0.5;
      const startY = box!.y + box!.height * (1 - 145 / 600);

      await page.evaluate(
        ({ x, y }) => {
          const c = document.querySelector('[data-testid="fountain-canvas"]') as HTMLElement;
          c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 21 }));
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 40, clientY: y, pointerId: 21 }));
        },
        { x: startX, y: startY }
      );

      await stepFrames(page, 2);
      const draggingSnap = await getSnapshot(page);
      expect(draggingSnap.glass.isDragging).toBe(true);

      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 21 }));
        window.dispatchEvent(new Event('blur'));
      });
      await stepFrames(page, 2);

      const cancelledSnap = await getSnapshot(page);
      expect(cancelledSnap.glass.isDragging).toBe(false);
      expect(cancelledSnap.glass.vx).toBe(0);
      expect(cancelledSnap.glass.vy).toBe(0);
    });
  });

  test.describe('F5 Boundaries: Overfilling & Rim Overflow (EC3), Exterior Deflection, Reset Edge Cases', () => {
    test('T2-F5-01 (EC3): Overfilling the glass by continuous pouring caps fillLevel at 1.0, sets isOverflowing === true, and drains spilled overflow', async ({ page }) => {
      await waitForSimulationReady(page);

      await startPourButton(page, 'fanta', 'pointer');
      await stepFrames(page, 320);
      const overflowSnap = await getSnapshot(page);
      await stopPourButton(page, 'fanta', 'pointer');

      expect(overflowSnap.liquid.fillLevel).toBe(1.0);
      expect(overflowSnap.liquid.isOverflowing).toBe(true);
      expect(overflowSnap.spilledParticleCount).toBeGreaterThan(0);

      await expect(page.getByTestId('fountain-canvas')).toHaveAttribute('data-fill-ratio', '1.00');
      await expect(page.getByTestId('mixed-color-swatch')).toHaveAttribute('data-fill-percent', '100');
      await expect(page.getByTestId('fill-readout')).toHaveText('100%');

      await stepFrames(page, 180);
      const settledSnap = await getSnapshot(page);
      expect(settledSnap.spilledParticleCount).toBe(0);
      expect(settledSnap.liquid.fillLevel).toBeGreaterThanOrEqual(0.9);
    });

    test('T2-F5-02: Exterior stream deflection when nozzle hits just outside the glass rim (glass.x = 275, right rim lip at 350 < nozzle 360)', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, 275, 145, 10);

      await pourDrinkForFrames(page, 'coca-cola', 50, 25);
      const snap = await getSnapshot(page);
      expect(snap.pooledParticleCount).toBeLessThanOrEqual(10);
    });

    test('T2-F5-03: Grazing rim capture when nozzle is just inside the glass top opening (glass.x = 298, right rim lip at 373 > nozzle 360)', async ({ page }) => {
      await waitForSimulationReady(page);
      await dragGlassToWorld(page, 298, 145, 10);

      await pourDrinkForFrames(page, 'coca-cola', 50, 35);
      const snap = await getSnapshot(page);
      expect(snap.pooledParticleCount).toBeGreaterThan(25);
      expect(snap.liquid.fillLevel).toBeGreaterThan(0.03);
    });

    test('T2-F5-04: Clicking [data-testid="reset-button"] while a drink button is actively held clears existing fluid and re-centers the glass safely', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      await dragGlassToWorld(page, 460, 145, 8);
      await startPourButton(page, 'sprite', 'pointer');
      await stepFrames(page, 50);

      await page.getByTestId('reset-button').click();
      await stopPourButton(page, 'sprite', 'pointer');
      await stepFrames(page, 2);

      const snap = await getSnapshot(page);
      expect(snap.glass.x).toBe(400);
      expect(snap.glass.y).toBe(145);
      expect(errors.consoleErrors).toEqual([]);
    });

    test('T2-F5-05: Repeatedly clicking [data-testid="reset-button"] 10 times on an already empty glass is idempotent', async ({ page }) => {
      const errors = attachErrorTracking(page);
      await waitForSimulationReady(page);

      const resetBtn = page.getByTestId('reset-button');
      for (let i = 0; i < 10; i++) {
        await resetBtn.click();
      }
      await stepFrames(page, 5);

      const snap = await getSnapshot(page);
      expect(snap.pooledParticleCount).toBe(0);
      expect(snap.liquid.fillLevel).toBe(0);
      expect(snap.glass.x).toBe(400);
      expect(snap.glass.y).toBe(145);
      expect(snap.liquid.mixedColorHex).toBeNull();
      expect(errors.consoleErrors).toEqual([]);
    });
  });

  test.describe('F6 Boundaries: 5-Drink Equal Mix, Trace Dilution, Single-Drink Stability & Overflow Mixing', () => {
    test('T2-F6-01: Equal 5-way mix of all 5 catalog drinks converges to the 5-drink mean RGB (~[143, 114, 105]) with drinkComposition summing to 1.0', async ({ page }) => {
      await waitForSimulationReady(page);

      for (const drinkId of ALL_DRINK_IDS) {
        await pourDrinkForFrames(page, drinkId, 25, 10);
      }
      await stepFrames(page, 60);

      const snap = await getSnapshot(page);
      expect(snap.liquid.colorHistory).toHaveLength(5);

      const compValues = Object.values(snap.liquid.drinkComposition);
      const compSum = compValues.reduce((acc, v) => acc + v, 0);
      expect(compSum).toBeCloseTo(1.0, 2);
      for (const frac of compValues) {
        expect(frac).toBeGreaterThan(0.12);
        expect(frac).toBeLessThan(0.28);
      }

      const [r, g, b] = snap.liquid.averageColorRGB;
      expect(Math.abs(r - 143)).toBeLessThan(25);
      expect(Math.abs(g - 114)).toBeLessThan(25);
      expect(Math.abs(b - 105)).toBeLessThan(25);
    });

    test('T2-F6-02: Trace dilution boundary (90 frames coca-cola + 2-frame splash of sprite) keeps coca-cola dominant (> 90%)', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'coca-cola', 90, 25);
      const pureColaSnap = await getSnapshot(page);

      await pourDrinkForFrames(page, 'sprite', 2, 40);
      const traceSnap = await getSnapshot(page);

      expect(traceSnap.liquid.drinkComposition['coca-cola']).toBeGreaterThan(0.90);
      expect(traceSnap.liquid.drinkComposition['sprite']).toBeGreaterThan(0);
      expect(traceSnap.liquid.drinkComposition['sprite']).toBeLessThan(0.10);

      const [r, g, b] = traceSnap.liquid.averageColorRGB;
      expect(r).toBeLessThan(85);
      expect(g).toBeLessThan(50);
      expect(b).toBeLessThan(35);
      expect(g).toBeGreaterThanOrEqual(pureColaSnap.liquid.averageColorRGB[1]);
    });

    test('T2-F6-03: Repeated bursts of the same single drink (cherry) maintain zero color drift, unique colorHistory, and near-zero mixingVariance', async ({ page }) => {
      await waitForSimulationReady(page);

      for (let i = 0; i < 4; i++) {
        await pourDrinkForFrames(page, 'cherry', 20, 15);
      }

      const snap = await getSnapshot(page);
      expect(snap.liquid.colorHistory).toEqual(['cherry']);
      expect(snap.liquid.drinkComposition['cherry']).toBeCloseTo(1.0, 3);
      expect(snap.liquid.mixingVariance).toBeLessThan(0.01);

      const [r, g, b] = snap.liquid.averageColorRGB;
      expect(Math.abs(r - 228)).toBeLessThanOrEqual(5);
      expect(Math.abs(g - 24)).toBeLessThanOrEqual(5);
      expect(Math.abs(b - 62)).toBeLessThanOrEqual(5);
    });

    test('T2-F6-04: Resetting a multi-drink mixed glass clears colorHistory, zeroes drinkComposition, and sets mixedColorHex to null', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'fanta', 40, 15);
      await pourDrinkForFrames(page, 'berry-blue', 40, 30);

      const mixedSnap = await getSnapshot(page);
      expect(mixedSnap.liquid.colorHistory).toHaveLength(2);
      expect(mixedSnap.liquid.mixedColorHex).not.toBeNull();

      await page.getByTestId('reset-button').click();
      await stepFrames(page, 2);

      const resetSnap = await getSnapshot(page);
      expect(resetSnap.liquid.colorHistory).toEqual([]);
      expect(resetSnap.liquid.mixedColorHex).toBeNull();
      expect(resetSnap.liquid.averageColorRGB).toEqual([0, 0, 0]);
      expect(resetSnap.liquid.mixedColorRGBA).toEqual([0, 0, 0, 0]);
      for (const id of ALL_DRINK_IDS) {
        expect(resetSnap.liquid.drinkComposition[id]).toBe(0);
      }
    });

    test('T2-F6-05: Pouring a second drink (berry-blue) into an already full (fillLevel === 1.0) glass of fanta displaces/mixes and shifts averageColorRGB toward blue', async ({ page }) => {
      await waitForSimulationReady(page);

      await pourDrinkForFrames(page, 'fanta', 280, 20);
      const fullFantaSnap = await getSnapshot(page);
      expect(fullFantaSnap.liquid.fillLevel).toBeGreaterThanOrEqual(0.95);
      const beforeRGB = fullFantaSnap.liquid.averageColorRGB;

      await pourDrinkForFrames(page, 'berry-blue', 100, 40);
      const mixedFullSnap = await getSnapshot(page);

      expect(mixedFullSnap.liquid.drinkComposition['berry-blue']).toBeGreaterThan(0.05);
      expect(mixedFullSnap.liquid.averageColorRGB[2]).toBeGreaterThan(beforeRGB[2] + 15);
      expect(mixedFullSnap.liquid.averageColorRGB[0]).toBeLessThan(beforeRGB[0] - 15);
    });
  });
});
