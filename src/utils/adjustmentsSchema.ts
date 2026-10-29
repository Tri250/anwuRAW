/**
 * Adjustment parameter schema single source of truth (dependency-free pure data module).
 *
 * Responsibilities:
 * 1. `ADJUSTMENT_SECTIONS`: panel section grouping consumed by the GUI (re-exported by utils/adjustments.ts).
 * 2. Build-time generation of `src-tauri/resources/adjustments-schema.json`
 *    (tools/generate-adjustments-schema.mjs), embedded via include_str! into the binary and used by
 *    the CLI `capabilities` / `validate` subcommands (see docs/agent-cli.md and
 *    docs/contracts/adjustments-schema.md).
 *
 * Keep this file in sync with parameter definitions in utils/adjustments.ts:
 * after adding/renaming/removing an adjustment, update the matching entry here and
 * re-run `npm run schema:generate`. Slider ranges mirror the values used by the
 * adjustment panel components (Basic/Color/Details/Effects, CropPanel, LUTControl).
 */

export interface Sections {
  [index: string]: Array<string>;
  basic: Array<string>;
  curves: Array<string>;
  color: Array<string>;
  details: Array<string>;
  effects: Array<string>;
}

/** Panel section grouping. Values are adjustment keys (not enum symbols). */
export const ADJUSTMENT_SECTIONS: Sections = {
  basic: ['brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'exposure', 'toneMapper'],
  curves: ['curves', 'pointCurves', 'parametricCurve', 'curveMode'],
  color: [
    'saturation',
    'temperature',
    'tint',
    'whiteBalance',
    'vibrance',
    'hsl',
    'colorGrading',
    'colorCalibration',
    'hue',
  ],
  details: [
    'clarity',
    'dehaze',
    'structure',
    'centré',
    'centréX',
    'centréY',
    'sharpness',
    'sharpnessThreshold',
    'lumaNoiseReduction',
    'colorNoiseReduction',
    'aiDenoiseEnabled',
    'aiDenoiseMethod',
    'aiDenoiseAmount',
    'aiDenoiseDetail',
    'chromaticAberrationRedCyan',
    'chromaticAberrationBlueYellow',
    'negativeConversionEnabled',
    'negativeRedWeight',
    'negativeGreenWeight',
    'negativeBlueWeight',
    'negativeExposure',
    'negativeContrast',
  ],
  effects: [
    'glowAmount',
    'halationAmount',
    'flareAmount',
    'grainAmount',
    'grainRoughness',
    'grainSize',
    'lutIntensity',
    'lutName',
    'lutPath',
    'lutSize',
    'lutIsSceneReferred',
    'vignetteAmount',
    'vignetteFeather',
    'vignetteMidpoint',
    'vignetteRoundness',
    'vignetteCenterX',
    'vignetteCenterY',
    'lensBlurEnabled',
    'lensBlurAmount',
    'lensBlurDiffusion',
    'lensBlurShape',
    'lensBlurDepthMap',
    'lensBlurMinDepth',
    'lensBlurMaxDepth',
    'lensBlurMinFade',
    'lensBlurMaxFade',
    'relightEnabled',
    'relightNormalMap',
    'relightLights',
    'relightAmbient',
    'relightSoftness',
    'relightShine',
    'relightShadows',
    'relightShadowSoftness',
    'fogEnabled',
    'fogDepthMap',
    'fogAmount',
    'fogStart',
    'fogDensity',
    'fogHeight',
    'fogVariation',
    'fogGlow',
    'fogTemperature',
    'fogTint',
  ],
};

export interface ParamRange {
  min: number;
  max: number;
  step: number;
}

/** Numeric slider ranges, mirroring the adjustment panel components. */
export const ADJUSTMENT_PARAM_RANGES: Record<string, ParamRange> = {
  // basic
  exposure: { min: -5, max: 5, step: 0.01 },
  brightness: { min: -5, max: 5, step: 0.01 },
  contrast: { min: -100, max: 100, step: 1 },
  highlights: { min: -100, max: 100, step: 1 },
  shadows: { min: -100, max: 100, step: 1 },
  whites: { min: -100, max: 100, step: 1 },
  blacks: { min: -100, max: 100, step: 1 },
  // color
  vibrance: { min: -100, max: 100, step: 1 },
  saturation: { min: -100, max: 100, step: 1 },
  hue: { min: -180, max: 180, step: 1 },
  temperature: { min: -100, max: 100, step: 1 },
  tint: { min: -100, max: 100, step: 1 },
  // details
  sharpness: { min: -100, max: 100, step: 1 },
  sharpnessThreshold: { min: 0, max: 80, step: 1 },
  clarity: { min: -100, max: 100, step: 1 },
  dehaze: { min: -100, max: 100, step: 1 },
  structure: { min: -100, max: 100, step: 1 },
  centré: { min: -100, max: 100, step: 1 },
  lumaNoiseReduction: { min: 0, max: 100, step: 1 },
  colorNoiseReduction: { min: 0, max: 100, step: 1 },
  aiDenoiseAmount: { min: 0, max: 100, step: 1 },
  aiDenoiseDetail: { min: 0, max: 100, step: 1 },
  chromaticAberrationRedCyan: { min: -100, max: 100, step: 1 },
  chromaticAberrationBlueYellow: { min: -100, max: 100, step: 1 },
  negativeRedWeight: { min: 0.5, max: 2, step: 0.01 },
  negativeGreenWeight: { min: 0.5, max: 2, step: 0.01 },
  negativeBlueWeight: { min: 0.5, max: 2, step: 0.01 },
  negativeExposure: { min: -2, max: 2, step: 0.05 },
  negativeContrast: { min: 0.5, max: 2.5, step: 0.05 },
  // effects
  glowAmount: { min: 0, max: 100, step: 1 },
  halationAmount: { min: 0, max: 100, step: 1 },
  flareAmount: { min: 0, max: 100, step: 1 },
  lensBlurAmount: { min: 0, max: 100, step: 1 },
  lensBlurDiffusion: { min: 0, max: 100, step: 1 },
  lensBlurMinDepth: { min: 0, max: 100, step: 1 },
  lensBlurMaxDepth: { min: 0, max: 100, step: 1 },
  lensBlurMinFade: { min: 0, max: 100, step: 1 },
  lensBlurMaxFade: { min: 0, max: 100, step: 1 },
  relightAmbient: { min: -100, max: 100, step: 1 },
  relightSoftness: { min: 0, max: 100, step: 1 },
  relightShine: { min: 0, max: 100, step: 1 },
  relightShadowSoftness: { min: 0, max: 100, step: 1 },
  fogAmount: { min: 0, max: 100, step: 1 },
  fogStart: { min: 0, max: 100, step: 1 },
  fogDensity: { min: 0, max: 100, step: 1 },
  fogHeight: { min: 0, max: 100, step: 1 },
  fogVariation: { min: 0, max: 100, step: 1 },
  fogGlow: { min: 0, max: 100, step: 1 },
  fogTemperature: { min: -100, max: 100, step: 1 },
  fogTint: { min: -100, max: 100, step: 1 },
  vignetteAmount: { min: -100, max: 100, step: 1 },
  vignetteMidpoint: { min: 0, max: 100, step: 1 },
  vignetteRoundness: { min: -100, max: 100, step: 1 },
  vignetteFeather: { min: 0, max: 100, step: 1 },
  grainAmount: { min: 0, max: 100, step: 1 },
  grainSize: { min: 0, max: 100, step: 1 },
  grainRoughness: { min: 0, max: 100, step: 1 },
  lutIntensity: { min: 0, max: 200, step: 1 },
  // geometry / lens (CropPanel)
  transformDistortion: { min: -100, max: 100, step: 1 },
  transformVertical: { min: -100, max: 100, step: 1 },
  transformHorizontal: { min: -100, max: 100, step: 1 },
  transformRotate: { min: -45, max: 45, step: 0.1 },
  transformAspect: { min: -100, max: 100, step: 1 },
  transformScale: { min: 50, max: 150, step: 1 },
  transformXOffset: { min: -100, max: 100, step: 1 },
  transformYOffset: { min: -100, max: 100, step: 1 },
  lensDistortionAmount: { min: 0, max: 200, step: 1 },
  lensVignetteAmount: { min: 0, max: 200, step: 1 },
  lensTcaAmount: { min: 0, max: 200, step: 1 },
};

/** Closed-set string parameters. */
export const ADJUSTMENT_ENUM_VALUES: Record<string, Array<string>> = {
  toneMapper: ['agx', 'basic'],
  lensBlurShape: ['circle', 'hexagon', 'octagon', 'ring'],
  lensCorrectionMode: ['auto', 'manual'],
  curveMode: ['point', 'parametric'],
  aiDenoiseMethod: ['ai', 'bm3d'],
};

/** Mask categories accepted in adjustments.masks[]. */
export const MASK_TYPES: Array<string> = [
  'ai-depth',
  'ai-foreground',
  'ai-sky',
  'ai-subject',
  'ai-text',
  'ai-face',
  'all',
  'brush',
  'flow',
  'color',
  'linear',
  'luminance',
  'quick-eraser',
  'radial',
  'clone',
  'heal',
  'liquify',
  'retouch',
];

export const SUB_MASK_MODES: Array<string> = ['additive', 'subtractive', 'intersect'];

/** Export formats accepted by the `export` subcommand. */
export const EXPORT_FORMATS: Array<string> = ['jpeg', 'png', 'webp', 'tiff'];

export const TIFF_BIT_DEPTHS: Array<number> = [8, 16];

export interface ParamSpec {
  type: 'number' | 'boolean' | 'enum' | 'string' | 'array' | 'object' | 'any';
  min?: number;
  max?: number;
  values?: Array<string>;
  properties?: Record<string, ParamSpec>;
  /** Item spec for `array` params. */
  items?: ParamSpec;
}

const HSL_CHANNEL_SPEC: ParamSpec = {
  type: 'object',
  properties: {
    hue: { type: 'number', min: -100, max: 100 },
    saturation: { type: 'number', min: -100, max: 100 },
    luminance: { type: 'number', min: -100, max: 100 },
  },
};

const HSL_OBJECT_SPEC: ParamSpec = {
  type: 'object',
  properties: Object.fromEntries(
    ['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'].map((channel) => [
      channel,
      HSL_CHANNEL_SPEC,
    ]),
  ),
};

const COLOR_GRADING_ZONE_SPEC: ParamSpec = {
  type: 'object',
  properties: {
    hue: { type: 'number' },
    saturation: { type: 'number' },
    luminance: { type: 'number' },
  },
};

const RELIGHT_LIGHT_SPEC: ParamSpec = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'enum', values: ['point', 'spot', 'directional'] },
    x: { type: 'number' },
    y: { type: 'number' },
    depth: { type: 'number', min: 0, max: 100 },
    intensity: { type: 'number', min: 0, max: 100 },
    radius: { type: 'number', min: 0, max: 100 },
    angle: { type: 'number', min: 0, max: 360 },
    elevation: { type: 'number', min: -180, max: 180 },
    cone: { type: 'number', min: 0, max: 100 },
    feather: { type: 'number', min: 0, max: 100 },
    temperature: { type: 'number', min: -100, max: 100 },
    tint: { type: 'number', min: -100, max: 100 },
    color: { type: 'string' },
  },
};

