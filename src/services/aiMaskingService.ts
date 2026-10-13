/**
 * W9-I2 AI 蒙版业务服务层。
 *
 * 原 useAiMasking 的全部业务逻辑迁入此处（hook 仅保留 precompute 订阅效果）。
 * 所有状态读写经 useEditorStore.getState()，无 React 依赖。
 */
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { debouncedSetHistory } from '../hooks/useEditorActions';
import { Adjustments, AiPatch, MaskContainer, Coord } from '../utils/adjustments';
import { SubMask } from '../components/panel/right/Masks';
import { Invokes } from '../components/ui/AppProperties';

/**
 * 在最新 adjustments 中查找指定 subMask(同时搜索 masks 与 aiPatches)。
 * 用于 AI 蒙版 handler 在 await 后获取最新参数,避免:
 * 1. 使用函数入口时捕获的过期 adjustments 闭包
 * 2. 仅搜索 aiPatches 导致 masks 容器中的 subMask 参数丢失
 */
const findSubMaskInLatestState = (subMaskId: string): SubMask | undefined => {
  const { adjustments } = useEditorStore.getState();
  return (
    adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
    adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId)
  );
};

/** 安全解析后端返回的 JSON 字符串,失败时抛出带上下文的可读错误 */
const parsePatchDataJson = (json: unknown, context: string): Record<string, unknown> => {
  if (typeof json !== 'string') {
    throw new Error(`${context}: expected JSON string, got ${typeof json}`);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`${context}: backend returned invalid JSON (len=${(json as string).length})`);
  }
};

const getTransformAdjustments = (adj: Adjustments) => ({
  transformDistortion: adj.transformDistortion,
  transformVertical: adj.transformVertical,
  transformHorizontal: adj.transformHorizontal,
  transformRotate: adj.transformRotate,
  transformAspect: adj.transformAspect,
  transformScale: adj.transformScale,
  transformXOffset: adj.transformXOffset,
  transformYOffset: adj.transformYOffset,
  lensDistortionAmount: adj.lensDistortionAmount,
  lensVignetteAmount: adj.lensVignetteAmount,
  lensTcaAmount: adj.lensTcaAmount,
  lensDistortionParams: adj.lensDistortionParams,
  lensMaker: adj.lensMaker,
  lensModel: adj.lensModel,
  lensDistortionEnabled: adj.lensDistortionEnabled,
  lensTcaEnabled: adj.lensTcaEnabled,
  lensVignetteEnabled: adj.lensVignetteEnabled,
});

