export interface FluidFBO {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly isFloat: boolean;
  readonly internalFormat: number;
  readonly format: number;
  readonly type: number;
  readonly splatScale: number;
  readonly isoThreshold: number;
}

export interface CreateFluidFBOOptions {
  readonly webglVersion?: 1 | 2;
  readonly forceRGBA8?: boolean;
}

export const FLOAT_SPLAT_SCALE = 1.0;
export const FLOAT_ISO_THRESHOLD = 0.16;
export const RGBA8_SPLAT_SCALE = 0.12;
export const RGBA8_ISO_THRESHOLD = 0.025;

const GL_RGBA16F = 0x881a;
const GL_HALF_FLOAT = 0x140b;
const GL_HALF_FLOAT_OES = 0x8d61;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;

export function detectWebGLVersion(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): 1 | 2 {
  if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
    return 2;
  }
  const maybeGl2 = gl as Partial<WebGL2RenderingContext>;
  if (
    typeof maybeGl2.texStorage2D === 'function' ||
    typeof maybeGl2.RGBA16F === 'number'
  ) {
    return 2;
  }
  return 1;
}

function tryAllocateAttachment(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  useLinearFilter: boolean,
): { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null {
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }

  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    gl.deleteTexture(texture);
    return null;
  }

  // Clear any prior GL error before probing
  if (typeof gl.getError === 'function') {
    gl.getError();
  }

  const filter = useLinearFilter ? gl.LINEAR : gl.NEAREST;

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  try {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      width,
      height,
      0,
      format,
      type,
      null,
    );
  } catch {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }

  if (typeof gl.getError === 'function') {
    const err = gl.getError();
    if (err !== gl.NO_ERROR && err !== 0) {
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return null;
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  if (status !== (gl.FRAMEBUFFER_COMPLETE || GL_FRAMEBUFFER_COMPLETE)) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }

  return { framebuffer, texture };
}

/**
 * Creates an offscreen Framebuffer Object for additive metaball splatting.
 * Attempts `RGBA16F` (`EXT_color_buffer_float` in WebGL2 or half-float in WebGL1) first,
 * and falls back seamlessly to `RGBA8` (`UNSIGNED_BYTE`) with scaled splat weights.
 */
