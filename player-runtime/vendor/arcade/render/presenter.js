// A final presentation pass for games that render a small, stable source
// image and want it enlarged without surrendering ownership of their pixels.
//
// The WebGL2 path keeps the effects on the GPU. The 2d path is deliberately
// useful rather than decorative: it preserves nearest-neighbour scaling and
// builds a reusable effect mask only when the viewport or filter changes.
//
// Four of the filters are the modest ones that survived use in Abuse. The
// fifth, `crt`, is the tube shader Abuse wrote first and then took out on
// visual feedback: beam-profile scanlines, halation, convergence, a grille,
// speckle, curvature and a tube mask. It is here as an opt-in, scaled by one
// amount, and it is never the default -- it decides how a game looks, which is
// the game's call.

import { createDisplay } from "../platform/display.js";
import { browserCanvas, context2d } from "./canvas.js";

// In shader order: a name's index here is the value `pixelFilter` takes.
const PIXEL_FILTER_INDEX = ["none", "source-scanlines", "display-scanlines", "lcd-grid", "crt"];
const PIXEL_FILTERS = new Set(PIXEL_FILTER_INDEX);
const PIXEL_BACKENDS = new Set(["auto", "webgl2", "canvas2d"]);

/** @typedef {"none"|"source-scanlines"|"display-scanlines"|"lcd-grid"|"crt"} PixelFilterName */
/** @typedef {"auto"|"webgl2"|"canvas2d"} PixelBackendRequest */
/**
 * @typedef {object} PixelSettings
 * @property {number} width
 * @property {number} height
 * @property {number} pixelAspect
 * @property {"letterbox"|"stretch"} mode
 * @property {"fit"|"integer"} scaleMode
 * @property {PixelBackendRequest} backend
 * @property {PixelFilterName} filter
 * @property {number} lineBrightness
 * @property {number} bandRows
 * @property {number} gridThickness
 * @property {number} crtAmount
 * @property {number} crtGlow
 * @property {number} crtNoise
 * @property {readonly [number, number, number, number]} clearColor
 */

