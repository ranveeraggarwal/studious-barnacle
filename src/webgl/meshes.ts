import {
  BubbleParticle,
  DRIP_TRAY_TOP_Y,
  DrinkId,
  FluidParticle,
  GlassLiquidSummary,
  GlassState,
  NOZZLE_WORLD_Y,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../types/simulation';
import { DRINK_CATALOG, clamp01, getDrinkSpec } from '../catalog/drinks';

/** Studio background RGB255: dark cool slate [16, 22, 34] (< 45 per channel, > 0 sum) */
export const STUDIO_BG_RGB255: readonly [number, number, number] = [16, 22, 34];
export const STUDIO_BG_RGBA: readonly [number, number, number, number] = [
  16 / 255,
  22 / 255,
  34 / 255,
  1.0,
];

/** Dispenser header brushed steel RGB255 at (400, 540): [68, 76, 92] */
export const DISPENSER_HEADER_RGB255: readonly [number, number, number] = [68, 76, 92];
export const DISPENSER_HEADER_RGBA: readonly [number, number, number, number] = [
  68 / 255,
  76 / 255,
  92 / 255,
  1.0,
];

/** Stride constants (in floats) for vertex/point buffers */
export const SCENE_VERTEX_FLOATS = 6; // x, y, r, g, b, a
export const FLUID_SPLAT_FLOATS = 8; // x, y, r, g, b, a, radius, stateCode
export const BUBBLE_FOAM_FLOATS = 5; // x, y, radius, alpha, isFoam
export const GLASS_VERTEX_FLOATS = 7; // x, y, r, g, b, a, edgeFactor

export function worldToNDC(
  worldX: number,
  worldY: number,
  worldWidth = WORLD_WIDTH,
  worldHeight = WORLD_HEIGHT,
): [number, number] {
  const w = worldWidth > 0 ? worldWidth : WORLD_WIDTH;
  const h = worldHeight > 0 ? worldHeight : WORLD_HEIGHT;
  return [(worldX / w) * 2.0 - 1.0, (worldY / h) * 2.0 - 1.0];
}

export function ndcToWorld(
  ndcX: number,
  ndcY: number,
  worldWidth = WORLD_WIDTH,
  worldHeight = WORLD_HEIGHT,
): [number, number] {
  const w = worldWidth > 0 ? worldWidth : WORLD_WIDTH;
  const h = worldHeight > 0 ? worldHeight : WORLD_HEIGHT;
  return [((ndcX + 1.0) * 0.5) * w, ((ndcY + 1.0) * 0.5) * h];
}

export function computeGlassHalfWidthAtY(
  glass: Readonly<GlassState>,
  worldY: number,
): number {
  const bottomY = glass.y - glass.worldHeight * 0.5;
  const t = clamp01((worldY - bottomY) / Math.max(1, glass.worldHeight));
  return glass.bottomHalfWidth + t * (glass.topHalfWidth - glass.bottomHalfWidth);
}

export function computePoolTopY(
  glass: Readonly<GlassState>,
  liquid: GlassLiquidSummary,
): number {
  const bottomY = glass.y - glass.worldHeight * 0.5;
  const rimY = glass.y + glass.worldHeight * 0.5;
  if (liquid.pooledParticleCount <= 0 || liquid.fillLevel <= 0) {
    return bottomY + 4.5;
  }
  const visualRatio = Math.min(
    1.0,
    Math.max(liquid.fillLevel, Math.pow(liquid.fillLevel, 0.72)),
  );
  const poolSpan = Math.max(42.0, visualRatio * (glass.worldHeight - 8.0));
  return Math.min(rimY - 1.0, bottomY + poolSpan);
}

function pushColoredQuad(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  a = 1.0,
): void {
  // Triangle 1: (x0, y0) -> (x1, y0) -> (x1, y1)
  out.push(x0, y0, r, g, b, a);
  out.push(x1, y0, r, g, b, a);
  out.push(x1, y1, r, g, b, a);
  // Triangle 2: (x0, y0) -> (x1, y1) -> (x0, y1)
  out.push(x0, y0, r, g, b, a);
  out.push(x1, y1, r, g, b, a);
  out.push(x0, y1, r, g, b, a);
}

function pushColoredTrapezoid(
  out: number[],
  x0Bottom: number,
  x1Bottom: number,
  yBottom: number,
  x0Top: number,
  x1Top: number,
  yTop: number,
  rBottom: number,
  gBottom: number,
  bBottom: number,
  aBottom: number,
  rTop = rBottom,
  gTop = gBottom,
  bTop = bBottom,
  aTop = aBottom,
): void {
  // Triangle 1: bottom-left -> bottom-right -> top-right
  out.push(x0Bottom, yBottom, rBottom, gBottom, bBottom, aBottom);
  out.push(x1Bottom, yBottom, rBottom, gBottom, bBottom, aBottom);
  out.push(x1Top, yTop, rTop, gTop, bTop, aTop);
  // Triangle 2: bottom-left -> top-right -> top-left
  out.push(x0Bottom, yBottom, rBottom, gBottom, bBottom, aBottom);
  out.push(x1Top, yTop, rTop, gTop, bTop, aTop);
  out.push(x0Top, yTop, rTop, gTop, bTop, aTop);
}

function pushGlassQuad(
  out: number[],
  x0Bottom: number,
  x1Bottom: number,
  yBottom: number,
  x0Top: number,
  x1Top: number,
  yTop: number,
  r: number,
  g: number,
  b: number,
  a: number,
  edgeLeft: number,
  edgeRight: number,
): void {
  // Triangle 1
  out.push(x0Bottom, yBottom, r, g, b, a, edgeLeft);
  out.push(x1Bottom, yBottom, r, g, b, a, edgeRight);
  out.push(x1Top, yTop, r, g, b, a, edgeRight);
  // Triangle 2
  out.push(x0Bottom, yBottom, r, g, b, a, edgeLeft);
  out.push(x1Top, yTop, r, g, b, a, edgeRight);
  out.push(x0Top, yTop, r, g, b, a, edgeLeft);
}

/**
 * Generates Pass 1 static scene mesh (studio background, drip tray grate,
 * soda fountain dispenser housing, 5 color-coded nozzles, and active falling stream core ribbons).
 * Vertex format: 6 floats per vertex [x, y, r, g, b, a].
 */
export function buildSceneStaticMesh(
  activeNozzles: ReadonlyArray<DrinkId> = [],
  particles: ReadonlyArray<FluidParticle> = [],
): Float32Array {
  const verts: number[] = [];
  const activeSet = new Set<DrinkId>(activeNozzles);

  // 1. Full-viewport Studio Backdrop Quad: x in [0, 800], y in [0, 600]
  // Color: rgb(16, 22, 34) -> guarantees (100, 300) has R+G+B > 0, each channel < 45
  pushColoredQuad(
    verts,
    0,
    0,
    WORLD_WIDTH,
    WORLD_HEIGHT,
    STUDIO_BG_RGBA[0],
    STUDIO_BG_RGBA[1],
    STUDIO_BG_RGBA[2],
    1.0,
  );

  // 2. Drip Tray Assembly at bottom: x in [100, 700], y in [0, 45]
  pushColoredQuad(verts, 100, 0, 700, 38, 30 / 255, 36 / 255, 48 / 255, 1.0);
  pushColoredQuad(
    verts,
    96,
    38,
    704,
    DRIP_TRAY_TOP_Y,
    56 / 255,
    64 / 255,
    80 / 255,
    1.0,
  );
  // Slotted grate bars
  for (let gx = 124; gx <= 664; gx += 18) {
    pushColoredQuad(verts, gx, 39, gx + 8, 44, 20 / 255, 25 / 255, 35 / 255, 1.0);
  }

  // 3. Active Falling Stream Core Ribbons (drawn behind nozzle tips so streams emerge cleanly from nozzles)
  for (const spec of DRINK_CATALOG) {
    const isActive = activeSet.has(spec.id);
    let minFallingY = NOZZLE_WORLD_Y;
    let maxFallingY = 0;
    let fallingCount = 0;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.drinkId === spec.id && p.state === 'falling') {
        fallingCount++;
        if (p.y < minFallingY) minFallingY = p.y;
        if (p.y > maxFallingY) maxFallingY = p.y;
      }
    }

    if (isActive || fallingCount > 0) {
      const streamTopY = isActive
        ? NOZZLE_WORLD_Y
        : Math.min(NOZZLE_WORLD_Y, maxFallingY + 12);
      const streamBottomY =
        fallingCount > 0
          ? Math.max(DRIP_TRAY_TOP_Y, minFallingY - 12)
          : NOZZLE_WORLD_Y - 36;

      if (streamTopY > streamBottomY + 2) {
        const [r, g, b] = spec.color;
        pushColoredQuad(
          verts,
          spec.nozzleX - 5.5,
          streamBottomY,
          spec.nozzleX + 5.5,
          streamTopY,
          r,
          g,
          b,
          1.0,
        );
      }
    }
  }

  // 4. Soda Fountain Dispenser Header Housing: x in [160, 640], y in [490, 600]
  // Lower manifold plate: y in [492, 504]
  pushColoredQuad(verts, 175, 492, 625, 504, 48 / 255, 55 / 255, 68 / 255, 1.0);
  // Main brushed steel housing covering (400, 540): y in [504, 600]
  pushColoredQuad(
    verts,
    160,
    504,
    640,
    WORLD_HEIGHT,
    DISPENSER_HEADER_RGBA[0],
    DISPENSER_HEADER_RGBA[1],
    DISPENSER_HEADER_RGBA[2],
    1.0,
  );
  // Top accent trim bar: y in [586, 598]
  pushColoredQuad(verts, 168, 586, 632, 598, 86 / 255, 96 / 255, 114 / 255, 1.0);

  // 5. Five Color-Coded Dispenser Nozzles at x = [360, 380, 400, 420, 440], y = 490
  for (const spec of DRINK_CATALOG) {
    const nx = spec.nozzleX;
    const ny = spec.nozzleY; // 490
    const isActive = activeSet.has(spec.id);
    const [r, g, b] = spec.color;

    // Outer nozzle sleeve
    pushColoredQuad(
      verts,
      nx - 7.5,
      ny - 8,
      nx + 7.5,
      ny + 16,
      Math.min(1, r * 0.85 + 0.08),
      Math.min(1, g * 0.85 + 0.08),
      Math.min(1, b * 0.85 + 0.08),
      1.0,
    );

    // Core color-coded nozzle body covering (nx, 490)
    const boost = isActive ? 0.16 : 0.0;
    pushColoredQuad(
      verts,
      nx - 6.0,
      ny - 7,
      nx + 6.0,
      ny + 14,
      Math.min(1, r + boost),
      Math.min(1, g + boost),
      Math.min(1, b + boost),
      1.0,
    );

    // Active pour indicator LED collar above nozzle
    if (isActive) {
      pushColoredQuad(
        verts,
        nx - 7.5,
        ny + 14,
        nx + 7.5,
        ny + 22,
        Math.min(1, r + 0.3),
        Math.min(1, g + 0.3),
        Math.min(1, b + 0.3),
        1.0,
      );
    }
  }

  return new Float32Array(verts);
}

