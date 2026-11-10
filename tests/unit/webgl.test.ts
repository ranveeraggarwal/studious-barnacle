import { describe, expect, it } from 'vitest';
import {
  DRINK_BY_ID,
  DRINK_IDS,
  blendDrinksByVolume,
} from '../../src/catalog/drinks';
import { FluidWorld } from '../../src/physics/fluidWorld';
import {
  SHADER_PASS_NAMES,
  compileShader,
  createAllShaderPrograms,
  createShaderProgram,
  destroyShaderPrograms,
  getShaderSource,
  getShaderSources,
} from '../../src/webgl/shaders';
import {
  FLOAT_ISO_THRESHOLD,
  FLOAT_SPLAT_SCALE,
  FluidFBOManager,
  RGBA8_ISO_THRESHOLD,
  RGBA8_SPLAT_SCALE,
  createFluidFBO,
  destroyFluidFBO,
  detectWebGLVersion,
  resizeFluidFBO,
} from '../../src/webgl/fbo';
import {
  BUBBLE_FOAM_FLOATS,
  DISPENSER_HEADER_RGB255,
  FLUID_SPLAT_FLOATS,
  GLASS_VERTEX_FLOATS,
  SCENE_VERTEX_FLOATS,
  STUDIO_BG_RGB255,
  buildBubbleFoamBuffer,
  buildFluidSplatBuffer,
  buildFullScreenQuad,
  buildGlassContainerMesh,
  buildHydrostaticLiquidMesh,
  buildSceneStaticMesh,
  computeGlassHalfWidthAtY,
  computePoolTopY,
  ndcToWorld,
  worldToNDC,
} from '../../src/webgl/meshes';
import {
  SodaFountainRenderer,
  WEBGL_CONTEXT_ATTRIBUTES,
  evaluateScenePixelAtWorld,
} from '../../src/webgl/renderer';

interface MockShaderRecord {
  id: number;
  type: number;
  source: string;
  compiled: boolean;
  deleted: boolean;
}

interface MockProgramRecord {
  id: number;
  shaders: MockShaderRecord[];
  attribBindings: Map<string, number>;
  uniformValues: Map<string, number | number[]>;
  linked: boolean;
  deleted: boolean;
}

interface MockTextureRecord {
  id: number;
  width: number;
  height: number;
  internalFormat: number;
  format: number;
  type: number;
  deleted: boolean;
  floatData: Float32Array;
}

interface MockFBORecord {
  id: number;
  colorAttachment: MockTextureRecord | null;
  deleted: boolean;
}

interface AttribPointerState {
  buffer: Float32Array | null;
  size: number;
  strideFloats: number;
  offsetFloats: number;
  enabled: boolean;
}

