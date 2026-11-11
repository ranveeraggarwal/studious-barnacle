import { WORLD_H, WORLD_W } from '../types';

/**
 * Zero-allocation 2D uniform spatial hash grid backed by flat TypedArrays.
 * Sized to cover the entire world stage plus overflow margins with zero hash collisions.
 */
export class SpatialHash {
  public readonly cellSize: number;
  public readonly invCellSize: number;
  public readonly minX: number;
  public readonly minY: number;
  public readonly cols: number;
  public readonly rows: number;
  public readonly head: Int32Array;
  public readonly next: Int32Array;
  public readonly cellX: Int32Array;
  public readonly cellY: Int32Array;

  constructor(
    cellSize: number,
    maxParticles: number,
    minX = -64,
    minY = -64,
    maxX = WORLD_W + 64,
    maxY = WORLD_H + 64
  ) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) * this.invCellSize));
    this.rows = Math.max(1, Math.ceil((maxY - minY) * this.invCellSize));

    this.head = new Int32Array(this.cols * this.rows);
    this.head.fill(-1);
    this.next = new Int32Array(maxParticles);
    this.cellX = new Int32Array(maxParticles);
    this.cellY = new Int32Array(maxParticles);
  }

  public clear(): void {
    this.head.fill(-1);
  }

  /**
   * Rebuilds the linked-cell spatial index in O(count) with zero heap allocations.
   */
  public build(x: Float32Array, y: Float32Array, count: number): void {
    const { head, next, cellX, cellY, minX, minY, invCellSize, cols, rows } = this;
    head.fill(-1);

    const maxCol = cols - 1;
    const maxRow = rows - 1;

    for (let i = 0; i < count; i++) {
      let cx = ((x[i] - minX) * invCellSize) | 0;
      let cy = ((y[i] - minY) * invCellSize) | 0;
      if (cx < 0) cx = 0;
      else if (cx > maxCol) cx = maxCol;
      if (cy < 0) cy = 0;
      else if (cy > maxRow) cy = maxRow;

      cellX[i] = cx;
      cellY[i] = cy;

      const cellIdx = cy * cols + cx;
      next[i] = head[cellIdx];
      head[cellIdx] = i;
    }
  }

  /**
   * Writes indices of all particles within `radius` of `(qx, qy)` into `outIndices`
   * and returns the count written (up to `outIndices.length`).
   */
  public queryNeighbors(
    qx: number,
    qy: number,
    radius: number,
    x: Float32Array,
    y: Float32Array,
    outIndices: Int32Array
  ): number {
    const { head, next, minX, minY, invCellSize, cols, rows } = this;
    const r2 = radius * radius;
    const maxOut = outIndices.length;

    let minCx = ((qx - radius - minX) * invCellSize) | 0;
    let maxCx = ((qx + radius - minX) * invCellSize) | 0;
    let minCy = ((qy - radius - minY) * invCellSize) | 0;
    let maxCy = ((qy + radius - minY) * invCellSize) | 0;

    if (minCx < 0) minCx = 0;
    if (maxCx >= cols) maxCx = cols - 1;
    if (minCy < 0) minCy = 0;
    if (maxCy >= rows) maxCy = rows - 1;

    let found = 0;
    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowOffset = cy * cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        let j = head[rowOffset + cx];
        while (j !== -1) {
          const dx = x[j] - qx;
          const dy = y[j] - qy;
          if (dx * dx + dy * dy <= r2) {
            outIndices[found++] = j;
            if (found >= maxOut) return found;
          }
          j = next[j];
        }
      }
    }
    return found;
  }
}
