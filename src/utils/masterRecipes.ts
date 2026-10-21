import type { Adjustments, HueSatLum } from './adjustments';

/**
 * 大师配方数据层 —— 移植自 RawLab(koudaixiangce) Shared/master-recipes.json。
 *
 * 每个配方 = 一组经校准的调整参数增量(曝光/对比度/高光/阴影/饱和度/色调)
 * + 8 通道 HSL 微调 + 一枚内置风格 LUT(resources/master_recipe_luts, display-referred)。
 *
 * koudai 源数据的 HSL 为 8 通道数组, 通道顺序与本应用一致:
 * reds/oranges/yellows/greens/aquas/blues/purples/magentas(0-7),
 * 轴映射: hue→hue, saturation→saturation, lightness→luminance, 值域均为 -100..100。
 */

export interface MasterRecipeDef {
  id: string;
  /** 摄影师/风格名(专有名词, 不参与翻译, 与源项目一致) */
  name: string;
  /** 内置 LUT 文件名(不含扩展名, 由 list_recipe_luts 在运行时解析为绝对路径) */
  lutFileName: string;
  /** 治理域内叠加的校准参数(在 RECIPE_SCOPE_DEFAULTS 之上) */
  values: Pick<
    Adjustments,
    'exposure' | 'contrast' | 'highlights' | 'shadows' | 'saturation' | 'tint'
  >;
  hsl: Adjustments['hsl'];
}

type HslChannelName = 'reds' | 'oranges' | 'yellows' | 'greens' | 'aquas' | 'blues' | 'purples' | 'magentas';

const HSL_CHANNELS: HslChannelName[] = [
  'reds',
  'oranges',
  'yellows',
  'greens',
  'aquas',
  'blues',
  'purples',
  'magentas',
];

const neutralChannel = (): HueSatLum => ({ hue: 0, saturation: 0, luminance: 0 });

export const createIdentityHsl = (): Adjustments['hsl'] =>
  Object.fromEntries(HSL_CHANNELS.map((name) => [name, neutralChannel()])) as Adjustments['hsl'];

type HslPatch = Partial<Record<HslChannelName, Partial<HueSatLum>>>;

/** 由部分覆盖值构建完整 8 通道 HSL(未覆盖通道保持中性) */
const buildHsl = (patch: HslPatch = {}): Adjustments['hsl'] => {
  const hsl = createIdentityHsl();
  for (const channel of HSL_CHANNELS) {
    const overrides = patch[channel];
    if (overrides) Object.assign(hsl[channel], overrides);
  }
  return hsl;
};

