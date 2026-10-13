/**
 * W9-I2 瘦身后的纯绑定层：AI 蒙版业务逻辑在 services/aiMaskingService.ts。
 * 本 hook 仅保留 precompute 订阅效果并转发服务函数。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { aiMaskingService, maybePrecomputeAiSubjectMask } from '../services/aiMaskingService';

export function useAiMasking() {
  const activeMaskId = useEditorStore((state) => state.activeMaskId);
  const activeAiSubMaskId = useEditorStore((state) => state.activeAiSubMaskId);
  const selectedImagePath = useEditorStore((state) => state.selectedImage?.path);
  const adjustments = useEditorStore((state) => state.adjustments);

  // 记录上次 precompute 的签名(path + transform 字段),避免 adjustments 任意字段变化都触发 IPC
  const lastPrecomputeKey = useRef<string>('');

  useEffect(() => {
    maybePrecomputeAiSubjectMask(activeMaskId, activeAiSubMaskId, selectedImagePath ?? null, lastPrecomputeKey);
  }, [activeMaskId, activeAiSubMaskId, selectedImagePath, adjustments]);

  return useMemo(
    () => ({
      updateSubMask: (subMaskId: string, updatedData: any) => aiMaskingService.updateSubMask(subMaskId, updatedData),
      handleGenerativeReplace: (patchId: string, prompt: string, useFastInpaint: boolean) =>
        aiMaskingService.handleGenerativeReplace(patchId, prompt, useFastInpaint),
      handleDirectPatch: (subMaskId: string, sourceX: number, sourceY: number) =>
        aiMaskingService.handleDirectPatch(subMaskId, sourceX, sourceY),
      handleQuickErase: (subMaskId: string | null, startPoint: any, endPoint: any) =>
        aiMaskingService.handleQuickErase(subMaskId, startPoint, endPoint),
      handleDeleteMaskContainer: (containerId: string) => aiMaskingService.handleDeleteMaskContainer(containerId),
      handleDeleteAiPatch: (patchId: string) => aiMaskingService.handleDeleteAiPatch(patchId),
      handleToggleAiPatchVisibility: (patchId: string) => aiMaskingService.handleToggleAiPatchVisibility(patchId),
      handleGenerateAiMask: (subMaskId: string, startPoint: any, endPoint: any) =>
        aiMaskingService.handleGenerateAiMask(subMaskId, startPoint, endPoint),
      handleGenerateAiDepthMask: (subMaskId: string, parameters: any) =>
        aiMaskingService.handleGenerateAiDepthMask(subMaskId, parameters),
      handleGenerateAiForegroundMask: (subMaskId: string) => aiMaskingService.handleGenerateAiForegroundMask(subMaskId),
      handleGenerateAiSkyMask: (subMaskId: string) => aiMaskingService.handleGenerateAiSkyMask(subMaskId),
    }),
    [],
  );
}
