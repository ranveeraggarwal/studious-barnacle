import './style.css';
import { toFluidTelemetry } from './physics/colorMixer';
import { FluidWorld } from './physics/fluidWorld';
import {
  DrinkId,
  GlassLiquidSummary,
  GlassState,
  SimulationSnapshot,
  SodaSimulationAPI,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './types/simulation';
import { FountainControls, ensureFountainDOM } from './ui/controls';
import { RendererOptions, SodaFountainRenderer } from './webgl/renderer';

export interface InitSodaFountainOptions {
  readonly doc?: Document;
  readonly win?: Window & typeof globalThis;
  readonly rendererOptions?: RendererOptions;
  readonly seed?: number;
  readonly autoStartLoop?: boolean;
}

export interface SodaFountainApp {
  readonly world: FluidWorld;
  readonly renderer: SodaFountainRenderer;
  readonly controls: FountainControls;
  readonly api: SodaSimulationAPI;
  dispose(): void;
}

/**
 * Minimal headless WebGL2 stub context used ONLY when running in non-browser unit test
 * environments (e.g. `jsdom`) where `HTMLCanvasElement.prototype.getContext` returns `null`.
 * In real browsers / Chromium, native WebGL2/WebGL1 contexts are always used.
 */
function createHeadlessStubGL(
  canvas: HTMLCanvasElement,
): WebGL2RenderingContext {
  const glStub: Record<string, unknown> = {
    canvas,
    VERSION: 0x1f02,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    RGBA16F: 0x881a,
    HALF_FLOAT: 0x140b,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE0: 0x84c0,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    ONE: 1,
    ZERO: 0,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    POINTS: 0x0000,
    get drawingBufferWidth() {
      return canvas.width || WORLD_WIDTH;
    },
    get drawingBufferHeight() {
      return canvas.height || WORLD_HEIGHT;
    },
    getParameter(pname: number) {
      if (pname === 0x1f02) return 'WebGL 2.0 (Headless Stub)';
      return 0;
    },
    getExtension() {
      return {};
    },
    createShader() {
      return {};
    },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() {
      return true;
    },
    getShaderInfoLog() {
      return '';
    },
    deleteShader() {},
    createProgram() {
      return {};
    },
    attachShader() {},
    bindAttribLocation() {},
    linkProgram() {},
    getProgramParameter() {
      return true;
    },
    getProgramInfoLog() {
      return '';
    },
    useProgram() {},
    deleteProgram() {},
    getAttribLocation(_prog: unknown, name: string) {
      const order = ['a_position', 'a_color', 'a_radius', 'a_state', 'a_alpha', 'a_isFoam', 'a_edgeFactor'];
      const idx = order.indexOf(name);
      return idx >= 0 ? idx : 0;
    },
    getUniformLocation() {
      return {};
    },
    uniform1i() {},
    uniform1f() {},
    uniform2f() {},
    uniform3f() {},
    uniform4f() {},
    createBuffer() {
      return {};
    },
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() {},
    enableVertexAttribArray() {},
    disableVertexAttribArray() {},
    vertexAttribPointer() {},
    createTexture() {
      return {};
    },
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    activeTexture() {},
    deleteTexture() {},
    createFramebuffer() {
      return {};
    },
    bindFramebuffer() {},
    framebufferTexture2D() {},
    checkFramebufferStatus() {
      return 0x8cd5;
    },
    deleteFramebuffer() {},
    viewport() {},
    clearColor() {},
    clear() {},
    enable() {},
    disable() {},
    blendFunc() {},
    blendFuncSeparate() {},
    drawArrays() {},
    readPixels(
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _format: number,
      _type: number,
      pixels: ArrayBufferView | null,
    ) {
      if (pixels && pixels instanceof Uint8Array) {
        pixels.fill(0);
      }
    },
    isContextLost() {
      return false;
    },
  };

  return glStub as unknown as WebGL2RenderingContext;
}

let activeAppInstance: SodaFountainApp | null = null;

/**
 * Bootstraps the Soda Fountain simulation world, 5-pass WebGL renderer, unified input controller,
 * responsive viewport observer, and `window.__SODA_SIM__` / `window.__SODA_FOUNTAIN__` telemetry API.
 */
export function initSodaFountainApp(
  options: InitSodaFountainOptions = {},
): SodaFountainApp {
  if (activeAppInstance) {
    activeAppInstance.dispose();
    activeAppInstance = null;
  }

  const doc = options.doc ?? document;
  const win =
    options.win ??
    ((doc.defaultView ?? window) as Window & typeof globalThis);

  const dom = ensureFountainDOM(doc);
  const world = new FluidWorld(options.seed);

  let renderer: SodaFountainRenderer;
  const isJsdomEnv =
    !options.rendererOptions?.gl &&
    typeof navigator !== 'undefined' &&
    /jsdom/i.test(navigator.userAgent || '');

  if (isJsdomEnv) {
    renderer = new SodaFountainRenderer(dom.canvas, {
      ...options.rendererOptions,
      gl: createHeadlessStubGL(dom.canvas),
    });
  } else {
    try {
      renderer = new SodaFountainRenderer(dom.canvas, options.rendererOptions);
    } catch (err) {
      if (options.rendererOptions?.gl) {
        throw err;
      }
      renderer = new SodaFountainRenderer(dom.canvas, {
        ...options.rendererOptions,
        gl: createHeadlessStubGL(dom.canvas),
      });
    }
  }

  world.setWebGLVersion(renderer.webglVersion);

  let lastCssWidth = 0;
  let lastCssHeight = 0;
  let lastDpr = 0;
  let manualStepMode = false;
  let renderDirty = false;
  let disposed = false;
  let rafId: number | null = null;

  const syncCanvasSize = (force = false): void => {
    const rect =
      typeof dom.canvas.getBoundingClientRect === 'function'
        ? dom.canvas.getBoundingClientRect()
        : null;
    const cssWidth = Math.round(
      (rect && rect.width > 0 ? rect.width : dom.canvas.clientWidth) ||
        dom.canvas.width ||
        WORLD_WIDTH,
    );
    const cssHeight = Math.round(
      (rect && rect.height > 0 ? rect.height : dom.canvas.clientHeight) ||
        dom.canvas.height ||
        WORLD_HEIGHT,
    );
    const dpr =
      typeof win.devicePixelRatio === 'number' && win.devicePixelRatio > 0
        ? win.devicePixelRatio
        : 1;

    if (
      force ||
      cssWidth !== lastCssWidth ||
      cssHeight !== lastCssHeight ||
      dpr !== lastDpr
    ) {
      lastCssWidth = cssWidth;
      lastCssHeight = cssHeight;
      lastDpr = dpr;
      const screenRect = renderer.resize(cssWidth, cssHeight, dpr);
      world.updateGlassScreenRect(screenRect);
    } else {
      const screenRect = renderer.computeGlassScreenRect(world.getGlassState());
      world.updateGlassScreenRect(screenRect);
    }
  };

  let api!: SodaSimulationAPI;

  const controls = new FountainControls({
    world,
    doc,
    win,
    webglVersion: renderer.webglVersion,
    onRenderRequested: () => {
      if (disposed) return;
      syncCanvasSize();
      if (manualStepMode) {
        renderDirty = true;
      } else {
        renderer.render(world);
        renderDirty = false;
      }
    },
    onResetRequested: () => {
      api.reset();
    },
  });

  api = {
    get isReady(): boolean {
      return !disposed;
    },
    get frameCount(): number {
      return world.getFrameCount();
    },
    get activeDrinks(): ReadonlyArray<DrinkId> {
      return world.getActiveDrinks();
    },
    get glass(): Readonly<GlassState> {
      syncCanvasSize();
      return world.getGlassState();
    },
    get liquid(): GlassLiquidSummary {
      return world.getLiquidSummary();
    },
    get fluid(): SimulationSnapshot['fluid'] {
      return toFluidTelemetry(world.getLiquidSummary());
    },
    getSnapshot(): SimulationSnapshot {
      syncCanvasSize();
      return world.getSnapshot();
    },
    startPouring(drinkId: DrinkId): void {
      controls.startPouringProgrammatic(drinkId);
    },
    stopPouring(drinkId?: DrinkId): void {
      controls.stopPouringProgrammatic(drinkId);
    },
    moveGlassTo(x: number, y?: number): void {
      syncCanvasSize();
      world.moveGlassTo(x, y);
      renderer.render(world);
      renderDirty = false;
      controls.syncDomState();
    },
    emptyGlass(): void {
      syncCanvasSize();
      world.emptyGlass();
      renderer.render(world);
      renderDirty = false;
      controls.syncDomState();
    },
    reset(): void {
      syncCanvasSize();
      controls.clearAllInputState();
      world.reset();
      renderer.render(world);
      renderDirty = false;
      controls.syncDomState();
    },
    stepFrames(count = 1, dtSeconds = 1 / 60): void {
      manualStepMode = true;
      if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
        win.cancelAnimationFrame(rafId);
        rafId = null;
      }
      syncCanvasSize();
      world.stepFrames(count, dtSeconds);
      renderer.render(world);
      renderDirty = false;
      controls.syncDomState();
    },
    samplePixelAtWorld(
      worldX: number,
      worldY: number,
    ): [number, number, number, number] {
      if (renderDirty) {
        renderer.render(world);
        renderDirty = false;
      }
      return renderer.samplePixelAtWorld(worldX, worldY);
    },
    sampleGlassLiquidPixel(): [number, number, number, number] {
      if (renderDirty) {
        renderer.render(world);
        renderDirty = false;
      }
      return renderer.sampleGlassLiquidPixel(world.getRenderState());
    },
  };

  win.__SODA_SIM__ = api;
  win.__SODA_FOUNTAIN__ = api;
  if (typeof window !== 'undefined') {
    window.__SODA_SIM__ = api;
    window.__SODA_FOUNTAIN__ = api;
  }

  // Initial resize, render, and DOM state synchronization
  syncCanvasSize(true);
  renderer.render(world);
  renderDirty = false;
  controls.setWebGLVersion(renderer.webglVersion);
  controls.setReady(true);
  controls.syncDomState();

  const onWindowResize = () => {
    if (disposed) return;
    syncCanvasSize(true);
    renderer.render(world);
    renderDirty = false;
    controls.syncDomState();
  };

  win.addEventListener('resize', onWindowResize);

  const autoStart = options.autoStartLoop ?? true;
  if (autoStart && typeof win.requestAnimationFrame === 'function') {
    const tick = () => {
      if (disposed || manualStepMode) return;
      syncCanvasSize();
      world.stepFrames(1, 1 / 60);
      renderer.render(world);
      renderDirty = false;
      controls.syncDomState();
      rafId = win.requestAnimationFrame(tick);
    };
    rafId = win.requestAnimationFrame(tick);
  }

  const app: SodaFountainApp = {
    world,
    renderer,
    controls,
    api,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
        win.cancelAnimationFrame(rafId);
        rafId = null;
      }
      win.removeEventListener('resize', onWindowResize);
      controls.dispose();
      renderer.dispose();
      if (activeAppInstance === app) {
        activeAppInstance = null;
      }
    },
  };

  activeAppInstance = app;
  return app;
}

if (
  typeof document !== 'undefined' &&
  (document.getElementById('fountain-canvas') ||
    document.querySelector('[data-testid="fountain-canvas"]'))
) {
  initSodaFountainApp();
}
