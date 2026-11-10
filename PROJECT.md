# Project: Minimal WebGL Soda Fountain Fluid Simulation (`studious-barnacle`)

## Architecture

### Overview
A minimal, single-viewport web application featuring an OpenGL ES (WebGL2 with WebGL1 fallback) `<canvas>` that simulates pouring drinks (Coca-Cola, Fanta, Sprite, Cherry Soda, Blue Raspberry) from a soda fountain into a user-movable glass with real-time 2D SPH fluid physics, screen-space metaball shader rendering, fluid-structure sloshing/overflow, and dynamic multi-drink color mixing.

### Canonical Coordinate System & Geometry
- **Simulation World Space**: Fixed logical coordinate system of `W = 800` by `H = 600` units with origin `(0, 0)` at the **bottom-left** (`x ∈ [0, 800]`, `y ∈ [0, 600]`), matching WebGL's bottom-up convention (`gl.readPixels` row 0 = bottom).
- **Normalized Coordinates**: `normX = worldX / 800` (`[0, 1]`), `normY = worldY / 600` (`[0, 1]`).
- **Soda Fountain Dispenser Header**: Located at top center (`y ∈ [490, 600]`, `x ∈ [160, 640]`).
- **Dispensing Nozzles**: 5 distinct color-coded nozzles clustered on the central dispenser head at `y = 490`, `x = [360, 380, 400, 420, 440]` (corresponding to `coca-cola`, `fanta`, `sprite`, `cherry`, `berry-blue`).
- **Movable Glass Container**:
  - Default resting center: `glass.x = 400` (`normX = 0.50`), `glass.y = 145` (floor at `bottomY = 55`, top rim at `rimY = 235`).
  - Tapered U-shaped geometry: `bottomHalfWidth = 55`, `topHalfWidth = 75`, `height = 180` (so at default `glass.x = 400`, the top opening spans `x ∈ [325, 475]`, capturing streams from all 5 central nozzles `[360..440]` out-of-the-box without requiring initial glass movement).
  - Movable bounds: `glass.x ∈ [120, 680]` (`normX ∈ [0.15, 0.85]`), `glass.y ∈ [135, 340]`. When dragged far left (`glass.x <= 250`, `normX <= 0.31`) or far right (`glass.x >= 550`, `normX >= 0.69`), the glass opening (`glass.x ± 75`) is completely outside all nozzles (`[360..440]`), causing poured streams to miss the glass and fall into the drip tray (`y < 45`).

### Data Flow
1. **Input Layer (`src/ui/controls.ts`)**: Captures unified Pointer, Mouse, Touch, and Keyboard events on the drink buttons (`[data-testid="drink-btn-<id>"]`), reset button (`[data-testid="reset-button"]`), and WebGL canvas (`[data-testid="fountain-canvas"]`). Tracks active drink pointers and glass-drag pointer independently for simultaneous pouring + glass movement.
2. **Physics & Color Mixing Engine (`src/physics/`)**:
   - Emits falling fluid particles from active nozzles (`fluidWorld.ts`).
   - Integrates 2D SPH density, pressure, viscosity, and cohesion forces using an $O(N)$ spatial hash grid (`spatialHash.ts`).
   - Resolves rigid-body collisions against the moving tapered glass walls and floor (`glassCollider.ts`), co-translating interior pooled fluid with glass movement and imparting sloshing/stirring velocity impulses. Handles exterior stream deflection and rim overflow (`fillLevel >= 1.0`).
   - Mixes fluid colors via two-stage blending (`colorMixer.ts`): Stage A local SPH neighbor color diffusion (visual pouring plumes/swirls) + Stage B agitation-accelerated global pool homogenization toward the exact volume-weighted RGB average of pooled drinks.
