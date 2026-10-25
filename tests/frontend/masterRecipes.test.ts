import { describe, expect, it } from 'vitest';
import i18n from 'i18next';
import {
  FILM_SCOPE_DEFAULTS,
  MASTER_RECIPES,
  RECIPE_PARAMETER_RESET,
  RECIPE_SCOPE_DEFAULTS,
  SCENE_SCOPE_DEFAULTS,
  createIdentityHsl,
  getActiveRecipeId,
  isHslEqual,
  recipeToAdjustmentValues,
} from '../../src/utils/masterRecipes';
import { CURVE_TONE_PRESETS, DIAGONAL } from '../../src/components/adjustments/curvePresets';
import type { Adjustments } from '../../src/utils/adjustments';

const buildRecipeAdjustments = (recipeIndex: number): Adjustments =>
  ({
    ...SCENE_SCOPE_DEFAULTS,
    ...recipeToAdjustmentValues(MASTER_RECIPES[recipeIndex]),
  }) as Adjustments;

describe('大师配方数据层', () => {
  it('内置 14 个配方且 id/名称/LUT 文件名唯一', () => {
    expect(MASTER_RECIPES).toHaveLength(14);
    expect(new Set(MASTER_RECIPES.map((r) => r.id)).size).toBe(14);
    expect(new Set(MASTER_RECIPES.map((r) => r.name)).size).toBe(14);
    expect(new Set(MASTER_RECIPES.map((r) => r.lutFileName)).size).toBe(14);
  });

  it('每个配方都提供六项色调参数与完整 8 通道 HSL', () => {
    for (const recipe of MASTER_RECIPES) {
      expect(Object.keys(recipe.values).sort()).toEqual([
        'contrast',
        'exposure',
        'highlights',
        'saturation',
        'shadows',
        'tint',
      ]);
      expect(Object.keys(recipe.hsl).sort()).toEqual([
        'aquas',
        'blues',
        'greens',
        'magentas',
        'oranges',
        'purples',
        'reds',
        'yellows',
      ]);
      for (const channel of Object.values(recipe.hsl)) {
        expect(channel).toEqual({
          hue: expect.any(Number),
          saturation: expect.any(Number),
          luminance: expect.any(Number),
        });
      }
    }
  });

  it('scene 治理域为 14 个中性基础键', () => {
    expect(Object.keys(SCENE_SCOPE_DEFAULTS)).toHaveLength(14);
    expect(Object.values(SCENE_SCOPE_DEFAULTS).every((v) => v === 0)).toBe(true);
    expect(SCENE_SCOPE_DEFAULTS).toMatchObject({
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      temperature: 0,
      tint: 0,
      saturation: 0,
      vibrance: 0,
      clarity: 0,
      dehaze: 0,
      lumaNoiseReduction: 0,
      colorNoiseReduction: 0,
    });
  });

  it('film 治理域仅包含 LUT 字段', () => {
    expect(FILM_SCOPE_DEFAULTS).toEqual({
      lutPath: null,
      lutName: null,
      lutData: null,
      lutSize: 0,
      lutIntensity: 100,
      lutIsSceneReferred: false,
    });
  });

  it('recipe 治理域 = 场景 14 键 + HSL + LUT', () => {
    expect(Object.keys(RECIPE_SCOPE_DEFAULTS).sort()).toEqual(
      [...Object.keys(SCENE_SCOPE_DEFAULTS), 'hsl', ...Object.keys(FILM_SCOPE_DEFAULTS)].sort(),
    );
    expect(RECIPE_PARAMETER_RESET).toEqual({
      ...SCENE_SCOPE_DEFAULTS,
      hsl: createIdentityHsl(),
    });
    expect(RECIPE_PARAMETER_RESET).not.toHaveProperty('lutName');
  });

  it('recipeToAdjustmentValues 写入 LUT 名称与中性强度', () => {
    const recipe = MASTER_RECIPES[0];
    const values = recipeToAdjustmentValues(recipe);
    expect(values.lutName).toBe(recipe.name);
    expect(values.lutIntensity).toBe(100);
    expect(values.lutIsSceneReferred).toBe(false);
    expect(values.hsl).not.toBe(recipe.hsl);
    expect(values.hsl).toEqual(recipe.hsl);
    expect(values.exposure).toBe(recipe.values.exposure);
    expect(values.contrast).toBe(recipe.values.contrast);
  });

  it('recipeToAdjustmentValues 深拷贝 HSL 通道，修改返回值不会污染配方常量', () => {
    const recipe = MASTER_RECIPES[0];
    const originalHue = recipe.hsl.reds.hue;
    const values = recipeToAdjustmentValues(recipe);

    expect(values.hsl!.reds).not.toBe(recipe.hsl.reds);
    values.hsl!.reds.hue = 123;

    expect(recipe.hsl.reds.hue).toBe(originalHue);
    expect(recipeToAdjustmentValues(recipe).hsl!.reds.hue).toBe(originalHue);
  });

  it('getActiveRecipeId 能识别每一个配方的完整参数', () => {
    MASTER_RECIPES.forEach((recipe, index) => {
      expect(getActiveRecipeId(buildRecipeAdjustments(index))).toBe(recipe.id);
    });
  });

  it('HSL 引用不同但值一致时仍视为激活', () => {
    const adjustments = {
      ...buildRecipeAdjustments(0),
      hsl: JSON.parse(JSON.stringify(MASTER_RECIPES[0].hsl)),
    };
    expect(getActiveRecipeId(adjustments)).toBe(MASTER_RECIPES[0].id);
  });

  it('任一参数被微调后退出激活态', () => {
    const adjustments = { ...buildRecipeAdjustments(0), exposure: 0.41 };
    expect(getActiveRecipeId(adjustments)).toBeNull();
  });

  it('HSL 微调后退出激活态', () => {
    const adjustments = buildRecipeAdjustments(0);
    adjustments.hsl.reds.luminance = 3;
    expect(getActiveRecipeId(adjustments)).toBeNull();
  });

  it('中性外观不匹配任何配方', () => {
    expect(
      getActiveRecipeId({
        ...SCENE_SCOPE_DEFAULTS,
        hsl: createIdentityHsl(),
        lutName: null,
      }),
    ).toBeNull();
  });

  it('isHslEqual 逐通道比较', () => {
    const a = createIdentityHsl();
    const b = createIdentityHsl();
    expect(isHslEqual(a, b)).toBe(true);
    expect(isHslEqual(a, a)).toBe(true);
    expect(isHslEqual(undefined, undefined)).toBe(true);
    expect(isHslEqual(a, undefined)).toBe(false);
    b.greens.saturation = 1;
    expect(isHslEqual(a, b)).toBe(false);
  });
});