export function createFluidFBO(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  width: number,
  height: number,
  options: CreateFluidFBOOptions = {},
): FluidFBO {
  const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 800));
  const safeHeight = Math.max(1, Math.floor(Number.isFinite(height) ? height : 600));
  const version = options.webglVersion ?? detectWebGLVersion(gl);
  const forceRGBA8 = Boolean(options.forceRGBA8);

  if (!forceRGBA8) {
    if (version === 2) {
      const floatColorExt = gl.getExtension('EXT_color_buffer_float');
      const halfFloatColorExt =
        floatColorExt || gl.getExtension('EXT_color_buffer_half_float');
      if (halfFloatColorExt) {
        const linearExt = Boolean(
          gl.getExtension('OES_texture_float_linear') ||
            gl.getExtension('OES_texture_half_float_linear') ||
            true,
        );
        const internalFormat =
          (gl as WebGL2RenderingContext).RGBA16F ?? GL_RGBA16F;
        const halfFloatType =
          (gl as WebGL2RenderingContext).HALF_FLOAT ?? GL_HALF_FLOAT;

        const allocated = tryAllocateAttachment(
          gl,
          safeWidth,
          safeHeight,
          internalFormat,
          gl.RGBA,
          halfFloatType,
          linearExt,
        );
        if (allocated) {
          return {
            framebuffer: allocated.framebuffer,
            texture: allocated.texture,
            width: safeWidth,
            height: safeHeight,
            isFloat: true,
            internalFormat,
            format: gl.RGBA,
            type: halfFloatType,
            splatScale: FLOAT_SPLAT_SCALE,
            isoThreshold: FLOAT_ISO_THRESHOLD,
          };
        }
      }
    } else {
      // WebGL1 half-float FBO probe
      const halfFloatTexExt = gl.getExtension('OES_texture_half_float') as {
        HALF_FLOAT_OES?: number;
      } | null;
      const halfFloatColorExt = gl.getExtension('EXT_color_buffer_half_float');
      if (halfFloatTexExt && halfFloatColorExt) {
        const linearExt = Boolean(gl.getExtension('OES_texture_half_float_linear'));
        const halfFloatType = halfFloatTexExt.HALF_FLOAT_OES ?? GL_HALF_FLOAT_OES;
        const allocated = tryAllocateAttachment(
          gl,
          safeWidth,
          safeHeight,
          gl.RGBA,
          gl.RGBA,
          halfFloatType,
          linearExt,
        );
        if (allocated) {
          return {
            framebuffer: allocated.framebuffer,
            texture: allocated.texture,
            width: safeWidth,
            height: safeHeight,
            isFloat: true,
            internalFormat: gl.RGBA,
            format: gl.RGBA,
            type: halfFloatType,
            splatScale: FLOAT_SPLAT_SCALE,
            isoThreshold: FLOAT_ISO_THRESHOLD,
          };
        }
      }
    }
  }

  // Fallback to universal RGBA8 (UNSIGNED_BYTE) FBO
  const rgba8Allocated = tryAllocateAttachment(
    gl,
    safeWidth,
    safeHeight,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    true,
  );

  if (!rgba8Allocated) {
    throw new Error(
      `Failed to allocate offscreen FluidFBO (${safeWidth}x${safeHeight}) in both RGBA16F and RGBA8 modes`,
    );
  }

  return {
    framebuffer: rgba8Allocated.framebuffer,
    texture: rgba8Allocated.texture,
    width: safeWidth,
    height: safeHeight,
    isFloat: false,
    internalFormat: gl.RGBA,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    splatScale: RGBA8_SPLAT_SCALE,
    isoThreshold: RGBA8_ISO_THRESHOLD,
  };
}

export function resizeFluidFBO(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  currentFbo: FluidFBO | null,
  width: number,
  height: number,
  options: CreateFluidFBOOptions = {},
): FluidFBO {
  const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 800));
  const safeHeight = Math.max(1, Math.floor(Number.isFinite(height) ? height : 600));

  if (
    currentFbo &&
    currentFbo.width === safeWidth &&
    currentFbo.height === safeHeight
  ) {
    return currentFbo;
  }

  if (currentFbo) {
    destroyFluidFBO(gl, currentFbo);
  }

  return createFluidFBO(gl, safeWidth, safeHeight, options);
}

export function destroyFluidFBO(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  fbo: FluidFBO | null | undefined,
): void {
  if (!fbo) return;
  gl.deleteFramebuffer(fbo.framebuffer);
  gl.deleteTexture(fbo.texture);
}

export class FluidFBOManager {
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly options: CreateFluidFBOOptions;
  private fbo: FluidFBO;

  constructor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    width: number,
    height: number,
    options: CreateFluidFBOOptions = {},
  ) {
    this.gl = gl;
    this.options = options;
    this.fbo = createFluidFBO(gl, width, height, options);
  }

  public get current(): FluidFBO {
    return this.fbo;
  }

  public get width(): number {
    return this.fbo.width;
  }

  public get height(): number {
    return this.fbo.height;
  }

  public get isFloat(): boolean {
    return this.fbo.isFloat;
  }

  public get splatScale(): number {
    return this.fbo.splatScale;
  }

  public get isoThreshold(): number {
    return this.fbo.isoThreshold;
  }

  public bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo.framebuffer);
    this.gl.viewport(0, 0, this.fbo.width, this.fbo.height);
  }

  public unbind(viewportWidth?: number, viewportHeight?: number): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    if (viewportWidth !== undefined && viewportHeight !== undefined) {
      this.gl.viewport(0, 0, viewportWidth, viewportHeight);
    }
  }

  public resize(width: number, height: number): FluidFBO {
    this.fbo = resizeFluidFBO(this.gl, this.fbo, width, height, this.options);
    return this.fbo;
  }

  public dispose(): void {
    destroyFluidFBO(this.gl, this.fbo);
  }
}
