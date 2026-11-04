import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import {
  Aperture,
  Circle,
  Contrast,
  CopyPlus,
  Crop,
  Eye,
  FlipHorizontal,
  FlipVertical,
  Hexagon,
  ImageOff,
  Loader2,
  Octagon,
  Plus,
  RotateCcw,
  RotateCw,
  ScanLine,
  Smile,
  Sparkles,
  Trash2,
  Upload,
  User,
  Wand2,
  Waves,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  Adjustments,
  ColorCalibration,
  DEFAULT_PARAMETRIC_CURVE_SETTINGS,
  ParametricCurve,
  INITIAL_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  RelightLight,
  createRelightLight,
  getActiveTools,
  getRelightLightColor,
  setToolActive,
} from '../../utils/adjustments';
import { calculateCenteredCrop, calculateAutoCropForRotation } from '../../utils/cropUtils';
import { buildParametricPoints, isDefaultParametricCurve } from '../../utils/parametricCurve';
import { createSubMask } from '../../utils/maskUtils';
import { getTransformAdjustments } from '../../hooks/useAiMasking';
import { useEditorActions } from '../../hooks/useEditorActions';
import { Invokes } from '../ui/AppProperties';
import { DepthRangePicker } from '../ui/DepthRangePicker';
import { selectAiModelDownloadStatus, useProcessStore } from '../../store/useProcessStore';
import {
  CxSliderRow,
  CxSubSection,
  CxSwitch,
  awaitImageReady,
  haptic,
  useCrystalAdjust,
  useCrystalAiMasks,
} from './crystalShared';
import { Mask } from '../panel/right/Masks';
import type { CrystalCategory } from './CrystalMobileApp';
import CrystalPresetsPanel from './CrystalPresetsPanel';
import CrystalAiToolsPanel from './CrystalAiToolsPanel';

/* ---------------------------------------------------------------------------
 * 参数面板骨架：标题 + 滑杆组。所有值读写真实 store.adjustments。
 * 布局统一（以预设/滤镜/AI 工具面板为标准）：标题行与标准面板同规格——
 * 13px 分类图标 + 文案（预设/滤镜 = Wand2、AI = Sparkles，此处按分类导航
 * 同源图标），面板容器由路由层统一挂 .cx-panel（定高滚动卡片）。
 * ------------------------------------------------------------------------- */