/** 与 useEditorActions.setAdjustments 相同语义（含防抖历史与 showOriginal 退出） */
const setAdjustments = (value: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => {
  useEditorStore.getState().setEditor((state) => {
    const prev = state.adjustments;
    const newAdjustments = typeof value === 'function' ? value(prev) : { ...prev, ...value };
    debouncedSetHistory(newAdjustments);
    return {
      adjustments: newAdjustments,
      ...(state.showOriginal ? { showOriginal: false, previewOverride: null } : {}),
    };
  });
};

export const aiMaskingService = {
  updateSubMask(subMaskId: string, updatedData: any) {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((c: MaskContainer) => ({
        ...c,
        subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
      aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
        ...p,
        subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
    }));
  },

  async handleDirectPatch(subMaskId: string, sourceX: number, sourceY: number) {
    const { selectedImage } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    const startPath = selectedImage.path;

    // 预先设置加载状态（基于当前已知patchId）
    const currentPatchId = useEditorStore
      .getState()
      .adjustments.aiPatches.find((p: AiPatch) => p.subMasks.some((sm: SubMask) => sm.id === subMaskId))?.id;
    if (!currentPatchId) return;

    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === currentPatchId ? { ...p, isLoading: true } : p)),
    }));

    let patchId = currentPatchId;
    try {
      // 重新获取最新状态，避免使用过期闭包
      const latestState = useEditorStore.getState();
      const latestAdjustments = latestState.adjustments;
      const { patchesSentToBackend } = latestState;
      const latestPatchId = latestAdjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!latestPatchId) {
        // patch已被删除，静默回滚加载状态
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === currentPatchId ? { ...p, isLoading: false } : p,
          ),
        }));
        return;
      }
      patchId = latestPatchId;
      const patchDefinitionForBackend = latestAdjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
      const isAutoErase = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'auto-erase');
      const isLiquify = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'liquify');
      const isRetouch = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'retouch');
      const command = isAutoErase
        ? 'generate_auto_erase_patch'
        : isLiquify
          ? 'generate_liquify_patch'
          : isRetouch
            ? 'generate_retouch_patch'
            : 'generate_manual_cleanup_patch';

      const newPatchDataJson: any = await invoke(command, {
        currentAdjustments: latestAdjustments,
        patchDefinition: patchDefinitionForBackend,
        sourcePoint: [sourceX, sourceY],
      });

      // 用户已切换到其他图片 — 丢弃旧结果
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const newPatchData = parsePatchDataJson(newPatchDataJson, 'Patch Generation');
      patchesSentToBackend.delete(patchId);

      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) =>
          p.id === patchId ? { ...p, patchData: newPatchData, isLoading: false } : p,
        ),
      }));
    } catch (err: any) {
      // 如果切了图，不要重置新图的 isLoading 状态
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`Patch Generation Failed: ${err.message || String(err)}`);
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
      }));
    }
  },

  async handleGenerativeReplace(patchId: string, prompt: string, useFastInpaint: boolean) {
    const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || isGeneratingAi) return;
    const startPath = selectedImage.path;

    const patch: AiPatch | undefined = adjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
    if (!patch) return;

    const patchDefinition = { ...patch, prompt };
    // 端侧优先：推理全部本地执行，不获取云鉴权 token，避免断网时阻断可用性。

    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true, prompt } : p)),
    }));

    useEditorStore.getState().setEditor({ isGeneratingAi: true });

    try {
      const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
        currentAdjustments: adjustments,
        patchDefinition: patchDefinition,
        path: selectedImage.path,
        useFastInpaint: useFastInpaint,
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const newPatchData = parsePatchDataJson(newPatchDataJson, 'Generative Replace');

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) =>
          p.id === patchId
            ? {
                ...p,
                patchData: newPatchData,
                isLoading: false,
                name: useFastInpaint ? 'Inpaint' : prompt && prompt.trim() ? prompt.trim() : p.name,
              }
            : p,
        ),
      }));
      patchesSentToBackend.delete(patchId);
      useEditorStore
        .getState()
        .setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null, isGeneratingAi: false });
    } catch (err) {
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`AI Replace Failed: ${err}`);
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
      }));
      useEditorStore.getState().setEditor({ isGeneratingAi: false });
    }
  },

  async handleQuickErase(subMaskId: string | null, startPoint: Coord, endPoint: Coord) {
    const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || isGeneratingAi) return;
    const startPath = selectedImage.path;

    const patchId = adjustments.aiPatches.find((p: AiPatch) =>
      p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
    )?.id;
    if (!patchId) return;

    // 快速涂画始终使用端侧 Lama 模型，完全本地执行，无需云 token。
    useEditorStore.getState().setEditor({ isGeneratingAi: true });
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
    }));

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newMaskParams: any = await invoke(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      // 使用最新状态查找 subMask,避免过期闭包导致参数丢失
      const subMaskToUpdate = findSubMaskInLatestState(subMaskId || '');
      const finalSubMaskParams: any = { ...subMaskToUpdate?.parameters, ...newMaskParams };

      // 先将蒙版参数回写到 state,确保后续 patch 生成失败时参数不丢失
      this.updateSubMask(subMaskId || '', { parameters: finalSubMaskParams });

      const latestAdjustments = useEditorStore.getState().adjustments;
      const updatedAdjustmentsForBackend = {
        ...latestAdjustments,
        aiPatches: latestAdjustments.aiPatches.map((p: AiPatch) =>
          p.id === patchId
            ? {
                ...p,
                subMasks: p.subMasks.map((sm: SubMask) =>
                  sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                ),
              }
            : p,
        ),
      };

      const patchDefinitionForBackend = updatedAdjustmentsForBackend.aiPatches.find((p: AiPatch) => p.id === patchId);
      const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
        currentAdjustments: updatedAdjustmentsForBackend,
        patchDefinition: { ...patchDefinitionForBackend, prompt: '' },
        path: selectedImage.path,
        useFastInpaint: true,
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const newPatchData = parsePatchDataJson(newPatchDataJson, 'Quick Erase');

      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) =>
          p.id === patchId
            ? {
                ...p,
                patchData: newPatchData,
                isLoading: false,
              }
            : p,
        ),
      }));
      patchesSentToBackend.delete(patchId);
      useEditorStore
        .getState()
        .setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null, isGeneratingAi: false });
    } catch (err: any) {
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`Quick Erase Failed: ${err.message || String(err)}`);
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
      }));
      useEditorStore.getState().setEditor({ isGeneratingAi: false });
    }
  },

  handleDeleteMaskContainer(containerId: string) {
    const { activeMaskContainerId } = useEditorStore.getState();
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: (prev.masks || []).filter((c) => c.id !== containerId),
    }));
    if (activeMaskContainerId === containerId) {
      useEditorStore.getState().setEditor({ activeMaskContainerId: null, activeMaskId: null });
    }
  },

  handleDeleteAiPatch(patchId: string) {
    const { activeAiPatchContainerId } = useEditorStore.getState();
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
    }));
    if (activeAiPatchContainerId === patchId) {
      useEditorStore.getState().setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
    }
  },

  handleToggleAiPatchVisibility(patchId: string) {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: (prev.aiPatches || []).map((p: AiPatch) =>
        p.id === patchId ? { ...p, visible: !p.visible } : p,
      ),
    }));
  },

  async handleGenerateAiMask(subMaskId: string, startPoint: Coord, endPoint: Coord) {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    const startPath = selectedImage.path;
    useEditorStore.getState().setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const subMask = findSubMaskInLatestState(subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, unknown>) };
      patchesSentToBackend.delete(subMaskId);
      this.updateSubMask(subMaskId, { parameters: mergedParameters });
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    } catch (error) {
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`AI Mask Failed: ${error}`);
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    }
  },

  async handleGenerateAiDepthMask(subMaskId: string, parameters: any) {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    const startPath = selectedImage.path;
    useEditorStore.getState().setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke('generate_ai_depth_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        minDepth: parameters.minDepth ?? 20,
        maxDepth: parameters.maxDepth ?? 100,
        minFade: parameters.minFade ?? 15,
        maxFade: parameters.maxFade ?? 15,
        feather: parameters.feather ?? 10,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const subMask = findSubMaskInLatestState(subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, unknown>) };
      patchesSentToBackend.delete(subMaskId);
      this.updateSubMask(subMaskId, { parameters: mergedParameters });
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    } catch (error) {
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`AI Depth Mask Failed: ${error}`);
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    }
  },

  async handleGenerateAiForegroundMask(subMaskId: string) {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    const startPath = selectedImage.path;
    useEditorStore.getState().setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiForegroundMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const subMask = findSubMaskInLatestState(subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, unknown>) };
      patchesSentToBackend.delete(subMaskId);
      this.updateSubMask(subMaskId, { parameters: mergedParameters });
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    } catch (error) {
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`AI Mask Failed: ${error}`);
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    }
  },

  async handleGenerateAiSkyMask(subMaskId: string) {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    const startPath = selectedImage.path;
    useEditorStore.getState().setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiSkyMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      if (useEditorStore.getState().selectedImage?.path !== startPath) return;

      const subMask = findSubMaskInLatestState(subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, unknown>) };
      patchesSentToBackend.delete(subMaskId);
      this.updateSubMask(subMaskId, { parameters: mergedParameters });
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    } catch (error) {
      if (useEditorStore.getState().selectedImage?.path !== startPath) return;
      toast.error(`AI Mask Failed: ${error}`);
      useEditorStore.getState().setEditor({ isGeneratingAiMask: false });
    }
  },
};

