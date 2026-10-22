import { motion } from 'framer-motion';
import clsx from 'clsx';
import Slider from '../ui/Slider';
import { Adjustments, BasicAdjustment, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import {
  FILM_SCOPE_DEFAULTS,
  getActiveRecipeId,
  MASTER_RECIPES,
  MasterRecipeDef,
  recipeToAdjustmentValues,
  RECIPE_PARAMETER_RESET,
  RECIPE_SCOPE_DEFAULTS,
  SCENE_SCOPE_DEFAULTS,
} from '../../utils/masterRecipes';

// 保持既有导入路径兼容：测试与外部模块从 Basic 导入 getActiveRecipeId
export { getActiveRecipeId };
import { useEffect, useRef, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface BasicAdjustmentsProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
  appSettings?: any;
  onAutoAdjust?: () => void;
}

/**
 * 一键场景/风格增强 —— 端侧真实实现。
 * 每个场景是一组经过校准的调整参数，直接经由现有调整管线实时作用于像素。
 * 「自动」复用后端 perform_auto_analysis 直方图自动分析。
 *
 * 本面板由三组「外观」构成（融合自 RawLab/koudaixiangce 的大师配方与胶片坞）：
 * - 场景：4 组校准参数预设，治理域仅覆盖 14 个基础键；
 * - 大师配方：14 组完整摄影风格（参数 + 8 通道 HSL + 内置风格 LUT），治理域覆盖
 *   14 基础键 + HSL + LUT 字段（完整外观，保证「同一配方 = 同一结果」）；
 * - 胶片：内置胶片模拟 LUT（display 网格之外的 scene-referred 内置片装），仅治理 LUT 字段。
 *
 * 确定性语义：各治理域在应用时先归零再叠加校准值，保证「同一外观 = 同一结果」，
 * 切换外观不会残留上一外观的参数；域外参数（亮度、结构、曲线、锐化、蒙版等用户创作
 * 意图）一律保留。应用时同步强制开启参数所属 section，避免 section 被 eye 隐藏后
 * 写入管线时被归零失效。激活态由当前值推导而非点击记忆。
 *
 * 治理域常量（SCENE/FILM/RECIPE_SCOPE_DEFAULTS、RECIPE_PARAMETER_RESET、getActiveRecipeId）
 * 定义于 utils/masterRecipes.ts 数据层，此处与 useEditorActions/Effects 链路共用。
 */

/** 场景预设写入的参数所属 section（与 SCENE_SCOPE_DEFAULTS 的键一一对应） */
const SCENE_SECTIONS = ['basic', 'color', 'details'] as const;

/** 大师配方额外写入 HSL（color）与 LUT（effects） */
const RECIPE_SECTIONS = ['basic', 'color', 'details', 'effects'] as const;
/** 胶片仅写入 LUT 字段（effects） */
const FILM_SECTIONS = ['effects'] as const;

interface SceneEnhanceOptions {
  labelKey: string;
  /** 在治理域默认值之上叠加的场景校准参数（真实生效） */
  values: Partial<Adjustments>;
}

const SCENE_ENHANCE: SceneEnhanceOptions[] = [
  {
    labelKey: 'adjustments.basic.scene.prototypePortrait',
    values: {
      contrast: 6,
      highlights: -10,
      shadows: 14,
      saturation: -4,
      vibrance: 10,
      clarity: 10,
    },
  },
  {
    labelKey: 'adjustments.basic.scene.prototypeLandscape',
    values: {
      contrast: 12,
      highlights: -8,
      shadows: 12,
      saturation: 20,
      vibrance: 16,
      clarity: 16,
      dehaze: 14,
    },
  },
  {
    labelKey: 'adjustments.basic.scene.prototypeNight',
    values: {
      exposure: 0.5,
      highlights: -22,
      shadows: 28,
      whites: -4,
      blacks: 4,
      saturation: 8,
      vibrance: 8,
      lumaNoiseReduction: 24,
      colorNoiseReduction: 18,
    },
  },
  {
    labelKey: 'adjustments.basic.scene.prototypeWarmSunset',
    values: {
      exposure: 0.12,
      contrast: 5,
      highlights: -12,
      shadows: 10,
      temperature: 16,
      vibrance: 18,
      saturation: 8,
    },
  },
];

/**
 * 判定当前调整状态是否与某个场景完全一致（治理域 14 键逐键比对）。
 * 用于切换态高亮与「再次点击还原」：状态由值推导而非点击记忆，
 * 撤销/重置/手动微调后高亮自然消失，手动调回场景值则自然恢复。
 */
export const getActiveSceneLabelKey = (adjustments: Partial<Adjustments>): string | null => {
  const SCENE_SCOPE_KEYS = Object.keys(SCENE_SCOPE_DEFAULTS) as Array<keyof typeof SCENE_SCOPE_DEFAULTS>;
  for (const preset of SCENE_ENHANCE) {
    const resolved = { ...SCENE_SCOPE_DEFAULTS, ...preset.values };
    const isMatch = SCENE_SCOPE_KEYS.every((key) => adjustments[key] === resolved[key]);
    if (isMatch) return preset.labelKey;
  }
  return null;
};

/** 运行时从 list_recipe_luts 解析出的配方 LUT 绝对路径映射（lutFileName → path） */
export const mapRecipeLutPaths = (entries: Array<{ name: string; path: string }> | null | undefined) => {
  const map: Record<string, string> = {};
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.name && entry?.path) map[entry.name] = entry.path;
    }
  }
  return map;
};

