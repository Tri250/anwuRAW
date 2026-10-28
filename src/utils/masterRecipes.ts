import recipeCatalog from './masterRecipes.json';
import type { Adjustments, Hsl } from './adjustments';

/**
 * Master recipe catalog ported from RawLab (GPL-3.0-only, see
 * resources/licenses/RawLab-GPL-3.0.txt). Each recipe pairs a display-referred
 * 3D LUT with six tone/colour controls and eight HSL channels.
 */
export interface MasterRecipeHsl {
  hue: Array<number>;
  lightness: Array<number>;
  saturation: Array<number>;
}

export interface MasterRecipe {
  contrastDelta: number;
  exposureDelta: number;
  highlightsDelta: number;
  hsl: MasterRecipeHsl;
  id: string;
  lutFileName: string;
  name: string;
  saturationDelta: number;
  shadowsDelta: number;
  subtitle: string;
  summary: string;
  tintDelta: number;
}

export const MASTER_RECIPES: Array<MasterRecipe> = recipeCatalog as Array<MasterRecipe>;

/** `Adjustments.exposure` is stored in slider units; the renderer multiplies by 0.8 to get EV. */
export const EXPOSURE_SLIDER_SCALE = 0.8;
/** `Adjustments.tint` is stored in relative units; the renderer multiplies by 1.5 to get tint counts. */
export const TINT_RELATIVE_SCALE = 1.5;
export const RECIPE_INTENSITY_DEFAULT = 100;
export const RECIPE_INTENSITY_MAX = 200;
export const MASTER_LUT_NAME_PREFIX = '大师·';

/** RawLab channel order is red, orange, yellow, green, aqua, blue, purple, magenta. */
const HSL_CHANNEL_KEYS = ['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'] as const;

type HslChannelKey = (typeof HSL_CHANNEL_KEYS)[number];

export type RecipeAdjustmentPatch = Partial<Adjustments>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const buildRecipeHsl = (hsl: MasterRecipeHsl): Hsl => {
  const result = {} as Hsl;
  HSL_CHANNEL_KEYS.forEach((key: HslChannelKey, index: number) => {
    result[key] = {
      hue: hsl.hue[index] ?? 0,
      saturation: hsl.saturation[index] ?? 0,
      luminance: hsl.lightness[index] ?? 0,
    };
  });
  return result;
};

/**
 * Converts a recipe into the adjustment values written to the store. Only the
 * controls a recipe owns are returned, so unrelated sliders keep their values.
 */
export const recipeToAdjustments = (
  recipe: MasterRecipe,
  strength: number = RECIPE_INTENSITY_DEFAULT,
): RecipeAdjustmentPatch => {
  const scale = clamp(strength, 0, RECIPE_INTENSITY_MAX) / RECIPE_INTENSITY_DEFAULT;
  const hsl = buildRecipeHsl(recipe.hsl);
  const scaledHsl = {} as Hsl;
  HSL_CHANNEL_KEYS.forEach((key: HslChannelKey) => {
    const channel = hsl[key];
    scaledHsl[key] = {
      hue: clamp(channel.hue * scale, -100, 100),
      saturation: clamp(channel.saturation * scale, -100, 100),
      luminance: clamp(channel.luminance * scale, -100, 100),
    };
  });

  return {
    exposure: (recipe.exposureDelta / EXPOSURE_SLIDER_SCALE) * scale,
    shadows: recipe.shadowsDelta * scale,
    highlights: recipe.highlightsDelta * scale,
    contrast: recipe.contrastDelta * scale,
    saturation: recipe.saturationDelta * scale,
    tint: (recipe.tintDelta / TINT_RELATIVE_SCALE) * scale,
    hsl: scaledHsl,
  };
};

/** Master LUTs are authored as `Gamma: sRGB to sRGB`, so they run after tone mapping. */
export const MASTER_LUT_IS_SCENE_REFERRED = false;

export const masterLutBaseName = (recipe: MasterRecipe) => `${MASTER_LUT_NAME_PREFIX}${recipe.name}`;

export const masterRecipeArtworkUrl = (recipeId: string) => `/master-recipes/${recipeId}.png`;

/**
 * Resolves the bundled LUT path for a recipe. The catalog stores RawLab file
 * names while the bundle ships localized `大师·<name>.cube` files, so the
 * lookup falls back to matching the LUT stem against the recipe name.
 */
export const resolveMasterLutPath = (
  recipe: MasterRecipe,
  luts: Array<{ name: string; path: string }>,
): string | null => resolveMasterLutEntry(recipe, luts)?.path ?? null;

export interface MasterLutEntryLike {
  name: string;
  path: string;
  isSceneReferred?: boolean;
}

/**
 * Resolves the bundled LUT entry for a recipe, preserving the backend-detected
 * `isSceneReferred` flag so the renderer applies the LUT in the correct stage.
 */
export const resolveMasterLutEntry = (
  recipe: MasterRecipe,
  luts: Array<MasterLutEntryLike>,
): MasterLutEntryLike | null => {
  const expected = masterLutBaseName(recipe);
  const exact = luts.find((lut) => lut.name === expected);
  if (exact) {
    return exact;
  }
  const normalizedName = recipe.name.toLowerCase();
  const fuzzy = luts.find((lut) => lut.name.toLowerCase().includes(normalizedName));
  return fuzzy ?? null;
};
