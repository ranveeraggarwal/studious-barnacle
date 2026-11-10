# E2E Test Infrastructure (`TEST_INFRA.md`)

## 1. Overview
This document defines the End-to-End (E2E) browser and WebGL verification infrastructure for **Minimal WebGL Soda Fountain Fluid Simulation (`studious-barnacle`)**.

- **Test Runner**: `@playwright/test`
- **Config File**: `tests/e2e/playwright.e2e.config.ts`
- **Browser Engine**: System Chromium (`/usr/lib/chromium/chromium`, `Chromium 156.0.8078.79`)
- **Headless WebGL Backend**: ANGLE over SwiftShader (`--headless=new --no-sandbox --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader --enable-webgl --ignore-gpu-blocklist`)
- **Application Server**: Vite dev server on `http://127.0.0.1:5173` (`npx vite --host 127.0.0.1 --port 5173`)

## 2. Execution Commands

| Task | Command |
|---|---|
| List & verify all E2E tests (Tiers 1–5, 89 tests) | `npx playwright test --list --config=tests/e2e/playwright.e2e.config.ts` |
| Run full E2E test suite (Tiers 1–5, 89 tests) | `npx playwright test --config=tests/e2e/playwright.e2e.config.ts` |
| Run Tier 1 (Feature Coverage, 30 tests) | `npx playwright test tests/e2e/tier1-features.spec.ts --config=tests/e2e/playwright.e2e.config.ts` |
| Run Tier 2 (Boundary & Corner Cases, 30 tests) | `npx playwright test tests/e2e/tier2-boundaries.spec.ts --config=tests/e2e/playwright.e2e.config.ts` |
| Run Tier 3 (Cross-Feature Combinations, 12 tests) | `npx playwright test tests/e2e/tier3-combinations.spec.ts --config=tests/e2e/playwright.e2e.config.ts` |
| Run Tier 4 (Real-World Scenarios, 7 tests) | `npx playwright test tests/e2e/tier4-scenarios.spec.ts --config=tests/e2e/playwright.e2e.config.ts` |
| Run Tier 5 (White-Box Adversarial Hardening, 10 tests) | `npx playwright test tests/e2e/tier5-adversarial.spec.ts --config=tests/e2e/playwright.e2e.config.ts` |
| Run full Vitest unit & white-box adversarial test suite (75 tests) | `npm run test:unit` |

## 3. Directory & File Structure

```text
tests/
├── unit/
│   ├── physics.test.ts        # M1: Drink catalog, SpatialHash, GlassCollider, ColorMixer, FluidWorld (20 tests)
│   ├── webgl.test.ts          # M2: Shaders, FBO, procedural meshes, 5-pass renderer (16 tests)
│   ├── ui.test.ts             # M3: Controls, DOM sync, and app integration (8 tests)
│   └── adversarial.test.ts    # Tier 5: White-box adversarial & defensive guard unit tests (31 tests)
└── e2e/
    ├── playwright.e2e.config.ts   # Self-contained Playwright + SwiftShader WebGL config
    ├── helpers.ts                 # Opaque-box DOM/Mouse/Touch/Keyboard & WebGL pixel helpers
    ├── tier1-features.spec.ts     # Tier 1: Core feature verification across F1–F6 (30 tests)
    ├── tier2-boundaries.spec.ts   # Tier 2: Boundary conditions & edge cases EC1–EC7 (30 tests)
    ├── tier3-combinations.spec.ts # Tier 3: Pairwise & multi-feature interactions (12 tests)
    ├── tier4-scenarios.spec.ts    # Tier 4: End-to-end user journeys & stress sessions (7 tests)
    └── tier5-adversarial.spec.ts  # Tier 5: White-box adversarial & defensive guard E2E tests (10 tests)
```

## 4. DOM Selector & State Attribute Contract