export const MASTER_RECIPES: MasterRecipeDef[] = [
  {
    id: 'hamada_daylight_v2',
    name: '滨田英明',
    lutFileName: 'hamada_daylight_pro_v2',
    values: { exposure: 0.4, contrast: -15, highlights: -15, shadows: 20, saturation: -8, tint: 5 },
    hsl: buildHsl({
      yellows: { hue: 1 },
      aquas: { luminance: -1, saturation: 4 },
      oranges: { saturation: 1 },
      blues: { saturation: 1 },
    }),
  },
  {
    id: 'takashi_yasui_zen',
    name: '保井崇志',
    lutFileName: 'takashi_yasui_zen',
    values: { exposure: 0, contrast: 30, highlights: -35, shadows: -25, saturation: -15, tint: 2 },
    hsl: buildHsl(),
  },
  {
    id: 'takahiro_sakai_blue',
    name: '酒井贵弘',
    lutFileName: 'takahiro_sakai_blue',
    values: { exposure: 0.35, contrast: -15, highlights: -25, shadows: 35, saturation: -10, tint: 4 },
    hsl: buildHsl({
      oranges: { hue: 1, saturation: 2 },
      reds: { saturation: 1 },
      yellows: { saturation: 1 },
      aquas: { hue: -1, saturation: 1 },
    }),
  },
  {
    id: 'withluke_epic',
    name: 'withluke',
    lutFileName: 'withluke_epic',
    values: { exposure: 0.1, contrast: 10, highlights: -30, shadows: 25, saturation: -12, tint: -2 },
    hsl: buildHsl({ aquas: { saturation: -1 } }),
  },
  {
    id: 'daniel_casson_autumn',
    name: 'Daniel Casson',
    lutFileName: 'daniel_casson_autumn',
    values: { exposure: 0.15, contrast: 15, highlights: -25, shadows: 25, saturation: 5, tint: -3 },
    hsl: buildHsl(),
  },
  {
    id: 'billy_dinh_cinema',
    name: 'Billy Dinh',
    lutFileName: 'billy_dinh_cinema',
    values: { exposure: -0.2, contrast: 25, highlights: -30, shadows: -15, saturation: -10, tint: 2 },
    hsl: buildHsl(),
  },
  {
    id: 'rkrkrk_cyberpunk',
    name: 'rkrkrk',
    lutFileName: 'rkrkrk_cyberpunk',
    values: { exposure: 0, contrast: 25, highlights: -40, shadows: 25, saturation: 15, tint: 5 },
    hsl: buildHsl(),
  },
  {
    id: 'samalive_vintage',
    name: 'Samalive',
    lutFileName: 'samalive_vintage',
    values: { exposure: 0.15, contrast: -5, highlights: -25, shadows: 20, saturation: 5, tint: 4 },
    hsl: buildHsl(),
  },
  {
    id: 'iwona_fairy_tale',
    name: 'Iwona',
    lutFileName: 'iwona_fairy_tale',
    values: { exposure: 0.1, contrast: -15, highlights: -20, shadows: 15, saturation: -5, tint: 3 },
    hsl: buildHsl({
      reds: { hue: -1 },
      oranges: { saturation: 1 },
      aquas: { hue: 1, saturation: 1 },
      blues: { hue: 1, saturation: 2 },
    }),
  },
  {
    id: 'cinestill_800t',
    name: 'CineStill 800T',
    lutFileName: 'cinestill_800t',
    values: { exposure: 0.1, contrast: 10, highlights: -35, shadows: 20, saturation: 10, tint: -5 },
    hsl: buildHsl(),
  },
  {
    id: 'wilson_lee_golden',
    name: 'Wilson Lee',
    lutFileName: 'wilson_lee_golden',
    values: { exposure: 0.25, contrast: -10, highlights: -20, shadows: 20, saturation: 0, tint: 3 },
    hsl: buildHsl({
      reds: { saturation: 2 },
      blues: { hue: 1, saturation: 2 },
      aquas: { saturation: 1 },
      purples: { saturation: 1 },
      magentas: { saturation: 1 },
    }),
  },
  {
    id: 'luizclas_portrait',
    name: 'Luiz Clas',
    lutFileName: 'luizclas_portrait',
    values: { exposure: 0.2, contrast: 10, highlights: -35, shadows: 25, saturation: 5, tint: 4 },
    hsl: buildHsl(),
  },
  {
    id: 'ivan_ivanchenko_twilight',
    name: 'Ivan Ivanchenko',
    lutFileName: 'ivan_ivanchenko_twilight',
    values: { exposure: 0.15, contrast: -20, highlights: -30, shadows: 25, saturation: -5, tint: 2 },
    hsl: buildHsl(),
  },
  {
    id: 'jungraphy_neon',
    name: 'Jungraphy',
    lutFileName: 'jungraphy_neon',
    values: { exposure: 0, contrast: 15, highlights: -35, shadows: 25, saturation: 15, tint: 8 },
    hsl: buildHsl(),
  },
];

/**
 * 配方写入调整状态的完整取值(lutPath 由运行时解析后由调用方补齐)。
 * lutName 使用配方名: 既作为 Effects/LUT 面板的显示名, 也作为激活态判定的稳定标识。
 */
export const recipeToAdjustmentValues = (recipe: MasterRecipeDef): Partial<Adjustments> => ({
  ...recipe.values,
  hsl: recipe.hsl,
  lutName: recipe.name,
  lutIntensity: 100,
  lutIsSceneReferred: false,
});

/** 逐值比较两份 HSL(引用不同但值一致视为相等) */
export const isHslEqual = (
  a: Adjustments['hsl'] | undefined,
  b: Adjustments['hsl'] | undefined,
): boolean =>
  HSL_CHANNELS.every((channel) => {
    const left = a?.[channel];
    const right = b?.[channel];
    return (
      left?.hue === right?.hue &&
      left?.saturation === right?.saturation &&
      left?.luminance === right?.luminance
    );
  });