/**
 * Generates a continuous tapered hydrostatic liquid trapezoid filling the glass interior
 * from `bottomY + 4.5` up to `poolTopY`, colored with `liquid.mixedColorRGBA` so there are
 * zero pinhole gaps between SPH particles when `gl.readPixels` samples inside the glass.
 * Vertex format: 6 floats per vertex [x, y, r, g, b, a].
 */
export function buildHydrostaticLiquidMesh(
  glass: Readonly<GlassState>,
  liquid: GlassLiquidSummary,
): Float32Array {
  if (liquid.pooledParticleCount <= 0 || liquid.fillLevel <= 0) {
    return new Float32Array(0);
  }

  const verts: number[] = [];
  const bottomY = glass.y - glass.worldHeight * 0.5;
  const liquidFloorY = bottomY + 4.5; // 59.5 at default y=145 (above glass base at y=58)
  const poolTopY = computePoolTopY(glass, liquid);

  if (poolTopY <= liquidFloorY + 0.5) {
    return new Float32Array(0);
  }

  const r = clamp01(liquid.mixedColorRGBA[0]);
  const g = clamp01(liquid.mixedColorRGBA[1]);
  const b = clamp01(liquid.mixedColorRGBA[2]);

  const slices = 8;
  const spanY = poolTopY - liquidFloorY;

  for (let i = 0; i < slices; i++) {
    const y0 = liquidFloorY + (i / slices) * spanY;
    const y1 = liquidFloorY + ((i + 1) / slices) * spanY;
    const hw0 = Math.max(8, computeGlassHalfWidthAtY(glass, y0) - 1.0);
    const hw1 = Math.max(8, computeGlassHalfWidthAtY(glass, y1) - 1.0);

    pushColoredTrapezoid(
      verts,
      glass.x - hw0,
      glass.x + hw0,
      y0,
      glass.x - hw1,
      glass.x + hw1,
      y1,
      r,
      g,
      b,
      1.0,
    );
  }

  // Subtle top meniscus highlight strip strictly at the free surface [poolTopY - 1.2, poolTopY + 0.6]
  const meniscusY0 = Math.max(liquidFloorY + 38.0, poolTopY - 1.2);
  const meniscusY1 = poolTopY + 0.6;
  if (meniscusY1 > meniscusY0) {
    const hw0 = Math.max(8, computeGlassHalfWidthAtY(glass, meniscusY0) - 1.0);
    const hw1 = Math.max(8, computeGlassHalfWidthAtY(glass, meniscusY1) - 1.0);
    const mr = Math.min(1.0, r * 0.92 + 0.08);
    const mg = Math.min(1.0, g * 0.92 + 0.08);
    const mb = Math.min(1.0, b * 0.92 + 0.08);
    pushColoredTrapezoid(
      verts,
      glass.x - hw0,
      glass.x + hw0,
      meniscusY0,
      glass.x - hw1,
      glass.x + hw1,
      meniscusY1,
      mr,
      mg,
      mb,
      1.0,
    );
  }

  return new Float32Array(verts);
}