describe('曲线色调预设库', () => {
  it('内置 10 个预设且 id 唯一', () => {
    expect(CURVE_TONE_PRESETS).toHaveLength(10);
    expect(new Set(CURVE_TONE_PRESETS.map((p) => p.id)).size).toBe(10);
    expect(CURVE_TONE_PRESETS.map((p) => p.id)).toEqual([
      'original',
      'brighten',
      'darken',
      'sCurve',
      'lowContrast',
      'fade',
      'film',
      'warm',
      'cool',
      'portrait',
    ]);
  });

  it('每个预设四通道齐全,点数量 ≤16 且坐标在 0..255', () => {
    for (const preset of CURVE_TONE_PRESETS) {
      expect(Object.keys(preset.curves).sort()).toEqual(['blue', 'green', 'luma', 'red']);
      for (const channel of Object.values(preset.curves)) {
        expect(channel.length).toBeGreaterThanOrEqual(2);
        expect(channel.length).toBeLessThanOrEqual(16);
        for (const point of channel) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(255);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(255);
        }
        for (let i = 1; i < channel.length; i++) {
          expect(channel[i].x).toBeGreaterThanOrEqual(channel[i - 1].x);
        }
        expect(channel[0].x).toBe(0);
        expect(channel[channel.length - 1].x).toBe(255);
      }
    }
  });

  it('original 为中性对角线且色调参数全部归零', () => {
    const original = CURVE_TONE_PRESETS.find((p) => p.id === 'original')!;
    expect(original.curves.luma).toBe(DIAGONAL);
    expect(original.curves.red).toBe(DIAGONAL);
    expect(original.tone).toEqual({
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 0,
      vibrance: 0,
      temperature: 0,
      tint: 0,
    });
  });

  it('暖色预设提升色温,冷色预设降低色温并调整蓝/绿通道', () => {
    const warm = CURVE_TONE_PRESETS.find((p) => p.id === 'warm')!;
    const cool = CURVE_TONE_PRESETS.find((p) => p.id === 'cool')!;
    expect(warm.tone?.temperature).toBe(14);
    expect(cool.tone?.temperature).toBe(-14);
    const redMid = warm.curves.red.find((point) => point.x === 128)!;
    const blueMid = warm.curves.blue.find((point) => point.x === 128)!;
    const coolRedMid = cool.curves.red.find((point) => point.x === 128)!;
    const coolBlueMid = cool.curves.blue.find((point) => point.x === 128)!;
    expect(redMid.y).toBeGreaterThan(128);
    expect(blueMid.y).toBeLessThan(128);
    expect(coolRedMid.y).toBeLessThan(128);
    expect(coolBlueMid.y).toBeGreaterThan(128);
  });

  it('S 曲线预设提高对比度,低对比预设反向', () => {
    expect(CURVE_TONE_PRESETS.find((p) => p.id === 'sCurve')!.tone?.contrast).toBe(5);
    expect(CURVE_TONE_PRESETS.find((p) => p.id === 'lowContrast')!.tone?.contrast).toBe(-12);
    expect(CURVE_TONE_PRESETS.find((p) => p.id === 'fade')!.tone?.saturation).toBe(-6);
  });

  it('所有 i18n 标签键在 zh-CN 与 en 中都存在', () => {
    for (const preset of CURVE_TONE_PRESETS) {
      expect(i18n.exists(preset.labelKey, { lng: 'zh-CN' })).toBe(true);
      expect(i18n.exists(preset.labelKey, { lng: 'en' })).toBe(true);
    }
  });
});
