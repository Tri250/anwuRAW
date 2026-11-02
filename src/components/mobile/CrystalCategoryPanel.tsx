import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Aperture, Eye, FlipHorizontal, FlipVertical, Loader2, RotateCw } from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { calculateCenteredCrop } from '../../utils/cropUtils';
import { CxSliderRow, useCrystalAdjust, useCrystalAiMasks } from './crystalShared';
import { Mask } from '../panel/right/Masks';
import type { CrystalCategory } from './CrystalMobileApp';
import CrystalPresetsPanel from './CrystalPresetsPanel';
import CrystalAiToolsPanel from './CrystalAiToolsPanel';

/* ---------------------------------------------------------------------------
 * 参数面板骨架：标题 + 滑杆组。所有值读写真实 store.adjustments。
 * ------------------------------------------------------------------------- */
function PanelShell({ titleKey, children }: { titleKey: ParseKeys; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="cx-panel-title">{t(titleKey)}</div>
      {children}
    </>
  );
}

/* ---------------------------- 调色 ---------------------------- */
const TONE_SLIDERS: Array<{ key: string; min: number; max: number; step: number; labelKey: ParseKeys; dv?: number }> = [
  { key: 'exposure', min: -5, max: 5, step: 0.05, labelKey: 'crystal.tone.exposure' },
  { key: 'contrast', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.contrast' },
  { key: 'highlights', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.highlights' },
  { key: 'shadows', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.shadows' },
  { key: 'whites', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.whites' },
  { key: 'blacks', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.blacks' },
  { key: 'temperature', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.temperature' },
  { key: 'tint', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.tint' },
  { key: 'vibrance', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.vibrance' },
  { key: 'saturation', min: -100, max: 100, step: 1, labelKey: 'crystal.tone.saturation' },
];

function TonePanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch } = useCrystalAdjust();
  const defaults = useMemo(
    () => ({
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      temperature: 0,
      tint: 0,
      vibrance: 0,
      saturation: 0,
    }),
    [],
  );

  return (
    <PanelShell titleKey="crystal.categories.tone">
      {TONE_SLIDERS.map(({ key, min, max, step, labelKey }) => (
        <CxSliderRow
          key={key}
          label={t(labelKey)}
          min={min}
          max={max}
          step={step}
          value={Number(adjustments[key] ?? 0)}
          defaultValue={defaults[key as keyof typeof defaults] ?? 0}
          onChange={(v) => applyPatch({ [key]: v })}
        />
      ))}
    </PanelShell>
  );
}

/* ---------------------------- 人像（真实参数组合，无伪造 AI） ---------------------------- */
function PortraitPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch } = useCrystalAdjust();
  const { handleGenerateAiFaceMask, findContainer, ensureContainer, setMaskAdjustments, maskReady } =
    useCrystalAiMasks();

  const [eyeBusy, setEyeBusy] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);

  const oneTapPortrait = useCallback(() => {
    // 一键人像：柔肤降噪 + 轻微通透 + 暖调，全部为真实管线参数。
    applyPatch({
      lumaNoiseReduction: Math.max(Number(adjustments.lumaNoiseReduction ?? 0), 22),
      clarity: Number(adjustments.clarity ?? 0),
      dehaze: Number(adjustments.dehaze ?? 0) + 6,
      temperature: Number(adjustments.temperature ?? 0) + 4,
      vibrance: Number(adjustments.vibrance ?? 0) + 8,
      glowAmount: Math.max(Number(adjustments.glowAmount ?? 0), 18),
    });
  }, [adjustments, applyPatch]);

  /* 边界计划 P1：眼部增强 —— 复用桌面 face mask（iris/eyeWhites）链路。
   * 强度 v → clarity 0.4v + exposure 0.12v（MasksPanel RetouchKind.eyes 同源映射）。 */
  const runEyeEnhance = useCallback(async () => {
    if (eyeBusy) return;
    setEyeBusy(true);
    try {
      const container = ensureContainer(Mask.AiFace, { parts: ['iris', 'eyeWhites'] });
      await handleGenerateAiFaceMask(container.subMasks[0].id, ['iris', 'eyeWhites']);
      if (maskReady(Mask.AiFace)) {
        // 仅首次识别后写入默认强度；重复执行不覆盖用户已调值。
        if (!Number(container.adjustments.clarity ?? 0)) setMaskAdjustments(container.id, { clarity: 20, exposure: 6 });
      } else {
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setEyeBusy(false);
    }
  }, [ensureContainer, eyeBusy, handleGenerateAiFaceMask, maskReady, setMaskAdjustments, t]);

  const eyesContainer = findContainer(Mask.AiFace);
  const eyeReady = maskReady(Mask.AiFace);
  const eyeStrength = eyesContainer ? Math.round(Number(eyesContainer.adjustments.clarity ?? 0) / 0.4) : 0;
  const setEyeStrength = useCallback(
    (v: number) => {
      if (eyesContainer)
        setMaskAdjustments(eyesContainer.id, { clarity: Math.round(v * 0.4), exposure: Math.round(v * 0.12) });
    },
    [eyesContainer, setMaskAdjustments],
  );

  /* 边界计划 P1：背景虚化 —— 复用桌面 Effects 链路（generate_full_image_depth_map
   * → lensBlurDepthMap + lensBlurEnabled/Amount），深度图驱动真实管线虚化。 */
  const runBgBlur = useCallback(async () => {
    if (blurBusy) return;
    const { adjustments: adj } = useEditorStore.getState();
    if (adj.lensBlurEnabled) {
      applyPatch({ lensBlurEnabled: false });
      return;
    }
    setBlurBusy(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map', { jsAdjustments: adj });
      applyPatch({ lensBlurDepthMap: b64, lensBlurEnabled: true, lensBlurAmount: 50 });
    } catch {
      toast.error(t('crystal.portrait.blurFailed'));
    } finally {
      setBlurBusy(false);
    }
  }, [applyPatch, blurBusy, t]);

  return (
    <PanelShell titleKey="crystal.categories.portrait">
      <button className="cx-ai-apply mb-3 w-full" onClick={oneTapPortrait} style={{ width: '100%' }}>
        {t('crystal.portrait.oneTap')}
      </button>

      <div className="cx-grid-tiles mb-2">
        <button className="cx-tile" onClick={runEyeEnhance} disabled={eyeBusy}>
          {eyeBusy ? (
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--cx-accent)' }} />
          ) : (
            <span
              className="cx-tile-color flex items-center justify-center"
              style={{ ['--cx-tile-color' as string]: 'var(--cx-cat-ren)' }}
            >
              <Eye size={13} />
            </span>
          )}
          {t('crystal.portrait.eyeEnhance')}
        </button>
        <button
          className={`cx-tile ${adjustments.lensBlurEnabled ? 'is-active' : ''}`}
          onClick={runBgBlur}
          disabled={blurBusy}
        >
          {blurBusy ? (
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--cx-accent)' }} />
          ) : (
            <span
              className="cx-tile-color flex items-center justify-center"
              style={{ ['--cx-tile-color' as string]: 'var(--cx-cat-comp)' }}
            >
              <Aperture size={13} />
            </span>
          )}
          {t('crystal.portrait.bgBlur')}
        </button>
      </div>

      {eyeReady && (
        <CxSliderRow
          label={t('crystal.portrait.eyeStrength')}
          min={0}
          max={100}
          step={1}
          value={Math.max(0, Math.min(100, eyeStrength))}
          onChange={setEyeStrength}
        />
      )}
      {Boolean(adjustments.lensBlurEnabled) && (
        <CxSliderRow
          label={t('crystal.portrait.bgBlurStrength')}
          min={0}
          max={100}
          step={1}
          value={Number(adjustments.lensBlurAmount ?? 0)}
          onChange={(v) => applyPatch({ lensBlurAmount: v })}
        />
      )}

      <CxSliderRow
        label={t('crystal.portrait.softSkin')}
        min={0}
        max={100}
        step={1}
        value={Number(adjustments.lumaNoiseReduction ?? 0)}
        onChange={(v) => applyPatch({ lumaNoiseReduction: v })}
      />
      <CxSliderRow
        label={t('crystal.portrait.contour')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.structure ?? 0)}
        onChange={(v) => applyPatch({ structure: v })}
      />
      <CxSliderRow
        label={t('crystal.portrait.clarity')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.clarity ?? 0)}
        onChange={(v) => applyPatch({ clarity: v })}
      />
      <CxSliderRow
        label={t('crystal.portrait.warmth')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.temperature ?? 0)}
        onChange={(v) => applyPatch({ temperature: v })}
      />
      <CxSliderRow
        label={t('crystal.portrait.glow')}
        min={0}
        max={100}
        step={1}
        value={Number(adjustments.glowAmount ?? 0)}
        onChange={(v) => applyPatch({ glowAmount: v })}
      />
    </PanelShell>
  );
}