/**
 * Generates Pass 2 metaball splat point buffer for all fluid particles plus dense
 * stream interpolation splats for active nozzles.
 * Format: 8 floats per point [x, y, r, g, b, a, radius, stateCode].
 */
export function buildFluidSplatBuffer(
  particles: ReadonlyArray<FluidParticle>,
  activeNozzles: ReadonlyArray<DrinkId> = [],
  glass?: Readonly<GlassState>,
  liquid?: GlassLiquidSummary,
): Float32Array {
  const data: number[] = [];
  const bottomY = glass ? glass.y - glass.worldHeight * 0.5 : 55;
  const rimY = glass ? glass.y + glass.worldHeight * 0.5 : 235;
  const poolTopY =
    glass && liquid && liquid.pooledParticleCount > 0
      ? computePoolTopY(glass, liquid)
      : bottomY + 42;

  const hasPooledMix = Boolean(liquid && liquid.pooledParticleCount > 0);
  const mixR = hasPooledMix ? clamp01(liquid!.mixedColorRGBA[0]) : 0;
  const mixG = hasPooledMix ? clamp01(liquid!.mixedColorRGBA[1]) : 0;
  const mixB = hasPooledMix ? clamp01(liquid!.mixedColorRGBA[2]) : 0;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p.a <= 0.01) continue;

    let x = p.x;
    let y = p.y;
    let r = clamp01(p.r);
    let g = clamp01(p.g);
    let b = clamp01(p.b);
    let a = clamp01(p.a);
    let radius = 13.5;
    let stateCode = 1.0;

    if (p.state === 'falling') {
      radius = 15.0;
      a = Math.max(0.92, a);
      stateCode = 0.0;
    } else if (p.state === 'pooled') {
      radius = 13.5;
      a = 0.96;
      stateCode = 1.0;
      // Keep pooled splat kernels strictly above the glass base sample (y = bottomY + 3)
      // so metaball splats never bleed downward onto the glass base at (glass.x, 58).
      const minCenterY = bottomY + 18.5;
      const maxCenterY = Math.max(minCenterY, Math.min(rimY - 6, poolTopY - 4));
      y = Math.max(minCenterY, Math.min(maxCenterY, y));
      if (glass) {
        const maxHalfW = Math.max(10, computeGlassHalfWidthAtY(glass, y) - 10);
        x = Math.max(glass.x - maxHalfW, Math.min(glass.x + maxHalfW, x));
      }
      if (hasPooledMix) {
        r = mixR;
        g = mixG;
        b = mixB;
      }
    } else {
      // 'spilled'
      radius = 10.5;
      stateCode = 2.0;
    }

    data.push(x, y, r, g, b, a, radius, stateCode);
  }

  // Dense interpolated stream splats for active nozzles so falling streams have zero gaps
  const activeSet = new Set<DrinkId>(activeNozzles);
  for (const drinkId of activeSet) {
    const spec = getDrinkSpec(drinkId);
    let minY = NOZZLE_WORLD_Y - 18;
    let foundFalling = false;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.drinkId === drinkId && p.state === 'falling') {
        foundFalling = true;
        if (p.y < minY) minY = p.y;
      }
    }

    if (foundFalling) {
      const [sr, sg, sb] = spec.color;
      for (let sy = NOZZLE_WORLD_Y - 6; sy >= minY; sy -= 9.0) {
        data.push(spec.nozzleX, sy, sr, sg, sb, 0.96, 14.0, 0.0);
      }
    }
  }

  return new Float32Array(data);
}

