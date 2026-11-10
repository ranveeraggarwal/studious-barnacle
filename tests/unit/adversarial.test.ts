// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRINK_BY_ID,
  DRINK_IDS,
  blendDrinksByVolume,
  clamp01,
  clampByte,
  getDrinkById,
  getDrinkSpec,
  hexToRgb,
  isValidDrinkId,
  rgb255ToNormalized,
  rgbToHex,
} from '../../src/catalog/drinks';
import { SodaFountainApp, initSodaFountainApp } from '../../src/main';
import { ColorMixer } from '../../src/physics/colorMixer';
import { FluidWorld } from '../../src/physics/fluidWorld';
import { GlassCollider } from '../../src/physics/glassCollider';
import { SpatialHash } from '../../src/physics/spatialHash';
import {
  BubbleParticle,
  DEFAULT_GLASS_X,
  DEFAULT_GLASS_Y,
  DrinkId,
  FluidParticle,
  GLASS_MAX_CAPACITY_PARTICLES,
  SimulationSnapshot,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../../src/types/simulation';
import {
  FountainControls,
  clampWorldGlassCoords,
  clientToWorldCoords,
  ensureFountainDOM,
} from '../../src/ui/controls';
import {
  FLOAT_ISO_THRESHOLD,
  FLOAT_SPLAT_SCALE,
  FluidFBOManager,
  RGBA8_ISO_THRESHOLD,
  RGBA8_SPLAT_SCALE,
  createFluidFBO,
  destroyFluidFBO,
  detectWebGLVersion,
  resizeFluidFBO,
} from '../../src/webgl/fbo';
import {
  BUBBLE_FOAM_FLOATS,
  DISPENSER_HEADER_RGB255,
  FLUID_SPLAT_FLOATS,
  STUDIO_BG_RGB255,
  buildBubbleFoamBuffer,
  buildFluidSplatBuffer,
  buildHydrostaticLiquidMesh,
  buildSceneStaticMesh,
  computePoolTopY,
  ndcToWorld,
  worldToNDC,
} from '../../src/webgl/meshes';
import {
  SodaFountainRenderer,
  evaluateScenePixelAtWorld,
} from '../../src/webgl/renderer';
import {
  SHADER_PASS_NAMES,
  ShaderPassName,
  compileShader,
  createAllShaderPrograms,
  createShaderProgram,
  destroyShaderPrograms,
  getShaderSource,
  getShaderSources,
} from '../../src/webgl/shaders';

function makeParticle(overrides: Partial<FluidParticle> = {}): FluidParticle {
  const spec = DRINK_BY_ID[overrides.drinkId ?? 'coca-cola'];
  return {
    x: 400,
    y: 100,
    vx: 0,
    vy: 0,
    r: spec.color[0],
    g: spec.color[1],
    b: spec.color[2],
    a: spec.color[3],
    initR: spec.color[0],
    initG: spec.color[1],
    initB: spec.color[2],
    initA: spec.color[3],
    drinkId: spec.id,
    carbonation: spec.carbonation,
    density: 1.0,
    pressure: 0.0,
    state: 'pooled',
    age: 1.0,
    ...overrides,
  };
}

function createLightweightStubGL(
  overrides: Record<string, unknown> = {},
): WebGL2RenderingContext {
  const deletedShaders: object[] = [];
  const deletedPrograms: object[] = [];
  const deletedTextures: object[] = [];
  const deletedFramebuffers: object[] = [];
  const deletedBuffers: object[] = [];
  const texParams: Array<{ target: number; pname: number; param: number }> = [];

  const base: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    RGBA16F: 0x881a,
    HALF_FLOAT: 0x140b,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE0: 0x84c0,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    ONE: 1,
    ZERO: 0,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    POINTS: 0x0000,
    NO_ERROR: 0,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    __deletedShaders: deletedShaders,
    __deletedPrograms: deletedPrograms,
    __deletedTextures: deletedTextures,
    __deletedFramebuffers: deletedFramebuffers,
    __deletedBuffers: deletedBuffers,
    __texParams: texParams,
    getError: () => 0,
    getExtension: () => ({}),
    createShader: (type: number) => ({ type }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: (s: object) => {
      deletedShaders.push(s);
    },
    createProgram: () => ({}),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    useProgram: () => {},
    deleteProgram: (p: object) => {
      deletedPrograms.push(p);
    },
    getAttribLocation: (_p: unknown, name: string) => {
      const order = [
        'a_position',
        'a_color',
        'a_radius',
        'a_state',
        'a_alpha',
        'a_isFoam',
        'a_edgeFactor',
      ];
      return order.indexOf(name);
    },
    getUniformLocation: () => ({}),
    uniform1i: () => {},
    uniform1f: () => {},
    uniform2f: () => {},
    uniform3f: () => {},
    uniform4f: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: (b: object) => {
      deletedBuffers.push(b);
    },
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: (target: number, pname: number, param: number) => {
      texParams.push({ target, pname, param });
    },
    texImage2D: () => {},
    activeTexture: () => {},
    deleteTexture: (t: object) => {
      deletedTextures.push(t);
    },
    createFramebuffer: () => ({}),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    deleteFramebuffer: (f: object) => {
      deletedFramebuffers.push(f);
    },
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    enable: () => {},
    disable: () => {},
    blendFunc: () => {},
    blendFuncSeparate: () => {},
    drawArrays: () => {},
    readPixels: (
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _fmt: number,
      _type: number,
      pixels: ArrayBufferView | null,
    ) => {
      if (pixels && pixels instanceof Uint8Array) {
        pixels.fill(0);
      }
    },
    isContextLost: () => false,
    ...overrides,
  };

  return base as unknown as WebGL2RenderingContext;
}

// ============================================================================
// UT-ADV-01 & U5-5a: Drink Catalog Defensive Guards, Error Branches & WB-BUG-01
// ============================================================================
describe('UT-ADV-01 / U5-5a: Drink Catalog Defensive Guards & Non-Finite Volume Blending (src/catalog/drinks.ts)', () => {
  it('rejects Object.prototype keys and non-string values in isValidDrinkId and throws on unknown DrinkId in getDrinkSpec', () => {
    expect(isValidDrinkId('toString')).toBe(false);
    expect(isValidDrinkId('constructor')).toBe(false);
    expect(isValidDrinkId('valueOf')).toBe(false);
    expect(isValidDrinkId('__proto__')).toBe(false);
    expect(isValidDrinkId('')).toBe(false);
    expect(isValidDrinkId(123)).toBe(false);
    expect(isValidDrinkId({})).toBe(false);
    expect(isValidDrinkId(undefined)).toBe(false);

    expect(() => getDrinkSpec('root-beer' as DrinkId)).toThrow(
      /Unknown DrinkId: root-beer/,
    );
    expect(() => getDrinkById('pepsi' as DrinkId)).toThrow(
      /Unknown DrinkId: pepsi/,
    );
  });

  it('handles NaN, Infinity, and out-of-range inputs in clamp01, clampByte, rgbToHex, hexToRgb, and rgb255ToNormalized', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(-0.25)).toBe(0);
    expect(clamp01(1.75)).toBe(1);
    expect(clamp01(0.45)).toBeCloseTo(0.45, 5);

    expect(clampByte(NaN)).toBe(0);
    expect(clampByte(Infinity)).toBe(0);
    expect(clampByte(-Infinity)).toBe(0);
    expect(clampByte(-5)).toBe(0);
    expect(clampByte(254.6)).toBe(255);
    expect(clampByte(999)).toBe(255);

    // Omitted g, b scalar overload
    expect(rgbToHex(128)).toBe('#800000');
    expect(rgbToHex(128, 64)).toBe('#804000');
    expect(rgbToHex([NaN, 300, -10])).toBe('#00ff00');

    // Whitespace trimming & 3-char hex
    expect(hexToRgb('  #F0A  ')).toEqual([255, 0, 170]);

    // Invalid hex error branches
    expect(() => hexToRgb('#g0z')).toThrow(/Invalid hex color/);
    expect(() => hexToRgb('#ggg')).toThrow(/Invalid hex color/);
    expect(() => hexToRgb('#12345')).toThrow(/Invalid hex color/);
    expect(() => hexToRgb('')).toThrow(/Invalid hex color/);
    expect(() => hexToRgb('#GG00FF')).toThrow(/Invalid hex color/);
    expect(() => hexToRgb('#zzzzzz')).toThrow(/Invalid hex color/);

    // Default alpha = 1.0 in rgb255ToNormalized
    const norm = rgb255ToNormalized([255, 0, 128]);
    expect(norm[0]).toBeCloseTo(1.0, 5);
    expect(norm[1]).toBeCloseTo(0.0, 5);
    expect(norm[2]).toBeCloseTo(128 / 255, 5);
    expect(norm[3]).toBe(1.0);
  });

  it('sanitizes negative, NaN, and Infinity volume weights in blendDrinksByVolume (WB-BUG-01 fix)', () => {
    const res = blendDrinksByVolume({
      'coca-cola': -50,
      fanta: NaN,
      sprite: Infinity,
      cherry: 10,
      'berry-blue': -Infinity,
    });

    expect(res.totalWeight).toBe(10);
    expect(res.composition['coca-cola']).toBe(0);
    expect(res.composition.fanta).toBe(0);
    expect(res.composition.sprite).toBe(0);
    expect(res.composition.cherry).toBe(1.0);
    expect(res.composition['berry-blue']).toBe(0);
    expect(res.rgb255).toEqual([228, 24, 62]);
    expect(res.hex).toBe('#e4183e');

    const allInvalid = blendDrinksByVolume({
      'coca-cola': NaN,
      fanta: Infinity,
      sprite: -10,
    });
    expect(allInvalid.totalWeight).toBe(0);
    expect(allInvalid.hex).toBeNull();
    expect(allInvalid.rgb255).toEqual([0, 0, 0]);
  });
});