3. **Multi-Pass WebGL Renderer (`src/webgl/`)**:
   - Initializes WebGL2 (or WebGL1 fallback) with `{ preserveDrawingBuffer: true, alpha: false, antialias: true, premultipliedAlpha: false }`.
   - **Pass 1**: Background studio gradient, soda fountain dispenser housing, drip tray grate, and 5 color-coded nozzles with active pour indicators (`meshes.ts`, `shaders.ts`).
   - **Pass 2**: Offscreen `RGBA16F` (with `RGBA8` fallback) Framebuffer Object (`fbo.ts`) additive metaball splatting (`vec4(rgb * w, w)`).
   - **Pass 3**: Full-screen fluid surface resolve shader (isosurface thresholding, screen-space normal estimation, specular/Fresnel rim lighting, top meniscus highlight).
   - **Pass 4**: Buoyant CO2 carbonation micro-bubbles and surface foam crest inside the glass.
   - **Pass 5**: Translucent foreground glass container walls, thick refractive base, and rim highlights.

---

## Feature Inventory

Every feature from the Phase 0 Survey appears below with its assigned milestone.

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Minimal Website & WebGL2/WebGL1 Multi-Pass Canvas | Single-viewport minimal UI (`100vw × 100vh`) with `#fountain-canvas[data-testid="fountain-canvas"]` (`preserveDrawingBuffer: true`), 5-pass WebGL2/WebGL1 shader pipeline (fountain/nozzles, `RGBA16F`/`RGBA8` metaball splat FBO, screen-space fluid surface/meniscus resolve, carbonation bubbles/foam, translucent glass), DPR/resize handling, and `window.__SODA_SIM__` / `window.__SODA_FOUNTAIN__` + DOM `data-*` telemetry. | M2, M3, M4 | survey |
| F2 | Soda Fountain & Multi-Drink Dispenser Controls | Top dispenser bar (`[data-testid="fountain-controls"]`) with 5 distinct drink buttons (`coca-cola`, `fanta`, `sprite`, `cherry`, `berry-blue`) supporting Mouse (`mousedown`/`mouseup`), Touch (`touchstart`/`touchend`), Pointer (`pointerdown`/`pointerup`/`pointercancel`), and Keyboard (`1`–`5`) hold-to-pour interactions, plus `window`-level release handling so pours never stick when releasing outside a button. | M1, M3 | survey |
| F3 | Pouring Fluid Stream & 2D SPH Physics Engine | Continuous emission of cohesive falling fluid streams from active drink nozzles (`x = [360, 380, 400, 420, 440]`, `y = 490`), 2D SPH particle solver with $O(N)$ spatial hash grid, gravity, pressure/viscosity/cohesion forces, buoyant CO2 bubbles & surface foam, and drip-tray drain removal for spilled fluid. | M1, M2 | survey |
| F4 | Interactive Movable Glass Container | Smooth horizontal (`x ∈ [120, 680]`, default `400` / `normX = 0.50`) and bounded vertical (`y ∈ [135, 340]`, default `145`) glass dragging via mouse or touch on the canvas, independent pointer tracking for simultaneous pouring + glass movement, and per-step velocity clamping to prevent wall tunneling. | M1, M3 | survey |
| F5 | Fluid-Glass Containment, Sloshing, Overflow & Reset | Tapered U-shaped rigid-body glass collider (`bottomHalfWidth = 55`, `topHalfWidth = 75`, `height = 180`) that captures falling streams inside the top rim, deflects exterior streams when moved away (`glass.x <= 250` or `>= 550`), co-translates interior fluid and imparts sloshing velocity impulses when moved, spills excess liquid over the rim when overfilled (`fillLevel >= 1.0`), and empties/resets via `[data-testid="reset-button"]`. | M1, M3 | survey |
| F6 | Dynamic Multi-Drink Color Mixing & Blending | Two-stage color mixing engine combining local SPH neighbor color diffusion (visual pouring swirls) and agitation-accelerated homogenization toward the exact volume-weighted RGB average of pooled drinks, reflected in both WebGL rendered glass pixels (`gl.readPixels` / `sampleGlassLiquidPixel`) and `[data-testid="mixed-color-swatch"]`. | M1, M2, M3 | survey |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Types, Drink Catalog & 2D SPH Fluid/Glass/Color Physics Engine | Project scaffolding (`package.json`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`, `.gitignore`), shared contracts (`src/types/simulation.ts`), 5-drink catalog (`src/catalog/drinks.ts`), 2D SPH solver, spatial hash, movable glass collider, two-stage color mixer (`src/physics/*`), and unit tests (`tests/unit/physics.test.ts`). | none | DONE (20/20 unit tests pass, 0 tsc errors, Gate PASS) |
| M2 | Multi-Pass WebGL2/WebGL1 Fluid & Fountain Renderer | WebGL2/WebGL1 shaders (`src/webgl/shaders.ts`), offscreen `RGBA16F`/`RGBA8` FBO manager (`src/webgl/fbo.ts`), procedural fountain/nozzle/glass meshes (`src/webgl/meshes.ts`), 5-pass renderer & pixel readback (`src/webgl/renderer.ts`), and renderer unit/headless tests (`tests/unit/webgl.test.ts`). | M1 | DONE (16/16 webgl unit tests pass, 36/36 total, 0 tsc errors, Gate PASS) |
| M3 | Minimal Website UI, Mouse/Touch Controls & Full App Integration | Minimal HTML/CSS shell (`index.html`, `src/style.css`), unified Pointer/Mouse/Touch/Keyboard controller (`src/ui/controls.ts`), main loop & `window.__SODA_SIM__` / `window.__SODA_FOUNTAIN__` telemetry integration (`src/main.ts`), and UI/integration unit tests (`tests/unit/ui.test.ts`). | M1, M2 | DONE (8/8 UI unit tests pass, 44/44 total unit tests pass, 0 tsc/build errors, Gate PASS) |
| E2E | E2E Testing Track (Tiers 1–4 Opaque-Box Test Suite) | Requirement-driven Playwright headless Chromium WebGL E2E test infrastructure (`TEST_INFRA.md`, `tests/e2e/playwright.e2e.config.ts`), comprehensive test cases across Tiers 1–4 (`tests/e2e/*.spec.ts`, 79 tests), and `TEST_READY.md`. | none | DONE (`TEST_READY.md`, 79 tests across Tiers 1–4, Gate PASS) |
| M4 | Final Milestone: E2E Test Pass (Tiers 1–4) & Adversarial Hardening (Tier 5) | Phase 1: Pass 100% of the E2E test suite across Tiers 1–4 (`TEST_READY.md`). Phase 2: White-box adversarial coverage hardening (Tier 5) via Challenger → Worker → Reviewer loop until zero gaps remain. | M3, E2E | DONE (Phase 1 DONE: 79/79 Tiers 1–4 E2E PASS; Phase 2 Tier 5 DONE: 89/89 Tiers 1–5 E2E PASS, 75/75 unit tests PASS, 0 tsc/build errors, Gate PASS) |

---

## Interface Contracts

### 1. Drink Catalog Specification (`src/catalog/drinks.ts`)

| Drink ID (`DrinkId`) | Display Name | Hex Color | Target RGB `(0-255)` | Normalized `color: [r, g, b, a]` | Carbonation | Nozzle Index | Nozzle World `(X, Y)` |
|---|---|---|---|---|---|---|---|
| `coca-cola` | Coca-Cola | `#3E160C` | `[62, 22, 12]` | `[0.243, 0.086, 0.047, 0.94]` | `0.90` | `0` | `(360, 490)` |
| `fanta` | Fanta | `#FF7D00` | `[255, 125, 0]` | `[1.000, 0.490, 0.000, 0.90]` | `0.65` | `1` | `(380, 490)` |
| `sprite` | Sprite | `#AAF5C3` | `[170, 245, 195]` | `[0.667, 0.961, 0.765, 0.75]` | `0.95` | `2` | `(400, 490)` |
| `cherry` | Cherry Soda | `#E4183E` | `[228, 24, 62]` | `[0.894, 0.094, 0.243, 0.90]` | `0.40` | `3` | `(420, 490)` |
| `berry-blue` | Blue Raspberry | `#0098FF` | `[0, 152, 255]` | `[0.000, 0.596, 1.000, 0.88]` | `0.55` | `4` | `(440, 490)` |

### 2. Core TypeScript Interfaces (`src/types/simulation.ts`)

```ts
export type DrinkId = 'coca-cola' | 'fanta' | 'sprite' | 'cherry' | 'berry-blue';

export interface DrinkSpec {
  readonly id: DrinkId;
  readonly name: string;
  readonly shortLabel: string;
  readonly hexColor: string;
  readonly rgb255: readonly [number, number, number];
  /** Normalized color [r, g, b, a] in 0..1 */
  readonly color: readonly [number, number, number, number];
  /** Foam/fizz highlight tint [r, g, b] in 0..1 */
  readonly foamColor: readonly [number, number, number];
  /** Carbonation intensity in 0..1 */
  readonly carbonation: number;
  readonly nozzleIndex: number;
  readonly nozzleX: number;
  readonly nozzleY: number;
}

