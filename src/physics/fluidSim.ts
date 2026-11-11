import { absorptionToDisplayHex, DRINK_MAP, DRINKS } from '../drinks';
import {
  COUNTER_TOP_Y,
  DrinkId,
  GLASS_BASE_THICKNESS,
  GLASS_BOTTOM_HALF_W,
  GLASS_FULL_PARTICLES,
  GLASS_INNER_HEIGHT,
  GLASS_MAX_X,
  GLASS_MAX_Y,
  GLASS_MIN_X,
  GLASS_MIN_Y,
  GLASS_TOP_HALF_W,
  GLASS_WALL_THICKNESS,
  GlassMixSummary,
  GlassState,
  KERNEL_RADIUS,
  MAX_BUBBLES,
  MAX_PARTICLES,
  NOZZLE_TIP_Y,
  PARTICLE_RADIUS,
  SimulationSnapshot,
  TRAY_LEFT_X,
  TRAY_RIGHT_X,
  TRAY_SURFACE_Y,
  WORLD_H,
  WORLD_W,
} from '../types';
import { SpatialHash } from './spatialHash';

const SUBSTEPS = 4;
const DEFAULT_DT = 1 / 60;
const MAX_DT = 1 / 30;

// Double-Density Relaxation (Clavet et al. 2005) + XSPH & pool damping parameters
const GRAVITY = -2150;
const TERMINAL_FALL_SOFT_VY = -665;
const TERMINAL_FALL_CAP_SPAN = 15; // Asymptotes smoothly to -680 wu/s (vy >= -680)
const REST_DENSITY = 3.14;
const K_STIFFNESS = 215;
const K_NEAR = 520;
const MIN_PRESSURE = -6;
const XSPH_FACTOR = 0.14;
const POOL_DAMP_RATE = 1.6;
const MAX_CONSTRAINT_DV = 260;
const MAX_PARTICLE_SPEED = 1250;

// Glass spring, cup-frame co-advection & thick capsule collision constants
const GLASS_SPRING_OMEGA = 28;
const MAX_GLASS_SPEED = 1050;
const CO_ADVECT_X = 0.78;
const CO_ADVECT_Y = 0.85;
const GLASS_TOUCH_PADDING = 20;
const HALF_WALL = GLASS_WALL_THICKNESS * 0.5; // 5.25
const HALF_BASE = GLASS_BASE_THICKNESS * 0.5; // 8.0
// Effective particle-to-capsule clearance (~8.2 on walls) so visual fluid sits flush against inner crystal
const EFFECTIVE_SURFACE_PAD = 2.95;
const WALL_CAPSULE_RADIUS = HALF_WALL + EFFECTIVE_SURFACE_PAD; // 8.2
const FLOOR_CAPSULE_RADIUS = HALF_BASE + EFFECTIVE_SURFACE_PAD; // 10.95
const WALL_RESTITUTION = 0.04;
const WALL_FRICTION = 0.16;
const WALL_CLIMB_KNEE = 130;

// Multi-nozzle emission constants
const EMIT_RATE_PER_NOZZLE = 235; // particles / sec (~2.9s to fill 680-particle glass)
const LANE_OFFSETS = [-1.4, 0, 1.4] as const;
const NOZZLE_SPAWN_Y = NOZZLE_TIP_Y - 2;
const INITIAL_JET_VY = -350;

// Tray & world cleanup constants
const TRAY_COLLISION_Y = TRAY_SURFACE_Y + 1.8;
const TRAY_DRAIN_THRESHOLD_Y = TRAY_SURFACE_Y + 3;
const COUNTER_COLLISION_Y = COUNTER_TOP_Y + 1.8;
const COUNTER_DRAIN_THRESHOLD_Y = COUNTER_TOP_Y + 3;

