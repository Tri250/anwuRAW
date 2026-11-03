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
import {
  Adjustments,
  INITIAL_ADJUSTMENTS,
  applyStrength,
  getAiDenoiseEnablePatch,
} from '../../utils/adjustments';
import type { MaskContainer } from '../../utils/adjustments';
import { hasAiSubMasks, mergeAiMaskResults, stripAiMaskResults } from '../../utils/maskUtils';
import { Invokes, Preset } from '../ui/AppProperties';
import ConfirmModal from '../modals/ConfirmModal';
import { pushExitLayer, removeExitLayer } from '../../utils/androidBackRegistry';
import { CxSliderRow, haptic, summarizeExif, useCrystalAdjust } from './crystalShared';

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
    adjustments: { temperature: 14, vibrance: 18, shadows: -12, blacks: -18, vignetteAmount: 24 },
  },
  {
    id: 'cyber',
    labelKey: 'crystal.filters.cyber',
    group: 'film',
    adjustments: { tint: -18, temperature: -14, saturation: 22, contrast: 14, halationAmount: 16 },
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
    adjustments: { saturation: -18, temperature: 10, vignetteAmount: 20, grainAmount: 18, blacks: 12 },
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

  // 场景来自 scene_classify（真实像素统计）。识别失败/低于门槛 → 静默降级：
  // 仅隐藏场景配方按钮，一键增强始终可用（原方案「AI 失败不阻塞」边界）。
  useEffect(() => {
    let cancelled = false;
    setScene(null);
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
  }, [selectedImage?.path]);

  const sceneKey: SceneKey | null =
    scene && scene.confidence >= SCENE_CONFIDENCE_GATE ? (scene.scene as SceneKey) : null;

  const runAiEnhance = async () => {
    if (isEnhancing) return;
    setIsEnhancing(true);
    try {
      const result = await invoke<Partial<Adjustments>>(Invokes.AiAutoEnhance, { intensity: 'standard' });
      // 与桌面 EditorToolbar 同源：经 setAdjustments → debounced pushHistory，
      // 保证 AI 增强结果进 50 步撤销栈（setEditor 直接写会绕过历史）。
      setAdjustments((prev) => ({ ...prev, ...result }));
    } catch (e) {
      console.error('AI enhance failed:', e);
      toast.error(t('crystal.aiRecommend.failed'));
    } finally {
      setIsEnhancing(false);
    }
  };

  // W3-3 推荐映射规则库：scene → 真实管线参数包（与 ai_auto_enhance 同写入路径）。
  const applySceneRecipe = () => {
    if (sceneKey === 'portrait') {
      applyPatch({
        lumaNoiseReduction: Math.max(Number(useEditorStore.getState().adjustments.lumaNoiseReduction ?? 0), 18),
        clarity: 8,
        glowAmount: 20,
        vibrance: 8,
      });
    } else if (sceneKey === 'landscape') {
      applyPatch({ vibrance: 22, clarity: 14, dehaze: 10, contrast: 8 });
    } else if (sceneKey === 'night') {
      applyPatch({
        ...(aiProvider ? getAiDenoiseEnablePatch(aiProvider) : { lumaNoiseReduction: 30 }),
        shadows: 14,
        blacks: -8,
      });
    } else if (sceneKey === 'food') {
      applyPatch({ vibrance: 16, saturation: 6, temperature: 6, contrast: 6, shadows: 8 });
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
          <span className="cx-ai-tag">AI</span>
          {sceneKey && <span className="cx-ai-tag">{t('crystal.aiRecommend.tagStats')}</span>}
          <span className="cx-ai-tag">{t('crystal.aiRecommend.tagExif')}</span>
        </div>
      </div>
      <button className="cx-ai-apply" onClick={runAiEnhance} disabled={isEnhancing}>
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
          onClick={applySceneRecipe}
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

  // 模式切换时复位分组，避免预设分组名泄漏到滤镜过滤
  useEffect(() => {
    setSelectedGroup(null);
  }, [mode]);

  const sources: Array<PreviewSource> = useMemo(() => {
    if (mode === 'filter') {
      const list = selectedGroup ? BUILTIN_FILTERS.filter((f) => f.group === selectedGroup) : BUILTIN_FILTERS;
      return list.map((f) => ({
        id: `filter:${f.id}`,
        name: t(f.labelKey),
        adjustments: f.adjustments as Record<string, unknown>,
      }));
    }
    const pool = selectedGroup
      ? (presetGroups.find((g) => g.name === selectedGroup)?.presets ?? [])
      : presetGroups.flatMap((g) => g.presets);
    return pool.map((p) => ({
      id: `preset:${p.id}`,
      name: p.name,
      adjustments: (p.adjustments ?? {}) as Record<string, unknown>,
    }));
  }, [mode, presetGroups, selectedGroup, t]);

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

  useEffect(() => {
    enqueue(sources);
  }, [sources, enqueue, selectedImagePath]);

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

  const activeSource = activeId ? (sources.find((s) => s.id === activeId) ?? null) : null;
  const rawId = useCallback((sourceId: string) => sourceId.replace(/^preset:/, ''), []);

  /** 与桌面 resolvePresetAiMasks 同源：按当前图重跑 AI 蒙版并合并结果（不进撤销栈） */
  const resolvePresetAiMasks = useCallback(async (presetMasks: Array<MaskContainer>) => {
    const path = useEditorStore.getState().selectedImage?.path;
    if (!path) return;
    try {
      await invoke(Invokes.ApplyAdjustmentsToPaths, { paths: [path], adjustments: { masks: presetMasks } });
      const meta = await invoke<{ adjustments?: { masks?: Array<MaskContainer> } | null } | null>(Invokes.LoadMetadata, {
        path,
      });
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
    }
  }, [importPresetsFromFiles, resetGeneration, t]);

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
    if (presets.length === 0) return;
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
          enqueue([
            { id: source.id, name: source.name, adjustments: (updated.adjustments ?? {}) as Record<string, unknown> },
          ]);
          toast.success(t('crystal.presets.overwritten'));
        }
      } catch (e) {
        console.error('Failed to overwrite preset:', e);
        toast.error(t('crystal.presets.exportFailed'));
      }
    },
    [enqueue, invalidate, overwritePreset, rawId, t],
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
          <button className="cx-preset-act" onClick={() => void handleImportPresets()}>
            <FileUp size={13} />
            {t('crystal.presets.import')}
          </button>
          <button
            className="cx-preset-act"
            disabled={totalPresetCount === 0}
            onClick={() => void handleExportAll()}
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
            onClick={() => setSelectedGroup(null)}
          >
            {t('crystal.presets.all')}
          </button>
          {namedGroups.map((g) => (
            <button
              key={g.name}
              className={`cx-chip ${selectedGroup === g.name ? 'is-active' : ''}`}
              onClick={() => setSelectedGroup(g.name)}
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
            onClick={() => setSelectedGroup(null)}
          >
            {t('crystal.presets.all')}
          </button>
          {FILTER_GROUPS.map((g) => (
            <button
              key={g.id}
              className={`cx-chip ${selectedGroup === g.id ? 'is-active' : ''}`}
              onClick={() => setSelectedGroup(g.id)}
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
          {/* 显式取消入口：分组过滤隐藏激活卡时，「再点同卡取消」不可达，此处兜底闭环 */}
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