export type ParticleState = 'falling' | 'pooled' | 'spilled';

export interface FluidParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
  a: number;
  initR: number;
  initG: number;
  initB: number;
  initA: number;
  drinkId: DrinkId;
  carbonation: number;
  density: number;
  pressure: number;
  state: ParticleState;
  age: number;
}

export interface BubbleParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  isFoam: boolean;
}

export interface GlassScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlassState {
  /** Center X in simulation world space [0..800] (default 400) */
  x: number;
  /** Center Y in simulation world space [0..600] (default 145) */
  y: number;
  /** Normalized horizontal center x / 800 in [0..1] (default 0.5) */
  normX: number;
  /** Normalized vertical center y / 600 in [0..1] (default 0.2417) */
  normY: number;
  /** Normalized interior width in [0..1] */
  width: number;
  /** Normalized interior height in [0..1] */
  height: number;
  /** Instantaneous velocity (world units/sec) */
  vx: number;
  vy: number;
  readonly bottomHalfWidth: number;
  readonly topHalfWidth: number;
  readonly worldHeight: number;
  readonly maxCapacityParticles: number;
  isDragging: boolean;
  /** CSS pixel bounding box on canvas for E2E mouse/touch targeting */
  screenRect: GlassScreenRect;
}

export interface GlassLiquidSummary {
  readonly pooledParticleCount: number;
  /** Normalized fill fraction in [0..1] */
  readonly fillLevel: number;
  /** Alias for fillLevel in [0..1] */
  readonly fillRatio: number;
  readonly isOverflowing: boolean;
  /** Current mean mixed color [r, g, b, a] in 0..1 of liquid inside the glass */
  readonly mixedColorRGBA: readonly [number, number, number, number];
  /** Current mean mixed color [R, G, B] in 0..255 */
  readonly averageColorRGB: readonly [number, number, number];
  /** Current mixed color as CSS hex string e.g. "#7d4208" (or null if empty) */
  readonly mixedColorHex: string | null;
  /** Fractional composition by DrinkId summing to 1.0 when non-empty */
  readonly drinkComposition: Readonly<Record<DrinkId, number>>;
  /** Ordered list of distinct DrinkIds that have contributed to current glass contents */
  readonly colorHistory: ReadonlyArray<DrinkId>;
  /** Color variance/entropy metric across pooled particles (decreases toward 0 as fluid homogenizes) */
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
  /** Alias for liquid to support both telemetry schemas */
  readonly fluid: GlassLiquidSummary & {
    readonly particleOrMassCount: number;
    readonly mixingEntropyOrVariance: number;
  };
  readonly webglVersion: 1 | 2;
  readonly frameCount: number;
}

