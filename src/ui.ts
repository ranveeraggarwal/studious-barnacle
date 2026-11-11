import { DRINKS } from './drinks';
import {
  BUTTON_CENTER_Y,
  BUTTON_H,
  BUTTON_W,
  COUNTER_TOP_Y,
  DrinkId,
  DrinkSpec,
  SimulationSnapshot,
  ViewportTransform,
  clientToWorld,
  computeViewportTransform,
  worldToCss,
} from './types';

export interface UIBindings {
  setDispensing(id: DrinkId, active: boolean): void;
  stopAllDispensing(): void;
  isPointNearGlass(worldX: number, worldY: number): boolean;
  beginGlassDrag(worldX: number, worldY: number): boolean;
  updateGlassDrag(worldX: number, worldY: number): void;
  endGlassDrag(): void;
  emptyGlass(): void;
}

interface HeldPointerEntry {
  id: DrinkId;
  downTime: number;
  button: HTMLButtonElement;
}

interface PadVisualCache {
  active: boolean;
  latched: boolean;
}

const LATCH_HOLD_THRESHOLD_MS = 210;
const EMPTY_GLASS_PROMPT = 'Drag glass · Press a soda to pour';

const KEY_TO_DRINK: ReadonlyMap<string, DrinkId> = new Map(
  DRINKS.map((drink) => [drink.keyHint, drink.id])
);

function getPointerId(e: PointerEvent): number {
  return typeof e.pointerId === 'number' ? e.pointerId : 1;
}

function safeSetPointerCapture(el: Element, pointerId: number): void {
  try {
    if ('setPointerCapture' in el && typeof el.setPointerCapture === 'function') {
      el.setPointerCapture(pointerId);
    }
  } catch {
    // Synthetic or detached pointer events may throw; safe to ignore.
  }
}

function safeReleasePointerCapture(el: Element, pointerId: number): void {
  try {
    if (
      'hasPointerCapture' in el &&
      typeof el.hasPointerCapture === 'function' &&
      el.hasPointerCapture(pointerId)
    ) {
      el.releasePointerCapture(pointerId);
    }
  } catch {
    // Safe no-op in non-browser test environments.
  }
}

function formatMixRecipe(snapshot: SimulationSnapshot): string {
  const { fillRatio, recipeShares } = snapshot.mix;
  const pct = Math.max(1, Math.min(100, Math.round(fillRatio * 100)));

  const ranked = DRINKS.map((drink) => ({
    shortName: drink.shortName,
    share: recipeShares[drink.id] ?? 0,
  })).sort((a, b) => b.share - a.share);

  const topDrinks = ranked.filter((item) => item.share >= 0.04).slice(0, 3);
  const chosen =
    topDrinks.length > 0
      ? topDrinks
      : ranked.filter((item) => item.share > 0).slice(0, 1);

  if (chosen.length === 0) {
    return `${pct}% full`;
  }

  return `${pct}% · ${chosen.map((item) => item.shortName).join(' + ')}`;
}

export class FountainUI {
  private readonly canvas: HTMLCanvasElement;
  private readonly overlayRoot: HTMLElement;
  private readonly doc: Document;
  private readonly win: (Window & typeof globalThis) | null;
  private readonly bindings: UIBindings;
  private readonly cleanups: Array<() => void> = [];

  private readonly padButtons = new Map<DrinkId, HTMLButtonElement>();
  private readonly padCache = new Map<DrinkId, PadVisualCache>();

  private readonly hudPillEl: HTMLDivElement;
  private readonly mixSwatchEl: HTMLSpanElement;
  private readonly mixLabelEl: HTMLSpanElement;
  private readonly stopBtnEl: HTMLButtonElement;
  private readonly emptyBtnEl: HTMLButtonElement;

  private readonly heldPointers = new Map<number, HeldPointerEntry>();
  private readonly latchedDrinks = new Set<DrinkId>();
  private readonly heldKeys = new Set<DrinkId>();
  private readonly externalActiveDrinks = new Set<DrinkId>();

  private vp: ViewportTransform;
  private dragPointerId: number | null = null;
  private glassHovered = false;
  private lastMoveEvent: Event | null = null;

