import {
  ALCOVE_LEFT_X,
  ALCOVE_RIGHT_X,
  BUTTON_CENTER_Y,
  BUTTON_H,
  BUTTON_W,
  COUNTER_TOP_Y,
  FOUNTAIN_BOTTOM_Y,
  FOUNTAIN_LEFT_X,
  FOUNTAIN_RIGHT_X,
  FOUNTAIN_TOP_Y,
  GLASS_BASE_THICKNESS,
  GLASS_BOTTOM_HALF_W,
  GLASS_INNER_HEIGHT,
  GLASS_TOP_HALF_W,
  GLASS_WALL_THICKNESS,
  NOZZLE_BASE_Y,
  NOZZLE_HALF_W,
  NOZZLE_TIP_Y,
  TRAY_LEFT_X,
  TRAY_RIGHT_X,
  TRAY_SURFACE_Y,
} from '../types';

export interface ShaderSourcePair {
  vert: string;
  frag: string;
}

export interface RendererShaderSources {
  studioBg: ShaderSourcePair;
  particleSplat: ShaderSourcePair;
  blur: ShaderSourcePair;
  liquidShade: ShaderSourcePair;
  bubble: ShaderSourcePair;
  glassComposite: ShaderSourcePair;
}

function f(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

const SCENE_CONSTANTS_GLSL = `
#define COUNTER_TOP_Y ${f(COUNTER_TOP_Y)}
#define TRAY_SURFACE_Y ${f(TRAY_SURFACE_Y)}
#define TRAY_LEFT_X ${f(TRAY_LEFT_X)}
#define TRAY_RIGHT_X ${f(TRAY_RIGHT_X)}
#define FOUNTAIN_LEFT_X ${f(FOUNTAIN_LEFT_X)}
#define FOUNTAIN_RIGHT_X ${f(FOUNTAIN_RIGHT_X)}
#define FOUNTAIN_BOTTOM_Y ${f(FOUNTAIN_BOTTOM_Y)}
#define FOUNTAIN_TOP_Y ${f(FOUNTAIN_TOP_Y)}
#define ALCOVE_LEFT_X ${f(ALCOVE_LEFT_X)}
#define ALCOVE_RIGHT_X ${f(ALCOVE_RIGHT_X)}
#define NOZZLE_TIP_Y ${f(NOZZLE_TIP_Y)}
#define NOZZLE_BASE_Y ${f(NOZZLE_BASE_Y)}
#define NOZZLE_HALF_W ${f(NOZZLE_HALF_W)}
#define BUTTON_CENTER_Y ${f(BUTTON_CENTER_Y)}
#define BUTTON_W ${f(BUTTON_W)}
#define BUTTON_H ${f(BUTTON_H)}
#define GLASS_BASE_THICKNESS ${f(GLASS_BASE_THICKNESS)}
#define GLASS_WALL_THICKNESS ${f(GLASS_WALL_THICKNESS)}
#define GLASS_INNER_HEIGHT ${f(GLASS_INNER_HEIGHT)}
#define GLASS_BOTTOM_HALF_W ${f(GLASS_BOTTOM_HALF_W)}
#define GLASS_TOP_HALF_W ${f(GLASS_TOP_HALF_W)}
#define GLASS_TOTAL_H ${f(GLASS_BASE_THICKNESS + GLASS_INNER_HEIGHT)}

float sq(float x) {
  return x * x;
}
`;

const COLOR_SPACE_GLSL = `
vec3 srgbToLinear(vec3 c) {
  vec3 clamped = clamp(c, 0.0, 1.0);
  vec3 lo = clamped / 12.92;
  vec3 hi = pow(max((clamped + 0.055) / 1.055, vec3(1e-5)), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), clamped));
}

vec3 linearToSrgb(vec3 c) {
  vec3 clamped = max(c, vec3(0.0));
  vec3 lo = clamped * 12.92;
  vec3 hi = 1.055 * pow(max(clamped, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return clamp(mix(lo, hi, step(vec3(0.0031308), clamped)), 0.0, 1.0);
}
`;

export function buildShaderSources(isWebGL2: boolean): RendererShaderSources {
  const vertHeader = isWebGL2
    ? `#version 300 es
precision highp float;
#define ATTR in
#define VARYING out
`
    : `precision highp float;
#define ATTR attribute
#define VARYING varying
`;

  const fragHeader = isWebGL2
    ? `#version 300 es
precision highp float;
#define VARYING in
#define TEX2D texture
out vec4 outFragColor;
#define FRAG_COLOR outFragColor
`
    : `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define VARYING varying
#define TEX2D texture2D
#define FRAG_COLOR gl_FragColor
`;

  const fullscreenVert = `${vertHeader}
uniform vec4 uViewBounds;
ATTR vec2 aPosition;
VARYING vec2 vUv;
VARYING vec2 vWorldPos;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  vWorldPos = vec2(
    mix(uViewBounds.x, uViewBounds.y, vUv.x),
    mix(uViewBounds.z, uViewBounds.w, vUv.y)
  );
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

  // ============================================================================
  // PASS 1: Full-Screen Procedural Studio & Industrial Soda Fountain Shader
  // ============================================================================
  const studioBgFrag = `${fragHeader}
${SCENE_CONSTANTS_GLSL}

uniform float uWorldPerPixel;
uniform vec2 uGlassPos;
uniform float uGlassFill;
uniform float uNozzleX[5];
uniform vec3 uNozzleRingColor[5];
uniform vec3 uNozzleGlowColor[5];
uniform float uNozzleActive[5];
uniform float uTime;

VARYING vec2 vUv;
VARYING vec2 vWorldPos;

// r.x = top-right, r.y = bottom-right, r.z = top-left, r.w = bottom-left
float sdRoundedBox(vec2 p, vec2 b, vec4 r) {
  vec2 rSel = (p.x > 0.0) ? r.xy : r.zw;
  float rad = (p.y > 0.0) ? rSel.x : rSel.y;
  vec2 q = abs(p) - b + vec2(rad);
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
}

float aaCoverage(float sd, float aa) {
  return 1.0 - smoothstep(-aa, aa, sd);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 p = vWorldPos;
  float aa = max(uWorldPerPixel * 1.15, 0.25);

  // 1. Full-bleed dark architectural charcoal studio backdrop (#0d1016 -> #151a24)
  vec2 stageNorm = (p - vec2(480.0, 340.0)) / vec2(520.0, 420.0);
  float radial = clamp(1.0 - dot(stageNorm, stageNorm) * 0.58, 0.0, 1.0);
  vec3 bgDark = vec3(0.051, 0.063, 0.086);   // #0d1016
  vec3 bgMid  = vec3(0.082, 0.102, 0.141);   // #151a24
  vec3 col = mix(bgDark, bgMid, smoothstep(0.0, 1.0, radial));

  // Subtle architectural wall glow behind the machine silhouette
  vec2 haloDelta = (p - vec2(480.0, 355.0)) / vec2(370.0, 310.0);
  float machineHalo = exp(-dot(haloDelta, haloDelta) * 1.65);
  col += vec3(0.022, 0.030, 0.044) * machineHalo;

  // 2. Architectural Dark Slate Countertop (Y <= COUNTER_TOP_Y)
  float dCounter = p.y - COUNTER_TOP_Y;
  float counterMask = aaCoverage(dCounter, aa);
  if (counterMask > 0.0) {
    float cy = clamp((COUNTER_TOP_Y - p.y) / 64.0, 0.0, 1.0);
    vec3 counterCol = mix(
      vec3(0.098, 0.118, 0.160),
      vec3(0.038, 0.047, 0.068),
      pow(max(cy, 1e-5), 0.72)
    );
    // Soft diffuse alcove reflection on honed counter front
    float alcoveReflectX = smoothstep(150.0, 260.0, p.x) * (1.0 - smoothstep(700.0, 810.0, p.x));
    counterCol += vec3(0.035, 0.042, 0.055) * alcoveReflectX * exp(-cy * 3.8);
    // Crisp beveled counter top lip
    float counterLip = exp(-sq((p.y - (COUNTER_TOP_Y - 1.1)) / 1.3));
    counterCol += vec3(0.095, 0.115, 0.148) * counterLip;
    col = mix(col, counterCol, counterMask);
  }

  // 3. Soda Fountain Tower Structural Side Cheeks (brushed dark gunmetal housing)
  vec2 towerCenter = vec2(0.5 * (FOUNTAIN_LEFT_X + FOUNTAIN_RIGHT_X), 0.5 * (TRAY_SURFACE_Y + FOUNTAIN_BOTTOM_Y));
  vec2 towerHalf = vec2(0.5 * (FOUNTAIN_RIGHT_X - FOUNTAIN_LEFT_X), 0.5 * (FOUNTAIN_BOTTOM_Y - TRAY_SURFACE_Y) + 6.0);
  float dTower = sdRoundedBox(p - towerCenter, towerHalf, vec4(6.0));
  float towerMask = aaCoverage(dTower, aa);
  if (towerMask > 0.0) {
    float tx = clamp((p.x - FOUNTAIN_LEFT_X) / (FOUNTAIN_RIGHT_X - FOUNTAIN_LEFT_X), 0.0, 1.0);
    vec3 pillarCol = mix(vec3(0.110, 0.132, 0.175), vec3(0.165, 0.195, 0.250), sin(tx * 3.14159265));
    // Brushed metallic vertical edge highlights on outer & inner pillar chamfers
    float outerBevel = exp(-sq((abs(p.x - towerCenter.x) - (towerHalf.x - 1.8)) / 1.6));
    float innerBevel = exp(-sq((abs(p.x - towerCenter.x) - (0.5 * (ALCOVE_RIGHT_X - ALCOVE_LEFT_X) + 1.6)) / 1.5));
    pillarCol += vec3(0.11, 0.13, 0.16) * outerBevel + vec3(0.08, 0.10, 0.13) * innerBevel;
    col = mix(col, pillarCol, towerMask);
  }

  // 4. Illuminated Dispense Alcove (X: ALCOVE_LEFT_X..ALCOVE_RIGHT_X, Y: TRAY_SURFACE_Y..FOUNTAIN_BOTTOM_Y)
  vec2 alcoveCenter = vec2(0.5 * (ALCOVE_LEFT_X + ALCOVE_RIGHT_X), 0.5 * (TRAY_SURFACE_Y + FOUNTAIN_BOTTOM_Y));
  vec2 alcoveHalf = vec2(0.5 * (ALCOVE_RIGHT_X - ALCOVE_LEFT_X), 0.5 * (FOUNTAIN_BOTTOM_Y - TRAY_SURFACE_Y));
  float dAlcove = sdRoundedBox(p - alcoveCenter, alcoveHalf, vec4(5.0));
  float alcoveMask = aaCoverage(dAlcove, aa);

  // Accumulate active nozzle LED downlight cones (affects alcove & drip tray)
  vec3 ledConeAccum = vec3(0.0);
  float ledConeMask = 0.0;
  for (int i = 0; i < 5; i++) {
    float act = uNozzleActive[i];
    if (act > 0.004) {
      float dy = (NOZZLE_TIP_Y + 4.0) - p.y;
      if (dy > -6.0) {
        float safeDy = max(dy, 0.0);
        float dx = p.x - uNozzleX[i];
        float coneHalfW = 13.0 + safeDy * 0.22;
        float lateral = exp(-sq(dx / coneHalfW));
        float verticalFade = smoothstep(-6.0, 8.0, dy) * exp(-safeDy * 0.0046);
        float tipHotspot = exp(-(dx * dx * 0.0042 + safeDy * safeDy * 0.0024));
        float w = act * (lateral * verticalFade * 0.52 + tipHotspot * 0.42);
        ledConeAccum += uNozzleGlowColor[i] * w;
        ledConeMask += w;
      }
    }
  }

  if (alcoveMask > 0.0) {
    vec2 an = (p - alcoveCenter) / alcoveHalf; // [-1, 1]
    // Warm-silver backlit brushed panel: ~#d8dee9 luminous center vignetted to #8d98ab at edges
    float vig = clamp(1.0 - (an.x * an.x * 0.68 + an.y * an.y * 0.42), 0.0, 1.0);
    vec3 alcoveEdge      = vec3(0.553, 0.596, 0.671); // #8d98ab
    vec3 alcoveCenterCol = vec3(0.865, 0.888, 0.928); // luminous #dce2ec / #d8dee9
    vec3 alcoveCol = mix(alcoveEdge, alcoveCenterCol, smoothstep(0.0, 1.0, vig));

    // Overhead recessed white studio LED diffuser wash from top of alcove
    float topWash = exp(-max(0.0, FOUNTAIN_BOTTOM_Y - p.y) * 0.011) * (1.0 - 0.35 * an.x * an.x);
    alcoveCol += vec3(0.075, 0.082, 0.095) * topWash;

    // Fine horizontal brushed satin anodized micro-grain (attenuated by pixel scale to prevent aliasing)
    float grainFade = 1.0 - smoothstep(0.6, 2.2, uWorldPerPixel);
    float brushed = (sin(p.y * 2.6) * 0.5 + sin(p.y * 6.3 + 1.1) * 0.5) * 0.007 * grainFade;
    alcoveCol += vec3(brushed);

    // Subtle recessed architectural side-wall & overhang depth AO
    float sideAo = smoothstep(0.0, 18.0, alcoveHalf.x - abs(p.x - alcoveCenter.x));
    float bottomAo = smoothstep(0.0, 14.0, p.y - TRAY_SURFACE_Y);
    float overhangShadow = 1.0 - 0.22 * exp(-max(0.0, FOUNTAIN_BOTTOM_Y - p.y) * 0.14);
    alcoveCol *= (0.82 + 0.18 * sideAo) * (0.90 + 0.10 * bottomAo) * overhangShadow;

    // Flush overhead LED lightbar strip tucked right beneath FOUNTAIN_BOTTOM_Y
    float ledBarY = smoothstep(FOUNTAIN_BOTTOM_Y - 7.5, FOUNTAIN_BOTTOM_Y - 2.5, p.y);
    float ledBarX = smoothstep(ALCOVE_LEFT_X + 14.0, ALCOVE_LEFT_X + 36.0, p.x) *
                    (1.0 - smoothstep(ALCOVE_RIGHT_X - 36.0, ALCOVE_RIGHT_X - 14.0, p.x));
    alcoveCol = mix(alcoveCol, vec3(0.95, 0.97, 1.0), ledBarY * ledBarX * 0.55);

    // Add colored LED downlight cones from active dispensing nozzles (preserving rich hue on bright panel)
    if (ledConeMask > 0.001) {
      vec3 coneHue = ledConeAccum / max(ledConeMask, 0.001);
      float wash = clamp(ledConeMask, 0.0, 0.85);
      vec3 tintedPanel = alcoveCol * mix(vec3(1.0), coneHue * 1.18 + vec3(0.12), 0.58) + ledConeAccum * 0.24;
      alcoveCol = mix(alcoveCol, tintedPanel, wash);
    }

    col = mix(col, clamp(alcoveCol, 0.0, 1.0), alcoveMask);
  }

  // 5. Five Tapered Stainless-Steel Dispenser Nozzles (NOZZLE_TIP_Y..NOZZLE_BASE_Y)
  if (p.y >= NOZZLE_TIP_Y - 3.0 && p.y <= NOZZLE_BASE_Y + 3.0) {
    for (int i = 0; i < 5; i++) {
      float nx = uNozzleX[i];
      float dx = p.x - nx;
      if (abs(dx) < NOZZLE_HALF_W + 6.0) {
        // Upper dark chrome mounting collar (Y: 467..474)
        float dCollar = sdRoundedBox(
          vec2(dx, p.y - (NOZZLE_BASE_Y - 3.5)),
          vec2(NOZZLE_HALF_W + 2.4, 3.8),
          vec4(1.5)
        );
        float collarMask = aaCoverage(dCollar, aa);
        if (collarMask > 0.0) {
          float cn = dx / (NOZZLE_HALF_W + 2.4);
          vec3 collarCol = mix(vec3(0.12, 0.14, 0.19), vec3(0.32, 0.36, 0.43), exp(-sq((cn + 0.3) / 0.45)));
          col = mix(col, collarCol, collarMask);
        }

        // Tapered stainless barrel (Y: 451.5..468.5)
        float bodyT = clamp((p.y - (NOZZLE_TIP_Y + 3.5)) / (NOZZLE_BASE_Y - NOZZLE_TIP_Y - 5.5), 0.0, 1.0);
        float halfW = mix(NOZZLE_HALF_W * 0.76, NOZZLE_HALF_W, bodyT);
        float dBarrel = max(abs(dx) - halfW, abs(p.y - (NOZZLE_TIP_Y + 11.8)) - 8.3);
        float barrelMask = aaCoverage(dBarrel, aa);
        if (barrelMask > 0.0) {
          float cyl = dx / max(halfW, 1.0);
          // Studio cylindrical brushed stainless specular lobes
          vec3 steelBase = vec3(0.42, 0.46, 0.53);
          float specMain = exp(-sq((cyl + 0.36) / 0.26));
          float specRim  = exp(-sq((cyl - 0.68) / 0.18));
          float coreDark = exp(-sq((cyl - 0.14) / 0.34));
          vec3 barrelCol = steelBase
            + vec3(0.46, 0.49, 0.54) * specMain
            + vec3(0.24, 0.27, 0.32) * specRim
            - vec3(0.20, 0.22, 0.25) * coreDark;
          col = mix(col, clamp(barrelCol, 0.0, 1.0), barrelMask);
        }

        // Colored valve ring tip (Y: NOZZLE_TIP_Y .. NOZZLE_TIP_Y + 4.2)
        float tipHalfW = NOZZLE_HALF_W * 0.74;
        float dTip = sdRoundedBox(
          vec2(dx, p.y - (NOZZLE_TIP_Y + 2.1)),
          vec2(tipHalfW, 2.1),
          vec4(1.2, 1.6, 1.2, 1.6)
        );
        float tipMask = aaCoverage(dTip, aa);
        if (tipMask > 0.0) {
          float cyl = dx / max(tipHalfW, 1.0);
          float tipLight = 0.72 + 0.38 * exp(-sq((cyl + 0.32) / 0.42));
          vec3 ringCol = uNozzleRingColor[i] * tipLight + uNozzleGlowColor[i] * (uNozzleActive[i] * 0.55);
          // Subtle dark orifice bore at bottom tip
          float bore = smoothstep(NOZZLE_TIP_Y + 1.1, NOZZLE_TIP_Y, p.y) * (1.0 - smoothstep(3.2, 4.6, abs(dx)));
          ringCol = mix(ringCol, vec3(0.06, 0.07, 0.10), bore * 0.75);
          col = mix(col, clamp(ringCol, 0.0, 1.0), tipMask);
        }
      }
    }
  }

  // 6. Fountain Upper Head (X: FOUNTAIN_LEFT_X..FOUNTAIN_RIGHT_X, Y: FOUNTAIN_BOTTOM_Y..FOUNTAIN_TOP_Y)
  vec2 headCenter = vec2(0.5 * (FOUNTAIN_LEFT_X + FOUNTAIN_RIGHT_X), 0.5 * (FOUNTAIN_BOTTOM_Y + FOUNTAIN_TOP_Y));
  vec2 headHalf = vec2(0.5 * (FOUNTAIN_RIGHT_X - FOUNTAIN_LEFT_X), 0.5 * (FOUNTAIN_TOP_Y - FOUNTAIN_BOTTOM_Y));
  float dHead = sdRoundedBox(p - headCenter, headHalf, vec4(15.0, 5.0, 15.0, 5.0));
  float headMask = aaCoverage(dHead, aa);
  if (headMask > 0.0) {
    vec2 hn = (p - headCenter) / headHalf;
    // Brushed dark anodized gunmetal chassis
    vec3 headTop = vec3(0.155, 0.185, 0.242);
    vec3 headBot = vec3(0.095, 0.114, 0.152);
    vec3 headCol = mix(headBot, headTop, clamp(hn.y * 0.5 + 0.5, 0.0, 1.0));
    headCol += vec3(0.028, 0.034, 0.046) * (1.0 - hn.x * hn.x);

    // Fine horizontal brushed metal texture
    float grainFade = 1.0 - smoothstep(0.6, 2.2, uWorldPerPixel);
    headCol += vec3(sin(p.y * 3.1) * 0.005 * grainFade);

    // Sleek top chrome architectural trim strip
    float dChrome = sdRoundedBox(
      p - vec2(headCenter.x, FOUNTAIN_TOP_Y - 5.5),
      vec2(headHalf.x - 10.0, 2.6),
      vec4(2.2)
    );
    float chromeMask = aaCoverage(dChrome, aa);
    if (chromeMask > 0.0) {
      float cx = (p.x - headCenter.x) / headHalf.x;
      vec3 chromeCol = mix(vec3(0.42, 0.47, 0.56), vec3(0.82, 0.87, 0.94), exp(-cx * cx * 2.2));
      headCol = mix(headCol, chromeCol, chromeMask * 0.88);
    }

    // Lower fascia metallic seam highlight along FOUNTAIN_BOTTOM_Y
    float botLip = exp(-sq((p.y - (FOUNTAIN_BOTTOM_Y + 2.0)) / 1.4));
    headCol += vec3(0.10, 0.12, 0.16) * botLip;

    // Outer perimeter chamfer catchlight
    float headEdge = exp(-sq((dHead + 1.4) / 1.3));
    headCol += vec3(0.09, 0.11, 0.15) * headEdge;

    // 5 Recessed Dark Bay Slots around dispenser push-pads (BUTTON_CENTER_Y)
    vec2 slotHalf = vec2(BUTTON_W * 0.5 + 3.5, BUTTON_H * 0.5 + 3.5);
    for (int i = 0; i < 5; i++) {
      vec2 slotP = p - vec2(uNozzleX[i], BUTTON_CENTER_Y);
      if (abs(slotP.x) < slotHalf.x + 8.0 && abs(slotP.y) < slotHalf.y + 8.0) {
        float dSlot = sdRoundedBox(slotP, slotHalf, vec4(11.5));
        float slotMask = aaCoverage(dSlot, aa);
        if (slotMask > 0.0) {
          float sy = clamp(slotP.y / slotHalf.y, -1.0, 1.0);
          vec3 bayCol = mix(vec3(0.055, 0.068, 0.096), vec3(0.088, 0.108, 0.148), sy * 0.5 + 0.5);
          // Inset top shadow inside recessed bay
          bayCol *= 1.0 - 0.35 * exp(-max(0.0, slotHalf.y - slotP.y) * 0.25);
          // Subtle inner colored plaque glow
          float act = uNozzleActive[i];
          bayCol += uNozzleGlowColor[i] * (0.04 + 0.16 * act) * (1.0 - 0.4 * abs(sy));
          headCol = mix(headCol, bayCol, slotMask);
        }
        // Beveled slot rim + colored status LED halo
        float rimBand = exp(-sq(dSlot / 1.5));
        float ledIntensity = 0.22 + 0.78 * uNozzleActive[i];
        vec3 rimTint = mix(vec3(0.22, 0.26, 0.34), uNozzleGlowColor[i], ledIntensity * 0.75);
        headCol += rimTint * rimBand * (0.45 + 0.55 * uNozzleActive[i]);
      }
    }

    col = mix(col, clamp(headCol, 0.0, 1.0), headMask);
  }

  // 7. Recessed Stainless-Steel Drip Tray (X: TRAY_LEFT_X..TRAY_RIGHT_X, Y: COUNTER_TOP_Y..TRAY_SURFACE_Y)
  vec2 trayCenter = vec2(0.5 * (TRAY_LEFT_X + TRAY_RIGHT_X), 0.5 * (COUNTER_TOP_Y + TRAY_SURFACE_Y));
  vec2 trayHalf = vec2(0.5 * (TRAY_RIGHT_X - TRAY_LEFT_X), 0.5 * (TRAY_SURFACE_Y - COUNTER_TOP_Y));
  float dTray = sdRoundedBox(p - trayCenter, trayHalf, vec4(3.5, 2.0, 3.5, 2.0));
  float trayMask = aaCoverage(dTray, aa);
  if (trayMask > 0.0) {
    float tx = (p.x - trayCenter.x) / trayHalf.x;
    float ty = clamp((p.y - COUNTER_TOP_Y) / (TRAY_SURFACE_Y - COUNTER_TOP_Y), 0.0, 1.0);

    // Brushed stainless steel frame catching the backlit alcove glow
    vec3 steelSide = vec3(0.38, 0.42, 0.49);
    vec3 steelMid  = vec3(0.70, 0.75, 0.82);
    vec3 trayCol = mix(steelSide, steelMid, exp(-tx * tx * 1.65));
    trayCol *= 0.68 + 0.34 * ty;

    // Bright top bevel deck along TRAY_SURFACE_Y
    float topDeck = smoothstep(TRAY_SURFACE_Y - 3.2, TRAY_SURFACE_Y - 0.6, p.y);
    trayCol += vec3(0.18, 0.20, 0.24) * topDeck;

    // Recessed slotted drainage grate (repeating metallic bars & dark slots)
    vec2 grateCenter = vec2(trayCenter.x, COUNTER_TOP_Y + 7.2);
    vec2 grateHalf = vec2(trayHalf.x - 18.0, 5.0);
    float dGrateWell = sdRoundedBox(p - grateCenter, grateHalf, vec4(2.2));
    float grateWellMask = aaCoverage(dGrateWell, aa);
    if (grateWellMask > 0.0) {
      float period = 11.0;
      float cellX = mod(p.x - (TRAY_LEFT_X + 22.0), period) - 0.5 * period;
      float dSlot = sdRoundedBox(vec2(cellX, p.y - grateCenter.y), vec2(2.4, 3.8), vec4(1.2));
      float slotMask = aaCoverage(dSlot, aa);

      // Stainless bar between slots
      float barTop = smoothstep(grateCenter.y, grateCenter.y + 4.2, p.y);
      vec3 barCol = trayCol * (0.86 + 0.22 * barTop) + vec3(0.10) * exp(-cellX * cellX * 0.12);
      // Dark drainage sump inside slots
      vec3 sumpCol = vec3(0.055, 0.068, 0.092) + ledConeAccum * 0.12;
      vec3 grateCol = mix(barCol, sumpCol, slotMask);
      trayCol = mix(trayCol, grateCol, grateWellMask);
    }

    // Subtle colored reflection on stainless steel from active nozzle LEDs
    trayCol += ledConeAccum * 0.32;

    col = mix(col, clamp(trayCol, 0.0, 1.0), trayMask);
  }

  // 8. Soft Ambient Contact Shadow directly beneath snapshot.glass.x, snapshot.glass.y
  float lift = max(0.0, uGlassPos.y - TRAY_SURFACE_Y);
  float shadowHalfW = (GLASS_BOTTOM_HALF_W + GLASS_WALL_THICKNESS) * (0.96 + lift * 0.0035);
  float shadowDx = (p.x - uGlassPos.x) / max(shadowHalfW, 1.0);
  float shadowDy = (p.y - (TRAY_SURFACE_Y - 1.5)) / (8.5 + lift * 0.08);
  float shadowRadial = shadowDx * shadowDx + shadowDy * shadowDy;
  if (shadowRadial < 2.5 && p.y <= TRAY_SURFACE_Y + 10.0 && p.y >= COUNTER_TOP_Y - 3.0) {
    float shadowFalloff = exp(-shadowRadial * 2.1) * exp(-lift * 0.015);
    float coreContact = exp(-(shadowDx * shadowDx * 3.4 + sq((p.y - (TRAY_SURFACE_Y - 1.0)) / 3.2))) * exp(-lift * 0.045);
    float occlusion = clamp((shadowFalloff * 0.42 + coreContact * 0.36) * (1.0 + 0.12 * uGlassFill), 0.0, 0.72);
    col *= (1.0 - occlusion);
  }

  // Perceptual sub-bit dither to keep 8-bit gradients silky smooth
  float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  FRAG_COLOR = vec4(clamp(col + dither, 0.0, 1.0), 1.0);
}
`;

  // ============================================================================
  // PASS 2: Velocity-Stretched Per-Particle Optical Splatting (ONE, ONE)
  // ============================================================================
  const particleSplatVert = `${vertHeader}
uniform vec4 uViewBounds;
uniform float uSplatWriteScale;
uniform float uPixelsPerWorld;

ATTR vec2 aCorner;
ATTR vec4 aPosVel;
ATTR vec4 aAbsFizz;

VARYING vec2 vLocal;
VARYING vec3 vAbsRGB;
VARYING float vWeight;

void main() {
  vec2 pos = aPosVel.xy;
  vec2 vel = aPosVel.zw;
  float speed = length(vel);

  // Align billboard along (vx, vy) so fast falling stream droplets form a silky continuous ribbon
  vec2 dir = (speed > 1.0) ? (vel / speed) : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);

  float streamStretch = smoothstep(42.0, 320.0, speed);
  float baseRadius = 16.8;
  float rAlong = baseRadius + 12.5 * streamStretch;
  float rPerp  = mix(baseRadius, 11.5, streamStretch);

  vec2 worldPos = pos + dir * (aCorner.y * rAlong) + perp * (aCorner.x * rPerp);

  vec2 ndc = vec2(
    ((worldPos.x - uViewBounds.x) / (uViewBounds.y - uViewBounds.x)) * 2.0 - 1.0,
    ((worldPos.y - uViewBounds.z) / (uViewBounds.w - uViewBounds.z)) * 2.0 - 1.0
  );

  vLocal = aCorner;
  vAbsRGB = aAbsFizz.rgb;

  // Normalize kernel weight so pooled glass interior hits optical depth ~1.4..1.85
  // while faster falling streams & splash droplets remain crisp and continuous above D=0.34
  float particleWeight = mix(0.255, 0.44, smoothstep(40.0, 220.0, speed));
  vWeight = particleWeight * uSplatWriteScale;

  gl_PointSize = baseRadius * 2.0 * uPixelsPerWorld;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

  const particleSplatFrag = `${fragHeader}
VARYING vec2 vLocal;
VARYING vec3 vAbsRGB;
VARYING float vWeight;

void main() {
  float r2 = dot(vLocal, vLocal);
  float m = max(0.0, 1.0 - r2);
  // Exact pow(max(0.0, 1.0 - r2), 2.5) without undefined pow(0.0, 2.5) behavior
  float w = m * m * sqrt(m);
  float wk = w * vWeight;
  FRAG_COLOR = vec4(vAbsRGB * wk, wk);
}
`;

  // ============================================================================
  // PASS 3: 9-Tap Separable Gaussian Blur (~3.8 World Units Radius)
  // ============================================================================
  const blurFrag = `${fragHeader}
uniform sampler2D uInputTex;
uniform vec2 uBlurStep;

VARYING vec2 vUv;
VARYING vec2 vWorldPos;

void main() {
  vec4 acc = TEX2D(uInputTex, vUv) * 0.204164;
  acc += (TEX2D(uInputTex, vUv + uBlurStep * 1.0) + TEX2D(uInputTex, vUv - uBlurStep * 1.0)) * 0.180174;
  acc += (TEX2D(uInputTex, vUv + uBlurStep * 2.0) + TEX2D(uInputTex, vUv - uBlurStep * 2.0)) * 0.123832;
  acc += (TEX2D(uInputTex, vUv + uBlurStep * 3.0) + TEX2D(uInputTex, vUv - uBlurStep * 3.0)) * 0.066282;
  acc += (TEX2D(uInputTex, vUv + uBlurStep * 4.0) + TEX2D(uInputTex, vUv - uBlurStep * 4.0)) * 0.027630;
  FRAG_COLOR = acc;
}
`;

  // ============================================================================
  // PASS 4A: Beer-Lambert Liquid Shading + Specular Meniscus + Fizz Foam
  // ============================================================================
  const liquidShadeFrag = `${fragHeader}
${SCENE_CONSTANTS_GLSL}
${COLOR_SPACE_GLSL}

uniform sampler2D uBgTex;
uniform sampler2D uSplatTex;
uniform float uSplatReadScale;
uniform vec2 uNormalStepUv;
uniform vec2 uWorldToUv;
uniform vec2 uGlassPos;
uniform float uGlassTilt;
uniform float uFoamCarbonation;
uniform float uTime;

VARYING vec2 vUv;
VARYING vec2 vWorldPos;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fPart = fract(p);
  vec2 u = fPart * fPart * (3.0 - 2.0 * fPart);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec4 splat = TEX2D(uSplatTex, vUv) * uSplatReadScale;
  float D = splat.a;
  vec3 bgRawSrgb = TEX2D(uBgTex, vUv).rgb;

  if (D < 0.08) {
    FRAG_COLOR = vec4(bgRawSrgb, 1.0);
    return;
  }

  // Local glass coordinates for capillary wall/floor wetting & meniscus foam
  vec2 relG = vWorldPos - uGlassPos;
  float ct = cos(uGlassTilt);
  float st = sin(uGlassTilt);
  vec2 gLocal = vec2(relG.x * ct + relG.y * st, -relG.x * st + relG.y * ct);

  float hFrac = clamp((gLocal.y - GLASS_BASE_THICKNESS) / GLASS_INNER_HEIGHT, 0.0, 1.0);
  float innerHalfW = mix(GLASS_BOTTOM_HALF_W, GLASS_TOP_HALF_W, hFrac);

  // Capillary wetting: pooled liquid hugs the inner crystal walls & floor with zero air gap
  if (
    gLocal.y >= GLASS_BASE_THICKNESS - 1.5 &&
    gLocal.y <= GLASS_TOTAL_H - 1.0 &&
    abs(gLocal.x) <= innerHalfW + 1.2
  ) {
    float wallGap = innerHalfW - abs(gLocal.x);
    float floorGap = gLocal.y - GLASS_BASE_THICKNESS;
    float nearFluid = smoothstep(0.13, 0.25, D);
    float wallWet = smoothstep(6.8, -0.5, wallGap) * nearFluid * 0.19;
    float floorWet = smoothstep(5.8, -0.5, floorGap) * nearFluid * 0.19;
    D += max(wallWet, floorWet);
  }

  // 3D liquid surface normal & screen-space gradient magnitude for razor-crisp wet edge AA
  float dR = TEX2D(uSplatTex, vUv + vec2(uNormalStepUv.x, 0.0)).a * uSplatReadScale;
  float dL = TEX2D(uSplatTex, vUv - vec2(uNormalStepUv.x, 0.0)).a * uSplatReadScale;
  float dU = TEX2D(uSplatTex, vUv + vec2(0.0, uNormalStepUv.y)).a * uSplatReadScale;
  float dD = TEX2D(uSplatTex, vUv - vec2(0.0, uNormalStepUv.y)).a * uSplatReadScale;

  float dDx = (dR - dL) * 0.5;
  float dDy = (dU - dD) * 0.5;
  float gradMag = length(vec2(dDx, dDy));
  float edgeAa = clamp(gradMag * 0.85, 0.009, 0.030);

  float coverage = smoothstep(0.30 - edgeAa, 0.30 + edgeAa, D);
  if (coverage <= 0.001) {
    FRAG_COLOR = vec4(bgRawSrgb, 1.0);
    return;
  }

  vec3 N = normalize(vec3(-dDx, -dDy, 0.35));

  // Subtle background refraction through curved liquid surface
  vec2 bgRefractUv = clamp(vUv - N.xy * 2.8 * uWorldToUv, vec2(0.001), vec2(0.999));
  vec3 bgBehindSrgb = TEX2D(uBgTex, bgRefractUv).rgb;
  vec3 bgBehind = srgbToLinear(bgBehindSrgb);

  // Per-pixel effective Beer-Lambert optical absorption (preserves multi-drink swirls & marbling!)
  vec3 absSumRGB = max(splat.rgb, vec3(0.0));
  vec3 meanAbs = absSumRGB / max(splat.a, 0.001);
  vec3 sigma = meanAbs * clamp(D * 0.95, 0.35, 1.85);

  // Beer-Lambert spectral transmittance + jewel-like subsurface scatter boost
  vec3 transmitted = bgBehind * exp(-sigma);
  vec3 scatter = 0.10 * exp(-sigma * 0.55) * (1.0 - exp(-D));
  vec3 liquidLin = transmitted + scatter;

  // Directional studio specular highlights + Fresnel rim sheen
  vec3 lightDir = normalize(vec3(-0.36, 0.62, 0.70));
  vec3 fillDir  = normalize(vec3(0.34, 0.52, 0.78));
  float specPrimary = pow(max(dot(N, lightDir), 1e-4), 42.0) * 0.55;
  float specFill    = pow(max(dot(N, fillDir), 1e-4), 28.0) * 0.14;
  float oneMinusNz  = 1.0 - clamp(N.z, 0.0, 1.0);
  float fresnel     = oneMinusNz * oneMinusNz * oneMinusNz;
  vec3 rimTint      = mix(exp(-sigma * 0.35), vec3(1.0), 0.62);

  liquidLin += vec3(specPrimary + specFill) + rimTint * fresnel * 0.18;

  // Delicate creamy-white carbonation fizz/foam meniscus along upward-facing free surfaces
  // (N.y > 0.45 inside the glass horizontal span when liquid is present)

  if (
    uFoamCarbonation > 0.02 &&
    N.y > 0.45 &&
    gLocal.y > GLASS_BASE_THICKNESS + 5.0 &&
    gLocal.y < GLASS_TOTAL_H + 6.0 &&
    abs(gLocal.x) < innerHalfW + 3.0
  ) {
    float upFacing = smoothstep(0.45, 0.74, N.y);
    float inSpan = 1.0 - smoothstep(innerHalfW - 2.0, innerHalfW + 3.0, abs(gLocal.x));
    // Meniscus climbs slightly higher right against the left/right glass walls
    float wallMeniscus = 1.0 + 0.48 * smoothstep(innerHalfW - 18.0, innerHalfW, abs(gLocal.x));
    float surfaceBand = (1.0 - smoothstep(0.32, 0.92 * wallMeniscus, D)) * smoothstep(0.24, 0.34, D);

    // Fine sparkling micro-bubble foam texture
    vec2 foamCoord = gLocal * vec2(0.32, 0.48) + vec2(sin(uTime * 0.7) * 0.4, -uTime * 1.4);
    float microFizz = 0.72 + 0.28 * valueNoise(foamCoord);
    float foamAmount = clamp(upFacing * inSpan * surfaceBand * uFoamCarbonation * microFizz * 1.15, 0.0, 0.88);

    // Creamy white foam subtly kissed by the soda's bright transmitted hue
    vec3 drinkTint = exp(-meanAbs * 0.16);
    vec3 foamColorLin = mix(drinkTint, vec3(0.96, 0.96, 0.95), 0.86);
    liquidLin = mix(liquidLin, foamColorLin, foamAmount);
  }

  vec3 liquidSrgb = linearToSrgb(liquidLin);
  vec3 finalSrgb = mix(bgRawSrgb, liquidSrgb, coverage);
  FRAG_COLOR = vec4(finalSrgb, 1.0);
}
`;

  // ============================================================================
  // PASS 4B: Sparkling Refractive Carbonation Bubbles (Clipped Inside D > 0.32)
  // ============================================================================
  const bubbleVert = `${vertHeader}
uniform vec4 uViewBounds;
uniform float uPixelsPerWorld;

ATTR vec2 aCorner;
ATTR vec4 aBubble; // [x, y, radius, alpha]

VARYING vec2 vLocal;
VARYING vec2 vUv;
VARYING float vAlpha;

void main() {
  vec2 center = aBubble.xy;
  float radius = max(aBubble.z, 1.1);
  float pad = 1.35;
  vec2 worldPos = center + aCorner * (radius * pad);

  vec2 uv = vec2(
    (worldPos.x - uViewBounds.x) / (uViewBounds.y - uViewBounds.x),
    (worldPos.y - uViewBounds.z) / (uViewBounds.w - uViewBounds.z)
  );

  vLocal = aCorner * pad;
  vUv = uv;
  vAlpha = clamp(aBubble.w, 0.0, 1.0);

  gl_PointSize = radius * 2.0 * pad * uPixelsPerWorld;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

  const bubbleFrag = `${fragHeader}
uniform sampler2D uSplatTex;
uniform float uSplatReadScale;

VARYING vec2 vLocal;
VARYING vec2 vUv;
VARYING float vAlpha;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 1.12) {
    discard;
  }

  // Strictly clip bubbles inside the liquid body (D > 0.32)
  float D = TEX2D(uSplatTex, vUv).a * uSplatReadScale;
  float inLiquid = smoothstep(0.32, 0.40, D);
  if (inLiquid <= 0.005) {
    discard;
  }

  float r = sqrt(max(r2, 0.0));
  // Crisp thin refractive bubble ring + pinpoint studio specular glint
  float outerAa = 1.0 - smoothstep(0.92, 1.06, r);
  float ring = smoothstep(0.48, 0.86, r) * outerAa;

  vec2 glintPos = vLocal - vec2(-0.32, 0.35);
  float glint = exp(-dot(glintPos, glintPos) * 14.0) * outerAa;

  vec2 crescentPos = vLocal - vec2(0.28, -0.30);
  float lowerCaustic = exp(-dot(crescentPos, crescentPos) * 7.5) * ring * 0.45;

  float alpha = clamp((ring * 0.62 + glint * 0.90 + lowerCaustic + outerAa * 0.08) * vAlpha * inLiquid, 0.0, 0.92);
  vec3 bubbleCol = vec3(0.95, 0.98, 1.0);
  FRAG_COLOR = vec4(bubbleCol, alpha);
}
`;

  // ============================================================================
  // PASS 5: Refractive Tapered Crystal Tumbler Glass Composite (Default FBO)
  // ============================================================================
  const glassCompositeFrag = `${fragHeader}