// Pair cache & Verlet skin capacity for zero-allocation solver
const VERLET_RADIUS = KERNEL_RADIUS + 2.2; // 17.0 wu tight Verlet skin
const MAX_PAIRS = 65536;
const MAX_VERLET_PAIRS = 81920;
const NUM_DRINKS = DRINKS.length; // 5
const SURFACE_BINS = 8;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class FluidSimulation {
  private particleCount = 0;
  private bubbleCount = 0;
  private time = 0;

  // Structure-of-Arrays fluid particle state (zero heap allocation in step)
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly prevX = new Float32Array(MAX_PARTICLES);
  private readonly prevY = new Float32Array(MAX_PARTICLES);
  private readonly dvx = new Float32Array(MAX_PARTICLES);
  private readonly dvy = new Float32Array(MAX_PARTICLES);

  private readonly absR = new Float32Array(MAX_PARTICLES);
  private readonly absG = new Float32Array(MAX_PARTICLES);
  private readonly absB = new Float32Array(MAX_PARTICLES);
  private readonly fizz = new Float32Array(MAX_PARTICLES);
  private readonly baseFizz = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);

  // Per-particle 5-drink recipe composition weights [w0..w4] summing to 1
  private readonly w0 = new Float32Array(MAX_PARTICLES);
  private readonly w1 = new Float32Array(MAX_PARTICLES);
  private readonly w2 = new Float32Array(MAX_PARTICLES);
  private readonly w3 = new Float32Array(MAX_PARTICLES);
  private readonly w4 = new Float32Array(MAX_PARTICLES);

  // Double-density buffers & packed pair cache ((i << 16) | j)
  private readonly rho = new Float32Array(MAX_PARTICLES);
  private readonly rhoNear = new Float32Array(MAX_PARTICLES);
  private readonly pressure = new Float32Array(MAX_PARTICLES);
  private readonly nearPressure = new Float32Array(MAX_PARTICLES);

  private readonly pairIJ = new Uint32Array(MAX_PAIRS);
  private readonly pairUx = new Float32Array(MAX_PAIRS);
  private readonly pairUy = new Float32Array(MAX_PAIRS);
  private readonly pairQ = new Float32Array(MAX_PAIRS);
  private readonly verletIJ = new Uint32Array(MAX_VERLET_PAIRS);
  private readonly neighborCells = new Int32Array(4);
  private readonly permScratchF32 = new Float32Array(MAX_PARTICLES);
  private readonly permScratchU8 = new Uint8Array(MAX_PARTICLES);
  private readonly inCup = new Uint8Array(MAX_PARTICLES);
  private lastPairCount = 0;
  private verletCount = 0;
  private reclaimCursor = 0;
  private stepCount = 0;

  // Pooled interior tracking & surface height profile for carbonation bubbles
  private readonly insideIndices = new Int32Array(MAX_PARTICLES);
  private readonly surfaceBins = new Float32Array(SURFACE_BINS);
  private readonly smoothedBins = new Float32Array(SURFACE_BINS);

  // Micro-bubble SoA state
  private readonly bx = new Float32Array(MAX_BUBBLES);
  private readonly by = new Float32Array(MAX_BUBBLES);
  private readonly bRadius = new Float32Array(MAX_BUBBLES);
  private readonly bAlpha = new Float32Array(MAX_BUBBLES);
  private readonly bBuoyancy = new Float32Array(MAX_BUBBLES);
  private readonly bPhase = new Float32Array(MAX_BUBBLES);
  private readonly bFreq = new Float32Array(MAX_BUBBLES);
  private readonly bAmp = new Float32Array(MAX_BUBBLES);
  private readonly bAge = new Float32Array(MAX_BUBBLES);

  // Interleaved GPU snapshot buffers
  private readonly particleGpuBuffer = new Float32Array(MAX_PARTICLES * 8);
  private readonly bubbleGpuBuffer = new Float32Array(MAX_BUBBLES * 4);

  private readonly spatialHash: SpatialHash;

  // Nozzle emission accumulators & lane counters
  private readonly activeDrinks = new Set<DrinkId>();
  private readonly emitAccum = new Float32Array(NUM_DRINKS);
  private readonly emitLane = new Int32Array(NUM_DRINKS);
  private bubbleSpawnAccum = 0;

  // Glass rigid body & pointer drag state
  private readonly glass: GlassState = {
    x: 480,
    y: TRAY_SURFACE_Y,
    vx: 0,
    vy: 0,
    targetX: 480,
    targetY: TRAY_SURFACE_Y,
    isDragging: false,
    tilt: 0,
  };
  private grabOffsetX = 0;
  private grabOffsetY = 0;

  private mixSummary: GlassMixSummary = {
    particleCount: 0,
    fillRatio: 0,
    displayHex: absorptionToDisplayHex(0, 0, 0),
    meanAbsorption: [0, 0, 0],
    recipeShares: {
      cola: 0,
      fanta: 0,
      sprite: 0,
      cherry: 0,
      'blue-raspberry': 0,
    },
  };

  // Fast deterministic xorshift32 PRNG state
  private rngState = 0x6d2b79f5;

  constructor() {
    this.spatialHash = new SpatialHash(
      VERLET_RADIUS,
      MAX_PARTICLES,
      -64,
      -64,
      WORLD_W + 64,
      WORLD_H + 80
    );
  }

  private rand(): number {
    let s = this.rngState | 0;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rngState = s;
    return (s >>> 0) / 4294967296;
  }

  public setDispensing(drinkId: DrinkId, active: boolean): void {
    if (!(drinkId in DRINK_MAP)) return;
    if (active) {
      this.activeDrinks.add(drinkId);
    } else {
      this.activeDrinks.delete(drinkId);
    }
  }

  public stopAllDispensing(): void {
    this.activeDrinks.clear();
  }

  public isDispensing(drinkId: DrinkId): boolean {
    return this.activeDrinks.has(drinkId);
  }

  /**
   * Returns true if `(worldX, worldY)` lies within the tapered outer glass silhouette
   * expanded by `20` world units of ergonomic touch/pointer padding.
   */
  public isPointNearGlass(worldX: number, worldY: number): boolean {
    const gx = this.glass.x;
    const gy = this.glass.y;
    const totalHeight = GLASS_BASE_THICKNESS + GLASS_INNER_HEIGHT;
    const y0 = gy;
    const y1 = gy + totalHeight;

    const dy = worldY < y0 ? y0 - worldY : worldY > y1 ? worldY - y1 : 0;
    if (dy > GLASS_TOUCH_PADDING) return false;

    const t = clamp((worldY - y0) / totalHeight, 0, 1);
    const outerBotHalfW = GLASS_BOTTOM_HALF_W + GLASS_WALL_THICKNESS;
    const outerTopHalfW = GLASS_TOP_HALF_W + GLASS_WALL_THICKNESS;
    const outerHalfW = outerBotHalfW + t * (outerTopHalfW - outerBotHalfW);

    const dx = Math.max(0, Math.abs(worldX - gx) - outerHalfW);
    return dx * dx + dy * dy <= GLASS_TOUCH_PADDING * GLASS_TOUCH_PADDING;
  }

  public beginGlassDrag(worldX: number, worldY: number): boolean {
    if (!this.isPointNearGlass(worldX, worldY)) {
      return false;
    }
    this.glass.isDragging = true;
    this.grabOffsetX = this.glass.x - worldX;
    this.grabOffsetY = this.glass.y - worldY;
    this.glass.targetX = clamp(worldX + this.grabOffsetX, GLASS_MIN_X, GLASS_MAX_X);
    this.glass.targetY = clamp(worldY + this.grabOffsetY, GLASS_MIN_Y, GLASS_MAX_Y);
    return true;
  }

  public updateGlassDrag(worldX: number, worldY: number): void {
    if (!this.glass.isDragging) return;
    this.glass.targetX = clamp(worldX + this.grabOffsetX, GLASS_MIN_X, GLASS_MAX_X);
    this.glass.targetY = clamp(worldY + this.grabOffsetY, GLASS_MIN_Y, GLASS_MAX_Y);
  }

  public endGlassDrag(): void {
    this.glass.isDragging = false;
    this.glass.targetX = clamp(this.glass.targetX, GLASS_MIN_X, GLASS_MAX_X);
    this.glass.targetY = TRAY_SURFACE_Y;
  }

  private isInsideGlassCupAt(x: number, y: number, gx: number, gy: number): boolean {
    const floorMidY = gy + HALF_BASE;
    const rimTopY = gy + GLASS_BASE_THICKNESS + GLASS_INNER_HEIGHT + PARTICLE_RADIUS * 1.25;
    if (y < floorMidY || y > rimTopY) return false;

    const t = clamp((y - (gy + GLASS_BASE_THICKNESS)) / GLASS_INNER_HEIGHT, 0, 1);
    const innerHalfW =
      GLASS_BOTTOM_HALF_W + t * (GLASS_TOP_HALF_W - GLASS_BOTTOM_HALF_W);
    return Math.abs(x - gx) <= innerHalfW + HALF_WALL * 0.5;
  }

  private isInsideGlassCup(x: number, y: number): boolean {
    return this.isInsideGlassCupAt(x, y, this.glass.x, this.glass.y);
  }

  /**
   * Removes fluid particles currently inside the glass interior and resets bubbles
   * inside the glass while leaving any mid-air falling stream particles intact.
   */
  public emptyGlass(): void {
    let write = 0;
    const n = this.particleCount;
    for (let i = 0; i < n; i++) {
      if (!this.isInsideGlassCup(this.px[i], this.py[i])) {
        if (write !== i) {
          this.copyParticle(write, i);
        }
        write++;
      }
    }
    this.particleCount = write;
    this.bubbleCount = 0;
    this.bubbleSpawnAccum = 0;
    this.updateMixAndGpuBuffers(0);
  }

  private copyParticle(dst: number, src: number): void {
    this.px[dst] = this.px[src];
    this.py[dst] = this.py[src];
    this.vx[dst] = this.vx[src];
    this.vy[dst] = this.vy[src];
    this.prevX[dst] = this.prevX[src];
    this.prevY[dst] = this.prevY[src];
    this.absR[dst] = this.absR[src];
    this.absG[dst] = this.absG[src];
    this.absB[dst] = this.absB[src];
    this.fizz[dst] = this.fizz[src];
    this.baseFizz[dst] = this.baseFizz[src];
    this.life[dst] = this.life[src];
    this.w0[dst] = this.w0[src];
    this.w1[dst] = this.w1[src];
    this.w2[dst] = this.w2[src];
    this.w3[dst] = this.w3[src];
    this.w4[dst] = this.w4[src];
  }

  public step(dtSeconds: number): void {
    const dt = dtSeconds > 0 ? Math.min(dtSeconds, MAX_DT) : DEFAULT_DT;
    const subDt = dt / SUBSTEPS;
    const prevGlassX = this.glass.x;
    const prevGlassY = this.glass.y;
    let peakGlassAgitation = 0;

    this.lastPairCount = 0;
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      const gx0 = this.glass.x;
      const gy0 = this.glass.y;
      const gvx0 = this.glass.vx;
      const gvy0 = this.glass.vy;

      this.stepGlassSpring(subDt);

      const dgx = this.glass.x - gx0;
      const dgy = this.glass.y - gy0;
      const dgvx = this.glass.vx - gvx0;
      const dgvy = this.glass.vy - gvy0;
      const ag = Math.abs(this.glass.vx) + Math.abs(this.glass.vy) * 0.5;
      if (ag > peakGlassAgitation) peakGlassAgitation = ag;

      const rebuildNeighbors = sub === 0 || (sub === 2 && peakGlassAgitation > 480);
      const applyXsph = (sub & 1) === 1;
      if (sub === 0) {
        this.emitNozzleStreams(dt);
      }
      this.stepFluidSubstep(
        subDt,
        rebuildNeighbors,
        applyXsph,
        gx0,
        gy0,
        dgx,
        dgy,
        dgvx,
        dgvy
      );
    }

    this.mixDyeAndFizz(dt, peakGlassAgitation);
    this.compactParticles();
    this.time += dt;

    const glassDx = this.glass.x - prevGlassX;
    const glassDy = this.glass.y - prevGlassY;
    this.updateMixAndBubbles(dt, glassDx, glassDy);
  }

  private stepGlassSpring(subDt: number): void {
    const g = this.glass;
    const w = GLASS_SPRING_OMEGA;
    const wdt = w * subDt;
    const denom = 1 / (1 + 2 * wdt + wdt * wdt);
    const w2dt = w * w * subDt;

    const errX = g.targetX - g.x;
    const errY = g.targetY - g.y;

    let nextVx = (g.vx + w2dt * errX) * denom;
    let nextVy = (g.vy + w2dt * errY) * denom;

    const speed2 = nextVx * nextVx + nextVy * nextVy;
    if (speed2 > MAX_GLASS_SPEED * MAX_GLASS_SPEED) {
      const inv = MAX_GLASS_SPEED / Math.sqrt(speed2);
      nextVx *= inv;
      nextVy *= inv;
    }

    let nextX = g.x + nextVx * subDt;
    let nextY = g.y + nextVy * subDt;

    if (nextX < GLASS_MIN_X) {
      nextX = GLASS_MIN_X;
      if (nextVx < 0) nextVx = 0;
    } else if (nextX > GLASS_MAX_X) {
      nextX = GLASS_MAX_X;
      if (nextVx > 0) nextVx = 0;
    }

    if (nextY < GLASS_MIN_Y) {
      nextY = GLASS_MIN_Y;
      if (nextVy < 0) nextVy = 0;
    } else if (nextY > GLASS_MAX_Y) {
      nextY = GLASS_MAX_Y;
      if (nextVy > 0) nextVy = 0;
    }

    if (
      Math.abs(g.targetX - nextX) < 0.005 &&
      Math.abs(g.targetY - nextY) < 0.005 &&
      nextVx * nextVx + nextVy * nextVy < 0.01
    ) {
      nextX = g.targetX;
      nextY = g.targetY;
      nextVx = 0;
      nextVy = 0;
    }

    g.x = nextX;
    g.y = nextY;
    g.vx = nextVx;
    g.vy = nextVy;
    g.tilt = 0;
  }

  private reclaimTrayParticleIfFull(): boolean {
    if (this.particleCount < MAX_PARTICLES) return true;
    const n = this.particleCount;
    const { life, px, py } = this;

    // Fast O(1) amortized cursor scan for any draining tray/countertop particle (life < 1)
    let cur = this.reclaimCursor;
    if (cur >= n) cur = 0;
    for (let step = 0; step < n; step++) {
      if (life[cur] < 0.99) {
        const last = n - 1;
        if (cur !== last) {
          this.copyParticle(cur, last);
        }
        this.particleCount = last;
        this.reclaimCursor = cur + 1 < last ? cur + 1 : 0;
        return true;
      }
      cur++;
      if (cur >= n) cur = 0;
    }

    // Fallback: reclaim any non-cup particle splashing near the tray
    for (let i = 0; i < n; i++) {
      if (py[i] < TRAY_SURFACE_Y + 28 && !this.isInsideGlassCup(px[i], py[i])) {
        const last = n - 1;
        if (i !== last) {
          this.copyParticle(i, last);
        }
        this.particleCount = last;
        return true;
      }
    }
    return false;
  }

  private emitNozzleStreams(dt: number): void {
    if (this.activeDrinks.size === 0) return;

    for (let d = 0; d < NUM_DRINKS; d++) {
      const spec = DRINKS[d];
      if (!this.activeDrinks.has(spec.id)) continue;

      this.emitAccum[d] += EMIT_RATE_PER_NOZZLE * dt;
      const burstCount = this.emitAccum[d] | 0;
      if (burstCount <= 0) continue;

      const jetSpanY = INITIAL_JET_VY * dt;
      for (let k = 0; k < burstCount; k++) {
        this.emitAccum[d] -= 1;
        if (!this.reclaimTrayParticleIfFull()) {
          this.emitAccum[d] = 0;
          break;
        }

        const laneIdx = this.emitLane[d] % 3;
        this.emitLane[d] = (laneIdx + 1) % 3;
        const laneOffset = LANE_OFFSETS[laneIdx];

        const jitterX = (this.rand() - 0.5) * 0.9;
        const jitterY = -this.rand() * 0.9;
        const spawnX = clamp(
          spec.nozzleX + laneOffset + jitterX,
          spec.nozzleX - 4.5,
          spec.nozzleX + 4.5
        );
        const spawnY = NOZZLE_SPAWN_Y + (jetSpanY * k) / burstCount + jitterY;

        // Gentle laminar convergence so the fast-falling stream stays sleek and single-column
        const turbVx = -laneOffset * 0.35 + (this.rand() - 0.5) * 2.2;
        const turbVy = INITIAL_JET_VY + (this.rand() - 0.5) * 10.0;

        const idx = this.particleCount++;
        this.px[idx] = spawnX;
        this.py[idx] = spawnY;
        this.prevX[idx] = spawnX;
        this.prevY[idx] = spawnY;
        this.vx[idx] = turbVx;
        this.vy[idx] = turbVy;
        this.rho[idx] = 0.85;
        this.inCup[idx] = 0;

        this.absR[idx] = spec.absorption[0];
        this.absG[idx] = spec.absorption[1];
        this.absB[idx] = spec.absorption[2];
        this.fizz[idx] = spec.carbonation;
        this.baseFizz[idx] = 0.16 * spec.carbonation;
        this.life[idx] = 1.0;

        this.w0[idx] = d === 0 ? 1 : 0;
        this.w1[idx] = d === 1 ? 1 : 0;
        this.w2[idx] = d === 2 ? 1 : 0;
        this.w3[idx] = d === 3 ? 1 : 0;
        this.w4[idx] = d === 4 ? 1 : 0;
      }
    }
  }

  private stepFluidSubstep(
    subDt: number,
    rebuildNeighbors: boolean,
    applyXsph: boolean,
    gx0: number,
    gy0: number,
    dgx: number,
    dgy: number,
    _dgvx: number,
    _dgvy: number
  ): void {
    const n = this.particleCount;
    if (n === 0) {
      this.lastPairCount = 0;
      this.verletCount = 0;
      return;
    }

    const {
      px,
      py,
      vx,
      vy,
      prevX,
      prevY,
      dvx,
      dvy,
      rho,
      rhoNear,
      pressure,
      nearPressure,
      pairIJ,
      pairUx,
      pairUy,
      pairQ,
      verletIJ,
      neighborCells,
      inCup,
      life,
      spatialHash,
    } = this;

    const shiftCupX = CO_ADVECT_X * dgx;
    const shiftCupY = CO_ADVECT_Y * dgy;
    const floorMidY = gy0 + HALF_BASE;
    const baseTopY = gy0 + GLASS_BASE_THICKNESS;
    const cupFloorBandY = baseTopY + 24;
    const rimTopY = baseTopY + GLASS_INNER_HEIGHT + PARTICLE_RADIUS * 1.25;
    const invInnerH = 1 / GLASS_INNER_HEIGHT;
    const halfWSlope = GLASS_TOP_HALF_W - GLASS_BOTTOM_HALF_W;
    const maxCupHalfW = GLASS_TOP_HALF_W + HALF_WALL * 0.5;

    // 1. Cup-frame co-advection, gravity with terminal soft-cap, and ballistic prediction
    for (let i = 0; i < n; i++) {
      const x0 = px[i];
      const y0 = py[i];
      const vy0 = vy[i];

      let insideCup = false;
      const absDxCup = Math.abs(x0 - gx0);
      if (absDxCup <= maxCupHalfW && y0 >= floorMidY && y0 <= rimTopY) {
        if (!(vy0 < -260 && y0 > cupFloorBandY && rho[i] < 2.15)) {
          let t = (y0 - baseTopY) * invInnerH;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          insideCup = absDxCup <= GLASS_BOTTOM_HALF_W + t * halfWSlope + HALF_WALL * 0.5;
        }
      }

      let bx = x0;
      let by = y0;
      if (insideCup) {
        inCup[i] = 1;
        bx += shiftCupX;
        by += shiftCupY;
      } else {
        inCup[i] = 0;
      }

      prevX[i] = bx;
      prevY[i] = by;

      let nextVy = vy0 + GRAVITY * subDt;
      if (nextVy < TERMINAL_FALL_SOFT_VY) {
        const excess = TERMINAL_FALL_SOFT_VY - nextVy;
        nextVy =
          TERMINAL_FALL_SOFT_VY -
          (TERMINAL_FALL_CAP_SPAN * excess) / (TERMINAL_FALL_CAP_SPAN + excess);
      }
      vy[i] = nextVy;

      px[i] = bx + vx[i] * subDt;
      py[i] = by + nextVy * subDt;
      rho[i] = 0.85;
      rhoNear[i] = 0.0;
      if (applyXsph) {
        dvx[i] = 0.0;
        dvy[i] = 0.0;
      }
    }

    // 2. Extract active neighbor pairs via CSR cell slices (sub===0) or packed Verlet list
    const h = KERNEL_RADIUS;
    const h2 = h * h;
    const invH = 1 / h;
    let pairCount = 0;

    if (rebuildNeighbors) {
      spatialHash.build(px, py, n);
      if (subDt > 0 && ((this.stepCount++ & 15) === 0) && n > 64) {
        this.reorderParticlesByCell(n);
      }
      const {
        dirtyCells,
        dirtyCount,
        cellCount,
        cellStart,
        sortedIdx,
        sortedX,
        sortedY,
        cols,
        rows,
      } = spatialHash;
      const vSkin2 = VERLET_RADIUS * VERLET_RADIUS;
      let vCount = 0;

      for (let d = 0; d < dirtyCount; d++) {
        const c = dirtyCells[d];
        const countA = cellCount[c];
        const startA = cellStart[c];
        const endA = startA + countA;

        // 2a. Intra-cell pairs (b > a) on contiguous L1-resident sortedX/sortedY
        for (let a = startA; a < endA - 1; a++) {
          const xi = sortedX[a];
          const yi = sortedY[a];
          const i = sortedIdx[a];
          const iShift = i << 16;

          for (let b = a + 1; b < endA; b++) {
            const dx = sortedX[b] - xi;
            const dy = sortedY[b] - yi;
            const r2 = dx * dx + dy * dy;
            if (r2 < vSkin2) {
              const j = sortedIdx[b];
              const packed = iShift | j;
              if (vCount < MAX_VERLET_PAIRS) {
                verletIJ[vCount++] = packed;
              }
              if (r2 < h2) {
                let ux: number;
                let uy: number;
                let q: number;
                if (r2 > 1e-8) {
                  const r = Math.sqrt(r2);
                  const invR = 1 / r;
                  ux = dx * invR;
                  uy = dy * invR;
                  q = 1 - r * invH;
                } else {
                  const lo = i < j ? i : j;
                  const hi = i < j ? j : i;
                  const angle = ((lo * 73856093) ^ (hi * 19349663)) & 0xff;
                  const rad = angle * 0.02454369;
                  ux = Math.cos(rad);
                  uy = Math.sin(rad);
                  q = 0.999;
                }

                const q2 = q * q;
                const q3 = q2 * q;
                rho[i] += q2;
                rho[j] += q2;
                rhoNear[i] += q3;
                rhoNear[j] += q3;

                if (pairCount < MAX_PAIRS) {
                  pairIJ[pairCount] = packed;
                  pairUx[pairCount] = ux;
                  pairUy[pairCount] = uy;
                  pairQ[pairCount] = q;
                  pairCount++;
                }
              }
            }
          }
        }

        // 2b. 4 forward neighbor cells with O(1) empty-cell skip
        const cy = (c / cols) | 0;
        const cx = c - cy * cols;
        let nbLen = 0;
        if (cx + 1 < cols && cellCount[c + 1] > 0) {
          neighborCells[nbLen++] = c + 1;
        }
        if (cy + 1 < rows) {
          const nextRowCell = c + cols;
          if (cx > 0 && cellCount[nextRowCell - 1] > 0) {
            neighborCells[nbLen++] = nextRowCell - 1;
          }
          if (cellCount[nextRowCell] > 0) {
            neighborCells[nbLen++] = nextRowCell;
          }
          if (cx + 1 < cols && cellCount[nextRowCell + 1] > 0) {
            neighborCells[nbLen++] = nextRowCell + 1;
          }
        }

        for (let nbIdx = 0; nbIdx < nbLen; nbIdx++) {
          const nb = neighborCells[nbIdx];
          const startB = cellStart[nb];
          const endB = startB + cellCount[nb];

          for (let a = startA; a < endA; a++) {
            const xi = sortedX[a];
            const yi = sortedY[a];
            const i = sortedIdx[a];
            const iShift = i << 16;

            for (let b = startB; b < endB; b++) {
              const dx = sortedX[b] - xi;
              const dy = sortedY[b] - yi;
              const r2 = dx * dx + dy * dy;
              if (r2 < vSkin2) {
                const j = sortedIdx[b];
                const packed = iShift | j;
                if (vCount < MAX_VERLET_PAIRS) {
                  verletIJ[vCount++] = packed;
                }
                if (r2 < h2) {
                  let ux: number;
                  let uy: number;
                  let q: number;
                  if (r2 > 1e-8) {
                    const r = Math.sqrt(r2);
                    const invR = 1 / r;
                    ux = dx * invR;
                    uy = dy * invR;
                    q = 1 - r * invH;
                  } else {
                    const lo = i < j ? i : j;
                    const hi = i < j ? j : i;
                    const angle = ((lo * 73856093) ^ (hi * 19349663)) & 0xff;
                    const rad = angle * 0.02454369;
                    ux = Math.cos(rad);
                    uy = Math.sin(rad);
                    q = 0.999;
                  }

                  const q2 = q * q;
                  const q3 = q2 * q;
                  rho[i] += q2;
                  rho[j] += q2;
                  rhoNear[i] += q3;
                  rhoNear[j] += q3;

                  if (pairCount < MAX_PAIRS) {
                    pairIJ[pairCount] = packed;
                    pairUx[pairCount] = ux;
                    pairUy[pairCount] = uy;
                    pairQ[pairCount] = q;
                    pairCount++;
                  }
                }
              }
            }
          }
        }
      }
      this.verletCount = vCount;
    } else {
      const vCount = this.verletCount;
      for (let vp = 0; vp < vCount; vp++) {
        const packed = verletIJ[vp];
        const i = packed >>> 16;
        const j = packed & 0xffff;
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const r2 = dx * dx + dy * dy;
        if (r2 < h2) {
          let ux: number;
          let uy: number;
          let q: number;
          if (r2 > 1e-8) {
            const r = Math.sqrt(r2);
            const invR = 1 / r;
            ux = dx * invR;
            uy = dy * invR;
            q = 1 - r * invH;
          } else {
            const lo = i < j ? i : j;
            const hi = i < j ? j : i;
            const angle = ((lo * 73856093) ^ (hi * 19349663)) & 0xff;
            const rad = angle * 0.02454369;
            ux = Math.cos(rad);
            uy = Math.sin(rad);
            q = 0.999;
          }

          const q2 = q * q;
          const q3 = q2 * q;
          rho[i] += q2;
          rho[j] += q2;
          rhoNear[i] += q3;
          rhoNear[j] += q3;

          if (pairCount < MAX_PAIRS) {
            pairIJ[pairCount] = packed;
            pairUx[pairCount] = ux;
            pairUy[pairCount] = uy;
            pairQ[pairCount] = q;
            pairCount++;
          }
        }
      }
    }
    this.lastPairCount = pairCount;

    // 3. Double-Density Relaxation (Clavet et al. 2005)
    for (let i = 0; i < n; i++) {
      // Smooth vena-contracta depressurization below nozzle orifice + cohesive laminar free-fall
      const yi = py[i];
      const jetExit = clamp((NOZZLE_TIP_Y - yi) / 52, 0, 1);
      const jetRamp = jetExit * jetExit;
      const freeFallSoft = this.inCup[i] === 0 && vy[i] < -210 ? 0.12 : 1;
      const rawP = K_STIFFNESS * (rho[i] - REST_DENSITY);
      const drainScale = yi <= TRAY_COLLISION_Y && life[i] < 0.7 ? 0.25 : 1;
      pressure[i] =
        (rawP > 0 ? rawP * freeFallSoft : rawP < MIN_PRESSURE ? MIN_PRESSURE : rawP) *
        jetRamp *
        drainScale;

      // Near-pressure engages strongly inside bulk pools to prevent compression/stacking
      // while allowing stretched falling streams & plunging plumes to slip into the pool
      const u = clamp((rho[i] - 2.15) / 0.65, 0, 1);
      const bulk = u * u * (3 - 2 * u);
      const plungeSoft = vy[i] < -140 ? clamp((vy[i] + 420) * (1 / 280), 0.14, 1) : 1;
      nearPressure[i] =
        K_NEAR *
        jetRamp *
        drainScale *
        freeFallSoft *
        (0.01 + 0.99 * bulk * plungeSoft) *
        rhoNear[i];
    }

    const dispScale = 27.5 * subDt * subDt;
    const maxPairDisp = h * 0.22;

    for (let p = 0; p < pairCount; p++) {
      const packed = pairIJ[p];
      const i = packed >>> 16;
      const j = packed & 0xffff;
      const q = pairQ[p];
      let disp =
        dispScale *
        ((pressure[i] + pressure[j]) * q + (nearPressure[i] + nearPressure[j]) * q * q);
      if (disp > maxPairDisp) disp = maxPairDisp;
      else if (disp < -maxPairDisp) disp = -maxPairDisp;

      const dx = pairUx[p] * disp;
      const dy = pairUy[p] * disp;
      px[i] -= dx;
      py[i] -= dy;
      px[j] += dx;
      py[j] += dy;
    }

    // 4 & 5. Fused DDR spike clamp + pre-velocity boundary resolution + viscous pool velocity derivation
    const invSubDt = 1 / subDt;
    this.resolveBoundariesAndVelocities(subDt, invSubDt, !applyXsph);

    // 6. Cohesive XSPH velocity smoothing on odd substeps + unconditional speed safety clamp
    if (applyXsph) {
      const nozzleFreeFallTopY = NOZZLE_TIP_Y - 56;
      const xsphPair = XSPH_FACTOR * 1.65;
      for (let p = 0; p < pairCount; p++) {
        const packed = pairIJ[p];
        const i = packed >>> 16;
        const j = packed & 0xffff;
        const isPlunging = vy[i] < -150 || vy[j] < -150;
        const w =
          (!isPlunging &&
          rho[i] + rho[j] > 4.2 &&
          py[i] < nozzleFreeFallTopY &&
          py[j] < nozzleFreeFallTopY
            ? xsphPair
            : 0.02) * pairQ[p];
        const ix = (vx[j] - vx[i]) * w;
        const iy = (vy[j] - vy[i]) * w;
        dvx[i] += ix;
        dvy[i] += iy;
        dvx[j] -= ix;
        dvy[j] -= iy;
      }

      const maxSpeed2 = MAX_PARTICLE_SPEED * MAX_PARTICLE_SPEED;
      for (let i = 0; i < n; i++) {
        const vxi = vx[i] + dvx[i];
        const vyi = vy[i] + dvy[i];
        const sp2 = vxi * vxi + vyi * vyi;
        if (sp2 > maxSpeed2) {
          const s = MAX_PARTICLE_SPEED / Math.sqrt(sp2);
          vx[i] = vxi * s;
          vy[i] = vyi * s;
        } else {
          vx[i] = vxi;
          vy[i] = vyi;
        }
      }
    }
  }

  /**
   * Once-per-step 10-channel Beer-Lambert absorption, 5-drink recipe weight,
   * and carbonation fizz exchange using the final substep's cached neighbor pairs.
   */
  private mixDyeAndFizz(dt: number, peakGlassAgitation: number): void {
    const n = this.particleCount;
    if (n === 0) return;

    const {
      py,
      vx,
      vy,
      pairIJ,
      pairQ,
      inCup,
      absR,
      absG,
      absB,
      fizz,
      baseFizz,
      w0,
      w1,
      w2,
      w3,
      w4,
      lastPairCount,
    } = this;

    const glassAgitation = Math.min(peakGlassAgitation * 0.015, 4.5);
    const baseMixRate = 0.28 + glassAgitation;
    const traySkipY = TRAY_SURFACE_Y + 8;

    for (let p = 0; p < lastPairCount; p++) {
      const packed = pairIJ[p];
      const i = packed >>> 16;
      const j = packed & 0xffff;
      if ((inCup[i] | inCup[j]) === 0 && py[i] < traySkipY && py[j] < traySkipY) {
        continue;
      }
      const q = pairQ[p];

      const rvx = vx[j] - vx[i];
      const rvy = vy[j] - vy[i];
      const relSpeed = Math.abs(rvx) + Math.abs(rvy) * 0.9;

      let alpha = (baseMixRate + 0.055 * relSpeed) * q * dt;
      if (alpha > 0.36) alpha = 0.36;
      else if (alpha < 0) alpha = 0;

      const dR = (absR[j] - absR[i]) * alpha;
      const dG = (absG[j] - absG[i]) * alpha;
      const dB = (absB[j] - absB[i]) * alpha;
      absR[i] += dR;
      absR[j] -= dR;
      absG[i] += dG;
      absG[j] -= dG;
      absB[i] += dB;
      absB[j] -= dB;

      const dw0 = (w0[j] - w0[i]) * alpha;
      const dw1 = (w1[j] - w1[i]) * alpha;
      const dw2 = (w2[j] - w2[i]) * alpha;
      const dw3 = (w3[j] - w3[i]) * alpha;
      const dw4 = (w4[j] - w4[i]) * alpha;
      w0[i] += dw0;
      w0[j] -= dw0;
      w1[i] += dw1;
      w1[j] -= dw1;
      w2[i] += dw2;
      w2[j] -= dw2;
      w3[i] += dw3;
      w3[j] -= dw3;
      w4[i] += dw4;
      w4[j] -= dw4;

      const dFizz = (fizz[j] - fizz[i]) * (alpha * 0.5);
      fizz[i] += dFizz;
      fizz[j] -= dFizz;

      const dBaseFizz = (baseFizz[j] - baseFizz[i]) * alpha;
      baseFizz[i] += dBaseFizz;
      baseFizz[j] -= dBaseFizz;
    }

    const fizzDecay = 0.12 * dt;
    for (let i = 0; i < n; i++) {
      if (fizz[i] > baseFizz[i]) {
        const decayed = fizz[i] - fizzDecay;
        fizz[i] = decayed > baseFizz[i] ? decayed : baseFizz[i];
      }
    }
  }

  /**
   * Register-fused post-DDR pass:
   * 1) Clamps DDR pressure-correction velocity spikes (<= 260 wu/s per substep)
   * 2) Resolves glass capsule & drip tray / countertop boundaries BEFORE velocity derivation
   * 3) Derives PBD velocities and applies exp(-1.6 * dt) viscous damping to pooled particles
   */
  private resolveBoundariesAndVelocities(
    subDt: number,
    invSubDt: number,
    clampSpeed: boolean
  ): void {
    const n = this.particleCount;
    const { px, py, prevX, prevY, vx, vy, inCup, life } = this;

    const gx = this.glass.x;
    const gy = this.glass.y;
    const gvx = this.glass.vx;
    const gvy = this.glass.vy;
    const coWallVx = (1 - CO_ADVECT_X) * gvx;
    const coWallVy = (1 - CO_ADVECT_Y) * gvy;

    // Precomputed glass capsule segment geometry
    const lax = gx - GLASS_BOTTOM_HALF_W - HALF_WALL;
    const lay = gy + HALF_WALL;
    const lbx = gx - GLASS_TOP_HALF_W - HALF_WALL;
    const lby = gy + GLASS_BASE_THICKNESS + GLASS_INNER_HEIGHT;
    const labx = lbx - lax;
    const wallAby = lby - lay;
    const wallInvLen2 = 1 / (labx * labx + wallAby * wallAby);

    const rax = gx + GLASS_BOTTOM_HALF_W + HALF_WALL;
    const rbx = gx + GLASS_TOP_HALF_W + HALF_WALL;
    const rabx = rbx - rax;

    const fax = gx - GLASS_BOTTOM_HALF_W - HALF_WALL * 0.5;
    const fay = gy + HALF_BASE;
    const fbx = gx + GLASS_BOTTOM_HALF_W + HALF_WALL * 0.5;

    const floorR = FLOOR_CAPSULE_RADIUS;
    const floorR2 = floorR * floorR;
    const wallR = WALL_CAPSULE_RADIUS;
    const wallR2 = wallR * wallR;
    const wallKeepTang = 1 - WALL_FRICTION;

    const glassBoundHalfW = GLASS_TOP_HALF_W + GLASS_WALL_THICKNESS + WALL_CAPSULE_RADIUS + 8;
    const glassBoundMinY = gy - FLOOR_CAPSULE_RADIUS - 6;
    const glassBoundMaxY = lby + WALL_CAPSULE_RADIUS + 6;

    const maxCorr = MAX_CONSTRAINT_DV * subDt;
    const maxCorr2 = maxCorr * maxCorr;
    const poolDamp = Math.exp(-POOL_DAMP_RATE * subDt);
    const maxSpeed2 = MAX_PARTICLE_SPEED * MAX_PARTICLE_SPEED;

    for (let i = 0; i < n; i++) {
      let x = px[i];
      let y = py[i];
      let pvx = prevX[i];
      let pvy = prevY[i];

      // 1. Clamp DDR position-correction velocity spikes
      const predX = pvx + vx[i] * subDt;
      const predY = pvy + vy[i] * subDt;
      const corrX = x - predX;
      const corrY = y - predY;
      const corr2 = corrX * corrX + corrY * corrY;
      if (corr2 > maxCorr2) {
        const s = maxCorr / Math.sqrt(corr2);
        x = predX + corrX * s;
        y = predY + corrY * s;
      }

      const cupFlag = inCup[i];

      // 2. Pre-velocity 3-capsule glass collision
      if (
        Math.abs(x - gx) < glassBoundHalfW &&
        y > glassBoundMinY &&
        y < glassBoundMaxY
      ) {
        const wVx = cupFlag ? coWallVx : gvx;
        const wVy = cupFlag ? coWallVy : gvy;

        // 2a. Horizontal bottom floor capsule
        const fcx = x < fax ? fax : x > fbx ? fbx : x;
        const fdx = x - fcx;
        const fdy = y - fay;
        const fd2 = fdx * fdx + fdy * fdy;
        if (fd2 < floorR2) {
          let nx = 0;
          let ny = 1;
          let pen = floorR;
          if (fd2 > 1e-8) {
            const dist = Math.sqrt(fd2);
            const invDist = 1 / dist;
            nx = fdx * invDist;
            ny = fdy * invDist;
            pen = floorR - dist;
          }
          const nxPx = x + nx * pen;
          const nyPy = y + ny * pen;
          const rvx = (x - pvx) * invSubDt - wVx;
          const rvy = (y - pvy) * invSubDt - wVy;
          const vn = rvx * nx + rvy * ny;
          x = nxPx;
          y = nyPy;
          if (vn < 0) {
            const tx = -ny;
            const ty = nx;
            const newVn = -vn * WALL_RESTITUTION;
            const newVt = (rvx * tx + rvy * ty) * wallKeepTang;
            pvx = x - (wVx + nx * newVn + tx * newVt) * subDt;
            pvy = y - (wVy + ny * newVn + ty * newVt) * subDt;
          } else {
            pvx += nx * pen;
            pvy += ny * pen;
          }
        }

        // 2b. Left tapered wall capsule
        let lt = ((x - lax) * labx + (y - lay) * wallAby) * wallInvLen2;
        if (lt < 0) lt = 0;
        else if (lt > 1) lt = 1;
        const ldx = x - (lax + lt * labx);
        const ldy = y - (lay + lt * wallAby);
        const ld2 = ldx * ldx + ldy * ldy;
        if (ld2 < wallR2) {
          let nx = 1;
          let ny = 0;
          let pen = wallR;
          if (ld2 > 1e-8) {
            const dist = Math.sqrt(ld2);
            const invDist = 1 / dist;
            nx = ldx * invDist;
            ny = ldy * invDist;
            pen = wallR - dist;
          }
          const nxPx = x + nx * pen;
          const nyPy = y + ny * pen;
          const rvx = (x - pvx) * invSubDt - wVx;
          const rvy = (y - pvy) * invSubDt - wVy;
          const vn = rvx * nx + rvy * ny;
          x = nxPx;
          y = nyPy;
          if (vn < 0) {
            const tx = -ny;
            const ty = nx;
            const newVn = -vn * WALL_RESTITUTION;
            let newVt = (rvx * tx + rvy * ty) * wallKeepTang;
            const upSpeed = newVt * ty;
            if (Math.abs(ny) < 0.5 && upSpeed > WALL_CLIMB_KNEE) {
              newVt *= (WALL_CLIMB_KNEE + (upSpeed - WALL_CLIMB_KNEE) * 0.28) / upSpeed;
            }
            pvx = x - (wVx + nx * newVn + tx * newVt) * subDt;
            pvy = y - (wVy + ny * newVn + ty * newVt) * subDt;
          } else {
            pvx += nx * pen;
            pvy += ny * pen;
          }
        }

        // 2c. Right tapered wall capsule
        let rt = ((x - rax) * rabx + (y - lay) * wallAby) * wallInvLen2;
        if (rt < 0) rt = 0;
        else if (rt > 1) rt = 1;
        const rdx = x - (rax + rt * rabx);
        const rdy = y - (lay + rt * wallAby);
        const rd2 = rdx * rdx + rdy * rdy;
        if (rd2 < wallR2) {
          let nx = -1;
          let ny = 0;
          let pen = wallR;
          if (rd2 > 1e-8) {
            const dist = Math.sqrt(rd2);
            const invDist = 1 / dist;
            nx = rdx * invDist;
            ny = rdy * invDist;
            pen = wallR - dist;
          }
          const nxPx = x + nx * pen;
          const nyPy = y + ny * pen;
          const rvx = (x - pvx) * invSubDt - wVx;
          const rvy = (y - pvy) * invSubDt - wVy;
          const vn = rvx * nx + rvy * ny;
          x = nxPx;
          y = nyPy;
          if (vn < 0) {
            const tx = -ny;
            const ty = nx;
            const newVn = -vn * WALL_RESTITUTION;
            let newVt = (rvx * tx + rvy * ty) * wallKeepTang;
            const upSpeed = newVt * ty;
            if (Math.abs(ny) < 0.5 && upSpeed > WALL_CLIMB_KNEE) {
              newVt *= (WALL_CLIMB_KNEE + (upSpeed - WALL_CLIMB_KNEE) * 0.28) / upSpeed;
            }
            pvx = x - (wVx + nx * newVn + tx * newVt) * subDt;
            pvy = y - (wVy + ny * newVn + ty * newVt) * subDt;
          } else {
            pvx += nx * pen;
            pvy += ny * pen;
          }
        }
      }

      // 3. Drip tray grate & countertop collision (fast single-branch reject for y > 77)
      if (y <= TRAY_DRAIN_THRESHOLD_Y) {
        if (x >= TRAY_LEFT_X && x <= TRAY_RIGHT_X) {
          const phase = x * 0.066845;
          const slotFactor = phase - (phase | 0) < 0.45 ? 3.1 : 1.9;
          const nextLife = life[i] - slotFactor * subDt;
          life[i] = nextLife;
          const sinkOffset = nextLife < 0.25 ? (0.25 - nextLife) * 14 : 0;
          const grateFloorY = TRAY_COLLISION_Y - sinkOffset;
          if (y < grateFloorY) {
            const curVy = (y - pvy) * invSubDt;
            const curVx = (x - pvx) * invSubDt;
            if (curVy < 0) {
              pvy = grateFloorY - -curVy * 0.08 * subDt;
              pvx = x - curVx * 0.84 * subDt;
            } else {
              pvy += grateFloorY - y;
            }
            y = grateFloorY;
          }
        } else if (y <= COUNTER_DRAIN_THRESHOLD_Y) {
          life[i] -= 2.2 * subDt;
          if (y < COUNTER_COLLISION_Y) {
            const curVy = (y - pvy) * invSubDt;
            const curVx = (x - pvx) * invSubDt;
            if (curVy < 0) {
              pvy = COUNTER_COLLISION_Y - -curVy * 0.07 * subDt;
              pvx = x - curVx * 0.82 * subDt;
            } else {
              pvy += COUNTER_COLLISION_Y - y;
            }
            y = COUNTER_COLLISION_Y;
          }
        }
      }

      px[i] = x;
      py[i] = y;
      prevX[i] = pvx;
      prevY[i] = pvy;

      // 4. Derive relaxed PBD velocity + viscous pool damping
      let nvx = (x - pvx) * invSubDt;
      let nvy = (y - pvy) * invSubDt;
      if (cupFlag) {
        nvx = coWallVx + (nvx - coWallVx) * poolDamp;
        nvy = coWallVy + (nvy - coWallVy) * poolDamp;
      }
      if (clampSpeed) {
        const sp2 = nvx * nvx + nvy * nvy;
        if (sp2 > maxSpeed2) {
          const s = MAX_PARTICLE_SPEED / Math.sqrt(sp2);
          nvx *= s;
          nvy *= s;
        }
      }
      vx[i] = nvx;
      vy[i] = nvy;
    }
  }

  private permuteFloat32(arr: Float32Array, order: Int32Array, n: number): void {
    const tmp = this.permScratchF32;
    for (let k = 0; k < n; k++) {
      tmp[k] = arr[order[k]];
    }
    for (let k = 0; k < n; k++) {
      arr[k] = tmp[k];
    }
  }

  private reorderParticlesByCell(n: number): void {
    const { sortedIdx, sortedX, sortedY } = this.spatialHash;
    const { px, py, inCup, permScratchU8 } = this;

    for (let k = 0; k < n; k++) {
      px[k] = sortedX[k];
      py[k] = sortedY[k];
      permScratchU8[k] = inCup[sortedIdx[k]];
    }
    for (let k = 0; k < n; k++) {
      inCup[k] = permScratchU8[k];
    }

    this.permuteFloat32(this.vx, sortedIdx, n);
    this.permuteFloat32(this.vy, sortedIdx, n);
    this.permuteFloat32(this.prevX, sortedIdx, n);
    this.permuteFloat32(this.prevY, sortedIdx, n);
    this.permuteFloat32(this.absR, sortedIdx, n);
    this.permuteFloat32(this.absG, sortedIdx, n);
    this.permuteFloat32(this.absB, sortedIdx, n);
    this.permuteFloat32(this.fizz, sortedIdx, n);
    this.permuteFloat32(this.baseFizz, sortedIdx, n);
    this.permuteFloat32(this.life, sortedIdx, n);
    this.permuteFloat32(this.w0, sortedIdx, n);
    this.permuteFloat32(this.w1, sortedIdx, n);
    this.permuteFloat32(this.w2, sortedIdx, n);
    this.permuteFloat32(this.w3, sortedIdx, n);
    this.permuteFloat32(this.w4, sortedIdx, n);

    for (let k = 0; k < n; k++) {
      sortedIdx[k] = k;
    }
  }

  private compactParticles(): void {
    let write = 0;
    const n = this.particleCount;
    const minX = -24;
    const maxX = WORLD_W + 24;
    const minY = -24;
    const maxY = WORLD_H + 48;

    for (let i = 0; i < n; i++) {
      const x = this.px[i];
      const y = this.py[i];
      if (
        this.life[i] > 0 &&
        x >= minX &&
        x <= maxX &&
        y >= minY &&
        y <= maxY
      ) {
        if (write !== i) {
          this.copyParticle(write, i);
        }
        write++;
      }
    }
    this.particleCount = write;
  }

  private sampleSurfaceY(worldX: number): number {
    const gx = this.glass.x;
    const span = GLASS_TOP_HALF_W * 2;
    const u = clamp((worldX - (gx - GLASS_TOP_HALF_W)) / span, 0, 0.9999);
    const f = u * (SURFACE_BINS - 1);
    const b0 = f | 0;
    const b1 = b0 + 1 < SURFACE_BINS ? b0 + 1 : b0;
    const frac = f - b0;
    return this.smoothedBins[b0] * (1 - frac) + this.smoothedBins[b1] * frac;
  }

  private updateMixAndBubbles(dt: number, glassDx: number, glassDy: number): void {
    const insideCount = this.collectInteriorAndSurface();
    this.stepBubbles(dt, glassDx, glassDy, insideCount);
    this.updateMixAndGpuBuffers(insideCount);
  }

  private collectInteriorAndSurface(): number {
    const gx = this.glass.x;
    const gy = this.glass.y;
    const innerFloorY = gy + GLASS_BASE_THICKNESS;
    const span = GLASS_TOP_HALF_W * 2;
    const leftEdge = gx - GLASS_TOP_HALF_W;

    for (let b = 0; b < SURFACE_BINS; b++) {
      this.surfaceBins[b] = innerFloorY;
    }

    let insideCount = 0;
    const n = this.particleCount;
    for (let i = 0; i < n; i++) {
      const x = this.px[i];
      const y = this.py[i];
      if (this.isInsideGlassCup(x, y)) {
        this.insideIndices[insideCount++] = i;
        const bin = clamp(((x - leftEdge) / span) * SURFACE_BINS, 0, SURFACE_BINS - 1) | 0;
        if (y + PARTICLE_RADIUS * 0.6 > this.surfaceBins[bin]) {
          this.surfaceBins[bin] = y + PARTICLE_RADIUS * 0.6;
        }
      }
    }

    // Fill empty side bins from nearest occupied bin and smooth 3-tap
    for (let b = 1; b < SURFACE_BINS; b++) {
      if (this.surfaceBins[b] <= innerFloorY + 0.5 && this.surfaceBins[b - 1] > innerFloorY + 0.5) {
        this.surfaceBins[b] = this.surfaceBins[b - 1];
      }
    }
    for (let b = SURFACE_BINS - 2; b >= 0; b--) {
      if (this.surfaceBins[b] <= innerFloorY + 0.5 && this.surfaceBins[b + 1] > innerFloorY + 0.5) {
        this.surfaceBins[b] = this.surfaceBins[b + 1];
      }
    }
    for (let b = 0; b < SURFACE_BINS; b++) {
      const prev = this.surfaceBins[b > 0 ? b - 1 : 0];
      const curr = this.surfaceBins[b];
      const next = this.surfaceBins[b + 1 < SURFACE_BINS ? b + 1 : SURFACE_BINS - 1];
      this.smoothedBins[b] = 0.25 * prev + 0.5 * curr + 0.25 * next;
    }

    return insideCount;
  }

  private stepBubbles(
    dt: number,
    glassDx: number,
    glassDy: number,
    insideCount: number
  ): void {
    const gx = this.glass.x;
    const gy = this.glass.y;
    const innerFloorY = gy + GLASS_BASE_THICKNESS;
    const rimY = innerFloorY + GLASS_INNER_HEIGHT;

    // Compute mean fizz of pooled particles inside the glass
    let fizzSum = 0;
    for (let k = 0; k < insideCount; k++) {
      fizzSum += this.fizz[this.insideIndices[k]];
    }
    const meanFizz = insideCount > 0 ? fizzSum / insideCount : 0;

    // Spawn rising micro-bubbles proportional to pooled fizz
    if (insideCount >= 20 && meanFizz > 0.02) {
      const spawnRate = Math.min(300, insideCount * meanFizz * 0.28);
      this.bubbleSpawnAccum += spawnRate * dt;

      let attempts = 0;
      while (
        this.bubbleSpawnAccum >= 1 &&
        this.bubbleCount < MAX_BUBBLES &&
        attempts < 24
      ) {
        this.bubbleSpawnAccum -= 1;
        attempts++;

        const pIdx = this.insideIndices[(this.rand() * insideCount) | 0];
        const spawnX = this.px[pIdx] + (this.rand() - 0.5) * 6;
        const spawnY = this.py[pIdx] + (this.rand() - 0.5) * 4;
        const surfY = this.sampleSurfaceY(spawnX);

        if (surfY - spawnY < 8) continue;

        const u = this.rand();
        const radius = 1.05 + u * 2.05;
        const buoyancy = 95 + u * 70; // 95..165 world units/s

        const b = this.bubbleCount++;
        this.bx[b] = spawnX;
        this.by[b] = Math.max(innerFloorY + radius + 1.5, spawnY);
        this.bRadius[b] = radius;
        this.bBuoyancy[b] = buoyancy;
        this.bPhase[b] = this.rand() * Math.PI * 2;
        this.bFreq[b] = 6.5 + this.rand() * 6.5;
        this.bAmp[b] = 9 + this.rand() * 14;
        this.bAge[b] = 0;
        this.bAlpha[b] = 0.05;
      }
      if (this.bubbleCount >= MAX_BUBBLES) {
        this.bubbleSpawnAccum = 0;
      }
    } else {
      this.bubbleSpawnAccum = 0;
    }

    // Advect, wobble, clamp inside tapered walls, and despawn smoothly at liquid surface
    let write = 0;
    for (let i = 0; i < this.bubbleCount; i++) {
      const age = this.bAge[i] + dt;
      const r = this.bRadius[i];
      const wobble =
        Math.sin(this.time * this.bFreq[i] + this.bPhase[i]) * this.bAmp[i] * dt;

      let x = this.bx[i] + glassDx + wobble;
      let y = this.by[i] + glassDy + this.bBuoyancy[i] * dt;

      const t = clamp((y - innerFloorY) / GLASS_INNER_HEIGHT, 0, 1);
      const maxHalfW = Math.max(
        4,
        GLASS_BOTTOM_HALF_W +
          t * (GLASS_TOP_HALF_W - GLASS_BOTTOM_HALF_W) -
          r -
          EFFECTIVE_SURFACE_PAD
      );
      x = clamp(x, gx - maxHalfW, gx + maxHalfW);
      if (y < innerFloorY + r + 1) {
        y = innerFloorY + r + 1;
      }

      const surfY = this.sampleSurfaceY(x);
      const distBelowSurface = surfY - y;

      if (
        insideCount < 8 ||
        distBelowSurface < -1.5 ||
        y > rimY + 4 ||
        surfY <= innerFloorY + 3
      ) {
        continue;
      }

      const fadeIn = Math.min(1, age / 0.06);
      const fadeOut = clamp((distBelowSurface + 1.5) / 11, 0, 1);
      const baseAlpha = 0.36 + 0.4 * ((r - 1.05) / 2.05);

      this.bx[write] = x;
      this.by[write] = y;
      this.bRadius[write] = r;
      this.bBuoyancy[write] = this.bBuoyancy[i];
      this.bPhase[write] = this.bPhase[i];
      this.bFreq[write] = this.bFreq[i];
      this.bAmp[write] = this.bAmp[i];
      this.bAge[write] = age;
      this.bAlpha[write] = baseAlpha * fadeIn * fadeOut;
      write++;
    }
    this.bubbleCount = write;
  }

  private updateMixAndGpuBuffers(insideCount: number): void {
    // Pack per-particle GPU data: [x, y, vx, vy, absR, absG, absB, fizz]
    const n = this.particleCount;
    const pBuf = this.particleGpuBuffer;
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      pBuf[o] = this.px[i];
      pBuf[o + 1] = this.py[i];
      pBuf[o + 2] = this.vx[i];
      pBuf[o + 3] = this.vy[i];
      pBuf[o + 4] = this.absR[i];
      pBuf[o + 5] = this.absG[i];
      pBuf[o + 6] = this.absB[i];
      pBuf[o + 7] = this.fizz[i];
    }

    // Pack per-bubble GPU data: [x, y, radius, alpha]
    const bCount = this.bubbleCount;
    const bBuf = this.bubbleGpuBuffer;
    for (let i = 0; i < bCount; i++) {
      const o = i * 4;
      bBuf[o] = this.bx[i];
      bBuf[o + 1] = this.by[i];
      bBuf[o + 2] = this.bRadius[i];
      bBuf[o + 3] = this.bAlpha[i];
    }

    if (insideCount === 0) {
      this.mixSummary = {
        particleCount: 0,
        fillRatio: 0,
        displayHex: absorptionToDisplayHex(0, 0, 0),
        meanAbsorption: [0, 0, 0],
        recipeShares: {
          cola: 0,
          fanta: 0,
          sprite: 0,
          cherry: 0,
          'blue-raspberry': 0,
        },
      };
      return;
    }

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sw0 = 0;
    let sw1 = 0;
    let sw2 = 0;
    let sw3 = 0;
    let sw4 = 0;

    for (let k = 0; k < insideCount; k++) {
      const i = this.insideIndices[k];
      sumR += this.absR[i];
      sumG += this.absG[i];
      sumB += this.absB[i];
      sw0 += this.w0[i];
      sw1 += this.w1[i];
      sw2 += this.w2[i];
      sw3 += this.w3[i];
      sw4 += this.w4[i];
    }

    const invCount = 1 / insideCount;
    const meanR = sumR * invCount;
    const meanG = sumG * invCount;
    const meanB = sumB * invCount;

    const totalW = sw0 + sw1 + sw2 + sw3 + sw4;
    const invW = totalW > 1e-8 ? 1 / totalW : 0;

    this.mixSummary = {
      particleCount: insideCount,
      fillRatio: Math.min(1, insideCount / GLASS_FULL_PARTICLES),
      displayHex: absorptionToDisplayHex(meanR, meanG, meanB),
      meanAbsorption: [meanR, meanG, meanB],
      recipeShares: {
        cola: sw0 * invW,
        fanta: sw1 * invW,
        sprite: sw2 * invW,
        cherry: sw3 * invW,
        'blue-raspberry': sw4 * invW,
      },
    };
  }

  public getSnapshot(): SimulationSnapshot {
    return {
      particleCount: this.particleCount,
      particleData: this.particleGpuBuffer.subarray(0, this.particleCount * 8),
      bubbleCount: this.bubbleCount,
      bubbleData: this.bubbleGpuBuffer.subarray(0, this.bubbleCount * 4),
      glass: this.glass,
      activeDrinks: this.activeDrinks,
      mix: this.mixSummary,
      time: this.time,
    };
  }
}
