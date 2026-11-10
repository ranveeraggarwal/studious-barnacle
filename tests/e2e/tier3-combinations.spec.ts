import { test, expect } from '@playwright/test';
import {
  type SodaWindow,
  waitForSimReady,
  getSnapshot,
  stepFrames,
  startPourButton,
  stopPourButton,
  pourDrinkForFrames,
  dragGlassByWorldCoords,
  dragGlassToWorld,
  clickResetButton,
  sampleGlassLiquidPixel,
  readRawCanvasPixelAtWorld,
  computeExpectedWeightedRGB,
  expectRGBCloseTo,
  attachErrorTracking,
  DRINK_CATALOG_RGB,
} from './helpers';

test.describe('Tier 3: Cross-Feature Pairwise & Multi-Feature Combinations', () => {
  test('T3-01: Sequential 2-drink pour (coca-cola + fanta) blends into warm bronze-amber across telemetry, DOM & WebGL pixels', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // 1. Pour Coca-Cola and settle
    await pourDrinkForFrames(page, 'coca-cola', 45, 25);
    const snapCola = await getSnapshot(page);
    expect(snapCola.liquid.pooledParticleCount).toBeGreaterThan(20);
    expectRGBCloseTo(snapCola.liquid.averageColorRGB, DRINK_CATALOG_RGB['coca-cola'], 8);
    const pxCola = await sampleGlassLiquidPixel(page);

    // 2. Pour Fanta on top of Coca-Cola and settle
    await pourDrinkForFrames(page, 'fanta', 45, 65);
    const snapMix = await getSnapshot(page);

    expect(snapMix.liquid.drinkComposition['coca-cola']).toBeGreaterThan(0.30);
    expect(snapMix.liquid.drinkComposition['fanta']).toBeGreaterThan(0.30);
    expect(snapMix.liquid.colorHistory).toEqual(['coca-cola', 'fanta']);

    // Verify exact volume-weighted RGB math
    const expectedRGB = computeExpectedWeightedRGB(snapMix.liquid.drinkComposition);
    expectRGBCloseTo(snapMix.liquid.averageColorRGB, expectedRGB, 8);

    // Strictly intermediate between Coca-Cola [62,22,12] and Fanta [255,125,0]
    const [r, g, b] = snapMix.liquid.averageColorRGB;
    expect(r).toBeGreaterThan(110);
    expect(r).toBeLessThan(210);
    expect(g).toBeGreaterThan(45);
    expect(g).toBeLessThan(105);
    expect(b).toBeGreaterThanOrEqual(2);
    expect(b).toBeLessThanOrEqual(10);

    // Verify DOM attributes match
    await expect(page.locator('#fountain-canvas')).toHaveAttribute('data-avg-rgb', `${r},${g},${b}`);
    await expect(page.locator('[data-testid="mixed-color-swatch"]')).toHaveAttribute('data-rgb', `${r},${g},${b}`);

    // Verify WebGL pixel readback shifted from pure Coca-Cola toward warm orange-amber
    const pxMix = await sampleGlassLiquidPixel(page);
    expect(pxMix[3]).toBe(255);
    expect(pxMix[0]).toBeGreaterThan(pxCola[0] + 15);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-02: Multi-drink pour (cherry + berry-blue) + horizontal glass sloshing accelerates homogenization and reduces mixingVariance', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    await pourDrinkForFrames(page, 'cherry', 45, 20);
    await startPourButton(page, 'berry-blue', 'pointer');
    await stepFrames(page, 45);
    await stopPourButton(page, 'berry-blue', 'pointer');
    await stepFrames(page, 10);

    const beforeSlosh = await getSnapshot(page);
    const initialVariance = beforeSlosh.liquid.mixingVariance;
    expect(initialVariance).toBeGreaterThan(0);

    // Slosh glass back and forth within nozzle-safe center region
    await dragGlassByWorldCoords(page, 345, 145, 10);
    await dragGlassByWorldCoords(page, 455, 145, 10);
    await dragGlassByWorldCoords(page, 400, 145, 10);
    await stepFrames(page, 45);

    const afterSlosh = await getSnapshot(page);
    expect(afterSlosh.liquid.mixingVariance).toBeLessThan(initialVariance);
    expect(afterSlosh.spilledParticleCount).toBe(0);
    expect(afterSlosh.liquid.colorHistory).toEqual(['cherry', 'berry-blue']);

    const expectedRGB = computeExpectedWeightedRGB(afterSlosh.liquid.drinkComposition);
    expectRGBCloseTo(afterSlosh.liquid.averageColorRGB, expectedRGB, 8);

    const [r, g, b] = afterSlosh.liquid.averageColorRGB;
    expect(r).toBeGreaterThan(75);
    expect(r).toBeLessThan(155);
    expect(g).toBeGreaterThan(60);
    expect(g).toBeLessThan(115);
    expect(b).toBeGreaterThan(120);
    expect(b).toBeLessThan(195);

    const px = await sampleGlassLiquidPixel(page);
    expect(px[0]).toBeGreaterThan(50);
    expect(px[2]).toBeGreaterThan(80);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-03: Simultaneous multi-pointer interaction: Pointer 1 holds sprite button while Pointer 2 drags glass across canvas', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    const spriteBtn = page.getByTestId('drink-btn-sprite');
    await startPourButton(page, 'sprite', 'touch', 1);
    await expect(spriteBtn).toHaveAttribute('data-active', 'true');

    // Drag glass with secondary touch pointerId = 2 while Pointer 1 stays held on Sprite button
    await dragGlassToWorld(page, 360, 145, 8, 'touch', 2, 2);
    await expect(spriteBtn).toHaveAttribute('data-active', 'true');

    await dragGlassToWorld(page, 435, 145, 8, 'touch', 2, 2);
    await expect(spriteBtn).toHaveAttribute('data-active', 'true');

    const midSnap = await getSnapshot(page);
    expect(midSnap.activeDrinks).toContain('sprite');
    expect(midSnap.glass.isDragging).toBe(false);
    expect(midSnap.glass.x).toBeGreaterThan(415);

    await stopPourButton(page, 'sprite', 'touch', 1);
    await stepFrames(page, 30);

    await expect(spriteBtn).toHaveAttribute('data-active', 'false');
    const finalSnap = await getSnapshot(page);
    expect(finalSnap.activeDrinks).toEqual([]);
    expect(finalSnap.pooledParticleCount).toBeGreaterThan(35);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-04: Simultaneous keyboard hold-to-pour (Key1 -> Key2) + mouse glass drag mixes coca-cola and fanta on the move', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    await page.keyboard.down('1');
    await dragGlassToWorld(page, 370, 145, 12, 'mouse', 3);
    await page.keyboard.up('1');

    await page.keyboard.down('2');
    await dragGlassToWorld(page, 425, 145, 12, 'mouse', 3);
    await page.keyboard.up('2');

    await stepFrames(page, 50);
    const snap = await getSnapshot(page);

    expect(snap.glass.x).toBeGreaterThan(405);
    expect(snap.liquid.colorHistory).toEqual(['coca-cola', 'fanta']);
    expect(snap.liquid.drinkComposition['coca-cola']).toBeGreaterThan(0.25);
    expect(snap.liquid.drinkComposition['fanta']).toBeGreaterThan(0.25);

    const expectedRGB = computeExpectedWeightedRGB(snap.liquid.drinkComposition);
    expectRGBCloseTo(snap.liquid.averageColorRGB, expectedRGB, 8);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-05: Pour catch (fanta) -> drag glass far left (normX <= 0.25) pour miss (berry-blue) -> drag back (normX = 0.52) pour catch & mix', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Phase 1: Pour Fanta at default center x = 400
    await pourDrinkForFrames(page, 'fanta', 55, 30);
    const phase1Snap = await getSnapshot(page);
    expect(phase1Snap.pooledParticleCount).toBeGreaterThan(30);
    expectRGBCloseTo(phase1Snap.liquid.averageColorRGB, DRINK_CATALOG_RGB.fanta, 8);

    // Phase 2: Drag glass far left (x = 180, normX = 0.225) so opening [105..255] misses berry-blue nozzle (440)
    await dragGlassByWorldCoords(page, 180, 145, 12);
    await pourDrinkForFrames(page, 'berry-blue', 45, 35);
    const phase2Snap = await getSnapshot(page);

    expect(phase2Snap.glass.normX).toBeLessThanOrEqual(0.25);
    expect(phase2Snap.liquid.drinkComposition['berry-blue']).toBe(0);
    expect(phase2Snap.liquid.colorHistory).toEqual(['fanta']);
    expectRGBCloseTo(phase2Snap.liquid.averageColorRGB, DRINK_CATALOG_RGB.fanta, 8);

    // Phase 3: Drag glass back under nozzles (x = 416, normX = 0.52) and pour berry-blue into glass
    await dragGlassByWorldCoords(page, 416, 145, 12);
    await pourDrinkForFrames(page, 'berry-blue', 55, 55);
    const phase3Snap = await getSnapshot(page);

    expect(phase3Snap.liquid.drinkComposition['berry-blue']).toBeGreaterThan(0.25);
    expect(phase3Snap.liquid.colorHistory).toEqual(['fanta', 'berry-blue']);
    const expectedRGB = computeExpectedWeightedRGB(phase3Snap.liquid.drinkComposition);
    expectRGBCloseTo(phase3Snap.liquid.averageColorRGB, expectedRGB, 8);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-06: Simultaneous dual-button multi-touch pour (sprite + berry-blue) emits two concurrent streams and blends into tropical aqua', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    await startPourButton(page, 'sprite', 'touch', 1);
    await startPourButton(page, 'berry-blue', 'touch', 2);

    await stepFrames(page, 50);
    const activeSnap = await getSnapshot(page);
    expect(activeSnap.activeDrinks).toContain('sprite');
    expect(activeSnap.activeDrinks).toContain('berry-blue');
    expect(activeSnap.activeNozzles).toHaveLength(2);

    await stopPourButton(page, 'sprite', 'touch', 1);
    await stopPourButton(page, 'berry-blue', 'touch', 2);
    await stepFrames(page, 55);

    const mixSnap = await getSnapshot(page);
    expect(mixSnap.liquid.drinkComposition['sprite']).toBeGreaterThan(0.30);
    expect(mixSnap.liquid.drinkComposition['berry-blue']).toBeGreaterThan(0.30);

    const expectedRGB = computeExpectedWeightedRGB(mixSnap.liquid.drinkComposition);
    expectRGBCloseTo(mixSnap.liquid.averageColorRGB, expectedRGB, 8);

    // Tropical aqua (~[85, 199, 225])
    const [r, g, b] = mixSnap.liquid.averageColorRGB;
    expect(r).toBeGreaterThan(50);
    expect(r).toBeLessThan(120);
    expect(g).toBeGreaterThan(170);
    expect(g).toBeLessThan(225);
    expect(b).toBeGreaterThan(205);
    expect(b).toBeLessThan(245);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-07: Overfill glass (cherry) -> drag overflowing glass horizontally -> click Reset -> fresh re-pour (sprite) with zero residue', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Overfill glass with Cherry
    await pourDrinkForFrames(page, 'cherry', 310, 10);
    const overSnap = await getSnapshot(page);
    expect(overSnap.liquid.fillLevel).toBe(1.0);
    expect(overSnap.liquid.isOverflowing).toBe(true);

    // Drag overflowing glass horizontally
    await dragGlassByWorldCoords(page, 470, 145, 10);
    const draggedSnap = await getSnapshot(page);
    expect(draggedSnap.glass.x).toBeGreaterThan(440);
    expect(draggedSnap.pooledParticleCount).toBeGreaterThan(100);

    // Click Reset and verify total cleanup
    const resetSnap = await clickResetButton(page);
    expect(resetSnap.pooledParticleCount).toBe(0);
    expect(resetSnap.totalParticleCount).toBe(0);
    expect(resetSnap.glass.x).toBe(400);
    expect(resetSnap.liquid.colorHistory).toEqual([]);

    // Fresh re-pour of Sprite has zero Cherry residue
    await pourDrinkForFrames(page, 'sprite', 60, 35);
    const freshSnap = await getSnapshot(page);
    expect(freshSnap.liquid.drinkComposition['cherry']).toBe(0);
    expect(freshSnap.liquid.drinkComposition['sprite']).toBeCloseTo(1.0, 3);
    expect(freshSnap.liquid.colorHistory).toEqual(['sprite']);
    expectRGBCloseTo(freshSnap.liquid.averageColorRGB, DRINK_CATALOG_RGB.sprite, 8);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-08: Viewport resize (1280x720 -> 390x844) mid-simulation preserves pooled coca-cola & glass normX, then drags & mixes cherry', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    await pourDrinkForFrames(page, 'coca-cola', 50, 25);
    const beforeResize = await getSnapshot(page);
    expect(beforeResize.pooledParticleCount).toBeGreaterThan(25);

    await page.setViewportSize({ width: 390, height: 844 });
    await stepFrames(page, 8);

    const afterResize = await getSnapshot(page);
    expect(afterResize.glass.normX).toBeCloseTo(0.5, 2);
    expect(afterResize.pooledParticleCount).toBeGreaterThanOrEqual(Math.floor(beforeResize.pooledParticleCount * 0.9));

    // Drag glass slightly on mobile viewport and pour Cherry to create Cherry Coke
    await dragGlassByWorldCoords(page, 415, 145, 8);
    await pourDrinkForFrames(page, 'cherry', 50, 55);

    const mixSnap = await getSnapshot(page);
    expect(mixSnap.liquid.colorHistory).toEqual(['coca-cola', 'cherry']);
    const expectedRGB = computeExpectedWeightedRGB(mixSnap.liquid.drinkComposition);
    expectRGBCloseTo(mixSnap.liquid.averageColorRGB, expectedRGB, 8);

    const [r, g, b] = mixSnap.liquid.averageColorRGB;
    expect(r).toBeGreaterThan(105);
    expect(r).toBeLessThan(185);
    expect(g).toBeGreaterThanOrEqual(18);
    expect(g).toBeLessThanOrEqual(30);
    expect(b).toBeGreaterThan(22);
    expect(b).toBeLessThan(52);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-09: Asymmetric volume-weighted ratio shift: 1:1 vs 1:3 (fanta + cherry) monotonically shifts RGB toward crimson cherry', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Stage 1: 1:1 mix (30 frames Fanta + 30 frames Cherry)
    await pourDrinkForFrames(page, 'fanta', 30, 20);
    await pourDrinkForFrames(page, 'cherry', 30, 45);
    const snap1to1 = await getSnapshot(page);
    const expected1to1 = computeExpectedWeightedRGB(snap1to1.liquid.drinkComposition);
    expectRGBCloseTo(snap1to1.liquid.averageColorRGB, expected1to1, 8);

    // Stage 2: Pour another 60 frames of Cherry to reach ~1:3 (25% Fanta + 75% Cherry)
    await pourDrinkForFrames(page, 'cherry', 60, 50);
    const snap1to3 = await getSnapshot(page);
    const expected1to3 = computeExpectedWeightedRGB(snap1to3.liquid.drinkComposition);
    expectRGBCloseTo(snap1to3.liquid.averageColorRGB, expected1to3, 8);

    expect(snap1to3.liquid.drinkComposition['cherry']).toBeGreaterThan(
      snap1to1.liquid.drinkComposition['cherry'] + 0.15
    );
    // Green channel drops toward Cherry (24) while Blue channel rises toward Cherry (62)
    expect(snap1to3.liquid.averageColorRGB[1]).toBeLessThan(snap1to1.liquid.averageColorRGB[1] - 10);
    expect(snap1to3.liquid.averageColorRGB[2]).toBeGreaterThan(snap1to1.liquid.averageColorRGB[2] + 6);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-10: Vertical + horizontal glass lift (y: 145 -> 230) while mixing low-carbonation cherry (0.40) and high-carbonation sprite (0.95)', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Lift glass higher toward nozzles (x = 410, y = 230)
    await dragGlassByWorldCoords(page, 410, 230, 12);
    const liftedSnap = await getSnapshot(page);
    expect(liftedSnap.glass.y).toBeGreaterThan(185);

    // Pour low-carbonation Cherry (0.40)
    await pourDrinkForFrames(page, 'cherry', 45, 25);
    const cherrySnap = await getSnapshot(page);
    expect(cherrySnap.liquid.effectiveCarbonation).toBeCloseTo(0.40, 1);

    // Pour high-carbonation Sprite (0.95) to make a Shirley Temple
    await pourDrinkForFrames(page, 'sprite', 45, 45);
    const mixSnap = await getSnapshot(page);

    expect(mixSnap.liquid.effectiveCarbonation).toBeGreaterThan(0.58);
    expect(mixSnap.bubbleCount).toBeGreaterThan(0);

    const expectedRGB = computeExpectedWeightedRGB(mixSnap.liquid.drinkComposition);
    expectRGBCloseTo(mixSnap.liquid.averageColorRGB, expectedRGB, 8);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-11: Off-button pointer release (EC1) stops pour while canvas glass drag continues, followed by pointercancel (EC6) stopping drag', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Start pouring Fanta with pointerId = 1
    await startPourButton(page, 'fanta', 'pointer', 1);
    await stepFrames(page, 35);

    // Start dragging glass on canvas with pointerId = 2
    const canvas = page.getByTestId('fountain-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width * 0.5;
    const startY = box!.y + box!.height * (1 - 145 / 600);

    await page.evaluate(
      ({ x, y }) => {
        const c = document.querySelector('[data-testid="fountain-canvas"]') as HTMLElement;
        c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 2, pointerType: 'touch' }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 45, clientY: y, pointerId: 2, pointerType: 'touch' }));
      },
      { x: startX, y: startY }
    );
    await stepFrames(page, 5);

    // Release pointerId = 1 on window (off-button EC1): pour stops, but pointerId = 2 drag stays active
    await stopPourButton(page, 'fanta', 'pointer', 1, true);
    await stepFrames(page, 2);

    const midSnap = await getSnapshot(page);
    expect(midSnap.activeDrinks).toEqual([]);
    expect(midSnap.glass.isDragging).toBe(true);

    // Cancel pointerId = 2 (EC6): drag stops cleanly
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 2, pointerType: 'touch' }));
    });
    await stepFrames(page, 25);

    const finalSnap = await getSnapshot(page);
    expect(finalSnap.glass.isDragging).toBe(false);
    expect(finalSnap.glass.vx).toBe(0);
    expect(finalSnap.pooledParticleCount).toBeGreaterThan(15);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T3-12: 4-way telemetry & rendering synchronization (__SODA_SIM__ <-> __SODA_FOUNTAIN__ <-> DOM data-* <-> WebGL readPixels) after pour + drag + mix', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    await pourDrinkForFrames(page, 'coca-cola', 45, 20);
    await dragGlassByWorldCoords(page, 432, 145, 10);
    await pourDrinkForFrames(page, 'fanta', 45, 50);

    const syncData = await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      const simSnap = w.__SODA_SIM__!.getSnapshot();
      const fountainSnap = w.__SODA_FOUNTAIN__!.getSnapshot();
      const liquidPx = w.__SODA_SIM__!.sampleGlassLiquidPixel();
      return { simSnap, fountainSnap, liquidPx };
    });

    const { simSnap, fountainSnap, liquidPx } = syncData;
    expect(simSnap.pooledParticleCount).toBe(fountainSnap.pooledParticleCount);
    expect(simSnap.glass.x).toBe(fountainSnap.glass.x);
    expect(simSnap.liquid.averageColorRGB).toEqual(fountainSnap.liquid.averageColorRGB);
    expect(simSnap.fluid.particleOrMassCount).toBe(simSnap.pooledParticleCount);

    const [r, g, b] = simSnap.liquid.averageColorRGB;
    const expectedNormX = simSnap.glass.normX.toFixed(2);
    const expectedFillRatio = simSnap.liquid.fillLevel.toFixed(2);
    const expectedFillPct = String(Math.round(simSnap.liquid.fillLevel * 100));

    const canvas = page.locator('#fountain-canvas');
    await expect(canvas).toHaveAttribute('data-glass-x', expectedNormX);
    await expect(canvas).toHaveAttribute('data-fill-ratio', expectedFillRatio);
    await expect(canvas).toHaveAttribute('data-avg-rgb', `${r},${g},${b}`);
    await expect(page.getByTestId('mixed-color-swatch')).toHaveAttribute('data-rgb', `${r},${g},${b}`);
    await expect(page.getByTestId('mixed-color-swatch')).toHaveAttribute('data-fill-percent', expectedFillPct);
    await expect(page.getByTestId('fill-readout')).toHaveText(`${expectedFillPct}%`);

    const rawCenterPx = await readRawCanvasPixelAtWorld(page, simSnap.glass.x, 90);
    expect(liquidPx[3]).toBe(255);
    expect(rawCenterPx[3]).toBe(255);
    expect(liquidPx[0]).toBeGreaterThan(40);
    expect(errors.consoleErrors).toEqual([]);
  });
});
