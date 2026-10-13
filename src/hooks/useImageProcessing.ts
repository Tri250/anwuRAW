/**
 * W9-I2 瘦身后的纯绑定层：渲染业务逻辑全部在 store/renderEngine.ts
 * （经 useProcessStore 暴露）。本 hook 仅负责：
 * 1. 注册运行时依赖（变换状态/自动保存）到服务层
 * 2. 三条订阅效果触发渲染调度（未裁剪预览 / HiFi 缩放 / 编辑器调度）
 */
import { useEffect } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useProcessStore } from '../store/useProcessStore';
import { registerAppServices } from '../services/appServiceRegistry';
import { debouncedSave } from './useEditorActions';
import { Panel } from '../components/ui/AppProperties';

export function useImageProcessing(transformWrapperRef: React.RefObject<any>) {
  registerAppServices({
    getTransformState: () => transformWrapperRef.current?.instance?.transformState ?? null,
    saveAdjustmentsDebounced: debouncedSave,
  });

  const selectedImage = useEditorStore((state) => state.selectedImage);
  const adjustments = useEditorStore((state) => state.adjustments);
  const previewOverride = useEditorStore((state) => state.previewOverride);
  const isSliderDragging = useEditorStore((state) => state.isSliderDragging);
  const displaySize = useEditorStore((state) => state.displaySize);
  const originalSize = useEditorStore((state) => state.originalSize);
  const isWaveformVisible = useEditorStore((state) => state.isWaveformVisible);

  const activeView = useUIStore((state) => state.activeView);
  const activePanel = useUIStore((state) => state.activePanel);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  const isReady = selectedImage?.isReady;
  const imagePath = selectedImage?.path;

  // E1：Crop 面板激活时生成未裁剪预览
  useEffect(() => {
    if (activeView === 'editor' && activePanel === Panel.Crop && isReady) {
      useProcessStore.getState().generateUncroppedPreview(adjustments);
    }
  }, [activeView, adjustments, activePanel, isReady]);

  // E2：视口/原图变化时按需升档 HiFi 渲染
  useEffect(() => {
    if (activeView === 'editor' && isReady && displaySize.width > 0 && !isSliderDragging) {
      useProcessStore.getState().maybeRequestHiFiZoom();
    }
    return () => {
      useProcessStore.getState().cancelHiFiZoom();
    };
  }, [activeView, displaySize.width, displaySize.height, isReady, isSliderDragging, originalSize]);

  // E3：编辑器渲染调度（拖拽实时 / 空闲落账含自动保存与多选同步）
  useEffect(() => {
    useProcessStore.getState().scheduleEditorRender(isSliderDragging);
    return () => {
      useProcessStore.getState().clearDragIdleTimer();
    };
  }, [
    activeView,
    adjustments,
    previewOverride,
    imagePath,
    isReady,
    isSliderDragging,
    multiSelectedPaths,
    appSettings?.enableLivePreviews,
    appSettings?.copyPasteSettings?.includedAdjustments,
    appSettings?.copyPasteSettings?.autoSync,
    isWaveformVisible,
  ]);
}