/**
 * precompute 效果体（hook 订阅后调用）：仅当活动子蒙版为 ai-subject 时按签名触发，
 * 避免 adjustments 任意字段变化都发起 IPC。
 */
export function maybePrecomputeAiSubjectMask(
  activeMaskId: string | null,
  activeAiSubMaskId: string | null,
  selectedImagePath: string | null,
  lastPrecomputeKey: { current: string },
) {
  const { adjustments } = useEditorStore.getState();
  if (!adjustments) return;
  const activeSubMask =
    adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === activeMaskId) ||
    adjustments.aiPatches
      ?.flatMap((p: AiPatch) => p.subMasks)
      .find((sm: SubMask) => sm.id === activeAiSubMaskId);

  if (activeSubMask?.type === 'ai-subject' && selectedImagePath) {
    const transformAdjustments = getTransformAdjustments(adjustments);
    // 构造签名:path + transform 关键字段,仅在签名变化时发起 precompute
    const signature = `${selectedImagePath}|${JSON.stringify(transformAdjustments)}`;
    if (signature === lastPrecomputeKey.current) return;
    lastPrecomputeKey.current = signature;

    invoke('precompute_ai_subject_mask', {
      jsAdjustments: transformAdjustments,
      path: selectedImagePath,
    }).catch((err) => console.error('Failed to precompute AI subject mask:', err));
  }
}