// ============================================================================
// UT-ADV-02 & U5-5b: SpatialHash Dynamic Capacity, Degenerate Inputs & WB-BUG-02
// ============================================================================
describe('UT-ADV-02 / U5-5b: SpatialHash Dynamic Capacity Growth, Non-Finite Guards & Coincident Particles (src/physics/spatialHash.ts)', () => {
  it('clamps non-positive cellSize and dynamically reallocates internal buffers beyond initial capacity', () => {
    const clampedHash = new SpatialHash(800, 600, -5, 16);
    expect(clampedHash.cellSize).toBe(1.0);
    expect(clampedHash.invCellSize).toBe(1.0);

    const hash = new SpatialHash(800, 600, 16.0, 16); // nextPow2(16) = 1024
    const manyParticles: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 1200; i++) {
      manyParticles.push({ x: (i % 700) + 50, y: (i % 500) + 50 });
    }
    hash.rebuild(manyParticles);

    // Also insert at index 1500 to trigger ensureCapacity via insert()
    hash.insert(1500, 400, 300);
    const found = hash.queryNeighbors(400, 300, 5);
    expect(found).toContain(1500);
  });

  it('guards negative/non-finite indices, out-of-order inserts, and NaN coordinates/radii (WB-BUG-02 fix)', () => {
    const hash = new SpatialHash(800, 600, 16.0);
    hash.clear();

    // Negative and NaN indices are safe no-ops
    hash.insert(-1, 100, 100);
    hash.insert(NaN, 100, 100);
    expect(hash.queryNeighbors(100, 100, 20)).toEqual([]);

    // Out-of-order insert: index 10 then index 3 (index + 1 <= count)
    hash.insert(10, 200, 200);
    hash.insert(3, 202, 202);
    const near200 = hash.queryNeighbors(200, 200, 10).sort((a, b) => a - b);
    expect(near200).toEqual([3, 10]);

    // Non-finite coordinates in getCellIndex and insert must not produce NaN or infinite self-loops
    const cellNaN = hash.getCellIndex(NaN, NaN);
    expect(Number.isFinite(cellNaN)).toBe(true);
    expect(cellNaN).toBe(0);

    hash.insert(0, NaN, NaN);
    hash.insert(1, Infinity, -Infinity);
    expect(hash.queryNeighbors(0, 0, 20)).toContain(0);

    // Negative or NaN radius / coordinates in queryNeighbors & queryRadius & forEachNeighbor
    const reusedOut = [99, 100];
    expect(hash.queryNeighbors(400, 300, -1, undefined, reusedOut)).toBe(
      reusedOut,
    );
    expect(reusedOut).toEqual([]);
    expect(hash.queryRadius(400, 300, NaN)).toEqual([]);
    expect(hash.queryNeighbors(NaN, 300, 20)).toEqual([]);

    let visitedCount = 0;
    hash.forEachNeighbor(0, 400, 300, -5, undefined, () => {
      visitedCount++;
    });
    hash.forEachNeighbor(0, 400, 300, NaN, undefined, () => {
      visitedCount++;
    });
    hash.forEachNeighbor(0, NaN, 300, 20, undefined, () => {
      visitedCount++;
    });
    expect(visitedCount).toBe(0);
  });

  it('handles coincident particles at radius = 0 in forEachNeighbor while skipping selfIndex', () => {
    const hash = new SpatialHash(800, 600, 16.0);
    hash.insert(0, 250, 250);
    hash.insert(1, 250, 250);

    const hits: Array<{ idx: number; distSq: number }> = [];
    hash.forEachNeighbor(0, 250, 250, 0, undefined, (idx, _dx, _dy, distSq) => {
      hits.push({ idx, distSq });
    });

    expect(hits).toEqual([{ idx: 1, distSq: 0 }]);
  });
});

