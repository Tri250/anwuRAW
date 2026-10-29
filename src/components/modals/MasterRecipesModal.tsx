import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Film, Palette, Sparkles, X } from 'lucide-react';
import { toast } from 'react-toastify';
import LUTControl from '../ui/LUTControl';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { Adjustments, getActiveTools, setToolActive } from '../../utils/adjustments';
import {
  MASTER_LUT_IS_SCENE_REFERRED,
  MASTER_RECIPES,
  MasterRecipe,
  RECIPE_INTENSITY_DEFAULT,
  RECIPE_INTENSITY_MAX,
  RecipeAdjustmentPatch,
  masterLutBaseName,
  masterRecipeArtworkUrl,
  recipeToAdjustments,
  resolveMasterLutEntry,
} from '../../utils/masterRecipes';
import { useEditorStore } from '../../store/useEditorStore';
import { useEditorActions } from '../../hooks/useEditorActions';

interface MasterRecipesModalProps {
  isOpen: boolean;
  onClose(): void;
}

interface LutEntry {
  name: string;
  path: string;
  isBuiltIn: boolean;
  isSceneReferred: boolean;
}

type RecipeTab = 'master' | 'film';

const RECIPE_TOOL_IDS = [
  'basic',
  'curves',
  'colorPresence',
  'whiteBalance',
  'colorMixer',
  'colorGrading',
  'presence',
  'lut',
];

const enableRecipeTools = (activeTools: Record<string, boolean>) =>
  RECIPE_TOOL_IDS.reduce((tools, id) => setToolActive(tools, id, true), activeTools);

const snapshotAdjustments = (current: Adjustments): RecipeAdjustmentPatch => ({
  exposure: current.exposure,
  shadows: current.shadows,
  highlights: current.highlights,
  contrast: current.contrast,
  saturation: current.saturation,
  tint: current.tint,
  blacks: current.blacks,
  whites: current.whites,
  vibrance: current.vibrance,
  clarity: current.clarity,
  dehaze: current.dehaze,
  hsl: current.hsl,
  curves: current.curves,
  pointCurves: current.pointCurves,
  curveMode: current.curveMode,
  colorGrading: current.colorGrading,
  lutPath: current.lutPath,
  lutName: current.lutName,
  lutIntensity: current.lutIntensity,
  lutIsSceneReferred: current.lutIsSceneReferred,
  activeTools: current.activeTools,
});