/* ---------------------------- 构图 ---------------------------- */
const ASPECT_CHIPS: Array<{ labelKey: ParseKeys; value: number | null }> = [
  { labelKey: 'crystal.compose.free', value: null },
  { labelKey: 'crystal.compose.ratio11', value: 1 },
  { labelKey: 'crystal.compose.ratio43', value: 4 / 3 },
  { labelKey: 'crystal.compose.ratio32', value: 3 / 2 },
  { labelKey: 'crystal.compose.ratio169', value: 16 / 9 },
  { labelKey: 'crystal.compose.ratio916', value: 9 / 16 },
];

function ComposePanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const { applyPatch } = useCrystalAdjust();

  const rotate90 = useCallback(() => {
    const newSteps = ((adjustments.orientationSteps || 0) + 1) % 4;
    applyPatch({ orientationSteps: newSteps, rotation: 0 }, { enableTools: false });
  }, [adjustments.orientationSteps, applyPatch]);

  const activeAspect = useMemo(() => {
    const ratio = adjustments.aspectRatio;
    if (!ratio) return null;
    const hit = ASPECT_CHIPS.find((c) => c.value && Math.abs(c.value - ratio) < 0.01);
    return hit ? hit.value : ratio;
  }, [adjustments.aspectRatio]);

  // 与桌面 CropPanel.applyAspectRatio 同源：面积保持的居中裁剪。
  const rotateChip = useCallback(
    (value: number | null) => {
      const newCrop =
        value && selectedImage?.width && selectedImage?.height
          ? calculateCenteredCrop(
              selectedImage.width,
              selectedImage.height,
              adjustments.orientationSteps || 0,
              value,
              adjustments.rotation || 0,
            )
          : null;
      applyPatch({ aspectRatio: value, crop: newCrop }, { enableTools: false });
    },
    [adjustments.orientationSteps, adjustments.rotation, applyPatch, selectedImage],
  );

  return (
    <PanelShell titleKey="crystal.categories.compose">
      <div className="cx-chip-row mb-3">
        {ASPECT_CHIPS.map(({ labelKey, value }) => (
          <button
            key={labelKey}
            className={`cx-chip ${activeAspect === value ? 'is-active' : ''}`}
            onClick={() => rotateChip(value)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-8 mb-1" style={{ color: 'var(--cx-muted)' }}>
        <button className="cx-chip" onClick={rotate90}>
          <RotateCw size={14} className="inline mr-1 -mt-0.5" />
          {t('crystal.compose.rotate90')}
        </button>
        <button
          className={`cx-chip ${adjustments.flipHorizontal ? 'is-active' : ''}`}
          onClick={() => applyPatch({ flipHorizontal: !adjustments.flipHorizontal }, { enableTools: false })}
        >
          <FlipHorizontal size={14} className="inline mr-1 -mt-0.5" />
          {t('crystal.compose.flipH')}
        </button>
        <button
          className={`cx-chip ${adjustments.flipVertical ? 'is-active' : ''}`}
          onClick={() => applyPatch({ flipVertical: !adjustments.flipVertical }, { enableTools: false })}
        >
          <FlipVertical size={14} className="inline mr-1 -mt-0.5" />
          {t('crystal.compose.flipV')}
        </button>
      </div>
      <CxSliderRow
        label={t('crystal.compose.straighten')}
        min={-45}
        max={45}
        step={0.5}
        value={Number(adjustments.rotation ?? 0)}
        onChange={(v) => applyPatch({ rotation: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('crystal.compose.perspectiveV')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.transformVertical ?? 0)}
        onChange={(v) => applyPatch({ transformVertical: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('crystal.compose.perspectiveH')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.transformHorizontal ?? 0)}
        onChange={(v) => applyPatch({ transformHorizontal: v }, { enableTools: false })}
      />
    </PanelShell>
  );
}

/* ---------------------------- 特效 ---------------------------- */
function FxPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch } = useCrystalAdjust();

  const sliders: Array<{ key: string; min: number; max: number; labelKey: ParseKeys }> = [
    { key: 'vignetteAmount', min: 0, max: 100, labelKey: 'crystal.fx.vignette' },
    { key: 'grainAmount', min: 0, max: 100, labelKey: 'crystal.fx.grain' },
    { key: 'glowAmount', min: 0, max: 100, labelKey: 'crystal.fx.glow' },
    { key: 'halationAmount', min: 0, max: 100, labelKey: 'crystal.fx.halation' },
    { key: 'flareAmount', min: 0, max: 100, labelKey: 'crystal.fx.flare' },
    { key: 'dehaze', min: -100, max: 100, labelKey: 'crystal.fx.dehaze' },
  ];

  return (
    <PanelShell titleKey="crystal.categories.fx">
      {sliders.map(({ key, min, max, labelKey }) => (
        <CxSliderRow
          key={key}
          label={t(labelKey)}
          min={min}
          max={max}
          step={1}
          value={Number(adjustments[key] ?? 0)}
          onChange={(v) => applyPatch({ [key]: v })}
        />
      ))}
    </PanelShell>
  );
}

/* ---------------------------- 路由容器 ---------------------------- */
export default function CrystalCategoryPanel({ category }: { category: CrystalCategory }) {
  switch (category) {
    case 'presets':
      return (
        <div className="cx-panel">
          <CrystalPresetsPanel mode="presets" />
        </div>
      );
    case 'filter':
      return (
        <div className="cx-panel">
          <CrystalPresetsPanel mode="filter" />
        </div>
      );
    case 'ai':
      return (
        <div className="cx-panel">
          <CrystalAiToolsPanel />
        </div>
      );
    case 'tone':
      return (
        <div className="cx-panel">
          <TonePanel />
        </div>
      );
    case 'portrait':
      return (
        <div className="cx-panel">
          <PortraitPanel />
        </div>
      );
    case 'compose':
      return (
        <div className="cx-panel">
          <ComposePanel />
        </div>
      );
    case 'fx':
      return (
        <div className="cx-panel">
          <FxPanel />
        </div>
      );
    default:
      return null;
  }
}
