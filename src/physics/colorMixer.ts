import {
  DrinkId,
  FluidParticle,
  GLASS_MAX_CAPACITY_PARTICLES,
  GlassLiquidSummary,
  GlassState,
  SimulationSnapshot,
} from '../types/simulation';
import {
  clamp01,
  createEmptyDrinkComposition,
  normalizedToRgb255,
  rgbToHex,
} from '../catalog/drinks';
import { SpatialHash } from './spatialHash';

export interface ColorMixerConfig {
  /** Smoothing radius h for Stage A local neighbor color diffusion (default 16.0) */
  readonly smoothingRadius: number;
  /** Stage A local SPH neighbor diffusion rate in s^-1 (default 5.5) */
  readonly localDiffusionRate: number;
  /** Stage B baseline homogenization rate in s^-1 (default 1.8) */
  readonly baseHomogenizationRate: number;
  /** Stage B active pouring turbulence boost in s^-1 (default 0.8) */
  readonly pourHomogenizationBoost: number;
  /** Stage B glass sloshing agitation boost factor in s^-1 (default 2.8) */
  readonly sloshHomogenizationBoost: number;
}

export const DEFAULT_COLOR_MIXER_CONFIG: ColorMixerConfig = {
  smoothingRadius: 16.0,
  localDiffusionRate: 5.5,
  baseHomogenizationRate: 1.8,
  pourHomogenizationBoost: 0.8,
  sloshHomogenizationBoost: 2.8,
};

export interface ColorUpdateOptions {
  readonly isPouring?: boolean;
  readonly glassVx?: number;
  readonly glassVy?: number;
  readonly dt?: number;
  readonly maxCapacityParticles?: number;
  readonly isOverflowing?: boolean;
}

/**
 * Two-stage fluid color mixing engine:
 * - Stage A: Local SPH neighbor color diffusion (visual pouring swirls & plumes)
 * - Stage B: Agitation-accelerated global homogenization toward exact volume-weighted RGB average
 */
export class ColorMixer {
  private readonly config: ColorMixerConfig;
  /** Chronological insertion order of distinct DrinkIds that have entered the glass since last empty/reset */
  private contributedHistory: DrinkId[] = [];
  /** Whether the glass has experienced rim overflow since last empty/reset */
  private overflowFlag = false;

  // Scratch buffers for order-independent Stage A + Stage B updates
  private nextR = new Float32Array(2048);
  private nextG = new Float32Array(2048);
  private nextB = new Float32Array(2048);
  private nextA = new Float32Array(2048);
  private pooledIndices: number[] = [];

  constructor(config: Partial<ColorMixerConfig> = {}) {
    this.config = { ...DEFAULT_COLOR_MIXER_CONFIG, ...config };
  }

  /** Record that a particle of `drinkId` has been captured inside the glass pool */
  public recordDrinkContribution(drinkId: DrinkId): void {
    if (!this.contributedHistory.includes(drinkId)) {
      this.contributedHistory.push(drinkId);
    }
  }

  /** Mark whether the glass is currently overflowing or has overflowed at full capacity */
  public setOverflowing(isOverflowing: boolean): void {
    if (isOverflowing) {
      this.overflowFlag = true;
    }
  }

  /** Reset color history and overflow state when glass is emptied or simulation resets */
  public reset(): void {
    this.contributedHistory = [];
    this.overflowFlag = false;
  }