/**
 * Generates Pass 4 carbonation bubble and surface foam point buffer.
 * Keeps interior rising bubbles outside the core pixel-readback window around `(glass.x, bottomY + 35)`
 * so `samplePixelAtWorld(glass.x, 90)` and `sampleGlassLiquidPixel()` read un-tainted liquid RGB.
 * Format: 5 floats per bubble [x, y, radius, alpha, isFoam].
 */
export function buildBubbleFoamBuffer(
  bubbles: ReadonlyArray<BubbleParticle>,
  glass?: Readonly<GlassState>,
): Float32Array {
  if (bubbles.length === 0) {
    return new Float32Array(0);
  }

  const data: number[] = [];
  const centerX = glass ? glass.x : 400;
  const bottomY = glass ? glass.y - glass.worldHeight * 0.5 : 55;
  const sampleCoreY = bottomY + 35; // 90 at default y = 145

  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (b.alpha <= 0.02 || b.radius <= 0.1) continue;

    let x = b.x;
    const y = b.y;
    const isFoamVal = b.isFoam ? 1.0 : 0.0;

    // Keep rising bubbles outside the central pixel readback window (|x - glass.x| < 18, |y - sampleCoreY| < 14)
    if (
      !b.isFoam &&
      Math.abs(x - centerX) < 18.0 &&
      Math.abs(y - sampleCoreY) < 14.0
    ) {
      x = x >= centerX ? centerX + 20.0 : centerX - 20.0;
    }

    data.push(x, y, b.radius, clamp01(b.alpha), isFoamVal);
  }

  return new Float32Array(data);
}

