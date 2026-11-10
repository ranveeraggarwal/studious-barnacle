import {
  DEFAULT_GLASS_X,
  DEFAULT_GLASS_Y,
  DrinkId,
  FluidParticle,
  GLASS_BOTTOM_HALF_WIDTH,
  GLASS_MAX_CAPACITY_PARTICLES,
  GLASS_MAX_X,
  GLASS_MAX_Y,
  GLASS_MIN_X,
  GLASS_MIN_Y,
  GLASS_TOP_HALF_WIDTH,
  GLASS_WORLD_HEIGHT,
  GlassScreenRect,
  GlassState,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../types/simulation';
import { clamp01 } from '../catalog/drinks';

export const PARTICLE_COLLISION_RADIUS = 5.0;
export const EXTERIOR_WALL_THICKNESS = 8.0;

const WALL_DX = GLASS_TOP_HALF_WIDTH - GLASS_BOTTOM_HALF_WIDTH; // 20
const WALL_DY = GLASS_WORLD_HEIGHT; // 180
const WALL_LEN = Math.hypot(WALL_DX, WALL_DY);
const LEFT_NORMAL_X = WALL_DY / WALL_LEN; // +0.99388
const LEFT_NORMAL_Y = WALL_DX / WALL_LEN; // +0.11043
const RIGHT_NORMAL_X = -WALL_DY / WALL_LEN; // -0.99388
const RIGHT_NORMAL_Y = WALL_DX / WALL_LEN; // +0.11043

function computeDefaultScreenRect(
  x: number,
  y: number,
  topHalfWidth: number,
  worldHeight: number,
): GlassScreenRect {
  return {
    x: x - topHalfWidth,
    y: WORLD_HEIGHT - (y + worldHeight * 0.5),
    width: topHalfWidth * 2,
    height: worldHeight,
  };
}

/**
 * Movable tapered U-shaped rigid-body glass collider.
 * Handles coordinate normalization/clamping, interior stream capture, exterior deflection,
 * fluid co-translation + sloshing velocity impulses, and rim overflow spilling.
 */
export class GlassCollider {
  public readonly state: GlassState;
  private overflowActive = false;
  private hasCustomScreenRect = false;

  constructor() {
    this.state = {
      x: DEFAULT_GLASS_X,
      y: DEFAULT_GLASS_Y,
      normX: DEFAULT_GLASS_X / WORLD_WIDTH,
      normY: DEFAULT_GLASS_Y / WORLD_HEIGHT,
      width: (GLASS_TOP_HALF_WIDTH * 2) / WORLD_WIDTH,
      height: GLASS_WORLD_HEIGHT / WORLD_HEIGHT,
      vx: 0,
      vy: 0,
      bottomHalfWidth: GLASS_BOTTOM_HALF_WIDTH,
      topHalfWidth: GLASS_TOP_HALF_WIDTH,
      worldHeight: GLASS_WORLD_HEIGHT,
      maxCapacityParticles: GLASS_MAX_CAPACITY_PARTICLES,
      isDragging: false,
      screenRect: computeDefaultScreenRect(
        DEFAULT_GLASS_X,
        DEFAULT_GLASS_Y,
        GLASS_TOP_HALF_WIDTH,
        GLASS_WORLD_HEIGHT,
      ),
    };
  }

  public getState(): Readonly<GlassState> {
    return this.state;
  }

  public get bottomY(): number {
    return this.state.y - this.state.worldHeight * 0.5;
  }

  public get rimY(): number {
    return this.state.y + this.state.worldHeight * 0.5;
  }

  public get isOverflowing(): boolean {
    return this.overflowActive;
  }

  public clearOverflow(): void {
    this.overflowActive = false;
  }

  /**
   * Computes interior horizontal half-width at world height `worldY`.
   * Linearly interpolates between `bottomHalfWidth` (55) at `bottomY` and `topHalfWidth` (75) at `rimY`.
   */
  public halfWidthAt(worldY: number): number {
    const t = clamp01((worldY - this.bottomY) / this.state.worldHeight);
    return (
      this.state.bottomHalfWidth +
      t * (this.state.topHalfWidth - this.state.bottomHalfWidth)
    );
  }

  /** Alias for `halfWidthAt` */
  public halfWidthAtY(worldY: number): number {
    return this.halfWidthAt(worldY);
  }

  /**
   * Returns true if world coordinate `(x, y)` lies inside the tapered glass interior.
   */
  public isInsideGlass(x: number, y: number, margin = 0): boolean {
    if (y < this.bottomY + margin || y > this.rimY - margin) {
      return false;
    }
    const halfW = this.halfWidthAt(y) - margin;
    return Math.abs(x - this.state.x) <= halfW;
  }

  /**
   * Moves glass center to `x` (world `[120..680]` if `> 1.0`, or normalized `[0..1]` if `0 <= x <= 1.0`)
   * and optional `y` (world `[135..340]` if `> 1.0`, or normalized `[0..1]` if `0 <= y <= 1.0`).
   * Co-translates pooled particles and imparts sloshing velocity impulses.
   */
  public moveGlassTo(
    x: number,
    y?: number,
    particles?: FluidParticle[],
    dt = 1 / 60,
    coTranslateFalling = false,
  ): { dx: number; dy: number } {
    if (!Number.isFinite(x)) {
      return { dx: 0, dy: 0 };
    }

    const rawWorldX = x >= 0 && x <= 1.0 ? x * WORLD_WIDTH : x;
    const targetX = Math.max(GLASS_MIN_X, Math.min(GLASS_MAX_X, rawWorldX));

    let targetY = this.state.y;
    if (y !== undefined && Number.isFinite(y)) {
      const rawWorldY = y >= 0 && y <= 1.0 ? y * WORLD_HEIGHT : y;
      targetY = Math.max(GLASS_MIN_Y, Math.min(GLASS_MAX_Y, rawWorldY));
    }

    const prevX = this.state.x;
    const dx = targetX - this.state.x;
    const dy = targetY - this.state.y;

    this.state.x = targetX;
    this.state.y = targetY;
    this.state.normX = targetX / WORLD_WIDTH;
    this.state.normY = targetY / WORLD_HEIGHT;
    this.state.width = (this.state.topHalfWidth * 2) / WORLD_WIDTH;
    this.state.height = this.state.worldHeight / WORLD_HEIGHT;

    if (!this.hasCustomScreenRect) {
      this.state.screenRect = computeDefaultScreenRect(
        targetX,
        targetY,
        this.state.topHalfWidth,
        this.state.worldHeight,
      );
    }

    const effDt = Number.isFinite(dt) && dt > 0 ? Math.max(dt, 1 / 240) : 1 / 60;
    this.state.vx = Math.max(-900, Math.min(900, dx / effDt));
    this.state.vy = Math.max(-900, Math.min(900, dy / effDt));

    if (particles && (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4)) {
      const bottomY = this.bottomY;
      const rimY = this.rimY;
      const clampedDx = Math.max(-45, Math.min(45, dx));
      const clampedDy = Math.max(-30, Math.min(30, dy));
      const captureHalfW = this.state.topHalfWidth - 2.0;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.state === 'falling' && coTranslateFalling) {
          if (Math.abs(p.x - prevX) <= captureHalfW && p.y >= bottomY) {
            p.x += dx;
          }
          continue;
        }
        if (p.state !== 'pooled') continue;

        // Co-translate with glass
        p.x += dx;
        p.y += dy;

        const hNorm = clamp01((p.y - bottomY) / this.state.worldHeight);
        const halfW = Math.max(10, this.halfWidthAt(p.y) - PARTICLE_COLLISION_RADIUS);
        const xNorm = Math.max(-1, Math.min(1, (p.x - targetX) / halfW));

        // Shear slosh wave (top layer sloshes strongly vs bottom counter-current for stirring)
        p.vx += clampedDx * 2.2 * (hNorm - 0.35);
        // Vertical wave run-up along walls
        p.vy += Math.abs(clampedDx) * 0.75 * (-xNorm * Math.sign(clampedDx)) + clampedDy * 0.5;

        // Clamp velocity to prevent wall tunneling
        p.vx = Math.max(-380, Math.min(380, p.vx));
        p.vy = Math.max(-380, Math.min(380, p.vy));

        // Keep strictly inside inner glass bounds
        p.x = Math.max(targetX - halfW, Math.min(targetX + halfW, p.x));
        p.y = Math.max(bottomY + PARTICLE_COLLISION_RADIUS, Math.min(rimY + 8, p.y));
      }
    }

    return { dx, dy };
  }

  public setDragging(isDragging: boolean): void {
    this.state.isDragging = Boolean(isDragging);
  }

  public updateScreenRect(rect: GlassScreenRect): void {
    this.hasCustomScreenRect = true;
    this.state.screenRect = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  public decayVelocity(dt: number): void {
    const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const decay = Math.exp(-10.0 * safeDt);
    this.state.vx *= decay;
    this.state.vy *= decay;
    if (Math.abs(this.state.vx) < 0.05) this.state.vx = 0;
    if (Math.abs(this.state.vy) < 0.05) this.state.vy = 0;
  }

  public reset(): void {
    this.overflowActive = false;
    this.hasCustomScreenRect = false;
    this.state.x = DEFAULT_GLASS_X;
    this.state.y = DEFAULT_GLASS_Y;
    this.state.normX = DEFAULT_GLASS_X / WORLD_WIDTH;
    this.state.normY = DEFAULT_GLASS_Y / WORLD_HEIGHT;
    this.state.width = (GLASS_TOP_HALF_WIDTH * 2) / WORLD_WIDTH;
    this.state.height = GLASS_WORLD_HEIGHT / WORLD_HEIGHT;
    this.state.vx = 0;
    this.state.vy = 0;
    this.state.isDragging = false;
    this.state.screenRect = computeDefaultScreenRect(
      DEFAULT_GLASS_X,
      DEFAULT_GLASS_Y,
      GLASS_TOP_HALF_WIDTH,
      GLASS_WORLD_HEIGHT,
    );
  }

  /**
   * Resolves stream entry, exterior wall deflection, interior containment, and rim overflow.
   */
  public resolveCollisions(
    particles: FluidParticle[],
    _dt: number,
    onDrinkCaptured?: (drinkId: DrinkId) => void,
    onOverflow?: () => void,
  ): void {
    const glassX = this.state.x;
    const glassVx = this.state.vx;
    const glassVy = this.state.vy;
    const bottomY = this.bottomY;
    const rimY = this.rimY;
    const maxCap = this.state.maxCapacityParticles;

    // Step 1: Handle 'falling' particles crossing the top rim or hitting exterior walls
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.state !== 'falling') continue;

      if (p.y <= rimY && p.y >= bottomY - 4) {
        const halfW = this.halfWidthAt(p.y);
        const innerHalfW = halfW - 2.0;
        const distFromCenter = Math.abs(p.x - glassX);

        // Capture through top rim opening
        if (distFromCenter <= innerHalfW && p.y >= rimY - 36) {
          p.state = 'pooled';
          p.vy *= 0.55;
          p.vx += (p.x - glassX) * 0.15;
          if (onDrinkCaptured) {
            onDrinkCaptured(p.drinkId);
          }
        } else {
          // Exterior wall deflection when striking outside the glass
          const outerWallHalfW = halfW + EXTERIOR_WALL_THICKNESS;
          if (distFromCenter < outerWallHalfW) {
            const side = p.x >= glassX ? 1 : -1;
            p.x = glassX + side * outerWallHalfW;
            p.vx = side * Math.max(45, Math.abs(p.vx) * 0.6 + 35);
            p.state = 'spilled';
          }
        }
      }
    }

    // Count pooled particles after new captures
    let pooledCount = 0;
    for (let i = 0; i < particles.length; i++) {
      if (particles[i].state === 'pooled') {
        pooledCount++;
      }
    }

    // Step 2: Contain 'pooled' particles inside the tapered U-glass floor & walls
    const minFloorY = bottomY + PARTICLE_COLLISION_RADIUS;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.state !== 'pooled') continue;

      // Floor collision
      if (p.y < minFloorY) {
        p.y = minFloorY;
        const relVy = p.vy - glassVy;
        if (relVy < 0) {
          p.vy = glassVy - relVy * 0.12;
        }
        p.vx = glassVx + (p.vx - glassVx) * 0.94;
      }

      // Tapered side walls
      const halfW = Math.max(10, this.halfWidthAt(p.y) - PARTICLE_COLLISION_RADIUS);
      const minX = glassX - halfW;
      const maxX = glassX + halfW;

      if (p.x < minX) {
        if (p.y > rimY + 4 && (pooledCount >= maxCap * 0.92 || Math.abs(p.vx) > 220)) {
          p.state = 'spilled';
          p.x = glassX - this.state.topHalfWidth - 4;
          p.vx = Math.min(p.vx, -55);
          pooledCount--;
          this.overflowActive = true;
          if (onOverflow) onOverflow();
          continue;
        }
        p.x = minX;
        const relVx = p.vx - glassVx;
        const relVy = p.vy - glassVy;
        const dot = relVx * LEFT_NORMAL_X + relVy * LEFT_NORMAL_Y;
        if (dot < 0) {
          const bouncedVx = (relVx - 1.2 * dot * LEFT_NORMAL_X) * 0.96;
          const bouncedVy = (relVy - 1.2 * dot * LEFT_NORMAL_Y) * 0.96;
          p.vx = glassVx + bouncedVx;
          p.vy = glassVy + bouncedVy;
        }
      } else if (p.x > maxX) {
        if (p.y > rimY + 4 && (pooledCount >= maxCap * 0.92 || Math.abs(p.vx) > 220)) {
          p.state = 'spilled';
          p.x = glassX + this.state.topHalfWidth + 4;
          p.vx = Math.max(p.vx, 55);
          pooledCount--;
          this.overflowActive = true;
          if (onOverflow) onOverflow();
          continue;
        }
        p.x = maxX;
        const relVx = p.vx - glassVx;
        const relVy = p.vy - glassVy;
        const dot = relVx * RIGHT_NORMAL_X + relVy * RIGHT_NORMAL_Y;
        if (dot < 0) {
          const bouncedVx = (relVx - 1.2 * dot * RIGHT_NORMAL_X) * 0.96;
          const bouncedVy = (relVy - 1.2 * dot * RIGHT_NORMAL_Y) * 0.96;
          p.vx = glassVx + bouncedVx;
          p.vy = glassVy + bouncedVy;
        }
      }

      // Top rim containment when not exceeding capacity
      if (p.y > rimY + 6 && pooledCount <= maxCap) {
        p.y = rimY + 6;
        if (p.vy > 0) {
          p.vy *= -0.2;
        }
      }
    }

    // Step 3: Rim overflow spilling when fillLevel >= 1.0
    if (pooledCount >= maxCap) {
      this.overflowActive = true;
      if (onOverflow) onOverflow();
    }

    if (pooledCount > maxCap) {
      const excess = pooledCount - maxCap;
      // Collect pooled particle indices and spill established particles nearest the top rim
      const candidateIndices: number[] = [];
      for (let i = 0; i < particles.length; i++) {
        if (particles[i].state === 'pooled') {
          candidateIndices.push(i);
        }
      }
      candidateIndices.sort((a, b) => {
        const pa = particles[a];
        const pb = particles[b];
        const scoreA = (pa.age >= 1.5 ? 1000 : 0) + pa.y;
        const scoreB = (pb.age >= 1.5 ? 1000 : 0) + pb.y;
        return scoreB - scoreA;
      });

      for (let k = 0; k < excess && k < candidateIndices.length; k++) {
        const p = particles[candidateIndices[k]];
        p.state = 'spilled';
        const side = Math.abs(p.x - glassX) > 2 ? (p.x >= glassX ? 1 : -1) : k % 2 === 0 ? 1 : -1;
        p.x = glassX + side * (this.state.topHalfWidth + 4 + (k % 3) * 2);
        p.y = Math.min(p.y, rimY - 2);
        p.vx = side * (55 + (k % 4) * 12);
        p.vy = -40 - (k % 3) * 15;
      }
    }
  }
}
