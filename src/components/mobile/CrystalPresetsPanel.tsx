import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Loader2, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { usePresets, UserPreset } from '../../hooks/usePresets';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Adjustments, INITIAL_ADJUSTMENTS, applyStrength, getAiDenoiseEnablePatch } from '../../utils/adjustments';
import { Invokes, Preset } from '../ui/AppProperties';
import { CxSliderRow, summarizeExif, useCrystalAdjust } from './crystalShared';

/* ---------------------------------------------------------------------------
 * Crystal 移动端预设 / 滤镜面板。
 * - presets 模式：用户预设库（LoadPresets）+ AI 推荐卡（AiAutoEnhance 真实调用
 *   + 仅基于真实 EXIF 的场景启发，不伪造置信度）+ 强度混合（applyStrength）。
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

  useEffect(
    () => () => {
      queueRef.current = [];
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  return { previews, enqueue, resetGeneration };
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
  const { presets, isLoading } = usePresets(adjustments);
  const { previews, enqueue, resetGeneration } = usePresetPreviewQueue();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(100);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const baseRef = useRef<Adjustments | null>(null);

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

  useEffect(() => {
    enqueue(sources);
  }, [sources, enqueue, selectedImagePath]);

  const activeSource = activeId ? (sources.find((s) => s.id === activeId) ?? null) : null;

  const handleApply = useCallback(
    (source: PreviewSource) => {
      if (activeId === source.id) {
        // 再次点击取消：恢复应用前状态
        const base = baseRef.current;
        baseRef.current = null;
        setActiveId(null);
        setIntensity(100);
        if (base) setAdjustments(base);
        return;
      }
      baseRef.current = adjustments;
      setActiveId(source.id);
      setIntensity(100);
      applyPresetObject(source.adjustments);
    },
    [activeId, adjustments, applyPresetObject, setAdjustments],
  );

  const handleIntensity = useCallback(
    (val: number) => {
      setIntensity(val);
      if (!activeSource) return;
      const mixed = applyStrength(activeSource.adjustments as Record<string, unknown>, val) as Partial<Adjustments>;
      applyPresetObject(mixed as Record<string, unknown>);
    },
    [activeSource, applyPresetObject],
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
              onClick={() => handleApply(source)}
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
        </div>
      )}
    </>
  );
}
