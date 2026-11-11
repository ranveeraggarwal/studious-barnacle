export type DrinkId = 'cola' | 'fanta' | 'sprite' | 'cherry' | 'blue-raspberry';

export interface DrinkSpec {
  id: DrinkId;
  name: string;
  shortName: string;
  keyHint: string;
  /** Nozzle X center in canonical world units */
  nozzleX: number;
  /** Beer-Lambert RGB optical absorption coefficients per unit optical depth */
  absorption: readonly [number, number, number];
  /** UI badge / brand accent hex color */
  badgeColor: string;
  /** Secondary highlight hex for dispenser plaque */
  accentGlow: string;
  /** Carbonation fizz level [0..1] controlling rising bubbles & foam head */
  carbonation: number;
}

/**
 * Canonical world coordinate frame (Y=0 at bottom, Y=WORLD_H at top).
 * Aspect-ratio-preserving camera frames the active fountain stage cleanly
 * on any desktop, ultrawide, tablet, or mobile portrait viewport.
 */
export const WORLD_W = 960;
export const WORLD_H = 680;

/** Active stage bounds that must always remain visible inside the viewport */
export const STAGE_MIN_X = 148;
export const STAGE_MAX_X = 812;
export const STAGE_MIN_Y = 24;
export const STAGE_MAX_Y = 662;

/** Countertop & slotted stainless steel drip tray geometry */
export const COUNTER_TOP_Y = 56;
export const TRAY_SURFACE_Y = 74;
export const TRAY_LEFT_X = 166;
export const TRAY_RIGHT_X = 794;

/** Soda fountain upper head, alcove, nozzles, and dispenser fascia pads */
export const FOUNTAIN_LEFT_X = 172;
export const FOUNTAIN_RIGHT_X = 788;
export const FOUNTAIN_BOTTOM_Y = 472;
export const FOUNTAIN_TOP_Y = 650;
export const ALCOVE_LEFT_X = 192;
export const ALCOVE_RIGHT_X = 768;

export const NOZZLE_TIP_Y = 448;
export const NOZZLE_BASE_Y = 474;
export const NOZZLE_HALF_W = 11;

/** Dispenser push-pad geometry in world coordinates (mounted on fountain fascia) */
export const BUTTON_CENTER_Y = 548;
export const BUTTON_W = 94;
export const BUTTON_H = 104;

/** Tapered crystal tumbler glass dimensions (world units) */
export const GLASS_BASE_THICKNESS = 16;
export const GLASS_WALL_THICKNESS = 10.5;
export const GLASS_INNER_HEIGHT = 190;
export const GLASS_BOTTOM_HALF_W = 54;
export const GLASS_TOP_HALF_W = 73;

export const GLASS_MIN_X = 200;
export const GLASS_MAX_X = 760;
export const GLASS_MIN_Y = TRAY_SURFACE_Y;
export const GLASS_MAX_Y = 235;

/** Fluid particle & bubble capacity constants (tuned for locked 60-120 FPS) */
export const MAX_PARTICLES = 1800;
export const GLASS_FULL_PARTICLES = 680;
export const PARTICLE_RADIUS = 5.8;
export const KERNEL_RADIUS = 14.8;
export const MAX_BUBBLES = 280;

export interface ViewportTransform {
  /** CSS width of canvas */
  cssWidth: number;
  /** CSS height of canvas */
  cssHeight: number;
  /** Device pixel ratio applied to drawingbuffer */
  dpr: number;
  /** Uniform CSS pixels per 1 world unit */
  scale: number;
  /** CSS X offset of world X=0 from canvas left */
  offsetX: number;
  /** CSS Y offset of world Y=WORLD_H from canvas top (note: CSS Y grows downward) */
  offsetY: number;
  /** Visible world bounds covering the full canvas [left, right, bottom, top] */
  viewLeft: number;
  viewRight: number;
  viewBottom: number;
  viewTop: number;
}

