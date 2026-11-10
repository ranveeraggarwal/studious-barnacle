export type DrinkId = 'coca-cola' | 'fanta' | 'sprite' | 'cherry' | 'berry-blue';

export type RGB255Tuple = readonly [number, number, number];
export type RGBTuple = readonly [number, number, number];
export type RGBATuple = readonly [number, number, number, number];

/** Canonical Simulation World Constants (800 x 600 bottom-left origin) */
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;

export const NOZZLE_WORLD_Y = 490;
export const DRIP_TRAY_TOP_Y = 45;

export const DEFAULT_GLASS_X = 400;
export const DEFAULT_GLASS_Y = 145;
export const GLASS_MIN_X = 120;
export const GLASS_MAX_X = 680;
export const GLASS_MIN_Y = 135;
export const GLASS_MAX_Y = 340;
export const MIN_GLASS_X = GLASS_MIN_X;
export const MAX_GLASS_X = GLASS_MAX_X;
export const MIN_GLASS_Y = GLASS_MIN_Y;
export const MAX_GLASS_Y = GLASS_MAX_Y;
export const GLASS_BOTTOM_HALF_WIDTH = 55;
export const GLASS_TOP_HALF_WIDTH = 75;
export const GLASS_WORLD_HEIGHT = 180;
export const GLASS_MAX_CAPACITY_PARTICLES = 480;

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

/** Renderable state interface consumed by M2 WebGLRenderer */
export interface FluidRenderState {
  readonly particles: ReadonlyArray<FluidParticle>;
  readonly bubbles: ReadonlyArray<BubbleParticle>;
  readonly glass: Readonly<GlassState>;
  readonly liquid: GlassLiquidSummary;
  readonly activeNozzles: ReadonlyArray<DrinkId>;
  readonly worldWidth: number;
  readonly worldHeight: number;
}

declare global {
  interface Window {
    __SODA_SIM__?: SodaSimulationAPI;
    __SODA_FOUNTAIN__?: SodaSimulationAPI;
  }
}
