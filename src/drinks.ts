import { DrinkId, DrinkSpec } from './types';

/**
 * Curated 5-nozzle soda fountain catalog using physically-based Beer-Lambert
 * spectral absorption coefficients [absR, absG, absB]:
 * - Clear Sprite has near-zero absorption, naturally diluting dark sodas into
 *   luminous amber/rose/glacier tints instead of opaque grey/beige mud.
 * - Orange + Blue Raspberry preserves low green absorption -> vivid emerald green.
 * - Cherry + Blue Raspberry -> deep royal berry violet.
 * - Thin splashes/edges naturally glow warmer and brighter than deep pools.
 */
export const DRINKS: readonly DrinkSpec[] = [
  {
    id: 'cola',
    name: 'Coca-Cola',
    shortName: 'Cola',
    keyHint: '1',
    nozzleX: 260,
    // Transmits warm ruby-amber in thin sheets; deep mahogany brown-black in thick pools
    absorption: [0.95, 2.55, 4.25],
    badgeColor: '#d62828',
    accentGlow: '#ff5a4f',
    carbonation: 0.92,
  },
  {
    id: 'fanta',
    name: 'Fanta Orange',
    shortName: 'Fanta',
    keyHint: '2',
    nozzleX: 370,
    // Low red absorption, moderate green, strong blue -> luminous tangerine orange
    absorption: [0.05, 0.82, 3.55],
    badgeColor: '#f77f00',
    accentGlow: '#ff9f1c',
    carbonation: 0.72,
  },
  {
    id: 'sprite',
    name: 'Sprite',
    shortName: 'Sprite',
    keyHint: '3',
    nozzleX: 480,
    // Crystal-clear sparkling lemon-lime with faint crisp citron tint
    absorption: [0.09, 0.025, 0.075],
    badgeColor: '#10b981',
    accentGlow: '#34d399',
    carbonation: 1.0,
  },
  {
    id: 'cherry',
    name: 'Cherry Soda',
    shortName: 'Cherry',
    keyHint: '4',
    nozzleX: 590,
    // Vivid maraschino ruby red with slight blue transmission for rich purple mixes
    absorption: [0.07, 2.45, 1.55],
    badgeColor: '#e11d48',
    accentGlow: '#fb7185',
    carbonation: 0.82,
  },
  {
    id: 'blue-raspberry',
    name: 'Blue Raspberry',
    shortName: 'Blue Rasp',
    keyHint: '5',
    nozzleX: 700,
    // Electric glacier cyan-blue
    absorption: [2.45, 0.68, 0.05],
    badgeColor: '#0284c7',
    accentGlow: '#38bdf8',
    carbonation: 0.78,
  },
] as const;

export const DRINK_MAP: Readonly<Record<DrinkId, DrinkSpec>> = Object.fromEntries(
  DRINKS.map((d) => [d.id, d])
) as Record<DrinkId, DrinkSpec>;

function linearToSrgbChannel(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/**
 * Converts a Beer-Lambert absorption vector [absR, absG, absB] at a reference
 * glass optical thickness into an accurate sRGB hex string for UI swatch display.
 */
export function absorptionToDisplayHex(
  absR: number,
  absG: number,
  absB: number,
  opticalDepth = 1.35
): string {
  // Backlit neutral-warm studio illumination transmitted through the liquid
  const rLin = 0.98 * Math.exp(-absR * opticalDepth);
  const gLin = 0.99 * Math.exp(-absG * opticalDepth);
  const bLin = 1.0 * Math.exp(-absB * opticalDepth);

  const r = Math.round(linearToSrgbChannel(rLin) * 255);
  const g = Math.round(linearToSrgbChannel(gLin) * 255);
  const b = Math.round(linearToSrgbChannel(bLin) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`;
}