function PanelShell({
  titleKey,
  icon: Icon,
  children,
}: {
  titleKey: ParseKeys;
  icon: typeof User;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="cx-panel-title">
        <Icon size={13} className="inline mr-1.5 -mt-0.5" />
        {t(titleKey)}
      </div>
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

/* 分级调色 / 曲线通道 / 校准原色（复用桌面文案键，与 Color.tsx / Curves.tsx 同源） */
type GradingRegion = 'shadows' | 'midtones' | 'highlights' | 'global';
type CurveChannel = 'luma' | 'red' | 'green' | 'blue';

const GRADING_REGIONS: Array<{ id: GradingRegion; labelKey: ParseKeys; swatch: string }> = [
  { id: 'shadows', labelKey: 'adjustments.color.grading.shadows', swatch: '#4dabf7' },
  /* 自检优化：中间调色点遵循三向调色通用配色（达芬奇/LR：阴影蓝·中间调绿·高光橙），原紫色易误导为紫色调 */
  { id: 'midtones', labelKey: 'adjustments.color.grading.midtones', swatch: '#69db7c' },
  { id: 'highlights', labelKey: 'adjustments.color.grading.highlights', swatch: '#ffa94d' },
  { id: 'global', labelKey: 'adjustments.color.grading.global', swatch: '#868e96' },
];

const CURVE_CHANNELS: Array<{ id: CurveChannel; swatch: string }> = [
  { id: 'luma', swatch: '#adb5bd' },
  { id: 'red', swatch: '#ff6b6b' },
  { id: 'green', swatch: '#69db7c' },
  { id: 'blue', swatch: '#4dabf7' },
];

const CALIBRATION_PRIMARIES: Array<{ id: 'red' | 'green' | 'blue'; swatch: string }> = [
  { id: 'red', swatch: '#f87171' },
  { id: 'green', swatch: '#4ade80' },
  { id: 'blue', swatch: '#60a5fa' },
];

function TonePanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch } = useCrystalAdjust();
  const [tab, setTab] = useState<ToneTab>('light');
  const [band, setBand] = useState<keyof Adjustments['hsl']>('reds');
  const [gradingRegion, setGradingRegion] = useState<GradingRegion>('shadows');
  const [primary, setPrimary] = useState<'red' | 'green' | 'blue'>('red');
  const [curveChannel, setCurveChannel] = useState<CurveChannel>('luma');

  const bandHsl = adjustments.hsl?.[band] ?? { hue: 0, saturation: 0, luminance: 0 };
  const grading = adjustments.colorGrading ?? INITIAL_ADJUSTMENTS.colorGrading;
  const gradingRegionHsl = grading[gradingRegion] ?? { hue: 0, saturation: 0, luminance: 0 };
  const calibration = adjustments.colorCalibration ?? INITIAL_ADJUSTMENTS.colorCalibration;
  // ParametricCurve 索引签名要求四通道齐备，缺省时以默认值补全
  const parametricBase: ParametricCurve =
    adjustments.parametricCurve ??
    ({
      blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    } as ParametricCurve);
  const curveSettings = adjustments.parametricCurve?.[curveChannel] ?? DEFAULT_PARAMETRIC_CURVE_SETTINGS;
  /* 曲线通道辅助：点位序列 + 是否被修改过（激活 isDefaultParametricCurve：
   * 未激活但已修改的通道在图上淡显，与桌面 Curves 的 inactive 通道叠加一致） */
  const channelPoints = (ch: CurveChannel) =>
    buildParametricPoints(adjustments.parametricCurve?.[ch] ?? DEFAULT_PARAMETRIC_CURVE_SETTINGS).map(
      (p) => `${(p.x / 255) * 100},${100 - (p.y / 255) * 100}`,
    );
  const channelModified = (ch: CurveChannel) => !isDefaultParametricCurve(adjustments.parametricCurve?.[ch]);

  /* 审计修复（调色）：嵌套对象 patch 一律从 store 实时读取（而非渲染闭包），
   * 消除快速拖动时两个滑杆事件落在同一次重渲染前导致彼此覆盖的竞态。 */
  const setHsl = (key: 'hue' | 'saturation' | 'luminance', value: number) => {
    const hsl = useEditorStore.getState().adjustments.hsl ?? {};
    const cur = hsl[band] ?? { hue: 0, saturation: 0, luminance: 0 };
    applyPatch({ hsl: { ...hsl, [band]: { ...cur, [key]: value } } });
  };

  /* 分级调色：区域 hue/sat/lum + blending/balance（与桌面 ColorGradingPanel 同数据结构） */
  const setGradingHsl = (key: 'hue' | 'saturation' | 'luminance', value: number) => {
    const g = useEditorStore.getState().adjustments.colorGrading ?? INITIAL_ADJUSTMENTS.colorGrading;
    const region = g[gradingRegion] ?? { hue: 0, saturation: 0, luminance: 0 };
    applyPatch({ colorGrading: { ...g, [gradingRegion]: { ...region, [key]: value } } });
  };

  const setGradingMix = (key: 'blending' | 'balance', value: number) => {
    const g = useEditorStore.getState().adjustments.colorGrading ?? INITIAL_ADJUSTMENTS.colorGrading;
    applyPatch({ colorGrading: { ...g, [key]: value } });
  };

  /* 相机校准：红/绿/蓝原色 hue/sat + 阴影色调（与桌面 ColorCalibrationPanel 同源） */
  const setCalibration = (key: keyof ColorCalibration, value: number) => {
    const cal = useEditorStore.getState().adjustments.colorCalibration ?? INITIAL_ADJUSTMENTS.colorCalibration;
    applyPatch({ colorCalibration: { ...cal, [key]: value } });
  };

  /* 分级/校准整节重置（移动端闭环补充；桌面经由全局重置入口） */
  const resetGrading = () => {
    haptic(6);
    applyPatch({ colorGrading: { ...INITIAL_ADJUSTMENTS.colorGrading } });
  };
  const resetCalibration = () => {
    haptic(6);
    applyPatch({ colorCalibration: { ...INITIAL_ADJUSTMENTS.colorCalibration } });
  };

  /* 色彩匹配（AI 追色）：拾取样片 → ComputeColorMatch → 合并 colorGrading/curves 补丁。
   * 与桌面 handleColorMatch 同链路；Android 样片为 content:// URI，由后端 ContentResolver 读取。 */
  const [matchBusy, setMatchBusy] = useState(false);
  const handleColorMatch = useCallback(async () => {
    const img = useEditorStore.getState().selectedImage;
    if (!img || matchBusy) return;
    setMatchBusy(true);
    try {
      const { osPlatform } = useSettingsStore.getState();
      const selected = await open({
        multiple: false,
        filters:
          osPlatform === 'android'
            ? []
            : [
                {
                  name: 'Images',
                  extensions: [
                    'jpg',
                    'jpeg',
                    'png',
                    'tif',
                    'tiff',
                    'webp',
                    'avif',
                    'jxl',
                    'heic',
                    'dng',
                    'cr2',
                    'cr3',
                    'nef',
                    'arw',
                    'raf',
                    'orf',
                    'rw2',
                  ],
                },
              ],
      });
      const samplePath = Array.isArray(selected) ? selected[0] : selected;
      if (!samplePath) return;
      const result = await invoke<{
        adjustments?: { colorGrading?: Record<string, unknown>; curves?: Record<string, unknown> };
        metrics?: { deltaEReduction?: number };
      }>(Invokes.ComputeColorMatch, { samplePath, targetPath: img.path });
      const patch = result.adjustments || {};
      const cur = useEditorStore.getState().adjustments;
      const next: Partial<Adjustments> = {};
      if (patch.colorGrading) {
        next.colorGrading = {
          ...INITIAL_ADJUSTMENTS.colorGrading,
          ...(cur.colorGrading ?? {}),
          ...patch.colorGrading,
        } as Adjustments['colorGrading'];
      }
      if (patch.curves) {
        next.curves = {
          ...INITIAL_ADJUSTMENTS.curves,
          ...(cur.curves ?? {}),
          ...patch.curves,
        } as Adjustments['curves'];
      }
      /* 自检修复（调色-AI 追色）：与桌面 Color.tsx handleColorMatch 同源——追色只写
       * colorGrading/curves 两节，必须同时激活对应工具；否则 activeTools 中这两节
       * 为 false 时渲染端 is_tool_active 门控会忽略追色结果（按钮看似无效）。 */
      if (Object.keys(next).length > 0) {
        const activeTools = Object.keys(next).reduce(
          (tools, id) => setToolActive(tools, id, true),
          getActiveTools(cur),
        );
        applyPatch({ ...next, activeTools });
      }
      toast.success(
        t('adjustments.color.colorMatchDone', { reduction: Math.round(result.metrics?.deltaEReduction ?? 0) }),
      );
    } catch (e) {
      console.error('Color match failed:', e);
      toast.error(t('adjustments.color.colorMatchFailed'));
    } finally {
      setMatchBusy(false);
    }
  }, [applyPatch, matchBusy, t]);

  /* 参数化曲线：按通道滑杆实时换算为点曲线（后端渲染 curves[channel]），与桌面 Curves 同一套数学。
   * 审计修复（调色-曲线）：嵌套 patch 一律从 store 实时读取——闭包旧值在快速拖动时
   * 会把上一事件的曲线段回滚（与 HSL/分级/校准修复同类竞态）。 */
  const setParametric = (key: keyof typeof DEFAULT_PARAMETRIC_CURVE_SETTINGS, value: number) => {
    const fresh = useEditorStore.getState().adjustments;
    const base: ParametricCurve =
      fresh.parametricCurve ??
      ({
        blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
        green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
        luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
        red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      } as ParametricCurve);
    const cur = fresh.parametricCurve?.[curveChannel] ?? DEFAULT_PARAMETRIC_CURVE_SETTINGS;
    const next = { ...cur, [key]: value };
    applyPatch({
      parametricCurve: { ...base, [curveChannel]: next },
      curveMode: 'parametric',
      curves: { ...(fresh.curves ?? {}), [curveChannel]: buildParametricPoints(next) },
    });
  };

  const resetCurve = () => {
    haptic(6);
    const fresh = useEditorStore.getState().adjustments;
    applyPatch({
      parametricCurve: {
        ...(fresh.parametricCurve ?? parametricBase),
        [curveChannel]: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      },
      curveMode: 'parametric',
      curves: {
        ...(fresh.curves ?? {}),
        [curveChannel]: buildParametricPoints(DEFAULT_PARAMETRIC_CURVE_SETTINGS),
      },
    });
  };

  return (
    <PanelShell titleKey="crystal.categories.tone" icon={Waves}>
      <div className="cx-tone-tabs" role="tablist">
        {TONE_TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            role="tab"
            aria-selected={tab === tabDef.id}
            className={`cx-tone-tab${tab === tabDef.id ? ' active' : ''}`}
            onClick={() => {
              haptic(6);
              setTab(tabDef.id);
            }}
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
                  onClick={() => {
                    haptic(6);
                    setBand(bandDef.id);
                  }}
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

          <CxSubSection labelKey="adjustments.color.colorGrading">
            <div className="cx-hsl-bands">
              {GRADING_REGIONS.map((region) => (
                <button
                  key={region.id}
                  className={`cx-hsl-band${gradingRegion === region.id ? ' active' : ''}`}
                  style={{ '--band-color': region.swatch } as React.CSSProperties}
                  onClick={() => {
                    haptic(6);
                    setGradingRegion(region.id);
                  }}
                  aria-pressed={gradingRegion === region.id}
                >
                  <span className="cx-hswatch" />
                  {t(region.labelKey)}
                </button>
              ))}
            </div>
            <button
              className="cx-ai-apply mb-2 w-full"
              style={{ width: '100%' }}
              onClick={() => {
                haptic(6);
                void handleColorMatch();
              }}
              disabled={matchBusy}
            >
              {matchBusy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {t('adjustments.color.colorMatch')}
            </button>
            <CxSliderRow
              label={t('crystal.tone.hslHue')}
              min={0}
              max={360}
              step={1}
              value={Number(gradingRegionHsl.hue ?? 0)}
              defaultValue={0}
              onChange={(v) => setGradingHsl('hue', v)}
            />
            <CxSliderRow
              label={t('crystal.tone.hslSaturation')}
              min={0}
              max={100}
              step={1}
              value={Number(gradingRegionHsl.saturation ?? 0)}
              defaultValue={0}
              onChange={(v) => setGradingHsl('saturation', v)}
            />
            <CxSliderRow
              label={t('crystal.tone.hslLuminance')}
              min={-100}
              max={100}
              step={1}
              value={Number(gradingRegionHsl.luminance ?? 0)}
              defaultValue={0}
              onChange={(v) => setGradingHsl('luminance', v)}
            />
            <CxSliderRow
              label={t('adjustments.color.grading.blending')}
              min={0}
              max={100}
              step={1}
              value={Number(grading.blending ?? 0)}
              defaultValue={50}
              onChange={(v) => setGradingMix('blending', v)}
            />
            <CxSliderRow
              label={t('adjustments.color.grading.balance')}
              min={-100}
              max={100}
              step={1}
              value={Number(grading.balance ?? 0)}
              defaultValue={0}
              onChange={(v) => setGradingMix('balance', v)}
            />
            <button className="cx-mask-remove" onClick={resetGrading}>
              <RotateCcw size={11} />
              {t('adjustments.basic.reset')}
            </button>
          </CxSubSection>

          <CxSubSection labelKey="adjustments.color.calibration.title">
            <div className="cx-hsl-bands">
              {CALIBRATION_PRIMARIES.map((prim) => (
                <button
                  key={prim.id}
                  className={`cx-hsl-band${primary === prim.id ? ' active' : ''}`}
                  style={{ '--band-color': prim.swatch } as React.CSSProperties}
                  onClick={() => {
                    haptic(6);
                    setPrimary(prim.id);
                  }}
                  aria-pressed={primary === prim.id}
                >
                  <span className="cx-hswatch" />
                  {t(`adjustments.color.calibration.colors.${prim.id}`)}
                </button>
              ))}
            </div>
            <CxSliderRow
              label={t('adjustments.color.calibration.hue')}
              min={-100}
              max={100}
              step={1}
              value={Number(calibration[`${primary}Hue`] ?? 0)}
              defaultValue={0}
              onChange={(v) => setCalibration(`${primary}Hue`, v)}
            />
            <CxSliderRow
              label={t('adjustments.color.calibration.saturation')}
              min={-100}
              max={100}
              step={1}
              value={Number(calibration[`${primary}Saturation`] ?? 0)}
              defaultValue={0}
              onChange={(v) => setCalibration(`${primary}Saturation`, v)}
            />
            <CxSliderRow
              label={`${t('adjustments.color.calibration.shadows')} · ${t('adjustments.color.calibration.tint')}`}
              min={-100}
              max={100}
              step={1}
              value={Number(calibration.shadowsTint ?? 0)}
              defaultValue={0}
              onChange={(v) => setCalibration('shadowsTint', v)}
            />
            <button className="cx-mask-remove" onClick={resetCalibration}>
              <RotateCcw size={11} />
              {t('adjustments.basic.reset')}
            </button>
          </CxSubSection>
        </>
      )}

      {tab === 'curve' && (
        <>
          <div className="cx-hsl-bands">
            {CURVE_CHANNELS.map((ch) => (
              <button
                key={ch.id}
                className={`cx-hsl-band${curveChannel === ch.id ? ' active' : ''}`}
                style={{ '--band-color': ch.swatch } as React.CSSProperties}
                onClick={() => {
                  haptic(6);
                  setCurveChannel(ch.id);
                }}
                aria-pressed={curveChannel === ch.id}
              >
                <span className="cx-hswatch" />
                {t(`adjustments.curves.channels.${ch.id}`)}
              </button>
            ))}
          </div>
          <div className="cx-curve-card">
            <svg className="cx-curve-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <line
                x1="0"
                y1="100"
                x2="100"
                y2="0"
                stroke="rgba(255,255,255,0.18)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              {/* 未激活但已修改的通道淡显（与桌面 Curves.tsx inactive 通道叠加同构） */}
              {CURVE_CHANNELS.filter((ch) => ch.id !== curveChannel && channelModified(ch.id)).map((ch) => (
                <polyline
                  key={ch.id}
                  fill="none"
                  stroke={ch.swatch}
                  strokeWidth="1.5"
                  strokeOpacity="0.5"
                  vectorEffect="non-scaling-stroke"
                  points={channelPoints(ch.id).join(' ')}
                />
              ))}
              <polyline
                fill="none"
                stroke={CURVE_CHANNELS.find((ch) => ch.id === curveChannel)?.swatch ?? 'var(--color-accent)'}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                points={channelPoints(curveChannel).join(' ')}
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
            value={Number(curveSettings.darks ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('darks', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveShadows')}
            min={-100}
            max={100}
            step={1}
            value={Number(curveSettings.shadows ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('shadows', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveHighlights')}
            min={-100}
            max={100}
            step={1}
            value={Number(curveSettings.highlights ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('highlights', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveLights')}
            min={-100}
            max={100}
            step={1}
            value={Number(curveSettings.lights ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('lights', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveBlack')}
            min={0}
            max={100}
            step={1}
            value={Number(curveSettings.blackLevel ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('blackLevel', v)}
          />
          <CxSliderRow
            label={t('crystal.tone.curveWhite')}
            min={-100}
            max={0}
            step={1}
            value={Number(curveSettings.whiteLevel ?? 0)}
            defaultValue={0}
            onChange={(v) => setParametric('whiteLevel', v)}
          />
        </>
      )}
    </PanelShell>
  );
}

/* ---------------------------- 人像 ---------------------------- */
/* 人像精修算子：与桌面 MasksPanel RETOUCH_OPERATORS 同源（kind/parts/调整映射/激活分区）。
 * 每个算子一个独立 AiFace 容器（parameters.retouchKind 与桌面互相兼容），
 * 强度值由容器调整反推，滑杆 0 时移除容器（与桌面 handleRetouchChange 一致）。 */
interface RetouchOp {
  kind: 'smoothing' | 'teeth' | 'eyes';
  parts: string[];
  labelKey: ParseKeys;
  sections: [string, string];
  tileColor: string;
  map: (v: number) => Record<string, number>;
  inv: (adj: Record<string, unknown>) => number;
}

const RETOUCH_OPS: Array<RetouchOp> = [
  {
    kind: 'smoothing',
    parts: ['faceSkin', 'bodySkin'],
    labelKey: 'crystal.portrait.smoothSkin',
    sections: ['details', 'details'],
    tileColor: 'var(--cx-cat-tone)',
    map: (v) => ({ lumaNoiseReduction: v, sharpness: v * 0.3 }),
    inv: (adj) => Math.round(Number(adj.lumaNoiseReduction ?? 0)),
  },
  {
    kind: 'teeth',
    parts: ['teeth'],
    labelKey: 'crystal.portrait.teethWhiten',
    sections: ['basic', 'color'],
    tileColor: 'var(--cx-cat-portrait)',
    map: (v) => ({ exposure: v * 0.25, saturation: -v * 0.4 }),
    inv: (adj) => Math.round(Number(adj.exposure ?? 0) / 0.25),
  },
  {
    kind: 'eyes',
    parts: ['iris', 'eyeWhites'],
    labelKey: 'crystal.portrait.eyeEnhance',
    sections: ['basic', 'details'],
    tileColor: 'var(--cx-cat-ai)',
    map: (v) => ({ clarity: v * 0.4, exposure: v * 0.12 }),
    inv: (adj) => Math.round(Number(adj.clarity ?? 0) / 0.4),
  },
];
const RETOUCH_DEFAULT = 50;

function PortraitPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const { applyPatch, setAdjustments } = useCrystalAdjust();
  const {
    handleGenerateAiFaceMask,
    findLiquifyHost,
    createLiquifyHost,
    findContainerByKind,
    removeContainerByKind,
    updateSubMaskParameters,
    setMaskAdjustments,
  } = useCrystalAiMasks();

  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [unifyBusy, setUnifyBusy] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const [oneTapBusy, setOneTapBusy] = useState(false);
  const liquifyTimerRef = useRef<number | null>(null);
  const liquifyGenRef = useRef(0);

  useEffect(
    () => () => {
      if (liquifyTimerRef.current) window.clearTimeout(liquifyTimerRef.current);
    },
    [],
  );

  const activateSections = (sections: [string, string]): Record<string, boolean> => {
    const at = { ...getActiveTools(INITIAL_MASK_CONTAINER.adjustments) } as Record<string, boolean>;
    at[sections[0]] = true;
    at[sections[1]] = true;
    return at;
  };

  /* 算子开关：未开启 → 建独立 AiFace 容器（parts 限定作用域）并识别；已开启 → 移除。 */
  const runOperator = useCallback(
    async (op: RetouchOp) => {
      if (opBusy) return;
      if (findContainerByKind(op.kind)) {
        removeContainerByKind(op.kind);
        return;
      }
      setOpBusy(op.kind);
      try {
        // 闭环修复（人像-激活）：人脸识别依赖后端已加载原图，图片未就绪时点击
        // 会立即失败并闪断激活态。先等待就绪（busy 转圈反馈），超时/切图则放弃。
        const startPath = useEditorStore.getState().selectedImage?.path;
        if (!startPath) return;
        if (!useEditorStore.getState().selectedImage?.isReady && !(await awaitImageReady(startPath))) return;
        if (useEditorStore.getState().selectedImage?.path !== startPath) return;
        const { selectedImage: img } = useEditorStore.getState();
        const subMask = createSubMask(Mask.AiFace, { width: img?.width ?? 1000, height: img?.height ?? 1000 });
        subMask.parameters = {
          ...subMask.parameters,
          parts: [...op.parts],
          retouchKind: op.kind,
          retouch: { [op.kind]: RETOUCH_DEFAULT },
        };
        const containerId = uuidv4();
        const container = {
          ...INITIAL_MASK_CONTAINER,
          id: containerId,
          name: t(`editor.masks.retouch.${op.kind}Container`),
          subMasks: [subMask],
          adjustments: {
            ...INITIAL_MASK_CONTAINER.adjustments,
            ...op.map(RETOUCH_DEFAULT),
            activeTools: activateSections(op.sections),
          },
        };
        setAdjustments((prev) => ({ ...prev, masks: [...(prev.masks || []), container] }));
        // silent：hook 不再自带错误提示，统一由下方「无 maskDataBase64」判定后
        // 单源提示（此前 hook + 面板双 toast，用户一次点击看到两条错误）。
        await handleGenerateAiFaceMask(subMask.id, op.parts, { silent: true });
        const latest = useEditorStore.getState().adjustments;
        const created = (latest.masks || []).find((c) => c.id === containerId);
        if (created && !created.subMasks[0]?.parameters?.maskDataBase64) {
          // 审计修复（人像）：识别失败（无人脸/模型缺失/取消）时移除刚建的空容器，
          // 否则面板残留一个"无蒙版"的算子开关——开关看似生效、强度滑杆可拖但毫无效果。
          // 二轮补充：容器已被用户在生成期间手动移除（或已切图）时不误报失败、不重复清理。
          setAdjustments((prev) => ({
            ...prev,
            masks: (prev.masks || []).filter((c) => c.id !== containerId),
          }));
          toast.error(t('crystal.ai.maskFailed'));
        }
      } catch {
        // 异常路径同样清理可能已入库的容器（识别调用抛错时机不固定）
        const latest = useEditorStore.getState().adjustments;
        const created = (latest.masks || []).find((c) => c.subMasks?.[0]?.parameters?.retouchKind === op.kind);
        if (created) {
          setAdjustments((prev) => ({
            ...prev,
            masks: (prev.masks || []).filter((c) => c.id !== created.id),
          }));
        }
        toast.error(t('crystal.ai.maskFailed'));
      } finally {
        setOpBusy(null);
      }
    },
    [findContainerByKind, handleGenerateAiFaceMask, opBusy, removeContainerByKind, setAdjustments, t],
  );

  /* 移除算子容器；若其承载美型（liquify）值，则同步清掉对应 aiPatch。 */
  const removeOperator = useCallback(
    (op: RetouchOp) => {
      const container = findContainerByKind(op.kind);
      removeContainerByKind(op.kind);
      const liq = container?.subMasks[0]?.parameters?.liquify as { slimFace?: number; jawline?: number } | undefined;
      if (container && liq && ((liq.slimFace ?? 0) > 0 || (liq.jawline ?? 0) > 0)) {
        const patchId = `face-liquify-${container.id}`;
        useEditorStore.getState().patchesSentToBackend.delete(patchId);
        setAdjustments((prev) => ({
          ...prev,
          aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
        }));
      }
    },
    [findContainerByKind, removeContainerByKind, setAdjustments],
  );

  /* 统一肤色：复用桌面 ComputeSkinUnify，结果写入磨皮容器 colorGrading.global。 */
  const handleUnifySkin = useCallback(async () => {
    const container = findContainerByKind('smoothing');
    const img = useEditorStore.getState().selectedImage;
    if (!container || !img) return;
    setUnifyBusy(true);
    try {
      // 闭环修复（人像-激活）：统一肤色读原图像素，图片未就绪时先等待，
      // 超时/切图放弃（与算子/虚化链路同一守卫）。
      if (!img.isReady && !(await awaitImageReady(img.path))) return;
      if (useEditorStore.getState().selectedImage?.path !== img.path) return;
      const main = useEditorStore.getState();
      const result: { colorGrading?: { global?: Record<string, unknown> } } | null = await invoke(
        Invokes.ComputeSkinUnify,
        {
          jsAdjustments: getTransformAdjustments(main.adjustments),
          path: img.path,
          rotation: main.adjustments.rotation ?? 0,
          flipHorizontal: main.adjustments.flipHorizontal ?? false,
          flipVertical: main.adjustments.flipVertical ?? false,
          orientationSteps: main.adjustments.orientationSteps ?? 0,
        },
      );
      const global = result?.colorGrading?.global;
      if (global) {
        // 审计修复（人像-跨图）：统一肤色计算期间切图则丢弃结果，避免把旧图的
        // 肤色结果写进新图上下文并误报成功（容器 by-id 写入本身是 no-op，提示是错的）。
        if (useEditorStore.getState().selectedImage?.path !== img.path) return;
        setAdjustments((prev) => ({
          ...prev,
          masks: (prev.masks || []).map((c) =>
            c.id === container.id
              ? {
                  ...c,
                  adjustments: {
                    ...c.adjustments,
                    colorGrading: {
                      ...INITIAL_MASK_CONTAINER.adjustments.colorGrading,
                      ...(c.adjustments.colorGrading ?? {}),
                      global: {
                        ...INITIAL_MASK_CONTAINER.adjustments.colorGrading.global,
                        ...((c.adjustments.colorGrading ?? {}).global ?? {}),
                        ...global,
                      },
                    },
                    activeTools: setToolActive(getActiveTools(c.adjustments), 'color', true),
                  },
                }
              : c,
          ),
        }));
        toast.success(t('crystal.portrait.unifyDone'));
      }
    } catch (e) {
      console.error('Skin unify failed:', e);
      toast.error(t('crystal.portrait.unifyFailed'));
    } finally {
      setUnifyBusy(false);
    }
  }, [findContainerByKind, setAdjustments, t]);

  /* 一键人像完整链路（三层，失败层级回退——全局参数始终生效）：
   * 1) 全局柔肤/通透/暖调：增量基准实时读 + clamp ±100（用户已调高值时
   *    一键不再把参数推出滑杆可表示域，避免滑杆饱和与导出域不一致）；
   * 2) AI 磨皮：未开启则自动识别人脸并建立磨皮容器（复用 runOperator 全链路）；
   * 3) 统一肤色：磨皮就绪后自动执行（复用 handleUnifySkin）。
   * 无人脸/识别失败时容器被清理并提示，全局层仍有效；美型/背景虚化属强主观
   * 与构图选择，不默认开启。 */
  const oneTapPortrait = useCallback(async () => {
    if (oneTapBusy) return;
    setOneTapBusy(true);
    try {
      const adj = useEditorStore.getState().adjustments;
      applyPatch({
        lumaNoiseReduction: Math.max(Number(adj.lumaNoiseReduction ?? 0), 22),
        clarity: Math.max(-100, Math.min(100, Number(adj.clarity ?? 0) + 8)),
        dehaze: Math.max(-100, Math.min(100, Number(adj.dehaze ?? 0) + 6)),
        temperature: Math.max(-100, Math.min(100, Number(adj.temperature ?? 0) + 4)),
        vibrance: Math.max(-100, Math.min(100, Number(adj.vibrance ?? 0) + 8)),
        glowAmount: Math.max(Number(adj.glowAmount ?? 0), 18),
      });
      const smoothingOp = RETOUCH_OPS.find((op) => op.kind === 'smoothing');
      if (smoothingOp && !findContainerByKind('smoothing')) {
        await runOperator(smoothingOp);
      }
      if (findContainerByKind('smoothing')?.subMasks[0]?.parameters?.maskDataBase64) {
        await handleUnifySkin();
      }
    } finally {
      setOneTapBusy(false);
    }
  }, [applyPatch, findContainerByKind, handleUnifySkin, oneTapBusy, runOperator]);

  /* 美型（瘦脸/下颌线）：值存宿主 AiFace 容器 submask.parameters.liquify（与桌面一致），
   * 防抖 600ms 调 GenerateFaceLiquifyPatch → aiPatches upsert；双 0 自动移除补丁。 */
  const runFaceLiquify = useCallback(async () => {
    const main = useEditorStore.getState();
    // 专用宿主（与算子容器隔离）：先取已承载 liquify 值的 AiFace 容器
    const host = findLiquifyHost();
    if (!host || !main.selectedImage) return;
    const imgPath = main.selectedImage.path;
    // 闭环修复（人像-激活）：液化补丁读原图，未就绪时先等待；跨图守卫与
    // 其它 AI 链路一致（生成期间切图则丢弃，避免补丁写错图上下文）。
    if (!main.selectedImage.isReady && !(await awaitImageReady(imgPath))) return;
    if (useEditorStore.getState().selectedImage?.path !== imgPath) return;
    const liq = (host.subMasks[0]?.parameters?.liquify ?? {}) as { slimFace?: number; jawline?: number };
    const slim = liq.slimFace ?? 0;
    const jaw = liq.jawline ?? 0;
    const patchId = `face-liquify-${host.id}`;
    const existing = (main.adjustments.aiPatches || []).find((p) => p.id === patchId);
    if (slim <= 0 && jaw <= 0) {
      if (existing) {
        useEditorStore.getState().patchesSentToBackend.delete(patchId);
        setAdjustments((prev) => ({
          ...prev,
          aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
        }));
      }
      return;
    }
    const gen = ++liquifyGenRef.current;
    setAdjustments((prev) => ({
      ...prev,
      aiPatches: existing
        ? (prev.aiPatches || []).map((p) => (p.id === patchId ? { ...p, isLoading: true } : p))
        : [
            ...(prev.aiPatches || []),
            {
              id: patchId,
              invert: false,
              isLoading: true,
              name: t('editor.masks.retouch.faceLiquify'),
              patchData: null,
              prompt: '',
              subMasks: [
                {
                  ...createSubMask(Mask.Liquify, {
                    width: main.selectedImage?.width ?? 1000,
                    height: main.selectedImage?.height ?? 1000,
                  }),
                  parameters: { radiusX: 0, radiusY: 0 },
                },
              ],
              visible: true,
            },
          ],
    }));
    try {
      const patchJson: string = await invoke(Invokes.GenerateFaceLiquifyPatch, {
        jsAdjustments: getTransformAdjustments(main.adjustments),
        path: main.selectedImage.path,
        rotation: main.adjustments.rotation ?? 0,
        flipHorizontal: main.adjustments.flipHorizontal ?? false,
        flipVertical: main.adjustments.flipVertical ?? false,
        orientationSteps: main.adjustments.orientationSteps ?? 0,
        patchId,
        slimFace: slim,
        jawline: jaw,
      });
      if (gen !== liquifyGenRef.current) return;
      // 生成期间切图：补丁按 patchId upsert 到新图 adjustments 会静默丢失，
      // 且旧图补丁的 isLoading 残留无意义——直接放弃本次写入。
      if (useEditorStore.getState().selectedImage?.path !== imgPath) return;
      const patchData = JSON.parse(patchJson);
      // 同 id 补丁内容已变化：清掉已发送标记，让下一次渲染载荷把新 patchData 发给后端
      useEditorStore.getState().patchesSentToBackend.delete(patchId);
      setAdjustments((prev) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p) => (p.id === patchId ? { ...p, patchData, isLoading: false } : p)),
      }));
    } catch (e) {
      console.error('Face liquify failed:', e);
      setAdjustments((prev) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p) => (p.id === patchId ? { ...p, isLoading: false } : p)),
      }));
      toast.error(t('crystal.portrait.liquifyFailed'));
    }
  }, [findLiquifyHost, setAdjustments, t]);

  const setLiquify = useCallback(
    (key: 'slimFace' | 'jawline', v: number) => {
      // 美型值存专用宿主（非算子容器）：移除磨皮/牙齿/眼部不会连带清掉美型
      let host = findLiquifyHost();
      if (!host) host = createLiquifyHost();
      const liq = (host.subMasks[0]?.parameters?.liquify ?? {}) as { slimFace?: number; jawline?: number };
      updateSubMaskParameters(host.id, host.subMasks[0].id, { liquify: { ...liq, [key]: v } });
      if (liquifyTimerRef.current) window.clearTimeout(liquifyTimerRef.current);
      liquifyTimerRef.current = window.setTimeout(() => void runFaceLiquify(), 600);
    },
    [createLiquifyHost, findLiquifyHost, runFaceLiquify, updateSubMaskParameters],
  );

  /* 背景虚化 —— 复用桌面 Effects 链路（generate_full_image_depth_map
   * → lensBlurDepthMap + lensBlurEnabled/Amount），深度图驱动真实管线虚化。 */
  const runBgBlur = useCallback(async () => {
    if (blurBusy) return;
    const { adjustments: adj } = useEditorStore.getState();
    if (adj.lensBlurEnabled) {
      applyPatch({ lensBlurEnabled: false });
      return;
    }
    // 已识别过深度图：直接复用它开启，避免重复调用重推理。
    // amount 为 0 时回落默认 50：否则「开关已激活但强度 0」——激活态无任何效果。
    if (adj.lensBlurDepthMap) {
      applyPatch({ lensBlurEnabled: true, lensBlurAmount: adj.lensBlurAmount || 50 });
      return;
    }
    // 审计修复（人像-跨图）：深度图生成期间切图则丢弃结果，避免旧图的深度图
    // 写入新图 adjustments 后被「复用已识别深度图」路径误用（与特效面板同守卫）。
    // 守卫置于 busy 置位之前：早退不得跳过 finally 复位（否则瓦片永久禁用）。
    const startPath = useEditorStore.getState().selectedImage?.path;
    if (!startPath) return;
    setBlurBusy(true);
    try {
      // 闭环修复（人像-激活）：深度图推理依赖后端原图，未就绪时先等待。
      if (!useEditorStore.getState().selectedImage?.isReady && !(await awaitImageReady(startPath))) return;
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      const b64: string = await invoke('generate_full_image_depth_map', { jsAdjustments: adj });
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      applyPatch({ lensBlurDepthMap: b64, lensBlurEnabled: true, lensBlurAmount: 50 });
    } catch {
      if (useEditorStore.getState().selectedImage?.path === startPath) {
        toast.error(t('crystal.portrait.blurFailed'));
      }
    } finally {
      setBlurBusy(false);
    }
  }, [applyPatch, blurBusy, t]);

  const liquifyHost = findLiquifyHost();
  const liquifyValues = (liquifyHost?.subMasks[0]?.parameters?.liquify ?? {}) as {
    slimFace?: number;
    jawline?: number;
  };

  return (
    <PanelShell titleKey="crystal.categories.portrait" icon={User}>
      <button
        className="cx-ai-apply mb-3 w-full"
        onClick={() => {
          haptic(8);
          void oneTapPortrait();
        }}
        disabled={oneTapBusy || Boolean(opBusy) || unifyBusy || blurBusy}
        style={{ width: '100%' }}
      >
        {oneTapBusy && <Loader2 size={13} className="animate-spin inline mr-1.5 -mt-0.5" />}
        {t('crystal.portrait.oneTap')}
      </button>

      <div className="cx-grid-tiles mb-2">
        {RETOUCH_OPS.map((op) => {
          const active = Boolean(findContainerByKind(op.kind));
          const busy = opBusy === op.kind;
          return (
            <button
              key={op.kind}
              className={`cx-tile ${active ? 'is-active' : ''}`}
              onClick={() => {
                haptic(6);
                void runOperator(op);
              }}
              disabled={Boolean(opBusy) || oneTapBusy}
            >
              {busy ? (
                <Loader2 size={20} className="animate-spin" style={{ color: 'var(--cx-accent)' }} />
              ) : (
                <span
                  className="cx-tile-color flex items-center justify-center"
                  style={{ ['--cx-tile-color' as string]: op.tileColor }}
                >
                  {op.kind === 'smoothing' ? (
                    <Sparkles size={13} />
                  ) : op.kind === 'teeth' ? (
                    <Smile size={13} />
                  ) : (
                    <Eye size={13} />
                  )}
                </span>
              )}
              {t(op.labelKey)}
            </button>
          );
        })}
        <button
          className={`cx-tile ${adjustments.lensBlurEnabled ? 'is-active' : ''}`}
          onClick={() => {
            haptic(6);
            runBgBlur();
          }}
          disabled={blurBusy}
        >
          {blurBusy ? (
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--cx-accent)' }} />
          ) : (
            <span
              className="cx-tile-color flex items-center justify-center"
              style={{ ['--cx-tile-color' as string]: 'var(--cx-cat-compose)' }}
            >
              <Aperture size={13} />
            </span>
          )}
          {t('crystal.portrait.bgBlur')}
        </button>
      </div>

      {RETOUCH_OPS.map((op) => {
        const container = findContainerByKind(op.kind);
        if (!container) return null;
        const ready = Boolean(container.subMasks[0]?.parameters?.maskDataBase64);
        const strength = Math.max(0, Math.min(100, op.inv(container.adjustments as Record<string, unknown>)));
        return (
          <div key={`sec-${op.kind}`} className="mb-1">
            <CxSliderRow
              label={`${t(op.labelKey)} · ${t('crystal.portrait.opStrength')}`}
              min={0}
              max={100}
              step={1}
              value={strength}
              onChange={(v) => {
                if (v <= 0) {
                  removeOperator(op);
                  return;
                }
                setMaskAdjustments(container.id, op.map(v));
              }}
            />
            {op.kind === 'smoothing' && ready && (
              <button
                className="cx-mask-remove"
                onClick={() => {
                  haptic(6);
                  void handleUnifySkin();
                }}
                disabled={unifyBusy}
              >
                {unifyBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {t('crystal.portrait.unifySkin')}
              </button>
            )}
            <button
              className="cx-mask-remove"
              onClick={() => {
                haptic(6);
                removeOperator(op);
              }}
            >
              <X size={11} />
              {t('crystal.portrait.removeMask')}
            </button>
          </div>
        );
      })}

      <CxSubSection labelKey="crystal.portrait.faceShape">
        <CxSliderRow
          label={t('crystal.portrait.slimFace')}
          min={0}
          max={100}
          step={1}
          value={Number(liquifyValues.slimFace ?? 0)}
          onChange={(v) => setLiquify('slimFace', v)}
        />
        <CxSliderRow
          label={t('crystal.portrait.jawline')}
          min={0}
          max={100}
          step={1}
          value={Number(liquifyValues.jawline ?? 0)}
          onChange={(v) => setLiquify('jawline', v)}
        />
      </CxSubSection>

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
  const isAutoStraightening = useEditorStore((s) => s.isAutoStraightening);
  const { applyPatch } = useCrystalAdjust();
  const { handleAutoStraighten, handleAutoLensCorrection } = useEditorActions();

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
    /* 审计 C-状态：旋转 90° 后比例取逆（4:3 → 3:4），chip 高亮按用户所选宽比做正/逆双向匹配 */
    const hit = ASPECT_CHIPS.find(
      (c) => c.value && (Math.abs(c.value - ratio) < 0.01 || Math.abs(1 / c.value - ratio) < 0.01),
    );
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

  /* 拉直：裁剪窗口跟随旋转（calculateAutoCropForRotation 面积保持），无裁剪时仅改角度。
   * 审计修复（构图）：从 store 实时读取 rotation/crop 计算面积保持增量，
   * 避免快速拖动时闭包里的旧 rotation 使 delta 计算错位、裁剪窗抖动。 */
  const setRotation = useCallback(
    (v: number) => {
      const fresh = useEditorStore.getState().adjustments;
      const patch: Record<string, unknown> = { rotation: v };
      if (selectedImage?.width && selectedImage?.height && fresh.crop) {
        patch.crop = calculateAutoCropForRotation(
          selectedImage.width,
          selectedImage.height,
          fresh.orientationSteps || 0,
          fresh.aspectRatio,
          v,
          fresh.crop,
          v - (fresh.rotation || 0),
        );
      }
      applyPatch(patch, { enableTools: false });
    },
    [applyPatch, selectedImage],
  );

  /* 重置构图：与桌面 CropPanel.handleReset 同键集（几何变换 + 镜头校正档案/参数一并还原） */
  const resetCompose = useCallback(() => {
    applyPatch(
      {
        aspectRatio: INITIAL_ADJUSTMENTS.aspectRatio,
        crop: INITIAL_ADJUSTMENTS.crop,
        flipHorizontal: INITIAL_ADJUSTMENTS.flipHorizontal,
        flipVertical: INITIAL_ADJUSTMENTS.flipVertical,
        orientationSteps: INITIAL_ADJUSTMENTS.orientationSteps,
        rotation: INITIAL_ADJUSTMENTS.rotation,
        transformDistortion: INITIAL_ADJUSTMENTS.transformDistortion,
        transformVertical: INITIAL_ADJUSTMENTS.transformVertical,
        transformHorizontal: INITIAL_ADJUSTMENTS.transformHorizontal,
        transformRotate: INITIAL_ADJUSTMENTS.transformRotate,
        transformAspect: INITIAL_ADJUSTMENTS.transformAspect,
        transformScale: INITIAL_ADJUSTMENTS.transformScale,
        transformXOffset: INITIAL_ADJUSTMENTS.transformXOffset,
        transformYOffset: INITIAL_ADJUSTMENTS.transformYOffset,
        guidedPerspective: INITIAL_ADJUSTMENTS.guidedPerspective,
        lensMaker: INITIAL_ADJUSTMENTS.lensMaker,
        lensModel: INITIAL_ADJUSTMENTS.lensModel,
        lensDistortionAmount: INITIAL_ADJUSTMENTS.lensDistortionAmount,
        lensVignetteAmount: INITIAL_ADJUSTMENTS.lensVignetteAmount,
        lensTcaAmount: INITIAL_ADJUSTMENTS.lensTcaAmount,
        lensDistortionEnabled: INITIAL_ADJUSTMENTS.lensDistortionEnabled,
        lensTcaEnabled: INITIAL_ADJUSTMENTS.lensTcaEnabled,
        lensVignetteEnabled: INITIAL_ADJUSTMENTS.lensVignetteEnabled,
        lensDistortionParams: INITIAL_ADJUSTMENTS.lensDistortionParams,
        lensCorrectionMode: INITIAL_ADJUSTMENTS.lensCorrectionMode,
      },
      { enableTools: false },
    );
  }, [applyPatch]);

  return (
    <PanelShell titleKey="crystal.categories.compose" icon={Crop}>
      <div className="cx-chip-row mb-3">
        {ASPECT_CHIPS.map(({ labelKey, value }) => (
          <button
            key={labelKey}
            className={`cx-chip ${activeAspect === value ? 'is-active' : ''}`}
            onClick={() => {
              haptic(6);
              rotateChip(value);
            }}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-8 mb-1" style={{ color: 'var(--cx-muted)' }}>
        <button
          className="cx-chip"
          onClick={() => {
            haptic(6);
            rotate90();
          }}
        >
          <RotateCw size={14} className="inline mr-1 -mt-0.5" />
          {t('crystal.compose.rotate90')}
        </button>
        <button
          className={`cx-chip ${adjustments.flipHorizontal ? 'is-active' : ''}`}
          onClick={() => {
            haptic(6);
            applyPatch({ flipHorizontal: !adjustments.flipHorizontal }, { enableTools: false });
          }}
        >
          <FlipHorizontal size={14} className="inline mr-1 -mt-0.5" />
          {t('crystal.compose.flipH')}
        </button>
        <button
          className={`cx-chip ${adjustments.flipVertical ? 'is-active' : ''}`}
          onClick={() => {
            haptic(6);
            applyPatch({ flipVertical: !adjustments.flipVertical }, { enableTools: false });
          }}
        >
          <FlipVertical size={14} className="inline mr-1 -mt-0.5" />
          {t('crystal.compose.flipV')}
        </button>
        {/* 自动拉直：与桌面旋转区同链路（CalculateAutoStraighten + 面积保持裁剪） */}
        <button
          className="cx-chip"
          disabled={isAutoStraightening}
          onClick={() => {
            haptic(6);
            void handleAutoStraighten();
          }}
        >
          {isAutoStraightening ? (
            <Loader2 size={14} className="inline mr-1 -mt-0.5 animate-spin" />
          ) : (
            <ScanLine size={14} className="inline mr-1 -mt-0.5" />
          )}
          {t('contextMenus.editor.autoStraighten')}
        </button>
        {/* 自动镜头校正：与桌面工具栏同链路（EXIF → 镜头档案 → ApplyAutoLensCorrectionToPaths） */}
        <button
          className="cx-chip"
          onClick={() => {
            haptic(6);
            handleAutoLensCorrection();
          }}
        >
          <Aperture size={14} className="inline mr-1 -mt-0.5" />
          {t('contextMenus.editor.autoLensCorrection')}
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
      {/* 几何变换（与桌面 modals.transform 滑杆组同范围/同默认值） */}
      <CxSliderRow
        label={t('modals.transform.distortion')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.transformDistortion ?? 0)}
        defaultValue={0}
        onChange={(v) => applyPatch({ transformDistortion: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('modals.transform.rotate')}
        min={-45}
        max={45}
        step={0.1}
        value={Number(adjustments.transformRotate ?? 0)}
        defaultValue={0}
        onChange={(v) => applyPatch({ transformRotate: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('modals.transform.aspect')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.transformAspect ?? 0)}
        defaultValue={0}
        onChange={(v) => applyPatch({ transformAspect: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('modals.transform.scale')}
        min={50}
        max={150}
        step={1}
        value={Number(adjustments.transformScale ?? 100)}
        defaultValue={100}
        onChange={(v) => applyPatch({ transformScale: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('modals.transform.xAxis')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.transformXOffset ?? 0)}
        defaultValue={0}
        onChange={(v) => applyPatch({ transformXOffset: v }, { enableTools: false })}
      />
      <CxSliderRow
        label={t('modals.transform.yAxis')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.transformYOffset ?? 0)}
        defaultValue={0}
        onChange={(v) => applyPatch({ transformYOffset: v }, { enableTools: false })}
      />
      <button
        className="cx-mask-remove mt-2 w-full"
        onClick={() => {
          haptic(6);
          resetCompose();
        }}
      >
        <RotateCcw size={11} />
        {t('adjustments.basic.reset')}
      </button>
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

/* Spatial AI 散景形状 / 重打光光源类型（与桌面 Effects.tsx 同枚举） */
type BokehShape = 'circle' | 'hexagon' | 'octagon' | 'ring';
type RelightLightType = 'point' | 'spot' | 'directional';

const BOKEH_SHAPES: Array<{ id: BokehShape; Icon: typeof Circle; labelKey: ParseKeys }> = [
  { id: 'circle', Icon: Circle, labelKey: 'adjustments.effects.bokehCircular' },
  { id: 'hexagon', Icon: Hexagon, labelKey: 'adjustments.effects.bokehHexagonal' },
  { id: 'octagon', Icon: Octagon, labelKey: 'adjustments.effects.bokehOctagonal' },
  { id: 'ring', Icon: Aperture, labelKey: 'adjustments.effects.bokehRing' },
];

const RELIGHT_TYPES: Array<{ id: RelightLightType; labelKey: ParseKeys }> = [
  { id: 'point', labelKey: 'adjustments.effects.relightTypes.point' },
  { id: 'spot', labelKey: 'adjustments.effects.relightTypes.spot' },
  { id: 'directional', labelKey: 'adjustments.effects.relightTypes.directional' },
];

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
        /* 审计 FX-内存：缩略图缓存按图累积，限制保留最近 6 组，防长会话内存增长 */
        if (lutCache.current.size > 6) {
          const oldest = lutCache.current.keys().next().value;
          if (oldest !== undefined) lutCache.current.delete(oldest);
        }
        setLutPreviews(map);
      })
      .catch((e) => console.error('Failed to generate LUT previews:', e));
    return () => {
      active = false;
    };
  }, [selectedPath, isImageReady, lutEntries]);

  /* LUT 导入：Android content URI 需解析名称并按扩展名过滤（与桌面同链路）。
     审计 FX-反馈：导入期间按钮忙碌态防重复触发，成功后给出数量反馈。 */
  const [lutImporting, setLutImporting] = useState(false);
  const importLuts = async () => {
    if (lutImporting) return;
    setLutImporting(true);
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
                extensions: ['cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff', 'CUBE', '3DL', 'PNG', 'JPG', 'JPEG', 'TIFF'],
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
      toast.success(t('crystal.fx.lutImported', { n: list.length }));
    } catch (e) {
      console.error('Failed to import LUTs:', e);
      toast.error(t('ui.lut.importFailed'));
    } finally {
      setLutImporting(false);
    }
  };

  const clearLut = () => {
    haptic(6);
    applyPatch({
      lutPath: null,
      lutName: null,
      lutData: null,
      lutSize: 0,
      lutIntensity: 100,
      lutIsSceneReferred: false,
    });
  };

  /* ---------------- Spatial AI 三件套（与桌面 Effects 同链路） ----------------
   * 镜头模糊/雾化共用 generate_full_image_depth_map，重打光走 generate_relight_normal_map；
   * 生成失败按桌面语义回退开关，避免半开启状态；模型下载进度复用全局下载状态。 */
  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider);
  const showSpatial = aiProvider !== 'ai-free';
  const aiDownloadStatus = useProcessStore(selectAiModelDownloadStatus);
  const [genBusy, setGenBusy] = useState<'lensBlur' | 'fog' | 'relight' | null>(null);

  const generateEffectMap = useCallback(
    async (kind: 'lensBlur' | 'fog' | 'relight') => {
      if (genBusy) return;
      /* 审计 FX-串扰：记录生成发起时的图片，完成后若已切图则丢弃结果，
         避免旧图深度/法线图写入新图 adjustments（再次开启会误用错误数据）。 */
      const startPath = useEditorStore.getState().selectedImage?.path;
      setGenBusy(kind);
      try {
        const { adjustments: adj } = useEditorStore.getState();
        if (kind === 'relight') {
          const b64 = await invoke<string>('generate_relight_normal_map', { jsAdjustments: adj });
          if (useEditorStore.getState().selectedImage?.path !== startPath) return;
          applyPatch({ relightNormalMap: b64 });
        } else {
          const b64 = await invoke<string>('generate_full_image_depth_map', { jsAdjustments: adj });
          if (useEditorStore.getState().selectedImage?.path !== startPath) return;
          applyPatch(kind === 'lensBlur' ? { lensBlurDepthMap: b64 } : { fogDepthMap: b64 });
        }
      } catch (e) {
        console.error('Effect map generation failed:', e);
        toast.error(t(kind === 'relight' ? 'crystal.fx.normalFailed' : 'crystal.fx.depthFailed'));
        if (useEditorStore.getState().selectedImage?.path === startPath) {
          applyPatch(
            kind === 'lensBlur'
              ? { lensBlurEnabled: false }
              : kind === 'fog'
                ? { fogEnabled: false }
                : { relightEnabled: false },
          );
        }
      } finally {
        setGenBusy(null);
      }
    },
    [applyPatch, genBusy, t],
  );

  const toggleLensBlur = (on: boolean) => {
    applyPatch({ lensBlurEnabled: on });
    if (on && !adjustments.lensBlurDepthMap) void generateEffectMap('lensBlur');
  };

  const toggleFog = (on: boolean) => {
    applyPatch({ fogEnabled: on });
    if (on && !adjustments.fogDepthMap) void generateEffectMap('fog');
  };

  const toggleRelight = (on: boolean) => {
    applyPatch({ relightEnabled: on });
    if (on && !adjustments.relightNormalMap) void generateEffectMap('relight');
  };

  /* 重打光光源管理：添加/复制/删除/选中 + 参数与位置（移动端以 X/Y 滑杆
   * 替代桌面画布拾取，同样写 relightLights[].x/y，渲染管线无差别）。 */
  const relightLights: Array<RelightLight> = adjustments.relightLights || [];
  const [activeLightId, setActiveLightId] = useState<string | null>(null);
  const activeLight = relightLights.find((l) => l.id === activeLightId) ?? null;

  /* 审计修复（特效-重打光）：光源参数从 store 实时读取后合并——闭包旧数组在快速拖动时
   * 会让两个滑杆事件落在同一次重渲染前互相覆盖（如 intensity 与 temperature 丢一方）。 */
  const updateLight = (id: string, patch: Partial<RelightLight>) => {
    const lights = useEditorStore.getState().adjustments.relightLights || [];
    applyPatch({ relightLights: lights.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  };

  const addLight = () => {
    const light = createRelightLight(0.5, 0.5);
    applyPatch({ relightLights: [...relightLights, light] });
    setActiveLightId(light.id);
  };

  const removeLight = (id: string) => {
    applyPatch({ relightLights: relightLights.filter((l) => l.id !== id) });
    if (id === activeLightId) setActiveLightId(null);
  };

  const duplicateLight = (id: string) => {
    const src = relightLights.find((l) => l.id === id);
    if (!src) return;
    const copy: RelightLight = { ...src, id: uuidv4() };
    const idx = relightLights.findIndex((l) => l.id === id);
    applyPatch({ relightLights: [...relightLights.slice(0, idx + 1), copy, ...relightLights.slice(idx + 1)] });
    setActiveLightId(copy.id);
  };

  const vignetteOn = Number(adjustments.vignetteAmount ?? 0) !== 0;
  const grainOn = Number(adjustments.grainAmount ?? 0) > 0;

  return (
    <PanelShell titleKey="crystal.categories.fx" icon={Contrast}>
      <div className="cx-lut">
        <div className="cx-lut-head">
          <span className="cx-lut-title">{t('crystal.fx.lut')}</span>
          <button
            className="cx-lut-import"
            disabled={lutImporting}
            onClick={() => {
              haptic(6);
              void importLuts();
            }}
          >
            {lutImporting ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {t('crystal.fx.lutImport')}
          </button>
        </div>
        <div className="cx-lut-strip">
          {lutEntries.map((entry) => (
            <button
              key={entry.path}
              className={`cx-lut-thumb${adjustments.lutPath === entry.path ? ' active' : ''}`}
              onClick={() => {
                haptic(6);
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
          {lutEntries.length === 0 && (
            /* UX：文案为「点击导入」，空态本身须可点，与导入按钮等价 */
            <button
              type="button"
              className="cx-lut-empty"
              disabled={lutImporting}
              onClick={() => {
                haptic(6);
                void importLuts();
              }}
            >
              {t('crystal.fx.lutEmpty')}
            </button>
          )}
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
            {/* 中心点位置：桌面为画布拖拽标记，移动端以 X/Y 滑杆闭环（0-100 → 0-1） */}
            <CxSliderRow
              label={t('crystal.fx.centerX')}
              min={0}
              max={100}
              step={1}
              suffix="%"
              value={Math.round(Number(adjustments.vignetteCenterX ?? 0.5) * 100)}
              defaultValue={50}
              onChange={(v) => applyPatch({ vignetteCenterX: v / 100 })}
            />
            <CxSliderRow
              label={t('crystal.fx.centerY')}
              min={0}
              max={100}
              step={1}
              suffix="%"
              value={Math.round(Number(adjustments.vignetteCenterY ?? 0.5) * 100)}
              defaultValue={50}
              onChange={(v) => applyPatch({ vignetteCenterY: v / 100 })}
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

      {/* ------- Spatial AI：镜头模糊 / 重打光 / 雾化（ai-free 档隐藏，与桌面一致） ------- */}
      {showSpatial && (
        <>
          <CxSubSection labelKey="adjustments.effects.lensBlur">
            <CxSwitch
              checked={!!adjustments.lensBlurEnabled}
              onChange={toggleLensBlur}
              disabled={genBusy !== null && genBusy !== 'lensBlur'}
              label={t('adjustments.effects.lensBlur')}
            />
            {genBusy === 'lensBlur' ? (
              <div className="cx-gen-busy">
                <Loader2 size={13} className="animate-spin" />
                <span className={aiDownloadStatus ? 'gen-status' : undefined}>
                  {aiDownloadStatus || t('editor.ai.generatingDepthMap')}
                </span>
              </div>
            ) : adjustments.lensBlurEnabled ? (
              <>
                <CxSliderRow
                  label={t('adjustments.effects.amount')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.lensBlurAmount ?? 40)}
                  defaultValue={40}
                  onChange={(v) => applyPatch({ lensBlurAmount: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.lensDiffusion')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.lensBlurDiffusion ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ lensBlurDiffusion: v })}
                />
                <div className="cx-grid-tiles mb-2" role="radiogroup" aria-label={t('adjustments.effects.bokehShape')}>
                  {BOKEH_SHAPES.map((shape) => (
                    <button
                      key={shape.id}
                      className={`cx-tile${(adjustments.lensBlurShape || 'circle') === shape.id ? ' is-active' : ''}`}
                      onClick={() => {
                        haptic(6);
                        applyPatch({ lensBlurShape: shape.id });
                      }}
                    >
                      <span className="cx-tile-color flex items-center justify-center">
                        <shape.Icon size={13} />
                      </span>
                      {t(shape.labelKey)}
                    </button>
                  ))}
                </div>
                <DepthRangePicker
                  minDepth={100 - (adjustments.lensBlurMaxDepth ?? 100)}
                  maxDepth={100 - (adjustments.lensBlurMinDepth ?? 20)}
                  minFade={adjustments.lensBlurMaxFade ?? 20}
                  maxFade={adjustments.lensBlurMinFade ?? 20}
                  defaultMinDepth={0}
                  defaultMaxDepth={80}
                  defaultMinFade={20}
                  defaultMaxFade={20}
                  onChange={(values) =>
                    applyPatch({
                      lensBlurMinDepth: 100 - values.maxDepth,
                      lensBlurMaxDepth: 100 - values.minDepth,
                      lensBlurMinFade: values.maxFade,
                      lensBlurMaxFade: values.minFade,
                    })
                  }
                />
              </>
            ) : null}
          </CxSubSection>

          <CxSubSection labelKey="adjustments.effects.relight">
            <CxSwitch
              checked={!!adjustments.relightEnabled}
              onChange={toggleRelight}
              disabled={genBusy !== null && genBusy !== 'relight'}
              label={t('adjustments.effects.relight')}
            />
            {genBusy === 'relight' ? (
              <div className="cx-gen-busy">
                <Loader2 size={13} className="animate-spin" />
                <span className={aiDownloadStatus ? 'gen-status' : undefined}>
                  {aiDownloadStatus || t('editor.ai.generatingNormalMap')}
                </span>
              </div>
            ) : adjustments.relightEnabled ? (
              <>
                <CxSliderRow
                  label={t('adjustments.effects.relightAmbient')}
                  min={-100}
                  max={100}
                  step={1}
                  value={Number(adjustments.relightAmbient ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ relightAmbient: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.relightSoftness')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.relightSoftness ?? 25)}
                  defaultValue={25}
                  onChange={(v) => applyPatch({ relightSoftness: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.relightShine')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.relightShine ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ relightShine: v })}
                />
                <CxSwitch
                  checked={!!adjustments.relightShadows}
                  onChange={(on) => applyPatch({ relightShadows: on })}
                  label={t('adjustments.effects.relightShadows')}
                />
                {adjustments.relightShadows && (
                  <CxSliderRow
                    label={t('adjustments.effects.relightShadowSoftness')}
                    min={0}
                    max={100}
                    step={1}
                    value={Number(adjustments.relightShadowSoftness ?? 15)}
                    defaultValue={15}
                    onChange={(v) => applyPatch({ relightShadowSoftness: v })}
                  />
                )}
                <div className="cx-light-strip">
                  {relightLights.map((light) => (
                    <button
                      key={light.id}
                      className={`cx-light-swatch${light.id === activeLightId ? ' is-active' : ''}`}
                      style={{ background: getRelightLightColor(light) }}
                      onClick={() => {
                        haptic(6);
                        setActiveLightId(light.id === activeLightId ? null : light.id);
                      }}
                      aria-label={t('adjustments.effects.relightLight', {
                        index: relightLights.indexOf(light) + 1,
                      })}
                    />
                  ))}
                  <button
                    className="cx-light-add"
                    onClick={() => {
                      haptic(6);
                      addLight();
                    }}
                    aria-label={t('adjustments.effects.relightAddLight')}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {activeLight ? (
                  <>
                    <div className="cx-light-actions">
                      <button
                        className="cx-mask-remove"
                        onClick={() => {
                          haptic(6);
                          duplicateLight(activeLight.id);
                        }}
                      >
                        <CopyPlus size={11} />
                        {t('adjustments.effects.relightDuplicateLight')}
                      </button>
                      <button
                        className="cx-mask-remove"
                        onClick={() => {
                          haptic(6);
                          removeLight(activeLight.id);
                        }}
                      >
                        <Trash2 size={11} />
                        {t('adjustments.effects.relightRemoveLight')}
                      </button>
                    </div>
                    <div className="cx-fx-label mb-1">{t('adjustments.effects.relightType')}</div>
                    <div className="cx-tone-tabs mb-2" role="tablist">
                      {RELIGHT_TYPES.map((tp) => (
                        <button
                          key={tp.id}
                          role="tab"
                          aria-selected={activeLight.type === tp.id}
                          className={`cx-tone-tab${activeLight.type === tp.id ? ' active' : ''}`}
                          onClick={() => {
                            haptic(6);
                            updateLight(activeLight.id, { type: tp.id });
                          }}
                        >
                          {t(tp.labelKey)}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="cx-fx-label">{t('adjustments.effects.relightColor')}</span>
                      <input
                        className="cx-color-input"
                        type="color"
                        value={activeLight.color || '#ffffff'}
                        onChange={(e) => updateLight(activeLight.id, { color: e.target.value })}
                        aria-label={t('adjustments.effects.relightColor')}
                      />
                    </div>
                    <CxSliderRow
                      label={t('adjustments.effects.relightIntensity')}
                      min={0}
                      max={100}
                      step={1}
                      value={activeLight.intensity}
                      defaultValue={60}
                      onChange={(v) => updateLight(activeLight.id, { intensity: v })}
                    />
                    {activeLight.type !== 'directional' && (
                      <>
                        <CxSliderRow
                          label={t('adjustments.effects.relightDepth')}
                          min={0}
                          max={100}
                          step={1}
                          value={activeLight.depth}
                          defaultValue={0}
                          onChange={(v) => updateLight(activeLight.id, { depth: v })}
                        />
                        <CxSliderRow
                          label={t('adjustments.effects.relightFalloff')}
                          min={0}
                          max={100}
                          step={1}
                          value={activeLight.radius}
                          defaultValue={30}
                          onChange={(v) => updateLight(activeLight.id, { radius: v })}
                        />
                      </>
                    )}
                    {activeLight.type !== 'point' && (
                      <>
                        <CxSliderRow
                          label={t('adjustments.effects.relightAngle')}
                          min={0}
                          max={360}
                          step={1}
                          suffix="°"
                          value={activeLight.angle}
                          defaultValue={135}
                          onChange={(v) => updateLight(activeLight.id, { angle: v })}
                        />
                        <CxSliderRow
                          label={t('adjustments.effects.relightElevation')}
                          min={-180}
                          max={180}
                          step={1}
                          suffix="°"
                          value={activeLight.elevation}
                          defaultValue={60}
                          onChange={(v) => updateLight(activeLight.id, { elevation: v })}
                        />
                      </>
                    )}
                    {activeLight.type === 'spot' && (
                      <>
                        <CxSliderRow
                          label={t('adjustments.effects.relightCone')}
                          min={0}
                          max={100}
                          step={1}
                          value={activeLight.cone}
                          defaultValue={40}
                          onChange={(v) => updateLight(activeLight.id, { cone: v })}
                        />
                        <CxSliderRow
                          label={t('adjustments.effects.feather')}
                          min={0}
                          max={100}
                          step={1}
                          value={activeLight.feather}
                          defaultValue={50}
                          onChange={(v) => updateLight(activeLight.id, { feather: v })}
                        />
                      </>
                    )}
                    <CxSliderRow
                      label={t('adjustments.color.temperature')}
                      min={-100}
                      max={100}
                      step={1}
                      value={activeLight.temperature}
                      defaultValue={0}
                      onChange={(v) => updateLight(activeLight.id, { temperature: v })}
                    />
                    <CxSliderRow
                      label={t('adjustments.color.tint')}
                      min={-100}
                      max={100}
                      step={1}
                      value={activeLight.tint}
                      defaultValue={0}
                      onChange={(v) => updateLight(activeLight.id, { tint: v })}
                    />
                    {/* 光源定位：桌面为画布点选/拖拽，移动端以 X/Y 滑杆等价闭环 */}
                    <CxSliderRow
                      label={t('crystal.fx.lightPosX')}
                      min={0}
                      max={100}
                      step={1}
                      suffix="%"
                      value={Math.round(activeLight.x * 100)}
                      defaultValue={50}
                      onChange={(v) => updateLight(activeLight.id, { x: v / 100 })}
                    />
                    <CxSliderRow
                      label={t('crystal.fx.lightPosY')}
                      min={0}
                      max={100}
                      step={1}
                      suffix="%"
                      value={Math.round(activeLight.y * 100)}
                      defaultValue={50}
                      onChange={(v) => updateLight(activeLight.id, { y: v / 100 })}
                    />
                  </>
                ) : (
                  <div className="cx-fx-hint">{t('crystal.fx.relightHint')}</div>
                )}
              </>
            ) : null}
          </CxSubSection>

          <CxSubSection labelKey="adjustments.effects.fog">
            <CxSwitch
              checked={!!adjustments.fogEnabled}
              onChange={toggleFog}
              disabled={genBusy !== null && genBusy !== 'fog'}
              label={t('adjustments.effects.fog')}
            />
            {genBusy === 'fog' ? (
              <div className="cx-gen-busy">
                <Loader2 size={13} className="animate-spin" />
                <span className={aiDownloadStatus ? 'gen-status' : undefined}>
                  {aiDownloadStatus || t('editor.ai.generatingDepthMap')}
                </span>
              </div>
            ) : adjustments.fogEnabled ? (
              <>
                <CxSliderRow
                  label={t('adjustments.effects.amount')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogAmount ?? 50)}
                  defaultValue={50}
                  onChange={(v) => applyPatch({ fogAmount: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.fogStart')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogStart ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ fogStart: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.fogDensity')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogDensity ?? 50)}
                  defaultValue={50}
                  onChange={(v) => applyPatch({ fogDensity: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.fogHeight')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogHeight ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ fogHeight: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.fogVariation')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogVariation ?? 25)}
                  defaultValue={25}
                  onChange={(v) => applyPatch({ fogVariation: v })}
                />
                <CxSliderRow
                  label={t('adjustments.effects.glow')}
                  min={0}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogGlow ?? 25)}
                  defaultValue={25}
                  onChange={(v) => applyPatch({ fogGlow: v })}
                />
                <CxSliderRow
                  label={t('adjustments.color.temperature')}
                  min={-100}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogTemperature ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ fogTemperature: v })}
                />
                <CxSliderRow
                  label={t('adjustments.color.tint')}
                  min={-100}
                  max={100}
                  step={1}
                  value={Number(adjustments.fogTint ?? 0)}
                  defaultValue={0}
                  onChange={(v) => applyPatch({ fogTint: v })}
                />
              </>
            ) : null}
          </CxSubSection>
        </>
      )}

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

/* ---------------------------- 路由容器 ----------------------------
 * 布局统一（以预设/滤镜/AI 工具面板为标准）：七个分类一律挂同一个
 * .cx-panel 容器——定高滚动卡片（clamp 216-268px）、统一内边距与卡片
 * 背景/边框、横屏左栏 grid 布局。此前人像/调色/构图/特效四面板为裸
 * fragment 直入 flex column，无定高无滚动无卡片视觉，与标准面板比例
 * 完全脱节（预览被挤压、内容贴边、横屏 grid-area 丢失）。 */
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
