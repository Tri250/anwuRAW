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
  values: Pick<Adjustments, 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'saturation' | 'tint'>;
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

/* ============ 治理域定义（从 Basic.tsx 下沉到数据层，供面板与 hooks 共用） ============ */

/** 场景治理域：14 基础键中性值（场景切换的归零基准，域外参数一律保留） */
export const SCENE_SCOPE_DEFAULTS: Partial<Adjustments> = {
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
};

/** 胶片治理域：仅 LUT 字段（胶片 = 内置 LUT 选择，不触碰任何滑块） */
export const FILM_SCOPE_DEFAULTS: Partial<Adjustments> = {
  lutPath: null,
  lutName: null,
  lutData: null,
  lutSize: 0,
  lutIntensity: 100,
  lutIsSceneReferred: false,
};

/** 大师配方治理域：场景 14 基础键 + HSL + LUT 字段（完整外观） */
export const RECIPE_SCOPE_DEFAULTS: Partial<Adjustments> = {
  ...SCENE_SCOPE_DEFAULTS,
  hsl: createIdentityHsl(),
  ...FILM_SCOPE_DEFAULTS,
};

/**
 * 配方参数超集清理（跨组切换共用）：14 基础键归零 + HSL 回归中性。
 * 语义：配方完整外观 = 14 基础键 + HSL + LUT；切换到场景/胶片/其他 LUT 时，
 * 配方超出目标治理域的部分（至少 HSL）由调用方用此常量清除，LUT 字段由调用方覆写。
 * 用于 Basic 面板互斥切换、Effects 面板 handleLutSelect/handleLutClear 三条链路，
 * 保证「配方 → 任意其他外观」不留参数混合残留。
 */
export const RECIPE_PARAMETER_RESET: Partial<Adjustments> = {
  ...SCENE_SCOPE_DEFAULTS,
  hsl: createIdentityHsl(),
};

/** 大师配方激活态比对键：14 基础键 + hsl（逐值）+ lutName（配方名作为稳定标识） */
const RECIPE_MATCH_KEYS = [...Object.keys(SCENE_SCOPE_DEFAULTS), 'hsl', 'lutName'] as const;

/** 由当前调整值实时推导激活的配方 id（撤销/手动微调会自动退出激活态，调回自动恢复） */
export const getActiveRecipeId = (adjustments: Partial<Adjustments>): string | null => {
  for (const recipe of MASTER_RECIPES) {
    const resolved = { ...RECIPE_SCOPE_DEFAULTS, ...recipeToAdjustmentValues(recipe) };
    const isMatch = RECIPE_MATCH_KEYS.every((key) => {
      if (key === 'hsl') return isHslEqual(adjustments.hsl, resolved.hsl);
      return adjustments[key] === resolved[key];
    });
    if (isMatch) return recipe.id;
  }
  return null;
};

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
  // 深拷贝 HSL 通道,避免调用方写入调整状态时污染模块级配方常量
  hsl: Object.fromEntries(
    Object.entries(recipe.hsl).map(([channel, values]) => [channel, { ...values }]),
  ) as Adjustments['hsl'],
  lutName: recipe.name,
  lutIntensity: 100,
  lutIsSceneReferred: false,
});

/** 逐值比较两份 HSL(引用不同但值一致视为相等) */
export const isHslEqual = (a: Adjustments['hsl'] | undefined, b: Adjustments['hsl'] | undefined): boolean =>
  HSL_CHANNELS.every((channel) => {
    const left = a?.[channel];
    const right = b?.[channel];
    return left?.hue === right?.hue && left?.saturation === right?.saturation && left?.luminance === right?.luminance;
  });
