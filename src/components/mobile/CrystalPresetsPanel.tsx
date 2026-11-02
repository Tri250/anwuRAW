import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Loader2, Sparkles, Wand2 } from 'lucide-react';
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
const BUILTIN_FILTERS: Array<{ id: string; labelKey: ParseKeys; adjustments: Partial<Adjustments> }> = [
  { id: 'vivid', labelKey: 'crystal.filters.vivid', adjustments: { vibrance: 30, saturation: 8, contrast: 12, blacks: -10 } },
  { id: 'softMist', labelKey: 'crystal.filters.softMist', adjustments: { glowAmount: 30, highlights: 15, shadows: 12, dehaze: -8, contrast: -6 } },
  { id: 'film', labelKey: 'crystal.filters.film', adjustments: { contrast: 8, saturation: -12, grainAmount: 22, temperature: 6, blacks: -6 } },
  { id: 'mono', labelKey: 'crystal.filters.mono', adjustments: { saturation: -100, contrast: 18, structure: 8, grainAmount: 14 } },
  { id: 'goldBlack', labelKey: 'crystal.filters.goldBlack', adjustments: { temperature: 14, vibrance: 18, shadows: -12, blacks: -18, vignetteAmount: 24 } },
  { id: 'cyber', labelKey: 'crystal.filters.cyber', adjustments: { tint: -18, temperature: -14, saturation: 22, contrast: 14, halationAmount: 16 } },
  { id: 'airy', labelKey: 'crystal.filters.airy', adjustments: { exposure: 0.25, contrast: -8, saturation: -8, temperature: -4, highlights: -10 } },
  { id: 'vintage', labelKey: 'crystal.filters.vintage', adjustments: { saturation: -18, temperature: 10, vignetteAmount: 20, grainAmount: 18, blacks: 12 } },
  { id: 'coolBlue', labelKey: 'crystal.filters.coolBlue', adjustments: { temperature: -18, tint: 4, contrast: 8 } },
  { id: 'goldenHour', labelKey: 'crystal.filters.goldenHour', adjustments: { temperature: 18, vibrance: 12, glowAmount: 10 } },
  { id: 'hdrPunch', labelKey: 'crystal.filters.hdrPunch', adjustments: { clarity: 24, structure: 14, contrast: 10, vibrance: 16, dehaze: 8 } },
  { id: 'faded', labelKey: 'crystal.filters.faded', adjustments: { contrast: -12, blacks: 16, saturation: -14, shadows: 10 } },
];

