import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { CloudSun, Loader2, Sparkles, User, Wand2, Waves, Eraser } from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Adjustments, getAiDenoiseEnablePatch } from '../../utils/adjustments';
import { Invokes } from '../ui/AppProperties';
import { Mask } from '../panel/right/Masks';
import { useEditorActions } from '../../hooks/useEditorActions';
import { CxSliderRow, useCrystalAdjust, useCrystalAiMasks } from './crystalShared';

/* ---------------------------------------------------------------------------
 * Crystal AI 工具面板：全部为真实管线能力。
 * - AI 一键增强：invoke AiAutoEnhance（三档强度，桌面 EditorToolbar 同源）。
 * - 自动色调：useEditorActions.handleAutoAdjustments（CalculateAutoAdjustments）。
 * - AI 降噪：getAiDenoiseEnablePatch + aiDenoiseAmount（Details 面板同源）。
 * - 细节滑杆：structure/texture/clarity/dehaze/lumaNoiseReduction。
 * ------------------------------------------------------------------------- */

type EnhanceIntensity = 'subtle' | 'standard' | 'strong';

const INTENSITIES: ReadonlyArray<{ id: EnhanceIntensity; labelKey: ParseKeys }> = [
  { id: 'subtle', labelKey: 'editor.aiEnhance.intensities.subtle' },
  { id: 'standard', labelKey: 'editor.aiEnhance.intensities.standard' },
  { id: 'strong', labelKey: 'editor.aiEnhance.intensities.strong' },
];

