import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import {
  BringToFront,
  CloudSun,
  Loader2,
  Sparkles,
  TextSearch,
  User,
  Wand2,
  Waves,
  Eraser,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { selectAiModelDownloadStatus, useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Adjustments, getAiDenoiseEnablePatch } from '../../utils/adjustments';
import { Invokes } from '../ui/AppProperties';
import { Mask } from '../panel/right/Masks';
import { useEditorActions } from '../../hooks/useEditorActions';
import { useAiMasking } from '../../hooks/useAiMasking';
import { CxSliderRow, useCrystalAdjust, useCrystalAiMasks } from './crystalShared';

/* ---------------------------------------------------------------------------
 * Crystal AI 工具面板：全部为真实管线能力。
 * - AI 一键增强：invoke AiAutoEnhance（三档强度，桌面 EditorToolbar 同源）。
 * - 自动色调：useEditorActions.handleAutoAdjustments（CalculateAutoAdjustments）。
 * - AI 降噪：getAiDenoiseEnablePatch + aiDenoiseAmount（Details 面板同源）。
 * - 细节滑杆：structure/texture/clarity/dehaze/lumaNoiseReduction。
 * - 天空/主体识别：AiSky/AiForeground 一键生成 + 容器级强度 + 移除。
 * - 文本识别蒙版：AiText 提示词 → GenerateAiTextMask（桌面 MasksPanel 同源）。
 * - 景深蒙版：AiDepth 生成 + 近/远/羽化渲染期参数（DepthRangePicker 同构）。
 * - 生成中：busy 蒙层显示模型下载进度并提供 CancelAiTask 取消出口。
 * ------------------------------------------------------------------------- */

type EnhanceIntensity = 'subtle' | 'standard' | 'strong';
type AiBusyKind = 'enhance' | 'auto' | 'sky' | 'subject' | 'text' | 'depth';

const INTENSITIES: ReadonlyArray<{ id: EnhanceIntensity; labelKey: ParseKeys }> = [
  { id: 'subtle', labelKey: 'editor.aiEnhance.intensities.subtle' },
  { id: 'standard', labelKey: 'editor.aiEnhance.intensities.standard' },
  { id: 'strong', labelKey: 'editor.aiEnhance.intensities.strong' },
];

/** 深度蒙版默认参数（与桌面 MasksPanel.createMaskLogic 同源） */
const DEPTH_DEFAULTS = { minDepth: 20, maxDepth: 80, minFade: 15, maxFade: 15, feather: 10 } as const;

export default function CrystalAiToolsPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider);
  const aiDownloadStatus = useProcessStore(selectAiModelDownloadStatus);
  const { handleAutoAdjustments } = useEditorActions();
  const { applyPatch, setAdjustments } = useCrystalAdjust();
  const { handleGenerateAiTextMask, handleGenerateAiDepthMask, handleCancelAiTask } = useAiMasking();
  const {
    handleGenerateAiSkyMask,
    handleGenerateAiForegroundMask,
    ensureContainer,
    findContainer,
    setMaskAdjustments,
    updateSubMaskParameters,
    maskReady,
    removeContainer,
  } = useCrystalAiMasks();

  const [intensity, setIntensity] = useState<EnhanceIntensity>('standard');
  const [busy, setBusy] = useState<AiBusyKind | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  /** 用户主动取消后抑制「识别失败」toast（取消不是失败） */
  const cancelRef = useRef(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [showTextInput, setShowTextInput] = useState(false);

  const runEnhance = useCallback(async () => {
    if (busy) return;
    setBusy('enhance');
    try {
      const result = await invoke<Partial<Adjustments>>(Invokes.AiAutoEnhance, { intensity });
      // 与桌面 EditorToolbar 同源：经 setAdjustments → debounced pushHistory，
      // 保证 AI 增强结果进 50 步撤销栈（setEditor 直接写会绕过历史）。
      setAdjustments((prev) => ({ ...prev, ...result }));
    } catch (e) {
      console.error('AI enhance failed:', e);
      toast.error(t('crystal.aiRecommend.failed'));
    } finally {
      setBusy(null);
    }
  }, [busy, intensity, setAdjustments, t]);

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

  /* 天空识别 —— 复用桌面 sky mask 链路；识别成功后以容器级
   * MaskAdjustments（clarity/dehaze/saturation）提供「天空强度」滑杆。 */
  const runSky = useCallback(async () => {
    if (busy) return;
    setBusy('sky');
    cancelRef.current = false;
    try {
      const container = ensureContainer(Mask.AiSky);
      const subMaskId = container.subMasks[0].id;
      setBusyTaskId(subMaskId);
      await handleGenerateAiSkyMask(subMaskId);
      if (cancelRef.current) return;
      if (maskReady(Mask.AiSky)) {
        // 仅首次识别后写入默认强度；重复执行不覆盖用户已调值。
        if (!Number(container.adjustments.clarity ?? 0))
          setMaskAdjustments(container.id, { clarity: 10, dehaze: 8, saturation: 5 });
      } else {
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [busy, ensureContainer, handleGenerateAiSkyMask, maskReady, setMaskAdjustments, t]);

  /* 主体识别 —— AiForeground 前景分割（桌面语义同为主体识别，
   * 且无需框选坐标，适合移动端一键交互）。 */
  const runSubject = useCallback(async () => {
    if (busy) return;
    setBusy('subject');
    cancelRef.current = false;
    try {
      const container = ensureContainer(Mask.AiForeground);
      const subMaskId = container.subMasks[0].id;
      setBusyTaskId(subMaskId);
      await handleGenerateAiForegroundMask(subMaskId);
      if (cancelRef.current) return;
      if (maskReady(Mask.AiForeground)) {
        // 仅首次识别后写入默认强度；重复执行不覆盖用户已调值。
        if (!Number(container.adjustments.clarity ?? 0)) setMaskAdjustments(container.id, { clarity: 10 });
      } else {
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [busy, ensureContainer, handleGenerateAiForegroundMask, maskReady, setMaskAdjustments, t]);

  const skyContainer = findContainer(Mask.AiSky);
  const skyReady = maskReady(Mask.AiSky);
  const skyStrength = skyContainer ? Math.round(Number(skyContainer.adjustments.clarity ?? 0) / 0.2) : 0;

  const subjectContainer = findContainer(Mask.AiForeground);
  const subjectReady = maskReady(Mask.AiForeground);
  const subjectStrength = subjectContainer ? Math.round(Number(subjectContainer.adjustments.clarity ?? 0) / 0.2) : 0;

  /* 文本识别蒙版：提示词 → GenerateAiTextMask（桌面 MasksPanel 同源：
   * prompt 写入 subMask.parameters 后生成，容器级强度滑杆调局部效果）。 */
  const textContainer = findContainer(Mask.AiText);
  const textReady = maskReady(Mask.AiText);
  const textStrength = textContainer ? Math.round(Number(textContainer.adjustments.clarity ?? 0) / 0.2) : 0;

  // 容器已存在（重进面板/切换分类回来）时回填提示词，与桌面 textPrompt 状态同构。
  useEffect(() => {
    setTextPrompt(textContainer?.subMasks[0]?.parameters?.prompt || '');
    // 仅在容器身份变化时同步，避免生成过程中覆盖用户输入。
  }, [textContainer?.id]);

  const runText = useCallback(async () => {
    if (busy) return;
    const prompt = textPrompt.trim();
    if (!prompt) {
      setShowTextInput(true);
      return;
    }
    setBusy('text');
    cancelRef.current = false;
    try {
      const container = ensureContainer(Mask.AiText);
      const subMaskId = container.subMasks[0].id;
      // 桌面语义：生成前把 prompt 写入 subMask.parameters（getSubMaskName 亦用它命名）。
      updateSubMaskParameters(container.id, subMaskId, { prompt });
      setBusyTaskId(subMaskId);
      await handleGenerateAiTextMask(subMaskId, prompt);
      if (cancelRef.current) return;
      if (maskReady(Mask.AiText)) {
        // 仅首次识别后写入默认强度；重复执行不覆盖用户已调值。
        if (!Number(container.adjustments.clarity ?? 0)) setMaskAdjustments(container.id, { clarity: 10 });
        setShowTextInput(false);
      } else {
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [
    busy,
    textPrompt,
    ensureContainer,
    updateSubMaskParameters,
    handleGenerateAiTextMask,
    maskReady,
    setMaskAdjustments,
    t,
  ]);

  /* 景深蒙版：AiDepth 生成深度图；近/远/羽化为渲染期参数
   * （后端 generate_ai_depth_bitmap 按 minDepth/maxDepth/feather 实时重算），
   * 拖动滑杆即时生效，无需重新推理。 */
  const depthContainer = findContainer(Mask.AiDepth);
  const depthReady = maskReady(Mask.AiDepth);
  const depthParams = depthContainer?.subMasks[0]?.parameters;
  const depthMinDepth = Number(depthParams?.minDepth ?? DEPTH_DEFAULTS.minDepth);
  const depthMaxDepth = Number(depthParams?.maxDepth ?? DEPTH_DEFAULTS.maxDepth);
  const depthFeather = Number(depthParams?.feather ?? DEPTH_DEFAULTS.feather);

  const runDepth = useCallback(async () => {
    if (busy) return;
    setBusy('depth');
    cancelRef.current = false;
    try {
      const container = ensureContainer(Mask.AiDepth, { ...DEPTH_DEFAULTS });
      const subMaskId = container.subMasks[0].id;
      const p = container.subMasks[0].parameters || {};
      setBusyTaskId(subMaskId);
      await handleGenerateAiDepthMask(subMaskId, {
        minDepth: p.minDepth ?? DEPTH_DEFAULTS.minDepth,
        maxDepth: p.maxDepth ?? DEPTH_DEFAULTS.maxDepth,
        minFade: p.minFade ?? DEPTH_DEFAULTS.minFade,
        maxFade: p.maxFade ?? DEPTH_DEFAULTS.maxFade,
        feather: p.feather ?? DEPTH_DEFAULTS.feather,
      });
      if (cancelRef.current) return;
      if (!maskReady(Mask.AiDepth)) toast.error(t('crystal.ai.maskFailed'));
    } catch {
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [busy, ensureContainer, handleGenerateAiDepthMask, maskReady, t]);

  /** 生成中取消：与桌面 MasksPanel.handleCancelAiTask 同源（CancelAiTask + 任务注销）。 */
  const handleCancelBusy = useCallback(() => {
    cancelRef.current = true;
    if (busyTaskId) void handleCancelAiTask(busyTaskId);
  }, [busyTaskId, handleCancelAiTask]);

  const toggleDenoise = useCallback(() => {
    const patch = denoiseOn ? { aiDenoiseEnabled: false } : getAiDenoiseEnablePatch(aiProvider);
    applyPatch(patch as Partial<Adjustments>);
  }, [aiProvider, applyPatch, denoiseOn]);

  const tiles: Array<{
    id: string;
    label: string;
    icon: typeof Sparkles;
    color: string;
    onClick: () => void;
    active?: boolean;
    busy?: boolean;
  }> = [
    {
      id: 'enhance',
      label: t('crystal.ai.tiles.enhance'),
      icon: Sparkles,
      color: 'var(--cx-cat-ai)',
      onClick: runEnhance,
      busy: busy === 'enhance',
    },
    {
      id: 'auto',
      label: t('crystal.ai.tiles.auto'),
      icon: Wand2,
      color: 'var(--cx-cat-presets)',
      onClick: runAuto,
      busy: busy === 'auto',
    },
    {
      id: 'denoise',
      label: t('crystal.ai.tiles.denoise'),
      icon: Eraser,
      color: 'var(--cx-cat-tone)',
      onClick: toggleDenoise,
      active: denoiseOn,
    },
    {
      id: 'lumaNr',
      label: t('crystal.ai.tiles.detail'),
      icon: Waves,
      color: 'var(--cx-cat-filter)',
      onClick: () =>
        applyPatch({
          structure: Math.max(Number(adjustments.structure ?? 0), 10),
          clarity: Math.max(Number(adjustments.clarity ?? 0), 10),
        }),
    },
    {
      id: 'sky',
      label: t('crystal.ai.tiles.sky'),
      icon: CloudSun,
      color: 'var(--cx-cat-tone)',
      onClick: runSky,
      active: skyReady,
      busy: busy === 'sky',
    },
    {
      id: 'subject',
      label: t('crystal.ai.tiles.subject'),
      icon: User,
      color: 'var(--cx-cat-ren)',
      onClick: runSubject,
      active: subjectReady,
      busy: busy === 'subject',
    },
    {
      id: 'text',
      label: t('masks.types.text'),
      icon: TextSearch,
      color: 'var(--cx-cat-presets)',
      onClick: () => (textPrompt.trim() ? void runText() : setShowTextInput(true)),
      active: textReady,
      busy: busy === 'text',
    },
    {
      id: 'depth',
      label: t('masks.types.depth'),
      icon: BringToFront,
      color: 'var(--cx-cat-filter)',
      onClick: runDepth,
      active: depthReady,
      busy: busy === 'depth',
    },
  ];

  return (
    <>
      <div className="cx-panel-title">
        <Sparkles size={13} className="inline mr-1.5 -mt-0.5" />
        {t('crystal.categories.ai')}
      </div>

      {/* G9：识别过程进度蒙层 —— busy 期间覆盖面板内容，失败 toast 后自动消失，不阻塞编辑 */}
      <div className="relative">
        <div className={busy ? 'cx-busy-dim' : ''}>
          <div className="cx-chip-row mb-3">
            {INTENSITIES.map(({ id, labelKey }) => (
              <button
                key={id}
                className={`cx-chip ${intensity === id ? 'is-active' : ''}`}
                onClick={() => setIntensity(id)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>

          <div className="cx-grid-tiles mb-2">
            {tiles.map(({ id, label, icon: Icon, color, onClick, active, busy: isBusy }) => (
              <button
                key={id}
                className={`cx-tile ${active ? 'is-active' : ''} ${isBusy ? 'is-busy' : ''}`}
                onClick={onClick}
                disabled={Boolean(busy)}
              >
                {isBusy ? (
                  <Loader2 size={20} className="animate-spin" style={{ color: 'var(--cx-accent)' }} />
                ) : (
                  <span
                    className="cx-tile-color flex items-center justify-center"
                    style={{ ['--cx-tile-color' as string]: color }}
                  >
                    <Icon size={13} />
                  </span>
                )}
                {label}
              </button>
            ))}
          </div>

          {/* 文本识别：提示词输入 + 生成（桌面 MasksPanel isTextMask 区块同构） */}
          {(showTextInput || (textContainer && !textReady)) && (
            <div className="flex items-center gap-2 mb-2">
              <input
                className="cx-input grow"
                type="text"
                value={textPrompt}
                placeholder={t('editor.masks.settings.textPromptPlaceholder')}
                disabled={Boolean(busy)}
                onChange={(e) => setTextPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void runText();
                }}
              />
              <button
                className="cx-chip is-active shrink-0"
                disabled={Boolean(busy) || !textPrompt.trim()}
                onClick={() => void runText()}
              >
                {t('editor.masks.settings.generateTextMask')}
              </button>
            </div>
          )}

          {skyReady && (
            <>
              <CxSliderRow
                label={t('crystal.ai.skyStrength')}
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, skyStrength))}
                onChange={(v) =>
                  skyContainer &&
                  setMaskAdjustments(skyContainer.id, {
                    clarity: Math.round(v * 0.2),
                    dehaze: Math.round(v * 0.15),
                    saturation: Math.round(v * 0.1),
                  })
                }
              />
              <button className="cx-mask-remove" onClick={() => removeContainer(Mask.AiSky)}>
                <X size={11} />
                {t('crystal.ai.removeMask')}
              </button>
            </>
          )}
          {subjectReady && (
            <>
              <CxSliderRow
                label={t('crystal.ai.subjectStrength')}
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, subjectStrength))}
                onChange={(v) =>
                  subjectContainer && setMaskAdjustments(subjectContainer.id, { clarity: Math.round(v * 0.2) })
                }
              />
              <button className="cx-mask-remove" onClick={() => removeContainer(Mask.AiForeground)}>
                <X size={11} />
                {t('crystal.ai.removeMask')}
              </button>
            </>
          )}
          {textReady && (
            <>
              <CxSliderRow
                label={t('crystal.ai.textStrength')}
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, textStrength))}
                onChange={(v) =>
                  textContainer && setMaskAdjustments(textContainer.id, { clarity: Math.round(v * 0.2) })
                }
              />
              <button className="cx-mask-remove" onClick={() => removeContainer(Mask.AiText)}>
                <X size={11} />
                {t('crystal.ai.removeMask')}
              </button>
            </>
          )}
          {depthReady && (
            <>
              {/* 与桌面 DepthRangePicker 同构：近端显示值 = 100 - maxDepth，
                  远端显示值 = 100 - minDepth，双向钳制保证带通区间有效。 */}
              <CxSliderRow
                label={t('editor.masks.depthRange.near')}
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, 100 - depthMaxDepth))}
                onChange={(v) =>
                  depthContainer &&
                  updateSubMaskParameters(depthContainer.id, depthContainer.subMasks[0].id, {
                    maxDepth: Math.max(100 - v, depthMinDepth),
                  })
                }
              />
              <CxSliderRow
                label={t('editor.masks.depthRange.far')}
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, 100 - depthMinDepth))}
                onChange={(v) =>
                  depthContainer &&
                  updateSubMaskParameters(depthContainer.id, depthContainer.subMasks[0].id, {
                    minDepth: Math.min(100 - v, depthMaxDepth),
                  })
                }
              />
              <CxSliderRow
                label={t('editor.masks.params.globalFeather')}
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, depthFeather))}
                onChange={(v) =>
                  depthContainer &&
                  updateSubMaskParameters(depthContainer.id, depthContainer.subMasks[0].id, { feather: v })
                }
              />
              <button className="cx-mask-remove" onClick={() => removeContainer(Mask.AiDepth)}>
                <X size={11} />
                {t('crystal.ai.removeMask')}
              </button>
            </>
          )}

          {denoiseOn && (
            <>
              <CxSliderRow
                label={t('crystal.ai.denoiseAmount')}
                min={0}
                max={100}
                step={1}
                value={Number(adjustments.aiDenoiseAmount ?? 0)}
                onChange={(v) => applyPatch({ aiDenoiseAmount: v })}
              />
              <CxSliderRow
                label={t('crystal.ai.denoiseDetail')}
                min={0}
                max={100}
                step={1}
                value={Number(adjustments.aiDenoiseDetail ?? 0)}
                onChange={(v) => applyPatch({ aiDenoiseDetail: v })}
              />
            </>
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
        </div>
        {busy && (
          <div className="cx-busy-overlay" role="status" style={{ flexDirection: 'column', gap: 10 }}>
            <Loader2 size={22} className="animate-spin" style={{ color: 'var(--cx-accent)' }} />
            {aiDownloadStatus && (
              <span className="text-[11px] px-3 text-center" style={{ color: 'var(--cx-muted)' }}>
                {t('crystal.ai.modelDownloading')} · {aiDownloadStatus}
              </span>
            )}
            {busyTaskId && (
              <button className="cx-chip" onClick={handleCancelBusy}>
                <X size={11} className="inline mr-1" />
                {t('editor.ai.settings.cancelGeneration')}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