/* ---------------------------- 缩略图渲染队列（同桌面 PresetsPanel） ---------------------------- */
function usePresetPreviewQueue() {
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const previewsRef = useRef<Record<string, string | null>>({});
  const queueRef = useRef<Array<PreviewSource>>([]);
  const processingRef = useRef(false);
  const urlsRef = useRef<string[]>([]);

  const processQueue = useCallback(async () => {
    if (processingRef.current || queueRef.current.length === 0) return;
    processingRef.current = true;
    const pathAtStart = useEditorStore.getState().selectedImage?.path ?? null;

    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift();
      if (!item) break;
      if (previewsRef.current[item.id] !== undefined) continue;

      try {
        const fullAdjustments = { ...INITIAL_ADJUSTMENTS, ...item.adjustments };
        const imageData: Uint8Array = await invoke(Invokes.GeneratePresetPreview, {
          jsAdjustments: fullAdjustments,
        });
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

  return { previews, enqueue };
}

/* ---------------------------- AI 推荐（真实 EXIF 启发 + 真实 AiAutoEnhance） ---------------------------- */
function firstNumber(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function AiRecommendCard() {
  const { t } = useTranslation();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const { applyPatch } = useCrystalAdjust();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider);

  const exif = summarizeExif((selectedImage?.exif ?? null) as Record<string, unknown> | null);
  const focal = firstNumber(exif.focal);
  const iso = firstNumber(exif.iso);

  // 场景启发只陈述依据（EXIF 数值），不伪造置信度。
  const sceneKey = iso !== null && iso > 1600 ? 'night' : focal === null ? null : focal > 60 ? 'tele' : focal > 35 ? 'portrait' : focal < 24 ? 'landscape' : null;

  const runAiEnhance = async () => {
    if (isEnhancing) return;
    setIsEnhancing(true);
    try {
      const result = await invoke<Partial<Adjustments>>(Invokes.AiAutoEnhance, { intensity: 'standard' });
      const prev = useEditorStore.getState().adjustments;
      useEditorStore.getState().setEditor({ adjustments: { ...prev, ...result } });
    } catch (e) {
      console.error('AI enhance failed:', e);
      toast.error(t('crystal.aiRecommend.failed'));
    } finally {
      setIsEnhancing(false);
    }
  };

  const applySceneRecipe = () => {
    if (sceneKey === 'portrait') {
      applyPatch({ lumaNoiseReduction: Math.max(Number(useEditorStore.getState().adjustments.lumaNoiseReduction ?? 0), 18), clarity: 8, glowAmount: 20, vibrance: 8 });
    } else if (sceneKey === 'landscape') {
      applyPatch({ vibrance: 22, clarity: 14, dehaze: 10, contrast: 8 });
    } else if (sceneKey === 'night') {
      applyPatch({ ...(aiProvider ? getAiDenoiseEnablePatch(aiProvider) : { lumaNoiseReduction: 30 }), shadows: 14, blacks: -8 });
    } else {
      applyPatch({ vibrance: 14, contrast: 8 });
    }
  };

  return (
    <div className="cx-ai-card">
      <div className="grow min-w-0">
        <div className="cx-ai-title">{t('crystal.aiRecommend.title')}</div>
        <div className="cx-ai-desc">
          {sceneKey
            ? t('crystal.aiRecommend.sceneBasis', {
                scene: t(`crystal.aiRecommend.scenes.${sceneKey}`),
                basis: iso !== null && iso > 1600 ? `ISO ${iso}` : `${exif.focal || ''}`.trim(),
              })
            : t('crystal.aiRecommend.noExif')}
        </div>
        <div className="cx-ai-tags">
          <span className="cx-ai-tag">AI</span>
          <span className="cx-ai-tag">{t('crystal.aiRecommend.tagExif')}</span>
        </div>
      </div>
      <button className="cx-ai-apply" onClick={runAiEnhance} disabled={isEnhancing}>
        {isEnhancing ? <Loader2 size={15} className="animate-spin inline" /> : <Sparkles size={15} className="inline -mt-0.5" />}
        <span className="ml-1">{t('crystal.aiRecommend.enhance')}</span>
      </button>
      {sceneKey && (
        <button className="cx-ai-apply" style={{ background: 'var(--cx-card2)', color: 'var(--cx-ink)', border: '1px solid var(--cx-border)' }} onClick={applySceneRecipe}>
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
  const { applyPresetObject, setAdjustments } = useCrystalAdjust();
  const { presets, isLoading } = usePresets(adjustments);
  const { previews, enqueue } = usePresetPreviewQueue();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(100);
  const baseRef = useRef<Adjustments | null>(null);

  const flatPresets: Preset[] = useMemo(() => {
    const out: Preset[] = [];
    (presets as Array<UserPreset>).forEach((item) => {
      if (item.preset) out.push(item.preset);
      else if (item.folder?.children) out.push(...(item.folder.children as Preset[]));
    });
    return out;
  }, [presets]);

  const sources: Array<PreviewSource> = useMemo(() => {
    if (mode === 'filter') {
      return BUILTIN_FILTERS.map((f) => ({ id: `filter:${f.id}`, name: t(f.labelKey), adjustments: f.adjustments as Record<string, unknown> }));
    }
    return flatPresets.map((p) => ({ id: `preset:${p.id}`, name: p.name, adjustments: (p.adjustments ?? {}) as Record<string, unknown> }));
  }, [mode, flatPresets, t]);

  useEffect(() => {
    enqueue(sources);
  }, [sources, enqueue]);

  const activeSource = activeId ? sources.find((s) => s.id === activeId) ?? null : null;

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

  if (mode === 'presets' && isLoading && flatPresets.length === 0) {
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

      <div className={mode === 'presets' ? 'cx-hstrip mt-3' : 'cx-hstrip'}>
        {sources.map((source) => {
          const url = previews[source.id];
          const isActive = activeId === source.id;
          return (
            <button key={source.id} className={`cx-thumb-card ${isActive ? 'is-active' : ''}`} onClick={() => handleApply(source)}>
              <span className="cx-thumb-img flex items-center justify-center overflow-hidden">
                {url ? (
                  <img src={url} alt={source.name} draggable={false} className="w-full h-full object-cover rounded-[10px]" />
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
