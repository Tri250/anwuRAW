import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { BringToFront, CloudSun, Loader2, Sparkles, TextSearch, User, Wand2, Waves, Eraser, X, Palette } from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { selectAiModelDownloadStatus, useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useCloudStore } from '../../store/useCloudStore';
import { Adjustments, getAiDenoiseEnablePatch } from '../../utils/adjustments';
import { Invokes } from '../ui/AppProperties';
import { Mask } from '../panel/right/Masks';
import { useEditorActions } from '../../hooks/useEditorActions';
import { useAiMasking } from '../../hooks/useAiMasking';
import { CxSliderRow, awaitImageReady, haptic, useCrystalAdjust, useCrystalAiMasks } from './crystalShared';

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
 * - 风格词调色（原「一句话调色」）：ai_style_suggest 携带当前图路径（imagePath）；
 *   结果卡展示强度 / 混合风格名 / 被忽略的否定描述。
 * - 云参考图（实验性）：入口不可达时置灰展示而非静默隐藏（D-AI-02），操作区
 *   常驻联网隐私说明条（D-AI-03）。
 * - 9 格 tile 右上角来源圆点（青=本地模型 / 金=本地规则 / 紫=云端），首次点击
 *   某格时面板底部滑入来源说明条（D-AI-06）。
 * ------------------------------------------------------------------------- */

type EnhanceIntensity = 'subtle' | 'standard' | 'strong';
type AiBusyKind = 'enhance' | 'auto' | 'sky' | 'subject' | 'text' | 'depth' | 'styleRef';

const INTENSITIES: ReadonlyArray<{ id: EnhanceIntensity; labelKey: ParseKeys }> = [
  { id: 'subtle', labelKey: 'editor.aiEnhance.intensities.subtle' },
  { id: 'standard', labelKey: 'editor.aiEnhance.intensities.standard' },
  { id: 'strong', labelKey: 'editor.aiEnhance.intensities.strong' },
];

/** 风格词调色（原「一句话调色」）返回结构（与后端 style_suggest::StyleSuggestion::to_json
 * 对齐；negatedTerms/intensity/blended 为后端新增可选字段，旧后端缺省不传） */
interface StyleSuggestResult {
  styleId: string | null;
  /** 命中风格名；混合风格时后端已拼接好完整名称（如「清透日系 × 暗调情绪」） */
  styleName: string | null;
  confidence: number;
  scores: Array<{ id: string; score: number }>;
  matchedTerms: string[];
  adjustments: Partial<Adjustments> | null;
  /** 用户提示词中被忽略的否定描述（非空时结果卡提示） */
  negatedTerms?: string[] | null;
  /** 后端最终采用的建议强度（0..100，结果卡显示「强度 n%」） */
  intensity?: number | null;
  /** 混合风格名（存在即本次为混合结果；展示以 styleName 为准，其已拼接混合名） */
  blended?: string | null;
}

/** Tile 能力来源（D-AI-06）：model=本地 AI 模型（需下载模型、不联网上传）、
 * rule=本地参数规则（无需下载、不联网）、cloud=云端调用（联网）。 */
type AiSourceKind = 'model' | 'rule' | 'cloud';

/** 来源角标：6px 圆点颜色 + 文字说明 key。颜色之外必须提供 title/aria 文字
 * （不能单靠颜色区分）；badge/note key 为新增 i18n key，经 tKey 宽松调用。 */
const AI_SOURCE_BADGES: Record<AiSourceKind, { color: string; badgeKey: string; noteKey: string }> = {
  model: { color: '#22d3ee', badgeKey: 'crystal.ai.sourceBadge.model', noteKey: 'crystal.ai.sourceNote.model' },
  rule: { color: '#f0b429', badgeKey: 'crystal.ai.sourceBadge.rule', noteKey: 'crystal.ai.sourceNote.rule' },
  cloud: { color: '#a78bfa', badgeKey: 'crystal.ai.sourceBadge.cloud', noteKey: 'crystal.ai.sourceNote.cloud' },
};

/** 深度蒙版默认参数（与桌面 MasksPanel.createMaskLogic 同源） */
const DEPTH_DEFAULTS = { minDepth: 20, maxDepth: 80, minFade: 15, maxFade: 15, feather: 10 } as const;

/* 审计修复（AI-提示词）：移动端切分类即卸载面板，未生成的提示词随之丢失。
 * localStorage 持久化（容器内已有 prompt 时以容器为准），跨分类/重启均保留。 */
