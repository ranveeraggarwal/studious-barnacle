import {
  DrinkId,
  DrinkSpec,
  NOZZLE_WORLD_Y,
} from '../types/simulation';

export const DRINK_IDS: readonly DrinkId[] = [
  'coca-cola',
  'fanta',
  'sprite',
  'cherry',
  'berry-blue',
] as const;

export const DRINK_CATALOG: readonly DrinkSpec[] = [
  {
    id: 'coca-cola',
    name: 'Coca-Cola',
    shortLabel: 'Cola',
    hexColor: '#3E160C',
    rgb255: [62, 22, 12],
    color: [0.243, 0.086, 0.047, 0.94],
    foamColor: [0.85, 0.68, 0.50],
    carbonation: 0.90,
    nozzleIndex: 0,
    nozzleX: 360,
    nozzleY: NOZZLE_WORLD_Y,
  },
  {
    id: 'fanta',
    name: 'Fanta',
    shortLabel: 'Fanta',
    hexColor: '#FF7D00',
    rgb255: [255, 125, 0],
    color: [1.000, 0.490, 0.000, 0.90],
    foamColor: [1.00, 0.82, 0.55],
    carbonation: 0.65,
    nozzleIndex: 1,
    nozzleX: 380,
    nozzleY: NOZZLE_WORLD_Y,
  },
  {
    id: 'sprite',
    name: 'Sprite',
    shortLabel: 'Sprite',
    hexColor: '#AAF5C3',
    rgb255: [170, 245, 195],
    color: [0.667, 0.961, 0.765, 0.75],
    foamColor: [0.95, 1.00, 0.97],
    carbonation: 0.95,
    nozzleIndex: 2,
    nozzleX: 400,
    nozzleY: NOZZLE_WORLD_Y,
  },
  {
    id: 'cherry',
    name: 'Cherry Soda',
    shortLabel: 'Cherry',
    hexColor: '#E4183E',
    rgb255: [228, 24, 62],
    color: [0.894, 0.094, 0.243, 0.90],
    foamColor: [0.98, 0.65, 0.72],
    carbonation: 0.40,
    nozzleIndex: 3,
    nozzleX: 420,
    nozzleY: NOZZLE_WORLD_Y,
  },
  {
    id: 'berry-blue',
    name: 'Blue Raspberry',
    shortLabel: 'Berry Blue',
    hexColor: '#0098FF',
    rgb255: [0, 152, 255],
    color: [0.000, 0.596, 1.000, 0.88],
    foamColor: [0.65, 0.90, 1.00],
    carbonation: 0.55,
    nozzleIndex: 4,
    nozzleX: 440,
    nozzleY: NOZZLE_WORLD_Y,
  },
] as const;

/** Alias for DRINK_CATALOG */
export const DRINKS: readonly DrinkSpec[] = DRINK_CATALOG;

export const DRINK_BY_ID: Readonly<Record<DrinkId, DrinkSpec>> = {
  'coca-cola': DRINK_CATALOG[0],
  'fanta': DRINK_CATALOG[1],
  'sprite': DRINK_CATALOG[2],
  'cherry': DRINK_CATALOG[3],
  'berry-blue': DRINK_CATALOG[4],
};

export function isValidDrinkId(value: unknown): value is DrinkId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DRINK_BY_ID, value);
}

export function getDrinkSpec(drinkId: DrinkId): DrinkSpec {
  const spec = DRINK_BY_ID[drinkId];
  if (!spec) {
    throw new Error(`Unknown DrinkId: ${String(drinkId)}`);
  }
  return spec;
}

/** Alias for getDrinkSpec */
export const getDrinkById = getDrinkSpec;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Converts 0..255 RGB values (either as `(r, g, b)` numbers or `readonly [number, number, number]` tuple)
 * to lowercase CSS hex string e.g. "#7d4208"
 */
export function rgbToHex(
  rOrRgb: number | readonly [number, number, number],
  g?: number,
  b?: number,
): string {
  let rVal: number;
  let gVal: number;
  let bVal: number;
  if (Array.isArray(rOrRgb)) {
    rVal = rOrRgb[0];
    gVal = rOrRgb[1];
    bVal = rOrRgb[2];
  } else {
    rVal = rOrRgb as number;
    gVal = g ?? 0;
    bVal = b ?? 0;
  }
  const rr = clampByte(rVal).toString(16).padStart(2, '0');
  const gg = clampByte(gVal).toString(16).padStart(2, '0');
  const bb = clampByte(bVal).toString(16).padStart(2, '0');
  return `#${rr}${gg}${bb}`.toLowerCase();
}

