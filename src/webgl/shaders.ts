export type ShaderPassName =
  | 'sceneMesh'
  | 'fluidSplat'
  | 'fluidResolve'
  | 'bubbleFoam'
  | 'glassContainer';

export const SHADER_PASS_NAMES: readonly ShaderPassName[] = [
  'sceneMesh',
  'fluidSplat',
  'fluidResolve',
  'bubbleFoam',
  'glassContainer',
] as const;

export interface ShaderSourcePair {
  readonly vertexSource: string;
  readonly fragmentSource: string;
  readonly attributeNames: readonly string[];
  readonly uniformNames: readonly string[];
}

export interface CompiledShaderProgram {
  readonly name: ShaderPassName;
  readonly program: WebGLProgram;
  readonly vertexShader: WebGLShader;
  readonly fragmentShader: WebGLShader;
  readonly attributes: Readonly<Record<string, number>>;
  readonly uniforms: Readonly<Record<string, WebGLUniformLocation | null>>;
}

export type ShaderProgramMap = Readonly<Record<ShaderPassName, CompiledShaderProgram>>;

export interface ShaderProgramBundle extends ShaderProgramMap {
  readonly sceneMeshProgram: CompiledShaderProgram;
  readonly fluidSplatProgram: CompiledShaderProgram;
  readonly fluidResolveProgram: CompiledShaderProgram;
  readonly bubbleFoamProgram: CompiledShaderProgram;
  readonly glassContainerProgram: CompiledShaderProgram;
}