const TEXT_PROMPT_STORAGE_KEY = 'crystal.ai.textPrompt';
const loadStoredTextPrompt = (): string => {
  try {
    return localStorage.getItem(TEXT_PROMPT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};
const storeTextPrompt = (value: string) => {
  try {
    localStorage.setItem(TEXT_PROMPT_STORAGE_KEY, value);
  } catch {
    /* storage 不可用：仅保留内存态 */
  }
};

export default function CrystalAiToolsPanel() {
  const { t } = useTranslation();
  /* 本文件新增 i18n key 尚未合入 locale JSON（key 清单见缺陷报告）：仓库 t 为
   * en.json 严格 key 类型，与 useAppContextMenus 等处动态 key `as ParseKeys`
   * 惯例同理，这里对未落库 key 走宽松签名调用，key 落库后可收敛回严格 t。 */
  const tKey = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const adjustments = useEditorStore((s) => s.adjustments);
  const aiProvider = useSettingsStore((s) => s.appSettings?.aiProvider);
  const cloudUser = useCloudStore((s) => s.user);
  const getCloudToken = useCloudStore((s) => s.getToken);
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
  /** AI 增强明暗/色彩双强度（0..1，对应后端 tone_strength/color_strength） */
  const [toneStrength, setToneStrength] = useState(1);
  const [colorStrength, setColorStrength] = useState(1);
  const [busy, setBusy] = useState<AiBusyKind | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  /** 用户主动取消后抑制「识别失败」toast（取消不是失败） */
  const cancelRef = useRef(false);
  /* 程序化天空降级提示只弹一次（会话级），避免每次重复识别都打扰 */
  const proceduralNotified = useRef(false);
  const [textPrompt, setTextPrompt] = useState(loadStoredTextPrompt);
  const [showTextInput, setShowTextInput] = useState(false);
  /* 风格词调色：提示词仅驻内存（风格结果即时生效，无跨会话保留必要） */
  const [stylePrompt, setStylePrompt] = useState('');
  const [showStyleInput, setShowStyleInput] = useState(false);
  /* 最近一次风格词调色结果（结果卡数据：风格名/强度/被忽略否定词） */
  const [styleResult, setStyleResult] = useState<StyleSuggestResult | null>(null);
  /* 方案 B 云参考图入口：cloud 提供商 + 已登录 Pro 才可用（Android 无 Clerk
   * 登录态，cloudUser 恒为 null）。D-AI-02：不可达时不再静默隐藏入口——按钮
   * 置灰禁用并配「桌面版能力 · 需 Pro 登录」角标，保留能力可发现性。 */
  const canCloudStyle = aiProvider === 'cloud' && Boolean(cloudUser);
  /* D-AI-06：来源说明条状态 —— 每格仅首次点击触发；入场 150ms fade+slide，
   * 3 秒后自动收起（先淡出再卸载节点）。 */
  const [sourceNoteKind, setSourceNoteKind] = useState<AiSourceKind | null>(null);
  const [noteShown, setNoteShown] = useState(false);
  const noteSeenTilesRef = useRef<Set<string>>(new Set());
  const noteHideTimerRef = useRef<number | null>(null);
  const noteRemoveTimerRef = useRef<number | null>(null);
  const updateTextPrompt = useCallback((value: string) => {
    setTextPrompt(value);
    storeTextPrompt(value);
  }, []);

  /* D-AI-06：首次点击某格 → 面板底部滑入对应来源说明（model/rule/cloud 三选一，
   * 说明是否需下载模型 / 是否联网）。双 rAF 让隐藏初始态先完成一次布局再切到
   * 可见态以触发 150ms 过渡；3 秒后淡出，过渡结束即卸载节点。 */
  const showSourceNote = useCallback((tileId: string, source: AiSourceKind) => {
    if (noteSeenTilesRef.current.has(tileId)) return;
    noteSeenTilesRef.current.add(tileId);
    if (noteHideTimerRef.current !== null) clearTimeout(noteHideTimerRef.current);
    if (noteRemoveTimerRef.current !== null) clearTimeout(noteRemoveTimerRef.current);
    setSourceNoteKind(source);
    setNoteShown(false);
    requestAnimationFrame(() => requestAnimationFrame(() => setNoteShown(true)));
    noteHideTimerRef.current = window.setTimeout(() => {
      setNoteShown(false);
      noteRemoveTimerRef.current = window.setTimeout(() => setSourceNoteKind(null), 180);
    }, 3000);
  }, []);

  useEffect(
    () => () => {
      if (noteHideTimerRef.current !== null) clearTimeout(noteHideTimerRef.current);
      if (noteRemoveTimerRef.current !== null) clearTimeout(noteRemoveTimerRef.current);
    },
    [],
  );

  const runEnhance = useCallback(async () => {
    if (busy) return;
    setBusy('enhance');
    /* 闭环修复：
     * 1) 跨图守卫：AI 增强对发起时图片计算，完成后已切图则丢弃结果，
     *    避免旧图增强参数合并进新图 adjustments（与天空/主体/文本/景深同守卫）；
     * 2) isReady 等待：后端 ai_auto_enhance 依赖 state.original_image，
     *    图片未加载完即点击会抛 "No image loaded for AI enhance"——先等待就绪；
     * 3) activeTools 合并：后端返回 {basic/colorPresence/presence/vignette: true}，
     *    直接覆盖会把用户手动关掉的工具重新打开；按桌面 handleAutoAdjustments
     *    的 mergeActiveTools 语义只置 true 不关 false。 */
    const startPath = useEditorStore.getState().selectedImage?.path;
    if (!startPath) {
      setBusy(null);
      return;
    }
    try {
      if (!useEditorStore.getState().selectedImage?.isReady && !(await awaitImageReady(startPath))) {
        // 图片未就绪（仍在解码或加载失败）：静默 return 会被感知为死键
        toast.info(t('crystal.aiRecommend.notReady'));
        return;
      }
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      const result = await invoke<Partial<Adjustments>>(Invokes.AiAutoEnhance, {
        intensity,
        toneStrength,
        colorStrength,
      });
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      // 与桌面 EditorToolbar 同源：经 setAdjustments → debounced pushHistory，
      // 保证 AI 增强结果进 50 步撤销栈（setEditor 直接写会绕过历史）。
      setAdjustments((prev) => ({
        ...prev,
        ...result,
        ...(result.activeTools ? { activeTools: { ...prev.activeTools, ...result.activeTools } } : {}),
      }));
      // 成功反馈：直方图增强在曝光良好的图上幅度小，无提示会被误读为无响应
      toast.success(t('crystal.aiRecommend.applied'));
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
    /* 闭环修复：handleAutoAdjustments 内部 isReady 不满足时静默 return
     * （无 toast 无效果，移动端 tile 为唯一入口，感知为死键）——面板层先
     * 等待图片就绪再调用；跨图/超时由 hook 与 awaitImageReady 处理。 */
    const startPath = useEditorStore.getState().selectedImage?.path;
    if (!startPath) {
      setBusy(null);
      return;
    }
    try {
      if (!useEditorStore.getState().selectedImage?.isReady && !(await awaitImageReady(startPath))) {
        // 图片未就绪（仍在解码或加载失败）：静默 return 会被感知为死键
        toast.info(t('crystal.aiRecommend.notReady'));
        return;
      }
      await handleAutoAdjustments();
    } finally {
      setBusy(null);
    }
  }, [busy, handleAutoAdjustments, t]);

  const denoiseOn = Boolean(adjustments.aiDenoiseEnabled);

  /* 风格词调色 —— 本地词库映射（后端 ai_style_suggest，无网络/模型依赖）：
   * 自然语言 → 风格 + 非破坏性参数补丁；未命中时不改动当前调整。
   * imagePath（后端新增可选参数）：携带当前图路径供后端按图上下文微调建议，
   * 无图时传 null（旧后端忽略未知参数，向前兼容）。 */
  const runStyleSuggest = useCallback(async () => {
    const prompt = stylePrompt.trim();
    if (!prompt || busy) return;
    setBusy('enhance');
    const startPath = useEditorStore.getState().selectedImage?.path;
    try {
      const result = await invoke<StyleSuggestResult>(Invokes.AiStyleSuggest, {
        prompt,
        imagePath: startPath ?? null,
      });
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      if (!result.adjustments || !result.styleId) {
        toast.info(t('crystal.ai.style.failed'));
        return;
      }
      setAdjustments((prev) => ({ ...prev, ...result.adjustments }));
      setStyleResult(result);
      setShowStyleInput(false);
      toast.success(
        t('crystal.ai.style.applied', {
          name: result.styleName ?? result.styleId,
          conf: Math.round((result.confidence ?? 0) * 100),
        }),
      );
    } catch (e) {
      console.error('AI style suggest failed:', e);
      toast.error(t('crystal.ai.style.failed'));
    } finally {
      setBusy(null);
    }
  }, [busy, setAdjustments, stylePrompt, t]);

  /* 方案 B 云参考图：提示词 → 云端文生图（ai_generate_style_reference，
   * 命中词库风格时用风格英文生成提示）→ 生成图作为样片走 MKL 追色
   * （compute_color_match，bures 聚合）。生成图只进缓存目录作统计参考。 */
  const runStyleReference = useCallback(async () => {
    const prompt = stylePrompt.trim();
    if (!prompt || busy) return;
    const startPath = useEditorStore.getState().selectedImage?.path;
    if (!startPath) {
      setBusy(null);
      return;
    }
    setBusy('styleRef');
    try {
      const token = await getCloudToken();
      if (!token) {
        toast.error(t('crystal.ai.style.cloudNeedLogin'));
        return;
      }
      const generated = await invoke<{ path: string; styleId: string | null }>(
        Invokes.AiGenerateStyleReference,
        { prompt, token },
      );
      // 跨图守卫：生成期间切图则丢弃，避免把参考图追色落到新图上
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      const match = await invoke<{ adjustments: Partial<Adjustments> }>(Invokes.ComputeColorMatch, {
        samplePath: generated.path,
        targetPath: startPath,
        aggregate: 'bures',
      });
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      if (!match.adjustments || Object.keys(match.adjustments).length === 0) {
        toast.info(t('crystal.ai.style.cloudNoPatch'));
        return;
      }
      applyPatch(match.adjustments);
      setShowStyleInput(false);
      toast.success(t('crystal.ai.style.cloudApplied'));
    } catch (e) {
      console.error('AI cloud style reference failed:', e);
      toast.error(t('crystal.ai.style.cloudFailed'));
    } finally {
      setBusy(null);
    }
  }, [busy, getCloudToken, applyPatch, stylePrompt, t]);

  /* 天空识别 —— 复用桌面 sky mask 链路；识别成功后以容器级
   * MaskAdjustments（clarity/dehaze/saturation）提供「天空强度」滑杆。 */
  const runSky = useCallback(async () => {
    if (busy) return;
    setBusy('sky');
    cancelRef.current = false;
    /* 审计修复（AI-跨图）：记录发起时图片，完成后已切图则静默丢弃，
     * 避免在新图上下文里误报「识别失败」或写入默认强度。 */
    const startPath = useEditorStore.getState().selectedImage?.path;
    try {
      const container = ensureContainer(Mask.AiSky);
      const subMaskId = container.subMasks[0].id;
      setBusyTaskId(subMaskId);
      await handleGenerateAiSkyMask(subMaskId, { silent: true });
      if (cancelRef.current) return;
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      if (maskReady(Mask.AiSky)) {
        // 仅首次识别后写入默认强度；重复执行不重复提示。
        if (!Number(container.adjustments.clarity ?? 0))
          setMaskAdjustments(container.id, { clarity: 10, dehaze: 8, saturation: 5 });
        // 名实一致（自检修复 3）：ESAM3 未下载时后端自动降级程序化天空
        // 识别（颜色+地平线，aiSource="procedural"）——名称仍是「天空识别」，
        // 但必须如实告知用户当前走的是哪条路线，不能静默冒充 AI。
        const usedProcedural = String(container.subMasks[0]?.parameters?.aiSource ?? '') === 'procedural';
        if (usedProcedural && !proceduralNotified.current) {
          proceduralNotified.current = true;
          toast.info(t('crystal.ai.proceduralSky'));
        }
      } else {
        // 闭环修复：识别失败清理空容器，tile 状态回归「未开启」，下次点击干净重试。
        removeContainer(Mask.AiSky);
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      removeContainer(Mask.AiSky);
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [busy, ensureContainer, handleGenerateAiSkyMask, maskReady, removeContainer, setMaskAdjustments, t]);

  /* 主体识别 —— AiForeground 前景分割（桌面语义同为主体识别，
   * 且无需框选坐标，适合移动端一键交互）。 */
  const runSubject = useCallback(async () => {
    if (busy) return;
    setBusy('subject');
    cancelRef.current = false;
    const startPath = useEditorStore.getState().selectedImage?.path;
    try {
      const container = ensureContainer(Mask.AiForeground);
      const subMaskId = container.subMasks[0].id;
      setBusyTaskId(subMaskId);
      await handleGenerateAiForegroundMask(subMaskId, { silent: true });
      if (cancelRef.current) return;
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      if (maskReady(Mask.AiForeground)) {
        // 仅首次识别后写入默认强度；重复执行不覆盖用户已调值。
        if (!Number(container.adjustments.clarity ?? 0)) setMaskAdjustments(container.id, { clarity: 10 });
      } else {
        // 闭环修复：识别失败清理空容器（与天空同模式）。
        removeContainer(Mask.AiForeground);
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      removeContainer(Mask.AiForeground);
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [busy, ensureContainer, handleGenerateAiForegroundMask, maskReady, removeContainer, setMaskAdjustments, t]);

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

  // 容器已存在（重进面板/切换分类回来）时回填提示词并同步持久化；
  // 无容器时保留上次输入（持久化恢复），不再清空。仅在容器身份变化时同步，
  // 避免生成过程中覆盖用户输入。
  useEffect(() => {
    const saved = textContainer?.subMasks[0]?.parameters?.prompt;
    if (saved) updateTextPrompt(saved);
  }, [textContainer?.id, updateTextPrompt]);

  const runText = useCallback(async () => {
    if (busy) return;
    const prompt = textPrompt.trim();
    if (!prompt) {
      setShowTextInput(true);
      return;
    }
    setBusy('text');
    cancelRef.current = false;
    const startPath = useEditorStore.getState().selectedImage?.path;
    try {
      const container = ensureContainer(Mask.AiText);
      const subMaskId = container.subMasks[0].id;
      // 桌面语义：生成前把 prompt 写入 subMask.parameters（getSubMaskName 亦用它命名）。
      updateSubMaskParameters(container.id, subMaskId, { prompt });
      setBusyTaskId(subMaskId);
      await handleGenerateAiTextMask(subMaskId, prompt, { silent: true });
      if (cancelRef.current) return;
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      if (maskReady(Mask.AiText)) {
        // 仅首次识别后写入默认强度；重复执行不覆盖用户已调值。
        if (!Number(container.adjustments.clarity ?? 0)) setMaskAdjustments(container.id, { clarity: 10 });
        setShowTextInput(false);
      } else {
        // 闭环修复：识别失败清理空容器；输入与持久化 prompt 保留供直接重试。
        removeContainer(Mask.AiText);
        toast.error(t('crystal.ai.maskFailed'));
      }
    } catch {
      removeContainer(Mask.AiText);
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
    removeContainer,
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
    const startPath = useEditorStore.getState().selectedImage?.path;
    try {
      const container = ensureContainer(Mask.AiDepth, { ...DEPTH_DEFAULTS });
      const subMaskId = container.subMasks[0].id;
      const p = container.subMasks[0].parameters || {};
      setBusyTaskId(subMaskId);
      await handleGenerateAiDepthMask(
        subMaskId,
        {
          minDepth: p.minDepth ?? DEPTH_DEFAULTS.minDepth,
          maxDepth: p.maxDepth ?? DEPTH_DEFAULTS.maxDepth,
          minFade: p.minFade ?? DEPTH_DEFAULTS.minFade,
          maxFade: p.maxFade ?? DEPTH_DEFAULTS.maxFade,
          feather: p.feather ?? DEPTH_DEFAULTS.feather,
        },
        { silent: true },
      );
      if (cancelRef.current) return;
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      if (!maskReady(Mask.AiDepth)) {
        // 闭环修复：识别失败清理空容器（与天空/主体/文本同模式）。
        removeContainer(Mask.AiDepth);
        toast.error(t('crystal.ai.maskFailed'));
      } else if (!Number(container.adjustments.clarity ?? 0)) {
        // 死代码激活：深度强度（容器级 clarity，与天空/主体/文本同模式）。
        // crystal.ai.depthStrength 键 15 语言齐备但从未接线；深度蒙版遮罩内
        // 若无局部调整量，选中后画面零变化（仅范围参数可调、无任何效果）。
        setMaskAdjustments(container.id, { clarity: 10 });
      }
    } catch {
      removeContainer(Mask.AiDepth);
      toast.error(t('crystal.ai.maskFailed'));
    } finally {
      setBusy(null);
      setBusyTaskId(null);
    }
  }, [busy, ensureContainer, handleGenerateAiDepthMask, maskReady, removeContainer, setMaskAdjustments, t]);

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
    /** D-AI-06 来源：model=本地 AI 模型 / rule=本地参数规则 / cloud=云端 */
    source: AiSourceKind;
    onClick: () => void;
    active?: boolean;
    busy?: boolean;
  }> = [
    {
      id: 'enhance',
      label: t('crystal.ai.tiles.enhance'),
      icon: Sparkles,
      color: 'var(--cx-cat-ai)',
      source: 'model',
      onClick: runEnhance,
      busy: busy === 'enhance',
    },
    {
      id: 'auto',
      label: t('crystal.ai.tiles.auto'),
      icon: Wand2,
      color: 'var(--cx-cat-presets)',
      source: 'rule',
      onClick: runAuto,
      busy: busy === 'auto',
    },
    {
      id: 'denoise',
      label: t('crystal.ai.tiles.denoise'),
      icon: Eraser,
      color: 'var(--cx-cat-tone)',
      source: 'model',
      onClick: toggleDenoise,
      active: denoiseOn,
    },
    {
      id: 'lumaNr',
      label: t('crystal.ai.tiles.detail'),
      icon: Waves,
      color: 'var(--cx-cat-filter)',
      source: 'rule',
      onClick: () =>
        applyPatch({
          structure: Math.max(Number(adjustments.structure ?? 0), 10),
          clarity: Math.max(Number(adjustments.clarity ?? 0), 10),
        }),
      /* 审计 AI-反馈：值已达标时点击无变化，补激活态给到视觉闭环 */
      active: Number(adjustments.structure ?? 0) >= 10 || Number(adjustments.clarity ?? 0) >= 10,
    },
    {
      id: 'sky',
      label: t('crystal.ai.tiles.sky'),
      icon: CloudSun,
      color: 'var(--cx-cat-tone)',
      source: 'model',
      onClick: runSky,
      active: skyReady,
      busy: busy === 'sky',
    },
    {
      id: 'subject',
      label: t('crystal.ai.tiles.subject'),
      icon: User,
      /* 审计 AI-色：原 --cx-cat-ren 未定义（回退金色），改人像紫贴合主体识别语义 */
      color: 'var(--cx-cat-portrait)',
      source: 'model',
      onClick: runSubject,
      active: subjectReady,
      busy: busy === 'subject',
    },
    {
      id: 'style',
      label: t('crystal.ai.tiles.style'),
      icon: Palette,
      color: 'var(--cx-cat-presets)',
      /* 风格调色 tile：本地词库规则映射（cloud 云参考图为输入行内的独立入口） */
      source: 'rule',
      onClick: () => setShowStyleInput((v) => !v),
      active: showStyleInput,
    },
    {
      id: 'text',
      label: t('masks.types.text'),
      icon: TextSearch,
      color: 'var(--cx-cat-presets)',
      source: 'model',
      onClick: () => (textPrompt.trim() ? void runText() : setShowTextInput(true)),
      active: textReady,
      busy: busy === 'text',
    },
    {
      id: 'depth',
      label: t('masks.types.depth'),
      icon: BringToFront,
      color: 'var(--cx-cat-filter)',
      source: 'model',
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
          {/* UX：标注强度档仅作用于 AI 增强，避免误读为全局强度 */}
          <div className="cx-fx-label mb-1.5">{t('editor.aiEnhance.title')}</div>
          <div className="cx-chip-row mb-3">
            {INTENSITIES.map(({ id, labelKey }) => (
              <button
                key={id}
                className={`cx-chip ${intensity === id ? 'is-active' : ''}`}
                disabled={Boolean(busy)}
                onClick={() => {
                  haptic(6);
                  setIntensity(id);
                }}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>

          {/* 明暗/色彩双强度：作用于 AI 增强参数（后端 tone_strength/color_strength），
              使「只调氛围不改明暗」成为一阶能力 */}
          <div className="mb-3">
            <CxSliderRow
              label={t('crystal.ai.strength.tone')}
              min={0}
              max={100}
              step={5}
              defaultValue={100}
              value={Math.round(toneStrength * 100)}
              onChange={(v) => setToneStrength(v / 100)}
            />
            <CxSliderRow
              label={t('crystal.ai.strength.color')}
              min={0}
              max={100}
              step={5}
              defaultValue={100}
              value={Math.round(colorStrength * 100)}
              onChange={(v) => setColorStrength(v / 100)}
            />
          </div>

          <div className="cx-grid-tiles mb-2">
            {tiles.map(({ id, label, icon: Icon, color, source, onClick, active, busy: isBusy }) => {
              const badge = AI_SOURCE_BADGES[source];
              const badgeText = tKey(badge.badgeKey);
              return (
                <button
                  key={id}
                  className={`cx-tile ${active ? 'is-active' : ''} ${isBusy ? 'is-busy' : ''}`}
                  /* D-AI-06：来源文字随 label 一并进入可访问名称与悬浮提示（不单靠颜色） */
                  aria-label={`${label} · ${badgeText}`}
                  title={`${label} · ${badgeText}`}
                  onClick={() => {
                    haptic(6);
                    showSourceNote(id, source);
                    onClick();
                  }}
                  disabled={Boolean(busy)}
                  style={{ position: 'relative' }}
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
                  {/* 来源角标：右上角 6px 圆点（青=本地模型 / 金=本地规则 / 紫=云端），
                      自带 role/aria-label/title 文字说明 */}
                  <span
                    role="img"
                    aria-label={badgeText}
                    title={badgeText}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: badge.color,
                    }}
                  />
                  {label}
                </button>
              );
            })}
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
                /* 审计 AI-输入：出现即聚焦拉起软键盘，免二次点按 */
                autoFocus
                enterKeyHint="go"
                onChange={(e) => updateTextPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void runText();
                }}
              />
              <button
                className="cx-chip is-active shrink-0"
                disabled={Boolean(busy) || !textPrompt.trim()}
                onClick={() => {
                  haptic(6);
                  void runText();
                }}
              >
                {t('editor.masks.settings.generateTextMask')}
              </button>
            </div>
          )}

          {/* 风格词调色：风格描述输入 + 应用（后端 ai_style_suggest 本地词库映射） */}
          {showStyleInput && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <input
                  className="cx-input grow"
                  type="text"
                  value={stylePrompt}
                  placeholder={t('crystal.ai.style.placeholder')}
                  disabled={Boolean(busy)}
                  autoFocus
                  enterKeyHint="go"
                  onChange={(e) => setStylePrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runStyleSuggest();
                  }}
                />
                <button
                  className="cx-chip is-active shrink-0"
                  disabled={Boolean(busy) || !stylePrompt.trim()}
                  onClick={() => {
                    haptic(6);
                    void runStyleSuggest();
                  }}
                >
                  {t('crystal.ai.style.title')}
                </button>
                {/* D-AI-02：云参考图入口不可达（非 cloud 提供商 / 未登录 Pro，
                 * Android 恒为后者）时置灰禁用而非静默隐藏；可达时首次点击
                 * 触发底部「云端」来源说明。 */}
                <span className="relative inline-flex shrink-0">
                  <button
                    className="cx-chip shrink-0"
                    title={`${t('crystal.ai.style.cloud')} · ${tKey(AI_SOURCE_BADGES.cloud.badgeKey)}`}
                    aria-label={`${t('crystal.ai.style.cloud')} · ${tKey(AI_SOURCE_BADGES.cloud.badgeKey)}`}
                    disabled={Boolean(busy) || !stylePrompt.trim() || !canCloudStyle}
                    style={canCloudStyle ? undefined : { opacity: 0.45 }}
                    onClick={() => {
                      haptic(6);
                      showSourceNote('cloudRef', 'cloud');
                      void runStyleReference();
                    }}
                  >
                    {busy === 'styleRef' ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <CloudSun size={12} />
                    )}
                  </button>
                  {/* D-AI-06：云参考图入口同样带来源角标（紫=云端） */}
                  <span
                    role="img"
                    aria-label={tKey(AI_SOURCE_BADGES.cloud.badgeKey)}
                    title={tKey(AI_SOURCE_BADGES.cloud.badgeKey)}
                    style={{
                      position: 'absolute',
                      top: -2,
                      right: -2,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: AI_SOURCE_BADGES.cloud.color,
                    }}
                  />
                </span>
              </div>
              {/* D-AI-02/D-AI-03：云参考图说明条 —— 「实验性」标注置于功能标题旁；
               * 不可达时补「桌面版能力 · 需 Pro 登录」角标；联网隐私说明小字、
               * 诚实克制（仅上传文字提示词，不上传照片）。 */}
              <div className="mb-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10.5px] font-medium" style={{ color: 'var(--cx-muted)' }}>
                    {t('crystal.ai.style.cloud')}
                  </span>
                  <span
                    className="text-[9px] px-1 rounded"
                    style={{ color: 'var(--cx-faint)', border: '1px solid var(--cx-border)', lineHeight: '14px' }}
                  >
                    {tKey('crystal.ai.style.experimental')}
                  </span>
                  {!canCloudStyle && (
                    <span
                      className="text-[9px] px-1 rounded"
                      style={{ color: 'var(--cx-faint)', border: '1px solid var(--cx-border)', lineHeight: '14px' }}
                    >
                      {tKey('crystal.ai.style.cloudDesktopOnly')}
                    </span>
                  )}
                </div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--cx-faint)' }}>
                  {tKey('crystal.ai.style.cloudPrivacyNote')}
                </div>
              </div>
            </>
          )}

          {/* 风格词调色结果卡：展示后端返回的风格名（blended 混合时 styleName 已
           * 拼接完整混合名）、建议强度与被忽略的否定描述（可选字段，旧后端缺省不显示） */}
          {styleResult && (
            <div
              className="mb-2 rounded-lg px-2.5 py-2"
              style={{ background: 'var(--cx-card2)', border: '1px solid var(--cx-border)' }}
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                <Sparkles size={11} style={{ color: 'var(--cx-accent)', flexShrink: 0 }} />
                <span className="text-[12px] font-semibold" style={{ color: 'var(--cx-ink)' }}>
                  {styleResult.styleName ?? styleResult.blended ?? styleResult.styleId}
                </span>
                {typeof styleResult.intensity === 'number' && (
                  <span className="text-[10px]" style={{ color: 'var(--cx-faint)' }}>
                    {tKey('crystal.ai.style.intensity', { n: Math.round(styleResult.intensity) })}
                  </span>
                )}
              </div>
              {styleResult.negatedTerms && styleResult.negatedTerms.length > 0 && (
                <div className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--cx-faint)' }}>
                  {tKey('crystal.ai.style.negatedHint', { terms: styleResult.negatedTerms.join(', ') })}
                </div>
              )}
            </div>
          )}

          {skyReady && (
            <>
              <CxSliderRow
                label={t('crystal.ai.skyStrength')}
                min={0}
                max={100}
                step={1}
                defaultValue={50}
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
              <button
                className="cx-mask-remove"
                onClick={() => {
                  haptic(6);
                  removeContainer(Mask.AiSky);
                }}
              >
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
                defaultValue={50}
                value={Math.max(0, Math.min(100, subjectStrength))}
                onChange={(v) =>
                  subjectContainer && setMaskAdjustments(subjectContainer.id, { clarity: Math.round(v * 0.2) })
                }
              />
              <button
                className="cx-mask-remove"
                onClick={() => {
                  haptic(6);
                  removeContainer(Mask.AiForeground);
                }}
              >
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
                defaultValue={50}
                value={Math.max(0, Math.min(100, textStrength))}
                onChange={(v) =>
                  textContainer && setMaskAdjustments(textContainer.id, { clarity: Math.round(v * 0.2) })
                }
              />
              <button
                className="cx-mask-remove"
                onClick={() => {
                  haptic(6);
                  removeContainer(Mask.AiText);
                }}
              >
                <X size={11} />
                {t('crystal.ai.removeMask')}
              </button>
            </>
          )}
          {depthReady && (
            <>
              {/* 死代码激活：深度强度（容器级 clarity ×0.2，反读与天空/主体/文本一致）。
                  遮罩内默认 clarity:10 由 runDepth 首识别后写入。 */}
              <CxSliderRow
                label={t('crystal.ai.depthStrength')}
                min={0}
                max={100}
                step={1}
                defaultValue={50}
                value={Math.max(0, Math.min(100, Math.round(Number(depthContainer?.adjustments.clarity ?? 0) / 0.2)))}
                onChange={(v) =>
                  depthContainer && setMaskAdjustments(depthContainer.id, { clarity: Math.round(v * 0.2) })
                }
              />
              {/* 与桌面 DepthRangePicker 同构：近端显示值 = 100 - maxDepth，
                  远端显示值 = 100 - minDepth，双向钳制保证带通区间有效。
                  审计修复：钳制边界从 store 实时读取，防止快速拖动时闭包旧值
                  导致近/远端互相穿越（minDepth > maxDepth）。 */}
              <CxSliderRow
                label={t('editor.masks.depthRange.near')}
                min={0}
                max={100}
                step={1}
                defaultValue={20}
                value={Math.max(0, Math.min(100, 100 - depthMaxDepth))}
                onChange={(v) => {
                  if (!depthContainer) return;
                  const fresh = useEditorStore.getState().adjustments.masks?.find((c) => c.id === depthContainer.id);
                  const minDepth = Number(fresh?.subMasks[0]?.parameters?.minDepth ?? DEPTH_DEFAULTS.minDepth);
                  updateSubMaskParameters(depthContainer.id, depthContainer.subMasks[0].id, {
                    maxDepth: Math.max(100 - v, minDepth),
                  });
                }}
              />
              <CxSliderRow
                label={t('editor.masks.depthRange.far')}
                min={0}
                max={100}
                step={1}
                defaultValue={80}
                value={Math.max(0, Math.min(100, 100 - depthMinDepth))}
                onChange={(v) => {
                  if (!depthContainer) return;
                  const fresh = useEditorStore.getState().adjustments.masks?.find((c) => c.id === depthContainer.id);
                  const maxDepth = Number(fresh?.subMasks[0]?.parameters?.maxDepth ?? DEPTH_DEFAULTS.maxDepth);
                  updateSubMaskParameters(depthContainer.id, depthContainer.subMasks[0].id, {
                    minDepth: Math.min(100 - v, maxDepth),
                  });
                }}
              />
              <CxSliderRow
                label={t('editor.masks.params.globalFeather')}
                min={0}
                max={100}
                step={1}
                defaultValue={10}
                value={Math.max(0, Math.min(100, depthFeather))}
                onChange={(v) =>
                  depthContainer &&
                  updateSubMaskParameters(depthContainer.id, depthContainer.subMasks[0].id, { feather: v })
                }
              />
              <button
                className="cx-mask-remove"
                onClick={() => {
                  haptic(6);
                  removeContainer(Mask.AiDepth);
                }}
              >
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
                defaultValue={100}
                /* 自检修复（AI 降噪强度）：后端缺省按 100% 应用（ai_denoise.rs
                 * unwrap_or(100)），桌面 Details.tsx 显示 ?? 100；移动端此前 ?? 0
                 * 导致开启降噪后滑杆显示 0、实际满强度，拖动方向感知完全颠倒。 */
                value={Number(adjustments.aiDenoiseAmount ?? 100)}
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
              <button
                className="cx-chip"
                onClick={() => {
                  haptic(6);
                  handleCancelBusy();
                }}
              >
                <X size={11} className="inline mr-1" />
                {t('editor.ai.settings.cancelGeneration')}
              </button>
            )}
          </div>
        )}
        {/* D-AI-06：首次点击 tile 后底部滑入来源说明条（150ms fade+slide，
         * 3 秒自动收起；圆点颜色与说明文字同源，文字说明是否需下载模型/是否联网） */}
        {sourceNoteKind && (
          <div
            role="note"
            className="absolute left-2 right-2 bottom-2 z-20 flex items-start gap-2 rounded-lg px-3 py-2 pointer-events-none"
            style={{
              background: 'var(--cx-card2)',
              border: '1px solid var(--cx-border)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
              opacity: noteShown ? 1 : 0,
              transform: noteShown ? 'translateY(0)' : 'translateY(8px)',
              transition: 'opacity 150ms ease-out, transform 150ms ease-out',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                marginTop: 5,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: AI_SOURCE_BADGES[sourceNoteKind].color,
                flexShrink: 0,
              }}
            />
            <span className="text-[11px] leading-snug" style={{ color: 'var(--cx-muted)' }}>
              {tKey(AI_SOURCE_BADGES[sourceNoteKind].noteKey)}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