// ============================================================================
// UT-ADV-03 & U5-5b: GlassCollider Guards, Normalized Y, coTranslateFalling & Rim Slosh
// ============================================================================
describe('UT-ADV-03 / U5-5b: GlassCollider Non-Finite Guards, Normalized Y, coTranslateFalling & Rim Slosh Spill (src/physics/glassCollider.ts)', () => {
  it('guards non-finite x, y, and dt in moveGlassTo and decayVelocity (WB-BUG-03 fix)', () => {
    const collider = new GlassCollider();

    expect(collider.moveGlassTo(NaN, 200)).toEqual({ dx: 0, dy: 0 });
    expect(collider.state.x).toBe(DEFAULT_GLASS_X);
    expect(collider.state.y).toBe(DEFAULT_GLASS_Y);

    // Normalized y in [0..1] and NaN dt
    collider.moveGlassTo(0.5, 0.5, undefined, NaN);
    expect(collider.state.x).toBe(400);
    expect(collider.state.y).toBe(300);
    expect(collider.state.normY).toBeCloseTo(0.5, 5);
    expect(Number.isFinite(collider.state.vx)).toBe(true);
    expect(Number.isFinite(collider.state.vy)).toBe(true);

    // halfWidthAtY alias and isInsideGlass with margin
    expect(collider.halfWidthAtY(210)).toBeCloseTo(collider.halfWidthAt(210), 5);
    expect(collider.isInsideGlass(400, 300, 5)).toBe(true);
    expect(collider.isInsideGlass(400, 50, 5)).toBe(false);

    // decayVelocity(NaN) keeps velocity finite, decayVelocity(2.0) snaps residual velocity to 0
    collider.decayVelocity(NaN);
    expect(Number.isFinite(collider.state.vy)).toBe(true);
    collider.decayVelocity(2.0);
    expect(collider.state.vx).toBe(0);
    expect(collider.state.vy).toBe(0);
  });

  it('preserves custom screenRect across moveGlassTo until reset() is called', () => {
    const collider = new GlassCollider();
    const customRect = { x: 10, y: 20, width: 30, height: 40 };
    collider.updateScreenRect(customRect);

    collider.moveGlassTo(300, 180);
    expect(collider.state.screenRect).toEqual(customRect);

    collider.reset();
    expect(collider.state.screenRect.width).toBe(150);
    expect(collider.state.x).toBe(DEFAULT_GLASS_X);
  });

  it('co-translates in-flight falling particles inside capture column when coTranslateFalling is true', () => {
    const collider = new GlassCollider();
    const insideFalling = makeParticle({ state: 'falling', x: 410, y: 200 });
    const outsideXFalling = makeParticle({ state: 'falling', x: 100, y: 200 });
    const belowFloorFalling = makeParticle({ state: 'falling', x: 400, y: 30 });
    const particles = [insideFalling, outsideXFalling, belowFloorFalling];

    collider.moveGlassTo(440, 145, particles, 1 / 60, true);
    expect(insideFalling.x).toBeCloseTo(450, 5);
    expect(outsideXFalling.x).toBe(100);
    expect(belowFloorFalling.x).toBe(400);
  });

  it('spills pooled particles over left and right side walls during high-velocity rim slosh (Step 2) and prioritizes older particles on capacity overflow (Step 3)', () => {
    const collider = new GlassCollider();
    const rimY = collider.rimY; // 235
    const glassX = collider.state.x; // 400

    const leftSlosh = makeParticle({
      state: 'pooled',
      x: glassX - 80,
      y: rimY + 6,
      vx: -250,
      vy: 20,
    });
    const rightSlosh = makeParticle({
      state: 'pooled',
      x: glassX + 80,
      y: rimY + 6,
      vx: 250,
      vy: 20,
    });
    const rimContained = makeParticle({
      state: 'pooled',
      x: glassX,
      y: rimY + 9,
      vx: 0,
      vy: 40,
    });

    let overflowCallbacks = 0;
    collider.resolveCollisions(
      [leftSlosh, rightSlosh, rimContained],
      1 / 60,
      undefined,
      () => {
        overflowCallbacks++;
      },
    );

    expect(leftSlosh.state).toBe('spilled');
    expect(leftSlosh.vx).toBeLessThanOrEqual(-55);
    expect(rightSlosh.state).toBe('spilled');
    expect(rightSlosh.vx).toBeGreaterThanOrEqual(55);
    expect(collider.isOverflowing).toBe(true);
    expect(overflowCallbacks).toBe(2);

    // Rim containment for non-spilled interior particle
    expect(rimContained.state).toBe('pooled');
    expect(rimContained.y).toBe(rimY + 6);
    expect(rimContained.vy).toBeLessThan(0);

    // Step 3: Capacity overflow age priority (age >= 1.5 spilled before age < 1.5) & dead-center tie-breaker
    collider.clearOverflow();
    const cap = GLASS_MAX_CAPACITY_PARTICLES; // 480
    const pool: FluidParticle[] = [];
    for (let i = 0; i < cap; i++) {
      pool.push(
        makeParticle({
          state: 'pooled',
          x: glassX,
          y: 220,
          age: 0.1,
        }),
      );
    }
    const oldA = makeParticle({
      state: 'pooled',
      x: glassX,
      y: 120,
      age: 2.0,
    });
    const oldB = makeParticle({
      state: 'pooled',
      x: glassX,
      y: 120,
      age: 2.0,
    });
    pool.push(oldA, oldB);

    collider.resolveCollisions(pool, 1 / 60);
    expect(oldA.state).toBe('spilled');
    expect(oldB.state).toBe('spilled');
    // Dead-center tie-breaker alternates +1 and -1 sides
    expect(Math.sign(oldA.x - glassX)).toBe(1);
    expect(Math.sign(oldB.x - glassX)).toBe(-1);
  });
});

// ============================================================================
// UT-ADV-04 & U5-5b: ColorMixer updateColors, Scratch Buffer Growth & dt <= 0
// ============================================================================
describe('UT-ADV-04 / U5-5b: ColorMixer updateColors, Scratch Buffer Reallocation (>2048), dt <= 0 & History Filtering (src/physics/colorMixer.ts)', () => {
  it('executes updateColors with explicit and default options and preserves mean color across >2048 particles', () => {
    const mixer = new ColorMixer();
    const hash = new SpatialHash(800, 600, 16.0);

    const particles: FluidParticle[] = [];
    for (let i = 0; i < 2200; i++) {
      const id: DrinkId = i % 2 === 0 ? 'coca-cola' : 'fanta';
      particles.push(
        makeParticle({
          drinkId: id,
          x: 360 + (i % 80),
          y: 70 + Math.floor(i / 80) * 5,
          vx: (i % 5) * 10,
          vy: -5,
        }),
      );
    }
    hash.rebuild(particles);

    const summary1 = mixer.updateColors(particles, hash, {
      isPouring: true,
      glassVx: 120,
      glassVy: -40,
      dt: 1 / 60,
      maxCapacityParticles: 480,
      isOverflowing: true,
    });
    expect(summary1.isOverflowing).toBe(true);
    expect(summary1.pooledParticleCount).toBe(2200);
    expect(summary1.averageColorRGB).toEqual([158, 73, 6]);

    // Default options overload
    const summary2 = mixer.updateColors(particles, hash);
    expect(summary2.mixingVariance).toBeLessThanOrEqual(summary1.mixingVariance);
  });

  it('skips color mutation when dt <= 0 or NaN and filters out zero-count drinks from colorHistory', () => {
    const mixer = new ColorMixer();
    const hash = new SpatialHash(800, 600, 16.0);
    const pCola = makeParticle({ drinkId: 'coca-cola', x: 400, y: 100 });
    const pFanta = makeParticle({ drinkId: 'fanta', x: 404, y: 100 });
    const particles = [pCola, pFanta];
    hash.rebuild(particles);

    const initColaR = pCola.r;
    const summaryZeroDt = mixer.stepAndSummarize(
      particles,
      hash,
      { vx: 0, vy: 0, maxCapacityParticles: 480 },
      false,
      0,
    );
    expect(pCola.r).toBe(initColaR);
    expect(summaryZeroDt.colorHistory).toEqual(['coca-cola', 'fanta']);

    // Mark coca-cola as spilled -> colorHistory filters out coca-cola
    pCola.state = 'spilled';
    const summaryFiltered = mixer.computeSummary(particles, 480);
    expect(summaryFiltered.colorHistory).toEqual(['fanta']);

    mixer.reset();
    expect(mixer.createEmptySummary().colorHistory).toEqual([]);
  });
});