${SCENE_CONSTANTS_GLSL}

uniform sampler2D uSceneTex;
uniform vec2 uGlassPos;
uniform float uGlassTilt;
uniform float uGlassHighlight;
uniform float uWorldPerPixel;
uniform vec2 uWorldToUv;

VARYING vec2 vUv;
VARYING vec2 vWorldPos;

// Exact anti-aliased signed distance to a symmetric vertical tapered tumbler [y0..y1]
float sdTaperedTumbler(vec2 p, float y0, float y1, float halfW0, float halfW1, float cornerR) {
  float h = y1 - y0;
  float cy = 0.5 * (y0 + y1);
  vec2 q = vec2(abs(p.x), p.y - cy);
  float halfH = 0.5 * h - cornerR;
  float t = clamp((p.y - y0) / max(h, 0.001), 0.0, 1.0);
  float halfWAtY = mix(halfW0, halfW1, t) - cornerR;

  // Account for wall slope (~0.10) for true Euclidean wall distance
  float slope = (halfW1 - halfW0) / max(h, 0.001);
  float wallCos = inversesqrt(1.0 + slope * slope);
  float dx = (q.x - halfWAtY) * wallCos;
  float dy = abs(q.y) - halfH;

  vec2 d = vec2(dx, dy);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - cornerR;
}

