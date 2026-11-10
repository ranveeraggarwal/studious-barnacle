import {
  BubbleParticle,
  DRIP_TRAY_TOP_Y,
  DrinkId,
  FluidParticle,
  FluidRenderState,
  GlassLiquidSummary,
  GlassScreenRect,
  GlassState,
  SimulationSnapshot,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../types/simulation';
import { DRINK_IDS, getDrinkSpec, isValidDrinkId } from '../catalog/drinks';
import { SpatialHash } from './spatialHash';
import { GlassCollider } from './glassCollider';
import { ColorMixer, toFluidTelemetry } from './colorMixer';

const DEFAULT_SEED = 0x50da2026;
const SUBSTEPS = 2;
const GRAVITY_Y = -720.0;
const POOL_GRAVITY_Y = -420.0;
const SMOOTHING_RADIUS = 16.0;
const MIN_PARTICLE_DIST = 7.4;
const DRIP_TRAY_TRIGGER_Y = 52.0;
const DRIP_TRAY_FLOOR_Y = 16.0;
const MAX_PARTICLES = 1800;

function createSeededRandom(seed = DEFAULT_SEED): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 2D SPH fluid simulation world managing drink nozzle emitters, spatial hash neighbor queries,
 * movable tapered glass collisions, two-stage color mixing, carbonation bubbles, and drip tray draining.
 */
export class FluidWorld {
  public readonly worldWidth = WORLD_WIDTH;
  public readonly worldHeight = WORLD_HEIGHT;
  public readonly spatialHash: SpatialHash;
  public readonly glassCollider: GlassCollider;
  public readonly colorMixer: ColorMixer;

  private readonly initialSeed: number;
  private random: () => number;
  private particles: FluidParticle[] = [];
  private bubbles: BubbleParticle[] = [];
  private activeDrinks = new Set<DrinkId>();
  private frameCount = 0;
  private webglVersion: 1 | 2 = 2;
  private cachedLiquidSummary: GlassLiquidSummary;

  constructor(seed = DEFAULT_SEED) {
    this.initialSeed = seed;
    this.random = createSeededRandom(seed);
    this.spatialHash = new SpatialHash(WORLD_WIDTH, WORLD_HEIGHT, SMOOTHING_RADIUS);
    this.glassCollider = new GlassCollider();
    this.colorMixer = new ColorMixer({ smoothingRadius: SMOOTHING_RADIUS });
    this.cachedLiquidSummary = this.colorMixer.createEmptySummary();
  }

  public startPouring(drinkId: DrinkId): void {
    if (!isValidDrinkId(drinkId)) {
      return;
    }
    this.activeDrinks.add(drinkId);
  }

  public stopPouring(drinkId?: DrinkId): void {
    if (drinkId === undefined) {
      this.activeDrinks.clear();
    } else {
      this.activeDrinks.delete(drinkId);
    }
  }

  public isPouring(drinkId?: DrinkId): boolean {
    if (drinkId === undefined) {
      return this.activeDrinks.size > 0;
    }
    return this.activeDrinks.has(drinkId);
  }

  public getActiveDrinks(): ReadonlyArray<DrinkId> {
    return DRINK_IDS.filter((id) => this.activeDrinks.has(id));
  }

  /**
   * Moves glass center to `x` (world `[120..680]` if `> 1.0`, or normalized `[0..1]` if `<= 1.0`)
   * and optional `y`, co-translating interior pooled fluid and bubbles.
   */
  public moveGlassTo(x: number, y?: number): void {
    const { dx, dy } = this.glassCollider.moveGlassTo(
      x,
      y,
      this.particles,
      1 / 60,
      this.activeDrinks.size === 0,
    );
    if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
      for (let i = 0; i < this.bubbles.length; i++) {
        this.bubbles[i].x += dx;
        this.bubbles[i].y += dy;
      }
    }
  }

  public setGlassDragging(isDragging: boolean): void {
    this.glassCollider.setDragging(isDragging);
  }

  public updateGlassScreenRect(rect: GlassScreenRect): void {
    this.glassCollider.updateScreenRect(rect);
  }

  /**
   * Empties all liquid and bubbles while preserving the current glass position.
   */
  public emptyGlass(): void {
    this.particles.length = 0;
    this.bubbles.length = 0;
    this.spatialHash.clear();
    this.glassCollider.clearOverflow();
    this.colorMixer.reset();
    this.cachedLiquidSummary = this.colorMixer.createEmptySummary();
  }

  /**
   * Resets simulation to initial state: stops pouring, clears particles/bubbles, and centers glass at (400, 145).
   */
  public reset(): void {
    this.activeDrinks.clear();
    this.particles.length = 0;
    this.bubbles.length = 0;
    this.frameCount = 0;
    this.random = createSeededRandom(this.initialSeed);
    this.spatialHash.clear();
    this.glassCollider.reset();
    this.colorMixer.reset();
    this.cachedLiquidSummary = this.colorMixer.createEmptySummary();
  }

  /**
   * Advances physics & color mixing deterministically by `count` frames (default 1, `dtSeconds = 1/60`).
   */
  public stepFrames(count = 1, dtSeconds = 1 / 60): void {
    const steps = Math.max(0, Math.floor(count));
    const frameDt = dtSeconds > 0 && Number.isFinite(dtSeconds) ? dtSeconds : 1 / 60;

    for (let f = 0; f < steps; f++) {
      this.stepSingleFrame(frameDt);
    }
  }

  private stepSingleFrame(dt: number): void {
    this.frameCount++;

    // 1. Emit falling stream particles from all active drink nozzles
    this.emitNozzleStreams();

    // 2. Run 2D SPH physics substeps
    const subDt = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      this.stepSubframe(subDt);
    }

    // 3. Rebuild spatial hash and execute two-stage color mixing & summary computation
    this.spatialHash.rebuild(this.particles);
    if (this.glassCollider.isOverflowing) {
      this.colorMixer.setOverflowing(true);
    }
    this.cachedLiquidSummary = this.colorMixer.stepAndSummarize(
      this.particles,
      this.spatialHash,
      this.glassCollider.state,
      this.activeDrinks.size > 0,
      dt,
    );

    // 4. Update buoyant CO2 carbonation bubbles and surface foam
    this.updateBubbles(dt);

    // 5. Prune drained drip-tray particles
    this.pruneDrainedParticles();
  }

  private emitNozzleStreams(): void {
    if (this.activeDrinks.size === 0) return;

    for (let d = 0; d < DRINK_IDS.length; d++) {
      const drinkId = DRINK_IDS[d];
      if (!this.activeDrinks.has(drinkId)) continue;

      const spec = getDrinkSpec(drinkId);
      // Emit 3 particles per frame (180 particles/sec per active nozzle)
      for (let k = 0; k < 3; k++) {
        const jitterX = (this.random() - 0.5) * 3.6;
        const x = spec.nozzleX + jitterX;
        const y = spec.nozzleY - 4.0 - k * 4.5;
        const vx = (this.random() - 0.5) * 8.0;
        const vy = -295.0 - k * 6.0;
        const [r, g, b, a] = spec.color;

        this.particles.push({
          x,
          y,
          vx,
          vy,
          r,
          g,
          b,
          a,
          initR: r,
          initG: g,
          initB: b,
          initA: a,
          drinkId,
          carbonation: spec.carbonation,
          density: 1.0,
          pressure: 0.0,
          state: 'falling',
          age: 0.0,
        });
      }
    }
  }

  private stepSubframe(subDt: number): void {
    const n = this.particles.length;
    if (n === 0) {
      this.glassCollider.decayVelocity(subDt);
      return;
    }

    this.spatialHash.rebuild(this.particles);

    // Pass A: Compute SPH density & pressure for pooled particles
    const h = SMOOTHING_RADIUS;
    const invH = 1.0 / h;

    for (let i = 0; i < n; i++) {
      const pi = this.particles[i];
      if (pi.state !== 'pooled') {
        pi.density = 1.0;
        pi.pressure = 0.0;
        continue;
      }

      let density = 1.0;
      this.spatialHash.forEachNeighbor(
        i,
        pi.x,
        pi.y,
        h,
        this.particles,
        (j, _dx, _dy, distSq) => {
          const pj = this.particles[j];
          if (pj.state !== 'pooled') return;
          const dist = Math.sqrt(distSq);
          const q = 1.0 - dist * invH;
          if (q > 0) {
            density += q * q;
          }
        },
      );

      pi.density = density;
      pi.pressure = 120.0 * (density - 1.5);
    }

    // Pass B: Integrate forces & pairwise hydrostatic packing
    const isSettling =
      this.activeDrinks.size === 0 &&
      Math.abs(this.glassCollider.state.vx) < 5.0 &&
      Math.abs(this.glassCollider.state.vy) < 5.0;

    for (let i = 0; i < n; i++) {
      const pi = this.particles[i];
      pi.age += subDt;

      if (pi.state === 'falling') {
        pi.vy += GRAVITY_Y * subDt;
        pi.vx *= 0.992;
        pi.x += pi.vx * subDt;
        pi.y += pi.vy * subDt;

        if (
          pi.y < DRIP_TRAY_TRIGGER_Y &&
          !this.glassCollider.isInsideGlass(pi.x, pi.y)
        ) {
          pi.state = 'spilled';
        }
      } else if (pi.state === 'pooled') {
        let fx = 0.0;
        let fy = POOL_GRAVITY_Y;
        let relaxX = 0.0;
        let relaxY = 0.0;

        this.spatialHash.forEachNeighbor(
          i,
          pi.x,
          pi.y,
          h,
          this.particles,
          (j, dx, dy, distSq) => {
            const pj = this.particles[j];
            if (pj.state !== 'pooled') return;

            const dist = Math.sqrt(distSq);
            if (dist < 1e-4) {
              // Deterministic tiny separation if coincident
              const angle = ((i * 73 + j * 31) % 360) * (Math.PI / 180);
              relaxX += Math.cos(angle) * 0.5;
              relaxY += Math.sin(angle) * 0.5;
              return;
            }

            const nx = dx / dist; // unit vector from i to j
            const ny = dy / dist;
            const q = 1.0 - dist * invH;

            // SPH symmetric pressure + viscosity force
            const avgPressure = 0.5 * (pi.pressure + pj.pressure);
            const fPress = -avgPressure * q;
            const viscX = (pj.vx - pi.vx) * 0.18 * q;
            const viscY = (pj.vy - pi.vy) * 0.18 * q;

            fx += nx * fPress + viscX;
            fy += ny * fPress + viscY;

            // Minimum-distance position relaxation for uniform hydrostatic filling
            if (dist < MIN_PARTICLE_DIST) {
              const overlap = 0.22 * (MIN_PARTICLE_DIST - dist);
              relaxX -= nx * overlap;
              relaxY -= ny * overlap;
            }
          },
        );

        pi.vx += fx * subDt;
        pi.vy += fy * subDt;

        const damping = isSettling ? 0.955 : 0.982;
        pi.vx *= damping;
        pi.vy *= damping;

        pi.vx = Math.max(-380, Math.min(380, pi.vx));
        pi.vy = Math.max(-380, Math.min(380, pi.vy));

        pi.x += pi.vx * subDt + relaxX;
        pi.y += pi.vy * subDt + relaxY;
      } else {
        // 'spilled'
        pi.vy += GRAVITY_Y * subDt;
        pi.x += pi.vx * subDt;
        pi.y += pi.vy * subDt;

        if (pi.y <= DRIP_TRAY_FLOOR_Y) {
          pi.y = DRIP_TRAY_FLOOR_Y;
          pi.vy = 0;
          pi.vx *= 0.85;
          if (pi.age > 1.8) {
            pi.a = Math.max(0, pi.a - subDt * 0.9);
          }
        }
        // Keep within world horizontal bounds
        if (pi.x < 10) {
          pi.x = 10;
          pi.vx = Math.abs(pi.vx) * 0.5;
        } else if (pi.x > WORLD_WIDTH - 10) {
          pi.x = WORLD_WIDTH - 10;
          pi.vx = -Math.abs(pi.vx) * 0.5;
        }
      }
    }

    // Pass C: Resolve collisions against tapered glass walls/floor and rim overflow
    this.glassCollider.resolveCollisions(
      this.particles,
      subDt,
      (drinkId) => this.colorMixer.recordDrinkContribution(drinkId),
      () => this.colorMixer.setOverflowing(true),
    );

    // Pass D: Decay instantaneous glass velocity
    this.glassCollider.decayVelocity(subDt);
  }

  private updateBubbles(dt: number): void {
    const summary = this.cachedLiquidSummary;
    const glass = this.glassCollider.state;
    const bottomY = this.glassCollider.bottomY;
    const rimY = this.glassCollider.rimY;

    if (summary.pooledParticleCount === 0) {
      this.bubbles.length = 0;
      return;
    }

    const poolTopY =
      bottomY + Math.max(12, summary.fillLevel * (glass.worldHeight - 8));

    if (
      summary.pooledParticleCount >= 8 &&
      summary.effectiveCarbonation > 0.05 &&
      this.bubbles.length < 100
    ) {
      const spawnCount = summary.effectiveCarbonation > 0.6 ? 2 : 1;
      for (let s = 0; s < spawnCount; s++) {
        if (this.bubbles.length >= 100) break;
        const spawnY =
          bottomY + 8 + this.random() * Math.max(6, (poolTopY - bottomY) * 0.7);
        const halfW = Math.max(10, this.glassCollider.halfWidthAt(spawnY) - 8);
        const spawnX = glass.x + (this.random() - 0.5) * 2.0 * halfW;

        this.bubbles.push({
          x: spawnX,
          y: spawnY,
          vx: (this.random() - 0.5) * 10,
          vy: 55 + this.random() * 25,
          radius: 1.8 + this.random() * 2.2,
          alpha: Math.min(0.85, 0.35 + summary.effectiveCarbonation * 0.5),
          isFoam: false,
        });
      }
    }

    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      if (!b.isFoam) {
        b.y += b.vy * dt;
        b.x += (b.vx + Math.sin(b.y * 0.15) * 12) * dt;
        if (b.y >= poolTopY - 3) {
          b.isFoam = true;
          b.y = poolTopY;
          b.vy = 0;
          b.radius = Math.min(4.5, b.radius * 1.25);
        }
      } else {
        b.y += (poolTopY - b.y) * Math.min(1, dt * 10);
        b.alpha -= dt * 0.45;
      }

      const halfW = Math.max(8, this.glassCollider.halfWidthAt(b.y) - 6);
      b.x = Math.max(glass.x - halfW, Math.min(glass.x + halfW, b.x));

      if (b.alpha <= 0.03 || b.y > rimY + 10) {
        this.bubbles.splice(i, 1);
      }
    }
  }

  private pruneDrainedParticles(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (
        p.state === 'spilled' &&
        p.y <= DRIP_TRAY_TOP_Y &&
        p.a <= 0.04 &&
        p.age > 2.4
      ) {
        this.particles.splice(i, 1);
      }
    }

    // Safety cap on total particles by pruning oldest spilled particles first
    if (this.particles.length > MAX_PARTICLES) {
      let toRemove = this.particles.length - MAX_PARTICLES;
      for (let i = 0; i < this.particles.length && toRemove > 0; i++) {
        if (this.particles[i].state === 'spilled') {
          this.particles.splice(i, 1);
          i--;
          toRemove--;
        }
      }
    }
  }

  public getParticles(): ReadonlyArray<FluidParticle> {
    return this.particles;
  }

  public getBubbles(): ReadonlyArray<BubbleParticle> {
    return this.bubbles;
  }

  public getGlassState(): Readonly<GlassState> {
    return this.glassCollider.getState();
  }

  public getLiquidSummary(): GlassLiquidSummary {
    return this.cachedLiquidSummary;
  }

  public getFrameCount(): number {
    return this.frameCount;
  }

  public setWebGLVersion(version: 1 | 2): void {
    this.webglVersion = version;
  }

  public getRenderState(): FluidRenderState {
    return {
      particles: this.particles,
      bubbles: this.bubbles,
      glass: this.glassCollider.getState(),
      liquid: this.cachedLiquidSummary,
      activeNozzles: this.getActiveDrinks(),
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
    };
  }

  public getSnapshot(): SimulationSnapshot {
    let fallingCount = 0;
    let pooledCount = 0;
    let spilledCount = 0;

    for (let i = 0; i < this.particles.length; i++) {
      const st = this.particles[i].state;
      if (st === 'falling') fallingCount++;
      else if (st === 'pooled') pooledCount++;
      else spilledCount++;
    }

    const active = this.getActiveDrinks();
    const liquid = this.cachedLiquidSummary;
    const glass = this.glassCollider.getState();

    return {
      isReady: true,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      activeNozzles: active,
      activeDrinks: active,
      totalParticleCount: this.particles.length,
      fallingParticleCount: fallingCount,
      pooledParticleCount: pooledCount,
      spilledParticleCount: spilledCount,
      bubbleCount: this.bubbles.length,
      glass: {
        ...glass,
        screenRect: { ...glass.screenRect },
      },
      liquid,
      fluid: toFluidTelemetry(liquid),
      webglVersion: this.webglVersion,
      frameCount: this.frameCount,
    };
  }
}