| Element | Selector | Required State Attributes |
|---|---|---|
| Main WebGL Canvas | `#fountain-canvas[data-testid="fountain-canvas"]` | `data-ready="true"`, `data-webgl-version="1\|2"`, `data-glass-x="0.50"`, `data-fill-ratio="0.00"`, `data-avg-rgb="0,0,0"`, `data-active-drinks=""` |
| Fountain Controls Bar | `#fountain-controls[data-testid="fountain-controls"]` | — |
| Drink Buttons (5) | `[data-testid="drink-btn-coca-cola"]`, `[data-testid="drink-btn-fanta"]`, `[data-testid="drink-btn-sprite"]`, `[data-testid="drink-btn-cherry"]`, `[data-testid="drink-btn-berry-blue"]` | `data-drink="<id>"`, `data-color="#RRGGBB"`, `data-active="true\|false"`, `aria-pressed="true\|false"` |
| Empty / Reset Button | `#reset-btn[data-testid="reset-button"]` | `data-action="empty-glass"` |
| Status Bar | `#status-bar[data-testid="status-bar"]` | — |
| Mixed Color Swatch | `#mixed-color-swatch[data-testid="mixed-color-swatch"]` | `data-rgb="R,G,B"`, `data-fill-percent="0..100"` |
| Fill Level Readout | `#fill-readout[data-testid="fill-readout"]` | Text content `0%` .. `100%` |

## 5. Drink Catalog Reference

| Drink ID | Display Name | Hex Color | RGB `(0-255)` | Carbonation | Nozzle Index | Nozzle World `(X, Y)` | Key |
|---|---|---|---|---|---|---|---|
| `coca-cola` | Coca-Cola | `#3E160C` | `[62, 22, 12]` | `0.90` | `0` | `(360, 490)` | `1` |
| `fanta` | Fanta | `#FF7D00` | `[255, 125, 0]` | `0.65` | `1` | `(380, 490)` | `2` |
| `sprite` | Sprite | `#AAF5C3` | `[170, 245, 195]` | `0.95` | `2` | `(400, 490)` | `3` |
| `cherry` | Cherry Soda | `#E4183E` | `[228, 24, 62]` | `0.40` | `3` | `(420, 490)` | `4` |
| `berry-blue` | Blue Raspberry | `#0098FF` | `[0, 152, 255]` | `0.55` | `4` | `(440, 490)` | `5` |

## 6. Deterministic Simulation & Opaque-Box Verification Methodology

1. **Real User Input Dispatch**: All E2E tests trigger drink pouring, glass dragging, and resets through genuine DOM/Mouse/Pointer/Touch/Keyboard events (`page.mouse`, `page.touchscreen`, `page.keyboard`, and synthetic `PointerEvent`/`TouchEvent`/`MouseEvent` dispatch).
2. **Deterministic Frame Advancement**: While a button or drag gesture is active, tests call `stepSimulationFrames(page, count)` / `stepFrames(page, count)` in `tests/e2e/helpers.ts`, which invokes `window.__SODA_SIM__.stepFrames(count, 1/60)` (with fallback to `page.waitForTimeout`) so physics and WebGL rendering advance deterministically without wall-clock flakiness.
3. **Triple-Layer Assertions**:
   - **DOM State Layer**: Verifies `data-*` attributes and `aria-pressed` on `#fountain-canvas`, drink buttons, `#mixed-color-swatch`, and `#fill-readout`.
   - **Simulation Telemetry Layer**: Verifies `window.__SODA_SIM__` / `window.__SODA_FOUNTAIN__` snapshots (`fallingParticleCount`, `pooledParticleCount`, `spilledParticleCount`, `glass.x`, `liquid.fillLevel`, `liquid.averageColorRGB`, `liquid.drinkComposition`, `liquid.mixingVariance`).
   - **WebGL Framebuffer Pixel Layer**: Verifies real rendered pixels via `sampleGlassLiquidPixel()`, `samplePixelAtWorld(x, y)`, and direct `gl.readPixels()` on `#fountain-canvas`.
