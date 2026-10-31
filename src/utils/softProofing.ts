/**
 * Frontend soft-proofing approximation.
 *
 * A true ICC output transform needs the backend render pipeline (the frozen
 * `RenderRequest` would need a proofing-profile field). Until that hook
 * exists, this module approximates the on-screen result of converting the
 * working preview into a narrower/wider output profile with CSS filters, plus
 * a magenta out-of-gamut overlay computed from the preview pixels.
 */

export type SoftProofProfileId = 'srgb' | 'display-p3' | 'adobe-rgb' | 'rec2020';
export type SoftProofIntent = 'perceptual' | 'relative' | 'saturation' | 'absolute';

export interface SoftProofProfile {
  id: SoftProofProfileId;
  /** Saturation multiplier approximating a conversion into this gamut. */
  saturation: number;
  /** Brightness multiplier applied for absolute colorimetric paper simulation. */
  paperBrightness: number;
}

export interface SoftProofingSettings {
  enabled: boolean;
  profile: SoftProofProfileId;
  intent: SoftProofIntent;
  simulatePaper: boolean;
  gamutWarning: boolean;
}

export const DEFAULT_SOFT_PROOFING: SoftProofingSettings = {
  enabled: false,
  profile: 'srgb',
  intent: 'perceptual',
  simulatePaper: false,
  gamutWarning: false,
};

export const SOFT_PROOF_PROFILES: SoftProofProfile[] = [
  { id: 'srgb', saturation: 0.94, paperBrightness: 1.0 },
  { id: 'display-p3', saturation: 0.98, paperBrightness: 1.01 },
  { id: 'adobe-rgb', saturation: 1.0, paperBrightness: 1.01 },
  { id: 'rec2020', saturation: 1.02, paperBrightness: 1.0 },
];

/** Chroma threshold above which a preview pixel is flagged out-of-gamut. */
export const GAMUT_WARNING_SATURATION_THRESHOLD = 0.85;

export function getSoftProofFilter(settings: SoftProofingSettings): string | null {
  if (!settings.enabled) return null;

  const profile = SOFT_PROOF_PROFILES.find((p) => p.id === settings.profile) ?? SOFT_PROOF_PROFILES[0];
  let saturation = profile.saturation;
  let brightness = 1;
  let contrast = 1;
  let warm = 0;

  switch (settings.intent) {
    case 'perceptual':
      // Smooth compression: slightly soften saturation and contrast.
      saturation *= 0.98;
      contrast *= 0.99;
      break;
    case 'relative':
      // Clip out-of-gamut colors: keep saturation as-is.
      break;
    case 'saturation':
      // Rendering intent that preserves vividness at the expense of hue accuracy.
      saturation = Math.min(saturation * 1.08, 1.2);
      break;
    case 'absolute':
      // Absolute colorimetric reproduces the paper white.
      brightness *= profile.paperBrightness;
      warm = 0.04;
      break;
    default:
      break;
  }

  if (settings.simulatePaper) {
    brightness *= 0.99;
    contrast *= 0.97;
    warm = Math.max(warm, 0.05);
  }

  const parts: string[] = [];
  if (Math.abs(saturation - 1) > 0.001) parts.push(`saturate(${saturation.toFixed(3)})`);
  if (Math.abs(brightness - 1) > 0.001) parts.push(`brightness(${brightness.toFixed(3)})`);
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${contrast.toFixed(3)})`);
  if (warm > 0) parts.push(`sepia(${warm.toFixed(2)})`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Builds a magenta overlay marking preview pixels whose chroma exceeds the
 * out-of-gamut threshold. Returns null when the image cannot be sampled
 * (e.g. cross-origin sources).
 */
export async function computeGamutWarningOverlay(
  imageUrl: string,
  threshold: number = GAMUT_WARNING_SATURATION_THRESHOLD,
): Promise<string | null> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load preview for gamut analysis'));
      image.src = imageUrl;
    });
  } catch {
    return null;
  }

  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return null;

  const MAX_DIMENSION = 512;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height);
    const pixels = frame.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lightness = (max + min) / 510;
      const chroma = (max - min) / 255;
      const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
      if (saturation > threshold) {
        pixels[i] = 255;
        pixels[i + 1] = 0;
        pixels[i + 2] = 255;
      }
    }
    ctx.putImageData(frame, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    // Tainted canvas (cross-origin preview) — warnings unavailable.
    return null;
  }
}