/**
 * Computes an aspect-preserving uniform camera transform so 1 world unit is
 * always square (1:1 aspect ratio) across widescreen desktop and mobile portrait.
 */
export function computeViewportTransform(
  cssWidth: number,
  cssHeight: number,
  dpr = 1
): ViewportTransform {
  const safeW = Math.max(1, cssWidth);
  const safeH = Math.max(1, cssHeight);
  const stageW = STAGE_MAX_X - STAGE_MIN_X;
  const stageH = STAGE_MAX_Y - STAGE_MIN_Y;
  const padFactor = safeW < 640 ? 0.96 : 0.93;

  const scale = Math.min((safeW * padFactor) / stageW, (safeH * padFactor) / stageH);
  const stageCenterX = 0.5 * (STAGE_MIN_X + STAGE_MAX_X);
  const stageCenterY = 0.5 * (STAGE_MIN_Y + STAGE_MAX_Y);

  // World (x, y) -> CSS:
  // cssX = offsetX + x * scale
  // cssY = offsetY + (WORLD_H - y) * scale
  const offsetX = safeW * 0.5 - stageCenterX * scale;
  const offsetY = safeH * 0.5 - (WORLD_H - stageCenterY) * scale;

  const viewLeft = -offsetX / scale;
  const viewRight = (safeW - offsetX) / scale;
  const viewTop = WORLD_H + offsetY / scale;
  const viewBottom = WORLD_H - (safeH - offsetY) / scale;

  return {
    cssWidth: safeW,
    cssHeight: safeH,
    dpr,
    scale,
    offsetX,
    offsetY,
    viewLeft,
    viewRight,
    viewBottom,
    viewTop,
  };
}

export function clientToWorld(
  clientX: number,
  clientY: number,
  canvasRect: { left: number; top: number },
  vp: ViewportTransform
): { x: number; y: number } {
  const localX = clientX - canvasRect.left;
  const localY = clientY - canvasRect.top;
  return {
    x: (localX - vp.offsetX) / vp.scale,
    y: WORLD_H - (localY - vp.offsetY) / vp.scale,
  };
}

export function worldToCss(
  worldX: number,
  worldY: number,
  vp: ViewportTransform
): { left: number; top: number } {
  return {
    left: vp.offsetX + worldX * vp.scale,
    top: vp.offsetY + (WORLD_H - worldY) * vp.scale,
  };
}

export interface GlassState {
  /** Current outer-bottom center X in world units */
  x: number;
  /** Current outer-bottom Y in world units */
  y: number;
  /** Current velocity X (world units / s) */
  vx: number;
  /** Current velocity Y (world units / s) */
  vy: number;
  /** Target X driven by pointer drag */
  targetX: number;
  /** Target Y driven by pointer drag (settles to TRAY_SURFACE_Y when released) */
  targetY: number;
  /** Whether the user is actively dragging the glass */
  isDragging: boolean;
  /** Subtle tilt angle in radians induced by horizontal acceleration (visual/rim polish) */
  tilt: number;
}

export interface GlassMixSummary {
  /** Number of fluid particles currently inside the glass */
  particleCount: number;
  /** Fill fraction [0..1] */
  fillRatio: number;
  /** Apparent sRGB hex color of the liquid inside the glass via Beer-Lambert optics */
  displayHex: string;
  /** Mean Beer-Lambert absorption [r, g, b] inside the glass */
  meanAbsorption: [number, number, number];
  /** Share of each drink currently in the glass [0..1] */
  recipeShares: Record<DrinkId, number>;
}

export interface SimulationSnapshot {
  particleCount: number;
  /** Interleaved per-particle GPU data: [x, y, vx, vy, absR, absG, absB, fizz] * particleCount */
  particleData: Float32Array;
  bubbleCount: number;
  /** Interleaved per-bubble GPU data: [x, y, radius, alpha] * bubbleCount */
  bubbleData: Float32Array;
  glass: Readonly<GlassState>;
  activeDrinks: ReadonlySet<DrinkId>;
  mix: GlassMixSummary;
  time: number;
}