// ============================================================================
// UT-ADV-05 & U5-5b: FluidWorld Selective Stop, Coincident Separation & MAX_PARTICLES
// ============================================================================
describe('UT-ADV-05 / U5-5b: FluidWorld Selective stopPouring, Coincident Separation, Edge Bounce & MAX_PARTICLES Cap (src/physics/fluidWorld.ts)', () => {
  it('handles invalid DrinkId, selective stopPouring(drinkId), and negative/non-finite stepFrames args', () => {
    const world = new FluidWorld();
    world.startPouring('invalid-drink' as DrinkId);
    expect(world.isPouring()).toBe(false);
    expect(world.getActiveDrinks()).toEqual([]);

    world.startPouring('coca-cola');
    world.startPouring('fanta');
    expect(world.isPouring()).toBe(true);
    expect(world.isPouring('coca-cola')).toBe(true);
    expect(world.getActiveDrinks()).toEqual(['coca-cola', 'fanta']);

    world.stopPouring('coca-cola');
    expect(world.isPouring('coca-cola')).toBe(false);
    expect(world.isPouring('fanta')).toBe(true);
    expect(world.getActiveDrinks()).toEqual(['fanta']);

    // Negative frame count is a no-op; invalid dtSeconds falls back to 1/60
    const beforeFrame = world.getFrameCount();
    world.stepFrames(-3);
    expect(world.getFrameCount()).toBe(beforeFrame);

    world.stepFrames(1, -1);
    world.stepFrames(1, NaN);
    world.stepFrames(1, Infinity);
    expect(world.getFrameCount()).toBe(beforeFrame + 3);
  });

  it('separates coincident pooled particles (dist < 1e-4), bounces spilled particles at world X bounds, and co-translates bubbles', () => {
    const world = new FluidWorld();
    const mutableParticles = world.getParticles() as FluidParticle[];

    // Two coincident pooled particles at (400, 100)
    mutableParticles.push(
      makeParticle({ state: 'pooled', x: 400, y: 100, drinkId: 'sprite' }),
      makeParticle({ state: 'pooled', x: 400, y: 100, drinkId: 'sprite' }),
    );
    // Spilled particles outside left (< 10) and right (> 790) world bounds and on drip tray floor with age > 1.8
    mutableParticles.push(
      makeParticle({
        state: 'spilled',
        x: 2,
        y: 15,
        vx: -100,
        vy: -20,
        age: 2.0,
      }),
      makeParticle({
        state: 'spilled',
        x: 798,
        y: 15,
        vx: 100,
        vy: -20,
        age: 2.0,
      }),
    );

    // Add enough pooled carbonated particles to spawn bubbles
    for (let i = 0; i < 10; i++) {
      mutableParticles.push(
        makeParticle({
          state: 'pooled',
          x: 380 + i * 4,
          y: 90,
          drinkId: 'sprite',
        }),
      );
    }

    world.stepFrames(1);

    // Coincident particles separated with finite coordinates
    expect(Number.isFinite(mutableParticles[0].x)).toBe(true);
    expect(Number.isFinite(mutableParticles[1].x)).toBe(true);
    expect(
      Math.hypot(
        mutableParticles[0].x - mutableParticles[1].x,
        mutableParticles[0].y - mutableParticles[1].y,
      ),
    ).toBeGreaterThan(0);

    // Spilled particles bounced inward at x = 10 and x = 790
    const spilledLeft = mutableParticles[2];
    const spilledRight = mutableParticles[3];
    expect(spilledLeft.x).toBeGreaterThanOrEqual(10);
    expect(spilledLeft.vx).toBeGreaterThan(0);
    expect(spilledRight.x).toBeLessThanOrEqual(WORLD_WIDTH - 10);
    expect(spilledRight.vx).toBeLessThan(0);

    // Bubble co-translation on moveGlassTo
    const bubbles = world.getBubbles();
    expect(bubbles.length).toBeGreaterThan(0);
    const prevBubbleX = bubbles[0].x;
    world.moveGlassTo(450, 160);
    expect(bubbles[0].x).toBeCloseTo(prevBubbleX + 50, 4);
  });

  it('enforces MAX_PARTICLES (1800) safety cap by pruning oldest spilled particles during sustained 5-nozzle deluge', () => {
    const world = new FluidWorld();
    world.moveGlassTo(120, 145);
    for (const id of DRINK_IDS) {
      world.startPouring(id);
    }
    // 5 nozzles * 3 particles/frame = 15 particles/frame -> 130 frames = 1950 particles (< 144 frames natural drain)
    world.stepFrames(130);
    const snap = world.getSnapshot();
    expect(snap.totalParticleCount).toBeLessThanOrEqual(1800);
    expect(snap.spilledParticleCount).toBeGreaterThan(1000);
  });
});

// ============================================================================
// Suite U5-1: Shader Compilation, Linking & Rollback Adversarial Tests
// ============================================================================
describe('Suite U5-1: Shader Compilation, Linking & Rollback Adversarial Tests (src/webgl/shaders.ts)', () => {
  it('U5-1a: returns WebGL2 sources by default in getShaderSource/getShaderSources and throws on unknown pass', () => {
    const src = getShaderSource('sceneMesh');
    expect(src.vertexSource).toContain('#version 300 es');

    const allSources = getShaderSources();
    expect(allSources.fluidResolve.fragmentSource).toContain('#version 300 es');

    expect(() => getShaderSource('nonExistentPass' as ShaderPassName)).toThrow(
      /Unknown shader pass: nonExistentPass/,
    );
  });

  it('U5-1b: handles createShader null failure and empty shader infoLog fallback in compileShader', () => {
    const glNullShader = createLightweightStubGL({
      createShader: () => null,
    });
    expect(() =>
      compileShader(
        glNullShader,
        glNullShader.VERTEX_SHADER,
        'void main(){}',
        'myVert',
      ),
    ).toThrow(/Failed to allocate WebGLShader for myVert/);

    const glCompileFail = createLightweightStubGL({
      getShaderParameter: () => false,
      getShaderInfoLog: () => '',
    });
    expect(() =>
      compileShader(
        glCompileFail,
        glCompileFail.FRAGMENT_SHADER,
        'bad code',
        'customLabel',
      ),
    ).toThrow(
      /Shader compilation failed \(customLabel\): Unknown shader compile error/,
    );
    expect(
      (glCompileFail as unknown as { __deletedShaders: object[] })
        .__deletedShaders.length,
    ).toBe(1);
  });

  it('U5-1c: cleans up shaders on fragment compile failure, createProgram null, link failure, and falls back on -1 attrib location', () => {
    const pair = getShaderSource('sceneMesh', 2);

    // 1. Fragment compile failure deletes already-compiled vertexShader
    let shaderCall = 0;
    const glFragFail = createLightweightStubGL({
      getShaderParameter: () => {
        shaderCall++;
        return shaderCall === 1; // vertex succeeds, fragment fails
      },
      getShaderInfoLog: () => 'frag syntax err',
    });
    expect(() => createShaderProgram(glFragFail, 'sceneMesh', pair)).toThrow(
      /Shader compilation failed \(sceneMesh:fragment\): frag syntax err/,
    );
    expect(
      (glFragFail as unknown as { __deletedShaders: object[] }).__deletedShaders
        .length,
    ).toBe(2);

    // 2. createProgram returning null deletes both shaders and throws
    const glNullProg = createLightweightStubGL({
      createProgram: () => null,
    });
    expect(() => createShaderProgram(glNullProg, 'sceneMesh', pair)).toThrow(
      /Failed to allocate WebGLProgram for sceneMesh/,
    );
    expect(
      (glNullProg as unknown as { __deletedShaders: object[] }).__deletedShaders
        .length,
    ).toBe(2);

    // 3. Link failure with null infoLog deletes program + both shaders and uses fallback message
    const glLinkFail = createLightweightStubGL({
      getProgramParameter: () => false,
      getProgramInfoLog: () => null,
    });
    expect(() => createShaderProgram(glLinkFail, 'sceneMesh', pair)).toThrow(
      /Shader program link failed \(sceneMesh\): Unknown program link error/,
    );
    expect(
      (glLinkFail as unknown as { __deletedPrograms: object[] })
        .__deletedPrograms.length,
    ).toBe(1);
    expect(
      (glLinkFail as unknown as { __deletedShaders: object[] }).__deletedShaders
        .length,
    ).toBe(2);

    // 4. getAttribLocation returning -1 falls back to declaration index i
    const glNegLoc = createLightweightStubGL({
      getAttribLocation: () => -1,
    });
    const compiled = createShaderProgram(glNegLoc, 'sceneMesh', pair);
    expect(compiled.attributes.a_position).toBe(0);
    expect(compiled.attributes.a_color).toBe(1);
  });

  it('U5-1d: rolls back already-compiled programs when createAllShaderPrograms fails mid-bundle', () => {
    let linkCount = 0;
    const glMidFail = createLightweightStubGL({
      getProgramParameter: () => {
        linkCount++;
        return linkCount < 3; // Fail on 3rd pass (fluidResolve)
      },
      getProgramInfoLog: () => 'resolve link fail',
    });

    expect(() => createAllShaderPrograms(glMidFail, 2)).toThrow(
      /Shader program link failed \(fluidResolve\): resolve link fail/,
    );
    // 2 previously compiled programs (sceneMesh, fluidSplat) + 1 failed program (fluidResolve) = 3 deleted programs
    expect(
      (glMidFail as unknown as { __deletedPrograms: object[] })
        .__deletedPrograms.length,
    ).toBe(3);

    // Sparse map destroyShaderPrograms is safe on empty object
    destroyShaderPrograms(glMidFail, {});
  });
});