void main() {
  vec3 rawScene = TEX2D(uSceneTex, vUv).rgb;

  // Transform worldPos into glass-local coordinates (origin at outer-bottom center)
  vec2 rel = vWorldPos - uGlassPos;
  float ct = cos(uGlassTilt);
  float st = sin(uGlassTilt);
  vec2 g = vec2(rel.x * ct + rel.y * st, -rel.x * st + rel.y * ct);

  // Fast bounding-box reject outside the glass tumbler
  float maxOuterW = GLASS_TOP_HALF_W + GLASS_WALL_THICKNESS + 8.0;
  if (abs(g.x) > maxOuterW || g.y < -6.0 || g.y > GLASS_TOTAL_H + 8.0) {
    FRAG_COLOR = vec4(rawScene, 1.0);
    return;
  }

  float aa = max(uWorldPerPixel * 1.15, 0.25);

  // Outer crystal tumbler geometry (tapers along the same slope from foot to rim)
  float wallSlope = (GLASS_TOP_HALF_W - GLASS_BOTTOM_HALF_W) / GLASS_INNER_HEIGHT;
  float outerBottomHalfW = (GLASS_BOTTOM_HALF_W + GLASS_WALL_THICKNESS) - wallSlope * GLASS_BASE_THICKNESS;
  float outerTopHalfW = GLASS_TOP_HALF_W + GLASS_WALL_THICKNESS;

  float dOuter = sdTaperedTumbler(g, 0.0, GLASS_TOTAL_H, outerBottomHalfW, outerTopHalfW, 4.2);
  float glassMask = 1.0 - smoothstep(-aa, aa, dOuter);

  if (glassMask <= 0.001) {
    FRAG_COLOR = vec4(rawScene, 1.0);
    return;
  }

  // Inner cavity SDF (starts at GLASS_BASE_THICKNESS, extends past top opening so top rim is open!)
  float dCavity = sdTaperedTumbler(
    g,
    GLASS_BASE_THICKNESS,
    GLASS_TOTAL_H + 18.0,
    GLASS_BOTTOM_HALF_W,
    GLASS_TOP_HALF_W + wallSlope * 18.0,
    7.0
  );
  float cavityMask = 1.0 - smoothstep(-aa * 1.2, aa * 1.2, dCavity);
  float solidCrystalMask = glassMask * (1.0 - cavityMask);

  // Local width fractions at height g.y
  float tOuter = clamp(g.y / GLASS_TOTAL_H, 0.0, 1.0);
  float curOuterHalfW = mix(outerBottomHalfW, outerTopHalfW, tOuter);
  float tInner = clamp((g.y - GLASS_BASE_THICKNESS) / GLASS_INNER_HEIGHT, 0.0, 1.0);
  float curInnerHalfW = mix(GLASS_BOTTOM_HALF_W, GLASS_TOP_HALF_W, tInner);

  float uNorm = clamp(g.x / max(curOuterHalfW, 1.0), -1.0, 1.0);
  float absU = abs(uNorm);
  float sideSign = (g.x >= 0.0) ? 1.0 : -1.0;

  // 1. Optical Refraction Offset in Glass-Local Space (world units)
  vec2 refractLocal = vec2(0.0);

  // Subtle cylindrical lens curvature across the main front/back glass face
  refractLocal.x += -uNorm * (1.8 + 3.4 * absU * absU) * cavityMask;

  // Strong horizontal cylindrical prism refraction through left & right GLASS_WALL_THICKNESS walls
  float wallFrac = clamp((abs(g.x) - curInnerHalfW) / max(GLASS_WALL_THICKNESS, 1.0), 0.0, 1.0);
  float isSideWall = smoothstep(GLASS_BASE_THICKNESS - 4.0, GLASS_BASE_THICKNESS + 6.0, g.y) * solidCrystalMask;
  float wallLens = sin(wallFrac * 3.14159265) * 14.5 + wallFrac * wallFrac * 6.5;
  refractLocal.x += -sideSign * wallLens * isSideWall;

  // Heavy crystal sham base (GLASS_BASE_THICKNESS) vertical + horizontal optical refraction
  float isBase = (1.0 - smoothstep(GLASS_BASE_THICKNESS - 2.0, GLASS_BASE_THICKNESS + 7.0, g.y)) * solidCrystalMask;
  float baseVertProfile = sin(clamp(g.y / GLASS_BASE_THICKNESS, 0.0, 1.0) * 3.14159265);
  refractLocal.y += (8.5 * baseVertProfile + 4.0) * isBase;
  refractLocal.x += -uNorm * 10.5 * isBase;

  // Rotate local refraction vector back to world space and convert to UV offset
  vec2 refractWorld = vec2(
    refractLocal.x * ct - refractLocal.y * st,
    refractLocal.x * st + refractLocal.y * ct
  );
  vec2 uvOffset = refractWorld * uWorldToUv;

  // Subtle flint-crystal chromatic dispersion inside the thick side walls & heavy base
  float dispersion = 0.11 * solidCrystalMask;
  vec2 uvR = clamp(vUv + uvOffset * (1.0 + dispersion), vec2(0.001), vec2(0.999));
  vec2 uvG = clamp(vUv + uvOffset, vec2(0.001), vec2(0.999));
  vec2 uvB = clamp(vUv + uvOffset * (1.0 - dispersion), vec2(0.001), vec2(0.999));

  vec3 glassCol = vec3(
    TEX2D(uSceneTex, uvR).r,
    TEX2D(uSceneTex, uvG).g,
    TEX2D(uSceneTex, uvB).b
  );

  // Subtle crystal glass body clarity tint & physical total-internal-reflection (TIR) grazing edge contrast
  glassCol = mix(glassCol, glassCol * vec3(0.90, 0.95, 1.0) + vec3(0.018, 0.028, 0.042), solidCrystalMask * 0.48);
  float outerTirEdge = exp(-sq((dOuter + 1.1) / 1.15));
  float innerTirEdge = exp(-sq(dCavity / 1.15)) *
                       smoothstep(GLASS_BASE_THICKNESS - 2.0, GLASS_BASE_THICKNESS + 4.0, g.y) *
                       (1.0 - smoothstep(GLASS_TOTAL_H - 3.0, GLASS_TOTAL_H, g.y));
  glassCol *= 1.0 - 0.22 * outerTirEdge - 0.14 * innerTirEdge;

  // Internal bevel meniscus line along top of the heavy crystal sham base (y ~ GLASS_BASE_THICKNESS)
  float baseMeniscus = exp(-sq((g.y - GLASS_BASE_THICKNESS) / 1.55)) *
                       (1.0 - smoothstep(0.76, 0.97, absU));
  float footGleam = exp(-sq((g.y - 2.2) / 1.2)) * (1.0 - smoothstep(0.65, 0.96, absU));
  glassCol += vec3(0.26, 0.30, 0.36) * baseMeniscus * (1.0 - 0.35 * glassCol)
            + vec3(0.18, 0.21, 0.26) * footGleam;

  // 2. Crisp Cylindrical Vertical Studio Softbox Specular Streaks (Left & Right Curvature)
  float heightFade = smoothstep(2.0, 16.0, g.y) * (1.0 - 0.15 * smoothstep(GLASS_TOTAL_H - 10.0, GLASS_TOTAL_H, g.y));
  float leftSoftbox    = exp(-sq((uNorm + 0.76) / 0.055)) * 0.22 * heightFade;
  float leftSharp      = exp(-sq((uNorm + 0.885) / 0.019)) * 0.44 * heightFade;
  float rightRimStreak = exp(-sq((uNorm - 0.855) / 0.030)) * 0.34 * heightFade;
  float rightInner     = exp(-sq((uNorm - 0.72) / 0.045)) * 0.10 * heightFade;

  float softSpec = leftSoftbox + rightInner;
  float crispSpec = leftSharp + rightRimStreak;
  glassCol += vec3(0.92, 0.96, 1.0) * softSpec * (1.0 - 0.48 * glassCol);
  glassCol += vec3(0.96, 0.99, 1.0) * crispSpec;

  // 3. Fire-Polished Top Glass Rim Highlight Line (crisp dark-light crystal lip)
  float rimSubLine = exp(-sq((g.y - (GLASS_TOTAL_H - 3.0)) / 1.1));
  glassCol *= 1.0 - 0.15 * rimSubLine * (0.4 + 0.6 * absU);
  float rimYBand = exp(-sq((g.y - (GLASS_TOTAL_H - 1.2)) / 1.05));
  float rimProfile = 0.34 + 0.46 * pow(max(absU, 1e-4), 1.4);
  float topRim = rimYBand * rimProfile;
  glassCol += vec3(0.96, 0.99, 1.0) * topRim;

  // 4. Tasteful Subtle Rim Brightening on glassHovered || glass.isDragging
  if (uGlassHighlight > 0.001) {
    float outerEdgeBand = exp(-sq((dOuter + 1.3) / 1.35));
    vec3 hoverTint = vec3(0.72, 0.88, 1.0);
    glassCol += hoverTint * uGlassHighlight * (outerEdgeBand * 0.24 + topRim * 0.22);
  }

  vec3 outCol = mix(rawScene, clamp(glassCol, 0.0, 1.0), glassMask);
  FRAG_COLOR = vec4(outCol, 1.0);
}
`;

  return {
    studioBg: { vert: fullscreenVert, frag: studioBgFrag },
    particleSplat: { vert: particleSplatVert, frag: particleSplatFrag },
    blur: { vert: fullscreenVert, frag: blurFrag },
    liquidShade: { vert: fullscreenVert, frag: liquidShadeFrag },
    bubble: { vert: bubbleVert, frag: bubbleFrag },
    glassComposite: { vert: fullscreenVert, frag: glassCompositeFrag },
  };
}