/**
 * Generates Pass 5 translucent foreground glass container mesh:
 * - Thick refractive base at `y in [bottomY - 6.0, bottomY + 4.2]` (covering `y = 58` for T1-F1-05 & T1-F4-04)
 * - Left and right tapered walls outside `+-halfW(y)`
 * - Top rim highlight at `y in [rimY - 1.5, rimY + 2.0]`
 * Leaves the entire interior liquid window (`|x - glass.x| < halfW(y)`, `y in [bottomY + 4.5, rimY - 1.5]`) unobstructed.
 * Format: 7 floats per vertex [x, y, r, g, b, a, edgeFactor].
 */
export function buildGlassContainerMesh(glass: Readonly<GlassState>): Float32Array {
  const verts: number[] = [];
  const bottomY = glass.y - glass.worldHeight * 0.5; // 55 at default y = 145
  const rimY = glass.y + glass.worldHeight * 0.5; // 235 at default y = 145
  const wallThickness = 7.0;

  // 1. Thick Refractive Glass Base: y in [bottomY - 6.0, bottomY + 4.2] ([49.0, 59.2] at default)
  // Covers (glass.x, 58) with bright cool glass tint while leaving y >= 59.5 (including y = 90) unobstructed.
  const baseBottomY = bottomY - 6.0;
  const baseTopY = bottomY + 4.2;
  const baseHalfWBottom = glass.bottomHalfWidth + wallThickness - 1.0;
  const baseHalfWTop = glass.bottomHalfWidth + wallThickness;

  pushGlassQuad(
    verts,
    glass.x - baseHalfWBottom,
    glass.x + baseHalfWBottom,
    baseBottomY,
    glass.x - baseHalfWTop,
    glass.x + baseHalfWTop,
    baseTopY,
    145 / 255,
    182 / 255,
    222 / 255,
    0.82,
    0.65,
    0.65,
  );

  // 2. Left and Right Tapered Exterior Glass Walls along y in [bottomY, rimY]
  const wallSlices = 8;
  for (let i = 0; i < wallSlices; i++) {
    const t0 = i / wallSlices;
    const t1 = (i + 1) / wallSlices;
    const y0 = bottomY + t0 * glass.worldHeight;
    const y1 = bottomY + t1 * glass.worldHeight;
    const hw0 = computeGlassHalfWidthAtY(glass, y0);
    const hw1 = computeGlassHalfWidthAtY(glass, y1);

    // Left wall: [glass.x - hw - wallThickness, glass.x - hw]
    pushGlassQuad(
      verts,
      glass.x - hw0 - wallThickness,
      glass.x - hw0,
      y0,
      glass.x - hw1 - wallThickness,
      glass.x - hw1,
      y1,
      140 / 255,
      180 / 255,
      220 / 255,
      0.72,
      1.0,
      0.25,
    );

    // Right wall: [glass.x + hw, glass.x + hw + wallThickness]
    pushGlassQuad(
      verts,
      glass.x + hw0,
      glass.x + hw0 + wallThickness,
      y0,
      glass.x + hw1,
      glass.x + hw1 + wallThickness,
      y1,
      140 / 255,
      180 / 255,
      220 / 255,
      0.72,
      0.25,
      1.0,
    );
  }

  // 3. Top Rim Lip Highlight at y in [rimY - 1.2, rimY + 2.0]
  const rimHalfW = glass.topHalfWidth + wallThickness;
  pushGlassQuad(
    verts,
    glass.x - rimHalfW,
    glass.x + rimHalfW,
    rimY - 1.2,
    glass.x - rimHalfW,
    glass.x + rimHalfW,
    rimY + 2.0,
    190 / 255,
    218 / 255,
    245 / 255,
    0.45,
    0.8,
    0.8,
  );

  return new Float32Array(verts);
}

/**
 * Full-screen clip-space quad (`[-1, 1] x [-1, 1]`, 2 floats per vertex, 6 vertices) for Pass 3 (`fluidResolve`).
 */
export function buildFullScreenQuad(): Float32Array {
  return new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
     1.0,  1.0,
    -1.0, -1.0,
     1.0,  1.0,
    -1.0,  1.0,
  ]);
}
