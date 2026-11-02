import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Loader2, Sparkles, Wand2, Waves, Eraser } from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Adjustments, getAiDenoiseEnablePatch } from '../../utils/adjustments';
import { Invokes } from '../ui/AppProperties';
import { useEditorActions } from '../../hooks/useEditorActions';
import { CxSliderRow, useCrystalAdjust } from './crystalShared';

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
  const [busy, setBusy] = useState<'enhance' | 'auto' | null>(null);

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