/**
 * Parses "#RRGGBB" or "RRGGBB" or "#RGB" into [R, G, B] in 0..255
 */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      throw new Error(`Invalid hex color: ${hex}`);
    }
    return [clampByte(r), clampByte(g), clampByte(b)];
  }
  if (clean.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return [clampByte(r), clampByte(g), clampByte(b)];
}

/**
 * Converts normalized [r, g, b] or [r, g, b, a] in 0..1 to [R, G, B] in 0..255
 */
export function normalizedToRgb255(
  color: readonly [number, number, number] | readonly [number, number, number, number],
): [number, number, number] {
  return [
    clampByte(color[0] * 255),
    clampByte(color[1] * 255),
    clampByte(color[2] * 255),
  ];
}

/**
 * Converts [R, G, B] in 0..255 (and optional alpha in 0..1) to normalized [r, g, b, a] in 0..1
 */
export function rgb255ToNormalized(
  rgb: readonly [number, number, number],
  alpha = 1.0,
): [number, number, number, number] {
  return [
    clamp01(rgb[0] / 255),
    clamp01(rgb[1] / 255),
    clamp01(rgb[2] / 255),
    clamp01(alpha),
  ];
}

export function normalizedToHex(
  color: readonly [number, number, number] | readonly [number, number, number, number],
): string {
  const [r, g, b] = normalizedToRgb255(color);
  return rgbToHex(r, g, b);
}

export function colorDistanceRGB255(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.hypot(dr, dg, db);
}

export interface VolumeBlendResult {
  readonly totalWeight: number;
  readonly rgba: [number, number, number, number];
  readonly rgb255: [number, number, number];
  readonly hex: string | null;
  readonly effectiveCarbonation: number;
  readonly carbonation: number;
  readonly foamColor: [number, number, number];
  readonly composition: Record<DrinkId, number>;
}

export function createEmptyDrinkComposition(): Record<DrinkId, number> {
  return {
    'coca-cola': 0,
    'fanta': 0,
    'sprite': 0,
    'cherry': 0,
    'berry-blue': 0,
  };
}

/**
 * Computes exact volume-weighted RGBA, RGB255, hex, carbonation, foamColor, and fractional composition
 * from a map of drink volumes/counts.
 */
export function blendDrinksByVolume(
  volumes: Partial<Record<DrinkId, number>>,
): VolumeBlendResult {
  const composition = createEmptyDrinkComposition();
  let totalWeight = 0;

  for (const id of DRINK_IDS) {
    const raw = volumes[id] ?? 0;
    const w = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    composition[id] = w;
    totalWeight += w;
  }

  if (totalWeight <= 0) {
    return {
      totalWeight: 0,
      rgba: [0, 0, 0, 0],
      rgb255: [0, 0, 0],
      hex: null,
      effectiveCarbonation: 0,
      carbonation: 0,
      foamColor: [1, 1, 1],
      composition,
    };
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let carb = 0;
  let foamR = 0;
  let foamG = 0;
  let foamB = 0;

  for (const id of DRINK_IDS) {
    const frac = composition[id] / totalWeight;
    composition[id] = frac;
    if (frac > 0) {
      const spec = DRINK_BY_ID[id];
      r += spec.color[0] * frac;
      g += spec.color[1] * frac;
      b += spec.color[2] * frac;
      a += spec.color[3] * frac;
      carb += spec.carbonation * frac;
      foamR += spec.foamColor[0] * frac;
      foamG += spec.foamColor[1] * frac;
      foamB += spec.foamColor[2] * frac;
    }
  }

  const rgba: [number, number, number, number] = [
    clamp01(r),
    clamp01(g),
    clamp01(b),
    clamp01(a),
  ];
  const rgb255 = normalizedToRgb255(rgba);
  const hex = rgbToHex(rgb255[0], rgb255[1], rgb255[2]);
  const effectiveCarbonation = clamp01(carb);

  return {
    totalWeight,
    rgba,
    rgb255,
    hex,
    effectiveCarbonation,
    carbonation: effectiveCarbonation,
    foamColor: [clamp01(foamR), clamp01(foamG), clamp01(foamB)],
    composition,
  };
}

/** Alias for blendDrinksByVolume */
export const computeWeightedDrinkMix = blendDrinksByVolume;
