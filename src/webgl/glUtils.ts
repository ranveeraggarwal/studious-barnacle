export type GLContext = WebGL2RenderingContext | WebGLRenderingContext;

export interface OffscreenFBO {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  isFloat: boolean;
}

export interface SplatFormatInfo {
  useFloat16: boolean;
  writeScale: number;
  readScale: number;
}

export interface InstancingAdapter {
  drawArraysInstanced: (mode: number, first: number, count: number, primcount: number) => void;
  vertexAttribDivisor: (index: number, divisor: number) => void;
}

/**
 * Resolves hardware instancing for WebGL2 core or WebGL1 ANGLE_instanced_arrays.
 * Returns null only on minimal WebGL1 implementations without ANGLE_instanced_arrays.
 */
export function getInstancingAdapter(
  gl: GLContext,
  isWebGL2: boolean
): InstancingAdapter | null {
  if (isWebGL2) {
    const gl2 = gl as WebGL2RenderingContext;
    return {
      drawArraysInstanced: (mode, first, count, primcount) =>
        gl2.drawArraysInstanced(mode, first, count, primcount),
      vertexAttribDivisor: (index, divisor) => gl2.vertexAttribDivisor(index, divisor),
    };
  }

  const ext = gl.getExtension('ANGLE_instanced_arrays');
  if (!ext) {
    return null;
  }
  return {
    drawArraysInstanced: (mode, first, count, primcount) =>
      ext.drawArraysInstancedANGLE(mode, first, count, primcount),
    vertexAttribDivisor: (index, divisor) => ext.vertexAttribDivisorANGLE(index, divisor),
  };
}

/**
 * Probes whether RGBA16F color-renderable + blendable + linear-filterable FBOs
 * are genuinely supported on the active GPU / software rasterizer (SwiftShader).
 *
 * Per requirements: ONLY uses RGBA16F with LINEAR filtering in WebGL2 when BOTH
 * EXT_color_buffer_float AND OES_texture_float_linear succeed AND a test FBO
 * reports FRAMEBUFFER_COMPLETE. Otherwise cleanly falls back to RGBA8 with
 * 1/8.0 write scale and 8.0 read scale.
 */
export function detectSplatFormat(gl: GLContext, isWebGL2: boolean): SplatFormatInfo {
  if (isWebGL2) {
    const gl2 = gl as WebGL2RenderingContext;
    const extColorFloat = gl2.getExtension('EXT_color_buffer_float');
    const extFloatLinear = gl2.getExtension('OES_texture_float_linear');

    if (extColorFloat && extFloatLinear) {
      // Drain any prior GL error flag before probing
      while (gl2.getError() !== gl2.NO_ERROR) {
        // no-op
      }

      const tex = gl2.createTexture();
      const fbo = gl2.createFramebuffer();
      let ok = false;

      if (tex && fbo) {
        gl2.bindTexture(gl2.TEXTURE_2D, tex);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
        gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA16F, 4, 4, 0, gl2.RGBA, gl2.HALF_FLOAT, null);

        gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo);
        gl2.framebufferTexture2D(
          gl2.FRAMEBUFFER,
          gl2.COLOR_ATTACHMENT0,
          gl2.TEXTURE_2D,
          tex,
          0
        );

        const status = gl2.checkFramebufferStatus(gl2.FRAMEBUFFER);
        const err = gl2.getError();
        ok = status === gl2.FRAMEBUFFER_COMPLETE && err === gl2.NO_ERROR;
      }

      gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
      gl2.bindTexture(gl2.TEXTURE_2D, null);
      if (fbo) gl2.deleteFramebuffer(fbo);
      if (tex) gl2.deleteTexture(tex);

      if (ok) {
        return {
          useFloat16: true,
          writeScale: 1.0,
          readScale: 1.0,
        };
      }
    }
  }

  return {
    useFloat16: false,
    writeScale: 1.0 / 8.0,
    readScale: 8.0,
  };
}

/**
 * Creates a linear-filtered, edge-clamped offscreen framebuffer (either RGBA16F or RGBA8).
 * Automatically falls back to RGBA8 if RGBA16F creation fails at target dimensions.
 */
