import { describe, expect, it } from 'vitest';
import {
  DRINK_BY_ID,
  DRINK_CATALOG,
  DRINK_IDS,
  DRINKS,
  blendDrinksByVolume,
  colorDistanceRGB255,
  computeWeightedDrinkMix,
  getDrinkById,
  getDrinkSpec,
  hexToRgb,
  isValidDrinkId,
  normalizedToHex,
  normalizedToRgb255,
  rgb255ToNormalized,
  rgbToHex,
} from '../../src/catalog/drinks';
import { SpatialHash } from '../../src/physics/spatialHash';
import { GlassCollider } from '../../src/physics/glassCollider';
import { ColorMixer, toFluidTelemetry } from '../../src/physics/colorMixer';
import { FluidWorld } from '../../src/physics/fluidWorld';
import {
  DEFAULT_GLASS_X,
  DEFAULT_GLASS_Y,
  GLASS_BOTTOM_HALF_WIDTH,
  GLASS_MAX_CAPACITY_PARTICLES,
  GLASS_MAX_X,
  GLASS_MAX_Y,
  GLASS_MIN_X,
  GLASS_MIN_Y,
  GLASS_TOP_HALF_WIDTH,
  GLASS_WORLD_HEIGHT,
  NOZZLE_WORLD_Y,
} from '../../src/types/simulation';

describe('Group 1: Drink Catalog & Color Math (src/catalog/drinks.ts)', () => {
  it('defines all 5 canonical drinks with exact colors, carbonation, and nozzle coordinates', () => {
    expect(DRINK_IDS).toEqual([
      'coca-cola',
      'fanta',
      'sprite',
      'cherry',
      'berry-blue',
    ]);
    expect(DRINK_CATALOG).toHaveLength(5);
    expect(DRINKS).toBe(DRINK_CATALOG);

    const expectedNozzleX = [360, 380, 400, 420, 440];
    const expectedHex = ['#3E160C', '#FF7D00', '#AAF5C3', '#E4183E', '#0098FF'];
    const expectedRgb: Array<[number, number, number]> = [
      [62, 22, 12],
      [255, 125, 0],
      [170, 245, 195],
      [228, 24, 62],
      [0, 152, 255],
    ];

    DRINK_CATALOG.forEach((spec, idx) => {
      expect(spec.nozzleIndex).toBe(idx);
      expect(spec.nozzleX).toBe(expectedNozzleX[idx]);
      expect(spec.nozzleY).toBe(NOZZLE_WORLD_Y);
      expect(spec.hexColor).toBe(expectedHex[idx]);
      expect(spec.rgb255).toEqual(expectedRgb[idx]);
      expect(getDrinkSpec(spec.id)).toBe(spec);
      expect(getDrinkById(spec.id)).toBe(spec);
      expect(DRINK_BY_ID[spec.id]).toBe(spec);
      expect(isValidDrinkId(spec.id)).toBe(true);
    });

    expect(isValidDrinkId('unknown-soda')).toBe(false);
    expect(isValidDrinkId(null)).toBe(false);
  });

  it('converts accurately between RGB255, normalized RGBA, and CSS hex strings', () => {
    expect(rgbToHex(62, 22, 12)).toBe('#3e160c');
    expect(rgbToHex([255, 125, 0])).toBe('#ff7d00');
    expect(hexToRgb('#3E160C')).toEqual([62, 22, 12]);
    expect(hexToRgb('FF7D00')).toEqual([255, 125, 0]);
    expect(hexToRgb('#f0a')).toEqual([255, 0, 170]);

    const norm = rgb255ToNormalized([255, 125, 0], 0.9);
    expect(norm[0]).toBeCloseTo(1.0, 3);
    expect(norm[1]).toBeCloseTo(125 / 255, 3);
    expect(norm[2]).toBeCloseTo(0.0, 3);
    expect(norm[3]).toBeCloseTo(0.9, 3);

    expect(normalizedToRgb255(norm)).toEqual([255, 125, 0]);
    expect(normalizedToHex(norm)).toBe('#ff7d00');
    expect(colorDistanceRGB255([10, 20, 30], [13, 24, 30])).toBeCloseTo(5, 5);
  });

  it('computes exact volume-weighted multi-drink color blends', () => {
    const empty = blendDrinksByVolume({});
    expect(empty.totalWeight).toBe(0);
    expect(empty.hex).toBeNull();
    expect(empty.rgb255).toEqual([0, 0, 0]);

    const colaFanta = computeWeightedDrinkMix({ 'coca-cola': 1, 'fanta': 1 });
    expect(colaFanta.rgb255).toEqual([158, 73, 6]);
    expect(colaFanta.hex).toBe('#9e4906');
    expect(colaFanta.effectiveCarbonation).toBeCloseTo(0.775, 4);
    expect(colaFanta.composition['coca-cola']).toBeCloseTo(0.5, 5);
    expect(colaFanta.composition['fanta']).toBeCloseTo(0.5, 5);

    const cherryBlue = blendDrinksByVolume({ 'cherry': 50, 'berry-blue': 50 });
    expect(cherryBlue.rgb255).toEqual([114, 88, 158]);
    expect(cherryBlue.hex).toBe('#72589e');
    expect(cherryBlue.effectiveCarbonation).toBeCloseTo(0.475, 4);

    const fantaSprite = blendDrinksByVolume({ 'fanta': 1, 'sprite': 1 });
    expect(fantaSprite.rgb255).toEqual([213, 185, 98]);
    expect(fantaSprite.hex).toBe('#d5b962');

    const ratio75_25 = blendDrinksByVolume({ 'coca-cola': 3, 'fanta': 1 });
    expect(ratio75_25.rgb255).toEqual([110, 48, 9]);
    expect(ratio75_25.hex).toBe('#6e3009');
    expect(ratio75_25.composition['coca-cola']).toBeCloseTo(0.75, 5);
    expect(ratio75_25.composition['fanta']).toBeCloseTo(0.25, 5);
  });
});

