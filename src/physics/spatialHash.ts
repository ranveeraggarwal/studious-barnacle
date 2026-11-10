import { WORLD_HEIGHT, WORLD_WIDTH } from '../types/simulation';

function nextPow2(n: number): number {
  let p = 1024;
  while (p < n) {
    p <<= 1;
  }
  return p;
}

/**
 * O(N) uniform grid spatial hash for 2D SPH fluid physics and neighbor color diffusion.
 * Uses pre-allocated Int32Array intrusive linked lists and coordinate caches for zero-GC queries.
 */
export class SpatialHash {
  public readonly width: number;
  public readonly height: number;
  public readonly cellSize: number;
  public readonly invCellSize: number;
  public readonly cols: number;
  public readonly rows: number;

  private readonly cellHead: Int32Array;
  private nextParticle: Int32Array;
  private posX: Float32Array;
  private posY: Float32Array;
  private count = 0;

  constructor(
    width = WORLD_WIDTH,
    height = WORLD_HEIGHT,
    cellSize = 16.0,
    initialCapacity = 4096,
  ) {
    this.width = width;
    this.height = height;
    this.cellSize = Math.max(1.0, cellSize);
    this.invCellSize = 1.0 / this.cellSize;
    this.cols = Math.max(1, Math.ceil(this.width * this.invCellSize));
    this.rows = Math.max(1, Math.ceil(this.height * this.invCellSize));

    const totalCells = this.cols * this.rows;
    this.cellHead = new Int32Array(totalCells);
    this.cellHead.fill(-1);

    const cap = nextPow2(initialCapacity);
    this.nextParticle = new Int32Array(cap);
    this.nextParticle.fill(-1);
    this.posX = new Float32Array(cap);
    this.posY = new Float32Array(cap);
  }

  private ensureCapacity(requiredCapacity: number): void {
    if (requiredCapacity <= this.nextParticle.length) {
      return;
    }
    const newCap = nextPow2(requiredCapacity);
    const next = new Int32Array(newCap);
    next.fill(-1);
    next.set(this.nextParticle);
    this.nextParticle = next;

    const px = new Float32Array(newCap);
    px.set(this.posX);
    this.posX = px;

    const py = new Float32Array(newCap);
    py.set(this.posY);
    this.posY = py;
  }

  /** Reset all grid buckets in O(cols * rows) without allocations */
  public clear(): void {
    this.cellHead.fill(-1);
    this.count = 0;
  }

  /** Compute clamped grid cell index for world coordinates (x, y) */
  public getCellIndex(x: number, y: number): number {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(safeX * this.invCellSize)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(safeY * this.invCellSize)));
    return cy * this.cols + cx;
  }

  /** Insert a single particle index at world coordinates (x, y) */
  public insert(index: number, x: number, y: number): void {
    if (!Number.isFinite(index) || index < 0) return;
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    this.ensureCapacity(index + 1);
    this.posX[index] = safeX;
    this.posY[index] = safeY;
    const cellIdx = this.getCellIndex(safeX, safeY);
    this.nextParticle[index] = this.cellHead[cellIdx];
    this.cellHead[cellIdx] = index;
    if (index + 1 > this.count) {
      this.count = index + 1;
    }
  }

  /** Clear and insert all particles in O(N) time */
  public rebuild(particles: ReadonlyArray<{ x: number; y: number }>): void {
    const n = particles.length;
    this.ensureCapacity(n);
    this.cellHead.fill(-1);
    this.count = n;

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      const x = p.x;
      const y = p.y;
      this.posX[i] = x;
      this.posY[i] = y;
      const cellIdx = this.getCellIndex(x, y);
      this.nextParticle[i] = this.cellHead[cellIdx];
      this.cellHead[cellIdx] = i;
    }
  }

  /**
   * Populate `outIndices` (cleared before writing) with indices of all particles
   * within Euclidean distance `radius` of `(x, y)`. Returns `outIndices`.
   */
  public queryNeighbors(
    x: number,
    y: number,
    radius: number,
    particles?: ReadonlyArray<{ x: number; y: number }>,
    outIndices: number[] = [],
  ): number[] {
    outIndices.length = 0;
    if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return outIndices;
    }

    const minCx = Math.max(0, Math.floor((x - radius) * this.invCellSize));
    const maxCx = Math.min(this.cols - 1, Math.floor((x + radius) * this.invCellSize));
    const minCy = Math.max(0, Math.floor((y - radius) * this.invCellSize));
    const maxCy = Math.min(this.rows - 1, Math.floor((y + radius) * this.invCellSize));
    const rSq = radius * radius;

    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowOffset = cy * this.cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        let j = this.cellHead[rowOffset + cx];
        while (j !== -1) {
          const jx = particles ? particles[j].x : this.posX[j];
          const jy = particles ? particles[j].y : this.posY[j];
          const dx = jx - x;
          const dy = jy - y;
          if (dx * dx + dy * dy <= rSq) {
            outIndices.push(j);
          }
          j = this.nextParticle[j];
        }
      }
    }

    return outIndices;
  }

  /**
   * Alias for `queryNeighbors` supporting both `(x, y, radius)` and `(x, y, radius, particles, outIndices)`.
   */
  public queryRadius(
    x: number,
    y: number,
    radius: number,
    particles?: ReadonlyArray<{ x: number; y: number }>,
    outIndices: number[] = [],
  ): number[] {
    return this.queryNeighbors(x, y, radius, particles, outIndices);
  }

  /**
   * Zero-allocation neighbor traversal callback for hot SPH & color diffusion loops.
   * Calls `visitor(neighborIndex, dx, dy, distSq)` for every particle j != selfIndex
   * within `radius` of `(x, y)`.
   */
  public forEachNeighbor(
    selfIndex: number,
    x: number,
    y: number,
    radius: number,
    particles: ReadonlyArray<{ x: number; y: number }> | undefined,
    visitor: (neighborIndex: number, dx: number, dy: number, distSq: number) => void,
  ): void {
    if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    const minCx = Math.max(0, Math.floor((x - radius) * this.invCellSize));
    const maxCx = Math.min(this.cols - 1, Math.floor((x + radius) * this.invCellSize));
    const minCy = Math.max(0, Math.floor((y - radius) * this.invCellSize));
    const maxCy = Math.min(this.rows - 1, Math.floor((y + radius) * this.invCellSize));
    const rSq = radius * radius;

    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowOffset = cy * this.cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        let j = this.cellHead[rowOffset + cx];
        while (j !== -1) {
          if (j !== selfIndex) {
            const jx = particles ? particles[j].x : this.posX[j];
            const jy = particles ? particles[j].y : this.posY[j];
            const dx = jx - x;
            const dy = jy - y;
            const distSq = dx * dx + dy * dy;
            if (distSq <= rSq) {
              visitor(j, dx, dy, distSq);
            }
          }
          j = this.nextParticle[j];
        }
      }
    }
  }
}