/** Public controller & test inspection contract exposed on both window.__SODA_SIM__ and window.__SODA_FOUNTAIN__ */
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
  /** Move glass center to worldX in [120..680] (or normalized [0..1] if <= 1.0) and optional worldY */
  moveGlassTo(x: number, y?: number): void;
  emptyGlass(): void;
  reset(): void;
  /** Advance physics & WebGL render deterministically by count frames (default 1, dt = 1/60s) */
  stepFrames(count?: number, dtSeconds?: number): void;
  /** Read rendered WebGL pixel [R, G, B, A] (0..255) at simulation world coords (worldX, worldY) */
  samplePixelAtWorld(worldX: number, worldY: number): [number, number, number, number];
  /** Read average rendered WebGL pixel [R, G, B, A] (0..255) inside the currently pooled liquid region of the glass */
  sampleGlassLiquidPixel(): [number, number, number, number];
}
```

### 3. DOM Selector & State Attribute Contract (`index.html` & `src/ui/controls.ts`)

| Element | Required Selector | Required State Attributes |
|---|---|---|
| Main WebGL Canvas | `#fountain-canvas[data-testid="fountain-canvas"]` | `data-ready="true"`, `data-webgl-version="1\|2"`, `data-glass-x="0.50"`, `data-fill-ratio="0.00"`, `data-avg-rgb="0,0,0"`, `data-active-drinks=""` |
| Fountain Controls Bar | `#fountain-controls[data-testid="fountain-controls"]` | — |
| Drink Buttons (5) | `[data-testid="drink-btn-coca-cola"]`, `[data-testid="drink-btn-fanta"]`, `[data-testid="drink-btn-sprite"]`, `[data-testid="drink-btn-cherry"]`, `[data-testid="drink-btn-berry-blue"]` | `data-drink="<id>"`, `data-color="#RRGGBB"`, `data-active="true\|false"`, `aria-pressed="true\|false"` |
| Empty / Reset Button | `#reset-btn[data-testid="reset-button"]` | `data-action="empty-glass"` |
| Status Bar | `#status-bar[data-testid="status-bar"]` | — |
| Mixed Color Swatch | `#mixed-color-swatch[data-testid="mixed-color-swatch"]` | `data-rgb="R,G,B"`, `data-fill-percent="0..100"` |
| Fill Level Readout | `#fill-readout[data-testid="fill-readout"]` | Text content `0%` .. `100%` |