  private prevLabelText = '';
  private prevSwatchHex = '';
  private prevHasLiquid: boolean | null = null;
  private prevHasLatched: boolean | null = null;
  private prevCursor = '';

  constructor(canvas: HTMLCanvasElement, overlayRoot: HTMLElement, bindings: UIBindings) {
    this.canvas = canvas;
    this.overlayRoot = overlayRoot;
    this.doc = overlayRoot.ownerDocument;
    this.win =
      (this.doc.defaultView as (Window & typeof globalThis) | null) ??
      (typeof window !== 'undefined' ? window : null);
    this.bindings = bindings;

    this.canvas.classList.add('fountain-canvas');
    this.overlayRoot.classList.add('fountain-overlay');
    this.overlayRoot.replaceChildren();

    // 1. Create the 5 tactile dispenser push-pads mounted on the fountain fascia
    for (const drink of DRINKS) {
      const btn = this.createDispenserPad(drink);
      this.padButtons.set(drink.id, btn);
      this.padCache.set(drink.id, { active: false, latched: false });
      this.overlayRoot.appendChild(btn);
    }

    // 2. Create the minimal floating HUD pill below the drip tray
    this.hudPillEl = this.doc.createElement('div');
    this.hudPillEl.id = 'hud-pill';
    this.hudPillEl.className = 'hud-pill';
    this.hudPillEl.setAttribute('role', 'region');
    this.hudPillEl.setAttribute('aria-label', 'Glass mix status and controls');

    const mixStatus = this.doc.createElement('div');
    mixStatus.className = 'mix-status';

    this.mixSwatchEl = this.doc.createElement('span');
    this.mixSwatchEl.id = 'mix-swatch';
    this.mixSwatchEl.setAttribute('aria-hidden', 'true');

    this.mixLabelEl = this.doc.createElement('span');
    this.mixLabelEl.id = 'mix-label';
    this.mixLabelEl.textContent = EMPTY_GLASS_PROMPT;
    this.prevLabelText = EMPTY_GLASS_PROMPT;

    mixStatus.append(this.mixSwatchEl, this.mixLabelEl);

    const divider = this.doc.createElement('span');
    divider.className = 'hud-divider';
    divider.setAttribute('aria-hidden', 'true');

    const actions = this.doc.createElement('div');
    actions.className = 'hud-actions';

    this.stopBtnEl = this.doc.createElement('button');
    this.stopBtnEl.type = 'button';
    this.stopBtnEl.id = 'stop-btn';
    this.stopBtnEl.className = 'hud-btn';
    this.stopBtnEl.hidden = true;
    this.prevHasLatched = false;

    const stopDot = this.doc.createElement('span');
    stopDot.className = 'stop-btn-dot';
    stopDot.setAttribute('aria-hidden', 'true');
    const stopText = this.doc.createElement('span');
    stopText.textContent = 'Stop Pour';
    this.stopBtnEl.append(stopDot, stopText);

    this.listen(this.stopBtnEl, 'pointerdown', (e) => {
      e.stopPropagation();
    });
    this.listen(this.stopBtnEl, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.stopAllPouring();
    });

    this.emptyBtnEl = this.doc.createElement('button');
    this.emptyBtnEl.type = 'button';
    this.emptyBtnEl.id = 'empty-btn';
    this.emptyBtnEl.className = 'hud-btn';
    this.emptyBtnEl.textContent = 'Empty Glass';