const WEBGL2_SHADERS: Readonly<Record<ShaderPassName, ShaderSourcePair>> = {
  sceneMesh: {
    attributeNames: ['a_position', 'a_color'],
    uniformNames: ['u_worldSize'],
    vertexSource: `#version 300 es
precision highp float;

in vec2 a_position;
in vec4 a_color;

uniform vec2 u_worldSize;

out vec4 v_color;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}
`,
    fragmentSource: `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = vec4(clamp(v_color.rgb, 0.0, 1.0), clamp(v_color.a, 0.0, 1.0));
}
`,
  },

  fluidSplat: {
    attributeNames: ['a_position', 'a_color', 'a_radius', 'a_state'],
    uniformNames: ['u_worldSize', 'u_viewportSize', 'u_splatScale'],
    vertexSource: `#version 300 es
precision highp float;

in vec2 a_position;
in vec4 a_color;
in float a_radius;
in float a_state;

uniform vec2 u_worldSize;
uniform vec2 u_viewportSize;
uniform float u_splatScale;

out vec4 v_color;
out float v_state;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  float scaleY = u_viewportSize.y / max(u_worldSize.y, 1.0);
  gl_PointSize = clamp(a_radius * 2.0 * scaleY, 2.0, 256.0);
  v_color = a_color;
  v_state = a_state;
}
`,
    fragmentSource: `#version 300 es
precision highp float;

in vec4 v_color;
in float v_state;

uniform float u_splatScale;

out vec4 outColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) {
    discard;
  }
  float t = 1.0 - r2;
  float kernel = t * t * t;
  float w = kernel * clamp(v_color.a, 0.0, 1.0) * u_splatScale;
  outColor = vec4(v_color.rgb * w, w);
}
`,
  },

  fluidResolve: {
    attributeNames: ['a_position'],
    uniformNames: [
      'u_fluidTex',
      'u_texelSize',
      'u_isoThreshold',
      'u_splatScale',
      'u_foamColor',
    ],
    vertexSource: `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`,
    fragmentSource: `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_fluidTex;
uniform vec2 u_texelSize;
uniform float u_isoThreshold;
uniform float u_splatScale;
uniform vec3 u_foamColor;

out vec4 outColor;

void main() {
  vec4 accum = texture(u_fluidTex, v_uv);
  float scale = max(u_splatScale, 1e-4);
  float density = accum.a / scale;
  if (density < u_isoThreshold * 0.5) {
    discard;
  }

  vec3 baseColor = clamp(accum.rgb / max(accum.a, 1e-5), 0.0, 1.0);
  float alpha = smoothstep(u_isoThreshold * 0.65, u_isoThreshold * 1.25, density);

  // Restrict Fresnel/meniscus edge sheen strictly to the thin free-surface boundary
  // so interior liquid pixels retain 100% true drink/mixed RGB fidelity.
  float boundaryMask = 1.0 - smoothstep(u_isoThreshold * 1.3, u_isoThreshold * 2.6, density);
  vec3 finalRgb = baseColor;
  if (boundaryMask > 0.001) {
    float dR = texture(u_fluidTex, v_uv + vec2(u_texelSize.x, 0.0)).a / scale;
    float dL = texture(u_fluidTex, v_uv - vec2(u_texelSize.x, 0.0)).a / scale;
    float dU = texture(u_fluidTex, v_uv + vec2(0.0, u_texelSize.y)).a / scale;
    float dD = texture(u_fluidTex, v_uv - vec2(0.0, u_texelSize.y)).a / scale;
    vec2 grad = vec2(dR - dL, dU - dD);
    float gradLen = length(grad);
    float highlight = boundaryMask * clamp(gradLen * 0.25, 0.0, 0.14);
    finalRgb = mix(baseColor, clamp(u_foamColor, 0.0, 1.0), highlight);
  }

  outColor = vec4(finalRgb, alpha);
}
`,
  },

  bubbleFoam: {
    attributeNames: ['a_position', 'a_radius', 'a_alpha', 'a_isFoam'],
    uniformNames: ['u_worldSize', 'u_viewportSize', 'u_foamColor'],
    vertexSource: `#version 300 es
precision highp float;

in vec2 a_position;
in float a_radius;
in float a_alpha;
in float a_isFoam;

uniform vec2 u_worldSize;
uniform vec2 u_viewportSize;

out float v_alpha;
out float v_isFoam;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  float scaleY = u_viewportSize.y / max(u_worldSize.y, 1.0);
  gl_PointSize = clamp(a_radius * 2.0 * scaleY, 2.0, 64.0);
  v_alpha = a_alpha;
  v_isFoam = a_isFoam;
}
`,
    fragmentSource: `#version 300 es
precision highp float;

in float v_alpha;
in float v_isFoam;

uniform vec3 u_foamColor;

out vec4 outColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) {
    discard;
  }

  float outAlpha;
  vec3 rgb;
  if (v_isFoam > 0.5) {
    float soft = 1.0 - r2;
    outAlpha = soft * clamp(v_alpha, 0.0, 1.0) * 0.42;
    rgb = mix(clamp(u_foamColor, 0.0, 1.0), vec3(1.0), 0.35);
  } else {
    float ring = smoothstep(0.35, 0.85, r2) * (1.0 - smoothstep(0.85, 1.0, r2));
    outAlpha = ring * clamp(v_alpha, 0.0, 1.0) * 0.14;
    rgb = mix(clamp(u_foamColor, 0.0, 1.0), vec3(1.0), 0.5);
  }

  outColor = vec4(rgb, outAlpha);
}
`,
  },

  glassContainer: {
    attributeNames: ['a_position', 'a_color', 'a_edgeFactor'],
    uniformNames: ['u_worldSize'],
    vertexSource: `#version 300 es
precision highp float;

in vec2 a_position;
in vec4 a_color;
in float a_edgeFactor;

uniform vec2 u_worldSize;

out vec4 v_color;
out float v_edgeFactor;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
  v_edgeFactor = a_edgeFactor;
}
`,
    fragmentSource: `#version 300 es
precision highp float;

in vec4 v_color;
in float v_edgeFactor;

out vec4 outColor;

void main() {
  float fresnel = pow(clamp(v_edgeFactor, 0.0, 1.0), 1.6) * 0.18;
  vec3 litRgb = clamp(v_color.rgb + vec3(fresnel), 0.0, 1.0);
  outColor = vec4(litRgb, clamp(v_color.a, 0.0, 1.0));
}
`,
  },
};