interface MockGLOptions {
  version?: 1 | 2;
  width?: number;
  height?: number;
  supportFloatFBO?: boolean;
  failCompilePass?: string;
  failLinkPass?: string;
  enableSoftwareRaster?: boolean;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Stateful, software-rasterizing WebGL2 / WebGL1 test harness that executes vertex/fragment passes
 * into a backing color buffer and offscreen FBO so `gl.readPixels` genuinely reflects all 5 passes.
 */
function createMockWebGLContext(options: MockGLOptions = {}) {
  const version = options.version ?? 2;
  const supportFloatFBO = options.supportFloatFBO ?? true;
  const enableRaster = options.enableSoftwareRaster ?? true;

  let fbWidth = options.width ?? 400;
  let fbHeight = options.height ?? 300;
  let defaultPixels = new Uint8Array(fbWidth * fbHeight * 4);

  let nextId = 1;
  const shaders = new Map<object, MockShaderRecord>();
  const programs = new Map<object, MockProgramRecord>();
  const buffers = new Map<object, { id: number; data: Float32Array | null; deleted: boolean }>();
  const textures = new Map<object, MockTextureRecord>();
  const fbos = new Map<object, MockFBORecord>();

  let currentProgram: MockProgramRecord | null = null;
  let boundArrayBuffer: { id: number; data: Float32Array | null; deleted: boolean } | null = null;
  let boundTexture: MockTextureRecord | null = null;
  let boundFBO: MockFBORecord | null = null;

  let clearColor: [number, number, number, number] = [0, 0, 0, 1];
  let blendSrc = 0x0302; // SRC_ALPHA
  let blendDst = 0x0303; // ONE_MINUS_SRC_ALPHA

  const attribPointers = new Map<number, AttribPointerState>();
  const uniformLocations = new Map<
    object,
    { program: MockProgramRecord; name: string }
  >();

  function ensureDefaultSize(w: number, h: number) {
    if (w !== fbWidth || h !== fbHeight) {
      fbWidth = Math.max(1, w);
      fbHeight = Math.max(1, h);
      defaultPixels = new Uint8Array(fbWidth * fbHeight * 4);
    }
  }

  function blendPixelDefault(
    px: number,
    py: number,
    r01: number,
    g01: number,
    b01: number,
    a01: number,
  ) {
    if (px < 0 || px >= fbWidth || py < 0 || py >= fbHeight) return;
    const idx = (py * fbWidth + px) * 4;
    const a = Math.max(0, Math.min(1, a01));
    const sr = Math.max(0, Math.min(255, r01 * 255));
    const sg = Math.max(0, Math.min(255, g01 * 255));
    const sb = Math.max(0, Math.min(255, b01 * 255));

    const dr = defaultPixels[idx];
    const dg = defaultPixels[idx + 1];
    const db = defaultPixels[idx + 2];

    defaultPixels[idx] = Math.round(sr * a + dr * (1 - a));
    defaultPixels[idx + 1] = Math.round(sg * a + dg * (1 - a));
    defaultPixels[idx + 2] = Math.round(sb * a + db * (1 - a));
    defaultPixels[idx + 3] = 255;
  }

  function rasterizeTriangleWorld(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ) {
    const px0 = (x0 / 800) * fbWidth;
    const py0 = (y0 / 600) * fbHeight;
    const px1 = (x1 / 800) * fbWidth;
    const py1 = (y1 / 600) * fbHeight;
    const px2 = (x2 / 800) * fbWidth;
    const py2 = (y2 / 600) * fbHeight;

    const minX = Math.max(0, Math.floor(Math.min(px0, px1, px2)));
    const maxX = Math.min(fbWidth - 1, Math.ceil(Math.max(px0, px1, px2)));
    const minY = Math.max(0, Math.floor(Math.min(py0, py1, py2)));
    const maxY = Math.min(fbHeight - 1, Math.ceil(Math.max(py0, py1, py2)));

    const denom = (py1 - py2) * (px0 - px2) + (px2 - px1) * (py0 - py2);
    if (Math.abs(denom) < 1e-5) return;
    const invDenom = 1.0 / denom;

    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = ((py1 - py2) * (cx - px2) + (px2 - px1) * (cy - py2)) * invDenom;
        const w1 = ((py2 - py0) * (cx - px2) + (px0 - px2) * (cy - py2)) * invDenom;
        const w2 = 1.0 - w0 - w1;
        if (w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4) {
          blendPixelDefault(px, py, r, g, b, a);
        }
      }
    }
  }

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    POINTS: 0x0000,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
    RGBA: 0x1908,
    RGBA16F: version === 2 ? 0x881a : undefined,
    HALF_FLOAT: version === 2 ? 0x140b : undefined,
    UNSIGNED_BYTE: 0x1401,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    ZERO: 0,
    ONE: 1,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    NO_ERROR: 0,

    get drawingBufferWidth() {
      return fbWidth;
    },
    get drawingBufferHeight() {
      return fbHeight;
    },

    getContextAttributes: () => ({ ...WEBGL_CONTEXT_ATTRIBUTES }),
    isContextLost: () => false,
    getError: () => 0,

    getExtension: (name: string) => {
      if (!supportFloatFBO) return null;
      if (version === 2) {
        if (
          name === 'EXT_color_buffer_float' ||
          name === 'OES_texture_float_linear'
        ) {
          return {};
        }
      } else {
        if (name === 'OES_texture_half_float') {
          return { HALF_FLOAT_OES: 0x8d61 };
        }
        if (
          name === 'EXT_color_buffer_half_float' ||
          name === 'OES_texture_half_float_linear'
        ) {
          return {};
        }
      }
      return null;
    },

    createShader: (type: number) => {
      const token = {};
      shaders.set(token, {
        id: nextId++,
        type,
        source: '',
        compiled: false,
        deleted: false,
      });
      return token as unknown as WebGLShader;
    },

    shaderSource: (shader: WebGLShader, source: string) => {
      const rec = shaders.get(shader as object);
      if (rec) rec.source = source;
    },

    compileShader: (shader: WebGLShader) => {
      const rec = shaders.get(shader as object);
      if (!rec) return;
      if (
        options.failCompilePass &&
        rec.source.includes(options.failCompilePass)
      ) {
        rec.compiled = false;
        return;
      }
      rec.compiled = rec.source.includes('void main()');
    },

    getShaderParameter: (shader: WebGLShader, pname: number) => {
      const rec = shaders.get(shader as object);
      if (!rec) return false;
      if (pname === 0x8b81) return rec.compiled;
      return true;
    },

    getShaderInfoLog: (shader: WebGLShader) => {
      const rec = shaders.get(shader as object);
      return rec && !rec.compiled ? 'Simulated shader compile error' : '';
    },

    deleteShader: (shader: WebGLShader) => {
      const rec = shaders.get(shader as object);
      if (rec) rec.deleted = true;
    },

    createProgram: () => {
      const token = {};
      programs.set(token, {
        id: nextId++,
        shaders: [],
        attribBindings: new Map(),
        uniformValues: new Map(),
        linked: false,
        deleted: false,
      });
      return token as unknown as WebGLProgram;
    },

    attachShader: (program: WebGLProgram, shader: WebGLShader) => {
      const p = programs.get(program as object);
      const s = shaders.get(shader as object);
      if (p && s) p.shaders.push(s);
    },

    bindAttribLocation: (
      program: WebGLProgram,
      index: number,
      name: string,
    ) => {
      const p = programs.get(program as object);
      if (p) p.attribBindings.set(name, index);
    },

    linkProgram: (program: WebGLProgram) => {
      const p = programs.get(program as object);
      if (!p) return;
      if (
        options.failLinkPass &&
        p.shaders.some((s) => s.source.includes(options.failLinkPass!))
      ) {
        p.linked = false;
        return;
      }
      p.linked =
        p.shaders.length === 2 && p.shaders.every((s) => s.compiled);
    },

    getProgramParameter: (program: WebGLProgram, pname: number) => {
      const p = programs.get(program as object);
      if (!p) return false;
      if (pname === 0x8b82) return p.linked;
      return true;
    },

    getProgramInfoLog: (program: WebGLProgram) => {
      const p = programs.get(program as object);
      return p && !p.linked ? 'Simulated program link error' : '';
    },

    useProgram: (program: WebGLProgram | null) => {
      currentProgram = program ? programs.get(program as object) ?? null : null;
    },

    deleteProgram: (program: WebGLProgram) => {
      const p = programs.get(program as object);
      if (p) p.deleted = true;
    },

    getAttribLocation: (program: WebGLProgram, name: string) => {
      const p = programs.get(program as object);
      if (!p) return -1;
      return p.attribBindings.get(name) ?? 0;
    },

    getUniformLocation: (program: WebGLProgram, name: string) => {
      const p = programs.get(program as object);
      if (!p) return null;
      const locToken = {};
      uniformLocations.set(locToken, { program: p, name });
      return locToken as unknown as WebGLUniformLocation;
    },

    uniform1i: (loc: WebGLUniformLocation | null, v: number) => {
      const info = loc ? uniformLocations.get(loc as object) : null;
      if (info) info.program.uniformValues.set(info.name, v);
    },

    uniform1f: (loc: WebGLUniformLocation | null, v: number) => {
      const info = loc ? uniformLocations.get(loc as object) : null;
      if (info) info.program.uniformValues.set(info.name, v);
    },

    uniform2f: (loc: WebGLUniformLocation | null, x: number, y: number) => {
      const info = loc ? uniformLocations.get(loc as object) : null;
      if (info) info.program.uniformValues.set(info.name, [x, y]);
    },

    uniform3f: (
      loc: WebGLUniformLocation | null,
      x: number,
      y: number,
      z: number,
    ) => {
      const info = loc ? uniformLocations.get(loc as object) : null;
      if (info) info.program.uniformValues.set(info.name, [x, y, z]);
    },

    createBuffer: () => {
      const token = {};
      buffers.set(token, { id: nextId++, data: null, deleted: false });
      return token as unknown as WebGLBuffer;
    },

    bindBuffer: (_target: number, buffer: WebGLBuffer | null) => {
      boundArrayBuffer = buffer ? buffers.get(buffer as object) ?? null : null;
    },

    bufferData: (_target: number, data: BufferSource, _usage: number) => {
      if (boundArrayBuffer && data instanceof Float32Array) {
        boundArrayBuffer.data = new Float32Array(data);
      }
    },

    deleteBuffer: (buffer: WebGLBuffer) => {
      const b = buffers.get(buffer as object);
      if (b) b.deleted = true;
    },

    enableVertexAttribArray: (index: number) => {
      const cur = attribPointers.get(index) ?? {
        buffer: null,
        size: 2,
        strideFloats: 2,
        offsetFloats: 0,
        enabled: true,
      };
      cur.enabled = true;
      attribPointers.set(index, cur);
    },

    disableVertexAttribArray: (index: number) => {
      const cur = attribPointers.get(index);
      if (cur) cur.enabled = false;
    },

    vertexAttribPointer: (
      index: number,
      size: number,
      _type: number,
      _normalized: boolean,
      strideBytes: number,
      offsetBytes: number,
    ) => {
      attribPointers.set(index, {
        buffer: boundArrayBuffer?.data ?? null,
        size,
        strideFloats: strideBytes > 0 ? strideBytes / 4 : size,
        offsetFloats: offsetBytes / 4,
        enabled: true,
      });
    },

    createTexture: () => {
      const token = {};
      textures.set(token, {
        id: nextId++,
        width: 1,
        height: 1,
        internalFormat: 0x1908,
        format: 0x1908,
        type: 0x1401,
        deleted: false,
        floatData: new Float32Array(4),
      });
      return token as unknown as WebGLTexture;
    },

    bindTexture: (_target: number, texture: WebGLTexture | null) => {
      boundTexture = texture ? textures.get(texture as object) ?? null : null;
    },

    activeTexture: (_unit: number) => {},
    texParameteri: (_target: number, _pname: number, _param: number) => {},

    texImage2D: (
      _target: number,
      _level: number,
      internalFormat: number,
      width: number,
      height: number,
      _border: number,
      format: number,
      type: number,
      _pixels: ArrayBufferView | null,
    ) => {
      if (!boundTexture) return;
      boundTexture.width = Math.max(1, width);
      boundTexture.height = Math.max(1, height);
      boundTexture.internalFormat = internalFormat;
      boundTexture.format = format;
      boundTexture.type = type;
      boundTexture.floatData = new Float32Array(
        boundTexture.width * boundTexture.height * 4,
      );
    },

    deleteTexture: (texture: WebGLTexture) => {
      const t = textures.get(texture as object);
      if (t) t.deleted = true;
    },

    createFramebuffer: () => {
      const token = {};
      fbos.set(token, {
        id: nextId++,
        colorAttachment: null,
        deleted: false,
      });
      return token as unknown as WebGLFramebuffer;
    },

    bindFramebuffer: (_target: number, fbo: WebGLFramebuffer | null) => {
      boundFBO = fbo ? fbos.get(fbo as object) ?? null : null;
    },

    framebufferTexture2D: (
      _target: number,
      _attachment: number,
      _texTarget: number,
      texture: WebGLTexture | null,
      _level: number,
    ) => {
      if (boundFBO) {
        boundFBO.colorAttachment = texture
          ? textures.get(texture as object) ?? null
          : null;
      }
    },

    checkFramebufferStatus: (_target: number) => {
      if (!boundFBO || !boundFBO.colorAttachment) {
        return 0x8cd6;
      }
      if (
        !supportFloatFBO &&
        boundFBO.colorAttachment.type !== 0x1401 // UNSIGNED_BYTE
      ) {
        return 0x8cd6;
      }
      return 0x8cd5; // FRAMEBUFFER_COMPLETE
    },

    deleteFramebuffer: (fbo: WebGLFramebuffer) => {
      const f = fbos.get(fbo as object);
      if (f) f.deleted = true;
    },

    viewport: (_x: number, _y: number, w: number, h: number) => {
      if (!boundFBO) {
        ensureDefaultSize(w, h);
      }
    },

    disable: (_cap: number) => {},
    enable: (_cap: number) => {},

    blendFunc: (sfactor: number, dfactor: number) => {
      blendSrc = sfactor;
      blendDst = dfactor;
    },

    blendFuncSeparate: (
      srcRGB: number,
      dstRGB: number,
      _srcAlpha: number,
      _dstAlpha: number,
    ) => {
      blendSrc = srcRGB;
      blendDst = dstRGB;
    },

    clearColor: (r: number, g: number, b: number, a: number) => {
      clearColor = [r, g, b, a];
    },

    clear: (_mask: number) => {
      if (!enableRaster) return;
      if (boundFBO && boundFBO.colorAttachment) {
        const data = boundFBO.colorAttachment.floatData;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = clearColor[0];
          data[i + 1] = clearColor[1];
          data[i + 2] = clearColor[2];
          data[i + 3] = clearColor[3];
        }
      } else {
        const r = Math.round(clearColor[0] * 255);
        const g = Math.round(clearColor[1] * 255);
        const b = Math.round(clearColor[2] * 255);
        const a = Math.round(clearColor[3] * 255);
        for (let i = 0; i < defaultPixels.length; i += 4) {
          defaultPixels[i] = r;
          defaultPixels[i + 1] = g;
          defaultPixels[i + 2] = b;
          defaultPixels[i + 3] = a;
        }
      }
    },

    drawArrays: (mode: number, first: number, count: number) => {
      if (!enableRaster || !currentProgram || count <= 0) return;
      const posAttr = attribPointers.get(0);
      if (!posAttr || !posAttr.buffer) return;
      const buf = posAttr.buffer;

      // 1. Offscreen Pass 2: fluidSplat (POINTS into boundFBO)
      if (boundFBO && boundFBO.colorAttachment && mode === 0x0000) {
        const tex = boundFBO.colorAttachment;
        const fboData = tex.floatData;
        const w = tex.width;
        const h = tex.height;
        const splatScale =
          (currentProgram.uniformValues.get('u_splatScale') as number) ?? 1.0;

        for (let i = 0; i < count; i++) {
          const base = (first + i) * FLUID_SPLAT_FLOATS;
          const wx = buf[base];
          const wy = buf[base + 1];
          const r = buf[base + 2];
          const g = buf[base + 3];
          const b = buf[base + 4];
          const a = buf[base + 5];
          const radius = buf[base + 6];

          const cx = (wx / 800) * w;
          const cy = (wy / 600) * h;
          const radPx = Math.max(2.0, radius * (h / 600));
          const minX = Math.max(0, Math.floor(cx - radPx));
          const maxX = Math.min(w - 1, Math.ceil(cx + radPx));
          const minY = Math.max(0, Math.floor(cy - radPx));
          const maxY = Math.min(h - 1, Math.ceil(cy + radPx));

          for (let py = minY; py <= maxY; py++) {
            const dy = (py + 0.5 - cy) / radPx;
            for (let px = minX; px <= maxX; px++) {
              const dx = (px + 0.5 - cx) / radPx;
              const r2 = dx * dx + dy * dy;
              if (r2 > 1.0) continue;
              const t = 1.0 - r2;
              const weight = t * t * t * a * splatScale;
              const idx = (py * w + px) * 4;
              fboData[idx] += r * weight;
              fboData[idx + 1] += g * weight;
              fboData[idx + 2] += b * weight;
              fboData[idx + 3] += weight;
            }
          }
        }
        return;
      }

      // 2. Pass 3: fluidResolve (full-screen quad sampling boundTexture)
      if (
        !boundFBO &&
        mode === 0x0004 &&
        count === 6 &&
        posAttr.strideFloats === 2 &&
        boundTexture
      ) {
        const fboData = boundTexture.floatData;
        const isoThreshold =
          (currentProgram.uniformValues.get('u_isoThreshold') as number) ??
          0.16;
        const splatScale = Math.max(
          1e-4,
          (currentProgram.uniformValues.get('u_splatScale') as number) ?? 1.0,
        );

        for (let py = 0; py < fbHeight; py++) {
          for (let px = 0; px < fbWidth; px++) {
            const idx = (py * fbWidth + px) * 4;
            const accumA = fboData[idx + 3];
            const density = accumA / splatScale;
            if (density < isoThreshold * 0.5) continue;

            const invA = 1.0 / Math.max(accumA, 1e-5);
            const baseR = Math.max(0, Math.min(1, fboData[idx] * invA));
            const baseG = Math.max(0, Math.min(1, fboData[idx + 1] * invA));
            const baseB = Math.max(0, Math.min(1, fboData[idx + 2] * invA));
            const alpha = smoothstep(
              isoThreshold * 0.65,
              isoThreshold * 1.25,
              density,
            );
            blendPixelDefault(px, py, baseR, baseG, baseB, alpha);
          }
        }
        return;
      }

      // 3. Pass 1 (sceneMesh, stride 6) or Pass 5 (glassContainer, stride 7) TRIANGLES
      if (!boundFBO && mode === 0x0004) {
        const stride = posAttr.strideFloats;
        const isGlass = stride === GLASS_VERTEX_FLOATS;
        for (let i = 0; i + 2 < count; i += 3) {
          const i0 = (first + i) * stride;
          const i1 = (first + i + 1) * stride;
          const i2 = (first + i + 2) * stride;

          let r = (buf[i0 + 2] + buf[i1 + 2] + buf[i2 + 2]) / 3;
          let g = (buf[i0 + 3] + buf[i1 + 3] + buf[i2 + 3]) / 3;
          let b = (buf[i0 + 4] + buf[i1 + 4] + buf[i2 + 4]) / 3;
          const a = (buf[i0 + 5] + buf[i1 + 5] + buf[i2 + 5]) / 3;

          if (isGlass) {
            const edge = (buf[i0 + 6] + buf[i1 + 6] + buf[i2 + 6]) / 3;
            const fresnel = Math.pow(Math.max(0, Math.min(1, edge)), 1.6) * 0.18;
            r = Math.min(1, r + fresnel);
            g = Math.min(1, g + fresnel);
            b = Math.min(1, b + fresnel);
          }

          rasterizeTriangleWorld(
            buf[i0],
            buf[i0 + 1],
            buf[i1],
            buf[i1 + 1],
            buf[i2],
            buf[i2 + 1],
            r,
            g,
            b,
            a,
          );
        }
        return;
      }

      // 4. Pass 4: bubbleFoam (POINTS on default framebuffer)
      if (!boundFBO && mode === 0x0000 && posAttr.strideFloats === BUBBLE_FOAM_FLOATS) {
        const foamColor = (currentProgram.uniformValues.get('u_foamColor') as number[]) ?? [
          0.95, 0.98, 1.0,
        ];
        for (let i = 0; i < count; i++) {
          const base = (first + i) * BUBBLE_FOAM_FLOATS;
          const wx = buf[base];
          const wy = buf[base + 1];
          const radius = buf[base + 2];
          const alpha = buf[base + 3];
          const isFoam = buf[base + 4] > 0.5;

          const cx = Math.round((wx / 800) * fbWidth);
          const cy = Math.round((wy / 600) * fbHeight);
          const outAlpha = isFoam ? alpha * 0.42 : alpha * 0.14;
          blendPixelDefault(
            cx,
            cy,
            foamColor[0],
            foamColor[1],
            foamColor[2],
            outAlpha,
          );
        }
      }
    },

    readPixels: (
      x: number,
      y: number,
      width: number,
      height: number,
      _format: number,
      _type: number,
      pixels: ArrayBufferView,
    ) => {
      if (!enableRaster || !(pixels instanceof Uint8Array)) return;
      let dst = 0;
      for (let row = 0; row < height; row++) {
        const py = Math.max(0, Math.min(fbHeight - 1, y + row));
        for (let col = 0; col < width; col++) {
          const px = Math.max(0, Math.min(fbWidth - 1, x + col));
          const src = (py * fbWidth + px) * 4;
          pixels[dst] = defaultPixels[src];
          pixels[dst + 1] = defaultPixels[src + 1];
          pixels[dst + 2] = defaultPixels[src + 2];
          pixels[dst + 3] = defaultPixels[src + 3];
          dst += 4;
        }
      }
    },

    // Inspection helpers for unit assertions
    __stats: {
      shaders,
      programs,
      buffers,
      textures,
      fbos,
      get blendSrc() {
        return blendSrc;
      },
      get blendDst() {
        return blendDst;
      },
    },
  };

  return gl as unknown as WebGL2RenderingContext & {
    __stats: {
      shaders: Map<object, MockShaderRecord>;
      programs: Map<object, MockProgramRecord>;
      buffers: Map<
        object,
        { id: number; data: Float32Array | null; deleted: boolean }
      >;
      textures: Map<object, MockTextureRecord>;
      fbos: Map<object, MockFBORecord>;
      readonly blendSrc: number;
      readonly blendDst: number;
    };
  };
}