const PARAMETRIC_CURVE_CHANNEL_SPEC: ParamSpec = {
  type: 'object',
  properties: {
    darks: { type: 'number', min: -100, max: 100 },
    shadows: { type: 'number', min: -100, max: 100 },
    highlights: { type: 'number', min: -100, max: 100 },
    lights: { type: 'number', min: -100, max: 100 },
    whiteLevel: { type: 'number', min: 0, max: 100 },
    blackLevel: { type: 'number', min: -100, max: 0 },
    split1: { type: 'number', min: 0, max: 100 },
    split2: { type: 'number', min: 0, max: 100 },
    split3: { type: 'number', min: 0, max: 100 },
  },
};

const CURVE_CHANNELS = ['luma', 'red', 'green', 'blue'];

const PARAMETRIC_CURVE_SPEC: ParamSpec = {
  type: 'object',
  properties: Object.fromEntries(CURVE_CHANNELS.map((channel) => [channel, PARAMETRIC_CURVE_CHANNEL_SPEC])),
};

/** Nested object parameters with deep (recursive) validation. */
export const OBJECT_PARAM_SPECS: Record<string, ParamSpec> = {
  hsl: HSL_OBJECT_SPEC,
  colorCalibration: {
    type: 'object',
    properties: {
      shadowsTint: { type: 'number', min: -100, max: 100 },
      redHue: { type: 'number', min: -100, max: 100 },
      redSaturation: { type: 'number', min: -100, max: 100 },
      greenHue: { type: 'number', min: -100, max: 100 },
      greenSaturation: { type: 'number', min: -100, max: 100 },
      blueHue: { type: 'number', min: -100, max: 100 },
      blueSaturation: { type: 'number', min: -100, max: 100 },
    },
  },
  colorGrading: {
    type: 'object',
    properties: {
      balance: { type: 'number', min: -100, max: 100 },
      blending: { type: 'number', min: 0, max: 100 },
      global: COLOR_GRADING_ZONE_SPEC,
      highlights: COLOR_GRADING_ZONE_SPEC,
      midtones: COLOR_GRADING_ZONE_SPEC,
      shadows: COLOR_GRADING_ZONE_SPEC,
    },
  },
  parametricCurve: PARAMETRIC_CURVE_SPEC,
  relightLights: {
    type: 'array',
    items: RELIGHT_LIGHT_SPEC,
  },
};

/**
 * Parameters that only get type-level checks (complex objects, binary payloads,
 * internal bookkeeping keys like activeTools/aiPatches/showClipping).
 */
export const ANY_CHECK_PARAMS: Array<string> = [
  'activeTools',
  'aiPatches',
  'aspectRatio',
  'baselineExposure',
  'colorMatch',
  'crop',
  'curves',
  'pointCurves',
  'flipHorizontal',
  'flipVertical',
  'guidedPerspective',
  'lensBlurDepthMap',
  'lensDistortionParams',
  'lensMaker',
  'lensModel',
  'lutData',
  'lutName',
  'lutPath',
  'lutSize',
  'lutIsSceneReferred',
  'masks',
  'orientationSteps',
  'rotation',
  'showClipping',
  'whiteBalance',
  'fogDepthMap',
  'relightNormalMap',
];