  /**
   * Perform Stage A (local SPH neighbor color diffusion) and Stage B
   * (agitation-accelerated global homogenization toward exact volume-weighted mean)
   * on all pooled particles, and return the updated GlassLiquidSummary.
   */
  public stepAndSummarize(
    particles: readonly FluidParticle[],
    spatialHash: SpatialHash,
    glass: Readonly<Pick<GlassState, 'vx' | 'vy' | 'maxCapacityParticles'>>,
    isPouring: boolean,
    dt: number,
  ): GlassLiquidSummary {
    const nTotal = particles.length;
    if (this.nextR.length < nTotal) {
      const cap = Math.max(nTotal * 2, 2048);
      this.nextR = new Float32Array(cap);
      this.nextG = new Float32Array(cap);
      this.nextB = new Float32Array(cap);
      this.nextA = new Float32Array(cap);
    }

    this.pooledIndices.length = 0;
    let sumInitR = 0;
    let sumInitG = 0;
    let sumInitB = 0;
    let sumInitA = 0;
    let sumCarb = 0;
    let sumSpeed = 0;

    const counts = createEmptyDrinkComposition();

    for (let i = 0; i < nTotal; i++) {
      const p = particles[i];
      if (p.state === 'pooled') {
        this.pooledIndices.push(i);
        sumInitR += p.initR;
        sumInitG += p.initG;
        sumInitB += p.initB;
        sumInitA += p.initA;
        sumCarb += p.carbonation;
        sumSpeed += Math.hypot(p.vx, p.vy);
        counts[p.drinkId] = (counts[p.drinkId] ?? 0) + 1;
        if (!this.contributedHistory.includes(p.drinkId)) {
          this.contributedHistory.push(p.drinkId);
        }
      }
    }

    const pooledCount = this.pooledIndices.length;
    if (pooledCount === 0) {
      this.contributedHistory.length = 0;
      this.overflowFlag = false;
      return this.createEmptySummary();
    }

    const invCount = 1.0 / pooledCount;
    const targetR = sumInitR * invCount;
    const targetG = sumInitG * invCount;
    const targetB = sumInitB * invCount;
    const targetA = sumInitA * invCount;
    const effectiveCarbonation = clamp01(sumCarb * invCount);

    // Perform Stage A + Stage B if dt > 0
    if (Number.isFinite(dt) && dt > 0) {
      const h = this.config.smoothingRadius;
      const glassSpeed = Math.hypot(glass.vx, glass.vy);
      const avgPoolSpeed = sumSpeed * invCount;
      const agitation = Math.min(
        3.5,
        glassSpeed / 90.0 + Math.max(0, avgPoolSpeed - 15.0) / 160.0,
      );

      const kHomog =
        this.config.baseHomogenizationRate +
        (isPouring ? this.config.pourHomogenizationBoost : 0) +
        this.config.sloshHomogenizationBoost * agitation;
      const alphaHomog = 1.0 - Math.exp(-kHomog * dt);

      for (let idx = 0; idx < pooledCount; idx++) {
        const i = this.pooledIndices[idx];
        const pi = particles[i];

        // Stage A: Local SPH neighbor color diffusion
        let wSum = 0;
        let nbR = 0;
        let nbG = 0;
        let nbB = 0;
        let nbA = 0;

        spatialHash.forEachNeighbor(
          i,
          pi.x,
          pi.y,
          h,
          particles,
          (j, _dx, _dy, distSq) => {
            const pj = particles[j];
            if (pj.state !== 'pooled') return;
            const dist = Math.sqrt(distSq);
            if (dist >= h) return;

            const wKernel = 1.0 - dist / h;
            const relSpeed = Math.hypot(pj.vx - pi.vx, pj.vy - pi.vy);
            const vBoost = Math.min(2.5, 1.0 + relSpeed / 150.0);
            const w = wKernel * vBoost;

            wSum += w;
            nbR += pj.r * w;
            nbG += pj.g * w;
            nbB += pj.b * w;
            nbA += pj.a * w;
          },
        );

        let rA = pi.r;
        let gA = pi.g;
        let bA = pi.b;
        let aA = pi.a;

        if (wSum > 1e-6) {
          const invW = 1.0 / wSum;
          const alphaLocal = Math.min(
            0.4,
            this.config.localDiffusionRate * dt * Math.min(1.0, wSum * 0.4),
          );
          rA += alphaLocal * (nbR * invW - rA);
          gA += alphaLocal * (nbG * invW - gA);
          bA += alphaLocal * (nbB * invW - bA);
          aA += alphaLocal * (nbA * invW - aA);
        }

        // Stage B: Global agitation-accelerated homogenization toward exact volume-weighted target
        this.nextR[i] = rA + alphaHomog * (targetR - rA);
        this.nextG[i] = gA + alphaHomog * (targetG - gA);
        this.nextB[i] = bA + alphaHomog * (targetB - bA);
        this.nextA[i] = aA + alphaHomog * (targetA - aA);
      }

      // Mean-conservation projection so spatial mean equals exact volume-weighted target
      let meanR = 0;
      let meanG = 0;
      let meanB = 0;
      let meanA = 0;
      for (let idx = 0; idx < pooledCount; idx++) {
        const i = this.pooledIndices[idx];
        meanR += this.nextR[i];
        meanG += this.nextG[i];
        meanB += this.nextB[i];
        meanA += this.nextA[i];
      }
      const corrR = targetR - meanR * invCount;
      const corrG = targetG - meanG * invCount;
      const corrB = targetB - meanB * invCount;
      const corrA = targetA - meanA * invCount;

      for (let idx = 0; idx < pooledCount; idx++) {
        const i = this.pooledIndices[idx];
        const p = particles[i];
        p.r = clamp01(this.nextR[i] + corrR);
        p.g = clamp01(this.nextG[i] + corrG);
        p.b = clamp01(this.nextB[i] + corrB);
        p.a = clamp01(this.nextA[i] + corrA);
      }
    }

    return this.computeSummary(
      particles,
      glass.maxCapacityParticles,
      this.overflowFlag,
    );
  }

  /**
   * Convenience wrapper supporting options object for updating colors.
   */
  public updateColors(
    particles: readonly FluidParticle[],
    spatialHash: SpatialHash,
    options: ColorUpdateOptions = {},
  ): GlassLiquidSummary {
    if (options.isOverflowing) {
      this.overflowFlag = true;
    }
    return this.stepAndSummarize(
      particles,
      spatialHash,
      {
        vx: options.glassVx ?? 0,
        vy: options.glassVy ?? 0,
        maxCapacityParticles:
          options.maxCapacityParticles ?? GLASS_MAX_CAPACITY_PARTICLES,
      },
      options.isPouring ?? false,
      options.dt ?? 1 / 60,
    );
  }