describe('Group 2: Spatial Hash O(N) Neighbor Lookup (src/physics/spatialHash.ts)', () => {
  it('matches brute-force Euclidean radius search with 100% accuracy across 200 particles', () => {
    const hash = new SpatialHash(800, 600, 16.0);
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 200; i++) {
      pts.push({
        x: ((i * 97) % 780) + 10,
        y: ((i * 53) % 580) + 10,
      });
    }
    hash.rebuild(pts);

    const testQueries = [
      { x: 400, y: 150, r: 16.0 },
      { x: 250, y: 300, r: 32.0 },
      { x: 100, y: 100, r: 24.0 },
    ];

    for (const q of testQueries) {
      const actual = hash.queryRadius(q.x, q.y, q.r, pts).sort((a, b) => a - b);
      const expected: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - q.x, pts[i].y - q.y) <= q.r) {
          expected.push(i);
        }
      }
      expect(actual).toEqual(expected);
    }
  });

  it('handles boundary/out-of-bounds coordinates, clear/insert, and forEachNeighbor', () => {
    const hash = new SpatialHash(800, 600, 16.0);
    hash.clear();
    hash.insert(0, 0, 0);
    hash.insert(1, 800, 600);
    hash.insert(2, -25, -10);
    hash.insert(3, 850, 620);

    expect(hash.queryRadius(0, 0, 30)).toContain(0);
    expect(hash.queryRadius(0, 0, 30)).toContain(2);
    expect(hash.queryRadius(800, 600, 60)).toContain(1);
    expect(hash.queryRadius(800, 600, 60)).toContain(3);

    const visited: number[] = [];
    hash.forEachNeighbor(0, 0, 0, 35, undefined, (neighborIdx) => {
      visited.push(neighborIdx);
    });
    expect(visited).toEqual([2]);
  });
});