---

## Code Layout

```text
/home/antigravity/ranveeraggarwal/studious-barnacle/
├── .gitignore                        # Ignores node_modules/, dist/, .agents/, test-results/, playwright-report/
├── package.json                      # Scripts: dev, build, preview, test, test:unit, test:e2e
├── tsconfig.json                     # TypeScript configuration
├── vite.config.ts                    # Vite bundler & dev server config (port 5173)
├── playwright.config.ts              # Playwright E2E config using /usr/lib/chromium/chromium + SwiftShader WebGL flags
├── index.html                        # Minimal single-viewport HTML shell (owned by M3)
├── src/
│   ├── types/
│   │   └── simulation.ts             # Shared TypeScript interfaces & contracts (owned by M1)
│   ├── catalog/
│   │   └── drinks.ts                 # 5-drink catalog & RGB/color math utilities (owned by M1)
│   ├── physics/
│   │   ├── spatialHash.ts            # O(N) uniform grid spatial hash (owned by M1)
│   │   ├── glassCollider.ts          # Tapered movable glass rigid-body collider & bounds (owned by M1)
│   │   ├── colorMixer.ts             # Two-stage SPH neighbor diffusion + volume-weighted color mixer (owned by M1)
│   │   └── fluidWorld.ts             # 2D SPH particle solver, emitters, bubbles, overflow/drain (owned by M1)
│   ├── webgl/
│   │   ├── shaders.ts                # GLSL vertex & fragment shaders for 5-pass pipeline (owned by M2)
│   │   ├── fbo.ts                    # Offscreen RGBA16F / RGBA8 FBO manager (owned by M2)
│   │   ├── meshes.ts                 # Procedural geometry for fountain, nozzles, drip tray, glass (owned by M2)
│   │   └── renderer.ts               # Multi-pass WebGL2/WebGL1 renderer & pixel readback (owned by M2)
│   ├── ui/
│   │   └── controls.ts               # Unified Pointer/Mouse/Touch/Keyboard input controller (owned by M3)
│   ├── style.css                     # Minimalist viewport CSS, touch-action: none (owned by M3)
│   └── main.ts                       # App bootstrap, animation loop, DOM & window.__SODA_SIM__ wiring (owned by M3)
└── tests/
    ├── unit/
    │   ├── physics.test.ts           # Unit tests for drinks, spatialHash, glassCollider, colorMixer, fluidWorld (owned by M1)
    │   ├── webgl.test.ts             # Unit/headless tests for shaders, meshes, fbo, renderer (owned by M2)
    │   └── ui.test.ts                # Unit/integration tests for controls & app state wiring (owned by M3)
    └── e2e/                          # Playwright E2E test suite across Tiers 1-5 (owned by E2E Track & M4)
```
