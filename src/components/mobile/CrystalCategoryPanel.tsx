import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import {
  Aperture,
  Eye,
  FlipHorizontal,
  FlipVertical,
  ImageOff,
  Loader2,
  RotateCcw,
  RotateCw,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Adjustments, DEFAULT_PARAMETRIC_CURVE_SETTINGS, ParametricCurve } from '../../utils/adjustments';
import { calculateCenteredCrop, calculateAutoCropForRotation } from '../../utils/cropUtils';
import { buildParametricPoints } from '../../utils/parametricCurve';
import { useEditorActions } from '../../hooks/useEditorActions';
import { CxSliderRow, CxSubSection, useCrystalAdjust, useCrystalAiMasks } from './crystalShared';
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

/* ---------------------------- 调色：光效 / 颜色 / 曲线 ---------------------------- */
type ToneTab = 'light' | 'color' | 'curve';

const TONE_TABS: Array<{ id: ToneTab; labelKey: ParseKeys }> = [
  { id: 'light', labelKey: 'crystal.tone.tabLight' },
  { id: 'color', labelKey: 'crystal.tone.tabColor' },
  { id: 'curve', labelKey: 'crystal.tone.tabCurve' },
];

const HSL_BANDS: Array<{ id: keyof Adjustments['hsl']; labelKey: ParseKeys; swatch: string }> = [
  { id: 'reds', labelKey: 'crystal.tone.bandReds', swatch: '#ff6b6b' },
  { id: 'oranges', labelKey: 'crystal.tone.bandOranges', swatch: '#ffa94d' },
  { id: 'yellows', labelKey: 'crystal.tone.bandYellows', swatch: '#ffe066' },
  { id: 'greens', labelKey: 'crystal.tone.bandGreens', swatch: '#69db7c' },
  { id: 'aquas', labelKey: 'crystal.tone.bandAquas', swatch: '#38d9a9' },
  { id: 'blues', labelKey: 'crystal.tone.bandBlues', swatch: '#4dabf7' },
  { id: 'purples', labelKey: 'crystal.tone.bandPurples', swatch: '#b197fc' },
  { id: 'magentas', labelKey: 'crystal.tone.bandMagentas', swatch: '#f783ac' },
];

function TonePanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch } = useCrystalAdjust();
  const [tab, setTab] = useState<ToneTab>('light');
  const [band, setBand] = useState<keyof Adjustments['hsl']>('reds');

  const bandHsl = adjustments.hsl?.[band] ?? { hue: 0, saturation: 0, luminance: 0 };
  const lumaCurve = adjustments.parametricCurve?.luma ?? DEFAULT_PARAMETRIC_CURVE_SETTINGS;
  // ParametricCurve 索引签名要求四通道齐备，缺省时以默认值补全
  const parametricBase: ParametricCurve =
    adjustments.parametricCurve ??
    ({
      blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    } as ParametricCurve);
  const curvePoints = buildParametricPoints(lumaCurve);

  const setHsl = (key: 'hue' | 'saturation' | 'luminance', value: number) =>
    applyPatch({ hsl: { ...(adjustments.hsl ?? {}), [band]: { ...bandHsl, [key]: value } } });

  /* 参数化曲线：滑杆实时换算为点曲线（后端渲染 curves.luma），与桌面 Curves 同一套数学 */
  const setParametric = (key: keyof typeof DEFAULT_PARAMETRIC_CURVE_SETTINGS, value: number) => {
    const next = { ...lumaCurve, [key]: value };
    applyPatch({
      parametricCurve: { ...parametricBase, luma: next },
      curveMode: 'parametric',
      curves: { ...(adjustments.curves ?? {}), luma: buildParametricPoints(next) },
    });
  };

  const resetCurve = () =>
    applyPatch({
      parametricCurve: { ...parametricBase, luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS } },
      curveMode: 'parametric',
      curves: {
        ...(adjustments.curves ?? {}),
        luma: buildParametricPoints(DEFAULT_PARAMETRIC_CURVE_SETTINGS),
      },
    });

  return (
    <PanelShell titleKey="crystal.categories.tone">
      <div className="cx-tone-tabs" role="tablist">
        {TONE_TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            role="tab"
            aria-selected={tab === tabDef.id}
            className={`cx-tone-tab${tab === tabDef.id ? ' active' : ''}`}
            onClick={() => setTab(tabDef.id)}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'light' && (
        <>
          <CxSliderRow
            label={t('crystal.tone.exposure')}
            min={-5}
            max={5}
            step={0.05}
            value={Number(adjustments.exposure ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ exposure: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.brightness')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.brightness ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ brightness: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.contrast')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.contrast ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ contrast: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.highlights')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.highlights ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ highlights: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.shadows')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.shadows ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ shadows: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.whites')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.whites ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ whites: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.blacks')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.blacks ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ blacks: v })}
          />
        </>
      )}

      {tab === 'color' && (
        <>
          <CxSliderRow
            label={t('crystal.tone.temperature')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.temperature ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ temperature: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.tint')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.tint ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ tint: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.vibrance')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.vibrance ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ vibrance: v })}
          />
          <CxSliderRow
            label={t('crystal.tone.saturation')}
            min={-100}
            max={100}
            step={1}
            value={Number(adjustments.saturation ?? 0)}
            defaultValue={0}
            onChange={(v) => applyPatch({ saturation: v })}
          />

          <div className="cx-hsl">
            <div className="cx-hsl-title">{t('crystal.tone.hslTitle')}</div>
            <div className="cx-hsl-bands">
              {HSL_BANDS.map((bandDef) => (
                <button
                  key={bandDef.id}
                  className={`cx-hsl-band${band === bandDef.id ? ' active' : ''}`}
                  style={{ '--band-color': bandDef.swatch } as React.CSSProperties}
                  onClick={() => setBand(bandDef.id)}
                  aria-pressed={band === bandDef.id}
                >
                  <span className="cx-hswatch" />
                  {t(bandDef.labelKey)}
                </button>
              ))}
            </div>
            <CxSliderRow
              label={t('crystal.tone.hslHue')}
              min={-100}
              max={100}
              step={1}
              value={Number(bandHsl.hue ?? 0)}
              defaultValue={0}
              onChange={(v) => setHsl('hue', v)}
            />
            <CxSliderRow
              label={t('crystal.tone.hslSaturation')}
              min={-100}
              max={100}
              step={1}
              value={Number(bandHsl.saturation ?? 0)}
              defaultValue={0}
              onChange={(v) => setHsl('saturation', v)}
            />
            <CxSliderRow
              label={t('crystal.tone.hslLuminance')}
              min={-100}
              max={100}
              step={1}
              value={Number(bandHsl.luminance ?? 0)}
              defaultValue={0}
              onChange={(v) => setHsl('luminance', v)}
            />
          </div>
        </>
      )}

      {tab === 'curve' && (
        <>
          <div className="cx-curve-card">
            <svg className="cx-curve-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255,255,255,0.18)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <polyline
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                points={curvePoints.map((p) => `${(p.x / 255) * 100},${100 - (p.y / 255) * 100}`).join(' ')}
              />
            </svg>
            <button className="cx-curve-reset" onClick={resetCurve}>
              <RotateCcw size={12} />
              {t('crystal.tone.curveReset')}
            </button>
          </div>
          <CxSliderRow
            label={t('crystal.tone.curveDarks')}
            min={-100}
            max={100}
            step={1}
            value={Number(lumaCurve.darks ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('darks', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveShadows')}
            min={-100}
            max={100}
            step={1}
            value={Number(lumaCurve.shadows ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('shadows', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveHighlights')}
            min={-100}
            max={100}
            step={1}
            value={Number(lumaCurve.highlights ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('highlights', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveLights')}
            min={-100}
            max={100}
            step={1}
            value={Number(lumaCurve.lights ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('lights', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveBlack')}
            min={0}
            max={100}
            step={1}
            value={Number(lumaCurve.blackLevel ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('blackLevel', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveWhite')}
            min={-100}
            max={0}
            step={1}
            value={Number(lumaCurve.whiteLevel ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('whiteLevel', v)}
          />
        </>
      )}
    </PanelShell>
  );
}

/* ---------------------------- 人像（真实参数组合，无伪造 AI） ---------------------------- */
function PortraitPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch } = useCrystalAdjust();
  const { handleGenerateAiFaceMask, findContainer, ensureContainer, setMaskAdjustments, maskReady, removeContainer } =
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
    // 已识别过深度图：直接复用它开启，避免重复调用重推理
    if (adj.lensBlurDepthMap) {
      applyPatch({ lensBlurEnabled: true, lensBlurAmount: adj.lensBlurAmount || 50 });
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
        <>
          <CxSliderRow
            label={t('crystal.portrait.eyeStrength')}
            min={0}
            max={100}
            step={1}
            value={Math.max(0, Math.min(100, eyeStrength))}
            onChange={setEyeStrength}
          />
          <button className="cx-mask-remove" onClick={() => removeContainer(Mask.AiFace)}>
            <X size={11} />
            {t('crystal.portrait.removeMask')}
          </button>
        </>
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

  /* 旋转 90°：与桌面 handleRotate 同源 —— 比例取逆、裁剪按新朝向重算、拉直归零 */
  const rotate90 = useCallback(() => {
    const newSteps = ((adjustments.orientationSteps || 0) + 1) % 4;
    const newRatio = adjustments.aspectRatio ? 1 / adjustments.aspectRatio : adjustments.aspectRatio;
    const newCrop =
      newRatio && selectedImage?.width && selectedImage?.height
        ? calculateCenteredCrop(selectedImage.width, selectedImage.height, newSteps, newRatio, 0)
        : null;
    applyPatch(
      { orientationSteps: newSteps, rotation: 0, aspectRatio: newRatio, crop: newCrop },
      { enableTools: false },
    );
  }, [adjustments.orientationSteps, adjustments.aspectRatio, applyPatch, selectedImage]);

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

  /* 拉直：裁剪窗口跟随旋转（calculateAutoCropForRotation 面积保持），无裁剪时仅改角度 */
  const setRotation = useCallback(
    (v: number) => {
      const patch: Record<string, unknown> = { rotation: v };
      if (selectedImage?.width && selectedImage?.height && adjustments.crop) {
        patch.crop = calculateAutoCropForRotation(
          selectedImage.width,
          selectedImage.height,
          adjustments.orientationSteps || 0,
          adjustments.aspectRatio,
          v,
          adjustments.crop,
          v - (adjustments.rotation || 0),
        );
      }
      applyPatch(patch, { enableTools: false });
    },
    [adjustments.aspectRatio, adjustments.crop, adjustments.orientationSteps, adjustments.rotation, applyPatch, selectedImage],
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
        defaultValue={0}
        onChange={setRotation}
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

/* ---------------------------- 特效（LUT + 真实管线参数） ---------------------------- */
interface LutEntry {
  name: string;
  path: string;
  isBuiltIn: boolean;
  isSceneReferred: boolean;
}
interface LutPreviewResult {
  path: string;
  thumb: string | null;
}
const LUT_PREVIEW_SIZE = 96;

function FxPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const isImageReady = useEditorStore((s) => s.selectedImage?.isReady ?? false);
  const { applyPatch } = useCrystalAdjust();
  const { handleLutSelect } = useEditorActions();
  const [lutEntries, setLutEntries] = useState<LutEntry[]>([]);
  const [lutPreviews, setLutPreviews] = useState<Record<string, string | null>>({});
  const lutCache = useRef<Map<string, Record<string, string | null>>>(new Map());

  /* LUT 列表（list_luts） */
  const refreshLuts = useCallback(async () => {
    try {
      const list = await invoke<LutEntry[]>('list_luts');
      setLutEntries(list);
    } catch (e) {
      console.error('Failed to list LUTs:', e);
    }
  }, []);

  useEffect(() => {
    void refreshLuts();
  }, [refreshLuts]);

  /* LUT 缩略图（generate_lut_previews），按图片缓存 */
  useEffect(() => {
    if (!selectedPath || !isImageReady || lutEntries.length === 0) {
      setLutPreviews({});
      return;
    }
    const cacheKey = `${selectedPath}|${lutEntries
      .map((e) => `${e.path}:${e.isBuiltIn ? 1 : 0}:${e.isSceneReferred ? 1 : 0}`)
      .join(',')}`;
    const cached = lutCache.current.get(cacheKey);
    if (cached) {
      setLutPreviews(cached);
      return;
    }
    let active = true;
    invoke<LutPreviewResult[]>('generate_lut_previews', {
      luts: lutEntries.map((e) => ({
        path: e.path,
        isBuiltIn: e.isBuiltIn,
        isSceneReferred: e.isSceneReferred,
      })),
      size: LUT_PREVIEW_SIZE,
    })
      .then((results) => {
        if (!active) return;
        const map: Record<string, string | null> = {};
        results.forEach((r) => {
          map[r.path] = r.thumb;
        });
        lutCache.current.set(cacheKey, map);
        setLutPreviews(map);
      })
      .catch((e) => console.error('Failed to generate LUT previews:', e));
    return () => {
      active = false;
    };
  }, [selectedPath, isImageReady, lutEntries]);

  /* LUT 导入：Android content URI 需解析名称并按扩展名过滤（与桌面同链路） */
  const importLuts = async () => {
    try {
      const { osPlatform } = useSettingsStore.getState();
      const isAndroid = osPlatform === 'android';
      const selected = await open({
        multiple: true,
        filters: isAndroid
          ? []
          : [
              {
                name: t('ui.lut.filterLabel'),
                // 与桌面 LUTControl 一致：附带大写扩展名，.CUBE 等文件不被过滤
                extensions: [
                  'cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff',
                  'CUBE', '3DL', 'PNG', 'JPG', 'JPEG', 'TIFF',
                ],
              },
            ],
      });
      const sourcePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (sourcePaths.length === 0) return;
      let validPaths = sourcePaths;
      if (isAndroid) {
        const resolvedNames = await Promise.all(
          sourcePaths.map(async (path) => {
            try {
              return await invoke<string>('resolve_android_content_uri_name', { uriStr: path });
            } catch (e) {
              console.error('Failed to resolve Android URI:', e);
              return path;
            }
          }),
        );
        const allowed = new Set(['cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff']);
        validPaths = sourcePaths.filter((_, i) => allowed.has(resolvedNames[i].split('.').pop()?.toLowerCase() || ''));
        if (validPaths.length === 0) {
          toast.error(t('ui.lut.importFailed'));
          return;
        }
      }
      const list = await invoke<LutEntry[]>('import_luts', { sourcePaths: validPaths });
      lutCache.current.clear();
      setLutEntries(list);
      setLutPreviews({});
    } catch (e) {
      console.error('Failed to import LUTs:', e);
      toast.error(t('ui.lut.importFailed'));
    }
  };

  const clearLut = () =>
    applyPatch({
      lutPath: null,
      lutName: null,
      lutData: null,
      lutSize: 0,
      lutIntensity: 100,
      lutIsSceneReferred: false,
    });

  const vignetteOn = Number(adjustments.vignetteAmount ?? 0) !== 0;
  const grainOn = Number(adjustments.grainAmount ?? 0) > 0;

  return (
    <PanelShell titleKey="crystal.categories.fx">
      <div className="cx-lut">
        <div className="cx-lut-head">
          <span className="cx-lut-title">{t('crystal.fx.lut')}</span>
          <button className="cx-lut-import" onClick={() => void importLuts()}>
            <Upload size={11} />
            {t('crystal.fx.lutImport')}
          </button>
        </div>
        <div className="cx-lut-strip">
          {lutEntries.map((entry) => (
            <button
              key={entry.path}
              className={`cx-lut-thumb${adjustments.lutPath === entry.path ? ' active' : ''}`}
              onClick={() => {
                if (entry.path === adjustments.lutPath) clearLut();
                else void handleLutSelect(entry.path, entry.isSceneReferred);
              }}
            >
              <span className="cx-lut-img">
                {lutPreviews[entry.path] ? (
                  <img src={lutPreviews[entry.path] as string} alt={entry.name} draggable={false} />
                ) : (
                  <ImageOff size={14} />
                )}
              </span>
              <span className="cx-lut-name">{entry.name}</span>
            </button>
          ))}
          {lutEntries.length === 0 && <span className="cx-lut-empty">{t('crystal.fx.lutEmpty')}</span>}
        </div>
        {adjustments.lutPath && (
          <>
            <CxSliderRow
              label={t('crystal.fx.lutIntensity')}
              min={0}
              max={200}
              step={1}
              value={Number(adjustments.lutIntensity ?? 100)}
              defaultValue={100}
              onChange={(v) => applyPatch({ lutIntensity: v })}
            />
            <button className="cx-mask-remove" onClick={clearLut}>
              <X size={11} />
              {t('crystal.fx.lutClear')}
            </button>
          </>
        )}
      </div>

      <CxSubSection labelKey="crystal.fx.groupVignette">
        <CxSliderRow
          label={t('crystal.fx.vignette')}
          min={-100}
          max={100}
          step={1}
          value={Number(adjustments.vignetteAmount ?? 0)}
          defaultValue={0}
          onChange={(v) => applyPatch({ vignetteAmount: v })}
        />
        {vignetteOn && (
          <>
            <CxSliderRow
              label={t('crystal.fx.vignetteMidpoint')}
              min={0}
              max={100}
              step={1}
              value={Number(adjustments.vignetteMidpoint ?? 50)}
              defaultValue={50}
              onChange={(v) => applyPatch({ vignetteMidpoint: v })}
            />
            <CxSliderRow
              label={t('crystal.fx.vignetteRoundness')}
              min={-100}
              max={100}
              step={1}
              value={Number(adjustments.vignetteRoundness ?? 0)}
              defaultValue={0}
              onChange={(v) => applyPatch({ vignetteRoundness: v })}
            />
            <CxSliderRow
              label={t('crystal.fx.vignetteFeather')}
              min={0}
              max={100}
              step={1}
              value={Number(adjustments.vignetteFeather ?? 50)}
              defaultValue={50}
              onChange={(v) => applyPatch({ vignetteFeather: v })}
            />
          </>
        )}
      </CxSubSection>

      <CxSubSection labelKey="crystal.fx.groupGrain">
        <CxSliderRow
          label={t('crystal.fx.grain')}
          min={0}
          max={100}
          step={1}
          value={Number(adjustments.grainAmount ?? 0)}
          defaultValue={0}
          onChange={(v) => applyPatch({ grainAmount: v })}
        />
        {grainOn && (
          <>
            <CxSliderRow
              label={t('crystal.fx.grainSize')}
              min={0}
              max={100}
              step={1}
              value={Number(adjustments.grainSize ?? 25)}
              defaultValue={25}
              onChange={(v) => applyPatch({ grainSize: v })}
            />
            <CxSliderRow
              label={t('crystal.fx.grainRoughness')}
              min={0}
              max={100}
              step={1}
              value={Number(adjustments.grainRoughness ?? 50)}
              defaultValue={50}
              onChange={(v) => applyPatch({ grainRoughness: v })}
            />
          </>
        )}
      </CxSubSection>

      <CxSubSection labelKey="crystal.fx.groupGlow">
        <CxSliderRow
          label={t('crystal.fx.glow')}
          min={0}
          max={100}
          step={1}
          value={Number(adjustments.glowAmount ?? 0)}
          defaultValue={0}
          onChange={(v) => applyPatch({ glowAmount: v })}
        />
        <CxSliderRow
          label={t('crystal.fx.halation')}
          min={0}
          max={100}
          step={1}
          value={Number(adjustments.halationAmount ?? 0)}
          defaultValue={0}
          onChange={(v) => applyPatch({ halationAmount: v })}
        />
        <CxSliderRow
          label={t('crystal.fx.flare')}
          min={0}
          max={100}
          step={1}
          value={Number(adjustments.flareAmount ?? 0)}
          defaultValue={0}
          onChange={(v) => applyPatch({ flareAmount: v })}
        />
      </CxSubSection>

      <CxSubSection labelKey="crystal.fx.groupClarity">
        <CxSliderRow
          label={t('crystal.fx.dehaze')}
          min={-100}
          max={100}
          step={1}
          value={Number(adjustments.dehaze ?? 0)}
          defaultValue={0}
          onChange={(v) => applyPatch({ dehaze: v })}
        />
      </CxSubSection>
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
      return <TonePanel />;
    case 'portrait':
      return <PortraitPanel />;
    case 'compose':
      return <ComposePanel />;
    case 'fx':
      return <FxPanel />;
    default:
      return null;
  }
}