const PIXEL_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 pixelUv;
const vec2 pixelPositions[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
void main() {
  vec2 position = pixelPositions[gl_VertexID];
  pixelUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const PIXEL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D pixelFrame;
uniform vec2 pixelSourceSize;
uniform vec2 pixelViewportOrigin;
uniform int pixelFilter;
uniform float pixelLineBrightness;
uniform float pixelBandRows;
uniform float pixelGridThickness;
uniform float pixelTime;
uniform float pixelCrtAmount;
uniform float pixelCrtGlow;
uniform float pixelCrtNoise;
in vec2 pixelUv;
out vec4 pixelColor;

const float CRT_GAMMA = 2.2;

// The source, nearest-neighbour, in top-down texture space. Black past the
// edge, so the curvature has something to bend the picture into.
vec4 crtSample(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(pixelFrame, uv);
}
vec3 crtLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(CRT_GAMMA)); }
vec3 crtEncode(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / CRT_GAMMA)); }
float crtLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// Dave Hoskins' hash33: stable across GPUs, unlike the large-sine tricks.
vec3 crtHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Abuse's tube, on a true-colour source. Beam and glow are composited in
// linear light, which keeps the halation luminous instead of milky. Every
// stage scales with the amount, so 0 is the raw nearest-neighbour picture and
// 1 the full tube.
vec4 crt(vec2 uv) {
  float amount = pixelCrtAmount;
  vec2 centre = uv - 0.5;

  // Barrel curvature, subtle, measured in source pixels.
  vec2 warped = uv + centre * dot(centre, centre) * (0.035 * amount) * vec2(2.0, 2.4);
  vec4 raw = crtSample(uv);

  // Beam profile. The two nearest source rows each light a gaussian beam
  // whose width follows that row's brightness: bright rows bleed and nearly
  // close the gap, dark rows thin out. The peak stays at 1, so brights bloom
  // where beams overlap and mids show the line structure, as a tube does.
  vec2 sourcePosition = warped * pixelSourceSize;
  float rowPosition = sourcePosition.y - 0.5;
  float firstRow = floor(rowPosition);
  float rowFraction = rowPosition - firstRow;
  float convergence = 0.55 * amount / pixelSourceSize.x;
  float spot = 0.36 / pixelSourceSize.x;

  vec3 color = vec3(0.0);
  for (int i = 0; i <= 1; i++) {
    float v = (firstRow + float(i) + 0.5) / pixelSourceSize.y;
    // The horizontal phosphor spot softens the harshest pixel steps and keeps the chunk.
    vec3 beam = crtLinear(crtSample(vec2(warped.x, v)).rgb) * 0.68
              + crtLinear(crtSample(vec2(warped.x - spot, v)).rgb) * 0.16
              + crtLinear(crtSample(vec2(warped.x + spot, v)).rgb) * 0.16;
    // Convergence error: red and blue sampled slightly off-axis, inside the beam.
    beam.r = mix(beam.r, crtLinear(crtSample(vec2(warped.x + convergence, v)).rgb).r, 0.55 * amount);
    beam.b = mix(beam.b, crtLinear(crtSample(vec2(warped.x - convergence, v)).rgb).b, 0.55 * amount);
    float width = mix(0.32, 0.72, crtLuma(crtEncode(beam)));
    float offset = abs(float(i) - rowFraction);
    color += beam * exp(-(offset * offset) / (2.0 * width * width));
  }
  color *= 0.94;

  // Phosphor halation: a wide, luma-weighted glow gathered from the small source.
  float glow = pixelCrtGlow * amount;
  if (glow > 0.001) {
    vec3 gathered = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float angle = float(i) * (6.2831853 / 12.0);
      float radius = (i % 2 == 0) ? 1.3 : 2.7;
      vec3 s = crtLinear(crtSample(warped + vec2(cos(angle), sin(angle)) * radius / pixelSourceSize).rgb);
      gathered += s * crtLuma(crtEncode(s));
    }
    color += gathered * (0.14 * glow / 12.0);
  }

  // Aperture grille, locked to source-pixel triads.
  float phase = fract(sourcePosition.x) * 3.0;
  vec3 grille = phase < 1.0 ? vec3(1.05, 0.93, 0.93) : phase < 2.0 ? vec3(0.93, 1.05, 0.93) : vec3(0.93, 0.93, 1.05);
  color *= mix(vec3(1.0), grille, 0.5 * amount);

  // Analog speckle that rides the luminance, so true blacks stay black.
  float speckleAmount = pixelCrtNoise * amount;
  if (speckleAmount > 0.001) {
    vec3 speckle = crtHash(vec3(sourcePosition, floor(pixelTime * 60.0))) - 0.5;
    float visibility = 0.06 + 0.94 * crtLuma(crtEncode(color));
    color += (crtLinear(vec3(0.5) + speckle * 0.20 * speckleAmount) - crtLinear(vec3(0.5))) * visibility;
  }

  // Rolling band, vignette, mains flicker.
  float bandY = mod(pixelTime * 12.0, pixelSourceSize.y + 60.0) - 30.0;
  color += vec3(0.02 * amount * max(1.0 - abs(sourcePosition.y - bandY) / 30.0, 0.0));
  float vignette = smoothstep(0.55, 1.05, length(centre * vec2(1.0, 1.25)) * 1.5);
  color *= 1.0 - vignette * 0.32 * amount;
  color *= 1.0 - amount * (0.02 * sin(pixelTime * 87.0) + 0.01 * sin(pixelTime * 311.0) + 0.015);

  // Rounded tube mask. Alpha follows it, so the corners show the clear colour.
  vec2 corner = abs(centre * 2.0) - vec2(0.985, 0.975);
  float tube = 1.0 - smoothstep(-0.004, 0.004, length(max(corner, 0.0)) - 0.02) * amount;
  color *= tube;

  // A slight brightness and contrast trim so the additive passes do not grey out.
  vec3 mixed = mix(raw.rgb, crtEncode(color), amount);
  mixed = (mixed - 0.5) * (1.0 + 0.10 * amount) + 0.5 + 0.01 * amount;
  return vec4(clamp(mixed, 0.0, 1.0), raw.a * tube);
}

