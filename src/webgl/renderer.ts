import { DRINKS } from '../drinks';
import {
  MAX_BUBBLES,
  MAX_PARTICLES,
  SimulationSnapshot,
  ViewportTransform,
} from '../types';
import {
  createOffscreenFBO,
  destroyOffscreenFBO,
  detectSplatFormat,
  getInstancingAdapter,
  GLContext,
  hexToRgb01,
  InstancingAdapter,
  OffscreenFBO,
  ShaderProgram,
} from './glUtils';
import { buildShaderSources } from './shaders';

const QUAD_CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export class FountainRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: GLContext;
  private readonly isWebGL2: boolean;
  private readonly instancing: InstancingAdapter | null;

  private writeScale: number;
  private readScale: number;
  private readonly preferFloat16: boolean;

  private readonly studioBgProg: ShaderProgram;
  private readonly particleSplatProg: ShaderProgram;
  private readonly blurProg: ShaderProgram;
  private readonly liquidShadeProg: ShaderProgram;
  private readonly bubbleProg: ShaderProgram;
  private readonly glassCompositeProg: ShaderProgram;

  private readonly quadVBO: WebGLBuffer;
  private readonly particleInstanceVBO: WebGLBuffer;
  private readonly bubbleInstanceVBO: WebGLBuffer;
  private fallbackParticleVBO: WebGLBuffer | null = null;
  private fallbackBubbleVBO: WebGLBuffer | null = null;
  private fallbackIndexIBO: WebGLBuffer | null = null;
  private fallbackParticleData: Float32Array | null = null;
  private fallbackBubbleData: Float32Array | null = null;

  private fullscreenVAO: WebGLVertexArrayObject | null = null;
  private particleVAO: WebGLVertexArrayObject | null = null;
  private bubbleVAO: WebGLVertexArrayObject | null = null;

  private particleCapacity = MAX_PARTICLES;
  private bubbleCapacity = MAX_BUBBLES;

  private bgFBO: OffscreenFBO | null = null;
  private sceneFBO: OffscreenFBO | null = null;
  private splatFBO_A: OffscreenFBO | null = null;
  private splatFBO_B: OffscreenFBO | null = null;
  private fboWidth = 0;
  private fboHeight = 0;
  private splatWidth = 0;
  private splatHeight = 0;
  private readonly maxTexSize: number;

  // Static cache state for Pass 1 (bgFBO) so idle/settled frames cost 0.00 ms
  private bgCacheDirty = true;
  private cachedBgViewLeft = NaN;
  private cachedBgViewRight = NaN;
  private cachedBgViewBottom = NaN;
  private cachedBgViewTop = NaN;
  private cachedBgGlassX = NaN;
  private cachedBgGlassY = NaN;
  private cachedBgFill = NaN;
  private readonly cachedBgNozzleActive = new Float32Array([-1, -1, -1, -1, -1]);

  private readonly nozzleXUniform = new Float32Array(5);
  private readonly nozzleRingColorUniform = new Float32Array(15);
  private readonly nozzleGlowColorUniform = new Float32Array(15);
  private readonly nozzleActiveUniform = new Float32Array(5);

  private hoverHighlight = 0;
  private lastRenderTime = -1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const contextAttrs: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    };

    const gl2 = canvas.getContext('webgl2', contextAttrs) as WebGL2RenderingContext | null;
    if (gl2) {
      this.gl = gl2;
      this.isWebGL2 = true;
    } else {
      const gl1 =
        (canvas.getContext('webgl', contextAttrs) as WebGLRenderingContext | null) ??
        (canvas.getContext('experimental-webgl', contextAttrs) as WebGLRenderingContext | null);
      if (!gl1) {
        throw new Error('WebGL2 and WebGL1 are unavailable on this browser/device.');
      }
      this.gl = gl1;
      this.isWebGL2 = false;
    }

    const gl = this.gl;
    this.maxTexSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;
    this.instancing = getInstancingAdapter(gl, this.isWebGL2);

    const splatFormat = detectSplatFormat(gl, this.isWebGL2);
    this.preferFloat16 = splatFormat.useFloat16;
    this.writeScale = splatFormat.writeScale;
    this.readScale = splatFormat.readScale;

    // Precompute static 5-nozzle physical positions & brand colors from DRINKS
    for (let i = 0; i < 5; i++) {
      const drink = DRINKS[i];
      this.nozzleXUniform[i] = drink.nozzleX;
      const ringRgb = hexToRgb01(drink.badgeColor);
      const glowRgb = hexToRgb01(drink.accentGlow);
      this.nozzleRingColorUniform[i * 3 + 0] = ringRgb[0];
      this.nozzleRingColorUniform[i * 3 + 1] = ringRgb[1];
      this.nozzleRingColorUniform[i * 3 + 2] = ringRgb[2];
      this.nozzleGlowColorUniform[i * 3 + 0] = glowRgb[0];
      this.nozzleGlowColorUniform[i * 3 + 1] = glowRgb[1];
      this.nozzleGlowColorUniform[i * 3 + 2] = glowRgb[2];
    }

    // Compile all shader programs with deterministic attribute locations
    const sources = buildShaderSources(this.isWebGL2);
    this.studioBgProg = new ShaderProgram(
      gl,
      sources.studioBg.vert,
      sources.studioBg.frag,
      'studioBg',
      { aPosition: 0 }
    );
    this.particleSplatProg = new ShaderProgram(
      gl,
      sources.particleSplat.vert,
      sources.particleSplat.frag,
      'particleSplat',
      { aCorner: 0, aPosVel: 1, aAbsFizz: 2 }
    );
    this.blurProg = new ShaderProgram(gl, sources.blur.vert, sources.blur.frag, 'blur', {
      aPosition: 0,
    });
    this.liquidShadeProg = new ShaderProgram(
      gl,
      sources.liquidShade.vert,
      sources.liquidShade.frag,
      'liquidShade',
      { aPosition: 0 }
    );
    this.bubbleProg = new ShaderProgram(
      gl,
      sources.bubble.vert,
      sources.bubble.frag,
      'bubble',
      { aCorner: 0, aBubble: 1 }
    );
    this.glassCompositeProg = new ShaderProgram(
      gl,
      sources.glassComposite.vert,
      sources.glassComposite.frag,
      'glassComposite',
      { aPosition: 0 }
    );

    // Create geometry & dynamic instance buffers
    const quadBuf = gl.createBuffer();
    const partBuf = gl.createBuffer();
    const bubBuf = gl.createBuffer();
    if (!quadBuf || !partBuf || !bubBuf) {
      throw new Error('Failed to allocate WebGL vertex buffers.');
    }
    this.quadVBO = quadBuf;
    this.particleInstanceVBO = partBuf;
    this.bubbleInstanceVBO = bubBuf;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleInstanceVBO);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.particleCapacity * 8 * Float32Array.BYTES_PER_ELEMENT,
      gl.DYNAMIC_DRAW
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleInstanceVBO);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.bubbleCapacity * 4 * Float32Array.BYTES_PER_ELEMENT,
      gl.DYNAMIC_DRAW
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    if (this.isWebGL2 && this.instancing) {
      this.initWebGL2VAOs(gl as WebGL2RenderingContext);
    } else if (!this.instancing) {
      this.initNonInstancedFallback(gl);
    }
  }

  private initWebGL2VAOs(gl2: WebGL2RenderingContext): void {
    // 1. Fullscreen quad VAO
    const fsVao = gl2.createVertexArray();
    if (fsVao) {
      gl2.bindVertexArray(fsVao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.quadVBO);
      gl2.enableVertexAttribArray(0);
      gl2.vertexAttribPointer(0, 2, gl2.FLOAT, false, 0, 0);
      this.fullscreenVAO = fsVao;
    }

    // 2. Instanced particle splat VAO
    const pVao = gl2.createVertexArray();
    if (pVao) {
      gl2.bindVertexArray(pVao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.quadVBO);
      gl2.enableVertexAttribArray(0);
      gl2.vertexAttribPointer(0, 2, gl2.FLOAT, false, 0, 0);
      gl2.vertexAttribDivisor(0, 0);

      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.particleInstanceVBO);
      gl2.enableVertexAttribArray(1);
      gl2.vertexAttribPointer(1, 4, gl2.FLOAT, false, 32, 0);
      gl2.vertexAttribDivisor(1, 1);
      gl2.enableVertexAttribArray(2);
      gl2.vertexAttribPointer(2, 4, gl2.FLOAT, false, 32, 16);
      gl2.vertexAttribDivisor(2, 1);
      this.particleVAO = pVao;
    }

    // 3. Instanced bubble VAO
    const bVao = gl2.createVertexArray();
    if (bVao) {
      gl2.bindVertexArray(bVao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.quadVBO);
      gl2.enableVertexAttribArray(0);
      gl2.vertexAttribPointer(0, 2, gl2.FLOAT, false, 0, 0);
      gl2.vertexAttribDivisor(0, 0);

      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.bubbleInstanceVBO);
      gl2.enableVertexAttribArray(1);
      gl2.vertexAttribPointer(1, 4, gl2.FLOAT, false, 16, 0);
      gl2.vertexAttribDivisor(1, 1);
      this.bubbleVAO = bVao;
    }

    gl2.bindVertexArray(null);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
  }

  private initNonInstancedFallback(gl: GLContext): void {
    this.fallbackParticleVBO = gl.createBuffer();
    this.fallbackBubbleVBO = gl.createBuffer();
    this.fallbackIndexIBO = gl.createBuffer();

    const maxQuads = Math.max(this.particleCapacity, this.bubbleCapacity);
    const indices = new Uint16Array(maxQuads * 6);
    for (let i = 0; i < maxQuads; i++) {
      const v = i * 4;
      const o = i * 6;
      indices[o + 0] = v + 0;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v + 2;
      indices[o + 4] = v + 1;
      indices[o + 5] = v + 3;
    }

    if (this.fallbackIndexIBO) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fallbackIndexIBO);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }

    this.fallbackParticleData = new Float32Array(this.particleCapacity * 4 * 10);
    this.fallbackBubbleData = new Float32Array(this.bubbleCapacity * 4 * 6);

    if (this.fallbackParticleVBO) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fallbackParticleVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.fallbackParticleData.byteLength, gl.DYNAMIC_DRAW);
    }
    if (this.fallbackBubbleVBO) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fallbackBubbleVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.fallbackBubbleData.byteLength, gl.DYNAMIC_DRAW);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  public resize(vp: ViewportTransform): void {
    if (this.disposed) return;
    const gl = this.gl;

    const targetW = Math.min(this.maxTexSize, Math.max(1, Math.round(vp.cssWidth * vp.dpr)));
    const targetH = Math.min(this.maxTexSize, Math.max(1, Math.round(vp.cssHeight * vp.dpr)));
    const splatW = Math.max(1, Math.round(targetW * 0.5));
    const splatH = Math.max(1, Math.round(targetH * 0.5));

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    if (
      this.fboWidth === targetW &&
      this.fboHeight === targetH &&
      this.splatWidth === splatW &&
      this.splatHeight === splatH &&
      this.bgFBO &&
      this.sceneFBO &&
      this.splatFBO_A &&
      this.splatFBO_B
    ) {
      return;
    }

    destroyOffscreenFBO(gl, this.bgFBO);
    destroyOffscreenFBO(gl, this.sceneFBO);
    destroyOffscreenFBO(gl, this.splatFBO_A);
    destroyOffscreenFBO(gl, this.splatFBO_B);

    this.bgFBO = createOffscreenFBO(gl, this.isWebGL2, targetW, targetH, false);
    this.sceneFBO = createOffscreenFBO(gl, this.isWebGL2, targetW, targetH, false);
    this.splatFBO_A = createOffscreenFBO(gl, this.isWebGL2, splatW, splatH, this.preferFloat16);
    this.splatFBO_B = createOffscreenFBO(gl, this.isWebGL2, splatW, splatH, this.preferFloat16);

    if (this.splatFBO_A.isFloat && this.splatFBO_B.isFloat) {
      this.writeScale = 1.0;
      this.readScale = 1.0;
    } else {
      this.writeScale = 1.0 / 8.0;
      this.readScale = 8.0;
    }

    this.fboWidth = targetW;
    this.fboHeight = targetH;
    this.splatWidth = splatW;
    this.splatHeight = splatH;
    this.bgCacheDirty = true;
  }

  public render(
    snapshot: SimulationSnapshot,
    vp: ViewportTransform,
    glassHovered: boolean
  ): void {
    if (this.disposed) return;

    const gl = this.gl;
    const expectedW = Math.min(this.maxTexSize, Math.max(1, Math.round(vp.cssWidth * vp.dpr)));
    const expectedH = Math.min(this.maxTexSize, Math.max(1, Math.round(vp.cssHeight * vp.dpr)));
    if (
      !this.bgFBO ||
      !this.sceneFBO ||
      !this.splatFBO_A ||
      !this.splatFBO_B ||
      this.canvas.width !== expectedW ||
      this.canvas.height !== expectedH ||
      this.fboWidth !== expectedW ||
      this.fboHeight !== expectedH
    ) {
      this.resize(vp);
    }

    const bgFBO = this.bgFBO!;
    const sceneFBO = this.sceneFBO!;
    const splatA = this.splatFBO_A!;
    const splatB = this.splatFBO_B!;
    const width = this.fboWidth;
    const height = this.fboHeight;
    const splatW = this.splatWidth;
    const splatH = this.splatHeight;

    // Smoothly animate nozzle LED downlights & glass hover/drag rim brightening
    const dt =
      this.lastRenderTime >= 0
        ? Math.max(0, Math.min(0.1, snapshot.time - this.lastRenderTime))
        : 1 / 60;
    this.lastRenderTime = snapshot.time;
    const blendRate = 1.0 - Math.exp(-dt * 16.0);

    for (let i = 0; i < 5; i++) {
      const isActive = snapshot.activeDrinks.has(DRINKS[i].id);
      if (isActive) {
        this.nozzleActiveUniform[i] = Math.max(
          0.86,
          this.nozzleActiveUniform[i] + (1.0 - this.nozzleActiveUniform[i]) * blendRate
        );
        if (this.nozzleActiveUniform[i] > 0.998) this.nozzleActiveUniform[i] = 1.0;
      } else {
        this.nozzleActiveUniform[i] += (0.0 - this.nozzleActiveUniform[i]) * blendRate;
        if (this.nozzleActiveUniform[i] < 0.002) this.nozzleActiveUniform[i] = 0;
      }
    }

    const wantHighlight = glassHovered || snapshot.glass.isDragging;
    if (wantHighlight) {
      this.hoverHighlight = Math.max(
        0.85,
        this.hoverHighlight + (1.0 - this.hoverHighlight) * blendRate
      );
    } else {
      this.hoverHighlight += (0.0 - this.hoverHighlight) * blendRate;
      if (this.hoverHighlight < 0.002) this.hoverHighlight = 0;
    }

    const viewSpanX = Math.max(1e-4, vp.viewRight - vp.viewLeft);
    const viewSpanY = Math.max(1e-4, vp.viewTop - vp.viewBottom);
    const pixelsPerWorld = vp.scale * vp.dpr;
    const splatPixelsPerWorld = pixelsPerWorld * 0.5;
    const worldPerPixel = viewSpanX / Math.max(1, width);
    const worldToUvX = 1.0 / viewSpanX;
    const worldToUvY = 1.0 / viewSpanY;

    // Effective carbonation level for upward-facing meniscus foam inside the glass
    let foamCarbonation = 0;
    if (snapshot.particleCount > 0) {
      let weightedCarb = 0;
      let shareSum = 0;
      for (let i = 0; i < 5; i++) {
        const d = DRINKS[i];
        const share = snapshot.mix.recipeShares[d.id] ?? 0;
        weightedCarb += share * d.carbonation;
        shareSum += share;
      }
      const baseCarb = shareSum > 0.01 ? weightedCarb / shareSum : 0.82;
      const pourBoost = snapshot.activeDrinks.size > 0 ? 0.16 : 0.0;
      foamCarbonation = Math.min(1.0, baseCarb * 0.85 + pourBoost);
    }

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);

    // =========================================================================
    // PASS 1: Render Procedural Studio & Soda Fountain Scene -> bgFBO (Cached)
    // =========================================================================
    const quantizedFill = Math.round(snapshot.mix.fillRatio * 50) * 0.02;
    const glassDx = snapshot.glass.x - this.cachedBgGlassX;
    const glassDy = snapshot.glass.y - this.cachedBgGlassY;

    let nozzlesChanged = false;
    for (let i = 0; i < 5; i++) {
      if (Math.abs(this.nozzleActiveUniform[i] - this.cachedBgNozzleActive[i]) > 0.002) {
        nozzlesChanged = true;
        break;
      }
    }

    const needBgRender =
      this.bgCacheDirty ||
      this.cachedBgViewLeft !== vp.viewLeft ||
      this.cachedBgViewRight !== vp.viewRight ||
      this.cachedBgViewBottom !== vp.viewBottom ||
      this.cachedBgViewTop !== vp.viewTop ||
      !(glassDx * glassDx + glassDy * glassDy <= 0.15 * 0.15) ||
      Math.abs(quantizedFill - this.cachedBgFill) > 0.001 ||
      nozzlesChanged;

    if (needBgRender) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bgFBO.fbo);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);

      this.studioBgProg.use();
      this.studioBgProg.set4f('uViewBounds', vp.viewLeft, vp.viewRight, vp.viewBottom, vp.viewTop);
      this.studioBgProg.set1f('uWorldPerPixel', worldPerPixel);
      this.studioBgProg.set2f('uGlassPos', snapshot.glass.x, snapshot.glass.y);
      this.studioBgProg.set1f('uGlassFill', quantizedFill);
      this.studioBgProg.set1fv('uNozzleX', this.nozzleXUniform);
      this.studioBgProg.set3fv('uNozzleRingColor', this.nozzleRingColorUniform);
      this.studioBgProg.set3fv('uNozzleGlowColor', this.nozzleGlowColorUniform);
      this.studioBgProg.set1fv('uNozzleActive', this.nozzleActiveUniform);
      this.studioBgProg.set1f('uTime', snapshot.time);

      this.drawFullscreenQuad();

      this.bgCacheDirty = false;
      this.cachedBgViewLeft = vp.viewLeft;
      this.cachedBgViewRight = vp.viewRight;
      this.cachedBgViewBottom = vp.viewBottom;
      this.cachedBgViewTop = vp.viewTop;
      this.cachedBgGlassX = snapshot.glass.x;
      this.cachedBgGlassY = snapshot.glass.y;
      this.cachedBgFill = quantizedFill;
      this.cachedBgNozzleActive.set(this.nozzleActiveUniform);
    }

    // =========================================================================
    // PASS 2 & 3: Half-Res (0.5x) Optical Splatting + 9-Tap Separable Blur
    // =========================================================================
    const pCount = Math.min(
      snapshot.particleCount,
      Math.floor(snapshot.particleData.length / 8)
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, splatA.fbo);
    gl.viewport(0, 0, splatW, splatH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (pCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      this.particleSplatProg.use();
      this.particleSplatProg.set4f(
        'uViewBounds',
        vp.viewLeft,
        vp.viewRight,
        vp.viewBottom,
        vp.viewTop
      );
      this.particleSplatProg.set1f('uSplatWriteScale', this.writeScale);
      this.particleSplatProg.set1f('uPixelsPerWorld', splatPixelsPerWorld);

      this.drawParticles(snapshot.particleData, pCount);

      gl.disable(gl.BLEND);

      // 9-tap separable Gaussian blur with ~3.8 world units radius relative to 1/splatW, 1/splatH
      const blurTapTexels = (3.8 / 4.0) * splatPixelsPerWorld;
      const invSplatW = 1.0 / splatW;
      const invSplatH = 1.0 / splatH;

      // Pass 3a: Horizontal blur (splatFBO_A -> splatFBO_B)
      gl.bindFramebuffer(gl.FRAMEBUFFER, splatB.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, splatA.texture);

      this.blurProg.use();
      this.blurProg.set4f('uViewBounds', vp.viewLeft, vp.viewRight, vp.viewBottom, vp.viewTop);
      this.blurProg.set1i('uInputTex', 0);
      this.blurProg.set2f('uBlurStep', blurTapTexels * invSplatW, 0.0);
      this.drawFullscreenQuad();

      // Pass 3b: Vertical blur (splatFBO_B -> splatFBO_A)
      gl.bindFramebuffer(gl.FRAMEBUFFER, splatA.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, splatB.texture);

      this.blurProg.set2f('uBlurStep', 0.0, blurTapTexels * invSplatH);
      this.drawFullscreenQuad();
    }

    // =========================================================================
    // PASS 4A: Beer-Lambert Liquid Shading + Meniscus + Fizz Foam -> sceneFBO
    // =========================================================================
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO.fbo);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgFBO.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, splatA.texture);

    this.liquidShadeProg.use();
    this.liquidShadeProg.set4f(
      'uViewBounds',
      vp.viewLeft,
      vp.viewRight,
      vp.viewBottom,
      vp.viewTop
    );
    this.liquidShadeProg.set1i('uBgTex', 0);
    this.liquidShadeProg.set1i('uSplatTex', 1);
    this.liquidShadeProg.set1f('uSplatReadScale', this.readScale);
    this.liquidShadeProg.set2f('uNormalStepUv', 1.5 * worldToUvX, 1.5 * worldToUvY);
    this.liquidShadeProg.set2f('uWorldToUv', worldToUvX, worldToUvY);
    this.liquidShadeProg.set2f('uGlassPos', snapshot.glass.x, snapshot.glass.y);
    this.liquidShadeProg.set1f('uGlassTilt', snapshot.glass.tilt);
    this.liquidShadeProg.set1f('uFoamCarbonation', foamCarbonation);
    this.liquidShadeProg.set1f('uTime', snapshot.time);

    this.drawFullscreenQuad();

    // Unbind texture unit 1 cleanly
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // =========================================================================
    // PASS 4B: Sparkling Refractive Bubbles Clipped Inside Liquid -> sceneFBO
    // =========================================================================
    const bCount = Math.min(snapshot.bubbleCount, Math.floor(snapshot.bubbleData.length / 4));
    if (bCount > 0 && pCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, splatA.texture);

      this.bubbleProg.use();
      this.bubbleProg.set4f(
        'uViewBounds',
        vp.viewLeft,
        vp.viewRight,
        vp.viewBottom,
        vp.viewTop
      );
      this.bubbleProg.set1f('uPixelsPerWorld', pixelsPerWorld);
      this.bubbleProg.set1i('uSplatTex', 0);
      this.bubbleProg.set1f('uSplatReadScale', this.readScale);

      this.drawBubbles(snapshot.bubbleData, bCount);

      gl.disable(gl.BLEND);
    }

    // =========================================================================
    // PASS 5: Refractive Tapered Crystal Tumbler Glass -> Default Screen FBO
    // =========================================================================
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneFBO.texture);

    this.glassCompositeProg.use();
    this.glassCompositeProg.set4f(
      'uViewBounds',
      vp.viewLeft,
      vp.viewRight,
      vp.viewBottom,
      vp.viewTop
    );
    this.glassCompositeProg.set1i('uSceneTex', 0);
    this.glassCompositeProg.set2f('uGlassPos', snapshot.glass.x, snapshot.glass.y);
    this.glassCompositeProg.set1f('uGlassTilt', snapshot.glass.tilt);
    this.glassCompositeProg.set1f('uGlassHighlight', this.hoverHighlight);
    this.glassCompositeProg.set1f('uWorldPerPixel', worldPerPixel);
    this.glassCompositeProg.set2f('uWorldToUv', worldToUvX, worldToUvY);

    this.drawFullscreenQuad();

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private drawFullscreenQuad(): void {
    const gl = this.gl;
    if (this.isWebGL2 && this.fullscreenVAO) {
      const gl2 = gl as WebGL2RenderingContext;
      gl2.bindVertexArray(this.fullscreenVAO);
      gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
      gl2.bindVertexArray(null);
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    if (this.instancing) {
      this.instancing.vertexAttribDivisor(0, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private drawParticles(particleData: Float32Array, count: number): void {
    const gl = this.gl;

    if (this.instancing) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleInstanceVBO);
      if (count > this.particleCapacity) {
        this.particleCapacity = Math.max(count, this.particleCapacity * 2);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          this.particleCapacity * 8 * Float32Array.BYTES_PER_ELEMENT,
          gl.DYNAMIC_DRAW
        );
      }

      if (this.isWebGL2) {
        (gl as WebGL2RenderingContext).bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          particleData,
          0,
          count * 8
        );
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, particleData.subarray(0, count * 8));
      }

      if (this.isWebGL2 && this.particleVAO) {
        const gl2 = gl as WebGL2RenderingContext;
        gl2.bindVertexArray(this.particleVAO);
        gl2.drawArraysInstanced(gl2.TRIANGLE_STRIP, 0, 4, count);
        gl2.bindVertexArray(null);
        gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
        return;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.instancing.vertexAttribDivisor(0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleInstanceVBO);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
      this.instancing.vertexAttribDivisor(1, 1);

      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
      this.instancing.vertexAttribDivisor(2, 1);

      this.instancing.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

      this.instancing.vertexAttribDivisor(1, 0);
      this.instancing.vertexAttribDivisor(2, 0);
      gl.disableVertexAttribArray(1);
      gl.disableVertexAttribArray(2);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return;
    }

    // Bare WebGL1 fallback without ANGLE_instanced_arrays
    if (!this.fallbackParticleVBO || !this.fallbackIndexIBO || !this.fallbackParticleData) {
      return;
    }
    const safeCount = Math.min(count, this.particleCapacity);
    const out = this.fallbackParticleData;
    for (let i = 0; i < safeCount; i++) {
      const s = i * 8;
      const x = particleData[s + 0];
      const y = particleData[s + 1];
      const vx = particleData[s + 2];
      const vy = particleData[s + 3];
      const ar = particleData[s + 4];
      const ag = particleData[s + 5];
      const ab = particleData[s + 6];
      const fz = particleData[s + 7];

      for (let c = 0; c < 4; c++) {
        const d = (i * 4 + c) * 10;
        out[d + 0] = QUAD_CORNERS[c * 2 + 0];
        out[d + 1] = QUAD_CORNERS[c * 2 + 1];
        out[d + 2] = x;
        out[d + 3] = y;
        out[d + 4] = vx;
        out[d + 5] = vy;
        out[d + 6] = ar;
        out[d + 7] = ag;
        out[d + 8] = ab;
        out[d + 9] = fz;
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fallbackParticleVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out.subarray(0, safeCount * 4 * 10));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 40, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fallbackIndexIBO);
    gl.drawElements(gl.TRIANGLES, safeCount * 6, gl.UNSIGNED_SHORT, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
  }

  private drawBubbles(bubbleData: Float32Array, count: number): void {
    const gl = this.gl;

    if (this.instancing) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleInstanceVBO);
      if (count > this.bubbleCapacity) {
        this.bubbleCapacity = Math.max(count, this.bubbleCapacity * 2);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          this.bubbleCapacity * 4 * Float32Array.BYTES_PER_ELEMENT,
          gl.DYNAMIC_DRAW
        );
      }

      if (this.isWebGL2) {
        (gl as WebGL2RenderingContext).bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          bubbleData,
          0,
          count * 4
        );
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, bubbleData.subarray(0, count * 4));
      }

      if (this.isWebGL2 && this.bubbleVAO) {
        const gl2 = gl as WebGL2RenderingContext;
        gl2.bindVertexArray(this.bubbleVAO);
        gl2.drawArraysInstanced(gl2.TRIANGLE_STRIP, 0, 4, count);
        gl2.bindVertexArray(null);
        gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
        return;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.instancing.vertexAttribDivisor(0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleInstanceVBO);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
      this.instancing.vertexAttribDivisor(1, 1);
      gl.disableVertexAttribArray(2);

      this.instancing.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

      this.instancing.vertexAttribDivisor(1, 0);
      gl.disableVertexAttribArray(1);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return;
    }

    // Bare WebGL1 fallback without ANGLE_instanced_arrays
    if (!this.fallbackBubbleVBO || !this.fallbackIndexIBO || !this.fallbackBubbleData) {
      return;
    }
    const safeCount = Math.min(count, this.bubbleCapacity);
    const out = this.fallbackBubbleData;
    for (let i = 0; i < safeCount; i++) {
      const s = i * 4;
      const bx = bubbleData[s + 0];
      const by = bubbleData[s + 1];
      const br = bubbleData[s + 2];
      const ba = bubbleData[s + 3];

      for (let c = 0; c < 4; c++) {
        const d = (i * 4 + c) * 6;
        out[d + 0] = QUAD_CORNERS[c * 2 + 0];
        out[d + 1] = QUAD_CORNERS[c * 2 + 1];
        out[d + 2] = bx;
        out[d + 3] = by;
        out[d + 4] = br;
        out[d + 5] = ba;
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fallbackBubbleVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out.subarray(0, safeCount * 4 * 6));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.disableVertexAttribArray(2);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fallbackIndexIBO);
    gl.drawElements(gl.TRIANGLES, safeCount * 6, gl.UNSIGNED_SHORT, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.disableVertexAttribArray(1);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const gl = this.gl;
    destroyOffscreenFBO(gl, this.bgFBO);
    destroyOffscreenFBO(gl, this.sceneFBO);
    destroyOffscreenFBO(gl, this.splatFBO_A);
    destroyOffscreenFBO(gl, this.splatFBO_B);
    this.bgFBO = null;
    this.sceneFBO = null;
    this.splatFBO_A = null;
    this.splatFBO_B = null;

    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      if (this.fullscreenVAO) gl2.deleteVertexArray(this.fullscreenVAO);
      if (this.particleVAO) gl2.deleteVertexArray(this.particleVAO);
      if (this.bubbleVAO) gl2.deleteVertexArray(this.bubbleVAO);
      this.fullscreenVAO = null;
      this.particleVAO = null;
      this.bubbleVAO = null;
    }

    gl.deleteBuffer(this.quadVBO);
    gl.deleteBuffer(this.particleInstanceVBO);
    gl.deleteBuffer(this.bubbleInstanceVBO);
    if (this.fallbackParticleVBO) gl.deleteBuffer(this.fallbackParticleVBO);
    if (this.fallbackBubbleVBO) gl.deleteBuffer(this.fallbackBubbleVBO);
    if (this.fallbackIndexIBO) gl.deleteBuffer(this.fallbackIndexIBO);

    this.studioBgProg.dispose();
    this.particleSplatProg.dispose();
    this.blurProg.dispose();
    this.liquidShadeProg.dispose();
    this.bubbleProg.dispose();
    this.glassCompositeProg.dispose();
  }
}