export function createOffscreenFBO(
  gl: GLContext,
  isWebGL2: boolean,
  width: number,
  height: number,
  wantFloat16: boolean
): OffscreenFBO {
  const safeW = Math.max(1, Math.floor(width));
  const safeH = Math.max(1, Math.floor(height));

  if (wantFloat16 && isWebGL2) {
    const gl2 = gl as WebGL2RenderingContext;
    const tex = gl2.createTexture();
    const fbo = gl2.createFramebuffer();
    if (!tex || !fbo) {
      if (tex) gl2.deleteTexture(tex);
      if (fbo) gl2.deleteFramebuffer(fbo);
      throw new Error('Failed to allocate WebGL2 offscreen FBO resources.');
    }

    gl2.bindTexture(gl2.TEXTURE_2D, tex);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    gl2.texImage2D(
      gl2.TEXTURE_2D,
      0,
      gl2.RGBA16F,
      safeW,
      safeH,
      0,
      gl2.RGBA,
      gl2.HALF_FLOAT,
      null
    );

    gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo);
    gl2.framebufferTexture2D(
      gl2.FRAMEBUFFER,
      gl2.COLOR_ATTACHMENT0,
      gl2.TEXTURE_2D,
      tex,
      0
    );

    const complete = gl2.checkFramebufferStatus(gl2.FRAMEBUFFER) === gl2.FRAMEBUFFER_COMPLETE;
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
    gl2.bindTexture(gl2.TEXTURE_2D, null);

    if (complete) {
      return { fbo, texture: tex, width: safeW, height: safeH, isFloat: true };
    }

    gl2.deleteFramebuffer(fbo);
    gl2.deleteTexture(tex);
  }

  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) {
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
    throw new Error('Failed to allocate RGBA8 offscreen FBO resources.');
  }

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    safeW,
    safeH,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    throw new Error(`Offscreen RGBA8 framebuffer incomplete (status=0x${status.toString(16)}).`);
  }

  return { fbo, texture: tex, width: safeW, height: safeH, isFloat: false };
}

export function destroyOffscreenFBO(gl: GLContext, target: OffscreenFBO | null): void {
  if (!target) return;
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(target.texture);
}

function compileShader(gl: GLContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error(`Unable to create shader (${label}).`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'Unknown GLSL compile error';
    gl.deleteShader(shader);
    throw new Error(`GLSL compile error in ${label}:\n${info}`);
  }
  return shader;
}

export class ShaderProgram {
  public readonly program: WebGLProgram;
  private readonly gl: GLContext;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly attribs = new Map<string, number>();

  constructor(
    gl: GLContext,
    vertSource: string,
    fragSource: string,
    label: string,
    attribBindings?: Readonly<Record<string, number>>
  ) {
    this.gl = gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSource, `${label}:vert`);
    let fs: WebGLShader;
    try {
      fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource, `${label}:frag`);
    } catch (err) {
      gl.deleteShader(vs);
      throw err;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`Unable to create WebGLProgram (${label}).`);
    }

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);

    if (attribBindings) {
      for (const name of Object.keys(attribBindings)) {
        gl.bindAttribLocation(program, attribBindings[name], name);
      }
    }

    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) ?? 'Unknown program link error';
      gl.deleteProgram(program);
      throw new Error(`GLSL link error in ${label}:\n${info}`);
    }

    this.program = program;
  }

  public use(): void {
    this.gl.useProgram(this.program);
  }

  public attrib(name: string): number {
    let loc = this.attribs.get(name);
    if (loc === undefined) {
      loc = this.gl.getAttribLocation(this.program, name);
      this.attribs.set(name, loc);
    }
    return loc;
  }

  public uniform(name: string): WebGLUniformLocation | null {
    if (this.uniforms.has(name)) {
      return this.uniforms.get(name) ?? null;
    }
    const loc =
      this.gl.getUniformLocation(this.program, name) ??
      this.gl.getUniformLocation(this.program, `${name}[0]`);
    this.uniforms.set(name, loc);
    return loc;
  }

  public set1i(name: string, v: number): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform1i(loc, v);
  }

  public set1f(name: string, v: number): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform1f(loc, v);
  }

  public set2f(name: string, x: number, y: number): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform2f(loc, x, y);
  }

  public set3f(name: string, x: number, y: number, z: number): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform3f(loc, x, y, z);
  }

  public set4f(name: string, x: number, y: number, z: number, w: number): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform4f(loc, x, y, z, w);
  }

  public set1fv(name: string, data: Float32List): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform1fv(loc, data);
  }

  public set3fv(name: string, data: Float32List): void {
    const loc = this.uniform(name);
    if (loc !== null) this.gl.uniform3fv(loc, data);
  }

  public dispose(): void {
    this.gl.deleteProgram(this.program);
    this.uniforms.clear();
    this.attribs.clear();
  }
}

export function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) / 255;
    const g = parseInt(clean[1] + clean[1], 16) / 255;
    const b = parseInt(clean[2] + clean[2], 16) / 255;
    return [r, g, b];
  }
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return [1, 1, 1];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}