    this.listen(this.emptyBtnEl, 'pointerdown', (e) => {
      e.stopPropagation();
    });
    this.listen(this.emptyBtnEl, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.bindings.emptyGlass();
    });

    actions.append(this.stopBtnEl, this.emptyBtnEl);
    this.hudPillEl.append(mixStatus, divider, actions);
    this.overlayRoot.appendChild(this.hudPillEl);

    // 3. Attach canvas glass drag & hover listeners + global release/keyboard listeners
    this.bindCanvasAndGlobalEvents();

    // 4. Perform initial layout pass
    const winW = this.win ? this.win.innerWidth : 0;
    const winH = this.win ? this.win.innerHeight : 0;
    const initW = this.canvas.clientWidth || winW || 960;
    const initH = this.canvas.clientHeight || winH || 680;
    const initDpr = this.win ? this.win.devicePixelRatio || 1 : 1;
    this.vp = computeViewportTransform(initW, initH, initDpr);
    this.layout(this.vp);
  }

  public layout(vp: ViewportTransform): void {
    this.vp = vp;

    const scaleStr = vp.scale.toFixed(4);
    this.overlayRoot.style.setProperty('--pad-scale', scaleStr);
    this.overlayRoot.style.setProperty('--wu', `${scaleStr}px`);
    this.overlayRoot.classList.toggle('is-compact', vp.scale < 0.72);

    const padW = BUTTON_W * vp.scale;
    const padH = BUTTON_H * vp.scale;

    for (const drink of DRINKS) {
      const btn = this.padButtons.get(drink.id);
      if (!btn) continue;
      const center = worldToCss(drink.nozzleX, BUTTON_CENTER_Y, vp);
      btn.style.width = `${padW.toFixed(2)}px`;
      btn.style.height = `${padH.toFixed(2)}px`;
      btn.style.left = `${(center.left - padW * 0.5).toFixed(2)}px`;
      btn.style.top = `${(center.top - padH * 0.5).toFixed(2)}px`;
    }

    // Anchor HUD pill centered below the drip tray on the countertop apron, clamped inside viewport
    const counterCenter = worldToCss(480, COUNTER_TOP_Y, vp);
    const apronCenter = worldToCss(480, 20, vp);
    const shortViewport = vp.cssHeight < 480;
    const bottomSafeMargin = shortViewport ? 20 : 25;
    const minHudTop = counterCenter.top + (shortViewport ? 15 : 26);
    const maxHudTop = Math.max(24, vp.cssHeight - bottomSafeMargin);
    const hudTop = Math.min(maxHudTop, Math.max(minHudTop, apronCenter.top));

    this.hudPillEl.style.left = `${counterCenter.left.toFixed(2)}px`;
    this.hudPillEl.style.top = `${hudTop.toFixed(2)}px`;
  }

  public updateStatus(snapshot: SimulationSnapshot): void {
    this.externalActiveDrinks.clear();
    for (const id of snapshot.activeDrinks) {
      this.externalActiveDrinks.add(id);
    }
    this.syncPadAndStopVisuals();

    const hasLiquid = snapshot.mix.particleCount > 0 && snapshot.mix.fillRatio > 0;

    if (hasLiquid !== this.prevHasLiquid) {
      this.prevHasLiquid = hasLiquid;
      this.mixSwatchEl.classList.toggle('has-liquid', hasLiquid);
      this.mixLabelEl.classList.toggle('has-liquid', hasLiquid);
      this.emptyBtnEl.classList.toggle('has-liquid', hasLiquid);

      if (!hasLiquid && this.prevSwatchHex !== '') {
        this.mixSwatchEl.style.removeProperty('--swatch-color');
        this.prevSwatchHex = '';
      }
    }

    if (hasLiquid && snapshot.mix.displayHex !== this.prevSwatchHex) {
      this.prevSwatchHex = snapshot.mix.displayHex;
      this.mixSwatchEl.style.setProperty('--swatch-color', snapshot.mix.displayHex);
    }

    const nextLabel = hasLiquid ? formatMixRecipe(snapshot) : EMPTY_GLASS_PROMPT;
    if (nextLabel !== this.prevLabelText) {
      this.prevLabelText = nextLabel;
      this.mixLabelEl.textContent = nextLabel;
    }
  }

  public isGlassHovered(): boolean {
    return this.glassHovered;
  }

  public dispose(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.heldPointers.clear();
    this.latchedDrinks.clear();
    this.heldKeys.clear();
    this.externalActiveDrinks.clear();
    this.dragPointerId = null;
    this.glassHovered = false;
    this.canvas.style.cursor = '';
    this.overlayRoot.replaceChildren();
  }

  private listen<E extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void
  ): void {
    const wrapped = handler as EventListener;
    target.addEventListener(type, wrapped);
    this.cleanups.push(() => target.removeEventListener(type, wrapped));
  }

  private createDispenserPad(drink: DrinkSpec): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.id = `pad-${drink.id}`;
    btn.className = 'dispenser-pad';
    btn.dataset.drink = drink.id;
    btn.dataset.active = 'false';
    btn.dataset.latched = 'false';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', `${drink.name} (${drink.keyHint})`);
    btn.style.setProperty('--drink-color', drink.badgeColor);
    btn.style.setProperty('--drink-glow', drink.accentGlow);

    const plate = this.doc.createElement('span');
    plate.className = 'pad-plate';

    const cap = this.doc.createElement('span');
    cap.className = 'pad-cap';
    cap.setAttribute('aria-hidden', 'true');

    const meta = this.doc.createElement('span');
    meta.className = 'pad-meta';
    meta.setAttribute('aria-hidden', 'true');

    const keyHint = this.doc.createElement('kbd');
    keyHint.className = 'pad-key';
    keyHint.textContent = drink.keyHint;

    const latchBadge = this.doc.createElement('span');
    latchBadge.className = 'pad-latch-badge';

    const latchDot = this.doc.createElement('span');
    latchDot.className = 'pad-latch-dot';
    const latchText = this.doc.createElement('span');
    latchText.className = 'pad-latch-text';
    latchText.textContent = 'LOCK';

    latchBadge.append(latchDot, latchText);
    meta.append(keyHint, latchBadge);

    const label = this.doc.createElement('span');
    label.className = 'pad-label';
    label.textContent = drink.shortName;

    const led = this.doc.createElement('span');
    led.className = 'pad-led';
    led.setAttribute('aria-hidden', 'true');

    plate.append(cap, meta, label, led);
    btn.appendChild(plate);

    this.listen<PointerEvent>(btn, 'pointerdown', (e) =>
      this.handlePadPointerDown(drink.id, btn, e)
    );
    this.listen<PointerEvent>(btn, 'pointerup', (e) =>
      this.handlePadPointerFinish(e, true)
    );
    this.listen<PointerEvent>(btn, 'pointercancel', (e) =>
      this.handlePadPointerFinish(e, false)
    );
    this.listen<PointerEvent>(btn, 'lostpointercapture', (e) =>
      this.handlePadPointerFinish(e, false)
    );
    this.listen(btn, 'contextmenu', (e) => {
      e.preventDefault();
    });

    return btn;
  }

  private bindCanvasAndGlobalEvents(): void {
    this.listen<PointerEvent>(this.canvas, 'pointerdown', (e) =>
      this.handleCanvasPointerDown(e)
    );
    this.listen<PointerEvent>(this.canvas, 'pointermove', (e) =>
      this.handlePointerMove(e)
    );
    this.listen<PointerEvent>(this.canvas, 'pointerup', (e) =>
      this.handleCanvasPointerFinish(e, false)
    );
    this.listen<PointerEvent>(this.canvas, 'pointercancel', (e) =>
      this.handleCanvasPointerFinish(e, true)
    );
    this.listen<PointerEvent>(this.canvas, 'lostpointercapture', (e) =>
      this.handleCanvasPointerFinish(e, true)
    );
    this.listen(this.canvas, 'pointerleave', () => {
      if (this.dragPointerId === null && this.glassHovered) {
        this.glassHovered = false;
        this.updateCanvasCursor();
      }
    });
    this.listen(this.canvas, 'contextmenu', (e) => {
      e.preventDefault();
    });

    const globalTarget = this.win ?? this.doc;
    this.listen<PointerEvent>(globalTarget, 'pointermove', (e) =>
      this.handlePointerMove(e)
    );
    this.listen<PointerEvent>(globalTarget, 'pointerup', (e) => {
      this.handlePadPointerFinish(e, true);
      this.handleCanvasPointerFinish(e, false);
    });
    this.listen<PointerEvent>(globalTarget, 'pointercancel', (e) => {
      this.handlePadPointerFinish(e, false);
      this.handleCanvasPointerFinish(e, true);
    });
    if (this.win) {
      this.listen(this.win, 'blur', () => this.handleWindowBlur());
    }
    this.listen<KeyboardEvent>(globalTarget, 'keydown', (e) => this.handleKeyDown(e));
    this.listen<KeyboardEvent>(globalTarget, 'keyup', (e) => this.handleKeyUp(e));
  }

  private handlePadPointerDown(
    id: DrinkId,
    button: HTMLButtonElement,
    e: PointerEvent
  ): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const pointerId = getPointerId(e);

    // Instant shutoff if already latched open
    if (this.latchedDrinks.has(id)) {
      this.latchedDrinks.delete(id);
      this.heldKeys.delete(id);
      this.externalActiveDrinks.delete(id);
      for (const [pid, entry] of this.heldPointers) {
        if (entry.id === id) {
          this.heldPointers.delete(pid);
        }
      }
      this.bindings.setDispensing(id, false);
      this.syncPadAndStopVisuals();
      return;
    }

    this.heldPointers.set(pointerId, {
      id,
      downTime: performance.now(),
      button,
    });
    safeSetPointerCapture(button, pointerId);
    this.bindings.setDispensing(id, true);
    this.syncPadAndStopVisuals();
  }

  private handlePadPointerFinish(e: PointerEvent, allowLatch: boolean): void {
    const pointerId = getPointerId(e);
    const entry = this.heldPointers.get(pointerId);
    if (!entry) return;

    this.heldPointers.delete(pointerId);
    safeReleasePointerCapture(entry.button, pointerId);

    const heldDurationMs = performance.now() - entry.downTime;
    if (allowLatch && heldDurationMs < LATCH_HOLD_THRESHOLD_MS) {
      this.latchedDrinks.add(entry.id);
      this.bindings.setDispensing(entry.id, true);
    } else if (!this.isDrinkLocallyActive(entry.id)) {
      this.externalActiveDrinks.delete(entry.id);
      this.bindings.setDispensing(entry.id, false);
    }

    this.syncPadAndStopVisuals();
  }

  private handleCanvasPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pointerId = getPointerId(e);
    const { x: wx, y: wy } = this.clientToWorldPoint(e.clientX, e.clientY);

    if (this.dragPointerId !== null) return;

    const started = this.bindings.beginGlassDrag(wx, wy);
    if (started) {
      e.preventDefault();
      this.dragPointerId = pointerId;
      this.glassHovered = true;
      safeSetPointerCapture(this.canvas, pointerId);
      this.updateCanvasCursor();
    } else {
      this.glassHovered =
        e.pointerType === 'touch' ? false : this.bindings.isPointNearGlass(wx, wy);
      this.updateCanvasCursor();
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.lastMoveEvent === e) return;
    this.lastMoveEvent = e;

    const pointerId = getPointerId(e);

    if (pointerId === this.dragPointerId) {
      e.preventDefault();
      const { x: wx, y: wy } = this.clientToWorldPoint(e.clientX, e.clientY);
      this.bindings.updateGlassDrag(wx, wy);
      this.glassHovered = true;
      this.updateCanvasCursor();
      return;
    }

    if (this.dragPointerId === null && e.target === this.canvas && e.pointerType !== 'touch') {
      const { x: wx, y: wy } = this.clientToWorldPoint(e.clientX, e.clientY);
      this.glassHovered = this.bindings.isPointNearGlass(wx, wy);
      this.updateCanvasCursor();
    }
  }

  private handleCanvasPointerFinish(e: PointerEvent, isCancel: boolean): void {
    const pointerId = getPointerId(e);
    if (this.dragPointerId !== pointerId) return;

    this.dragPointerId = null;
    safeReleasePointerCapture(this.canvas, pointerId);
    this.bindings.endGlassDrag();

    if (isCancel || e.pointerType === 'touch') {
      this.glassHovered = false;
    } else {
      const { x: wx, y: wy } = this.clientToWorldPoint(e.clientX, e.clientY);
      this.glassHovered = this.bindings.isPointNearGlass(wx, wy);
    }
    this.updateCanvasCursor();
  }

  private handleWindowBlur(): void {
    if (this.dragPointerId !== null) {
      safeReleasePointerCapture(this.canvas, this.dragPointerId);
      this.dragPointerId = null;
      this.bindings.endGlassDrag();
    }

    this.glassHovered = false;
    this.updateCanvasCursor();

    const drinksToRelease = new Set<DrinkId>();
    for (const [pid, entry] of this.heldPointers) {
      safeReleasePointerCapture(entry.button, pid);
      drinksToRelease.add(entry.id);
    }
    for (const id of this.heldKeys) {
      drinksToRelease.add(id);
    }

    this.heldPointers.clear();
    this.heldKeys.clear();

    for (const id of drinksToRelease) {
      if (!this.latchedDrinks.has(id)) {
        this.externalActiveDrinks.delete(id);
        this.bindings.setDispensing(id, false);
      }
    }

    this.syncPadAndStopVisuals();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
      return;
    }

    const mappedDrink = KEY_TO_DRINK.get(e.key);
    if (mappedDrink) {
      if (e.repeat) return;
      e.preventDefault();
      this.latchedDrinks.delete(mappedDrink);
      this.heldKeys.add(mappedDrink);
      this.bindings.setDispensing(mappedDrink, true);
      this.syncPadAndStopVisuals();
      return;
    }

    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) {
        this.stopAllPouring();
      }
      return;
    }

    if (
      e.key === 'r' ||
      e.key === 'R' ||
      e.key === 'Backspace' ||
      e.key === 'Delete'
    ) {
      if (e.repeat) return;
      e.preventDefault();
      this.bindings.emptyGlass();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const mappedDrink = KEY_TO_DRINK.get(e.key);
    if (!mappedDrink) return;

    if (this.heldKeys.delete(mappedDrink) && !this.isDrinkLocallyActive(mappedDrink)) {
      this.externalActiveDrinks.delete(mappedDrink);
      this.bindings.setDispensing(mappedDrink, false);
      this.syncPadAndStopVisuals();
    }
  }

  private stopAllPouring(): void {
    for (const [pid, entry] of this.heldPointers) {
      safeReleasePointerCapture(entry.button, pid);
    }
    this.heldPointers.clear();
    this.latchedDrinks.clear();
    this.heldKeys.clear();
    this.externalActiveDrinks.clear();
    this.bindings.stopAllDispensing();
    this.syncPadAndStopVisuals();
  }

  private isPointerHolding(id: DrinkId): boolean {
    for (const entry of this.heldPointers.values()) {
      if (entry.id === id) return true;
    }
    return false;
  }

  private isDrinkLocallyActive(id: DrinkId): boolean {
    return (
      this.latchedDrinks.has(id) ||
      this.isPointerHolding(id) ||
      this.heldKeys.has(id)
    );
  }

  private syncPadAndStopVisuals(): void {
    for (const drink of DRINKS) {
      const btn = this.padButtons.get(drink.id);
      const cached = this.padCache.get(drink.id);
      if (!btn || !cached) continue;

      const isLatched = this.latchedDrinks.has(drink.id);
      const isActive =
        this.externalActiveDrinks.has(drink.id) || this.isDrinkLocallyActive(drink.id);

      if (isActive !== cached.active) {
        cached.active = isActive;
        btn.classList.toggle('is-active', isActive);
        btn.dataset.active = isActive ? 'true' : 'false';
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      }

      if (isLatched !== cached.latched) {
        cached.latched = isLatched;
        btn.classList.toggle('is-latched', isLatched);
        btn.dataset.latched = isLatched ? 'true' : 'false';
      }
    }

    const hasLatched = this.latchedDrinks.size > 0;
    if (hasLatched !== this.prevHasLatched) {
      this.prevHasLatched = hasLatched;
      this.stopBtnEl.hidden = !hasLatched;
    }
  }

  private clientToWorldPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return clientToWorld(clientX, clientY, rect, this.vp);
  }

  private updateCanvasCursor(): void {
    const nextCursor =
      this.dragPointerId !== null ? 'grabbing' : this.glassHovered ? 'grab' : 'default';
    if (nextCursor !== this.prevCursor) {
      this.prevCursor = nextCursor;
      this.canvas.style.cursor = nextCursor;
    }
  }
}