void main() {
  if (pixelFilter == 4) {
    pixelColor = crt(vec2(pixelUv.x, 1.0 - pixelUv.y));
    return;
  }

  vec2 sourcePosition = vec2(
    pixelUv.x * pixelSourceSize.x,
    (1.0 - pixelUv.y) * pixelSourceSize.y
  );
  vec4 color = texture(pixelFrame, vec2(pixelUv.x, 1.0 - pixelUv.y));
  float shade = 1.0;

  if (pixelFilter == 1) {
    float row = min(floor(sourcePosition.y), pixelSourceSize.y - 1.0);
    if (mod(floor(row / pixelBandRows), 2.0) >= 1.0) shade = pixelLineBrightness;
  } else if (pixelFilter == 2) {
    float row = floor((gl_FragCoord.y - pixelViewportOrigin.y) / pixelBandRows);
    if (mod(row, 2.0) >= 1.0) shade = pixelLineBrightness;
  } else if (pixelFilter == 3) {
    vec2 cell = fract(sourcePosition);
    vec2 edgeDistance = min(cell, 1.0 - cell) / max(fwidth(sourcePosition), vec2(0.0001));
    if (min(edgeDistance.x, edgeDistance.y) <= pixelGridThickness) shade = pixelLineBrightness;
  }

  pixelColor = vec4(color.rgb * shade, color.a);
}`;

/** @param {unknown} value @param {string} name @returns {number} */
function pixelPositiveInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

/** @param {unknown} value @param {string} name @param {number} fallback @returns {number} */
function pixelFinite(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

/** @param {unknown} value @returns {readonly [number, number, number, number]} */
function pixelClearColor(value) {
  if (value === undefined) return Object.freeze([0, 0, 0, 1]);
  if (!Array.isArray(value) || value.length !== 4) throw new Error("clearColor must be [red, green, blue, alpha].");
  const parts = value.map((part, index) => {
    const number = pixelFinite(part, `clearColor[${index}]`, 0);
    return Math.max(0, Math.min(1, number));
  });
  return Object.freeze(/** @type {[number, number, number, number]} */ (parts));
}

/** @param {any} options @returns {PixelSettings} */
function pixelInitialSettings(options) {
  const width = pixelPositiveInteger(options.width, "width");
  const height = pixelPositiveInteger(options.height, "height");
  const pixelAspect = pixelFinite(options.pixelAspect, "pixelAspect", 1);
  if (pixelAspect <= 0) throw new Error("pixelAspect must be greater than zero.");
  const mode = options.mode ?? "letterbox";
  if (mode !== "letterbox" && mode !== "stretch") throw new Error(`Unknown presenter mode "${mode}".`);
  const scaleMode = options.scaleMode ?? "integer";
  if (scaleMode !== "fit" && scaleMode !== "integer") throw new Error(`Unknown presenter scale mode "${scaleMode}".`);
  const backend = options.backend ?? "auto";
  if (!PIXEL_BACKENDS.has(backend)) throw new Error(`Unknown presenter backend "${backend}".`);

  return {
    width,
    height,
    pixelAspect,
    mode,
    scaleMode,
    backend,
    filter: pixelFilter(options.filter ?? "none"),
    lineBrightness: pixelUnit(options.lineBrightness, "lineBrightness", 0.72),
    bandRows: Math.max(1, Math.floor(pixelFinite(options.bandRows, "bandRows", 1))),
    gridThickness: Math.max(0, pixelFinite(options.gridThickness, "gridThickness", 1)),
    // Abuse's tuned defaults: the full tube, full halation, a quarter of the speckle.
    crtAmount: pixelUnit(options.crtAmount, "crtAmount", 1),
    crtGlow: pixelUnit(options.crtGlow, "crtGlow", 1),
    crtNoise: pixelUnit(options.crtNoise, "crtNoise", 0.25),
    clearColor: pixelClearColor(options.clearColor),
  };
}

/** @param {unknown} value @returns {PixelFilterName} */
function pixelFilter(value) {
  if (typeof value !== "string" || !PIXEL_FILTERS.has(value)) throw new Error(`Unknown pixel filter "${value}".`);
  return /** @type {PixelFilterName} */ (value);
}

/** @param {unknown} value @param {string} name @param {number} fallback @returns {number} */
function pixelUnit(value, name, fallback) {
  return Math.max(0, Math.min(1, pixelFinite(value, name, fallback)));
}

/** @param {PixelSettings} value @returns {Readonly<PixelSettings>} */
function pixelPublicSettings(value) {
  const clearColor = Object.freeze(/** @type {[number, number, number, number]} */ ([...value.clearColor]));
  return Object.freeze({ ...value, clearColor });
}

/** @param {WebGL2RenderingContext} gl @param {number} type @param {string} source */
function pixelCompileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("The WebGL2 presenter could not allocate a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`The WebGL2 presenter shader did not compile: ${message}`);
  }
  return shader;
}

/** @param {WebGL2RenderingContext} gl */
function pixelCreateProgram(gl) {
  const vertex = pixelCompileShader(gl, gl.VERTEX_SHADER, PIXEL_VERTEX_SHADER);
  let fragment = null;
  let program = null;
  try {
    fragment = pixelCompileShader(gl, gl.FRAGMENT_SHADER, PIXEL_FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error("The WebGL2 presenter could not allocate a program.");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "unknown link error";
      throw new Error(`The WebGL2 presenter program did not link: ${message}`);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

/** @param {any} source @param {number} width @param {number} height */
function pixelSource(source, width, height) {
  if (!source) throw new Error("present needs a canvas, image, video, bitmap, or RGBA buffer.");
  if (ArrayBuffer.isView(source.data)) {
    if (source.width !== width || source.height !== height) {
      throw new Error(`The RGBA source must be ${width}x${height}; received ${source.width}x${source.height}.`);
    }
    if (source.data.byteLength !== width * height * 4) {
      throw new Error(`The RGBA source must contain exactly ${width * height * 4} bytes.`);
    }
    return { kind: "rgba", value: source.data, width, height };
  }
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  if (sourceWidth !== width || sourceHeight !== height) {
    throw new Error(`The image source must be ${width}x${height}; received ${sourceWidth}x${sourceHeight}.`);
  }
  return { kind: "image", value: source, width, height };
}

/** @param {any} source */
function pixelOverlaySource(source) {
  if (!source) return null;
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  pixelPositiveInteger(width, "overlay width");
  pixelPositiveInteger(height, "overlay height");
  if (ArrayBuffer.isView(source.data)) {
    if (source.data.byteLength !== width * height * 4) {
      throw new Error(`The RGBA overlay must contain exactly ${width * height * 4} bytes.`);
    }
    return { kind: "rgba", value: source.data, width, height };
  }
  return { kind: "image", value: source, width, height };
}

/** @param {ReturnType<typeof createDisplay>} display @param {"letterbox"|"stretch"} mode */
function pixelBackingRect(display, mode) {
  if (mode === "stretch") return { x: 0, y: 0, width: display.canvas.width, height: display.canvas.height };
  const viewport = display.viewport;
  return {
    x: Math.round(viewport.offsetX * viewport.dpr),
    y: Math.round(viewport.offsetY * viewport.dpr),
    width: Math.round(display.width * viewport.scale * viewport.dpr),
    height: Math.round(display.height * viewport.scale * viewport.dpr),
  };
}

/**
 * Enlarge a fixed-size RGBA or CanvasImageSource frame onto a display canvas.
 * The game continues to own and draw the source; this object only owns the
 * final nearest-neighbour presentation pass.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {number} options.width Source width in pixels.
 * @param {number} options.height Source height in pixels.
 * @param {number} [options.pixelAspect]
 * @param {"letterbox"|"stretch"} [options.mode]
 * @param {"fit"|"integer"} [options.scaleMode]
 * @param {"auto"|"webgl2"|"canvas2d"} [options.backend]
 * @param {"none"|"source-scanlines"|"display-scanlines"|"lcd-grid"|"crt"} [options.filter]
 * @param {number} [options.lineBrightness]
 * @param {number} [options.bandRows]
 * @param {number} [options.gridThickness]
 * @param {number} [options.crtAmount] 0 is the raw picture, 1 the full tube.
 * @param {number} [options.crtGlow] Halation strength, scaled by the amount.
 * @param {number} [options.crtNoise] Speckle strength, scaled by the amount.
 * @param {[number, number, number, number]} [options.clearColor]
 * @param {number} [options.dprCap]
 * @param {boolean} [options.autoResize]
 * @param {(width: number, height: number) => any} [options.createCanvas]
 * @param {() => number} [options.now] Milliseconds, for the tube's animation.
 *        `performance.now` by default; a test passes its own clock.
 */
export function createPixelPresenter(canvas, options) {
  if (!canvas) throw new Error("createPixelPresenter needs a canvas.");
  if (!options || typeof options !== "object") throw new Error("createPixelPresenter needs options.");
  if (options.now !== undefined && typeof options.now !== "function") throw new Error("now must be a function returning milliseconds.");
  let settings = pixelInitialSettings(options);
  // Presentation may read the wall clock; the simulation never sees this.
  const now = options.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  const started = now();
  const createCanvas = options.createCanvas ?? ((width, height) => browserCanvas(width, height, "createPixelPresenter"));
  const designHeight = settings.height * settings.pixelAspect;
  const displayOptions = {
    designWidth: settings.width,
    designHeight,
    dprCap: options.dprCap,
    mode: settings.mode,
    scaleMode: settings.scaleMode,
    autoResize: options.autoResize,
  };

  let display;
  let backend;
  if (settings.backend === "canvas2d") {
    display = createDisplay(canvas, { ...displayOptions, contextType: "2d", contextAttributes: { alpha: true } });
    backend = "canvas2d";
  } else {
    try {
      display = createDisplay(canvas, {
        ...displayOptions,
        contextType: "webgl2",
        contextAttributes: { alpha: true, antialias: false, depth: false, stencil: false },
      });
      backend = "webgl2";
    } catch (error) {
      if (settings.backend === "webgl2") throw error;
      display = createDisplay(canvas, { ...displayOptions, contextType: "2d", contextAttributes: { alpha: true } });
      backend = "canvas2d";
    }
  }

  const previousImageRendering = canvas.style?.imageRendering;
  if (canvas.style) canvas.style.imageRendering = "pixelated";
  let destroyed = false;
  let lost = false;
  let maskDirty = true;
  let maskCanvas = null;
  let stagingCanvas = null;
  let stagingContext = null;
  let stagingImageData = null;
  let overlayStagingCanvas = null;
  let overlayStagingContext = null;
  let overlayStagingImageData = null;
  let unsubscribe = display.subscribe(() => { maskDirty = true; });

  /** @type {WebGLProgram|null} */
  let program = null;
  /** @type {WebGLTexture|null} */
  let texture = null;
  let textureWidth = 0;
  let textureHeight = 0;
  /** @type {WebGLTexture|null} */
  let overlayTexture = null;
  let overlayTextureWidth = 0;
  let overlayTextureHeight = 0;
  /** @type {WebGLVertexArrayObject|null} */
  let vertexArray = null;
  /** @type {Record<string, WebGLUniformLocation|null>} */
  let uniforms = {};

  function releaseGl() {
    if (backend !== "webgl2") return;
    const gl = /** @type {WebGL2RenderingContext} */ (display.context);
    if (texture) gl.deleteTexture(texture);
    if (overlayTexture) gl.deleteTexture(overlayTexture);
    if (vertexArray) gl.deleteVertexArray(vertexArray);
    if (program) gl.deleteProgram(program);
    texture = null;
    textureWidth = 0;
    textureHeight = 0;
    overlayTexture = null;
    overlayTextureWidth = 0;
    overlayTextureHeight = 0;
    vertexArray = null;
    program = null;
    uniforms = {};
  }

  function initializeGl() {
    const gl = /** @type {WebGL2RenderingContext} */ (display.context);
    program = pixelCreateProgram(gl);
    texture = gl.createTexture();
    overlayTexture = gl.createTexture();
    vertexArray = gl.createVertexArray();
    if (!texture || !overlayTexture || !vertexArray) {
      releaseGl();
      throw new Error("The WebGL2 presenter could not allocate its frame texture.");
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, overlayTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    uniforms = {
      frame: gl.getUniformLocation(program, "pixelFrame"),
      sourceSize: gl.getUniformLocation(program, "pixelSourceSize"),
      viewportOrigin: gl.getUniformLocation(program, "pixelViewportOrigin"),
      filter: gl.getUniformLocation(program, "pixelFilter"),
      lineBrightness: gl.getUniformLocation(program, "pixelLineBrightness"),
      bandRows: gl.getUniformLocation(program, "pixelBandRows"),
      gridThickness: gl.getUniformLocation(program, "pixelGridThickness"),
      time: gl.getUniformLocation(program, "pixelTime"),
      crtAmount: gl.getUniformLocation(program, "pixelCrtAmount"),
      crtGlow: gl.getUniformLocation(program, "pixelCrtGlow"),
      crtNoise: gl.getUniformLocation(program, "pixelCrtNoise"),
    };
  }

  function onContextLost(event) {
    event.preventDefault();
    lost = true;
  }

  function onContextRestored() {
    releaseGl();
    initializeGl();
    lost = false;
  }

  if (backend === "webgl2") {
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    initializeGl();
  }

  function rgbaCss() {
    const [red, green, blue, alpha] = settings.clearColor;
    return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${alpha})`;
  }

  /** @param {ReturnType<typeof pixelSource>} source */
  function sourceForCanvas(source) {
    if (source.kind === "image") return source.value;
    if (!stagingCanvas) {
      stagingCanvas = createCanvas(settings.width, settings.height);
      stagingContext = context2d(stagingCanvas, settings.width, settings.height, "createPixelPresenter staging canvas");
    }
    if (!stagingImageData) stagingImageData = stagingContext.createImageData(settings.width, settings.height);
    stagingImageData.data.set(source.value);
    stagingContext.putImageData(stagingImageData, 0, 0);
    return stagingCanvas;
  }

  /** @param {NonNullable<ReturnType<typeof pixelOverlaySource>>} source */
  function overlayForCanvas(source) {
    if (source.kind === "image") return source.value;
    if (!overlayStagingCanvas) overlayStagingCanvas = createCanvas(source.width, source.height);
    if (!overlayStagingContext || overlayStagingCanvas.width !== source.width || overlayStagingCanvas.height !== source.height) {
      overlayStagingContext = context2d(overlayStagingCanvas, source.width, source.height, "createPixelPresenter overlay canvas");
      overlayStagingImageData = null;
    }
    if (!overlayStagingImageData) overlayStagingImageData = overlayStagingContext.createImageData(source.width, source.height);
    overlayStagingImageData.data.set(source.value);
    overlayStagingContext.putImageData(overlayStagingImageData, 0, 0);
    return overlayStagingCanvas;
  }

  function rebuildMask() {
    maskDirty = false;
    if (settings.filter === "none") return;
    if (!maskCanvas) maskCanvas = createCanvas(canvas.width, canvas.height);
    const mask = context2d(maskCanvas, canvas.width, canvas.height, "createPixelPresenter filter canvas");
    mask.clearRect(0, 0, canvas.width, canvas.height);
    mask.fillStyle = `rgba(0, 0, 0, ${1 - settings.lineBrightness})`;
    const rect = pixelBackingRect(display, settings.mode);

    if (settings.filter === "display-scanlines") {
      const band = settings.bandRows;
      for (let y = rect.y + band; y < rect.y + rect.height; y += band * 2) {
        mask.fillRect(rect.x, y, rect.width, Math.min(band, rect.y + rect.height - y));
      }
    } else if (settings.filter === "source-scanlines") {
      const rowHeight = rect.height / settings.height;
      for (let row = settings.bandRows; row < settings.height; row += settings.bandRows * 2) {
        const top = rect.y + row * rowHeight;
        const bottom = rect.y + Math.min(row + settings.bandRows, settings.height) * rowHeight;
        mask.fillRect(rect.x, top, rect.width, bottom - top);
      }
    } else if (settings.filter === "lcd-grid" && settings.gridThickness > 0) {
      const cellWidth = rect.width / settings.width;
      const cellHeight = rect.height / settings.height;
      const thickness = settings.gridThickness;
      for (let column = 1; column < settings.width; column += 1) {
        mask.fillRect(rect.x + column * cellWidth - thickness / 2, rect.y, thickness, rect.height);
      }
      for (let row = 1; row < settings.height; row += 1) {
        mask.fillRect(rect.x, rect.y + row * cellHeight - thickness / 2, rect.width, thickness);
      }
    } else if (settings.filter === "crt") {
      // The tube, as far as a 2d context can follow it: alternate source rows
      // dimmed for the beam structure, and a radial vignette. Halation,
      // convergence, curvature and the animated speckle need the WebGL2 path,
      // and this still image says so by not pretending to them.
      const amount = settings.crtAmount;
      const rowHeight = rect.height / settings.height;
      mask.fillStyle = `rgba(0, 0, 0, ${0.45 * amount})`;
      for (let row = 1; row < settings.height; row += 2) {
        mask.fillRect(rect.x, rect.y + row * rowHeight, rect.width, rowHeight);
      }
      const centreX = rect.x + rect.width / 2;
      const centreY = rect.y + rect.height / 2;
      const vignette = mask.createRadialGradient(centreX, centreY, rect.width * 0.37, centreX, centreY, rect.width * 0.7);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, `rgba(0, 0, 0, ${0.32 * amount})`);
      mask.fillStyle = vignette;
      mask.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
  }

  /** @param {ReturnType<typeof pixelSource>} source */
  function presentCanvas(source, overlay) {
    const context = /** @type {CanvasRenderingContext2D} */ (display.context);
    // A transparent source-over fill does not erase yesterday's frame.
    display.clear();
    if (settings.clearColor[3] > 0) display.clear(rgbaCss());
    context.imageSmoothingEnabled = false;
    context.drawImage(sourceForCanvas(source), 0, 0, settings.width, designHeight);
    if (maskDirty || maskCanvas?.width !== canvas.width || maskCanvas?.height !== canvas.height) rebuildMask();
    if (settings.filter !== "none" && maskCanvas) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(maskCanvas, 0, 0);
      context.restore();
    }
    if (overlay) {
      context.imageSmoothingEnabled = true;
      context.drawImage(overlayForCanvas(overlay), 0, 0, settings.width, designHeight);
    }
  }

  /** @param {ReturnType<typeof pixelSource>} source @param {ReturnType<typeof pixelOverlaySource>} overlay */
  function presentGl(source, overlay) {
    const gl = /** @type {WebGL2RenderingContext} */ (display.context);
    const rect = pixelBackingRect(display, settings.mode);
    const glY = canvas.height - rect.y - rect.height;
    const [red, green, blue, alpha] = settings.clearColor;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(red, green, blue, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(rect.x, glY, rect.width, rect.height);
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uniforms.frame, 0);
    gl.uniform2f(uniforms.viewportOrigin, rect.x, glY);
    gl.uniform1f(uniforms.lineBrightness, settings.lineBrightness);
    gl.uniform1f(uniforms.bandRows, settings.bandRows);
    gl.uniform1f(uniforms.gridThickness, settings.gridThickness);
    gl.uniform1f(uniforms.time, (now() - started) / 1000);
    gl.uniform1f(uniforms.crtAmount, settings.crtAmount);
    gl.uniform1f(uniforms.crtGlow, settings.crtGlow);
    gl.uniform1f(uniforms.crtNoise, settings.crtNoise);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    function drawSource(frame, frameTexture, filter) {
      gl.bindTexture(gl.TEXTURE_2D, frameTexture);
      const isOverlay = frameTexture === overlayTexture;
      const sameSize = isOverlay
        ? overlayTextureWidth === frame.width && overlayTextureHeight === frame.height
        : textureWidth === frame.width && textureHeight === frame.height;
      if (sameSize && frame.kind === "rgba") {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, frame.value);
      } else if (sameSize) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.value);
      } else if (frame.kind === "rgba") {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.value);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.value);
      }
      if (isOverlay) {
        overlayTextureWidth = frame.width;
        overlayTextureHeight = frame.height;
      } else {
        textureWidth = frame.width;
        textureHeight = frame.height;
      }
      gl.uniform2f(uniforms.sourceSize, frame.width, frame.height);
      gl.uniform1i(uniforms.filter, filter);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    drawSource(source, texture, PIXEL_FILTER_INDEX.indexOf(settings.filter));
    if (overlay) drawSource(overlay, overlayTexture, 0);
  }

  return {
    backend,
    display,
    get lost() { return lost; },
    get settings() { return pixelPublicSettings(settings); },

    configure(patch = {}) {
      if (destroyed) throw new Error("This pixel presenter has been destroyed.");
      const next = { ...settings };
      if ("filter" in patch) next.filter = pixelFilter(patch.filter);
      if ("lineBrightness" in patch) next.lineBrightness = pixelUnit(patch.lineBrightness, "lineBrightness", settings.lineBrightness);
      if ("bandRows" in patch) next.bandRows = Math.max(1, Math.floor(pixelFinite(patch.bandRows, "bandRows", settings.bandRows)));
      if ("gridThickness" in patch) next.gridThickness = Math.max(0, pixelFinite(patch.gridThickness, "gridThickness", settings.gridThickness));
      if ("crtAmount" in patch) next.crtAmount = pixelUnit(patch.crtAmount, "crtAmount", settings.crtAmount);
      if ("crtGlow" in patch) next.crtGlow = pixelUnit(patch.crtGlow, "crtGlow", settings.crtGlow);
      if ("crtNoise" in patch) next.crtNoise = pixelUnit(patch.crtNoise, "crtNoise", settings.crtNoise);
      if ("clearColor" in patch) next.clearColor = pixelClearColor(patch.clearColor);
      settings = next;
      maskDirty = true;
      return pixelPublicSettings(settings);
    },

    present(frame, options = {}) {
      if (destroyed) throw new Error("This pixel presenter has been destroyed.");
      if (lost) return false;
      const source = pixelSource(frame, settings.width, settings.height);
      const overlay = pixelOverlaySource(options.overlay);
      if (backend === "webgl2") presentGl(source, overlay);
      else presentCanvas(source, overlay);
      return true;
    },

    toSource(clientX, clientY) {
      const point = display.toWorld(clientX, clientY);
      const x = point.x;
      const y = point.y / settings.pixelAspect;
      return { x, y, inside: x >= 0 && y >= 0 && x < settings.width && y < settings.height };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      if (backend === "webgl2") {
        canvas.removeEventListener("webglcontextlost", onContextLost);
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
        releaseGl();
      }
      display.destroy();
      if (canvas.style) canvas.style.imageRendering = previousImageRendering;
      maskCanvas = null;
      stagingCanvas = null;
      stagingContext = null;
      stagingImageData = null;
      overlayStagingCanvas = null;
      overlayStagingContext = null;
      overlayStagingImageData = null;
    },
  };
}