function createMockCanvas(options: MockGLOptions = {}): {
  canvas: HTMLCanvasElement;
  gl: ReturnType<typeof createMockWebGLContext>;
  attributes: Map<string, string>;
} {
  const gl = createMockWebGLContext(options);
  const attributes = new Map<string, string>();
  const width = options.width ?? 400;
  const height = options.height ?? 300;

  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    setAttribute: (name: string, val: string) => {
      attributes.set(name, val);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    }),
    getContext: (contextId: string, _attrs?: WebGLContextAttributes) => {
      if (contextId === 'webgl2') {
        return (options.version ?? 2) === 2 ? gl : null;
      }
      if (contextId === 'webgl' || contextId === 'experimental-webgl') {
        return gl;
      }
      return null;
    },
  } as unknown as HTMLCanvasElement;

  return { canvas, gl, attributes };
}

describe('Milestone M2: Multi-Pass WebGL2/WebGL1 Fluid & Fountain Renderer', () => {
  describe('1. Shaders (`src/webgl/shaders.ts`)', () => {
    it('provides valid GLSL ES 3.00 (WebGL2) and GLSL ES 1.00 (WebGL1) sources for all 5 passes', () => {
      const gl2Sources = getShaderSources(2);
      const gl1Sources = getShaderSources(1);

      expect(SHADER_PASS_NAMES).toEqual([
        'sceneMesh',
        'fluidSplat',
        'fluidResolve',
        'bubbleFoam',
        'glassContainer',
      ]);

      for (const pass of SHADER_PASS_NAMES) {
        const s2 = gl2Sources[pass];
        expect(s2).toBe(getShaderSource(pass, 2));
        expect(s2.vertexSource.startsWith('#version 300 es')).toBe(true);
        expect(s2.fragmentSource.startsWith('#version 300 es')).toBe(true);
        expect(s2.fragmentSource).toContain('out vec4 outColor;');
        expect(s2.attributeNames.length).toBeGreaterThan(0);
        expect(s2.uniformNames.length).toBeGreaterThan(0);

        const s1 = gl1Sources[pass];
        expect(s1).toBe(getShaderSource(pass, 1));
        expect(s1.vertexSource.startsWith('#version 100')).toBe(true);
        expect(s1.fragmentSource.startsWith('#version 100')).toBe(true);
        expect(s1.fragmentSource).toContain('gl_FragColor');
      }

      // Verify fluidResolve recovers exact weighted RGB and restricts Fresnel highlight to boundary
      expect(gl2Sources.fluidResolve.fragmentSource).toContain(
        'accum.rgb / max(accum.a, 1e-5)',
      );
      expect(gl2Sources.fluidResolve.fragmentSource).toContain('boundaryMask');
    });

    it('compiles, links, and destroys all 5 shader programs on both WebGL2 and WebGL1 contexts', () => {
      for (const version of [2, 1] as const) {
        const gl = createMockWebGLContext({ version });
        const bundle = createAllShaderPrograms(gl, version);

        expect(bundle.sceneMeshProgram).toBe(bundle.sceneMesh);
        expect(bundle.fluidSplatProgram).toBe(bundle.fluidSplat);
        expect(bundle.fluidResolveProgram).toBe(bundle.fluidResolve);
        expect(bundle.bubbleFoamProgram).toBe(bundle.bubbleFoam);
        expect(bundle.glassContainerProgram).toBe(bundle.glassContainer);

        for (const pass of SHADER_PASS_NAMES) {
          const compiled = bundle[pass];
          expect(compiled.name).toBe(pass);
          expect(compiled.program).toBeDefined();
          for (const attr of getShaderSource(pass, version).attributeNames) {
            expect(typeof compiled.attributes[attr]).toBe('number');
          }
          for (const u of getShaderSource(pass, version).uniformNames) {
            expect(compiled.uniforms[u]).not.toBeNull();
          }
        }

        destroyShaderPrograms(gl, bundle);
        for (const prog of gl.__stats.programs.values()) {
          expect(prog.deleted).toBe(true);
        }
      }
    });

    it('throws descriptive errors and cleans up resources when shader compilation or linking fails', () => {
      const glCompileFail = createMockWebGLContext({
        failCompilePass: 'u_fluidTex',
      });
      expect(() =>
        compileShader(
          glCompileFail,
          glCompileFail.FRAGMENT_SHADER,
          'invalid shader source without main',
          'testFrag',
        ),
      ).toThrow(/Shader compilation failed/);

      expect(() => createAllShaderPrograms(glCompileFail, 2)).toThrow(
        /Shader compilation failed/,
      );

      const glLinkFail = createMockWebGLContext({
        failLinkPass: 'u_isoThreshold',
      });
      expect(() =>
        createShaderProgram(
          glLinkFail,
          'fluidResolve',
          getShaderSource('fluidResolve', 2),
        ),
      ).toThrow(/Shader program link failed/);
    });
  });

  describe('2. Offscreen FBO Manager (`src/webgl/fbo.ts`)', () => {
    it('creates an RGBA16F float FBO in WebGL2 when EXT_color_buffer_float is available', () => {
      const gl2 = createMockWebGLContext({
        version: 2,
        supportFloatFBO: true,
      });
      expect(detectWebGLVersion(gl2)).toBe(2);

      const fbo = createFluidFBO(gl2, 640, 480);
      expect(fbo.isFloat).toBe(true);
      expect(fbo.width).toBe(640);
      expect(fbo.height).toBe(480);
      expect(fbo.splatScale).toBe(FLOAT_SPLAT_SCALE);
      expect(fbo.isoThreshold).toBe(FLOAT_ISO_THRESHOLD);

      destroyFluidFBO(gl2, fbo);
    });

    it('automatically falls back to RGBA8 (UNSIGNED_BYTE) when float FBO is unsupported or forced', () => {
      const glNoFloat = createMockWebGLContext({
        version: 2,
        supportFloatFBO: false,
      });
      const fallbackFbo = createFluidFBO(glNoFloat, 500, 400);
      expect(fallbackFbo.isFloat).toBe(false);
      expect(fallbackFbo.type).toBe(glNoFloat.UNSIGNED_BYTE);
      expect(fallbackFbo.splatScale).toBe(RGBA8_SPLAT_SCALE);
      expect(fallbackFbo.isoThreshold).toBe(RGBA8_ISO_THRESHOLD);

      const glForced = createMockWebGLContext({
        version: 2,
        supportFloatFBO: true,
      });
      const forcedFbo = createFluidFBO(glForced, 500, 400, {
        forceRGBA8: true,
      });
      expect(forcedFbo.isFloat).toBe(false);
      expect(forcedFbo.splatScale).toBe(RGBA8_SPLAT_SCALE);
    });

    it('manages FBO binding, unbinding, resizing, and disposal via FluidFBOManager', () => {
      const gl1 = createMockWebGLContext({
        version: 1,
        supportFloatFBO: false,
      });
      expect(detectWebGLVersion(gl1)).toBe(1);

      const manager = new FluidFBOManager(gl1, 320, 240, { webglVersion: 1 });
      expect(manager.width).toBe(320);
      expect(manager.height).toBe(240);
      expect(manager.isFloat).toBe(false);

      const firstFbo = manager.current;
      // Same size resize is a no-op
      expect(manager.resize(320, 240)).toBe(firstFbo);
      expect(resizeFluidFBO(gl1, firstFbo, 320, 240)).toBe(firstFbo);

      // Different dimensions allocate a new FBO and delete the old one
      const resized = manager.resize(800, 600);
      expect(resized.width).toBe(800);
      expect(resized.height).toBe(600);

      manager.bind();
      manager.unbind(800, 600);
      manager.dispose();
    });
  });

  describe('3. Procedural Meshes (`src/webgl/meshes.ts`)', () => {
    it('converts accurately between canonical world space (800x600) and clip-space NDC ([-1, 1])', () => {
      expect(worldToNDC(0, 0)).toEqual([-1, -1]);
      expect(worldToNDC(400, 300)).toEqual([0, 0]);
      expect(worldToNDC(800, 600)).toEqual([1, 1]);

      expect(ndcToWorld(-1, -1)).toEqual([0, 0]);
      expect(ndcToWorld(0, 0)).toEqual([400, 300]);
      expect(ndcToWorld(1, 1)).toEqual([800, 600]);

      const quad = buildFullScreenQuad();
      expect(quad.length).toBe(12);
    });

    it('generates scene static mesh with background, drip tray, dispenser housing, 5 nozzles, and active streams', () => {
      const world = new FluidWorld();
      const baseMesh = buildSceneStaticMesh([], []);
      expect(baseMesh.length % SCENE_VERTEX_FLOATS).toBe(0);
      expect(baseMesh.length).toBeGreaterThan(60 * SCENE_VERTEX_FLOATS);

      // Activate Fanta nozzle and step 14 frames to emit falling stream particles
      world.startPouring('fanta');
      world.stepFrames(14);
      const state = world.getRenderState();
      const activeMesh = buildSceneStaticMesh(
        state.activeNozzles,
        state.particles,
      );
      // Active nozzle adds LED indicator + active falling stream core quad
      expect(activeMesh.length).toBeGreaterThan(baseMesh.length);
    });

    it('generates hydrostatic liquid mesh only when pooledParticleCount > 0 and covers y = 90', () => {
      const world = new FluidWorld();
      const emptyState = world.getRenderState();
      expect(
        buildHydrostaticLiquidMesh(emptyState.glass, emptyState.liquid).length,
      ).toBe(0);

      world.startPouring('coca-cola');
      world.stepFrames(60);
      world.stopPouring();
      world.stepFrames(45);

      const filledState = world.getRenderState();
      expect(filledState.liquid.pooledParticleCount).toBeGreaterThan(0);

      const poolTopY = computePoolTopY(filledState.glass, filledState.liquid);
      expect(poolTopY).toBeGreaterThan(95);

      const hydroMesh = buildHydrostaticLiquidMesh(
        filledState.glass,
        filledState.liquid,
      );
      expect(hydroMesh.length % SCENE_VERTEX_FLOATS).toBe(0);
      expect(hydroMesh.length).toBeGreaterThan(0);
    });

    it('generates metaball splat buffer, bubble foam buffer, and unobstructed glass container mesh', () => {
      const world = new FluidWorld();
      world.startPouring('sprite');
      world.stepFrames(65);

      const state = world.getRenderState();
      const splats = buildFluidSplatBuffer(
        state.particles,
        state.activeNozzles,
        state.glass,
        state.liquid,
      );
      expect(splats.length % FLUID_SPLAT_FLOATS).toBe(0);
      expect(splats.length / FLUID_SPLAT_FLOATS).toBeGreaterThanOrEqual(
        state.particles.length,
      );

      const bubbles = buildBubbleFoamBuffer(state.bubbles, state.glass);
      expect(bubbles.length % BUBBLE_FOAM_FLOATS).toBe(0);
      // Verify no interior rising bubble sits inside the central readback box (|x - 400| < 18, |y - 90| < 14)
      for (let i = 0; i < bubbles.length; i += BUBBLE_FOAM_FLOATS) {
        const bx = bubbles[i];
        const by = bubbles[i + 1];
        const isFoam = bubbles[i + 4] > 0.5;
        if (!isFoam && Math.abs(by - 90) < 14) {
          expect(Math.abs(bx - state.glass.x)).toBeGreaterThanOrEqual(18);
        }
      }

      const glassMesh = buildGlassContainerMesh(state.glass);
      expect(glassMesh.length % GLASS_VERTEX_FLOATS).toBe(0);
      expect(glassMesh.length).toBeGreaterThan(0);
      expect(computeGlassHalfWidthAtY(state.glass, 55)).toBeCloseTo(55, 5);
      expect(computeGlassHalfWidthAtY(state.glass, 235)).toBeCloseTo(75, 5);
    });
  });

  describe('4. Full 5-Pass Renderer & Pixel Readback (`src/webgl/renderer.ts`)', () => {
    it('initializes WebGL2 (or WebGL1 fallback), sets data-webgl-version, and renders initial static scene pixels (T1-F1-05)', () => {
      const { canvas, attributes } = createMockCanvas({
        version: 2,
        width: 400,
        height: 300,
      });
      const renderer = new SodaFountainRenderer(canvas);
      const world = new FluidWorld();

      expect(renderer.webglVersion).toBe(2);
      expect(attributes.get('data-webgl-version')).toBe('2');

      renderer.render(world);
      expect(world.getSnapshot().webglVersion).toBe(2);

      // 1. Studio background at (100, 300)
      const bgPx = renderer.samplePixelAtWorld(100, 300);
      expect(bgPx[3]).toBe(255);
      expect(bgPx[0] + bgPx[1] + bgPx[2]).toBeGreaterThan(0);
      expect(bgPx[0]).toBeLessThan(45);
      expect(bgPx[1]).toBeLessThan(45);
      expect(bgPx[2]).toBeLessThan(45);
      expect(bgPx).toEqual([
        STUDIO_BG_RGB255[0],
        STUDIO_BG_RGB255[1],
        STUDIO_BG_RGB255[2],
        255,
      ]);

      // 2. Dispenser header housing at (400, 540)
      const headerPx = renderer.samplePixelAtWorld(400, 540);
      expect(headerPx[3]).toBe(255);
      expect(headerPx).toEqual([
        DISPENSER_HEADER_RGB255[0],
        DISPENSER_HEADER_RGB255[1],
        DISPENSER_HEADER_RGB255[2],
        255,
      ]);
      const headerDiff =
        Math.abs(headerPx[0] - bgPx[0]) +
        Math.abs(headerPx[1] - bgPx[1]) +
        Math.abs(headerPx[2] - bgPx[2]);
      expect(headerDiff).toBeGreaterThan(10);

      // 3. Nozzles at (360, 490) (Coca-Cola) and (400, 490) (Sprite)
      const nozzle0Px = renderer.samplePixelAtWorld(360, 490);
      const nozzle2Px = renderer.samplePixelAtWorld(400, 490);
      expect(nozzle0Px[3]).toBe(255);
      expect(nozzle0Px[0] + nozzle0Px[1] + nozzle0Px[2]).toBeGreaterThan(0);
      expect(nozzle2Px[3]).toBe(255);
      expect(nozzle2Px[1]).toBeGreaterThan(180); // Sprite bright green

      // 4. Glass base at (400, 58)
      const glassBasePx = renderer.samplePixelAtWorld(400, 58);
      expect(glassBasePx[3]).toBe(255);
      const baseDiff =
        Math.abs(glassBasePx[0] - bgPx[0]) +
        Math.abs(glassBasePx[1] - bgPx[1]) +
        Math.abs(glassBasePx[2] - bgPx[2]);
      expect(baseDiff).toBeGreaterThan(100);

      renderer.dispose();
    });

    it('detects active falling Fanta stream pixels at (380, 440), (380, 410), and (380, 380) after 14 frames (T1-F3-02)', () => {
      const { canvas } = createMockCanvas({
        version: 2,
        width: 400,
        height: 300,
      });
      const renderer = new SodaFountainRenderer(canvas);
      const world = new FluidWorld();

      renderer.render(world);
      const bgBefore = renderer.samplePixelAtWorld(380, 410);

      world.startPouring('fanta');
      world.stepFrames(14);
      renderer.render(world);

      const streamSamples = [
        renderer.samplePixelAtWorld(380, 440),
        renderer.samplePixelAtWorld(380, 410),
        renderer.samplePixelAtWorld(380, 380),
      ];

      for (const px of streamSamples) {
        expect(px[3]).toBe(255);
        expect(px[0] - bgBefore[0]).toBeGreaterThan(150);
      }

      const maxRedDiff = Math.max(
        ...streamSamples.map((px) => px[0] - bgBefore[0]),
      );
      expect(maxRedDiff).toBeGreaterThan(25);

      renderer.dispose();
    });

    it('renders accurate pooled liquid colors for all 5 pure drinks at (400, 90) and sampleGlassLiquidPixel() (T1-F3-03, T1-F6-01)', () => {
      const { canvas } = createMockCanvas({
        version: 2,
        width: 400,
        height: 300,
      });
      const renderer = new SodaFountainRenderer(canvas);
      const world = new FluidWorld();

      renderer.render(world);
      const emptyInteriorPx = renderer.samplePixelAtWorld(400, 90);

      for (const drinkId of DRINK_IDS) {
        world.reset();
        world.startPouring(drinkId);
        world.stepFrames(60);
        world.stopPouring();
        world.stepFrames(45);
        renderer.render(world);

        const spec = DRINK_BY_ID[drinkId];
        const centerPx = renderer.samplePixelAtWorld(400, 90);
        const liquidPx = renderer.sampleGlassLiquidPixel();

        expect(centerPx[3]).toBe(255);
        expect(liquidPx[3]).toBe(255);

        // Manhattan diff at (400, 90) vs empty glass interior must exceed 15 (even for dark Coca-Cola)
        const manhattanDiff =
          Math.abs(centerPx[0] - emptyInteriorPx[0]) +
          Math.abs(centerPx[1] - emptyInteriorPx[1]) +
          Math.abs(centerPx[2] - emptyInteriorPx[2]);
        expect(manhattanDiff).toBeGreaterThan(40);

        // Rendered liquid pixel must closely match catalog RGB
        expect(Math.abs(liquidPx[0] - spec.rgb255[0])).toBeLessThanOrEqual(8);
        expect(Math.abs(liquidPx[1] - spec.rgb255[1])).toBeLessThanOrEqual(8);
        expect(Math.abs(liquidPx[2] - spec.rgb255[2])).toBeLessThanOrEqual(8);

        if (drinkId === 'fanta') {
          expect(liquidPx[0]).toBeGreaterThan(liquidPx[1]);
          expect(liquidPx[1]).toBeGreaterThan(liquidPx[2] + 25);
        }
        if (drinkId === 'berry-blue') {
          expect(liquidPx[2]).toBeGreaterThan(liquidPx[1]);
          expect(liquidPx[1]).toBeGreaterThan(liquidPx[0] + 25);
        }
      }

      renderer.dispose();
    });

    it('renders volume-weighted multi-drink mixes accurately in both RGBA16F and RGBA8 FBO modes (T1-F6-02, T1-F6-03)', () => {
      for (const forceRGBA8FBO of [false, true]) {
        const { canvas } = createMockCanvas({
          version: forceRGBA8FBO ? 1 : 2,
          supportFloatFBO: !forceRGBA8FBO,
          width: 400,
          height: 300,
        });
        const renderer = new SodaFountainRenderer(canvas, {
          forceWebGL1: forceRGBA8FBO,
          forceRGBA8FBO,
        });
        const world = new FluidWorld();

        // Mix 1: Coca-Cola + Fanta (50/50)
        world.startPouring('coca-cola');
        world.stepFrames(50);
        world.stopPouring();
        world.stepFrames(25);
        renderer.render(world);
        const colaOnlyPx = renderer.sampleGlassLiquidPixel();

        world.startPouring('fanta');
        world.stepFrames(50);
        world.stopPouring();
        world.stepFrames(55);
        renderer.render(world);
        const colaFantaPx = renderer.sampleGlassLiquidPixel();

        expect(colaFantaPx[3]).toBe(255);
        expect(colaFantaPx[0]).toBeGreaterThan(colaOnlyPx[0] + 20);
        expect(colaFantaPx[0]).toBeGreaterThan(colaFantaPx[1]);
        expect(colaFantaPx[1]).toBeGreaterThan(colaFantaPx[2]);

        // Mix 2: Cherry + Berry-Blue (50/50 purple)
        world.reset();
        world.startPouring('cherry');
        world.stepFrames(50);
        world.stopPouring();
        world.startPouring('berry-blue');
        world.stepFrames(50);
        world.stopPouring();
        world.stepFrames(60);
        renderer.render(world);

        const purplePx = renderer.sampleGlassLiquidPixel();
        const expectedPurple = blendDrinksByVolume({
          cherry: 1,
          'berry-blue': 1,
        }).rgb255;
        expect(purplePx[3]).toBe(255);
        expect(purplePx[0]).toBeGreaterThan(50);
        expect(purplePx[2]).toBeGreaterThan(80);
        expect(Math.abs(purplePx[0] - expectedPurple[0])).toBeLessThanOrEqual(12);
        expect(Math.abs(purplePx[2] - expectedPurple[2])).toBeLessThanOrEqual(12);

        renderer.dispose();
      }
    });

    it('shifts rendered glass base and pooled liquid pixels when the glass is dragged (T1-F4-04, T1-F5-02)', () => {
      const { canvas } = createMockCanvas({
        version: 2,
        width: 400,
        height: 300,
      });
      const renderer = new SodaFountainRenderer(canvas);
      const world = new FluidWorld();

      // 1. T1-F4-04: Glass base shift to x = 220
      renderer.render(world);
      const emptyAt220Before = renderer.samplePixelAtWorld(220, 58);

      world.moveGlassTo(220, 145);
      renderer.render(world);
      const glassBaseAt220After = renderer.samplePixelAtWorld(220, 58);

      const baseShiftDiff =
        Math.abs(glassBaseAt220After[0] - emptyAt220Before[0]) +
        Math.abs(glassBaseAt220After[1] - emptyAt220Before[1]) +
        Math.abs(glassBaseAt220After[2] - emptyAt220Before[2]);
      expect(baseShiftDiff).toBeGreaterThan(100);

      // 2. T1-F5-02: Co-translated Cherry pool shift from x = 400 to x = 520
      world.reset();
      world.startPouring('cherry');
      world.stepFrames(65);
      world.stopPouring();
      world.stepFrames(35);

      world.moveGlassTo(520, 145);
      world.stepFrames(10);
      renderer.render(world);

      const pixelAtNewGlass = renderer.samplePixelAtWorld(520, 90);
      const pixelAtOldCenter = renderer.samplePixelAtWorld(400, 90);
      expect(pixelAtNewGlass[0]).toBeGreaterThan(pixelAtOldCenter[0] + 30);

      renderer.dispose();
    });

    it('clamps out-of-bounds/non-finite coordinates safely and handles resize + empty glass readback (T2-F1-01..04)', () => {
      const { canvas } = createMockCanvas({
        version: 2,
        width: 400,
        height: 300,
        enableSoftwareRaster: false, // Also verifies deterministic software fallback when readPixels is zeroed
      });
      const renderer = new SodaFountainRenderer(canvas);
      const world = new FluidWorld();
      renderer.render(world);

      // Out-of-bounds and NaN coordinates
      for (const [wx, wy] of [
        [-100, -100],
        [9999, 9999],
        [Number.NaN, Number.POSITIVE_INFINITY],
      ]) {
        const px = renderer.samplePixelAtWorld(wx, wy);
        expect(px).toHaveLength(4);
        for (const ch of px) {
          expect(Number.isFinite(ch)).toBe(true);
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
        expect(px[3]).toBe(255);
      }

      // Empty glass liquid sample
      const emptyLiquidPx = renderer.sampleGlassLiquidPixel(world.getSnapshot());
      expect(emptyLiquidPx).toEqual([
        STUDIO_BG_RGB255[0],
        STUDIO_BG_RGB255[1],
        STUDIO_BG_RGB255[2],
        255,
      ]);

      // Resize and verify screenRect update
      const rect = renderer.resize(1280, 720, 1.5);
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);
      expect(rect.width).toBeGreaterThan(100);
      expect(rect.height).toBeGreaterThan(100);

      expect(
        evaluateScenePixelAtWorld(400, 540, world.getRenderState()),
      ).toEqual([
        DISPENSER_HEADER_RGB255[0],
        DISPENSER_HEADER_RGB255[1],
        DISPENSER_HEADER_RGB255[2],
        255,
      ]);

      renderer.dispose();
    });
  });
});
