import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Check, FileDown, FileUp, Loader2, Pencil, Plus, Save, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { usePresets, UserPreset } from '../../hooks/usePresets';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Adjustments, INITIAL_ADJUSTMENTS, applyStrength, getAiDenoiseEnablePatch } from '../../utils/adjustments';
import type { MaskContainer } from '../../utils/adjustments';
import { hasAiSubMasks, mergeAiMaskResults, stripAiMaskResults } from '../../utils/maskUtils';
import { Invokes, Preset } from '../ui/AppProperties';
import ConfirmModal from '../modals/ConfirmModal';
import { pushExitLayer, removeExitLayer } from '../../utils/androidBackRegistry';
import { CxSliderRow, awaitImageReady, haptic, summarizeExif, useCrystalAdjust } from './crystalShared';

/* ---------------------------------------------------------------------------
 * Crystal 移动端预设 / 滤镜面板。
 * - presets 模式：用户预设库（LoadPresets）+ AI 推荐卡（AiAutoEnhance 真实调用
 *   + 仅基于真实 EXIF 的场景启发，不伪造置信度）+ 强度混合（applyStrength）。
 *   v2.1.13 补齐管理闭环：保存当前为预设 / 导入（rrpreset/xmp/lrtemplate，
 *   Android content URI 过滤）/ 导出（单个与全部，Android 落 Downloads/RapidRaw）/
 *   长按动作面板（覆盖更新 / 重命名 / 删除）。含 AI 蒙版的预设与桌面同源：
 *   先剥离结果占位，再异步按当前图重新解析（ApplyAdjustmentsToPaths → LoadMetadata）。
 * - filter 模式：内置风格滤镜矩阵，全部为真实管线参数组合。
 * 缩略图与桌面 PresetsPanel 同源：GeneratePresetPreview 渲染队列。
 * ------------------------------------------------------------------------- */

type PanelMode = 'presets' | 'filter';

interface PreviewSource {
  id: string;
  name: string;
  adjustments: Record<string, unknown>;
  /** 所属分组：滤镜为 FilterGroup id，预设为文件夹名（分组过滤 + 全量解析共用） */
  group?: string;
}

/* ---------------------------- 内置滤镜（真实参数组合） ---------------------------- */
const BUILTIN_FILTERS: Array<{
  id: string;
  labelKey: ParseKeys;
  group: 'landscape' | 'portrait' | 'film' | 'mono';
  adjustments: Partial<Adjustments>;
}> = [
  {
    id: 'vivid',
    labelKey: 'crystal.filters.vivid',
    group: 'landscape',
    adjustments: { vibrance: 30, saturation: 8, contrast: 12, blacks: -10 },
  },
  {
    id: 'softMist',
    labelKey: 'crystal.filters.softMist',
    group: 'portrait',
    adjustments: { glowAmount: 30, highlights: 15, shadows: 12, dehaze: -8, contrast: -6 },
  },
  {
    id: 'film',
    labelKey: 'crystal.filters.film',
    group: 'film',
    adjustments: { contrast: 8, saturation: -12, grainAmount: 22, temperature: 6, blacks: -6 },
  },
  {
    id: 'mono',
    labelKey: 'crystal.filters.mono',
    group: 'mono',
    adjustments: { saturation: -100, contrast: 18, structure: 8, grainAmount: 14 },
  },
  {
    id: 'goldBlack',
    labelKey: 'crystal.filters.goldBlack',
    group: 'film',
    // 自检修复（v2.1.15 滤镜名实一致性）：shader.wgsl 中 vignetteAmount<0 才是
    // 压暗四角（乘法衰减），>0 是 mix 到白色的白边泛光——黑金需要「黑」角，
    // 原 +24 实际渲染成白边，与名称相反，改为 -24。
    adjustments: { temperature: 14, vibrance: 18, shadows: -12, blacks: -18, vignetteAmount: -24 },
  },
  {
    id: 'cyber',
    labelKey: 'crystal.filters.cyber',
    group: 'film',
    // 自检修复：white_balance.rs 中 tint 正值经白点相除后渲染为洋红偏移（与
    // Lightroom 一致），负值为绿偏移——赛博朋克标志色是青蓝底+品红霓虹，
    // 原 tint:-18 渲染成「黑客帝国」式绿调，改为 +14 与 temp:-14 组成蓝紫霓虹；
    // halationAmount 在高光处加暖色光晕，正对霓虹灯管泛光。
    adjustments: { tint: 14, temperature: -14, saturation: 22, contrast: 14, halationAmount: 16 },
  },
  {
    id: 'airy',
    labelKey: 'crystal.filters.airy',
    group: 'portrait',
    adjustments: { exposure: 0.25, contrast: -8, saturation: -8, temperature: -4, highlights: -10 },
  },
  {
    id: 'vintage',
    labelKey: 'crystal.filters.vintage',
    group: 'film',
    // 自检修复：同 goldBlack——vignetteAmount 正值是白边泛光，复古暗角应为负值。
    adjustments: { saturation: -18, temperature: 10, vignetteAmount: -20, grainAmount: 18, blacks: 12 },
  },
  {
    id: 'coolBlue',
    labelKey: 'crystal.filters.coolBlue',
    group: 'landscape',
    adjustments: { temperature: -18, tint: 4, contrast: 8 },
  },
  {
    id: 'goldenHour',
    labelKey: 'crystal.filters.goldenHour',
    group: 'landscape',
    adjustments: { temperature: 18, vibrance: 12, glowAmount: 10 },
  },
  {
    id: 'hdrPunch',
    labelKey: 'crystal.filters.hdrPunch',
    group: 'landscape',
    adjustments: { clarity: 24, structure: 14, contrast: 10, vibrance: 16, dehaze: 8 },
  },
  {
    id: 'faded',
    labelKey: 'crystal.filters.faded',
    group: 'film',
    adjustments: { contrast: -12, blacks: 16, saturation: -14, shadows: 10 },
  },
];

