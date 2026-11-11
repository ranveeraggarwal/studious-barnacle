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

const SUBSTEPS = 6;
const DEFAULT_DT = 1 / 60;
const MAX_DT = 1 / 30;

// Double-Density Relaxation (Clavet et al. 2005) + XSPH parameters
const GRAVITY = -920;
const REST_DENSITY = 3.4;
const K_STIFFNESS = 160;
const K_NEAR = 420;
const MIN_PRESSURE = -6;
const XSPH_FACTOR = 0.035;
const MAX_PARTICLE_SPEED = 1650;

// Glass spring & thick capsule collision constants
const GLASS_SPRING_OMEGA = 36;
const MAX_GLASS_SPEED = 1400;
const GLASS_TOUCH_PADDING = 20;
const HALF_WALL = GLASS_WALL_THICKNESS * 0.5; // 5.25
const HALF_BASE = GLASS_BASE_THICKNESS * 0.5; // 8.0
// Effective particle-to-capsule clearance (~8.2 on walls) so visual fluid sits flush against inner crystal
const EFFECTIVE_SURFACE_PAD = 2.95;
const WALL_CAPSULE_RADIUS = HALF_WALL + EFFECTIVE_SURFACE_PAD; // 8.2
const FLOOR_CAPSULE_RADIUS = HALF_BASE + EFFECTIVE_SURFACE_PAD; // 10.95
const WALL_RESTITUTION = 0.12;
const WALL_FRICTION = 0.08;

// Multi-nozzle emission constants
const EMIT_RATE_PER_NOZZLE = 210; // particles / sec (~5.3s to fill 1120-particle glass)
const LANE_OFFSETS = [-3.8, 0, 3.8] as const;
const NOZZLE_SPAWN_Y = NOZZLE_TIP_Y - 2;
const INITIAL_JET_VY = -185;

// Tray & world cleanup constants
const TRAY_COLLISION_Y = TRAY_SURFACE_Y + 1.8;
const TRAY_DRAIN_THRESHOLD_Y = TRAY_SURFACE_Y + 3;
const COUNTER_COLLISION_Y = COUNTER_TOP_Y + 1.8;
const COUNTER_DRAIN_THRESHOLD_Y = COUNTER_TOP_Y + 3;