describe('Group 3: Movable Glass Collider (src/physics/glassCollider.ts)', () => {
  it('initializes at canonical default position and clamps world & normalized coordinates', () => {
    const collider = new GlassCollider();
    const state = collider.getState();

    expect(state.x).toBe(DEFAULT_GLASS_X);
    expect(state.y).toBe(DEFAULT_GLASS_Y);
    expect(state.normX).toBeCloseTo(0.5, 5);
    expect(state.normY).toBeCloseTo(145 / 600, 4);
    expect(state.bottomHalfWidth).toBe(GLASS_BOTTOM_HALF_WIDTH);
    expect(state.topHalfWidth).toBe(GLASS_TOP_HALF_WIDTH);
    expect(state.worldHeight).toBe(GLASS_WORLD_HEIGHT);
    expect(collider.bottomY).toBe(55);
    expect(collider.rimY).toBe(235);

    // Normalized coordinate input (<= 1.0)
    collider.moveGlassTo(0.25);
    expect(collider.state.x).toBeCloseTo(200, 5);
    expect(collider.state.normX).toBeCloseTo(0.25, 5);

    // World coordinate input (> 1.0)
    collider.moveGlassTo(520);
    expect(collider.state.x).toBeCloseTo(520, 5);
    expect(collider.state.normX).toBeCloseTo(0.65, 5);

    // Clamping at boundaries
    collider.moveGlassTo(10, 50);
    expect(collider.state.x).toBe(GLASS_MIN_X);
    expect(collider.state.normX).toBeCloseTo(0.15, 5);
    expect(collider.state.y).toBe(GLASS_MIN_Y);

    collider.moveGlassTo(795, 550);
    expect(collider.state.x).toBe(GLASS_MAX_X);
    expect(collider.state.normX).toBeCloseTo(0.85, 5);
    expect(collider.state.y).toBe(GLASS_MAX_Y);
  });

  it('computes tapered half-width and accurately classifies interior vs exterior points', () => {
    const collider = new GlassCollider();
    expect(collider.halfWidthAtY(55)).toBeCloseTo(55, 5);
    expect(collider.halfWidthAtY(145)).toBeCloseTo(65, 5);
    expect(collider.halfWidthAtY(235)).toBeCloseTo(75, 5);

    // Inside at bottom and top rim
    expect(collider.isInsideGlass(400, 100)).toBe(true);
    expect(collider.isInsideGlass(450, 60)).toBe(true);
    expect(collider.isInsideGlass(470, 230)).toBe(true);

    // Outside tapered lower wall (x = 470 is inside at y = 230, but outside at y = 60 where halfW ≈ 55.5)
    expect(collider.isInsideGlass(470, 60)).toBe(false);
    // Below bottom floor or above top rim
    expect(collider.isInsideGlass(400, 40)).toBe(false);
    expect(collider.isInsideGlass(400, 250)).toBe(false);
  });
});

describe('Group 4: Fluid Emission, Stream Catching, Missing & Overflow (src/physics/fluidWorld.ts)', () => {
  it('catches poured stream at default centered glass position (x = 400)', () => {
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.stepFrames(90);

    const snap = world.getSnapshot();
    expect(snap.activeDrinks).toEqual(['coca-cola']);
    expect(snap.fallingParticleCount).toBeGreaterThan(0);
    expect(snap.pooledParticleCount).toBeGreaterThan(100);
    expect(snap.liquid.fillLevel).toBeGreaterThan(0.2);
    expect(snap.liquid.colorHistory).toEqual(['coca-cola']);
    expect(snap.bubbleCount).toBeGreaterThan(0);
  });

  it('misses the glass when moved far left (x = 160) or far right (x = 640)', () => {
    const world = new FluidWorld();

    // Far left: glass.x = 160 (opening [85, 235], nozzle at 380)
    world.moveGlassTo(160);
    expect(world.getGlassState().x).toBe(160);
    world.startPouring('fanta');
    world.stepFrames(100);

    let snap = world.getSnapshot();
    expect(snap.pooledParticleCount).toBe(0);
    expect(snap.liquid.fillLevel).toBe(0);
    expect(snap.spilledParticleCount).toBeGreaterThan(0);

    // Far right: glass.x = 640 (opening [565, 715], nozzle at 440)
    world.reset();
    world.moveGlassTo(640);
    expect(world.getGlassState().x).toBe(640);
    world.startPouring('berry-blue');
    world.stepFrames(100);

    snap = world.getSnapshot();
    expect(snap.pooledParticleCount).toBe(0);
    expect(snap.liquid.fillLevel).toBe(0);
    expect(snap.spilledParticleCount).toBeGreaterThan(0);
  });

  it('co-translates pooled fluid and imparts sloshing velocity when moving a partially filled glass', () => {
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.stepFrames(75);
    world.stopPouring();
    world.stepFrames(35);

    const beforeSnap = world.getSnapshot();
    const initialPooled = beforeSnap.pooledParticleCount;
    expect(initialPooled).toBeGreaterThan(150);

    // Move glass horizontally from 400 to 500
    world.moveGlassTo(500);
    const particles = world.getParticles().filter((p) => p.state === 'pooled');
    expect(particles.length).toBe(initialPooled);

    const meanX =
      particles.reduce((acc, p) => acc + p.x, 0) / particles.length;
    const maxSpeed = particles.reduce(
      (acc, p) => Math.max(acc, Math.hypot(p.vx, p.vy)),
      0,
    );

    expect(meanX).toBeGreaterThan(460);
    expect(meanX).toBeLessThan(540);
    expect(maxSpeed).toBeGreaterThan(10);

    // Step 10 frames and verify fluid remains contained inside the moved glass
    world.stepFrames(10);
    expect(world.getSnapshot().pooledParticleCount).toBeGreaterThanOrEqual(
      Math.floor(initialPooled * 0.98),
    );
  });

  it('spills excess liquid over the rim when overfilled (fillLevel >= 1.0)', () => {
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.startPouring('fanta');
    // 2 nozzles * 3 particles/frame = 6 particles/frame -> > 480 particles in 120 frames
    world.stepFrames(130);

    const snap = world.getSnapshot();
    expect(snap.pooledParticleCount).toBe(GLASS_MAX_CAPACITY_PARTICLES);
    expect(snap.liquid.fillLevel).toBeCloseTo(1.0, 5);
    expect(snap.liquid.fillRatio).toBeCloseTo(1.0, 5);
    expect(snap.liquid.isOverflowing).toBe(true);
    expect(snap.spilledParticleCount).toBeGreaterThan(0);
  });
});