const WEBGL1_SHADERS: Readonly<Record<ShaderPassName, ShaderSourcePair>> = {
  sceneMesh: {
    attributeNames: ['a_position', 'a_color'],
    uniformNames: ['u_worldSize'],
    vertexSource: `#version 100
precision highp float;

attribute vec2 a_position;
attribute vec4 a_color;

uniform vec2 u_worldSize;

varying vec4 v_color;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}
`,
    fragmentSource: `#version 100
precision highp float;

varying vec4 v_color;

void main() {
  gl_FragColor = vec4(clamp(v_color.rgb, 0.0, 1.0), clamp(v_color.a, 0.0, 1.0));
}
`,
  },

  fluidSplat: {
    attributeNames: ['a_position', 'a_color', 'a_radius', 'a_state'],
    uniformNames: ['u_worldSize', 'u_viewportSize', 'u_splatScale'],
    vertexSource: `#version 100
precision highp float;

attribute vec2 a_position;
attribute vec4 a_color;
attribute float a_radius;
attribute float a_state;

uniform vec2 u_worldSize;
uniform vec2 u_viewportSize;
uniform float u_splatScale;

varying vec4 v_color;
varying float v_state;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  float scaleY = u_viewportSize.y / max(u_worldSize.y, 1.0);
  gl_PointSize = clamp(a_radius * 2.0 * scaleY, 2.0, 256.0);
  v_color = a_color;
  v_state = a_state;
}
`,
    fragmentSource: `#version 100
precision highp float;

varying vec4 v_color;
varying float v_state;

uniform float u_splatScale;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) {
    discard;
  }
  float t = 1.0 - r2;
  float kernel = t * t * t;
  float w = kernel * clamp(v_color.a, 0.0, 1.0) * u_splatScale;
  gl_FragColor = vec4(v_color.rgb * w, w);
}
`,
  },

  fluidResolve: {
    attributeNames: ['a_position'],
    uniformNames: [
      'u_fluidTex',
      'u_texelSize',
      'u_isoThreshold',
      'u_splatScale',
      'u_foamColor',
    ],
    vertexSource: `#version 100
precision highp float;

attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`,
    fragmentSource: `#version 100
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_fluidTex;
uniform vec2 u_texelSize;
uniform float u_isoThreshold;
uniform float u_splatScale;
uniform vec3 u_foamColor;

void main() {
  vec4 accum = texture2D(u_fluidTex, v_uv);
  float scale = max(u_splatScale, 1e-4);
  float density = accum.a / scale;
  if (density < u_isoThreshold * 0.5) {
    discard;
  }

  vec3 baseColor = clamp(accum.rgb / max(accum.a, 1e-5), 0.0, 1.0);
  float alpha = smoothstep(u_isoThreshold * 0.65, u_isoThreshold * 1.25, density);

  float boundaryMask = 1.0 - smoothstep(u_isoThreshold * 1.3, u_isoThreshold * 2.6, density);
  vec3 finalRgb = baseColor;
  if (boundaryMask > 0.001) {
    float dR = texture2D(u_fluidTex, v_uv + vec2(u_texelSize.x, 0.0)).a / scale;
    float dL = texture2D(u_fluidTex, v_uv - vec2(u_texelSize.x, 0.0)).a / scale;
    float dU = texture2D(u_fluidTex, v_uv + vec2(0.0, u_texelSize.y)).a / scale;
    float dD = texture2D(u_fluidTex, v_uv - vec2(0.0, u_texelSize.y)).a / scale;
    vec2 grad = vec2(dR - dL, dU - dD);
    float gradLen = length(grad);
    float highlight = boundaryMask * clamp(gradLen * 0.25, 0.0, 0.14);
    finalRgb = mix(baseColor, clamp(u_foamColor, 0.0, 1.0), highlight);
  }

  gl_FragColor = vec4(finalRgb, alpha);
}
`,
  },

  bubbleFoam: {
    attributeNames: ['a_position', 'a_radius', 'a_alpha', 'a_isFoam'],
    uniformNames: ['u_worldSize', 'u_viewportSize', 'u_foamColor'],
    vertexSource: `#version 100
precision highp float;

attribute vec2 a_position;
attribute float a_radius;
attribute float a_alpha;
attribute float a_isFoam;

uniform vec2 u_worldSize;
uniform vec2 u_viewportSize;

varying float v_alpha;
varying float v_isFoam;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  float scaleY = u_viewportSize.y / max(u_worldSize.y, 1.0);
  gl_PointSize = clamp(a_radius * 2.0 * scaleY, 2.0, 64.0);
  v_alpha = a_alpha;
  v_isFoam = a_isFoam;
}
`,
    fragmentSource: `#version 100
precision highp float;

varying float v_alpha;
varying float v_isFoam;

uniform vec3 u_foamColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) {
    discard;
  }

  float outAlpha;
  vec3 rgb;
  if (v_isFoam > 0.5) {
    float soft = 1.0 - r2;
    outAlpha = soft * clamp(v_alpha, 0.0, 1.0) * 0.42;
    rgb = mix(clamp(u_foamColor, 0.0, 1.0), vec3(1.0), 0.35);
  } else {
    float ring = smoothstep(0.35, 0.85, r2) * (1.0 - smoothstep(0.85, 1.0, r2));
    outAlpha = ring * clamp(v_alpha, 0.0, 1.0) * 0.14;
    rgb = mix(clamp(u_foamColor, 0.0, 1.0), vec3(1.0), 0.5);
  }

  gl_FragColor = vec4(rgb, outAlpha);
}
`,
  },

  glassContainer: {
    attributeNames: ['a_position', 'a_color', 'a_edgeFactor'],
    uniformNames: ['u_worldSize'],
    vertexSource: `#version 100
precision highp float;

attribute vec2 a_position;
attribute vec4 a_color;
attribute float a_edgeFactor;

uniform vec2 u_worldSize;

varying vec4 v_color;
varying float v_edgeFactor;

void main() {
  vec2 clip = (a_position / max(u_worldSize, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
  v_edgeFactor = a_edgeFactor;
}
`,
    fragmentSource: `#version 100
precision highp float;

varying vec4 v_color;
varying float v_edgeFactor;

void main() {
  float fresnel = pow(clamp(v_edgeFactor, 0.0, 1.0), 1.6) * 0.18;
  vec3 litRgb = clamp(v_color.rgb + vec3(fresnel), 0.0, 1.0);
  gl_FragColor = vec4(litRgb, clamp(v_color.a, 0.0, 1.0));
}
`,
  },
};

