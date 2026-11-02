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
  Smile,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  Adjustments,
  DEFAULT_PARAMETRIC_CURVE_SETTINGS,
  ParametricCurve,
  INITIAL_MASK_CONTAINER,
  getActiveTools,
  setToolActive,
} from '../../utils/adjustments';
import { calculateCenteredCrop, calculateAutoCropForRotation } from '../../utils/cropUtils';
import { buildParametricPoints } from '../../utils/parametricCurve';
import { createSubMask } from '../../utils/maskUtils';
import { getTransformAdjustments } from '../../hooks/useAiMasking';
import { useEditorActions } from '../../hooks/useEditorActions';
import { Invokes } from '../ui/AppProperties';
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
    findContainer,
    ensureContainer,
    findContainerByKind,
    removeContainerByKind,
    updateSubMaskParameters,
    setMaskAdjustments,
  } = useCrystalAiMasks();

  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [unifyBusy, setUnifyBusy] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const liquifyTimerRef = useRef<number | null>(null);
  const liquifyGenRef = useRef(0);

  useEffect(
    () => () => {
      if (liquifyTimerRef.current) window.clearTimeout(liquifyTimerRef.current);
    },
    [],
  );

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
        await handleGenerateAiFaceMask(subMask.id, op.parts);
        const latest = useEditorStore.getState().adjustments;
        const created = (latest.masks || []).find((c) => c.id === containerId);
        if (!created?.subMasks[0]?.parameters?.maskDataBase64) {
          toast.error(t('crystal.ai.maskFailed'));
        }
      } catch {
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

  /* 美型（瘦脸/下颌线）：值存宿主 AiFace 容器 submask.parameters.liquify（与桌面一致），
   * 防抖 600ms 调 GenerateFaceLiquifyPatch → aiPatches upsert；双 0 自动移除补丁。 */
  const runFaceLiquify = useCallback(async () => {
    const main = useEditorStore.getState();
    const host = (main.adjustments.masks || []).find((c) => c.subMasks.some((sm) => sm.type === Mask.AiFace));
    if (!host || !main.selectedImage) return;
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
      const patchData = JSON.parse(patchJson);
      // 同 id 补丁内容已变化：清掉已发送标记，让下一次渲染载荷把新 patchData 发给后端
      useEditorStore.getState().patchesSentToBackend.delete(patchId);
      setAdjustments((prev) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p) =>
          p.id === patchId ? { ...p, patchData, isLoading: false } : p,
        ),
      }));
    } catch (e) {
      console.error('Face liquify failed:', e);
      setAdjustments((prev) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p) => (p.id === patchId ? { ...p, isLoading: false } : p)),
      }));
      toast.error(t('crystal.portrait.liquifyFailed'));
    }
  }, [setAdjustments, t]);

  const setLiquify = useCallback(
    (key: 'slimFace' | 'jawline', v: number) => {
      let host = findContainer(Mask.AiFace);
      if (!host) host = ensureContainer(Mask.AiFace, { parts: ['faceSkin'] });
      const liq = (host.subMasks[0]?.parameters?.liquify ?? {}) as { slimFace?: number; jawline?: number };
      updateSubMaskParameters(host.id, host.subMasks[0].id, { liquify: { ...liq, [key]: v } });
      if (liquifyTimerRef.current) window.clearTimeout(liquifyTimerRef.current);
      liquifyTimerRef.current = window.setTimeout(() => void runFaceLiquify(), 600);
    },
    [ensureContainer, findContainer, runFaceLiquify, updateSubMaskParameters],
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

  const liquifyHost = findContainer(Mask.AiFace);
  const liquifyValues = (liquifyHost?.subMasks[0]?.parameters?.liquify ?? {}) as {
    slimFace?: number;
    jawline?: number;
  };

  return (
    <PanelShell titleKey="crystal.categories.portrait">
      <button className="cx-ai-apply mb-3 w-full" onClick={oneTapPortrait} style={{ width: '100%' }}>
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
              onClick={() => void runOperator(op)}
              disabled={Boolean(opBusy) && !busy}
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
          onClick={runBgBlur}
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
              <button className="cx-mask-remove" onClick={() => void handleUnifySkin()} disabled={unifyBusy}>
                {unifyBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {t('crystal.portrait.unifySkin')}
              </button>
            )}
            <button className="cx-mask-remove" onClick={() => removeOperator(op)}>
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