// ============================================================================
// Suite U5-2: Offscreen FBO Allocation, WebGL1 Half-Float & Error Rollbacks
// ============================================================================
describe('Suite U5-2: Offscreen FBO Allocation, WebGL1 Half-Float & Error Rollback Tests (src/webgl/fbo.ts)', () => {
  it('U5-2a: detects WebGL2 via instanceof WebGL2RenderingContext and texStorage2D probe', () => {
    const glWithTexStorage = { texStorage2D: () => {} } as unknown as WebGL2RenderingContext;
    expect(detectWebGLVersion(glWithTexStorage)).toBe(2);

    class FakeWebGL2RenderingContext {}
    vi.stubGlobal('WebGL2RenderingContext', FakeWebGL2RenderingContext);
    try {
      const inst = new FakeWebGL2RenderingContext() as unknown as WebGL2RenderingContext;
      expect(detectWebGLVersion(inst)).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }

    const gl1 = {} as unknown as WebGLRenderingContext;
    expect(detectWebGLVersion(gl1)).toBe(1);
  });

  it('U5-2b: allocates WebGL1 half-float FBO with NEAREST and LINEAR filters and GL_HALF_FLOAT_OES fallback', () => {
    // 1. WebGL1 half-float with OES_texture_half_float_linear = null -> NEAREST filter
    const gl1Nearest = createLightweightStubGL({
      RGBA16F: undefined,
      HALF_FLOAT: undefined,
      getExtension: (name: string) => {
        if (name === 'OES_texture_half_float') return { HALF_FLOAT_OES: 0x8d61 };
        if (name === 'EXT_color_buffer_half_float') return {};
        return null;
      },
    });
    const fbo1 = createFluidFBO(gl1Nearest, 400, 300, { webglVersion: 1 });
    expect(fbo1.isFloat).toBe(true);
    expect(fbo1.type).toBe(0x8d61);
    expect(fbo1.splatScale).toBe(FLOAT_SPLAT_SCALE);
    expect(fbo1.isoThreshold).toBe(FLOAT_ISO_THRESHOLD);
    const params1 = (
      gl1Nearest as unknown as {
        __texParams: Array<{ pname: number; param: number }>;
      }
    ).__texParams;
    expect(params1.some((p) => p.param === gl1Nearest.NEAREST)).toBe(true);

    // 2. WebGL1 half-float omitting HALF_FLOAT_OES property + linear extension present -> LINEAR filter
    const gl1Linear = createLightweightStubGL({
      RGBA16F: undefined,
      HALF_FLOAT: undefined,
      getExtension: (name: string) => {
        if (name === 'OES_texture_half_float') return {};
        if (name === 'EXT_color_buffer_half_float') return {};
        if (name === 'OES_texture_half_float_linear') return {};
        return null;
      },
    });
    const fbo2 = createFluidFBO(gl1Linear, 400, 300, { webglVersion: 1 });
    expect(fbo2.isFloat).toBe(true);
    expect(fbo2.type).toBe(0x8d61);
    const params2 = (
      gl1Linear as unknown as {
        __texParams: Array<{ pname: number; param: number }>;
      }
    ).__texParams;
    expect(params2.some((p) => p.param === gl1Linear.LINEAR)).toBe(true);
  });

  it('U5-2c: allocates WebGL2 half-float FBO via EXT_color_buffer_half_float and constant fallbacks', () => {
    const gl2HalfFloat = createLightweightStubGL({
      RGBA16F: undefined,
      HALF_FLOAT: undefined,
      getExtension: (name: string) => {
        if (name === 'EXT_color_buffer_float') return null;
        if (name === 'EXT_color_buffer_half_float') return {};
        return null;
      },
    });
    const fbo = createFluidFBO(gl2HalfFloat, 512, 256, { webglVersion: 2 });
    expect(fbo.isFloat).toBe(true);
    expect(fbo.internalFormat).toBe(0x881a);
    expect(fbo.type).toBe(0x140b);
  });

  it('U5-2d: rolls back failed float FBO probes (texImage2D throw, getError non-zero, incomplete status) and throws when both modes fail', () => {
    // (a) texImage2D throws on float type -> rolls back and succeeds on RGBA8
    const glTexThrow = createLightweightStubGL({
      texImage2D: (
        _target: number,
        _level: number,
        _internalFormat: number,
        _w: number,
        _h: number,
        _border: number,
        _format: number,
        type: number,
      ) => {
        if (type !== 0x1401) {
          throw new Error('Float texture unsupported');
        }
      },
    });
    const fboFromThrow = createFluidFBO(glTexThrow, 320, 240);
    expect(fboFromThrow.isFloat).toBe(false);
    expect(fboFromThrow.splatScale).toBe(RGBA8_SPLAT_SCALE);
    expect(fboFromThrow.isoThreshold).toBe(RGBA8_ISO_THRESHOLD);

    // (b) gl.getError() returns non-zero after float texImage2D -> rolls back to RGBA8
    let getErrorCalls = 0;
    const glErrorAfterTex = createLightweightStubGL({
      getError: () => {
        getErrorCalls++;
        // Call 1 clears error prior to float probe; Call 2 checks error after float texImage2D
        return getErrorCalls === 2 ? 0x0502 : 0;
      },
    });
    const fboFromGlErr = createFluidFBO(glErrorAfterTex, 320, 240);
    expect(fboFromGlErr.isFloat).toBe(false);

    // (c) checkFramebufferStatus returns incomplete on float -> rolls back to RGBA8
    let statusCalls = 0;
    const glIncompleteFloat = createLightweightStubGL({
      checkFramebufferStatus: () => {
        statusCalls++;
        return statusCalls === 1 ? 0x8cd6 : 0x8cd5;
      },
    });
    const fboFromStatus = createFluidFBO(glIncompleteFloat, 320, 240);
    expect(fboFromStatus.isFloat).toBe(false);

    // (d) createFramebuffer returns null -> deletes texture and throws total failure
    const glNoFbo = createLightweightStubGL({
      createFramebuffer: () => null,
    });
    expect(() => createFluidFBO(glNoFbo, 320, 240)).toThrow(
      /Failed to allocate offscreen FluidFBO \(320x240\) in both RGBA16F and RGBA8 modes/,
    );
    expect(
      (glNoFbo as unknown as { __deletedTextures: object[] }).__deletedTextures
        .length,
    ).toBeGreaterThanOrEqual(2);

    // (e) createTexture returns null -> throws total failure
    const glNoTex = createLightweightStubGL({
      createTexture: () => null,
    });
    expect(() => createFluidFBO(glNoTex, 320, 240)).toThrow(
      /Failed to allocate offscreen FluidFBO/,
    );
  });

  it('U5-2e: clamps invalid dimensions, handles null FBO in resizeFluidFBO/destroyFluidFBO, and exposes FluidFBOManager getters', () => {
    const gl = createLightweightStubGL();
    const fboClamped = createFluidFBO(gl, -50, 0);
    expect(fboClamped.width).toBe(1);
    expect(fboClamped.height).toBe(1);

    const fboDefault = createFluidFBO(gl, NaN, Infinity);
    expect(fboDefault.width).toBe(800);
    expect(fboDefault.height).toBe(600);

    const allocatedFromNull = resizeFluidFBO(gl, null, 400, 300);
    expect(allocatedFromNull.width).toBe(400);
    expect(allocatedFromNull.height).toBe(300);

    // Same size returns identical FBO instance
    expect(resizeFluidFBO(gl, allocatedFromNull, 400, 300)).toBe(
      allocatedFromNull,
    );

    // Safe no-ops on null/undefined
    destroyFluidFBO(gl, null);
    destroyFluidFBO(gl, undefined);

    const manager = new FluidFBOManager(gl, 400, 300);
    expect(manager.width).toBe(400);
    expect(manager.height).toBe(300);
    expect(manager.isFloat).toBe(true);
    expect(manager.splatScale).toBe(FLOAT_SPLAT_SCALE);
    expect(manager.isoThreshold).toBe(FLOAT_ISO_THRESHOLD);
    manager.bind();
    manager.unbind(); // without viewport args
    manager.dispose();
  });
});