describe('Group 5: Two-Stage Color Mixing & Variance Decay (src/physics/colorMixer.ts & fluidWorld.ts)', () => {
  it('preserves exact drink color and zero mixingVariance for a single poured drink', () => {
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.stepFrames(60);
    world.stopPouring();
    world.stepFrames(35);

    const liquid = world.getLiquidSummary();
    expect(liquid.pooledParticleCount).toBe(180);
    expect(liquid.averageColorRGB).toEqual([62, 22, 12]);
    expect(liquid.mixedColorHex).toBe('#3e160c');
    expect(liquid.drinkComposition['coca-cola']).toBeCloseTo(1.0, 5);
    expect(liquid.colorHistory).toEqual(['coca-cola']);
    expect(liquid.mixingVariance).toBe(0);
    expect(liquid.effectiveCarbonation).toBeCloseTo(0.9, 4);
  });

  it('blends 2-drink 50/50 mixes to exact volume-weighted RGB average', () => {
    // 1. Coca-Cola + Fanta 50/50 -> [158, 73, 6] (#9e4906)
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.stepFrames(50);
    world.stopPouring();
    world.startPouring('fanta');
    world.stepFrames(50);
    world.stopPouring();
    world.stepFrames(40);

    let liquid = world.getLiquidSummary();
    expect(liquid.drinkComposition['coca-cola']).toBeCloseTo(0.5, 2);
    expect(liquid.drinkComposition['fanta']).toBeCloseTo(0.5, 2);
    expect(colorDistanceRGB255(liquid.averageColorRGB, [158, 73, 6])).toBeLessThanOrEqual(2);
    expect(liquid.colorHistory).toEqual(['coca-cola', 'fanta']);

    // 2. Cherry + Berry-Blue 50/50 -> [114, 88, 158] (#72589e)
    world.reset();
    world.startPouring('cherry');
    world.stepFrames(50);
    world.stopPouring();
    world.startPouring('berry-blue');
    world.stepFrames(50);
    world.stopPouring();
    world.stepFrames(40);

    liquid = world.getLiquidSummary();
    expect(colorDistanceRGB255(liquid.averageColorRGB, [114, 88, 158])).toBeLessThanOrEqual(2);
    expect(liquid.colorHistory).toEqual(['cherry', 'berry-blue']);

    // 3. Fanta + Sprite 50/50 -> [213, 185, 98] (#d5b962)
    world.reset();
    world.startPouring('fanta');
    world.stepFrames(50);
    world.stopPouring();
    world.startPouring('sprite');
    world.stepFrames(50);
    world.stopPouring();
    world.stepFrames(40);

    liquid = world.getLiquidSummary();
    expect(colorDistanceRGB255(liquid.averageColorRGB, [213, 185, 98])).toBeLessThanOrEqual(2);
    expect(liquid.colorHistory).toEqual(['fanta', 'sprite']);
  });

  it('accurately blends 3 drinks and 75/25 non-equal drink ratios', () => {
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.stepFrames(40);
    world.stopPouring();
    world.startPouring('fanta');
    world.stepFrames(40);
    world.stopPouring();
    world.startPouring('sprite');
    world.stepFrames(40);
    world.stopPouring();
    world.stepFrames(40);

    const mix3 = world.getLiquidSummary();
    expect(mix3.colorHistory).toEqual(['coca-cola', 'fanta', 'sprite']);
    const compSum =
      mix3.drinkComposition['coca-cola'] +
      mix3.drinkComposition['fanta'] +
      mix3.drinkComposition['sprite'];
    expect(compSum).toBeCloseTo(1.0, 5);
    expect(colorDistanceRGB255(mix3.averageColorRGB, [162, 131, 69])).toBeLessThanOrEqual(3);

    // 75/25 Coca-Cola + Fanta
    world.reset();
    world.startPouring('coca-cola');
    world.stepFrames(60);
    world.stopPouring();
    world.startPouring('fanta');
    world.stepFrames(20);
    world.stopPouring();
    world.stepFrames(40);

    const mix75 = world.getLiquidSummary();
    expect(mix75.drinkComposition['coca-cola']).toBeCloseTo(0.75, 2);
    expect(mix75.drinkComposition['fanta']).toBeCloseTo(0.25, 2);
    expect(colorDistanceRGB255(mix75.averageColorRGB, [110, 48, 9])).toBeLessThanOrEqual(2);
  });

  it('exhibits positive mixingVariance upon second drink entry, decays monotonically to 0, and mixes faster with glass agitation', () => {
    const worldStationary = new FluidWorld(12345);
    const worldAgitated = new FluidWorld(12345);

    for (const w of [worldStationary, worldAgitated]) {
      w.startPouring('coca-cola');
      w.stepFrames(50);
      w.stopPouring();
      w.stepFrames(35);
      expect(w.getLiquidSummary().mixingVariance).toBe(0);

      // Pour Sprite until new particles enter the top of the Coca-Cola pool
      w.startPouring('sprite');
      w.stepFrames(35);
      w.stopPouring();
    }

    // Immediately upon stream entry into the pool, mixingVariance is strictly positive
    const vUponEntry = worldStationary.getLiquidSummary().mixingVariance;
    expect(vUponEntry).toBeGreaterThan(0.01);

    // Let the remaining in-flight falling Sprite stream finish landing in the pool
    worldStationary.stepFrames(32);
    worldAgitated.stepFrames(32);
    expect(worldStationary.getSnapshot().fallingParticleCount).toBe(0);

    const v0 = worldStationary.getLiquidSummary().mixingVariance;
    expect(v0).toBeGreaterThan(0.01);

    // Agitate worldAgitated by sloshing the glass back and forth while worldStationary sits still
    for (let step = 0; step < 20; step++) {
      const targetX = step % 2 === 0 ? 445 : 355;
      worldAgitated.moveGlassTo(targetX);
      worldAgitated.stepFrames(1);
      worldStationary.stepFrames(1);
    }

    const vStationary20 = worldStationary.getLiquidSummary().mixingVariance;
    const vAgitated20 = worldAgitated.getLiquidSummary().mixingVariance;

    expect(vStationary20).toBeLessThan(v0);
    expect(vAgitated20).toBeLessThan(vStationary20);

    // Step stationary world for another 80 frames and verify variance decays to near zero
    let prevV = vStationary20;
    for (let f = 0; f < 80; f++) {
      worldStationary.stepFrames(1);
      const curV = worldStationary.getLiquidSummary().mixingVariance;
      expect(curV).toBeLessThanOrEqual(prevV + 1e-9);
      prevV = curV;
    }
    const vFinal = worldStationary.getLiquidSummary().mixingVariance;
    expect(vFinal).toBeLessThan(v0 * 0.05);

    // Verify ColorMixer & toFluidTelemetry helper contract directly
    const mixer = new ColorMixer();
    const telemetry = toFluidTelemetry(worldStationary.getLiquidSummary());
    expect(telemetry.particleOrMassCount).toBe(
      worldStationary.getLiquidSummary().pooledParticleCount,
    );
    expect(telemetry.mixingEntropyOrVariance).toBe(
      worldStationary.getLiquidSummary().mixingVariance,
    );
    expect(mixer.createEmptySummary().mixedColorHex).toBeNull();
  });
});

