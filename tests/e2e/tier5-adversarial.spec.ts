import { expect, test } from '@playwright/test';
import {
  ALL_DRINK_IDS,
  DRINK_CATALOG_RGB,
  SELECTORS,
  SodaWindow,
  assertRgbCloseTo,
  colorDistanceRGB,
  getCanvasDomAttributes,
  getDrinkButtonState,
  getSimulationSnapshot,
  gotoAndWaitForReady,
  inspectWebGLContext,
  sampleGlassLiquidPixel,
  sampleWorldPixel,
  stepSimulationFrames,
  worldToClientCoords,
} from './helpers';

test.describe('Tier 5: White-Box Adversarial & Defensive Guard Coverage (T5-01..T5-10)', () => {
  test('T5-01: Multi-source input hold reference counting (Pointer + Keyboard + API on same drink) and selective stopPouring(drinkId)', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    // Hold 'coca-cola' simultaneously via Pointer (pointerId=1), Keyboard ('1'), and Programmatic API, plus 'fanta' via Keyboard ('2')
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      const colaBtn = document.querySelector(
        '[data-testid="drink-btn-coca-cola"]',
      ) as HTMLElement;
      const rect = colaBtn.getBoundingClientRect();
      colaBtn.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          code: 'Digit1',
          bubbles: true,
        }),
      );
      w.__SODA_SIM__!.startPouring('coca-cola');

      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '2',
          code: 'Digit2',
          bubbles: true,
        }),
      );
    });

    let snap = await stepSimulationFrames(page, 20);
    expect(snap.activeDrinks).toEqual(['coca-cola', 'fanta']);

    // Release Pointer 1 on Coca-Cola -> still held by Keyboard '1' and API
    await page.evaluate(() => {
      const colaBtn = document.querySelector(
        '[data-testid="drink-btn-coca-cola"]',
      ) as HTMLElement;
      colaBtn.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
        }),
      );
    });
    let colaState = await getDrinkButtonState(page, 'coca-cola');
    expect(colaState.active).toBe(true);
    expect(colaState.ariaPressed).toBe(true);

    // Release Keyboard '1' -> still held by Programmatic API
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: '1',
          code: 'Digit1',
          bubbles: true,
        }),
      );
    });
    colaState = await getDrinkButtonState(page, 'coca-cola');
    expect(colaState.active).toBe(true);

    // Call selective stopPouring('coca-cola') -> stops 'coca-cola' while 'fanta' continues pouring
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring('coca-cola');
    });
    colaState = await getDrinkButtonState(page, 'coca-cola');
    const fantaState = await getDrinkButtonState(page, 'fanta');
    expect(colaState.active).toBe(false);
    expect(fantaState.active).toBe(true);

    const domAttrs = await getCanvasDomAttributes(page);
    expect(domAttrs.activeDrinks).toEqual(['fanta']);

    snap = await stepSimulationFrames(page, 20);
    expect(snap.activeDrinks).toEqual(['fanta']);

    // Release Keyboard '2' -> all pours stop cleanly
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: '2',
          code: 'Digit2',
          bubbles: true,
        }),
      );
    });
    snap = await stepSimulationFrames(page, 30);
    expect(snap.activeDrinks).toEqual([]);
    expect(snap.pooledParticleCount).toBeGreaterThan(30);
    tracker.assertNoErrors();
  });

  test('T5-02: emptyGlass() vs reset() position preservation after moving glass to custom (x, y) and mixing drinks', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.moveGlassTo(460, 200);
      w.__SODA_SIM__!.startPouring('fanta');
      w.__SODA_SIM__!.startPouring('berry-blue');
    });

    await stepSimulationFrames(page, 40);

    // Selective stopPouring('fanta') while 'berry-blue' continues
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring('fanta');
    });
    let domAttrs = await getCanvasDomAttributes(page);
    expect(domAttrs.activeDrinks).toEqual(['berry-blue']);

    await stepSimulationFrames(page, 20);
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring();
    });
    let snap = await stepSimulationFrames(page, 30);
    expect(snap.pooledParticleCount).toBeGreaterThan(25);
    expect(snap.glass.x).toBeCloseTo(460, 1);
    expect(snap.glass.y).toBeCloseTo(200, 1);

    // Call emptyGlass() -> clears all liquid/bubbles while preserving glass (460, 200)
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.emptyGlass();
    });

    snap = await getSimulationSnapshot(page);
    expect(snap.pooledParticleCount).toBe(0);
    expect(snap.totalParticleCount).toBe(0);
    expect(snap.liquid.fillLevel).toBe(0);
    expect(snap.glass.x).toBeCloseTo(460, 1);
    expect(snap.glass.y).toBeCloseTo(200, 1);

    domAttrs = await getCanvasDomAttributes(page);
    expect(domAttrs.fillRatio).toBe(0);
    expect(domAttrs.glassX).toBeCloseTo(Number((460 / 800).toFixed(2)), 2);

    const emptyLiquidPx = await sampleGlassLiquidPixel(page);
    assertRgbCloseTo(
      [emptyLiquidPx[0], emptyLiquidPx[1], emptyLiquidPx[2]],
      [16, 22, 34],
      15,
      25,
    );

    // Subsequent reset() restores default (400, 145)
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.reset();
    });
    snap = await getSimulationSnapshot(page);
    expect(snap.glass.x).toBe(400);
    expect(snap.glass.y).toBe(145);
    tracker.assertNoErrors();
  });

  test('T5-03: Standalone legacy TouchEvent & MouseEvent fallbacks (without PointerEvent) and selective multi-touch touchcancel', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    // Dispatch standalone TouchEvent('touchstart') without PointerEvent for Cherry (id 10) and Sprite (id 20)
    await page.evaluate(() => {
      const cherryBtn = document.querySelector(
        '[data-testid="drink-btn-cherry"]',
      ) as HTMLElement;
      const spriteBtn = document.querySelector(
        '[data-testid="drink-btn-sprite"]',
      ) as HTMLElement;

      const t10 = new Touch({
        identifier: 10,
        target: cherryBtn,
        clientX: 100,
        clientY: 25,
      });
      cherryBtn.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [t10],
          targetTouches: [t10],
          changedTouches: [t10],
        }),
      );

      const t20 = new Touch({
        identifier: 20,
        target: spriteBtn,
        clientX: 200,
        clientY: 25,
      });
      spriteBtn.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [t10, t20],
          targetTouches: [t20],
          changedTouches: [t20],
        }),
      );
    });

    let snap = await stepSimulationFrames(page, 30);
    expect(snap.activeDrinks).toEqual(['sprite', 'cherry']);

    // Selective touchcancel on touch 10 (cherry) only -> sprite (touch 20) stays pouring
    await page.evaluate(() => {
      const cherryBtn = document.querySelector(
        '[data-testid="drink-btn-cherry"]',
      ) as HTMLElement;
      const t10 = new Touch({
        identifier: 10,
        target: cherryBtn,
        clientX: 100,
        clientY: 25,
      });
      window.dispatchEvent(
        new TouchEvent('touchcancel', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [t10],
        }),
      );
    });

    snap = await stepSimulationFrames(page, 25);
    expect(snap.activeDrinks).toEqual(['sprite']);

    // Release touch 20 via touchend
    await page.evaluate(() => {
      const spriteBtn = document.querySelector(
        '[data-testid="drink-btn-sprite"]',
      ) as HTMLElement;
      const t20 = new Touch({
        identifier: 20,
        target: spriteBtn,
        clientX: 200,
        clientY: 25,
      });
      window.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [t20],
        }),
      );
    });

    snap = await stepSimulationFrames(page, 30);
    expect(snap.activeDrinks).toEqual([]);
    expect(snap.liquid.drinkComposition.cherry).toBeGreaterThan(0.15);
    expect(snap.liquid.drinkComposition.sprite).toBeGreaterThan(0.15);

    // Standalone MouseEvent drag on #fountain-canvas without PointerEvent
    const startClient = await worldToClientCoords(page, 400, 145);
    const endClient = await worldToClientCoords(page, 480, 145);

    await page.evaluate(
      ({ sx, sy, ex, ey }) => {
        const canvas = document.querySelector(
          '#fountain-canvas',
        ) as HTMLElement;
        canvas.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: sx,
            clientY: sy,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: ex,
            clientY: ey,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: ex,
            clientY: ey,
          }),
        );
      },
      {
        sx: startClient.clientX,
        sy: startClient.clientY,
        ex: endClient.clientX,
        ey: endClient.clientY,
      },
    );

    snap = await getSimulationSnapshot(page);
    expect(snap.glass.x).toBeCloseTo(480, 1);
    expect(snap.glass.isDragging).toBe(false);
    expect(snap.glass.vx).toBe(0);
    expect(snap.glass.vy).toBe(0);
    tracker.assertNoErrors();
  });

  test('T5-04: Adversarial input rejection (right/middle mouse buttons, Ctrl/Alt/Meta + Digit keys, invalid DrinkId, and shifted Digit1 code fallback)', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      const colaBtn = document.querySelector(
        '[data-testid="drink-btn-coca-cola"]',
      ) as HTMLElement;
      const canvas = document.querySelector('#fountain-canvas') as HTMLElement;

      // Middle click (button: 1) and right click (button: 2) + contextmenu
      for (const btnCode of [1, 2]) {
        colaBtn.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: btnCode,
          }),
        );
        colaBtn.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: btnCode,
          }),
        );
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: btnCode,
            clientX: 200,
            clientY: 300,
          }),
        );
        canvas.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: btnCode,
            clientX: 200,
            clientY: 300,
          }),
        );
      }
      colaBtn.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      canvas.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );

      // Modifier keys Ctrl+1, Alt+2, Meta+3
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          code: 'Digit1',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '2',
          code: 'Digit2',
          altKey: true,
          bubbles: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '3',
          code: 'Digit3',
          metaKey: true,
          bubbles: true,
        }),
      );

      // Invalid programmatic DrinkIds
      w.__SODA_SIM__!.startPouring('not-a-drink' as never);
      w.__SODA_SIM__!.stopPouring('not-a-drink' as never);
    });

    let snap = await stepSimulationFrames(page, 10);
    expect(snap.activeDrinks).toEqual([]);
    expect(snap.glass.isDragging).toBe(false);
    expect(snap.totalParticleCount).toBe(0);

    // Shifted key event { key: '!', code: 'Digit1' } activates 'coca-cola' via KEY_TO_DRINK[e.code]
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '!',
          code: 'Digit1',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    snap = await stepSimulationFrames(page, 40);
    expect(snap.activeDrinks).toEqual(['coca-cola']);

    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: '!',
          code: 'Digit1',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    snap = await stepSimulationFrames(page, 30);
    expect(snap.activeDrinks).toEqual([]);
    expect(snap.pooledParticleCount).toBeGreaterThan(25);
    tracker.assertNoErrors();
  });

  test('T5-05: manualStepMode deferred render (renderDirty) lazy flush on immediate samplePixelAtWorld and sampleGlassLiquidPixel', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    // Pour Fanta at default x=400 and settle
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.startPouring('fanta');
    });
    await stepSimulationFrames(page, 65);
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring();
    });
    await stepSimulationFrames(page, 35);

    // Drag glass via PointerEvents on #fountain-canvas from x=400 to x=520 WITHOUT calling stepFrames afterward
    const startClient = await worldToClientCoords(page, 400, 145);
    const endClient = await worldToClientCoords(page, 520, 145);

    const immediateReadback = await page.evaluate(
      ({ sx, sy, ex, ey }) => {
        const w = window as unknown as SodaWindow;
        const canvas = document.querySelector(
          '#fountain-canvas',
        ) as HTMLElement;
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerId: 5,
            button: 0,
            clientX: sx,
            clientY: sy,
          }),
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerId: 5,
            button: 0,
            clientX: ex,
            clientY: ey,
          }),
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            pointerId: 5,
            button: 0,
            clientX: ex,
            clientY: ey,
          }),
        );

        // Immediately sample pixels WITHOUT calling stepFrames: must flush renderDirty lazily!
        const baseAtNewX = w.__SODA_SIM__!.samplePixelAtWorld(520, 58);
        const liquidPx = w.__SODA_SIM__!.sampleGlassLiquidPixel();

        // Also trigger startPouring('berry-blue') (sets renderDirty = true) and immediately sample nozzle
        w.__SODA_SIM__!.startPouring('berry-blue');
        const activeNozzlePx = w.__SODA_SIM__!.samplePixelAtWorld(440, 490);
        w.__SODA_SIM__!.stopPouring('berry-blue');

        return { baseAtNewX, liquidPx, activeNozzlePx };
      },
      {
        sx: startClient.clientX,
        sy: startClient.clientY,
        ex: endClient.clientX,
        ey: endClient.clientY,
      },
    );

    // Glass base at (520, 58) is bright cool refractive glass (blue channel > 120)
    expect(immediateReadback.baseAtNewX[2]).toBeGreaterThan(120);
    // Liquid pixel inside moved glass at x=520 is Fanta orange
    assertRgbCloseTo(
      [
        immediateReadback.liquidPx[0],
        immediateReadback.liquidPx[1],
        immediateReadback.liquidPx[2],
      ],
      DRINK_CATALOG_RGB.fanta,
      25,
      38,
    );
    // Active berry-blue nozzle at (440, 490) has high blue & boosted green
    expect(immediateReadback.activeNozzlePx[2]).toBeGreaterThan(220);
    tracker.assertNoErrors();
  });

  test('T5-06: Document visibilitychange (hidden -> visible) mid-pour and mid-drag state recovery', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    const startClient = await worldToClientCoords(page, 400, 145);
    const dragClient = await worldToClientCoords(page, 450, 145);

    await page.evaluate(
      ({ sx, sy, dx, dy }) => {
        const blueBtn = document.querySelector(
          '[data-testid="drink-btn-berry-blue"]',
        ) as HTMLElement;
        const canvas = document.querySelector(
          '#fountain-canvas',
        ) as HTMLElement;

        blueBtn.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 0,
          }),
        );
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerId: 2,
            button: 0,
            clientX: sx,
            clientY: sy,
          }),
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerId: 2,
            button: 0,
            clientX: dx,
            clientY: dy,
          }),
        );
      },
      {
        sx: startClient.clientX,
        sy: startClient.clientY,
        dx: dragClient.clientX,
        dy: dragClient.clientY,
      },
    );

    let snap = await stepSimulationFrames(page, 15);
    expect(snap.activeDrinks).toEqual(['berry-blue']);
    expect(snap.glass.isDragging).toBe(true);

    // Spoof document.visibilityState = 'hidden' and dispatch visibilitychange
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    snap = await getSimulationSnapshot(page);
    expect(snap.activeDrinks).toEqual([]);
    expect(snap.glass.isDragging).toBe(false);
    expect(snap.glass.vx).toBe(0);
    expect(snap.glass.vy).toBe(0);

    const blueBtnState = await getDrinkButtonState(page, 'berry-blue');
    expect(blueBtnState.active).toBe(false);

    // Restore visibilityState = 'visible' and verify subsequent pouring works cleanly
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.startPouring('sprite');
    });

    snap = await stepSimulationFrames(page, 40);
    expect(snap.activeDrinks).toEqual(['sprite']);
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring();
    });
    tracker.assertNoErrors();
  });

  test('T5-07: Mid-air post-pour stream co-translation (coTranslateFalling) capturing in-flight droplets when glass moves', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    // Emit a short burst of Sprite (12 frames = 36 particles in mid-air) and stop pouring
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.startPouring('sprite');
    });
    let snap = await stepSimulationFrames(page, 12);
    expect(snap.fallingParticleCount).toBe(36);

    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring();
      // Move glass right while activeDrinks is empty -> coTranslateFalling = true shifts in-flight stream with glass
      w.__SODA_SIM__!.moveGlassTo(440, 145);
    });

    snap = await stepSimulationFrames(page, 35);
    expect(snap.glass.x).toBe(440);
    expect(snap.pooledParticleCount).toBe(36);
    expect(snap.spilledParticleCount).toBe(0);
    tracker.assertNoErrors();
  });

  test('T5-08: High-velocity rim slosh side-wall spill and spilled metaball splat rendering', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    // Fill glass to ~94% capacity (~450 pooled particles) with Cherry
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.startPouring('cherry');
    });
    await stepSimulationFrames(page, 162);
    await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      w.__SODA_SIM__!.stopPouring();
    });
    let snap = await stepSimulationFrames(page, 25);
    expect(snap.liquid.fillLevel).toBeGreaterThanOrEqual(0.92);
    expect(snap.pooledParticleCount).toBeGreaterThanOrEqual(442);

    // Perform rapid high-velocity horizontal whip back and forth to slosh top-layer particles over the side walls
    const sawSpill = await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      const sim = w.__SODA_SIM__!;
      const targets = [260, 540, 260, 540, 260, 540, 400];
      let maxSpilled = 0;
      for (const tx of targets) {
        sim.moveGlassTo(tx, 145);
        sim.stepFrames(1);
        const s = sim.getSnapshot();
        if (s.spilledParticleCount > maxSpilled) {
          maxSpilled = s.spilledParticleCount;
        }
      }
      return maxSpilled;
    });

    snap = await getSimulationSnapshot(page);
    expect(sawSpill).toBeGreaterThan(0);
    expect(snap.liquid.isOverflowing).toBe(true);

    const ctxInfo = await inspectWebGLContext(page);
    expect(ctxInfo.isContextLost).toBe(false);
    tracker.assertNoErrors();
  });

  test('T5-09: Sustained 5-nozzle deluge beyond MAX_PARTICLES (1800) safety pruning cap', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    // Move glass far left so all 5 nozzles spill into drip tray, then pour all 5 drinks for 135 frames (2025 emitted particles)
    await page.evaluate((drinkIds) => {
      const w = window as unknown as SodaWindow;
      const sim = w.__SODA_SIM__!;
      sim.moveGlassTo(120, 145);
      for (const id of drinkIds) {
        sim.startPouring(id);
      }
      sim.stepFrames(135);
      sim.stopPouring();
    }, ALL_DRINK_IDS);

    const snap = await getSimulationSnapshot(page);
    expect(snap.totalParticleCount).toBe(1800);
    expect(snap.spilledParticleCount).toBeGreaterThan(1000);
    expect(snap.fallingParticleCount).toBeGreaterThan(500);
    expect(snap.pooledParticleCount).toBe(0);
    expect(Number.isFinite(snap.glass.x)).toBe(true);

    const ctxInfo = await inspectWebGLContext(page);
    expect(ctxInfo.isContextLost).toBe(false);
    tracker.assertNoErrors();
  });

  test('T5-10: Normalized [0..1] coordinate API (moveGlassTo), non-finite API input resilience, and out-of-bounds samplePixelAtWorld clamping', async ({
    page,
  }) => {
    const tracker = await gotoAndWaitForReady(page);

    const result = await page.evaluate(() => {
      const w = window as unknown as SodaWindow;
      const sim = w.__SODA_SIM__!;

      // 1. Normalized [0..1] x and y coordinates
      sim.moveGlassTo(0.25, 0.35);
      const afterNorm = sim.getSnapshot();

      // 2. Non-finite inputs to moveGlassTo and stepFrames
      const frameBefore = sim.frameCount;
      sim.moveGlassTo(NaN, Infinity);
      sim.stepFrames(-5, NaN);
      const afterNaN = sim.getSnapshot();

      // 3. Out-of-bounds and non-finite samplePixelAtWorld calls
      const pxNeg = sim.samplePixelAtWorld(-500, -500);
      const pxPos = sim.samplePixelAtWorld(5000, 5000);
      const pxNaN = sim.samplePixelAtWorld(NaN, Infinity);

      return {
        afterNorm,
        frameBefore,
        afterNaN,
        pxNeg,
        pxPos,
        pxNaN,
      };
    });

    expect(result.afterNorm.glass.x).toBeCloseTo(200, 3);
    expect(result.afterNorm.glass.y).toBeCloseTo(210, 3);
    expect(result.afterNorm.glass.normX).toBeCloseTo(0.25, 4);
    expect(result.afterNorm.glass.normY).toBeCloseTo(0.35, 4);

    // Non-finite calls leave state intact and finite
    expect(result.afterNaN.glass.x).toBeCloseTo(200, 3);
    expect(result.afterNaN.glass.y).toBeCloseTo(210, 3);
    expect(Number.isFinite(result.afterNaN.glass.vx)).toBe(true);
    expect(Number.isFinite(result.afterNaN.glass.vy)).toBe(true);
    expect(result.afterNaN.frameCount).toBe(result.frameBefore);

    // Out-of-bounds pixel readbacks return valid [R, G, B, 255] studio background tuples
    for (const px of [result.pxNeg, result.pxPos, result.pxNaN]) {
      expect(px).toHaveLength(4);
      expect(px[3]).toBe(255);
      expect(colorDistanceRGB([px[0], px[1], px[2]], [16, 22, 34])).toBeLessThan(
        20,
      );
    }

    const domAttrs = await getCanvasDomAttributes(page);
    expect(domAttrs.glassX).toBeCloseTo(0.25, 2);
    tracker.assertNoErrors();
  });
});