// ============================================================================
// Suite U5-3: Procedural Meshes & 5-Pass Renderer Edge Cases
// ============================================================================
describe('Suite U5-3: Procedural Meshes & 5-Pass Renderer Edge Cases (src/webgl/meshes.ts & src/webgl/renderer.ts)', () => {
  it('U5-3a: covers mesh builder boundary & fallback branches', () => {
    // Non-positive world dimensions fallback to 800x600
    expect(worldToNDC(400, 300, 0, -10)).toEqual([0, 0]);
    expect(ndcToWorld(0, 0, 0, -10)).toEqual([400, 300]);

    const world = new FluidWorld();
    const glass = world.getGlassState();
    const emptyLiquid = world.getLiquidSummary();

    // computePoolTopY when empty returns bottomY + 4.5
    expect(computePoolTopY(glass, emptyLiquid)).toBeCloseTo(55 + 4.5, 5);

    // buildHydrostaticLiquidMesh with shallow glass (poolTopY <= liquidFloorY + 0.5)
    const shallowGlass = { ...glass, worldHeight: 4 };
    const nonEmptyLiquid = {
      ...emptyLiquid,
      pooledParticleCount: 10,
      fillLevel: 0.5,
    };
    expect(
      buildHydrostaticLiquidMesh(shallowGlass, nonEmptyLiquid).length,
    ).toBe(0);

    // buildSceneStaticMesh: (1) active with 0 falling particles, (2) inactive with in-flight falling particles, (3) degenerate ribbon skip
    const meshActiveNoFalling = buildSceneStaticMesh(['coca-cola'], []);
    expect(meshActiveNoFalling.length).toBeGreaterThan(0);

    const meshInactiveWithFalling = buildSceneStaticMesh(
      [],
      [makeParticle({ drinkId: 'fanta', state: 'falling', x: 380, y: 300 })],
    );
    expect(meshInactiveWithFalling.length).toBeGreaterThan(0);

    const meshDegenerateStream = buildSceneStaticMesh(
      [],
      [makeParticle({ drinkId: 'sprite', state: 'falling', x: 400, y: 34 })],
    );
    expect(meshDegenerateStream.length).toBeGreaterThan(0);

    // buildFluidSplatBuffer: spilled particle (stateCode=2.0, radius=10.5), low-alpha skip, omitted glass/liquid, active nozzle with foundFalling=false
    const splats = buildFluidSplatBuffer(
      [
        makeParticle({ state: 'spilled', x: 250, y: 30, a: 0.8 }),
        makeParticle({ state: 'pooled', x: 400, y: 100, a: 0.005 }), // skipped
      ],
      ['cherry'], // active nozzle with no falling cherry particles
    );
    expect(splats.length).toBe(FLUID_SPLAT_FLOATS);
    expect(splats[6]).toBeCloseTo(10.5, 5); // radius
    expect(splats[7]).toBeCloseTo(2.0, 5); // stateCode

    // buildBubbleFoamBuffer: omitted glass arg, faint/tiny skip, left & right readback-window deflection
    const bubbles: BubbleParticle[] = [
      { x: 400, y: 90, vx: 0, vy: 10, radius: 2.0, alpha: 0.01, isFoam: false }, // skipped (alpha <= 0.02)
      { x: 400, y: 90, vx: 0, vy: 10, radius: 0.05, alpha: 0.8, isFoam: false }, // skipped (radius <= 0.1)
      { x: 395, y: 90, vx: 0, vy: 10, radius: 2.5, alpha: 0.7, isFoam: false }, // deflected left to 380
      { x: 405, y: 90, vx: 0, vy: 10, radius: 2.5, alpha: 0.7, isFoam: false }, // deflected right to 420
    ];
    const bubbleVerts = buildBubbleFoamBuffer(bubbles);
    expect(bubbleVerts.length).toBe(2 * BUBBLE_FOAM_FLOATS);
    expect(bubbleVerts[0]).toBe(380);
    expect(bubbleVerts[BUBBLE_FOAM_FLOATS]).toBe(420);
  });

  it('U5-3b: evaluates all scene geometry branches in evaluateScenePixelAtWorld', () => {
    // state === null
    expect(evaluateScenePixelAtWorld(100, 300, null)).toEqual([
      STUDIO_BG_RGB255[0],
      STUDIO_BG_RGB255[1],
      STUDIO_BG_RGB255[2],
      255,
    ]);

    // Drip tray body (y <= 38) and grate lip (38 < y <= 45)
    expect(evaluateScenePixelAtWorld(400, 20, null)).toEqual([30, 36, 48, 255]);
    expect(evaluateScenePixelAtWorld(400, 42, null)).toEqual([56, 64, 80, 255]);

    // Dispenser lower manifold (492 <= y < 504, outside nozzle sleeves) and main housing (y >= 504)
    expect(evaluateScenePixelAtWorld(250, 498, null)).toEqual([48, 55, 68, 255]);
    expect(evaluateScenePixelAtWorld(400, 540, null)).toEqual([
      DISPENSER_HEADER_RGB255[0],
      DISPENSER_HEADER_RGB255[1],
      DISPENSER_HEADER_RGB255[2],
      255,
    ]);

    // Active vs inactive nozzle at (380, 490) (Fanta) and initial stream ribbon at (380, 470)
    const world = new FluidWorld();
    const inactiveNozzlePx = evaluateScenePixelAtWorld(
      380,
      490,
      world.getRenderState(),
    );
    world.startPouring('fanta');
    const activeState = world.getRenderState();
    const activeNozzlePx = evaluateScenePixelAtWorld(380, 490, activeState);
    expect(activeNozzlePx[1]).toBe(Math.min(255, inactiveNozzlePx[1] + 40));

    // Active stream stub when fallingCount === 0 at (380, 470)
    expect(evaluateScenePixelAtWorld(380, 470, activeState)).toEqual([
      255, 125, 0, 255,
    ]);

    // Proximity to individual spilled particle
    const stateWithSpilled = {
      ...activeState,
      particles: [
        makeParticle({
          state: 'spilled',
          drinkId: 'berry-blue',
          x: 200,
          y: 200,
        }),
      ],
    };
    const spilledPx = evaluateScenePixelAtWorld(203, 203, stateWithSpilled);
    expect(spilledPx[2]).toBe(255);

    // Left and right tapered glass walls at y = 145 (halfW = 65, wall in [65, 72])
    const wallPx = evaluateScenePixelAtWorld(400 + 68, 145, activeState);
    expect(wallPx[2]).toBeGreaterThan(STUDIO_BG_RGB255[2] + 100);
  });

  it('U5-3c: covers SodaFountainRenderer context fallbacks, SimulationSnapshot input, DPR clamping, readPixels throw fallback, and dispose idempotency', () => {
    // 1. experimental-webgl fallback when webgl2 and webgl return null
    const expCanvas = document.createElement('canvas');
    const stubGl1 = createLightweightStubGL({
      RGBA16F: undefined,
      HALF_FLOAT: undefined,
    });
    expCanvas.getContext = ((contextId: string) => {
      if (contextId === 'experimental-webgl') return stubGl1;
      return null;
    }) as unknown as HTMLCanvasElement['getContext'];

    const expRenderer = new SodaFountainRenderer(expCanvas);
    expect(expRenderer.webglVersion).toBe(1);
    expect(expRenderer.currentFBO.width).toBeGreaterThan(0);
    expRenderer.dispose();

    // 2. All getContext calls returning null throws
    const failCanvas = document.createElement('canvas');
    failCanvas.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
    expect(() => new SodaFountainRenderer(failCanvas)).toThrow(
      /Unable to initialize WebGL2 or WebGL1 context/,
    );

    // 3. gl.createBuffer returning null throws
    const noBufCanvas = document.createElement('canvas');
    expect(
      () =>
        new SodaFountainRenderer(noBufCanvas, {
          gl: createLightweightStubGL({ createBuffer: () => null }),
        }),
    ).toThrow(/Failed to allocate WebGLBuffer/);

    // 4. Render with SimulationSnapshot input (empty particles/bubbles skips Passes 2, 3, 4; activeNozzles exercises computeFoamColor branch)
    const canvas = document.createElement('canvas');
    const gl = createLightweightStubGL({
      readPixels: () => {
        throw new Error('Synthetic readPixels error');
      },
    });
    const renderer = new SodaFountainRenderer(canvas, { gl });
    const world = new FluidWorld();
    world.startPouring('cherry');
    const snap: SimulationSnapshot = world.getSnapshot();
    renderer.render(snap);

    // Mutate canvas.width externally to trigger auto-resize inside render()
    canvas.width = 640;
    canvas.height = 480;
    (gl as unknown as { drawingBufferWidth: number }).drawingBufferWidth = 640;
    (gl as unknown as { drawingBufferHeight: number }).drawingBufferHeight = 480;
    renderer.render(world);
    expect(renderer.currentFBO.width).toBe(640);

    // resize() with no args and extreme DPR values (0.25, 4.0, NaN)
    renderer.resize(500, 400, 0.25);
    expect(canvas.width).toBe(500);
    renderer.resize(500, 400, 4.0);
    expect(canvas.width).toBe(1000);
    renderer.resize(undefined, undefined, NaN);

    // readPixels throwing falls back cleanly to evaluateScenePixelAtWorld
    const fallbackPx = renderer.samplePixelAtWorld(400, 540);
    expect(fallbackPx).toEqual([
      DISPENSER_HEADER_RGB255[0],
      DISPENSER_HEADER_RGB255[1],
      DISPENSER_HEADER_RGB255[2],
      255,
    ]);

    // sampleGlassLiquidPixel when empty vs populated
    const emptyGlassPx = renderer.sampleGlassLiquidPixel(world.getSnapshot());
    expect(emptyGlassPx[3]).toBe(255);

    // Post-dispose idempotency
    renderer.dispose();
    renderer.dispose();
    renderer.render(world);
  });
});

