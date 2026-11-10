import {
  DRINK_CATALOG,
  DRINK_IDS,
  getDrinkSpec,
  isValidDrinkId,
} from '../catalog/drinks';
import { FluidWorld } from '../physics/fluidWorld';
import {
  DrinkId,
  GLASS_MAX_X,
  GLASS_MAX_Y,
  GLASS_MIN_X,
  GLASS_MIN_Y,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../types/simulation';

export interface FountainDOMElements {
  readonly canvas: HTMLCanvasElement;
  readonly controlsBar: HTMLElement;
  readonly drinkButtons: ReadonlyMap<DrinkId, HTMLButtonElement>;
  readonly resetButton: HTMLButtonElement;
  readonly statusBar: HTMLElement;
  readonly mixedColorSwatch: HTMLElement;
  readonly fillReadout: HTMLElement;
}

export const KEY_TO_DRINK: Readonly<Record<string, DrinkId>> = {
  '1': 'coca-cola',
  Digit1: 'coca-cola',
  '2': 'fanta',
  Digit2: 'fanta',
  '3': 'sprite',
  Digit3: 'sprite',
  '4': 'cherry',
  Digit4: 'cherry',
  '5': 'berry-blue',
  Digit5: 'berry-blue',
};

/**
 * Converts client viewport coordinates `(clientX, clientY)` on `#fountain-canvas`
 * into simulation world coordinates `(worldX, worldY)` (`800 x 600`, origin bottom-left).
 */
export function clientToWorldCoords(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { worldX: number; worldY: number } {
  const rect =
    typeof canvas.getBoundingClientRect === 'function'
      ? canvas.getBoundingClientRect()
      : null;

  const left = rect ? rect.left : 0;
  const top = rect ? rect.top : 0;
  const width =
    rect && rect.width > 0
      ? rect.width
      : canvas.clientWidth || canvas.width || WORLD_WIDTH;
  const height =
    rect && rect.height > 0
      ? rect.height
      : canvas.clientHeight || canvas.height || WORLD_HEIGHT;

  const safeClientX = Number.isFinite(clientX) ? clientX : left + width * 0.5;
  const safeClientY = Number.isFinite(clientY) ? clientY : top + height * 0.5;

  const normX = (safeClientX - left) / Math.max(1, width);
  const normY = 1.0 - (safeClientY - top) / Math.max(1, height);

  return {
    worldX: normX * WORLD_WIDTH,
    worldY: normY * WORLD_HEIGHT,
  };
}

/**
 * Clamps simulation world coordinates `(worldX, worldY)` to the movable glass container bounds
 * (`x in [120, 680]`, `y in [135, 340]`).
 */
export function clampWorldGlassCoords(
  worldX: number,
  worldY: number,
): { worldX: number; worldY: number } {
  const safeX = Number.isFinite(worldX) ? worldX : (GLASS_MIN_X + GLASS_MAX_X) * 0.5;
  const safeY = Number.isFinite(worldY) ? worldY : (GLASS_MIN_Y + GLASS_MAX_Y) * 0.5;

  return {
    worldX: Math.max(GLASS_MIN_X, Math.min(GLASS_MAX_X, safeX)),
    worldY: Math.max(GLASS_MIN_Y, Math.min(GLASS_MAX_Y, safeY)),
  };
}

/**
 * Ensures all required DOM elements and initial `data-*` / `aria-*` attributes exist in `doc`.
 * If `doc.body` is empty (e.g. in unit tests), scaffolds the canonical single-viewport DOM shell.
 */
export function ensureFountainDOM(doc: Document = document): FountainDOMElements {
  let appRoot = doc.getElementById('app');
  if (!appRoot) {
    appRoot = doc.createElement('div');
    appRoot.id = 'app';
    appRoot.setAttribute('data-testid', 'app-root');
    doc.body.appendChild(appRoot);
  }

  let controlsBar =
    (doc.getElementById('fountain-controls') as HTMLElement | null) ||
    (doc.querySelector('[data-testid="fountain-controls"]') as HTMLElement | null);

  if (!controlsBar) {
    controlsBar = doc.createElement('header');
    controlsBar.id = 'fountain-controls';
    controlsBar.setAttribute('data-testid', 'fountain-controls');
    appRoot.appendChild(controlsBar);
  }
  controlsBar.style.touchAction = 'none';
  controlsBar.style.userSelect = 'none';

  let buttonsGroup = controlsBar.querySelector('.drink-buttons-group') as HTMLElement | null;
  if (!buttonsGroup) {
    buttonsGroup = doc.createElement('div');
    buttonsGroup.className = 'drink-buttons-group';
    buttonsGroup.setAttribute('role', 'group');
    buttonsGroup.setAttribute('aria-label', 'Soda Fountain Dispensers');
    controlsBar.appendChild(buttonsGroup);
  }

  const drinkButtons = new Map<DrinkId, HTMLButtonElement>();
  for (const spec of DRINK_CATALOG) {
    let btn =
      (doc.querySelector(
        `[data-testid="drink-btn-${spec.id}"]`,
      ) as HTMLButtonElement | null) ||
      (doc.querySelector(
        `.drink-btn[data-drink="${spec.id}"]`,
      ) as HTMLButtonElement | null);

    if (!btn) {
      btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'drink-btn';
      btn.setAttribute('data-testid', `drink-btn-${spec.id}`);
      const swatch = doc.createElement('span');
      swatch.className = 'drink-swatch';
      swatch.style.backgroundColor = spec.hexColor;
      const label = doc.createElement('span');
      label.className = 'drink-label';
      label.textContent = spec.name;
      btn.appendChild(swatch);
      btn.appendChild(label);
      buttonsGroup.appendChild(btn);
    }

    btn.setAttribute('data-testid', `drink-btn-${spec.id}`);
    btn.setAttribute('data-drink', spec.id);
    btn.setAttribute('data-color', spec.hexColor);
    if (!btn.hasAttribute('data-active')) {
      btn.setAttribute('data-active', 'false');
    }
    if (!btn.hasAttribute('aria-pressed')) {
      btn.setAttribute('aria-pressed', 'false');
    }
    btn.style.touchAction = 'none';
    btn.style.userSelect = 'none';
    drinkButtons.set(spec.id, btn);
  }

  let actionsContainer = controlsBar.querySelector('.fountain-actions') as HTMLElement | null;
  if (!actionsContainer) {
    actionsContainer = doc.createElement('div');
    actionsContainer.className = 'fountain-actions';
    controlsBar.appendChild(actionsContainer);
  }

  let statusBar =
    (doc.getElementById('status-bar') as HTMLElement | null) ||
    (doc.querySelector('[data-testid="status-bar"]') as HTMLElement | null);
  if (!statusBar) {
    statusBar = doc.createElement('div');
    statusBar.id = 'status-bar';
    statusBar.setAttribute('data-testid', 'status-bar');
    actionsContainer.appendChild(statusBar);
  }

  let mixedColorSwatch =
    (doc.getElementById('mixed-color-swatch') as HTMLElement | null) ||
    (doc.querySelector('[data-testid="mixed-color-swatch"]') as HTMLElement | null);
  if (!mixedColorSwatch) {
    mixedColorSwatch = doc.createElement('span');
    mixedColorSwatch.id = 'mixed-color-swatch';
    mixedColorSwatch.setAttribute('data-testid', 'mixed-color-swatch');
    statusBar.appendChild(mixedColorSwatch);
  }
  if (!mixedColorSwatch.hasAttribute('data-rgb')) {
    mixedColorSwatch.setAttribute('data-rgb', '0,0,0');
  }
  if (!mixedColorSwatch.hasAttribute('data-fill-percent')) {
    mixedColorSwatch.setAttribute('data-fill-percent', '0');
  }

  let fillReadout =
    (doc.getElementById('fill-readout') as HTMLElement | null) ||
    (doc.querySelector('[data-testid="fill-readout"]') as HTMLElement | null);
  if (!fillReadout) {
    fillReadout = doc.createElement('span');
    fillReadout.id = 'fill-readout';
    fillReadout.setAttribute('data-testid', 'fill-readout');
    fillReadout.textContent = '0%';
    statusBar.appendChild(fillReadout);
  }

  let resetButton =
    (doc.getElementById('reset-btn') as HTMLButtonElement | null) ||
    (doc.querySelector('[data-testid="reset-button"]') as HTMLButtonElement | null);
  if (!resetButton) {
    resetButton = doc.createElement('button');
    resetButton.type = 'button';
    resetButton.id = 'reset-btn';
    resetButton.setAttribute('data-testid', 'reset-button');
    resetButton.setAttribute('data-action', 'empty-glass');
    resetButton.textContent = 'Empty Glass';
    actionsContainer.appendChild(resetButton);
  }
  resetButton.setAttribute('data-testid', 'reset-button');
  resetButton.setAttribute('data-action', 'empty-glass');
  resetButton.style.touchAction = 'none';
  resetButton.style.userSelect = 'none';

  let canvas =
    (doc.getElementById('fountain-canvas') as HTMLCanvasElement | null) ||
    (doc.querySelector('[data-testid="fountain-canvas"]') as HTMLCanvasElement | null);
  if (!canvas) {
    canvas = doc.createElement('canvas');
    canvas.id = 'fountain-canvas';
    canvas.setAttribute('data-testid', 'fountain-canvas');
    appRoot.appendChild(canvas);
  }
  canvas.id = 'fountain-canvas';
  canvas.setAttribute('data-testid', 'fountain-canvas');
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';

  return {
    canvas,
    controlsBar,
    drinkButtons,
    resetButton,
    statusBar,
    mixedColorSwatch,
    fillReadout,
  };
}

export interface FountainControlsOptions {
  readonly world: FluidWorld;
  readonly doc?: Document;
  readonly win?: Window & typeof globalThis;
  readonly webglVersion?: 1 | 2;
  readonly onRenderRequested?: () => void;
  readonly onResetRequested?: () => void;
}

interface PointerDedupRecord {
  type: 'down' | 'move' | 'up' | 'cancel';
  time: number;
}

/**
 * Unified Pointer, Mouse, Touch, and Keyboard input controller for the Soda Fountain UI.
 * Supports simultaneous multi-drink pouring and independent canvas glass dragging.
 */
export class FountainControls {
  public readonly dom: FountainDOMElements;
  public readonly world: FluidWorld;

  private readonly doc: Document;
  private readonly win: Window & typeof globalThis;
  private readonly onRenderRequested?: () => void;
  private readonly onResetRequested?: () => void;

  private webglVersion: 1 | 2;
  private isReady = true;

  /** Maps active pointerId / touch.identifier -> DrinkId */
  private readonly drinkPointers = new Map<number, DrinkId>();
  /** Maps active keyboard shortcut ('1'..'5') -> DrinkId */
  private readonly drinkKeys = new Map<string, DrinkId>();
  /** Tracks drinks started explicitly via the programmatic API */
  private readonly apiPouringDrinks = new Set<DrinkId>();

  /** Active canvas glass-drag pointer tracking */
  private dragPointerId: number | null = null;
  private dragSharedWithDrinkPointer = false;
  private lastDragWorldX = NaN;
  private lastDragWorldY = NaN;

  /** Companion event deduplication between PointerEvent and compatibility MouseEvent/TouchEvent */
  private readonly lastPointerEvents = new Map<number, PointerDedupRecord>();

  private readonly cleanupFns: Array<() => void> = [];

  constructor(options: FountainControlsOptions) {
    this.world = options.world;
    this.doc = options.doc ?? document;
    this.win =
      options.win ??
      ((this.doc.defaultView ?? window) as Window & typeof globalThis);
    this.webglVersion = options.webglVersion ?? 2;
    this.onRenderRequested = options.onRenderRequested;
    this.onResetRequested = options.onResetRequested;

    this.dom = ensureFountainDOM(this.doc);
    this.bindEvents();
    this.syncDomState();
  }

  public setWebGLVersion(version: 1 | 2): void {
    this.webglVersion = version;
    this.syncDomState();
  }

  public setReady(ready: boolean): void {
    this.isReady = ready;
    this.syncDomState();
  }

  /**
   * Programmatic API entry point for starting a drink pour.
   */
  public startPouringProgrammatic(drinkId: DrinkId): void {
    if (!isValidDrinkId(drinkId)) return;
    this.apiPouringDrinks.add(drinkId);
    this.world.startPouring(drinkId);
    this.onRenderRequested?.();
    this.syncDomState();
  }

  /**
   * Programmatic API entry point for stopping a drink pour (or all pours if `drinkId` is omitted).
   */
  public stopPouringProgrammatic(drinkId?: DrinkId): void {
    if (drinkId === undefined) {
      this.apiPouringDrinks.clear();
      this.drinkPointers.clear();
      this.drinkKeys.clear();
      this.world.stopPouring();
    } else if (isValidDrinkId(drinkId)) {
      this.apiPouringDrinks.delete(drinkId);
      for (const [pid, id] of this.drinkPointers.entries()) {
        if (id === drinkId) {
          this.drinkPointers.delete(pid);
        }
      }
      for (const [key, id] of this.drinkKeys.entries()) {
        if (id === drinkId) {
          this.drinkKeys.delete(key);
        }
      }
      this.world.stopPouring(drinkId);
    }
    this.onRenderRequested?.();
    this.syncDomState();
  }

  /**
   * Clears all active UI input holds and glass drag state (used on reset / blur).
   */
  public clearAllInputState(): void {
    this.apiPouringDrinks.clear();
    this.drinkPointers.clear();
    this.drinkKeys.clear();
    this.dragPointerId = null;
    this.dragSharedWithDrinkPointer = false;
    this.lastDragWorldX = NaN;
    this.lastDragWorldY = NaN;
    this.world.setGlassDragging(false);
    this.world.glassCollider.state.vx = 0;
    this.world.glassCollider.state.vy = 0;
  }

  /**
   * Synchronizes all required DOM `data-*`, `aria-*`, inline styles, and text readouts
   * with the current `FluidWorld` state.
   */
  public syncDomState(): void {
    const { canvas, drinkButtons, mixedColorSwatch, fillReadout } = this.dom;
    const glass = this.world.getGlassState();
    const liquid = this.world.getLiquidSummary();
    const activeDrinks = this.world.getActiveDrinks();
    const activeSet = new Set<DrinkId>(activeDrinks);

    const [avgR, avgG, avgB] = liquid.averageColorRGB;
    const rgbStr = `${avgR},${avgG},${avgB}`;
    const fillPercent = Math.round(liquid.fillLevel * 100);

    canvas.setAttribute('data-ready', this.isReady ? 'true' : 'false');
    canvas.setAttribute('data-webgl-version', String(this.webglVersion));
    canvas.setAttribute('data-glass-x', glass.normX.toFixed(2));
    canvas.setAttribute('data-fill-ratio', liquid.fillLevel.toFixed(2));
    canvas.setAttribute('data-avg-rgb', rgbStr);
    canvas.setAttribute('data-active-drinks', activeDrinks.join(','));

    for (const id of DRINK_IDS) {
      const btn = drinkButtons.get(id);
      if (!btn) continue;
      const spec = getDrinkSpec(id);
      const isActive = activeSet.has(id);
      btn.setAttribute('data-drink', id);
      btn.setAttribute('data-color', spec.hexColor);
      btn.setAttribute('data-active', isActive ? 'true' : 'false');
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      btn.classList.toggle('active', isActive);
    }

    mixedColorSwatch.setAttribute('data-rgb', rgbStr);
    mixedColorSwatch.setAttribute('data-fill-percent', String(fillPercent));
    if (liquid.pooledParticleCount > 0 && liquid.mixedColorHex) {
      mixedColorSwatch.style.backgroundColor = liquid.mixedColorHex;
    } else {
      mixedColorSwatch.style.backgroundColor = 'rgb(0, 0, 0)';
    }

    fillReadout.textContent = `${fillPercent}%`;
  }

  private now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  private recordPointerEvent(
    pointerId: number,
    type: PointerDedupRecord['type'],
  ): void {
    this.lastPointerEvents.set(pointerId, { type, time: this.now() });
  }

  private isRedundantCompanionEvent(
    pointerId: number,
    type: PointerDedupRecord['type'],
  ): boolean {
    const rec = this.lastPointerEvents.get(pointerId);
    if (!rec) return false;
    return rec.type === type && this.now() - rec.time < 25;
  }

  private isDrinkStillHeld(drinkId: DrinkId): boolean {
    if (this.apiPouringDrinks.has(drinkId)) return true;
    for (const heldId of this.drinkPointers.values()) {
      if (heldId === drinkId) return true;
    }
    for (const heldId of this.drinkKeys.values()) {
      if (heldId === drinkId) return true;
    }
    return false;
  }

  private startDrinkPointerHold(pointerId: number, drinkId: DrinkId): void {
    this.drinkPointers.set(pointerId, drinkId);
    this.world.startPouring(drinkId);
    this.onRenderRequested?.();
    this.syncDomState();
  }

  private releaseDrinkPointerHold(pointerId: number): void {
    const drinkId = this.drinkPointers.get(pointerId);
    if (!drinkId) return;
    this.drinkPointers.delete(pointerId);
    if (!this.isDrinkStillHeld(drinkId)) {
      this.world.stopPouring(drinkId);
    }
    this.onRenderRequested?.();
    this.syncDomState();
  }

  private startGlassDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
  ): void {
    this.dragPointerId = pointerId;
    this.dragSharedWithDrinkPointer = this.drinkPointers.has(pointerId);
    this.world.setGlassDragging(true);

    const glass = this.world.getGlassState();
    this.lastDragWorldX = glass.x;
    this.lastDragWorldY = glass.y;

    const { worldX, worldY } = clientToWorldCoords(
      this.dom.canvas,
      clientX,
      clientY,
    );
    const clamped = clampWorldGlassCoords(worldX, worldY);

    if (
      Math.abs(clamped.worldX - glass.x) > 1.0 ||
      Math.abs(clamped.worldY - glass.y) > 1.0
    ) {
      this.world.moveGlassTo(clamped.worldX, clamped.worldY);
      this.lastDragWorldX = clamped.worldX;
      this.lastDragWorldY = clamped.worldY;
      this.onRenderRequested?.();
    }

    this.syncDomState();
  }

  private moveGlassDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
  ): void {
    if (this.dragPointerId !== pointerId) return;

    const { worldX, worldY } = clientToWorldCoords(
      this.dom.canvas,
      clientX,
      clientY,
    );
    const clamped = clampWorldGlassCoords(worldX, worldY);

    if (
      Math.abs(clamped.worldX - this.lastDragWorldX) > 0.01 ||
      Math.abs(clamped.worldY - this.lastDragWorldY) > 0.01
    ) {
      this.world.moveGlassTo(clamped.worldX, clamped.worldY);
      this.lastDragWorldX = clamped.worldX;
      this.lastDragWorldY = clamped.worldY;
      this.onRenderRequested?.();
    }

    this.syncDomState();
  }

  private endGlassDrag(): void {
    this.dragPointerId = null;
    this.dragSharedWithDrinkPointer = false;
    this.lastDragWorldX = NaN;
    this.lastDragWorldY = NaN;
    this.world.setGlassDragging(false);
    this.world.glassCollider.state.vx = 0;
    this.world.glassCollider.state.vy = 0;
    this.onRenderRequested?.();
    this.syncDomState();
  }

  private findDrinkButtonFromTarget(
    target: EventTarget | null,
  ): DrinkId | null {
    if (!target || typeof (target as Element).closest !== 'function') {
      return null;
    }
    const btn = (target as Element).closest('[data-drink]') as HTMLElement | null;
    if (!btn) return null;
    const id = btn.getAttribute('data-drink');
    return isValidDrinkId(id) ? id : null;
  }

  private handlePointerRelease(
    pointerId: number,
    target: EventTarget | null,
  ): void {
    const targetDrinkId = this.findDrinkButtonFromTarget(target);

    if (targetDrinkId !== null) {
      // Released directly on a drink button
      this.releaseDrinkPointerHold(pointerId);
      if (this.dragPointerId === pointerId && !this.dragSharedWithDrinkPointer) {
        this.endGlassDrag();
      }
      return;
    }

    // Released on canvas, window, or outside buttons
    if (this.dragPointerId === pointerId) {
      const wasSharedWithDrink = this.dragSharedWithDrinkPointer;
      this.endGlassDrag();
      if (!wasSharedWithDrink) {
        this.releaseDrinkPointerHold(pointerId);
      }
    } else {
      // Off-button release (e.g. EC1: press button, move onto canvas/window, release)
      this.releaseDrinkPointerHold(pointerId);
    }
  }

  private handlePointerCancel(pointerId: number): void {
    if (this.drinkPointers.has(pointerId)) {
      this.releaseDrinkPointerHold(pointerId);
    }
    if (this.dragPointerId === pointerId) {
      this.endGlassDrag();
    }
    this.syncDomState();
  }

  private handleAllCancelOrBlur(): void {
    this.clearAllInputState();
    this.world.stopPouring();
    this.onRenderRequested?.();
    this.syncDomState();
  }

  private bindEvents(): void {
    const { canvas, drinkButtons, resetButton } = this.dom;

    // 1. Drink Buttons: Pointer, Mouse, Touch, and ContextMenu
    for (const [drinkId, btn] of drinkButtons.entries()) {
      const onPointerDown = (e: Event) => {
        const pe = e as PointerEvent;
        if (typeof pe.button === 'number' && pe.button !== 0) return;
        const pid = typeof pe.pointerId === 'number' ? pe.pointerId : 1;
        this.recordPointerEvent(pid, 'down');
        this.startDrinkPointerHold(pid, drinkId);
      };

      const onMouseDown = (e: MouseEvent) => {
        if (typeof e.button === 'number' && e.button !== 0) return;
        if (this.isRedundantCompanionEvent(1, 'down')) return;
        this.startDrinkPointerHold(1, drinkId);
      };

      const onTouchStart = (e: TouchEvent) => {
        if (e.cancelable) e.preventDefault();
        const touches = e.changedTouches;
        if (!touches || touches.length === 0) {
          if (!this.isRedundantCompanionEvent(1, 'down')) {
            this.startDrinkPointerHold(1, drinkId);
          }
          return;
        }
        for (let i = 0; i < touches.length; i++) {
          const pid = touches[i].identifier;
          if (!this.isRedundantCompanionEvent(pid, 'down')) {
            this.startDrinkPointerHold(pid, drinkId);
          }
        }
      };

      const onContextMenu = (e: Event) => {
        e.preventDefault();
      };

      btn.addEventListener('pointerdown', onPointerDown);
      btn.addEventListener('mousedown', onMouseDown);
      btn.addEventListener('touchstart', onTouchStart, { passive: false });
      btn.addEventListener('contextmenu', onContextMenu);

      this.cleanupFns.push(() => {
        btn.removeEventListener('pointerdown', onPointerDown);
        btn.removeEventListener('mousedown', onMouseDown);
        btn.removeEventListener('touchstart', onTouchStart);
        btn.removeEventListener('contextmenu', onContextMenu);
      });
    }

    // 2. Canvas Glass Dragging: Pointer, Mouse, Touch, and ContextMenu
    const onCanvasPointerDown = (e: Event) => {
      const pe = e as PointerEvent;
      if (typeof pe.button === 'number' && pe.button !== 0) return;
      const pid = typeof pe.pointerId === 'number' ? pe.pointerId : 1;
      this.recordPointerEvent(pid, 'down');
      this.startGlassDrag(pid, pe.clientX, pe.clientY);
    };

    const onCanvasMouseDown = (e: MouseEvent) => {
      if (typeof e.button === 'number' && e.button !== 0) return;
      if (this.isRedundantCompanionEvent(1, 'down')) return;
      this.startGlassDrag(1, e.clientX, e.clientY);
    };

    const onCanvasTouchStart = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      const touches = e.changedTouches;
      if (!touches || touches.length === 0) return;
      const touch = touches[0];
      if (this.isRedundantCompanionEvent(touch.identifier, 'down')) return;
      this.startGlassDrag(touch.identifier, touch.clientX, touch.clientY);
    };

    const onCanvasContextMenu = (e: Event) => {
      e.preventDefault();
    };

    canvas.addEventListener('pointerdown', onCanvasPointerDown);
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('touchstart', onCanvasTouchStart, { passive: false });
    canvas.addEventListener('contextmenu', onCanvasContextMenu);

    this.cleanupFns.push(() => {
      canvas.removeEventListener('pointerdown', onCanvasPointerDown);
      canvas.removeEventListener('mousedown', onCanvasMouseDown);
      canvas.removeEventListener('touchstart', onCanvasTouchStart);
      canvas.removeEventListener('contextmenu', onCanvasContextMenu);
    });

    // 3. Window-level Move, Release, Cancel, Keyboard, and Blur Listeners
    const onWindowPointerMove = (e: Event) => {
      const pe = e as PointerEvent;
      const pid = typeof pe.pointerId === 'number' ? pe.pointerId : 1;
      this.recordPointerEvent(pid, 'move');
      this.moveGlassDrag(pid, pe.clientX, pe.clientY);
    };

    const onWindowMouseMove = (e: MouseEvent) => {
      if (this.isRedundantCompanionEvent(1, 'move')) return;
      this.moveGlassDrag(1, e.clientX, e.clientY);
    };

    const onWindowTouchMove = (e: TouchEvent) => {
      const touches = e.changedTouches;
      if (!touches || touches.length === 0) return;
      for (let i = 0; i < touches.length; i++) {
        const touch = touches[i];
        if (!this.isRedundantCompanionEvent(touch.identifier, 'move')) {
          this.moveGlassDrag(touch.identifier, touch.clientX, touch.clientY);
        }
      }
    };

    const onWindowPointerUp = (e: Event) => {
      const pe = e as PointerEvent;
      const pid = typeof pe.pointerId === 'number' ? pe.pointerId : 1;
      this.recordPointerEvent(pid, 'up');
      this.handlePointerRelease(pid, pe.target);
    };

    const onWindowMouseUp = (e: MouseEvent) => {
      if (this.isRedundantCompanionEvent(1, 'up')) return;
      this.handlePointerRelease(1, e.target);
    };

    const onWindowTouchEnd = (e: TouchEvent) => {
      const touches = e.changedTouches;
      if (!touches || touches.length === 0) {
        if (!this.isRedundantCompanionEvent(1, 'up')) {
          this.handlePointerRelease(1, e.target);
        }
        return;
      }
      for (let i = 0; i < touches.length; i++) {
        const touch = touches[i];
        if (!this.isRedundantCompanionEvent(touch.identifier, 'up')) {
          this.handlePointerRelease(touch.identifier, touch.target ?? e.target);
        }
      }
    };

    const onWindowPointerCancel = (e: Event) => {
      const pe = e as PointerEvent;
      const pid = typeof pe.pointerId === 'number' ? pe.pointerId : 1;
      this.recordPointerEvent(pid, 'cancel');
      this.handlePointerCancel(pid);
    };

    const onWindowTouchCancel = (e: Event) => {
      const te = e as TouchEvent;
      const touches = te.changedTouches;
      if (!touches || touches.length === 0) {
        this.handleAllCancelOrBlur();
        return;
      }
      for (let i = 0; i < touches.length; i++) {
        const pid = touches[i].identifier;
        this.handlePointerCancel(pid);
      }
    };

    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const drinkId = KEY_TO_DRINK[e.key] ?? KEY_TO_DRINK[e.code];
      if (!drinkId) return;
      const slot = String(DRINK_IDS.indexOf(drinkId) + 1);
      this.drinkKeys.set(slot, drinkId);
      this.world.startPouring(drinkId);
      this.onRenderRequested?.();
      this.syncDomState();
    };

    const onWindowKeyUp = (e: KeyboardEvent) => {
      const drinkId = KEY_TO_DRINK[e.key] ?? KEY_TO_DRINK[e.code];
      if (!drinkId) return;
      const slot = String(DRINK_IDS.indexOf(drinkId) + 1);
      this.drinkKeys.delete(slot);
      if (!this.isDrinkStillHeld(drinkId)) {
        this.world.stopPouring(drinkId);
      }
      this.onRenderRequested?.();
      this.syncDomState();
    };

    const onWindowBlur = () => {
      this.handleAllCancelOrBlur();
    };

    const onVisibilityChange = () => {
      if (this.doc.visibilityState === 'hidden') {
        this.handleAllCancelOrBlur();
      }
    };

    this.win.addEventListener('pointermove', onWindowPointerMove);
    this.win.addEventListener('mousemove', onWindowMouseMove);
    this.win.addEventListener('touchmove', onWindowTouchMove, { passive: false });
    this.win.addEventListener('pointerup', onWindowPointerUp);
    this.win.addEventListener('mouseup', onWindowMouseUp);
    this.win.addEventListener('touchend', onWindowTouchEnd);
    this.win.addEventListener('pointercancel', onWindowPointerCancel);
    this.win.addEventListener('touchcancel', onWindowTouchCancel);
    this.win.addEventListener('keydown', onWindowKeyDown);
    this.win.addEventListener('keyup', onWindowKeyUp);
    this.win.addEventListener('blur', onWindowBlur);
    this.doc.addEventListener('visibilitychange', onVisibilityChange);

    this.cleanupFns.push(() => {
      this.win.removeEventListener('pointermove', onWindowPointerMove);
      this.win.removeEventListener('mousemove', onWindowMouseMove);
      this.win.removeEventListener('touchmove', onWindowTouchMove);
      this.win.removeEventListener('pointerup', onWindowPointerUp);
      this.win.removeEventListener('mouseup', onWindowMouseUp);
      this.win.removeEventListener('touchend', onWindowTouchEnd);
      this.win.removeEventListener('pointercancel', onWindowPointerCancel);
      this.win.removeEventListener('touchcancel', onWindowTouchCancel);
      this.win.removeEventListener('keydown', onWindowKeyDown);
      this.win.removeEventListener('keyup', onWindowKeyUp);
      this.win.removeEventListener('blur', onWindowBlur);
      this.doc.removeEventListener('visibilitychange', onVisibilityChange);
    });

    // 4. Empty / Reset Button Click
    const onResetClick = (e: MouseEvent) => {
      e.preventDefault();
      if (this.onResetRequested) {
        this.onResetRequested();
      } else {
        this.clearAllInputState();
        this.world.reset();
        this.onRenderRequested?.();
        this.syncDomState();
      }
    };

    resetButton.addEventListener('click', onResetClick);
    this.cleanupFns.push(() => {
      resetButton.removeEventListener('click', onResetClick);
    });
  }

  public dispose(): void {
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns.length = 0;
  }
}
