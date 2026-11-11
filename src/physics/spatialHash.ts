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

  // Contiguous CSR cell layout + dirty-cell tracking for fast cache-local scans
  public readonly dirtyCells: Int32Array;
  public dirtyCount = 0;
  public readonly cellCount: Int32Array;
  public readonly cellStart: Int32Array;
  private readonly cellCursor: Int32Array;
  public readonly sortedIdx: Int32Array;
  public readonly sortedX: Float32Array;
  public readonly sortedY: Float32Array;

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

    const totalCells = this.cols * this.rows;
    this.head = new Int32Array(totalCells);
    this.head.fill(-1);
    this.dirtyCells = new Int32Array(totalCells);
    this.cellCount = new Int32Array(totalCells);
    this.cellStart = new Int32Array(totalCells);
    this.cellCursor = new Int32Array(totalCells);

    this.next = new Int32Array(maxParticles);
    this.cellX = new Int32Array(maxParticles);
    this.cellY = new Int32Array(maxParticles);
    this.sortedIdx = new Int32Array(maxParticles);
    this.sortedX = new Float32Array(maxParticles);
    this.sortedY = new Float32Array(maxParticles);
  }

  public clear(): void {
    const { head, cellCount, dirtyCells, dirtyCount } = this;
    for (let i = 0; i < dirtyCount; i++) {
      const c = dirtyCells[i];
      head[c] = -1;
      cellCount[c] = 0;
    }
    this.dirtyCount = 0;
  }

  /**
   * Rebuilds the spatial index in O(count) with zero heap allocations,
   * resetting only the cells dirtied during the previous build and packing
   * contiguous CSR slices (`sortedX`, `sortedY`, `sortedIdx`) per active cell.
   */
  public build(x: Float32Array, y: Float32Array, count: number): void {
    const {
      head,
      next,
      cellX,
      cellY,
      dirtyCells,
      cellCount,
      cellStart,
      cellCursor,
      sortedIdx,
      sortedX,
      sortedY,
      minX,
      minY,
      invCellSize,
      cols,
      rows,
    } = this;

    const prevDirty = this.dirtyCount;
    for (let i = 0; i < prevDirty; i++) {
      const c = dirtyCells[i];
      head[c] = -1;
      cellCount[c] = 0;
    }

    let dirtyCount = 0;
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
      const prevCount = cellCount[cellIdx];
      if (prevCount === 0) {
        dirtyCells[dirtyCount++] = cellIdx;
      }
      cellCount[cellIdx] = prevCount + 1;
      next[i] = head[cellIdx];
      head[cellIdx] = i;
    }

    let offset = 0;
    for (let d = 0; d < dirtyCount; d++) {
      const c = dirtyCells[d];
      cellStart[c] = offset;
      cellCursor[c] = offset;
      offset += cellCount[c];
    }

    for (let i = 0; i < count; i++) {
      const c = cellY[i] * cols + cellX[i];
      const dst = cellCursor[c]++;
      sortedIdx[dst] = i;
      sortedX[dst] = x[i];
      sortedY[dst] = y[i];
    }

    this.dirtyCount = dirtyCount;
  }

  /**
   * Writes indices of all particles within `radius` of `(qx, qy)` into `outIndices`
   * and returns the count written (up to `outIndices.length`).
   */
  public queryNeighbors(
    qx: number,
    qy: number,
    radius: number,
    _x: Float32Array,
    _y: Float32Array,
    outIndices: Int32Array
  ): number {
    const { cellCount, cellStart, sortedIdx, sortedX, sortedY, minX, minY, invCellSize, cols, rows } =
      this;
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
        const c = rowOffset + cx;
        const cnt = cellCount[c];
        if (cnt === 0) continue;
        const end = cellStart[c] + cnt;
        for (let k = cellStart[c]; k < end; k++) {
          const dx = sortedX[k] - qx;
          const dy = sortedY[k] - qy;
          if (dx * dx + dy * dy <= r2) {
            outIndices[found++] = sortedIdx[k];
            if (found >= maxOut) return found;
          }
        }
      }
    }
    return found;
  }
}