/* §3.2 滤镜子标签（全部/风景/人像/胶片/黑白），按滤镜真实调性归类 */
const FILTER_GROUPS: ReadonlyArray<{ id: 'landscape' | 'portrait' | 'film' | 'mono'; labelKey: ParseKeys }> = [
  { id: 'landscape', labelKey: 'crystal.filters.groupLandscape' },
  { id: 'portrait', labelKey: 'crystal.filters.groupPortrait' },
  { id: 'film', labelKey: 'crystal.filters.groupFilm' },
  { id: 'mono', labelKey: 'crystal.filters.groupMono' },
];

/* ---------------------------- 缩略图渲染队列（同桌面 PresetsPanel） ---------------------------- */
function usePresetPreviewQueue() {
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const previewsRef = useRef<Record<string, string | null>>({});
  const queueRef = useRef<Array<PreviewSource>>([]);
  const processingRef = useRef(false);
  const urlsRef = useRef<string[]>([]);
  const genRef = useRef(0);

  /** v2.1.13: 切图后作废全部缩略图与在途任务（旧图残留会误导滤镜选择） */
  const resetGeneration = useCallback(() => {
    genRef.current += 1;
    queueRef.current = [];
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    previewsRef.current = {};
    setPreviews({});
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current || queueRef.current.length === 0) return;
    processingRef.current = true;
    const gen = genRef.current;
    const pathAtStart = useEditorStore.getState().selectedImage?.path ?? null;

    while (queueRef.current.length > 0) {
      if (genRef.current !== gen) break;
      const item = queueRef.current.shift();
      if (!item) break;
      if (previewsRef.current[item.id] !== undefined) continue;

      try {
        const fullAdjustments = { ...INITIAL_ADJUSTMENTS, ...item.adjustments };
        const imageData: Uint8Array = await invoke(Invokes.GeneratePresetPreview, {
          jsAdjustments: fullAdjustments,
        });
        if (genRef.current !== gen) break;
        if (useEditorStore.getState().selectedImage?.path !== pathAtStart) continue;

        const blob = new Blob([new Uint8Array(imageData)], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        previewsRef.current[item.id] = url;
        setPreviews((prev) => ({ ...prev, [item.id]: url }));
      } catch (error) {
        const errStr = String(error);
        if (errStr.includes('No original image loaded') || errStr.includes('cancelled')) {
          queueRef.current = [];
          break;
        }
        console.error(`Crystal preview failed for ${item.name}:`, error);
        previewsRef.current[item.id] = null;
        setPreviews((prev) => ({ ...prev, [item.id]: null }));
      }
    }

    processingRef.current = false;
    // 代次切换后旧循环可能提前退出，此时队列里已有新任务，自恢复排空
    if (queueRef.current.length > 0) void processQueue();
  }, []);

  const enqueue = useCallback(
    (items: Array<PreviewSource>) => {
      const missing = items.filter((i) => previewsRef.current[i.id] === undefined);
      if (missing.length === 0) return;
      queueRef.current.push(...missing);
      processQueue();
    },
    [processQueue],
  );

  /** 单条失效（覆盖更新预设后旧缩略图不再可信）：撤销 URL 并清缓存，由调用方重新入队 */
  const invalidate = useCallback((id: string) => {
    const url = previewsRef.current[id];
    if (url) URL.revokeObjectURL(url);
    delete previewsRef.current[id];
    setPreviews((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      queueRef.current = [];
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  return { previews, enqueue, resetGeneration, invalidate };
}

/* ---------------------------- AI 推荐（真实像素场景识别 + 真实 AiAutoEnhance） ---------------------------- */
function firstNumber(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

interface SceneClassification {
  scene: string;
  confidence: number;
  tags: string[];
  /** 判别来源："clip" | "heuristic"（后端如实上报，二者置信度语义不同） */
  source?: string;
}

/* W3 边界：置信度 ≥0.75 才展示场景推荐（scene_classify 后端同门槛，前端二次门控） */
const SCENE_CONFIDENCE_GATE = 0.75;
type SceneKey = 'landscape' | 'portrait' | 'night' | 'food';

function AiRecommendCard() {
  const { t } = useTranslation();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [scene, setScene] = useState<SceneClassification | null>(null);
  const { applyPatch, setAdjustments } = useCrystalAdjust();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider);

  const exif = summarizeExif((selectedImage?.exif ?? null) as Record<string, unknown> | null);
  const iso = firstNumber(exif.iso);

  // 场景来自 scene_classify（真实像素统计，后端对「当前已加载原图」分类）。
  // 识别失败/低于门槛 → 静默降级：仅隐藏场景配方按钮，一键增强始终可用。
  // 审计修复（预设-AI推荐）：切图瞬间发起的 classify 会命中后端仍在解码的
  // 上一张图（或 No original image loaded），把旧图场景配方挂到新图——
  // 切图立即失效旧场景，并等 isReady（后端完成新图加载）后再识别。
  useEffect(() => {
    let cancelled = false;
    setScene(null);
    if (!selectedImage?.isReady)
      return () => {
        cancelled = true;
      };
    invoke<SceneClassification>(Invokes.SceneClassify)
      .then((result) => {
        if (!cancelled) setScene(result);
      })
      .catch(() => {
        /* 识别失败：静默降级，不阻塞编辑 */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedImage?.path, selectedImage?.isReady]);

  const sceneKey: SceneKey | null =
    scene && scene.confidence >= SCENE_CONFIDENCE_GATE ? (scene.scene as SceneKey) : null;

  const runAiEnhance = async () => {
    if (isEnhancing) return;
    setIsEnhancing(true);
    /* 闭环修复（预设-AI推荐）：与 AI 工具面板同款守卫——
     * 1) isReady 等待：后端 ai_auto_enhance 依赖 state.original_image，
     *    图片未加载完即点击会抛 "No image loaded for AI enhance"；
     * 2) 跨图守卫：切图后丢弃旧图增强结果，不合并进新图 adjustments；
     * 3) activeTools 合并：后端返回全 true，直接覆盖会把用户手动关掉的
     *    工具重新打开（桌面 handleAutoAdjustments mergeActiveTools 语义）。
     * v2.1.15 反馈闭环：此前所有提前 return 均为静默（加载超时/失败无任何
     * 提示，成功也无反馈，低幅度增强视觉变化细微）——用户感知为「点击无
     * 任何反应」。现除跨图丢弃外全路径给出 toast 反馈。 */
    const startPath = useEditorStore.getState().selectedImage?.path;
    if (!startPath) {
      setIsEnhancing(false);
      return;
    }
    try {
      if (!useEditorStore.getState().selectedImage?.isReady && !(await awaitImageReady(startPath))) {
        // 图片未就绪（仍在解码或加载失败）：静默 return 会被感知为死键
        toast.info(t('crystal.aiRecommend.notReady'));
        return;
      }
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      const result = await invoke<Partial<Adjustments>>(Invokes.AiAutoEnhance, { intensity: 'standard' });
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      // 与桌面 EditorToolbar 同源：经 setAdjustments → debounced pushHistory，
      // 保证 AI 增强结果进 50 步撤销栈（setEditor 直接写会绕过历史）。
      setAdjustments((prev) => ({
        ...prev,
        ...result,
        ...(result.activeTools ? { activeTools: { ...prev.activeTools, ...result.activeTools } } : {}),
      }));
      // 成功反馈：直方图增强在曝光良好的图上幅度小，无提示会被误读为无响应
      toast.success(t('crystal.aiRecommend.applied'));
    } catch (e) {
      console.error('AI enhance failed:', e);
      toast.error(t('crystal.aiRecommend.failed'));
    } finally {
      setIsEnhancing(false);
    }
  };

  // W3-3 推荐映射规则库：scene → 真实管线参数包（与 ai_auto_enhance 同写入路径）。
  // 反馈闭环修复（v2.1.16 Android：场景配方点击无反应）：
  // 1) 夜景分支原三元 `aiProvider ? AI降噪 : 经典降噪30` 恒走 AI——后端默认
  //    ai_provider 即 'cpu'（恒真），经典降噪是死代码；Android 上 NIND 需先
  //    下载模型（网络不通时静默失败）+ 端侧 CPU 推理可达分钟级，期间配方
  //    仅剩 shadows/blacks 微调，夜景暗部几乎不可感知 → 感知为点击无反应。
  //    现经典 NR 恒定生效（真实管线全平台立即可见），AI 降噪保留为可用时增量。
  // 2) 此前应用成功/未知场景均无任何提示（v2.1.15 一键增强同类问题），
  //    全路径补 toast 反馈；未知 sceneKey（按钮已渲染但无分支命中）不再静默。
  const applySceneRecipe = () => {
    if (sceneKey === 'portrait') {
      applyPatch({
        lumaNoiseReduction: Math.max(Number(useEditorStore.getState().adjustments.lumaNoiseReduction ?? 0), 18),
        clarity: 8,
        glowAmount: 20,
        vibrance: 8,
      });
      toast.success(t('crystal.aiRecommend.recipeApplied', { scene: t('crystal.aiRecommend.scenes.portrait') }));
    } else if (sceneKey === 'landscape') {
      applyPatch({ vibrance: 22, clarity: 14, dehaze: 10, contrast: 8 });
      toast.success(t('crystal.aiRecommend.recipeApplied', { scene: t('crystal.aiRecommend.scenes.landscape') }));
    } else if (sceneKey === 'night') {
      applyPatch({
        lumaNoiseReduction: Math.max(Number(useEditorStore.getState().adjustments.lumaNoiseReduction ?? 0), 30),
        ...(aiProvider ? getAiDenoiseEnablePatch(aiProvider) : {}),
        shadows: 14,
        blacks: -8,
      });
      toast.success(t('crystal.aiRecommend.recipeApplied', { scene: t('crystal.aiRecommend.scenes.night') }));
    } else if (sceneKey === 'food') {
      applyPatch({ vibrance: 16, saturation: 6, temperature: 6, contrast: 6, shadows: 8 });
      toast.success(t('crystal.aiRecommend.recipeApplied', { scene: t('crystal.aiRecommend.scenes.food') }));
    } else {
      // 防御：后端返回未映射场景时按钮仍会渲染（sceneKey 非空），不得静默
      toast.info(t('crystal.aiRecommend.noScene'));
    }
  };

  // 依据标签只陈述真实数据：EXIF（ISO/焦距）或后端画面统计。
  const basis = iso !== null ? `ISO ${iso}` : exif.focal || scene?.tags?.[0] || t('crystal.aiRecommend.tagStats');

  return (
    <div className="cx-ai-card">
      <div className="grow min-w-0">
        <div className="cx-ai-title">{t('crystal.aiRecommend.title')}</div>
        <div className="cx-ai-desc">
          {sceneKey
            ? t('crystal.aiRecommend.sceneBasis', {
                scene: t(`crystal.aiRecommend.scenes.${sceneKey}`),
                basis,
              })
            : t('crystal.aiRecommend.noScene')}
        </div>
        <div className="cx-ai-tags">
          {/* 名实一致（自检修复 4）：「AI」标签不再无条件硬编码——后端
              scene.source 如实区分 CLIP 零样本（AI）与统计启发式（非 AI），
              启发式结果标注为像素统计，不冒充 AI 识别。 */}
          <span className="cx-ai-tag">{scene?.source === 'heuristic' ? t('crystal.aiRecommend.tagStats') : 'AI'}</span>
          {sceneKey && scene?.source !== 'heuristic' && (
            <span className="cx-ai-tag">{t('crystal.aiRecommend.tagStats')}</span>
          )}
          <span className="cx-ai-tag">{t('crystal.aiRecommend.tagExif')}</span>
        </div>
      </div>
      <button
        className="cx-ai-apply"
        onClick={() => {
          haptic(6);
          runAiEnhance();
        }}
        disabled={isEnhancing}
      >
        {isEnhancing ? (
          <Loader2 size={15} className="animate-spin inline" />
        ) : (
          <Sparkles size={15} className="inline -mt-0.5" />
        )}
        <span className="ml-1">{t('crystal.aiRecommend.enhance')}</span>
      </button>
      {sceneKey && (
        <button
          className="cx-ai-apply"
          style={{ background: 'var(--cx-card2)', color: 'var(--cx-ink)', border: '1px solid var(--cx-border)' }}
          onClick={() => {
            haptic(6);
            applySceneRecipe();
          }}
        >
          {t('crystal.aiRecommend.recipe')}
        </button>
      )}
    </div>
  );
}

/* ---------------------------- 主面板 ---------------------------- */
export default function CrystalPresetsPanel({ mode }: { mode: PanelMode }) {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const selectedImagePath = useEditorStore((s) => s.selectedImage?.path);
  const { applyPresetObject, setAdjustments } = useCrystalAdjust();
  const {
    presets,
    isLoading,
    addPreset,
    importPresetsFromFiles,
    exportPresetsToFile,
    overwritePreset,
    renameItem,
    deleteItem,
  } = usePresets(adjustments);
  const { previews, enqueue, resetGeneration, invalidate } = usePresetPreviewQueue();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(100);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  /** 图片是否就绪：缩略图渲染依赖后端已加载原图，未就绪时的入队会整体失败 */
  const selectedImageIsReady = useEditorStore((s) => s.selectedImage?.isReady);
  const baseRef = useRef<Adjustments | null>(null);
  /** 当前应用中的滤镜/预设源：取消/换卡时用于取参数键集（activeId 的伴生 ref，二者同生命周期） */
  const activeSourceRef = useRef<PreviewSource | null>(null);
  /** 强度 0 时暂存的蒙版（与桌面 hiddenPresetMasks 同语义），>0 时还原 */
  const hiddenMasksRef = useRef<Array<MaskContainer> | null>(null);
  /** 长按动作面板目标（仅 presets 模式） */
  const [sheetSource, setSheetSource] = useState<PreviewSource | null>(null);
  const [nameDialog, setNameDialog] = useState<{ kind: 'save' | 'rename'; presetId?: string; initial: string } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<PreviewSource | null>(null);
  /* 审计 P-可行性：多选 lrtemplate/xmp 转换可秒级，导入期间按钮忙碌防重复触发 */
  const [importing, setImporting] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);

  // G5: 按文件夹分组（保持首次出现顺序），'' 为未分组。
  const presetGroups = useMemo(() => {
    const groups: Array<{ name: string; presets: Preset[] }> = [];
    const byName = new Map<string, Preset[]>();
    const push = (name: string, preset: Preset) => {
      let list = byName.get(name);
      if (!list) {
        list = [];
        byName.set(name, list);
        groups.push({ name, presets: list });
      }
      list.push(preset);
    };
    (presets as Array<UserPreset>).forEach((item) => {
      if (item.preset) push('', item.preset);
      else if (item.folder) {
        const name = item.folder.name ?? '';
        ((item.folder.children ?? []) as Preset[]).forEach((p) => push(name, p));
      }
    });
    return groups;
  }, [presets]);

  const namedGroups = useMemo(() => presetGroups.filter((g) => g.name), [presetGroups]);
  const totalPresetCount = useMemo(() => presetGroups.reduce((n, g) => n + g.presets.length, 0), [presetGroups]);

  // 全量列表（含 group）：已应用源按它解析，分组过滤隐藏激活卡时状态条/强度/取消入口仍可达
  const allSources: Array<PreviewSource> = useMemo(() => {
    if (mode === 'filter') {
      return BUILTIN_FILTERS.map((f) => ({
        id: `filter:${f.id}`,
        name: t(f.labelKey),
        adjustments: f.adjustments as Record<string, unknown>,
        group: f.group,
      }));
    }
    return presetGroups.flatMap((g) =>
      g.presets.map((p) => ({
        id: `preset:${p.id}`,
        name: p.name,
        adjustments: (p.adjustments ?? {}) as Record<string, unknown>,
        group: g.name,
      })),
    );
  }, [mode, presetGroups, t]);

  const sources: Array<PreviewSource> = useMemo(
    () => (selectedGroup ? allSources.filter((s) => s.group === selectedGroup) : allSources),
    [allSources, selectedGroup],
  );

  // v2.1.13: 切图后缩略图队列整体作废并按新图重建（必须在 enqueue 效果之前声明）
  useEffect(() => {
    resetGeneration();
  }, [selectedImagePath, resetGeneration]);

  // v2.1.13: 切图后应用态一并复位，防止上一张图的 baseRef/强度/蒙版暂存泄漏到新图
  useEffect(() => {
    setActiveId(null);
    setIntensity(100);
    baseRef.current = null;
    activeSourceRef.current = null;
    hiddenMasksRef.current = null;
  }, [selectedImagePath]);

  // 缩略图入队。审计修复（滤镜-缩略图死队列）：GeneratePresetPreview 依赖后端
  // original_image，图片未 ready 时入队的请求全部抛 "No original image loaded"
  // 并清空队列；此前 effect 不依赖 isReady，图片加载完成后不会重新入队——
  // 12 个滤镜卡永远停在 Loader2（点击虽能应用，但面板看似卡死）。
  // 依赖 isReady：false→true 转换时重新入队，previewsRef 保持 undefined 可重试。
  useEffect(() => {
    enqueue(sources);
  }, [sources, enqueue, selectedImagePath, selectedImageIsReady]);

  // Android 返回键：动作面板/命名对话框/删除确认打开时先关闭浮层
  useEffect(() => {
    if (!sheetSource && !nameDialog && !deleteTarget) return;
    const handler = () => {
      setSheetSource(null);
      setNameDialog(null);
      setDeleteTarget(null);
    };
    pushExitLayer(handler);
    return () => removeExitLayer(handler);
  }, [sheetSource, nameDialog, deleteTarget]);

  // 已应用源按全量列表解析：分组过滤/卡片滚出视口时不丢状态条、强度滑杆与取消入口。
  // 审计修复（预设↔滤镜）：两模式共用本组件实例，mode 切换不重挂载；此时 activeId
  // 属于另一模式的 id 前缀（preset: / filter:），在全量列表中解析不到 → 状态条与
  // 取消入口整体消失，而滤镜参数仍在生效。回落到 activeSourceRef 快照，保证跨模式
  // 切换后仍可调强度/取消，链路闭环。
  const activeSource = activeId ? (allSources.find((s) => s.id === activeId) ?? activeSourceRef.current) : null;
  const rawId = useCallback((sourceId: string) => sourceId.replace(/^preset:/, ''), []);

  /** 与桌面 resolvePresetAiMasks 同源：按当前图重跑 AI 蒙版并合并结果（不进撤销栈） */
  const resolvePresetAiMasks = useCallback(async (presetMasks: Array<MaskContainer>) => {
    const path = useEditorStore.getState().selectedImage?.path;
    if (!path) return;
    try {
      await invoke(Invokes.ApplyAdjustmentsToPaths, { paths: [path], adjustments: { masks: presetMasks } });
      const meta = await invoke<{ adjustments?: { masks?: Array<MaskContainer> } | null } | null>(
        Invokes.LoadMetadata,
        {
          path,
        },
      );
      const resolved = meta?.adjustments?.masks;
      if (!resolved || useEditorStore.getState().selectedImage?.path !== path) return;
      const setEditor = useEditorStore.getState().setEditor;
      setEditor((state) => ({
        adjustments: {
          ...state.adjustments,
          masks: mergeAiMaskResults(state.adjustments.masks || [], resolved),
        },
      }));
    } catch (e) {
      console.error('Failed to resolve preset AI masks:', e);
    }
  }, []);

  /** 取消应用：仅还原该滤镜/预设涉及的参数键（从 base 快照），保留用户对其余键的手动调整。
   *  供「再次点击同卡取消」与强度滑杆旁的显式取消按钮共用（分组过滤会隐藏激活卡，后者是唯一入口）。 */
  const cancelActive = useCallback(() => {
    const base = baseRef.current;
    const source = activeSourceRef.current;
    baseRef.current = null;
    activeSourceRef.current = null;
    hiddenMasksRef.current = null;
    setActiveId(null);
    setIntensity(100);
    if (base && source) {
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(source.adjustments)) {
        patch[key] = (base as Record<string, unknown>)[key];
      }
      setAdjustments({ ...useEditorStore.getState().adjustments, ...patch } as Adjustments);
    }
  }, [setAdjustments]);

  // 模式切换（滤镜↔预设）：复位分组 + 完整复位应用态。
  // 审计修复（滤镜-激活态泄漏）：两库独立，共用组件实例但 mode 切换不重挂载。
  // 此前 activeId 属于另一模式 id 前缀（filter:/preset:）解析不到时回落 ref 快照
  // ——切到预设模式后状态条仍显示「已应用 <滤镜> · 100%」。此处按 base 快照还原
  // 参数（cancelActive）并清空应用态，同时避免随后在预设模式应用新预设时
  // 两套参数叠加污染。cancelActive 读 ref 快照、不依赖渲染态。
  useEffect(() => {
    cancelActive();
    setSelectedGroup(null);
  }, [mode]);

  const handleApply = useCallback(
    (source: PreviewSource) => {
      haptic(8);
      if (activeId === source.id) {
        // 再次点击取消：按参数键还原（见 cancelActive）
        cancelActive();
        return;
      }
      const current = useEditorStore.getState().adjustments;
      const base = baseRef.current;
      // 换卡：先还原上一个滤镜的参数键，避免两套滤镜参数叠加污染
      // （如 A 的 saturation -100 会压过 B 的 -12）；再以还原后状态为新基线。
      let workingBase = current;
      const prevSource = activeId ? activeSourceRef.current : null;
      if (prevSource && base) {
        const patch: Record<string, unknown> = {};
        for (const key of Object.keys(prevSource.adjustments)) {
          patch[key] = (base as Record<string, unknown>)[key];
        }
        workingBase = { ...current, ...patch } as Adjustments;
        setAdjustments(workingBase);
      }
      baseRef.current = workingBase;
      activeSourceRef.current = source;
      setActiveId(source.id);
      setIntensity(100);
      hiddenMasksRef.current = null;
      // 含 AI 子蒙版的预设不能直接套用（结果属于创建时的图）：先剥离结果占位，
      // 再按当前图异步重新解析（与桌面 handleApplyPreset 同链路）。
      const presetMasks = (source.adjustments.masks ?? null) as Array<MaskContainer> | null;
      const hasAi = Boolean(presetMasks && hasAiSubMasks(presetMasks));
      if (hasAi && presetMasks) void resolvePresetAiMasks(presetMasks);
      applyPresetObject(
        hasAi && presetMasks ? { ...source.adjustments, masks: stripAiMaskResults(presetMasks) } : source.adjustments,
      );
    },
    [activeId, applyPresetObject, cancelActive, resolvePresetAiMasks, setAdjustments],
  );

  const handleIntensity = useCallback(
    (val: number) => {
      setIntensity(val);
      if (!activeSource) return;
      // 蒙版不参与强度混合（与桌面一致）：仅 0% 时隐藏，回升时还原并重解析 AI 蒙版
      const { masks: presetMasks, ...presetAdj } = activeSource.adjustments as Record<string, unknown>;
      const mixed = applyStrength(presetAdj, val) as Record<string, unknown>;
      if (presetMasks !== undefined) {
        const currentMasks = useEditorStore.getState().adjustments.masks;
        if (val === 0) {
          if (currentMasks?.length) hiddenMasksRef.current = currentMasks;
          mixed.masks = INITIAL_ADJUSTMENTS.masks;
        } else if (hiddenMasksRef.current || !currentMasks?.length) {
          const restored: Array<MaskContainer> = (
            hiddenMasksRef.current ?? stripAiMaskResults((presetMasks ?? []) as Array<MaskContainer>)
          ).map((container: MaskContainer) => ({
            ...container,
            adjustments: applyStrength(
              (container?.adjustments ?? {}) as Record<string, unknown>,
              val,
            ) as MaskContainer['adjustments'],
          }));
          hiddenMasksRef.current = null;
          if (
            hasAiSubMasks(restored, true) &&
            Array.isArray(presetMasks) &&
            (presetMasks as Array<MaskContainer>).length > 0
          ) {
            void resolvePresetAiMasks(presetMasks as Array<MaskContainer>);
          }
          mixed.masks = restored;
        }
      }
      applyPresetObject(mixed as Partial<Adjustments> as Record<string, unknown>);
    },
    [activeSource, applyPresetObject, resolvePresetAiMasks],
  );

  /* ---------------------------- 管理闭环（保存/导入/导出/覆盖/重命名/删除） ---------------------------- */

  const handleSaveCurrent = useCallback(
    (name: string) => {
      // 与桌面 ConfigurePresetModal 默认不同：移动端样式预设携带蒙版（人像/局部是核心场景），不携带裁剪几何
      const created = addPreset(name, null, true, false, 'style');
      if (created) toast.success(t('crystal.presets.saved'));
    },
    [addPreset, t],
  );

  const handleImportPresets = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const { osPlatform } = useSettingsStore.getState();
      const isAndroid = osPlatform === 'android';
      const selected = await open({
        multiple: true,
        filters: isAndroid
          ? []
          : [
              { name: t('editor.presets.dialog.allPresetFiles'), extensions: ['rrpreset', 'xmp', 'lrtemplate'] },
              { name: t('editor.presets.dialog.rapidRawPreset'), extensions: ['rrpreset'] },
              { name: t('editor.presets.dialog.legacyPreset'), extensions: ['xmp', 'lrtemplate'] },
            ],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length === 0) return;
      let validPaths = paths;
      if (isAndroid) {
        // SAF 返回 content:// URI：解析真实文件名按扩展名过滤（与 LUT 导入同链路）
        const resolvedNames = await Promise.all(
          paths.map(async (p) => {
            try {
              return await invoke<string>('resolve_android_content_uri_name', { uriStr: p });
            } catch {
              return p;
            }
          }),
        );
        const allowed = new Set(['rrpreset', 'xmp', 'lrtemplate']);
        validPaths = paths.filter((_, i) => allowed.has(resolvedNames[i].split('.').pop()?.toLowerCase() || ''));
        if (validPaths.length === 0) {
          toast.error(t('crystal.presets.importFailed'));
          return;
        }
      }
      const { failures } = await importPresetsFromFiles(validPaths);
      if (failures.length > 0) {
        toast.error(t('editor.presets.toasts.importFailures', { num: failures.length }));
      } else {
        toast.success(t('crystal.presets.importSuccess'));
      }
      failures.forEach((failure) => console.error(`Failed to import ${failure.fileName}: ${failure.error}`));
      resetGeneration();
    } catch (e) {
      console.error('Failed to import presets:', e);
      toast.error(t('crystal.presets.importFailed'));
    } finally {
      setImporting(false);
    }
  }, [importing, importPresetsFromFiles, resetGeneration, t]);

  const exportItem = useCallback(
    async (item: UserPreset, fallbackName: string) => {
      const { osPlatform } = useSettingsStore.getState();
      const safeName = `${fallbackName}.rrpreset`.replace(/[<>:"/\\|?*]/g, '_');
      const filePath =
        osPlatform === 'android'
          ? safeName
          : await save({
              defaultPath: safeName,
              filters: [{ name: t('editor.presets.dialog.presetFile'), extensions: ['rrpreset'] }],
              title: t('editor.presets.dialog.exportTitle', { type: t('editor.presets.types.preset') }),
            });
      if (filePath) {
        await exportPresetsToFile([item], filePath);
        toast.success(t('crystal.presets.exportSuccess'));
      }
    },
    [exportPresetsToFile, t],
  );

  const handleExportAll = useCallback(async () => {
    if (presets.length === 0) {
      // 空库不静默返回：给出闭环反馈，保持按钮始终可激活（无「置灰死控件」）。
      toast.info(t('crystal.presets.exportEmpty'));
      return;
    }
    try {
      const { osPlatform } = useSettingsStore.getState();
      const filePath =
        osPlatform === 'android'
          ? 'all_presets.rrpreset'
          : await save({
              defaultPath: 'all_presets.rrpreset',
              filters: [{ name: t('editor.presets.dialog.presetFile'), extensions: ['rrpreset'] }],
              title: t('editor.presets.dialog.exportAllTitle'),
            });
      if (filePath) {
        await exportPresetsToFile(presets, filePath);
        toast.success(t('crystal.presets.exportSuccess'));
      }
    } catch (e) {
      console.error('Failed to export all presets:', e);
      toast.error(t('crystal.presets.exportFailed'));
    }
  }, [exportPresetsToFile, presets, t]);

  /** 从预设库中找原始条目（保留 includeMasks/folder 信息），供单条导出 */
  const findUserPresetItem = useCallback(
    (presetId: string): UserPreset | null => {
      for (const item of presets as Array<UserPreset>) {
        if (item.preset?.id === presetId) return item;
        if (item.folder) {
          const child = item.folder.children.find((c: Preset) => c.id === presetId);
          if (child) return { preset: child };
        }
      }
      return null;
    },
    [presets],
  );

  const handleExportSingle = useCallback(
    async (source: PreviewSource) => {
      try {
        const item = findUserPresetItem(rawId(source.id));
        if (!item?.preset) return;
        await exportItem(item, source.name);
      } catch (e) {
        console.error('Failed to export preset:', e);
        toast.error(t('crystal.presets.exportFailed'));
      }
    },
    [exportItem, findUserPresetItem, rawId, t],
  );

  const handleOverwrite = useCallback(
    async (source: PreviewSource) => {
      try {
        // hook 返回类型因闭包赋值被推断为 null，这里显式放宽
        const updated = overwritePreset(rawId(source.id)) as Preset | null;
        if (updated) {
          invalidate(source.id);
          const nextSource: PreviewSource = {
            id: source.id,
            name: updated.name ?? source.name,
            adjustments: (updated.adjustments ?? {}) as Record<string, unknown>,
            group: source.group,
          };
          enqueue([nextSource]);
          // 若该预设正在应用中：刷新 activeSourceRef 快照，使强度滑杆/取消入口
          // 按覆写后的新参数键工作（否则旧快照与卡片显示不符）。
          if (activeId === source.id) activeSourceRef.current = nextSource;
          toast.success(t('crystal.presets.overwritten'));
        } else {
          // 目标不存在（已被删/库未加载）——此前静默无反馈，用户以为更新成功
          toast.error(t('crystal.presets.overwriteFailed'));
        }
      } catch (e) {
        console.error('Failed to overwrite preset:', e);
        // 此前误用 exportFailed（"导出预设失败"）文案，覆写失败被报成导出失败
        toast.error(t('crystal.presets.overwriteFailed'));
      }
    },
    [activeId, enqueue, invalidate, overwritePreset, rawId, t],
  );

  const handleDelete = useCallback(
    (source: PreviewSource) => {
      deleteItem(rawId(source.id));
      invalidate(source.id);
      if (activeId === source.id) {
        // 删除正在应用的预设：仅退出应用态，不回滚已写入的编辑
        setActiveId(null);
        setIntensity(100);
        baseRef.current = null;
        activeSourceRef.current = null;
        hiddenMasksRef.current = null;
      }
    },
    [activeId, deleteItem, invalidate, rawId],
  );

  /* 长按预设卡 → 管理动作面板（横滑超过阈值视为滚动，取消触发） */
  const clearPress = useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  }, []);

  const startPress = useCallback(
    (source: PreviewSource, e: React.PointerEvent) => {
      if (mode !== 'presets') return;
      longPressFired.current = false;
      clearPress();
      pressStart.current = { x: e.clientX, y: e.clientY };
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        longPressFired.current = true;
        setSheetSource(source);
      }, 450);
    },
    [clearPress, mode],
  );

  const movePress = useCallback(
    (e: React.PointerEvent) => {
      const start = pressStart.current;
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearPress();
    },
    [clearPress],
  );

  if (mode === 'presets' && isLoading && totalPresetCount === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--cx-faint)' }}>
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <>
      <div className="cx-panel-title">
        <Wand2 size={13} className="inline mr-1.5 -mt-0.5" />
        {mode === 'filter' ? t('crystal.categories.filter') : t('crystal.categories.presets')}
      </div>

      {/* v2.1.13 预设管理闭环：保存当前 / 导入 / 导出全部（仅预设模式） */}
      {mode === 'presets' && (
        <div className="cx-preset-actions">
          <button className="cx-preset-act" onClick={() => setNameDialog({ kind: 'save', initial: '' })}>
            <Plus size={13} />
            {t('crystal.presets.saveCurrent')}
          </button>
          <button
            className="cx-preset-act"
            disabled={importing}
            onClick={() => {
              haptic(6);
              void handleImportPresets();
            }}
          >
            {importing ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
            {t('crystal.presets.import')}
          </button>
          <button
            className="cx-preset-act"
            onClick={() => {
              haptic(6);
              void handleExportAll();
            }}
          >
            <FileDown size={13} />
            {t('crystal.presets.exportAll')}
          </button>
        </div>
      )}

      {mode === 'presets' && <AiRecommendCard />}

      {mode === 'presets' && namedGroups.length > 0 && (
        <div className="cx-chip-row mt-3">
          <button
            className={`cx-chip ${selectedGroup === null ? 'is-active' : ''}`}
            onClick={() => {
              haptic(6);
              setSelectedGroup(null);
            }}
          >
            {t('crystal.presets.all')}
          </button>
          {namedGroups.map((g) => (
            <button
              key={g.name}
              className={`cx-chip ${selectedGroup === g.name ? 'is-active' : ''}`}
              onClick={() => {
                haptic(6);
                setSelectedGroup(g.name);
              }}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* §3.2 滤镜子标签：全部/风景/人像/胶片/黑白 */}
      {mode === 'filter' && (
        <div className="cx-chip-row mt-3">
          <button
            className={`cx-chip ${selectedGroup === null ? 'is-active' : ''}`}
            onClick={() => {
              haptic(6);
              setSelectedGroup(null);
            }}
          >
            {t('crystal.presets.all')}
          </button>
          {FILTER_GROUPS.map((g) => (
            <button
              key={g.id}
              className={`cx-chip ${selectedGroup === g.id ? 'is-active' : ''}`}
              onClick={() => {
                haptic(6);
                setSelectedGroup(g.id);
              }}
            >
              {t(g.labelKey)}
            </button>
          ))}
        </div>
      )}

      <div className="cx-hstrip mt-3">
        {sources.map((source) => {
          const url = previews[source.id];
          const isActive = activeId === source.id;
          return (
            <button
              key={source.id}
              className={`cx-thumb-card ${isActive ? 'is-active' : ''}`}
              onClick={() => {
                // 长按弹出的动作面板会派生 click，此处吞掉避免误应用
                if (longPressFired.current) {
                  longPressFired.current = false;
                  return;
                }
                handleApply(source);
              }}
              onPointerDown={(e) => startPress(source, e)}
              onPointerMove={movePress}
              onPointerUp={clearPress}
              onPointerCancel={clearPress}
              onContextMenu={(e) => {
                if (mode !== 'presets') return;
                e.preventDefault();
                clearPress();
                setSheetSource(source);
              }}
            >
              <span className="cx-thumb-img flex items-center justify-center overflow-hidden">
                {url ? (
                  <img
                    src={url}
                    alt={source.name}
                    draggable={false}
                    className="w-full h-full object-cover rounded-[10px]"
                  />
                ) : (
                  <Loader2 size={16} className="animate-spin" style={{ color: 'var(--cx-faint)' }} />
                )}
              </span>
              <span className="cx-thumb-name">{source.name}</span>
            </button>
          );
        })}
        {mode === 'presets' && sources.length === 0 && (
          <div className="text-[11.5px] py-4 px-1" style={{ color: 'var(--cx-faint)' }}>
            {t('crystal.presets.empty')}
          </div>
        )}
      </div>

      {activeSource && (
        <div className="mt-2">
          {/* OC-6: 已应用预设状态条（卡位滚出视口时仍可见当前预设与强度） */}
          <div className="cx-applied-bar" role="status">
            <Check size={12} />
            {t('crystal.presets.appliedBar', { name: activeSource.name })} · {intensity}%
          </div>
          <CxSliderRow
            label={t('crystal.presets.intensity')}
            min={0}
            max={200}
            step={1}
            value={intensity}
            defaultValue={100}
            suffix="%"
            onChange={handleIntensity}
          />
          {/* 显式取消入口：分组过滤隐藏激活卡时，「再点同卡取消」不可达，此处兜底闭环
              （activeSource 按全量列表解析，切分组后本按钮与强度滑杆保持可见） */}
          <button className="cx-mask-remove mt-2 w-full" onClick={cancelActive}>
            <X size={11} />
            {t('modals.confirm.cancel')}
          </button>
        </div>
      )}

      {/* 长按动作面板：单条预设管理（与国内主流修图 App 交互一致） */}
      {sheetSource &&
        createPortal(
          <div className="cx-sheet-backdrop" onClick={() => setSheetSource(null)}>
            <div className="cx-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="cx-sheet-title">{sheetSource.name}</div>
              <button
                className="cx-sheet-row"
                style={sheetSource.id === activeId ? { color: 'var(--cx-accent)' } : undefined}
                onClick={() => {
                  handleApply(sheetSource);
                  setSheetSource(null);
                }}
              >
                <Check size={15} />
                {t('crystal.presets.menuApply')}
              </button>
              <button
                className="cx-sheet-row"
                onClick={() => {
                  haptic(6);
                  void handleOverwrite(sheetSource);
                  setSheetSource(null);
                }}
              >
                <Save size={15} />
                {t('crystal.presets.menuOverwrite')}
              </button>
              <button
                className="cx-sheet-row"
                onClick={() => {
                  haptic(6);
                  setNameDialog({ kind: 'rename', presetId: rawId(sheetSource.id), initial: sheetSource.name });
                  setSheetSource(null);
                }}
              >
                <Pencil size={15} />
                {t('crystal.presets.menuRename')}
              </button>
              <button
                className="cx-sheet-row"
                onClick={() => {
                  haptic(6);
                  void handleExportSingle(sheetSource);
                  setSheetSource(null);
                }}
              >
                <FileDown size={15} />
                {t('crystal.presets.menuExport')}
              </button>
              <button
                className="cx-sheet-row cx-danger"
                onClick={() => {
                  haptic(6);
                  setDeleteTarget(sheetSource);
                  setSheetSource(null);
                }}
              >
                <Trash2 size={15} />
                {t('crystal.presets.menuDelete')}
              </button>
              <button className="cx-sheet-row cx-sheet-cancel" onClick={() => setSheetSource(null)}>
                {t('modals.confirm.cancel')}
              </button>
            </div>
          </div>,
          document.body,
        )}

      <PresetNameDialog
        isOpen={nameDialog !== null}
        title={nameDialog?.kind === 'save' ? t('crystal.presets.saveTitle') : t('crystal.presets.renameTitle')}
        initial={nameDialog?.initial ?? ''}
        placeholder={t('crystal.presets.namePlaceholder')}
        confirmText={nameDialog?.kind === 'save' ? t('crystal.presets.saveCurrent') : t('crystal.presets.menuRename')}
        onClose={() => setNameDialog(null)}
        onSubmit={(name) => {
          if (!nameDialog) return;
          if (nameDialog.kind === 'save') {
            handleSaveCurrent(name);
          } else if (nameDialog.presetId) {
            renameItem(nameDialog.presetId, name);
          }
          setNameDialog(null);
        }}
      />

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title={t('crystal.presets.deleteTitle')}
        message={t('crystal.presets.deleteMessage', { name: deleteTarget?.name ?? '' })}
        confirmVariant="danger"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
        }}
      />
    </>
  );
}

/* ---------------------------- 命名对话框（保存为预设 / 重命名） ---------------------------- */
function PresetNameDialog({
  isOpen,
  title,
  initial,
  placeholder,
  confirmText,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  title: string;
  initial: string;
  placeholder: string;
  confirmText: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (isOpen) setValue(initial);
  }, [isOpen, initial]);

  if (!isOpen) return null;

  const submit = () => {
    const name = value.trim();
    if (!name) return;
    onSubmit(name);
  };

  return createPortal(
    <div className="cx-sheet-backdrop cx-center" onClick={onClose}>
      <div className="cx-sheet cx-sheet-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cx-sheet-title cx-sheet-title-strong">{title}</div>
        <input
          className="cx-sheet-input"
          value={value}
          placeholder={placeholder}
          maxLength={60}
          autoFocus
          enterKeyHint="done"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="cx-sheet-actions">
          <button className="cx-sheet-btn" onClick={onClose}>
            {t('modals.confirm.cancel')}
          </button>
          <button className="cx-sheet-btn cx-sheet-btn-primary" disabled={!value.trim()} onClick={submit}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