// Pair cache capacity for zero-allocation multi-pass substep solver
const MAX_PAIRS = 98304;
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

  // Double-density buffers & pair cache
  private readonly rho = new Float32Array(MAX_PARTICLES);
  private readonly rhoNear = new Float32Array(MAX_PARTICLES);
  private readonly pressure = new Float32Array(MAX_PARTICLES);
  private readonly nearPressure = new Float32Array(MAX_PARTICLES);

  private readonly pairI = new Int32Array(MAX_PAIRS);
  private readonly pairJ = new Int32Array(MAX_PAIRS);
  private readonly pairUx = new Float32Array(MAX_PAIRS);
  private readonly pairUy = new Float32Array(MAX_PAIRS);
  private readonly pairQ = new Float32Array(MAX_PAIRS);

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
      KERNEL_RADIUS,
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

  private isInsideGlassCup(x: number, y: number): boolean {
    const gx = this.glass.x;
    const gy = this.glass.y;
    const floorMidY = gy + HALF_BASE;
    const rimTopY = gy + GLASS_BASE_THICKNESS + GLASS_INNER_HEIGHT + PARTICLE_RADIUS * 1.25;
    if (y < floorMidY || y > rimTopY) return false;

    const t = clamp((y - (gy + GLASS_BASE_THICKNESS)) / GLASS_INNER_HEIGHT, 0, 1);
    const innerHalfW =
      GLASS_BOTTOM_HALF_W + t * (GLASS_TOP_HALF_W - GLASS_BOTTOM_HALF_W);
    return Math.abs(x - gx) <= innerHalfW + HALF_WALL * 0.5;
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

    for (let sub = 0; sub < SUBSTEPS; sub++) {
      this.stepGlassSpring(subDt);
      this.emitNozzleStreams(subDt);
      this.stepFluidSubstep(subDt);
    }

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
    g.tilt = clamp(-g.vx * 0.00009, -0.09, 0.09);
  }

  private reclaimTrayParticleIfFull(): boolean {
    if (this.particleCount < MAX_PARTICLES) return true;
    // Reclaim the lowest-life particle resting/splashing near the drip tray outside the glass
    let victim = -1;
    let lowestLife = 2;
    const n = this.particleCount;
    for (let i = 0; i < n; i++) {
      if (
        this.py[i] < TRAY_SURFACE_Y + 28 &&
        !this.isInsideGlassCup(this.px[i], this.py[i]) &&
        this.life[i] < lowestLife
      ) {
        lowestLife = this.life[i];
        victim = i;
      }
    }
    if (victim === -1) return false;
    const last = this.particleCount - 1;
    if (victim !== last) {
      this.copyParticle(victim, last);
    }
    this.particleCount = last;
    return true;
  }

  private emitNozzleStreams(subDt: number): void {
    if (this.activeDrinks.size === 0) return;

    for (let d = 0; d < NUM_DRINKS; d++) {
      const spec = DRINKS[d];
      if (!this.activeDrinks.has(spec.id)) continue;

      this.emitAccum[d] += EMIT_RATE_PER_NOZZLE * subDt;
      while (this.emitAccum[d] >= 1) {
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
        const spawnY = NOZZLE_SPAWN_Y + jitterY;

        // Tapered nozzle convergence + subtle organic turbulence so stream narrows as it falls
        const turbVx = -laneOffset * 1.7 + (this.rand() - 0.5) * 5.5;
        const turbVy = INITIAL_JET_VY + (this.rand() - 0.5) * 15.0;

        const idx = this.particleCount++;
        this.px[idx] = spawnX;
        this.py[idx] = spawnY;
        this.prevX[idx] = spawnX;
        this.prevY[idx] = spawnY;
        this.vx[idx] = turbVx;
        this.vy[idx] = turbVy;

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

  private stepFluidSubstep(subDt: number): void {
    const n = this.particleCount;
    if (n === 0) return;

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
      pairI,
      pairJ,
      pairUx,
      pairUy,
      pairQ,
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
      spatialHash,
    } = this;

    // 1. Apply gravity and advance predicted positions
    for (let i = 0; i < n; i++) {
      vy[i] += GRAVITY * subDt;
      prevX[i] = px[i];
      prevY[i] = py[i];
      px[i] += vx[i] * subDt;
      py[i] += vy[i] * subDt;
      rho[i] = 0.85;
      rhoNear[i] = 0.0;
      dvx[i] = 0.0;
      dvy[i] = 0.0;
    }

    // 2. Build spatial grid & extract active neighbor pairs (r < h, j > i)
    spatialHash.build(px, py, n);
    const { head, next, cellX, cellY, cols, rows } = spatialHash;
    const h = KERNEL_RADIUS;
    const h2 = h * h;
    const invH = 1 / h;

    let pairCount = 0;
    for (let i = 0; i < n; i++) {
      const xi = px[i];
      const yi = py[i];
      const cx = cellX[i];
      const cy = cellY[i];

      const minCy = cy > 0 ? cy - 1 : 0;
      const maxCy = cy + 1 < rows ? cy + 1 : rows - 1;
      const minCx = cx > 0 ? cx - 1 : 0;
      const maxCx = cx + 1 < cols ? cx + 1 : cols - 1;

      for (let ny = minCy; ny <= maxCy; ny++) {
        const rowOffset = ny * cols;
        for (let nx = minCx; nx <= maxCx; nx++) {
          let j = head[rowOffset + nx];
          while (j !== -1) {
            if (j > i) {
              const dx = px[j] - xi;
              const dy = py[j] - yi;
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
                  const angle = ((i * 73856093) ^ (j * 19349663)) & 0xff;
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
                  pairI[pairCount] = i;
                  pairJ[pairCount] = j;
                  pairUx[pairCount] = ux;
                  pairUy[pairCount] = uy;
                  pairQ[pairCount] = q;
                  pairCount++;
                }
              }
            }
            j = next[j];
          }
        }
      }
    }

    // 3. Double-Density Relaxation (Clavet et al. 2005)
    for (let i = 0; i < n; i++) {
      // Smooth vena-contracta depressurization below nozzle orifice
      const jetExit = clamp((NOZZLE_TIP_Y - py[i]) / 52, 0, 1);
      const jetRamp = jetExit * jetExit;
      const rawP = K_STIFFNESS * (rho[i] - REST_DENSITY);
      pressure[i] =
        rawP > 0 ? rawP * jetRamp : rawP < MIN_PRESSURE ? MIN_PRESSURE : rawP;

      // Near-pressure engages strongly inside bulk pools to prevent compression/stacking
      // while allowing stretched falling streams to stay cohesive without spraying apart
      const u = clamp((rho[i] - 2.75) / 0.65, 0, 1);
      const bulk = u * u * (3 - 2 * u);
      nearPressure[i] = K_NEAR * jetRamp * (0.008 + 0.992 * bulk) * rhoNear[i];
    }

    const dispScale = 14.5 * subDt * subDt;
    const maxPairDisp = h * 0.28;

    for (let p = 0; p < pairCount; p++) {
      const i = pairI[p];
      const j = pairJ[p];
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

    // 4. Derive relaxed velocities from position change
    const invSubDt = 1 / subDt;
    for (let i = 0; i < n; i++) {
      vx[i] = (px[i] - prevX[i]) * invSubDt;
      vy[i] = (py[i] - prevY[i]) * invSubDt;
    }

    // 5. Light XSPH velocity smoothing + shear-driven local Beer-Lambert dye & recipe mixing
    for (let p = 0; p < pairCount; p++) {
      const i = pairI[p];
      const j = pairJ[p];
      const q = pairQ[p];

      const rvx = vx[j] - vx[i];
      const rvy = vy[j] - vy[i];
      const relSpeed = Math.sqrt(rvx * rvx + rvy * rvy);

      // Light XSPH velocity smoothing (0.035) keeps rest pools calm while preserving vortices
      const xsphWeight = XSPH_FACTOR * q;
      const ix = rvx * xsphWeight;
      const iy = rvy * xsphWeight;
      dvx[i] += ix;
      dvy[i] += iy;
      dvx[j] -= ix;
      dvy[j] -= iy;

      // Shear + glass-agitation local dye & recipe mixing:
      // Stationary pours preserve dramatic swirling plumes; moving/shaking the glass blends rapidly
      const glassAgitation = Math.min(
        (Math.abs(this.glass.vx) + Math.abs(this.glass.vy) * 0.5) * 0.014,
        4.2
      );
      let alpha = (0.32 + glassAgitation + 0.022 * relSpeed) * q * subDt;
      if (alpha > 0.22) alpha = 0.22;
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

    for (let i = 0; i < n; i++) {
      vx[i] += dvx[i];
      vy[i] += dvy[i];

      // Decay carbonation fizz slowly (~0.12/s) toward baseline carbonation shimmer
      if (fizz[i] > baseFizz[i]) {
        const decayed = fizz[i] - 0.12 * subDt;
        fizz[i] = decayed > baseFizz[i] ? decayed : baseFizz[i];
      }
    }

    // 6. Collide against 3 thick glass capsules + drip tray grate + clamp max speed
    this.resolveBoundaries(subDt);
  }

  private collideCapsule(
    i: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    fallbackNx: number,
    fallbackNy: number,
    gvx: number,
    gvy: number
  ): void {
    const abx = bx - ax;
    const aby = by - ay;
    const abLen2 = abx * abx + aby * aby;
    const px = this.px[i];
    const py = this.py[i];

    let t = ((px - ax) * abx + (py - ay) * aby) / abLen2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const cx = ax + t * abx;
    const cy = ay + t * aby;
    const dx = px - cx;
    const dy = py - cy;
    const dist2 = dx * dx + dy * dy;

    if (dist2 >= radius * radius) return;

    let nx: number;
    let ny: number;
    let pen: number;
    if (dist2 > 1e-8) {
      const dist = Math.sqrt(dist2);
      const invDist = 1 / dist;
      nx = dx * invDist;
      ny = dy * invDist;
      pen = radius - dist;
    } else {
      nx = fallbackNx;
      ny = fallbackNy;
      pen = radius;
    }

    this.px[i] = px + nx * pen;
    this.py[i] = py + ny * pen;

    const rvx = this.vx[i] - gvx;
    const rvy = this.vy[i] - gvy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const tx = -ny;
      const ty = nx;
      const vt = rvx * tx + rvy * ty;
      const newVn = -vn * WALL_RESTITUTION;
      let newVt = vt * (1 - WALL_FRICTION);
      // Damp thin-film Munroe squirting up steep walls while keeping bulk slosh & whip spills lively
      const upSpeed = newVt * ty;
      if (Math.abs(ny) < 0.5 && upSpeed > 180) {
        newVt *= (180 + (upSpeed - 180) * 0.55) / upSpeed;
      }
      this.vx[i] = gvx + nx * newVn + tx * newVt;
      this.vy[i] = gvy + ny * newVn + ty * newVt;
    }
  }

  private resolveBoundaries(subDt: number): void {
    const n = this.particleCount;
    const gx = this.glass.x;
    const gy = this.glass.y;
    const gvx = this.glass.vx;
    const gvy = this.glass.vy;

    // 3 thick line-segment capsules in world space:
    // 1) Left tapered wall
    const lax = gx - GLASS_BOTTOM_HALF_W - HALF_WALL;
    const lay = gy + HALF_WALL;
    const lbx = gx - GLASS_TOP_HALF_W - HALF_WALL;
    const lby = gy + GLASS_BASE_THICKNESS + GLASS_INNER_HEIGHT;

    // 2) Right tapered wall (symmetric)
    const rax = gx + GLASS_BOTTOM_HALF_W + HALF_WALL;
    const ray = gy + HALF_WALL;
    const rbx = gx + GLASS_TOP_HALF_W + HALF_WALL;
    const rby = lby;

    // 3) Thick bottom floor segment at gy + baseThick * 0.5
    const fax = gx - GLASS_BOTTOM_HALF_W - HALF_WALL * 0.5;
    const fay = gy + HALF_BASE;
    const fbx = gx + GLASS_BOTTOM_HALF_W + HALF_WALL * 0.5;
    const fby = fay;

    const glassBoundHalfW = GLASS_TOP_HALF_W + GLASS_WALL_THICKNESS + WALL_CAPSULE_RADIUS + 8;
    const glassBoundMinY = gy - FLOOR_CAPSULE_RADIUS - 6;
    const glassBoundMaxY = lby + WALL_CAPSULE_RADIUS + 6;
    const maxSpeed2 = MAX_PARTICLE_SPEED * MAX_PARTICLE_SPEED;

    for (let i = 0; i < n; i++) {
      const x0 = this.px[i];
      const y0 = this.py[i];

      // Broadphase AABB check against glass capsules
      if (
        Math.abs(x0 - gx) < glassBoundHalfW &&
        y0 > glassBoundMinY &&
        y0 < glassBoundMaxY
      ) {
        this.collideCapsule(
          i,
          fax,
          fay,
          fbx,
          fby,
          FLOOR_CAPSULE_RADIUS,
          0,
          1,
          gvx,
          gvy
        );
        this.collideCapsule(
          i,
          lax,
          lay,
          lbx,
          lby,
          WALL_CAPSULE_RADIUS,
          1,
          0,
          gvx,
          gvy
        );
        this.collideCapsule(
          i,
          rax,
          ray,
          rbx,
          rby,
          WALL_CAPSULE_RADIUS,
          -1,
          0,
          gvx,
          gvy
        );
      }

      // Drip tray grate & countertop collision + smooth grate slot draining
      const xi = this.px[i];
      const yi = this.py[i];
      const overTray = xi >= TRAY_LEFT_X && xi <= TRAY_RIGHT_X;

      if (overTray) {
        if (yi <= TRAY_DRAIN_THRESHOLD_Y) {
          // Periodic stainless grate slots drain slightly faster than grate bars
          const slotFactor = Math.sin(xi * 0.42) > 0.15 ? 3.1 : 1.9;
          this.life[i] -= slotFactor * subDt;
          // Let draining droplets sink gently through slots right at the end of life
          const sinkOffset = this.life[i] < 0.25 ? (0.25 - this.life[i]) * 14 : 0;
          const grateFloorY = TRAY_COLLISION_Y - sinkOffset;
          if (yi < grateFloorY) {
            this.py[i] = grateFloorY;
            if (this.vy[i] < 0) {
              this.vy[i] = -this.vy[i] * 0.16;
              this.vx[i] *= 0.88;
            }
          }
        }
      } else if (yi <= COUNTER_DRAIN_THRESHOLD_Y) {
        this.life[i] -= 2.2 * subDt;
        if (yi < COUNTER_COLLISION_Y) {
          this.py[i] = COUNTER_COLLISION_Y;
          if (this.vy[i] < 0) {
            this.vy[i] = -this.vy[i] * 0.14;
            this.vx[i] *= 0.86;
          }
        }
      }

      // Clamp extreme velocity spikes for unconditional solver safety
      const vxi = this.vx[i];
      const vyi = this.vy[i];
      const sp2 = vxi * vxi + vyi * vyi;
      if (sp2 > maxSpeed2) {
        const s = MAX_PARTICLE_SPEED / Math.sqrt(sp2);
        this.vx[i] = vxi * s;
        this.vy[i] = vyi * s;
      }
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