describe('Group 6: Reset & Empty Glass Cleanup', () => {
  it('emptyGlass() clears all liquid and bubbles while preserving current glass position', () => {
    const world = new FluidWorld();
    world.moveGlassTo(460, 180);
    world.startPouring('cherry');
    world.stepFrames(60);

    expect(world.getLiquidSummary().pooledParticleCount).toBeGreaterThan(0);

    world.emptyGlass();
    const snap = world.getSnapshot();
    expect(snap.pooledParticleCount).toBe(0);
    expect(snap.totalParticleCount).toBe(0);
    expect(snap.bubbleCount).toBe(0);
    expect(snap.liquid.fillLevel).toBe(0);
    expect(snap.liquid.mixedColorHex).toBeNull();
    expect(snap.liquid.averageColorRGB).toEqual([0, 0, 0]);
    expect(snap.liquid.colorHistory).toEqual([]);
    expect(snap.liquid.mixingVariance).toBe(0);
    expect(snap.glass.x).toBe(460);
    expect(snap.glass.y).toBe(180);
  });

  it('reset() stops pouring, clears particles, and restores glass to default (400, 145)', () => {
    const world = new FluidWorld();
    world.moveGlassTo(220, 200);
    world.startPouring('berry-blue');
    world.stepFrames(60);

    world.reset();
    const snap = world.getSnapshot();
    expect(snap.activeDrinks).toEqual([]);
    expect(snap.totalParticleCount).toBe(0);
    expect(snap.pooledParticleCount).toBe(0);
    expect(snap.bubbleCount).toBe(0);
    expect(snap.frameCount).toBe(0);
    expect(snap.glass.x).toBe(DEFAULT_GLASS_X);
    expect(snap.glass.y).toBe(DEFAULT_GLASS_Y);
    expect(snap.glass.normX).toBeCloseTo(0.5, 5);
    expect(snap.liquid.fillLevel).toBe(0);
    expect(snap.liquid.mixedColorHex).toBeNull();
  });

  it('deflects falling stream off exterior tapered wall when nozzle strikes just outside the rim', () => {
    const world = new FluidWorld();
    // Place glass at x = 281 so right rim is at 281 + 75 = 356, just left of coca-cola nozzle at x = 360
    world.moveGlassTo(281);
    world.startPouring('coca-cola');
    world.stepFrames(80);

    const snap = world.getSnapshot();
    expect(snap.pooledParticleCount).toBe(0);
    expect(snap.spilledParticleCount).toBeGreaterThan(0);
  });

  it('continues blending new drink into the glass even when already at 100% capacity (overflow mixing)', () => {
    const world = new FluidWorld();
    world.startPouring('coca-cola');
    world.stepFrames(195);
    world.stopPouring();
    world.stepFrames(35);

    const fullCola = world.getSnapshot();
    expect(fullCola.liquid.fillLevel).toBeCloseTo(1.0, 5);
    expect(fullCola.liquid.isOverflowing).toBe(true);
    expect(fullCola.liquid.colorHistory).toEqual(['coca-cola']);

    // Now pour Fanta into the already-full glass
    world.startPouring('fanta');
    world.stepFrames(80);
    world.stopPouring();
    world.stepFrames(40);

    const mixedFull = world.getSnapshot();
    expect(mixedFull.liquid.fillLevel).toBeCloseTo(1.0, 5);
    expect(mixedFull.liquid.isOverflowing).toBe(true);
    expect(mixedFull.spilledParticleCount).toBeGreaterThan(0);
    expect(mixedFull.liquid.colorHistory).toEqual(['coca-cola', 'fanta']);
    expect(mixedFull.liquid.drinkComposition['fanta']).toBeGreaterThan(0.15);
    expect(mixedFull.liquid.averageColorRGB[0]).toBeGreaterThan(90);
  });

  it('exposes getRenderState(), setGlassDragging(), updateGlassScreenRect(), setWebGLVersion(), and isPouring()', () => {
    const world = new FluidWorld();
    expect(world.isPouring()).toBe(false);
    world.startPouring('sprite');
    expect(world.isPouring()).toBe(true);
    expect(world.isPouring('sprite')).toBe(true);
    expect(world.isPouring('fanta')).toBe(false);

    world.setGlassDragging(true);
    world.updateGlassScreenRect({ x: 100, y: 200, width: 150, height: 180 });
    world.setWebGLVersion(1);
    world.stepFrames(5);

    const renderState = world.getRenderState();
    expect(renderState.worldWidth).toBe(800);
    expect(renderState.worldHeight).toBe(600);
    expect(renderState.activeNozzles).toEqual(['sprite']);
    expect(renderState.glass.isDragging).toBe(true);
    expect(renderState.glass.screenRect).toEqual({
      x: 100,
      y: 200,
      width: 150,
      height: 180,
    });
    expect(world.getSnapshot().webglVersion).toBe(1);
    expect(world.getFrameCount()).toBe(5);
  });
});
