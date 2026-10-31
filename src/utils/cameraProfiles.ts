import { Adjustments, ColorCalibration, Hsl, INITIAL_ADJUSTMENTS } from './adjustments';

/**
 * Frontend-defined camera profile presets (plan §4 "相机配置文件体系").
 *
 * A profile is a one-shot patch over the color-rendering keys
 * (`colorCalibration`, `saturation`, `vibrance`, `hsl`). Selecting a profile
 * deterministically writes ALL managed keys — profile keys omitted from the
 * patch reset to their neutral defaults — so switching between profiles never
 * leaves residue from the previous one. Selecting `DEFAULT_CAMERA_PROFILE_ID`
 * restores the neutral values and clears the selection.
 *
 * The Rust pipeline has no embedded per-camera ICC/LUT profiles yet; when the
 * backend ships those, each preset can be switched to reference the embedded
 * profile id without touching the call sites.
 */
export interface CameraProfile {
  id: string;
  name: string;
  patch: {
    colorCalibration?: Partial<ColorCalibration>;
    saturation?: number;
    vibrance?: number;
    hsl?: Partial<Hsl>;
  };
}

export const DEFAULT_CAMERA_PROFILE_ID = 'default';

const NEUTRAL_HSL: Hsl = INITIAL_ADJUSTMENTS.hsl;

export const CAMERA_PROFILES: Array<CameraProfile> = [
  {
    id: 'camera-vivid',
    name: 'Camera Vivid',
    patch: {
      colorCalibration: { redSaturation: 10, greenSaturation: 5, blueSaturation: 10 },
      saturation: 5,
      vibrance: 20,
    },
  },
  {
    id: 'camera-faithful',
    name: 'Camera Faithful',
    patch: {
      colorCalibration: { redSaturation: -5, blueSaturation: -5 },
      saturation: -5,
      vibrance: 0,
    },
  },
  {
    id: 'camera-portrait',
    name: 'Camera Portrait',
    patch: {
      colorCalibration: { redSaturation: 5, shadowsTint: 5 },
      saturation: -5,
      vibrance: 15,
      hsl: { oranges: { hue: -5, saturation: 10, luminance: 5 } },
    },
  },
  {
    id: 'camera-landscape',
    name: 'Camera Landscape',
    patch: {
      colorCalibration: { greenSaturation: 10, blueSaturation: 15 },
      vibrance: 25,
      hsl: { greens: { hue: -5, saturation: 10, luminance: 0 }, blues: { hue: 0, saturation: 10, luminance: -5 } },
    },
  },
  {
    id: 'camera-monochrome',
    name: 'Camera Monochrome',
    patch: {
      saturation: -100,
      vibrance: 0,
    },
  },
  {
    id: 'film-portra',
    name: 'Film Portra',
    patch: {
      colorCalibration: { shadowsTint: 8, redSaturation: -5 },
      saturation: -15,
      vibrance: 10,
      hsl: {
        reds: { hue: 5, saturation: -10, luminance: 5 },
        oranges: { hue: 5, saturation: 5, luminance: 5 },
        greens: { hue: 10, saturation: -20, luminance: 5 },
        blues: { hue: -5, saturation: -15, luminance: 0 },
      },
    },
  },
  {
    id: 'film-velvia',
    name: 'Film Velvia',
    patch: {
      colorCalibration: { redSaturation: 10, greenSaturation: 10, blueSaturation: 15 },
      saturation: 25,
      vibrance: 20,
      hsl: {
        reds: { hue: -5, saturation: 15, luminance: -5 },
        greens: { hue: -10, saturation: 15, luminance: -5 },
        blues: { hue: 5, saturation: 20, luminance: -10 },
      },
    },
  },
  {
    id: 'film-ektar',
    name: 'Film Ektar',
    patch: {
      colorCalibration: { blueSaturation: 10, redSaturation: 5 },
      saturation: 15,
      vibrance: 15,
      hsl: {
        reds: { hue: 0, saturation: 10, luminance: 0 },
        blues: { hue: 0, saturation: 15, luminance: -5 },
        aquas: { hue: 0, saturation: 10, luminance: -5 },
      },
    },
  },
  {
    id: 'film-acros',
    name: 'Film Acros',
    patch: {
      saturation: -100,
      vibrance: 0,
      hsl: {},
    },
  },
];

/** Neutral values for every profile-managed key. */
export const getNeutralCameraProfileValues = (): Partial<Adjustments> => ({
  colorCalibration: { ...INITIAL_ADJUSTMENTS.colorCalibration },
  saturation: 0,
  vibrance: 0,
  hsl: {
    ...NEUTRAL_HSL,
    ...Object.fromEntries(Object.keys(NEUTRAL_HSL).map((channel) => [channel, { ...NEUTRAL_HSL[channel] }])),
  } as Hsl,
});

/**
 * Full managed-key values for a profile id (neutral defaults + profile patch).
 * Unknown ids resolve to the neutral default profile.
 */
export const getCameraProfileValues = (profileId: string | null | undefined): Partial<Adjustments> => {
  const values = getNeutralCameraProfileValues();
  const profile = CAMERA_PROFILES.find((p) => p.id === profileId);
  if (!profile) return values;

  const baseCalibration: ColorCalibration = values.colorCalibration ?? { ...INITIAL_ADJUSTMENTS.colorCalibration };
  const baseHsl: Hsl = (values.hsl as Hsl) ?? ({ ...NEUTRAL_HSL } as Hsl);
  const { colorCalibration: patchCalibration, saturation, vibrance, hsl: patchHsl } = profile.patch;

  const result: Partial<Adjustments> = { ...values };
  if (patchCalibration) {
    // The neutral base always carries all calibration fields, so the merged
    // object is a complete ColorCalibration even though the patch is partial.
    result.colorCalibration = { ...baseCalibration, ...patchCalibration } as ColorCalibration;
  }
  if (saturation !== undefined) result.saturation = saturation;
  if (vibrance !== undefined) result.vibrance = vibrance;
  if (patchHsl) {
    result.hsl = Object.fromEntries(
      Object.entries(baseHsl).map(([channel, channelValues]) => [
        channel,
        { ...channelValues, ...(patchHsl[channel] ?? {}) },
      ]),
    ) as Hsl;
  }
  return result;
};

/** Tools that must be active for a profile's written keys to reach the GPU. */
export const getCameraProfileTools = (profileId: string | null | undefined): Array<string> => {
  const profile = CAMERA_PROFILES.find((p) => p.id === profileId);
  const tools: Array<string> = [];
  if (!profile) return tools;
  if (profile.patch.colorCalibration) tools.push('colorCalibration');
  if (profile.patch.saturation !== undefined || profile.patch.vibrance !== undefined) tools.push('colorPresence');
  if (profile.patch.hsl && Object.keys(profile.patch.hsl).length > 0) tools.push('colorMixer');
  return tools;
};
