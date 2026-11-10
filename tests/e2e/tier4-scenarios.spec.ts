import { test, expect } from '@playwright/test';
import {
  ALL_DRINK_IDS,
  DRINK_CATALOG_EXPECTED,
  DRINK_CATALOG_RGB,
  waitForSimReady,
  getSnapshot,
  stepFrames,
  startPourButton,
  stopPourButton,
  pourDrinkForFrames,
  pourDrinkWithTouch,
  dragGlassByWorldCoords,
  dragGlassToWorld,
  agitateGlassWithMouse,
  clickResetButton,
  sampleGlassLiquidPixel,
  computeExpectedWeightedRGB,
  expectRGBCloseTo,
  attachErrorTracking,
} from './helpers';

test.describe('Tier 4: Real-World End-to-End Application Scenarios', () => {
  test('T4-01: Classic 2-Drink Custom Creation Journey ("Spezi / Mezzo Mix": Coca-Cola + Fanta + Glass Swirl)', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Step 1: Verify clean initial state
    const initSnap = await getSnapshot(page);
    expect(initSnap.pooledParticleCount).toBe(0);
    expect(initSnap.glass.x).toBe(400);

    // Step 2: Pour Coca-Cola to ~25-35% fill and swirl glass
    await pourDrinkForFrames(page, 'coca-cola', 70, 25);
    const colaSnap = await getSnapshot(page);
    expect(colaSnap.liquid.fillLevel).toBeGreaterThan(0.10);
    expectRGBCloseTo(colaSnap.liquid.averageColorRGB, DRINK_CATALOG_RGB['coca-cola'], 8);
    const colaPx = await sampleGlassLiquidPixel(page);

    // Step 3: Top up with equal Fanta pour and agitate glass to homogenize
    await pourDrinkForFrames(page, 'fanta', 70, 15);
    await agitateGlassWithMouse(page, 2, 55, 6);

    const mixSnap = await getSnapshot(page);
    expect(mixSnap.liquid.fillLevel).toBeGreaterThan(colaSnap.liquid.fillLevel + 0.08);
    expect(mixSnap.liquid.colorHistory).toEqual(['coca-cola', 'fanta']);
    expect(mixSnap.liquid.mixingVariance).toBeLessThan(0.03);

    const expectedRGB = computeExpectedWeightedRGB(mixSnap.liquid.drinkComposition);
    expectRGBCloseTo(mixSnap.liquid.averageColorRGB, expectedRGB, 8);

    const mixPx = await sampleGlassLiquidPixel(page);
    expect(mixPx[0]).toBeGreaterThan(colaPx[0] + 15);
    expect(mixPx[3]).toBe(255);
    expect(errors.consoleErrors).toEqual([]);
    expect(errors.pageErrors).toEqual([]);
  });

  test('T4-02: 5-Drink "Fountain Suicide / Swamp Water" Barista Recipe Journey Under Each Nozzle', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    const checkpoints: Array<[number, number, number]> = [];

    for (const drinkId of ALL_DRINK_IDS) {
      const spec = DRINK_CATALOG_EXPECTED[drinkId];
      await dragGlassByWorldCoords(page, spec.nozzleX, 145, 8);
      await pourDrinkForFrames(page, drinkId, 30, 25);

      const snap = await getSnapshot(page);
      const expected = computeExpectedWeightedRGB(snap.liquid.drinkComposition);
      expectRGBCloseTo(snap.liquid.averageColorRGB, expected, 10);
      checkpoints.push([...snap.liquid.averageColorRGB]);
    }

    // Center glass and swirl to settle the 5-drink blend
    await dragGlassByWorldCoords(page, 400, 145, 8);
    await stepFrames(page, 50);

    const finalSnap = await getSnapshot(page);
    expect(finalSnap.liquid.colorHistory).toEqual([...ALL_DRINK_IDS]);
    for (const drinkId of ALL_DRINK_IDS) {
      expect(finalSnap.liquid.drinkComposition[drinkId]).toBeGreaterThan(0.12);
    }

    // Verify cumulative trajectory shifted at each drink addition
    expect(checkpoints[1][0]).toBeGreaterThan(checkpoints[0][0] + 40); // +Fanta increases Red
    expect(checkpoints[2][1]).toBeGreaterThan(checkpoints[1][1] + 25); // +Sprite increases Green
    expect(checkpoints[4][2]).toBeGreaterThan(checkpoints[3][2] + 15); // +Berry-Blue increases Blue

    // Final 5-drink mean ~[143, 114, 105], effectiveCarbonation ~0.69
    const [r, g, b] = finalSnap.liquid.averageColorRGB;
    expect(r).toBeGreaterThan(115);
    expect(r).toBeLessThan(175);
    expect(g).toBeGreaterThan(85);
    expect(g).toBeLessThan(145);
    expect(b).toBeGreaterThan(75);
    expect(b).toBeLessThan(135);
    expect(finalSnap.liquid.effectiveCarbonation).toBeGreaterThan(0.58);
    expect(finalSnap.liquid.effectiveCarbonation).toBeLessThan(0.80);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T4-03: Touch-First Mobile User Session (375x667 Viewport, Multi-Touch Pour + Glass Drag + Reset)', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page, { viewport: { width: 375, height: 667 } });

    // Verify mobile viewport has zero scrollbars and touch-action: none on canvas
    const mobileLayout = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="fountain-canvas"]') as HTMLElement;
      return {
        touchAction: window.getComputedStyle(c).touchAction,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(mobileLayout.touchAction).toBe('none');
    expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.innerWidth);

    // Touch-pour Blue Raspberry
    await pourDrinkWithTouch(page, 'berry-blue', 50, 20, 1);

    // Simultaneous two-finger touch: Finger 1 holds Sprite while Finger 2 drags glass on canvas
    await startPourButton(page, 'sprite', 'touch', 1);
    await dragGlassToWorld(page, 370, 145, 8, 'touch', 3, 2);
    await dragGlassToWorld(page, 420, 145, 8, 'touch', 3, 2);
    await stopPourButton(page, 'sprite', 'touch', 1);
    await stepFrames(page, 45);

    const aquaSnap = await getSnapshot(page);
    expect(aquaSnap.liquid.colorHistory).toEqual(['berry-blue', 'sprite']);
    const expectedRGB = computeExpectedWeightedRGB(aquaSnap.liquid.drinkComposition);
    expectRGBCloseTo(aquaSnap.liquid.averageColorRGB, expectedRGB, 10);

    const px = await sampleGlassLiquidPixel(page);
    expect(px[2]).toBeGreaterThan(80);
    expect(px[3]).toBe(255);

    // Tap Reset button and verify clean recovery
    const resetSnap = await clickResetButton(page);
    expect(resetSnap.pooledParticleCount).toBe(0);
    expect(resetSnap.glass.normX).toBeCloseTo(0.5, 2);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T4-04: Spill, Missed Pour, Rim Overflow & Clean Recovery Workflow', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // 1. Move glass far right (x = 620) and pour Coca-Cola into the drip tray
    await dragGlassByWorldCoords(page, 620, 145, 10);
    await pourDrinkForFrames(page, 'coca-cola', 40, 180);
    const missedSnap = await getSnapshot(page);
    expect(missedSnap.pooledParticleCount).toBe(0);
    expect(missedSnap.spilledParticleCount).toBe(0);

    // 2. Move glass back to center (x = 400) and overfill with Cherry past 100%
    await dragGlassByWorldCoords(page, 400, 145, 10);
    await pourDrinkForFrames(page, 'cherry', 310, 15);
    const overflowSnap = await getSnapshot(page);
    expect(overflowSnap.liquid.fillLevel).toBe(1.0);
    expect(overflowSnap.liquid.isOverflowing).toBe(true);

    // 3. Reset and pour clean Fanta
    await clickResetButton(page);
    await pourDrinkForFrames(page, 'fanta', 65, 35);
    const recoverySnap = await getSnapshot(page);

    expect(recoverySnap.liquid.colorHistory).toEqual(['fanta']);
    expect(recoverySnap.liquid.drinkComposition['coca-cola']).toBe(0);
    expect(recoverySnap.liquid.drinkComposition['cherry']).toBe(0);
    expect(recoverySnap.liquid.drinkComposition['fanta']).toBeCloseTo(1.0, 3);
    expectRGBCloseTo(recoverySnap.liquid.averageColorRGB, DRINK_CATALOG_RGB.fanta, 8);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T4-05: Sequential Multi-Glass Bartender Session (3 Distinct Recipes Across Resets)', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Recipe 1: Cherry Limeade (Cherry + Sprite)
    await pourDrinkForFrames(page, 'cherry', 45, 20);
    await pourDrinkForFrames(page, 'sprite', 45, 45);
    const recipe1 = await getSnapshot(page);
    expect(recipe1.liquid.colorHistory).toEqual(['cherry', 'sprite']);
    expectRGBCloseTo(
      recipe1.liquid.averageColorRGB,
      computeExpectedWeightedRGB(recipe1.liquid.drinkComposition),
      8
    );

    await clickResetButton(page);

    // Recipe 2: Purple Berry Punch (Blue Raspberry + Cherry)
    await pourDrinkForFrames(page, 'berry-blue', 45, 20);
    await pourDrinkForFrames(page, 'cherry', 45, 45);
    const recipe2 = await getSnapshot(page);
    expect(recipe2.liquid.colorHistory).toEqual(['berry-blue', 'cherry']);
    expect(recipe2.liquid.drinkComposition['sprite']).toBe(0);
    expectRGBCloseTo(
      recipe2.liquid.averageColorRGB,
      computeExpectedWeightedRGB(recipe2.liquid.drinkComposition),
      8
    );

    await clickResetButton(page);

    // Recipe 3: Citrus Cooler (Fanta + Sprite)
    await pourDrinkForFrames(page, 'fanta', 45, 20);
    await pourDrinkForFrames(page, 'sprite', 45, 45);
    const recipe3 = await getSnapshot(page);
    expect(recipe3.liquid.colorHistory).toEqual(['fanta', 'sprite']);
    expect(recipe3.liquid.drinkComposition['berry-blue']).toBe(0);
    expect(recipe3.liquid.drinkComposition['cherry']).toBe(0);
    expectRGBCloseTo(
      recipe3.liquid.averageColorRGB,
      computeExpectedWeightedRGB(recipe3.liquid.drinkComposition),
      8
    );
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T4-06: Hands-Free Keyboard Bartender + 2D Mouse Glass Choreography ("Dirty Cherry Spritzer")', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // Hold Key 1 (Coca-Cola) while sweeping glass horizontally
    await page.keyboard.down('1');
    await dragGlassToWorld(page, 370, 145, 10, 'mouse', 3);
    await page.keyboard.up('1');

    // Hold Key 4 (Cherry) while lifting glass vertically (y: 145 -> 225)
    await page.keyboard.down('4');
    await dragGlassToWorld(page, 410, 225, 10, 'mouse', 3);
    await page.keyboard.up('4');

    const liftedSnap = await getSnapshot(page);
    expect(liftedSnap.glass.y).toBeGreaterThan(180);

    // Hold Key 3 (Sprite) while lowering glass back to resting height (y: 225 -> 145)
    await page.keyboard.down('3');
    await dragGlassToWorld(page, 400, 145, 10, 'mouse', 3);
    await page.keyboard.up('3');

    await stepFrames(page, 50);
    const spritzerSnap = await getSnapshot(page);

    expect(spritzerSnap.liquid.colorHistory).toEqual(['coca-cola', 'cherry', 'sprite']);
    const expectedRGB = computeExpectedWeightedRGB(spritzerSnap.liquid.drinkComposition);
    expectRGBCloseTo(spritzerSnap.liquid.averageColorRGB, expectedRGB, 8);

    const resetSnap = await clickResetButton(page);
    expect(resetSnap.pooledParticleCount).toBe(0);
    expect(resetSnap.glass.x).toBe(400);
    expect(resetSnap.glass.y).toBe(145);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('T4-07: Continuous High-Intensity Interactive Stress & Invariant Audit Session', async ({ page }) => {
    const errors = attachErrorTracking(page);
    await waitForSimReady(page);

    // 1. Rapid cycling across all 5 drinks + simultaneous dual pours
    for (const id of ALL_DRINK_IDS) {
      await pourDrinkForFrames(page, id, 15, 5);
    }

    await page.keyboard.down('1');
    await page.keyboard.down('5');
    await stepFrames(page, 30);
    await page.keyboard.up('1');
    await page.keyboard.up('5');

    // 2. High-speed glass sweeps and viewport resizes
    await dragGlassByWorldCoords(page, 260, 180, 6);
    await dragGlassByWorldCoords(page, 540, 150, 6);
    await dragGlassByWorldCoords(page, 400, 145, 6);

    await page.setViewportSize({ width: 768, height: 1024 });
    await stepFrames(page, 10);
    await page.setViewportSize({ width: 1024, height: 768 });
    await stepFrames(page, 25);

    // 3. Audit all simulation & rendering invariants
    const snap = await getSnapshot(page);
    expect(snap.isReady).toBe(true);
    expect(Number.isFinite(snap.glass.x)).toBe(true);
    expect(Number.isFinite(snap.glass.y)).toBe(true);
    expect(snap.glass.x).toBeGreaterThanOrEqual(120);
    expect(snap.glass.x).toBeLessThanOrEqual(680);
    expect(snap.glass.y).toBeGreaterThanOrEqual(135);
    expect(snap.glass.y).toBeLessThanOrEqual(340);

    expect(snap.pooledParticleCount).toBeGreaterThan(50);
    expect(snap.liquid.fillLevel).toBeGreaterThan(0);
    expect(snap.liquid.fillLevel).toBeLessThanOrEqual(1.0);

    const compSum = Object.values(snap.liquid.drinkComposition).reduce((a, b) => a + b, 0);
    expect(compSum).toBeCloseTo(1.0, 2);
    expect(snap.liquid.mixedColorHex).toMatch(/^#[0-9a-fA-F]{6}$/);

    const px = await sampleGlassLiquidPixel(page);
    expect(px[3]).toBe(255);
    expect(errors.consoleErrors).toEqual([]);
    expect(errors.pageErrors).toEqual([]);
  });
});