export function getShaderSource(
  pass: ShaderPassName,
  webglVersion: 1 | 2 = 2,
): ShaderSourcePair {
  const table = webglVersion === 2 ? WEBGL2_SHADERS : WEBGL1_SHADERS;
  const pair = table[pass];
  if (!pair) {
    throw new Error(`Unknown shader pass: ${String(pass)}`);
  }
  return pair;
}

export function getShaderSources(
  webglVersion: 1 | 2 = 2,
): Readonly<Record<ShaderPassName, ShaderSourcePair>> {
  return webglVersion === 2 ? WEBGL2_SHADERS : WEBGL1_SHADERS;
}

export function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string,
  label = 'shader',
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error(`Failed to allocate WebGLShader for ${label}`);
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!ok) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed (${label}): ${log}`);
  }

  return shader;
}

export function createShaderProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  name: ShaderPassName,
  sourcePair: ShaderSourcePair,
): CompiledShaderProgram {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    sourcePair.vertexSource,
    `${name}:vertex`,
  );

  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      sourcePair.fragmentSource,
      `${name}:fragment`,
    );
  } catch (err) {
    gl.deleteShader(vertexShader);
    throw err;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error(`Failed to allocate WebGLProgram for ${name}`);
  }

  // Bind attribute locations deterministically in declaration order (0, 1, 2, ...)
  for (let i = 0; i < sourcePair.attributeNames.length; i++) {
    gl.bindAttribLocation(program, i, sourcePair.attributeNames[i]);
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!linked) {
    const log = gl.getProgramInfoLog(program) || 'Unknown program link error';
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error(`Shader program link failed (${name}): ${log}`);
  }

  const attributes: Record<string, number> = {};
  for (let i = 0; i < sourcePair.attributeNames.length; i++) {
    const attrName = sourcePair.attributeNames[i];
    const loc = gl.getAttribLocation(program, attrName);
    attributes[attrName] = loc >= 0 ? loc : i;
  }

  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (let i = 0; i < sourcePair.uniformNames.length; i++) {
    const uniformName = sourcePair.uniformNames[i];
    uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
  }

  return {
    name,
    program,
    vertexShader,
    fragmentShader,
    attributes,
    uniforms,
  };
}

export function createAllShaderPrograms(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  webglVersion: 1 | 2 = 2,
): ShaderProgramBundle {
  const sources = getShaderSources(webglVersion);
  const compiled: Partial<Record<ShaderPassName, CompiledShaderProgram>> = {};

  try {
    for (const pass of SHADER_PASS_NAMES) {
      compiled[pass] = createShaderProgram(gl, pass, sources[pass]);
    }
  } catch (err) {
    destroyShaderPrograms(gl, compiled);
    throw err;
  }

  const map = compiled as Record<ShaderPassName, CompiledShaderProgram>;
  return {
    ...map,
    sceneMeshProgram: map.sceneMesh,
    fluidSplatProgram: map.fluidSplat,
    fluidResolveProgram: map.fluidResolve,
    bubbleFoamProgram: map.bubbleFoam,
    glassContainerProgram: map.glassContainer,
  };
}

export function destroyShaderPrograms(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  programs: Partial<Record<ShaderPassName, CompiledShaderProgram>>,
): void {
  for (const pass of SHADER_PASS_NAMES) {
    const entry = programs[pass];
    if (!entry) continue;
    gl.deleteProgram(entry.program);
    gl.deleteShader(entry.vertexShader);
    gl.deleteShader(entry.fragmentShader);
  }
}