export default function MasterRecipesModal({ isOpen, onClose }: MasterRecipesModalProps) {
  const { t } = useTranslation();
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const adjustments = useEditorStore((state) => state.adjustments);
  const setEditor = useEditorStore((state) => state.setEditor);
  const { setAdjustments, handleLutSelect, setLutPreviewOverride } = useEditorActions();

  const [tab, setTab] = useState<RecipeTab>('master');
  const [luts, setLuts] = useState<Array<LutEntry>>([]);
  const [isLoadingLuts, setIsLoadingLuts] = useState(false);
  const [activeRecipeId, setActiveRecipeId] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(RECIPE_INTENSITY_DEFAULT);
  const previousAdjustments = useRef<RecipeAdjustmentPatch | null>(null);

  const currentImagePath = selectedImage?.path ?? null;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let isCancelled = false;
    setIsLoadingLuts(true);
    invoke<Array<LutEntry>>('list_master_luts')
      .then((entries) => {
        if (!isCancelled) {
          setLuts(entries);
        }
      })
      .catch((error) => {
        console.error('Failed to list LUTs for master recipes:', error);
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingLuts(false);
        }
      });
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !currentImagePath) {
      return;
    }
    setActiveRecipeId(null);
    previousAdjustments.current = null;
    setIntensity(RECIPE_INTENSITY_DEFAULT);
  }, [isOpen, currentImagePath]);

  const activeRecipe = useMemo(
    () => MASTER_RECIPES.find((recipe) => recipe.id === activeRecipeId) ?? null,
    [activeRecipeId],
  );

  const handleApplyRecipe = useCallback(
    async (recipe: MasterRecipe) => {
      if (activeRecipeId === recipe.id) {
        const restore = previousAdjustments.current;
        if (restore) {
          setAdjustments((prev: Adjustments) => ({ ...prev, ...restore }));
        }
        previousAdjustments.current = null;
        setActiveRecipeId(null);
        setIntensity(RECIPE_INTENSITY_DEFAULT);
        return;
      }

      if (!activeRecipeId) {
        previousAdjustments.current = snapshotAdjustments(adjustments);
      }
      setActiveRecipeId(recipe.id);
      setIntensity(RECIPE_INTENSITY_DEFAULT);

      const patch = recipeToAdjustments(recipe, RECIPE_INTENSITY_DEFAULT);
      const entry = resolveMasterLutEntry(recipe, luts);

      // 与胶片 LUT 选择一致：先把 LUT 解析进后端缓存并验证可用，再写入渲染状态。
      // 否则损坏的 LUT 只会在主渲染时加载失败，画面表现为异常甚至全黑。
      let verifiedLutPath: string | null = null;
      let verifiedIsSceneReferred = MASTER_LUT_IS_SCENE_REFERRED;
      if (entry) {
        try {
          await invoke('load_and_parse_lut', { path: entry.path });
          verifiedLutPath = entry.path;
          verifiedIsSceneReferred = entry.isSceneReferred ?? MASTER_LUT_IS_SCENE_REFERRED;
        } catch (error) {
          console.error('Master recipe LUT failed to load:', error);
          toast.warn(t('editor.masterRecipes.missingLut', { name: recipe.name }));
        }
      } else {
        toast.warn(t('editor.masterRecipes.missingLut', { name: recipe.name }));
      }

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...patch,
        lutPath: verifiedLutPath,
        lutName: verifiedLutPath ? masterLutBaseName(recipe) : null,
        lutIntensity: verifiedLutPath ? RECIPE_INTENSITY_DEFAULT : 0,
        lutIsSceneReferred: verifiedIsSceneReferred,
        activeTools: enableRecipeTools(getActiveTools(prev)),
      }));
    },
    [activeRecipeId, adjustments, luts, setAdjustments, t],
  );

  const handleIntensityChange = useCallback(
    (value: number) => {
      if (!activeRecipe) {
        return;
      }
      setIntensity(value);
      const scaled = recipeToAdjustments(activeRecipe, value);
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...scaled,
        ...(prev.lutPath ? { lutIntensity: value } : {}),
      }));
    },
    [activeRecipe, setAdjustments],
  );

  const handleDragStateChange = useCallback(
    (isDragging: boolean) => {
      setEditor({ isSliderDragging: isDragging });
    },
    [setEditor],
  );

  const handleFilmLutSelect = useCallback(
    (path: string, isBuiltIn: boolean, isSceneReferred: boolean) => {
      setLutPreviewOverride(null);
      void handleLutSelect(path, isSceneReferred).catch((error) => {
        console.error('Failed to apply film look:', error);
      });
      void isBuiltIn;
    },
    [handleLutSelect, setLutPreviewOverride],
  );

  const handleFilmLutHover = useCallback(
    (path: string | null, isSceneReferred = true) => {
      setLutPreviewOverride(path, isSceneReferred);
    },
    [setLutPreviewOverride],
  );

  const handleFilmLutClear = useCallback(() => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      lutPath: null,
      lutName: null,
      lutIntensity: RECIPE_INTENSITY_DEFAULT,
      lutIsSceneReferred: false,
    }));
  }, [setAdjustments]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="flex h-full max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-bg-primary shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface px-5 py-3">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-accent" />
            <Text variant={TextVariants.title}>{t('editor.masterRecipes.title')}</Text>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
            data-tooltip={t('editor.masterRecipes.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-surface px-4 py-2">
          {(
            [
              { id: 'master' as RecipeTab, icon: Palette, label: t('editor.masterRecipes.tabs.master') },
              { id: 'film' as RecipeTab, icon: Film, label: t('editor.masterRecipes.tabs.film') },
            ] as const
          ).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === id ? 'bg-surface text-text-primary' : 'text-text-secondary hover:bg-surface/60'
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <div className="grow overflow-y-auto p-4">
          {!selectedImage ? (
            <div className="flex h-full items-center justify-center">
              <Text variant={TextVariants.heading} color={TextColors.secondary} weight={TextWeights.normal}>
                {t('editor.ai.noImageSelected')}
              </Text>
            </div>
          ) : tab === 'master' ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {MASTER_RECIPES.map((recipe) => {
                const isActive = recipe.id === activeRecipeId;
                return (
                  <button
                    key={recipe.id}
                    onClick={() => void handleApplyRecipe(recipe)}
                    className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
                      isActive ? 'border-accent bg-surface' : 'border-transparent bg-surface/50 hover:bg-surface'
                    }`}
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-bg-tertiary">
                      <img
                        src={masterRecipeArtworkUrl(recipe.id)}
                        alt={recipe.name}
                        className="h-full w-full object-cover"
                        draggable={false}
                        loading="lazy"
                      />
                      <AnimatePresence>
                        {isActive && (
                          <motion.span
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-button-text"
                          >
                            <Check size={14} />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="p-2">
                      <Text color={TextColors.primary} weight={TextWeights.medium} className="truncate">
                        {recipe.name}
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
                        {recipe.subtitle}
                      </Text>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Text variant={TextVariants.small} color={TextColors.secondary}>
                {t('editor.masterRecipes.filmHint')}
              </Text>
              <LUTControl
                lutPath={adjustments.lutPath ?? null}
                lutName={adjustments.lutName ?? null}
                lutIntensity={adjustments.lutIntensity ?? RECIPE_INTENSITY_DEFAULT}
                onLutSelect={handleFilmLutSelect}
                onLutHover={handleFilmLutHover}
                onClear={handleFilmLutClear}
                onIntensityChange={(value: number) =>
                  setAdjustments((prev: Adjustments) => ({ ...prev, lutIntensity: value }))
                }
                onDragStateChange={handleDragStateChange}
              />
            </div>
          )}
        </div>

        <AnimatePresence>
          {tab === 'master' && activeRecipe && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="shrink-0 overflow-hidden border-t border-surface"
            >
              <div className="px-5 py-3">
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  {activeRecipe.summary}
                </Text>
                <div className="mt-2">
                  <Slider
                    label={t('editor.masterRecipes.amount')}
                    min={0}
                    max={RECIPE_INTENSITY_MAX}
                    step={1}
                    value={intensity}
                    defaultValue={RECIPE_INTENSITY_DEFAULT}
                    onChange={(event) => handleIntensityChange(Number(event.target.value))}
                    onDragStateChange={handleDragStateChange}
                    fillOrigin="min"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {isLoadingLuts && (
          <div className="shrink-0 border-t border-surface px-5 py-2">
            <Text variant={TextVariants.small} color={TextColors.secondary}>
              {t('editor.masterRecipes.loadingLuts')}
            </Text>
          </div>
        )}
      </motion.div>
    </div>
  );
}