interface BuiltInLut {
  name: string;
  path: string;
}

interface ToneMapperSwitchProps {
  selectedMapper: string;
  onMapperChange: (mapper: string) => void;
  evShiftValue: number;
  onEvShiftChange: (value: number) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const ToneMapperSwitch = ({
  selectedMapper,
  onMapperChange,
  evShiftValue,
  onEvShiftChange,
  onDragStateChange,
}: ToneMapperSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const toneMapperOptions = useMemo(
    () => [
      {
        id: 'basic',
        label: t('adjustments.basic.mappers.basic'),
        title: t('adjustments.basic.mappers.basicDesc'),
      },
      {
        id: 'reinhard',
        label: t('adjustments.basic.mappers.reinhard'),
        title: t('adjustments.basic.mappers.reinhardDesc'),
      },
      {
        id: 'filmic',
        label: t('adjustments.basic.mappers.filmic'),
        title: t('adjustments.basic.mappers.filmicDesc'),
      },
      {
        id: 'agx',
        label: t('adjustments.basic.mappers.agx'),
        title: t('adjustments.basic.mappers.agxDesc'),
      },
      {
        id: 'gamma',
        label: t('adjustments.basic.mappers.gamma'),
        title: t('adjustments.basic.mappers.gammaDesc'),
      },
    ],
    [t],
  );

  const handleReset = () => {
    onMapperChange('basic');
    onEvShiftChange(0);
  };

  useEffect(() => {
    const selectedIndex = toneMapperOptions.findIndex((m) => m.id === selectedMapper);
    const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const widthPercent = 100 / toneMapperOptions.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      let initialX;
      if (selectedMapper === 'agx') {
        initialX = `${(toneMapperOptions.length - 1) * 100}%`;
      } else {
        initialX = '-25%';
      }

      setBubbleStyle({
        x: [initialX, targetX],
        width: targetWidth,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [selectedMapper, toneMapperOptions]);

  return (
    <div className="group mb-3">
      <div className="flex justify-between items-center mb-2">
        <div
          className="grid cursor-pointer"
          onClick={handleReset}
          onDoubleClick={handleReset}
          onMouseEnter={() => setIsLabelHovered(true)}
          onMouseLeave={() => setIsLabelHovered(false)}
        >
          <span
            aria-hidden={isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
              isLabelHovered ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {t('adjustments.basic.toneMapper')}
          </span>
          <span
            aria-hidden={!isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
              isLabelHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {t('adjustments.basic.reset')}
          </span>
        </div>
      </div>
      <div className="w-full p-2 pb-1 bg-card-active rounded-md">
        <div className="relative flex w-full overflow-x-auto no-scrollbar">
          <motion.div
            className="absolute top-0 bottom-0 z-0 bg-accent"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
          {toneMapperOptions.map((mapper) => (
            <button
              key={mapper.id}
              type="button"
              data-tooltip={mapper.title}
              onClick={() => onMapperChange(mapper.id)}
              className={clsx(
                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                {
                  'text-text-primary hover:bg-surface': selectedMapper !== mapper.id,
                  'text-button-text': selectedMapper === mapper.id,
                },
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <span className="relative z-10 flex items-center">{mapper.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-2.5 px-1">
          <Slider
            label={t('adjustments.basic.evShift')}
            max={5}
            min={-5}
            onChange={(e: any) => onEvShiftChange(parseFloat(e.target.value))}
            step={0.01}
            value={evShiftValue}
            trackClassName="bg-surface"
            onDragStateChange={onDragStateChange}
          />
        </div>
      </div>
    </div>
  );
};

export default function BasicAdjustments({
  adjustments,
  setAdjustments,
  isForMask = false,
  onDragStateChange,
  appSettings,
  onAutoAdjust,
}: BasicAdjustmentsProps) {
  const { t } = useTranslation();

  const handleAdjustmentChange = (key: BasicAdjustment, value: any) => {
    const numericValue = parseFloat(value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleToneMapperChange = (mapper: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      // 完整映射真实支持的 5 种 tone mapper（basic/agx/reinhard/filmic/gamma），
      // 与后端 tonemapper_mode 分支完全一致，避免类型收窄掩盖非法值。
      toneMapper: mapper as Adjustments['toneMapper'],
    }));
  };

  // 当前激活的外观（由当前值推导），用于切换高亮与再次点击还原
  const activeSceneLabelKey = useMemo(() => getActiveSceneLabelKey(adjustments), [adjustments]);
  const activeRecipeId = useMemo(() => getActiveRecipeId(adjustments), [adjustments]);
  const hasActiveLut = Boolean(adjustments.lutPath);

  // 胶片组 = 后端内置胶片模拟 LUT（与 Effects 面板 filmEmulations 同源）
  const [builtInFilms, setBuiltInFilms] = useState<BuiltInLut[]>([]);
  // 大师配方 LUT 文件运行时路径（lutFileName → 绝对路径）
  const [recipeLutPaths, setRecipeLutPaths] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isForMask) return;
    let isActive = true;
    invoke<Array<{ name: string; path: string; isBuiltIn: boolean }>>('list_luts')
      .then((list) => {
        if (!isActive) return;
        const entries = Array.isArray(list) ? list : [];
        setBuiltInFilms(
          entries.filter((entry) => entry.isBuiltIn).map((entry) => ({ name: entry.name, path: entry.path })),
        );
      })
      .catch((err) => console.error('Failed to list built-in films:', err));
    invoke<Array<{ name: string; path: string }>>('list_recipe_luts')
      .then((list) => {
        if (isActive) setRecipeLutPaths(mapRecipeLutPaths(list));
      })
      .catch((err) => console.error('Failed to list master recipe LUTs:', err));
    return () => {
      isActive = false;
    };
  }, [isForMask]);

  /**
   * 配方 LUT 路径自愈：内置资源路径依赖安装位置（如 AppImage 挂载点每次启动都会变化），
   * 旧会话持久化的绝对路径在新会话可能失效，渲染管线会静默跳过 LUT。
   * 配方以 lutName 作为稳定标识，运行时重新解析到有效路径时回写 lutPath，
   * 保证「同一配方 = 同一外观」跨会话成立。
   */
  useEffect(() => {
    if (isForMask || !adjustments.lutName) return;
    const recipe = MASTER_RECIPES.find((item) => item.name === adjustments.lutName);
    if (!recipe) return;
    const resolvedPath = recipeLutPaths[recipe.lutFileName];
    if (!resolvedPath || resolvedPath === adjustments.lutPath) return;
    setAdjustments((prev: Partial<Adjustments>) => (prev.lutName === recipe.name ? { lutPath: resolvedPath } : {}));
  }, [adjustments.lutName, adjustments.lutPath, isForMask, recipeLutPaths, setAdjustments]);

  /** 预热后端 LUT 缓存并回填 lutSize（渲染管线亦可按需加载，此处仅加速与补元数据） */
  const warmLutCache = (path: string) => {
    invoke<{ size: number }>('load_and_parse_lut', { path })
      .then((result) => {
        setAdjustments((prev: Partial<Adjustments>) =>
          prev.lutPath === path && prev.lutSize !== result.size ? { ...prev, lutSize: result.size } : prev,
        );
      })
      .catch(() => {});
  };

  const forceSections = (prev: Partial<Adjustments>, sections: readonly string[]) => {
    const prevVisibility = prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility;
    // 强制开启外观参数所属 section：被 eye 隐藏的 section 在后端 get_val 中会被归零，
    // 不开启会导致外观参数写入管线时静默失效
    const sectionVisibility = { ...prevVisibility };
    for (const section of sections) {
      sectionVisibility[section] = true;
    }
    return sectionVisibility;
  };

  const applySceneEnhance = (target: SceneEnhanceOptions) => {
    const isActive = target.labelKey === activeSceneLabelKey;
    // 切换语义：点不同场景 = 治理域归零后叠加新场景校准值；
    // 再次点击已激活场景 = 退出场景，治理域回归中性（其余参数一律保留）
    const sceneValues = isActive ? SCENE_SCOPE_DEFAULTS : { ...SCENE_SCOPE_DEFAULTS, ...target.values };
    // 跨组切换：配方完整激活时点场景 = 完全退出配方，额外清除配方超集部分（HSL + LUT 字段），
    // 否则场景高亮但配方 LUT/HSL 仍在渲染，违反「同一场景 = 同一结果」。
    // 胶片 LUT 与场景治理域不相交（可叠加），一律保留；配方 tint 恒非零、场景 tint 恒为零，
    // 两激活态互斥，不会误清用户叠加的胶片。
    const recipeSuperset: Partial<Adjustments> = activeRecipeId
      ? { ...RECIPE_PARAMETER_RESET, ...FILM_SCOPE_DEFAULTS }
      : {};
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      ...recipeSuperset,
      ...sceneValues,
      sectionVisibility: forceSections(prev, SCENE_SECTIONS),
    }));
  };

  const applyMasterRecipe = (recipe: MasterRecipeDef) => {
    const lutPath = recipeLutPaths[recipe.lutFileName];
    const isActive = recipe.id === activeRecipeId;
    // 退出语义：再次点击已激活配方 = 治理域回归中性（域外参数保留）。
    // 即使外观文件缺失也允许退出，避免卡在无法取消的激活态
    if (isActive) {
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        ...RECIPE_SCOPE_DEFAULTS,
        sectionVisibility: forceSections(prev, RECIPE_SECTIONS),
      }));
      return;
    }
    // 应用语义：治理域（14 基础键 + HSL + LUT）归零后叠加新配方。
    // 外观文件缺失（未随包/加载失败）时不落参数，保持「配方 = 完整外观」的保真语义
    if (!lutPath) return;
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      ...RECIPE_SCOPE_DEFAULTS,
      ...recipeToAdjustmentValues(recipe),
      lutPath,
      sectionVisibility: forceSections(prev, RECIPE_SECTIONS),
    }));
    warmLutCache(lutPath);
  };

  const applyFilm = (film: BuiltInLut | null) => {
    // null = 「中性」：清除 LUT 回归无外观
    const isActive = film ? adjustments.lutPath === film.path : !hasActiveLut;
    // 跨组切换：配方完整激活时选胶片（含「中性」）= 完全退出配方，额外清除配方参数与 HSL，
    // 否则胶片 LUT 叠在配方参数上的混合残留违反确定性；
    // 场景与胶片治理域不相交（可叠加），场景参数一律保留
    const recipeOverride: Partial<Adjustments> = activeRecipeId && !isActive ? RECIPE_PARAMETER_RESET : {};
    const filmValues: Partial<Adjustments> =
      film && !isActive
        ? {
            ...recipeOverride,
            ...FILM_SCOPE_DEFAULTS,
            lutPath: film.path,
            lutName: film.name,
            lutIsSceneReferred: true,
          }
        : { ...recipeOverride, ...FILM_SCOPE_DEFAULTS };
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      ...filmValues,
      sectionVisibility: forceSections(prev, FILM_SECTIONS),
    }));
    if (film && !isActive) warmLutCache(film.path);
  };

  const hideTonemapper = isForMask || appSettings?.tonemapperOverrideEnabled;

  const chipClass = (isActive: boolean) =>
    clsx(
      'px-2.5 py-1 text-xs rounded-md transition-colors',
      isActive
        ? 'bg-accent text-button-text hover:opacity-90'
        : 'bg-surface-secondary text-text-secondary hover:bg-surface hover:text-text-primary',
    );

  return (
    <div>
      {!isForMask && (
        <div className="p-2 bg-bg-tertiary rounded-md mb-4 space-y-3">
          <div>
            <Text variant={TextVariants.heading} className="mb-2">
              {t('adjustments.basic.scene.title')}
            </Text>
            <div className="flex flex-wrap items-center gap-1.5">
              {onAutoAdjust && (
                <button
                  type="button"
                  onClick={onAutoAdjust}
                  data-tooltip={t('adjustments.basic.scene.autoDesc')}
                  className="px-2.5 py-1 text-xs rounded-md transition-colors bg-accent text-button-text hover:opacity-90"
                >
                  {t('adjustments.basic.scene.auto')}
                </button>
              )}
              {SCENE_ENHANCE.map((preset) => {
                const isActive = preset.labelKey === activeSceneLabelKey;
                return (
                  <button
                    key={preset.labelKey}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => applySceneEnhance(preset)}
                    className={chipClass(isActive)}
                  >
                    {t(preset.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Text variant={TextVariants.heading} className="mb-2">
              {t('adjustments.basic.scene.masterRecipes')}
            </Text>
            <div className="flex flex-wrap items-center gap-1.5">
              {MASTER_RECIPES.map((recipe) => {
                const lutPath = recipeLutPaths[recipe.lutFileName];
                const isActive = recipe.id === activeRecipeId;
                const isAvailable = Boolean(lutPath);
                const subtitle = t(`adjustments.basic.scene.recipes.${recipe.id}.subtitle`);
                const summary = t(`adjustments.basic.scene.recipes.${recipe.id}.summary`);
                // disabled 表单元素不派发 mouseover，data-tooltip 会永不可见，
                // 用户无从得知缺失原因——改用 aria-disabled + 点击守卫，tooltip 正常弹出
                return (
                  <button
                    key={recipe.id}
                    type="button"
                    aria-pressed={isActive}
                    aria-disabled={!isAvailable && !isActive}
                    onClick={() => {
                      if (!isAvailable && !isActive) return;
                      applyMasterRecipe(recipe);
                    }}
                    data-tooltip={
                      isActive
                        ? `${recipe.name} · ${t('adjustments.basic.scene.recipeActiveHint')}`
                        : isAvailable
                          ? `${recipe.name} · ${subtitle}\n${summary}`
                          : `${recipe.name} · ${t('adjustments.basic.scene.recipeLutMissing')}`
                    }
                    className={clsx(chipClass(isActive), !isAvailable && !isActive && 'opacity-50 cursor-not-allowed')}
                  >
                    {recipe.name}
                  </button>
                );
              })}
            </div>
          </div>

          {builtInFilms.length > 0 && (
            <div>
              <Text variant={TextVariants.heading} className="mb-2">
                {t('adjustments.basic.scene.films')}
              </Text>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={!hasActiveLut}
                  onClick={() => applyFilm(null)}
                  className={chipClass(!hasActiveLut)}
                >
                  {t('adjustments.basic.scene.filmsNeutral')}
                </button>
                {builtInFilms.map((film) => {
                  const isActive = adjustments.lutPath === film.path;
                  return (
                    <button
                      key={film.path}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => applyFilm(film)}
                      data-tooltip={film.name}
                      className={chipClass(isActive)}
                    >
                      {film.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {hideTonemapper ? (
        <Slider
          label={t('adjustments.basic.evShift')}
          max={5}
          min={-5}
          onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Exposure, e.target.value)}
          step={0.01}
          value={adjustments.exposure}
          onDragStateChange={onDragStateChange}
        />
      ) : (
        <ToneMapperSwitch
          selectedMapper={adjustments.toneMapper || 'basic'}
          onMapperChange={handleToneMapperChange}
          evShiftValue={adjustments.exposure}
          onEvShiftChange={(value) => handleAdjustmentChange(BasicAdjustment.Exposure, value)}
          onDragStateChange={onDragStateChange}
        />
      )}
      <Slider
        label={t('adjustments.basic.brightness')}
        max={5}
        min={-5}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Brightness, e.target.value)}
        step={0.01}
        value={adjustments.brightness}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.contrast')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Contrast, e.target.value)}
        step={1}
        value={adjustments.contrast}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.highlights')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Highlights, e.target.value)}
        step={1}
        value={adjustments.highlights}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.shadows')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Shadows, e.target.value)}
        step={1}
        value={adjustments.shadows}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.whites')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Whites, e.target.value)}
        step={1}
        value={adjustments.whites}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.blacks')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Blacks, e.target.value)}
        step={1}
        value={adjustments.blacks}
        onDragStateChange={onDragStateChange}
      />
    </div>
  );
}