export default function CrystalAiToolsPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider);
  const { handleAutoAdjustments } = useEditorActions();
  const { applyPatch } = useCrystalAdjust();

  const [intensity, setIntensity] = useState<EnhanceIntensity>('standard');
  const [busy, setBusy] = useState<'enhance' | 'auto' | 'sky' | 'subject' | null>(null);
  const { handleGenerateAiSkyMask, handleGenerateAiForegroundMask, ensureContainer, findContainer, setMaskAdjustments, maskReady } =
    useCrystalAiMasks();

  const runEnhance = useCallback(async () => {
    if (busy) return;
    setBusy('enhance');
    try {
      const result = await invoke<Partial<Adjustments>>(Invokes.AiAutoEnhance, { intensity });
      const prev = useEditorStore.getState().adjustments;
      useEditorStore.getState().setEditor({ adjustments: { ...prev, ...result } });
    } catch (e) {
      console.error('AI enhance failed:', e);
      toast.error(t('crystal.aiRecommend.failed'));
    } finally {
      setBusy(null);
    }
  }, [busy, intensity, t]);

  const runAuto = useCallback(async () => {
    if (busy) return;
    setBusy('auto');
    try {
      await handleAutoAdjustments();
    } finally {
      setBusy(null);
    }
  }, [busy, handleAutoAdjustments]);

  const denoiseOn = Boolean(adjustments.aiDenoiseEnabled);

  /* 边界计划 P2：天空识别 —— 复用桌面 sky mask 链路；识别成功后以容器级
   * MaskAdjustments（clarity/dehaze/saturation）提供「天空强度」滑杆。 */
  const runSky = useCallback(async () => {
    if (busy) return;
    setBusy('sky');
    try {
      const container = ensureContainer(Mask.AiSky);
      await handleGenerateAiSkyMask(container.subMasks[0].id);
      if (maskReady(Mask.AiSky)) {
        setMaskAdjustments(container.id, { clarity: 10, dehaze: 8, saturation: 5 }); // v=50 默认
      } else {
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
    }
  }, [busy, ensureContainer, handleGenerateAiSkyMask, maskReady, setMaskAdjustments, t]);

  /* 边界计划 P2：主体识别 —— AiForeground 前景分割（桌面语义同为主体识别，
   * 且无需框选坐标，适合移动端一键交互）。 */
  const runSubject = useCallback(async () => {
    if (busy) return;
    setBusy('subject');
    try {
      const container = ensureContainer(Mask.AiForeground);
      await handleGenerateAiForegroundMask(container.subMasks[0].id);
      if (maskReady(Mask.AiForeground)) {
        setMaskAdjustments(container.id, { clarity: 10 }); // v=50 默认
      } else {
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
    }
  }, [busy, ensureContainer, handleGenerateAiForegroundMask, maskReady, setMaskAdjustments, t]);

  const skyContainer = findContainer(Mask.AiSky);
  const skyReady = maskReady(Mask.AiSky);
  const skyStrength = skyContainer ? Math.round(Number(skyContainer.adjustments.clarity ?? 0) / 0.2) : 0;

  const subjectContainer = findContainer(Mask.AiForeground);
  const subjectReady = maskReady(Mask.AiForeground);
  const subjectStrength = subjectContainer ? Math.round(Number(subjectContainer.adjustments.clarity ?? 0) / 0.2) : 0;

  const toggleDenoise = useCallback(() => {
    const patch = denoiseOn
      ? { aiDenoiseEnabled: false }
      : getAiDenoiseEnablePatch(aiProvider);
    applyPatch(patch as Partial<Adjustments>);
  }, [aiProvider, applyPatch, denoiseOn]);

  const tiles: Array<{ id: string; label: string; icon: typeof Sparkles; color: string; onClick: () => void; active?: boolean; busy?: boolean }> = [
    { id: 'enhance', label: t('crystal.ai.tiles.enhance'), icon: Sparkles, color: 'var(--cx-cat-ai)', onClick: runEnhance, busy: busy === 'enhance' },
    { id: 'auto', label: t('crystal.ai.tiles.auto'), icon: Wand2, color: 'var(--cx-cat-presets)', onClick: runAuto, busy: busy === 'auto' },
    { id: 'denoise', label: t('crystal.ai.tiles.denoise'), icon: Eraser, color: 'var(--cx-cat-tone)', onClick: toggleDenoise, active: denoiseOn },
    { id: 'lumaNr', label: t('crystal.ai.tiles.detail'), icon: Waves, color: 'var(--cx-cat-filter)', onClick: () => applyPatch({ structure: Math.max(Number(adjustments.structure ?? 0), 10), clarity: Math.max(Number(adjustments.clarity ?? 0), 10) }) },
    { id: 'sky', label: t('crystal.ai.tiles.sky'), icon: CloudSun, color: 'var(--cx-cat-tone)', onClick: runSky, active: skyReady, busy: busy === 'sky' },
    { id: 'subject', label: t('crystal.ai.tiles.subject'), icon: User, color: 'var(--cx-cat-ren)', onClick: runSubject, active: subjectReady, busy: busy === 'subject' },
  ];

  return (
    <>
      <div className="cx-panel-title">
        <Sparkles size={13} className="inline mr-1.5 -mt-0.5" />
        {t('crystal.categories.ai')}
      </div>

      <div className="cx-chip-row mb-3">
        {INTENSITIES.map(({ id, labelKey }) => (
          <button key={id} className={`cx-chip ${intensity === id ? 'is-active' : ''}`} onClick={() => setIntensity(id)}>
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="cx-grid-tiles mb-2">
        {tiles.map(({ id, label, icon: Icon, color, onClick, active, busy: isBusy }) => (
          <button key={id} className={`cx-tile ${active ? 'is-active' : ''} ${isBusy ? 'is-busy' : ''}`} onClick={onClick} disabled={Boolean(busy)}>
            {isBusy ? <Loader2 size={20} className="animate-spin" style={{ color: 'var(--cx-accent)' }} /> : <span className="cx-tile-color flex items-center justify-center" style={{ ['--cx-tile-color' as string]: color }}><Icon size={13} /></span>}
            {label}
          </button>
        ))}
      </div>

      {skyReady && (
        <CxSliderRow
          label={t('crystal.ai.skyStrength')}
          min={0}
          max={100}
          step={1}
          value={Math.max(0, Math.min(100, skyStrength))}
          onChange={(v) => skyContainer && setMaskAdjustments(skyContainer.id, { clarity: Math.round(v * 0.2), dehaze: Math.round(v * 0.15), saturation: Math.round(v * 0.1) })}
        />
      )}
      {subjectReady && (
        <CxSliderRow
          label={t('crystal.ai.subjectStrength')}
          min={0}
          max={100}
          step={1}
          value={Math.max(0, Math.min(100, subjectStrength))}
          onChange={(v) => subjectContainer && setMaskAdjustments(subjectContainer.id, { clarity: Math.round(v * 0.2) })}
        />
      )}

      {denoiseOn && (
        <CxSliderRow
          label={t('crystal.ai.denoiseAmount')}
          min={0}
          max={100}
          step={1}
          value={Number(adjustments.aiDenoiseAmount ?? 0)}
          onChange={(v) => applyPatch({ aiDenoiseAmount: v })}
        />
      )}
      <CxSliderRow
        label={t('crystal.ai.lumaNr')}
        min={0}
        max={100}
        step={1}
        value={Number(adjustments.lumaNoiseReduction ?? 0)}
        onChange={(v) => applyPatch({ lumaNoiseReduction: v })}
      />
      <CxSliderRow
        label={t('crystal.ai.structure')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.structure ?? 0)}
        onChange={(v) => applyPatch({ structure: v })}
      />
      <CxSliderRow
        label={t('crystal.ai.texture')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.textureAmount ?? 0)}
        onChange={(v) => applyPatch({ textureAmount: v })}
      />
      <CxSliderRow
        label={t('crystal.ai.clarity')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.clarity ?? 0)}
        onChange={(v) => applyPatch({ clarity: v })}
      />
      <CxSliderRow
        label={t('crystal.ai.dehaze')}
        min={-100}
        max={100}
        step={1}
        value={Number(adjustments.dehaze ?? 0)}
        onChange={(v) => applyPatch({ dehaze: v })}
      />
    </>
  );
}