  /**
   * Computes current `GlassLiquidSummary` from `particles` without advancing time.
   */
  public computeSummary(
    particles: readonly FluidParticle[],
    maxCapacityParticles = GLASS_MAX_CAPACITY_PARTICLES,
    isOverflowing = this.overflowFlag,
  ): GlassLiquidSummary {
    if (isOverflowing) {
      this.overflowFlag = true;
    }

    this.pooledIndices.length = 0;
    let sumInitR = 0;
    let sumInitG = 0;
    let sumInitB = 0;
    let sumInitA = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    let sumCarb = 0;

    const counts = createEmptyDrinkComposition();

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.state === 'pooled') {
        this.pooledIndices.push(i);
        sumInitR += p.initR;
        sumInitG += p.initG;
        sumInitB += p.initB;
        sumInitA += p.initA;
        sumR += p.r;
        sumG += p.g;
        sumB += p.b;
        sumA += p.a;
        sumCarb += p.carbonation;
        counts[p.drinkId] = (counts[p.drinkId] ?? 0) + 1;
        if (!this.contributedHistory.includes(p.drinkId)) {
          this.contributedHistory.push(p.drinkId);
        }
      }
    }

    const pooledCount = this.pooledIndices.length;
    if (pooledCount === 0) {
      this.contributedHistory.length = 0;
      this.overflowFlag = false;
      return this.createEmptySummary();
    }

    const invCount = 1.0 / pooledCount;
    const targetR = clamp01(sumInitR * invCount);
    const targetG = clamp01(sumInitG * invCount);
    const targetB = clamp01(sumInitB * invCount);
    const targetA = clamp01(sumInitA * invCount);

    const meanR = clamp01(sumR * invCount);
    const meanG = clamp01(sumG * invCount);
    const meanB = clamp01(sumB * invCount);
    const meanA = clamp01(sumA * invCount);

    let sqDiffSum = 0;
    for (let idx = 0; idx < pooledCount; idx++) {
      const p = particles[this.pooledIndices[idx]];
      const dr = p.r - meanR;
      const dg = p.g - meanG;
      const db = p.b - meanB;
      sqDiffSum += dr * dr + dg * dg + db * db;
    }

    let mixingVariance = sqDiffSum * invCount;
    if (mixingVariance < 1e-7) {
      mixingVariance = 0;
      for (let idx = 0; idx < pooledCount; idx++) {
        const p = particles[this.pooledIndices[idx]];
        p.r = targetR;
        p.g = targetG;
        p.b = targetB;
        p.a = targetA;
      }
    }

    const mixedColorRGBA: readonly [number, number, number, number] = [
      meanR,
      meanG,
      meanB,
      meanA,
    ];
    const averageColorRGB = normalizedToRgb255(mixedColorRGBA);
    const mixedColorHex = rgbToHex(averageColorRGB);

    const drinkComposition: Record<DrinkId, number> = {
      'coca-cola': counts['coca-cola'] * invCount,
      'fanta': counts['fanta'] * invCount,
      'sprite': counts['sprite'] * invCount,
      'cherry': counts['cherry'] * invCount,
      'berry-blue': counts['berry-blue'] * invCount,
    };

    const colorHistory = this.contributedHistory.filter((id) => counts[id] > 0);
    const fillLevel = clamp01(pooledCount / Math.max(1, maxCapacityParticles));
    const effectiveOverflow =
      this.overflowFlag || pooledCount >= maxCapacityParticles;
    const effectiveCarbonation = clamp01(sumCarb * invCount);

    return {
      pooledParticleCount: pooledCount,
      fillLevel,
      fillRatio: fillLevel,
      isOverflowing: effectiveOverflow,
      mixedColorRGBA,
      averageColorRGB,
      mixedColorHex,
      drinkComposition,
      colorHistory,
      mixingVariance,
      effectiveCarbonation,
    };
  }

  public createEmptySummary(): GlassLiquidSummary {
    return {
      pooledParticleCount: 0,
      fillLevel: 0,
      fillRatio: 0,
      isOverflowing: false,
      mixedColorRGBA: [0, 0, 0, 0],
      averageColorRGB: [0, 0, 0],
      mixedColorHex: null,
      drinkComposition: createEmptyDrinkComposition(),
      colorHistory: [],
      mixingVariance: 0,
      effectiveCarbonation: 0,
    };
  }
}

/**
 * Helper to construct `SimulationSnapshot['fluid']` from `GlassLiquidSummary`
 */
export function toFluidTelemetry(
  liquid: GlassLiquidSummary,
): SimulationSnapshot['fluid'] {
  return {
    ...liquid,
    particleOrMassCount: liquid.pooledParticleCount,
    mixingEntropyOrVariance: liquid.mixingVariance,
  };
}