// ============================================================================
// UT-ADV-06 & Suite U5-4: UI Controls, Reference Counting, Standalone Mouse/Touch & App Lifecycle
// ============================================================================
describe('UT-ADV-06 / Suite U5-4: UI Controls, Multi-Source Reference Counting, Standalone Mouse/Touch & App Lifecycle (src/ui/controls.ts & src/main.ts)', () => {
  let app: SodaFountainApp | null = null;

  afterEach(() => {
    if (app) {
      app.dispose();
      app = null;
    }
    document.body.innerHTML = '';
  });

  it('U5-4a: handles NaN/Infinity in coordinate helpers, ensureFountainDOM idempotency, setReady/setWebGLVersion, and selective stopPouring(drinkId)', () => {
    document.body.innerHTML = '';
    const dom1 = ensureFountainDOM(document);
    const dom2 = ensureFountainDOM(document);
    expect(dom1.canvas).toBe(dom2.canvas);
    expect(dom2.drinkButtons.size).toBe(5);

    // Zero-size getBoundingClientRect falls back to canvas.width / WORLD_WIDTH
    dom1.canvas.width = 800;
    dom1.canvas.height = 600;
    dom1.canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      }) as DOMRect;

    const coords = clientToWorldCoords(dom1.canvas, NaN, Infinity);
    expect(coords.worldX).toBeCloseTo(400, 5);
    expect(coords.worldY).toBeCloseTo(300, 5);

    const clamped = clampWorldGlassCoords(NaN, Infinity);
    expect(clamped.worldX).toBeCloseTo(400, 5);
    expect(clamped.worldY).toBeCloseTo(237.5, 5);

    app = initSodaFountainApp({
      doc: document,
      win: window,
      autoStartLoop: false,
    });
    app.controls.setReady(false);
    expect(app.controls.dom.canvas.getAttribute('data-ready')).toBe('false');
    app.controls.setWebGLVersion(1);
    expect(app.controls.dom.canvas.getAttribute('data-webgl-version')).toBe('1');

    // Selective programmatic stopPouring(drinkId) and invalid DrinkId guards
    const sim = window.__SODA_SIM__!;
    sim.startPouring('invalid' as DrinkId);
    expect(sim.activeDrinks).toEqual([]);

    sim.startPouring('coca-cola');
    sim.startPouring('fanta');
    expect(sim.activeDrinks).toEqual(['coca-cola', 'fanta']);

    sim.stopPouring('invalid' as DrinkId);
    expect(sim.activeDrinks).toEqual(['coca-cola', 'fanta']);

    sim.stopPouring('coca-cola');
    expect(sim.activeDrinks).toEqual(['fanta']);
    expect(
      app.controls.dom.drinkButtons.get('coca-cola')!.getAttribute('data-active'),
    ).toBe('false');
    expect(
      app.controls.dom.drinkButtons.get('fanta')!.getAttribute('data-active'),
    ).toBe('true');
  });

  it('U5-4b: enforces multi-source hold reference counting (isDrinkStillHeld), rejects right-click & modifier keys, and supports shifted Digit code fallback', () => {
    document.body.innerHTML = '';
    app = initSodaFountainApp({
      doc: document,
      win: window,
      autoStartLoop: false,
    });
    const sim = window.__SODA_SIM__!;
    const colaBtn = app.controls.dom.drinkButtons.get('coca-cola')!;
    const canvas = app.controls.dom.canvas;

    // 1. Hold coca-cola simultaneously via Pointer 1 + Keyboard '1' + API startPouring
    const pDown = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(pDown, 'pointerId', { value: 1 });
    colaBtn.dispatchEvent(pDown);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true }),
    );
    sim.startPouring('coca-cola');
    expect(sim.activeDrinks).toEqual(['coca-cola']);

    // Release Pointer 1 -> still held by Keyboard '1' and API
    const pUp = new MouseEvent('pointerup', { bubbles: true, button: 0 });
    Object.defineProperty(pUp, 'pointerId', { value: 1 });
    colaBtn.dispatchEvent(pUp);
    expect(sim.activeDrinks).toEqual(['coca-cola']);

    // Release Keyboard '1' -> still held by API
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '1', code: 'Digit1', bubbles: true }),
    );
    expect(sim.activeDrinks).toEqual(['coca-cola']);

    // Stop via API -> now stops completely
    sim.stopPouring('coca-cola');
    expect(sim.activeDrinks).toEqual([]);

    // 2. Hold via Pointer 2 + Keyboard '1', release Keyboard '1' first -> stays active until Pointer 2 releases
    const pDown2 = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(pDown2, 'pointerId', { value: 2 });
    colaBtn.dispatchEvent(pDown2);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '1', code: 'Digit1', bubbles: true }),
    );
    expect(sim.activeDrinks).toEqual(['coca-cola']);
    const pUp2 = new MouseEvent('pointerup', { bubbles: true, button: 0 });
    Object.defineProperty(pUp2, 'pointerId', { value: 2 });
    colaBtn.dispatchEvent(pUp2);
    expect(sim.activeDrinks).toEqual([]);

    // 3. Right-click (button: 2) on button and canvas, and modifier keys (ctrl/alt/meta) are ignored
    colaBtn.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 2 }),
    );
    colaBtn.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 2 }),
    );
    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 2 }),
    );
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 2 }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '2', altKey: true, bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }),
    );
    expect(sim.activeDrinks).toEqual([]);
    expect(sim.glass.isDragging).toBe(false);

    // 4. Shifted Digit1 ('!', code: 'Digit1') fallback
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '!', code: 'Digit1', bubbles: true }),
    );
    expect(sim.activeDrinks).toEqual(['coca-cola']);
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '!', code: 'Digit1', bubbles: true }),
    );
    expect(sim.activeDrinks).toEqual([]);
  });

  it('U5-4c: supports standalone MouseEvent and TouchEvent fallbacks (without PointerEvent) and standalone FountainControls reset click', () => {
    document.body.innerHTML = '';
    const dom = ensureFountainDOM(document);
    dom.canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const world = new FluidWorld();
    const standaloneControls = new FountainControls({
      world,
      doc: document,
      win: window,
    });

    const fantaBtn = standaloneControls.dom.drinkButtons.get('fanta')!;
    const spriteBtn = standaloneControls.dom.drinkButtons.get('sprite')!;
    const cherryBtn = standaloneControls.dom.drinkButtons.get('cherry')!;
    const canvas = standaloneControls.dom.canvas;

    // 1. Standalone mousedown / mouseup on drink button
    fantaBtn.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
    expect(world.getActiveDrinks()).toEqual(['fanta']);
    fantaBtn.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0 }),
    );
    expect(world.getActiveDrinks()).toEqual([]);

    // 2. Standalone touchstart with empty changedTouches fallback + touchend with empty changedTouches
    const emptyTouchStart = new Event('touchstart', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(emptyTouchStart, 'changedTouches', { value: [] });
    spriteBtn.dispatchEvent(emptyTouchStart);
    expect(world.getActiveDrinks()).toEqual(['sprite']);

    const emptyTouchEnd = new Event('touchend', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(emptyTouchEnd, 'changedTouches', { value: [] });
    spriteBtn.dispatchEvent(emptyTouchEnd);
    expect(world.getActiveDrinks()).toEqual([]);

    // 3. Multi-touch standalone touchstart (id 7 on sprite, id 8 on cherry) + selective touchcancel on id 7
    const ts7 = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(ts7, 'changedTouches', {
      value: [{ identifier: 7, target: spriteBtn, clientX: 10, clientY: 10 }],
    });
    spriteBtn.dispatchEvent(ts7);

    const ts8 = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(ts8, 'changedTouches', {
      value: [{ identifier: 8, target: cherryBtn, clientX: 20, clientY: 10 }],
    });
    cherryBtn.dispatchEvent(ts8);
    expect(world.getActiveDrinks()).toEqual(['sprite', 'cherry']);

    const tc7 = new Event('touchcancel', { bubbles: true, cancelable: true });
    Object.defineProperty(tc7, 'changedTouches', {
      value: [{ identifier: 7, target: spriteBtn, clientX: 10, clientY: 10 }],
    });
    window.dispatchEvent(tc7);
    expect(world.getActiveDrinks()).toEqual(['cherry']);

    // Empty changedTouches on touchcancel cancels all remaining holds
    const tcAll = new Event('touchcancel', { bubbles: true, cancelable: true });
    Object.defineProperty(tcAll, 'changedTouches', { value: [] });
    window.dispatchEvent(tcAll);
    expect(world.getActiveDrinks()).toEqual([]);

    // 4. Standalone mouse drag & standalone touch drag on canvas
    canvas.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 400,
        clientY: 455,
      }),
    );
    window.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 520,
        clientY: 455,
      }),
    );
    expect(world.getGlassState().x).toBeCloseTo(520, 1);
    window.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 520,
        clientY: 455,
      }),
    );
    expect(world.getGlassState().isDragging).toBe(false);

    const canvasTs = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(canvasTs, 'changedTouches', {
      value: [{ identifier: 9, target: canvas, clientX: 520, clientY: 455 }],
    });
    canvas.dispatchEvent(canvasTs);
    const canvasTm = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(canvasTm, 'changedTouches', {
      value: [{ identifier: 9, target: canvas, clientX: 300, clientY: 455 }],
    });
    window.dispatchEvent(canvasTm);
    expect(world.getGlassState().x).toBeCloseTo(300, 1);
    const canvasTe = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(canvasTe, 'changedTouches', {
      value: [{ identifier: 9, target: canvas, clientX: 300, clientY: 455 }],
    });
    window.dispatchEvent(canvasTe);
    expect(world.getGlassState().isDragging).toBe(false);

    // 5. Fallback reset handler when onResetRequested is not supplied
    standaloneControls.dom.resetButton.click();
    expect(world.getGlassState().x).toBe(DEFAULT_GLASS_X);
    standaloneControls.dispose();
  });

  it('U5-4d: flushes deferred renderDirty on samplePixelAtWorld / sampleGlassLiquidPixel in manualStepMode and auto-disposes prior app instance', () => {
    document.body.innerHTML = '';
    const app1 = initSodaFountainApp({
      doc: document,
      win: window,
      autoStartLoop: false,
    });
    expect(app1.api.isReady).toBe(true);

    // Re-initializing auto-disposes app1
    app = initSodaFountainApp({
      doc: document,
      win: window,
      autoStartLoop: false,
    });
    expect(app1.api.isReady).toBe(false);
    expect(app.api.isReady).toBe(true);

    const sim = app.api;
    const renderSpy = vi.spyOn(app.renderer, 'render');

    // Enter manualStepMode
    sim.stepFrames(1);
    renderSpy.mockClear();

    // Trigger onRenderRequested in manualStepMode via startPouring -> sets renderDirty = true without rendering yet
    sim.startPouring('fanta');
    expect(renderSpy).not.toHaveBeenCalled();

    // Calling samplePixelAtWorld flushes renderDirty lazily
    const px = sim.samplePixelAtWorld(380, 490);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(px[0]).toBe(255);

    // Trigger renderDirty again via stopPouring and flush via sampleGlassLiquidPixel
    sim.stopPouring('fanta');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const glassPx = sim.sampleGlassLiquidPixel();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(glassPx[3]).toBe(255);

    // Direct coverage of createHeadlessStubGL methods (WB-18)
    const stubGl = app.renderer.gl;
    expect(stubGl.getParameter(0x1f02)).toContain('WebGL 2.0');
    expect(stubGl.getParameter(0x9999)).toBe(0);
    expect(stubGl.isContextLost()).toBe(false);
    expect(stubGl.getShaderInfoLog({} as WebGLShader)).toBe('');
    expect(stubGl.getProgramInfoLog({} as WebGLProgram)).toBe('');
    expect(stubGl.getAttribLocation({} as WebGLProgram, 'non_existent')).toBe(0);
    stubGl.uniform4f(null, 1, 2, 3, 4);

    // Test non-jsdom try/catch fallback when getContext returns null without rendererOptions.gl,
    // and rethrow when rendererOptions.gl fails
    const origUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0',
      configurable: true,
    });
    try {
      const dom = ensureFountainDOM(document);
      dom.canvas.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
      app = initSodaFountainApp({
        doc: document,
        win: window,
        autoStartLoop: false,
      });
      expect(app.api.isReady).toBe(true);

      // Explicit broken gl in rendererOptions rethrows
      expect(() =>
        initSodaFountainApp({
          doc: document,
          win: window,
          autoStartLoop: false,
          rendererOptions: {
            gl: createLightweightStubGL({ createBuffer: () => null }),
          },
        }),
      ).toThrow(/Failed to allocate WebGLBuffer/);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: origUserAgent,
        configurable: true,
      });
    }
  });
});
