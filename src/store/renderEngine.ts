/**
 * W9-I2 渲染管线（AR-10 渲染链路 store 化）。
 *
 * 原 useImageProcessing 的全部渲染业务逻辑迁入此模块（store 层）：
 * - 预览渲染执行（executeApplyAdjustments）：AI patch 去重下发、ROI 计算、
 *   交互 patch 解码、blob URL 生命周期管理
 * - 拖拽管线（applyAdjustments/flushPipeline）：in-flight 上限 3 + 待发队列
 * - HiFi 缩放（maybeRequestHiFiZoom）：50ms 防抖、仅升分辨率
 * - 编辑器渲染调度（scheduleEditorRender）：拖拽实时/空闲 50ms 落账，
 *   含 debouncedSave 自动保存与多选 autoSync 增量下发
 *
 * hook 层（useImageProcessing）仅保留效果绑定与依赖触发。
 */
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { useEditorStore } from './useEditorStore';
import { useUIStore } from './useUIStore';
import { useSettingsStore } from './useSettingsStore';
import { useLibraryStore } from './useLibraryStore';
import { getAppServices } from '../services/appServiceRegistry';
import { Adjustments, COPYABLE_ADJUSTMENT_KEYS } from '../utils/adjustments';
import { Invokes } from '../components/ui/AppProperties';
import { globalImageCache } from '../utils/ImageLRUCache';

// === 模块级渲染状态（原 App 层 refs：previewJobIdRef 等，随渲染链路一并收编） ===
let previewJobId = 0;
let latestRenderedJobId = 0;
let currentRes = 1280;
let inFlightCount = 0;
let lastAnalyticsTime = 0;
let pendingApply: { adjustments: Adjustments; targetRes?: number } | null = null;
let dragIdleTimer: ReturnType<typeof setTimeout> | null = null;
/** 自动保存/多选同步的快照（原 prevAdjustmentsRef，useAppNavigation 切图时写入） */
let prevSyncSnapshot: { path: string; adjustments: Adjustments } | null = null;

const requestHiFiZoomDebounced = debounce((targetRes: number, apply: (adj: Adjustments, target: number) => void) => {
  if (targetRes > currentRes) {
    currentRes = targetRes;
    const { adjustments, previewOverride } = useEditorStore.getState();
    apply(previewOverride ?? adjustments, targetRes);
  }
}, 50);

// === 图像切换联动（useAppNavigation 消费） ===

/** 缓存命中路径：对齐渲染序号，未落地的旧渲染结果作废 */
export function alignRenderJobs() {
  latestRenderedJobId = previewJobId;
}

/** 缓存命中置 Infinity（信任缓存满分辨率），后端就绪/失败后归零 */
export function setCurrentRes(value: number) {
  currentRes = value;
}

/** 切图时同步自动保存快照 */
export function setPrevSyncSnapshot(path: string, adjustments: Adjustments) {
  prevSyncSnapshot = { path, adjustments };
}

// === ROI ===

function calculateROI(): [number, number, number, number] | null {
  const state = getAppServices().getTransformState();
  if (!state) return null;

  const { baseRenderSize } = useEditorStore.getState();
  if (!baseRenderSize) return null;

  const { scale, positionX, positionY } = state;
  const { width: baseW, height: baseH, offsetX, offsetY, containerWidth, containerHeight } = baseRenderSize;

  if (!baseW || !baseH || !containerWidth || !containerHeight) return null;
  if (scale <= 1.01) return null;

  const paddingPixels = 2.0;
  const paddingX = paddingPixels / baseW;
  const paddingY = paddingPixels / baseH;

  const visibleLeft = -positionX / scale;
  const visibleTop = -positionY / scale;
  const visibleRight = visibleLeft + containerWidth / scale;
  const visibleBottom = visibleTop + containerHeight / scale;

  const imgLeft = offsetX;
  const imgTop = offsetY;
  const imgRight = offsetX + baseW;
  const imgBottom = offsetY + baseH;

  const intersectLeft = Math.max(visibleLeft, imgLeft);
  const intersectTop = Math.max(visibleTop, imgTop);
  const intersectRight = Math.min(visibleRight, imgRight);
  const intersectBottom = Math.min(visibleBottom, imgBottom);

  if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
    return null;
  }

  const roiX = (intersectLeft - imgLeft) / baseW;
  const roiY = (intersectTop - imgTop) / baseH;
  const roiW = (intersectRight - intersectLeft) / baseW;
  const roiH = (intersectBottom - intersectTop) / baseH;

  const newRoiX = roiX - paddingX;
  const newRoiY = roiY - paddingY;
  const newRoiW = roiW + paddingX * 2;
  const newRoiH = roiH + paddingY * 2;

  const clampedX = Math.max(0, newRoiX);
  const clampedY = Math.max(0, newRoiY);
  const clampedW = Math.min(1 - clampedX, newRoiW);
  const clampedH = Math.min(1 - clampedY, newRoiH);

  if (clampedW > 0.999 && clampedH > 0.999) return null;

  return [clampedX, clampedY, clampedW, clampedH];
}

// === 渲染执行 ===

export async function executeApplyAdjustments(
  currentAdjustments: Adjustments,
  dragging: boolean = false,
  targetRes?: number,
) {
  const { selectedImage } = useEditorStore.getState();
  const currentPath = selectedImage?.path;
  if (!currentPath) return;

  let shouldRequestAnalytics = false;
  if (dragging) {
    const now = performance.now();
    if (now - lastAnalyticsTime > 33.33) {
      shouldRequestAnalytics = true;
      lastAnalyticsTime = now;
    }
  } else {
    shouldRequestAnalytics = true;
    lastAnalyticsTime = 0;
  }

  const payload = structuredClone(currentAdjustments);
  const { patchesSentToBackend } = useEditorStore.getState();
  const newlySentPatches = new Set<string>();

  const processSubMasks = (subMasks: any[]) => {
    if (!Array.isArray(subMasks)) return;
    subMasks.forEach((sm: any) => {
      if (sm.id && sm.parameters) {
        const keys = ['mask_data_base64', 'maskDataBase64'];
        let foundMaskData = false;

        for (const key of keys) {
          if (sm.parameters[key] !== undefined && sm.parameters[key] !== null) {
            foundMaskData = true;
            if (patchesSentToBackend.has(sm.id)) {
              sm.parameters[key] = null;
            }
          }
        }
        if (foundMaskData && !patchesSentToBackend.has(sm.id)) {
          newlySentPatches.add(sm.id);
        }
      }
    });
  };

  if (payload.aiPatches && Array.isArray(payload.aiPatches)) {
    payload.aiPatches.forEach((p: any) => {
      if (p.id && p.patchData && !p.isLoading) {
        if (patchesSentToBackend.has(p.id)) {
          p.patchData = null;
        } else {
          newlySentPatches.add(p.id);
        }
      }
      if (p.subMasks) processSubMasks(p.subMasks);
    });
  }

  if (payload.masks && Array.isArray(payload.masks)) {
    payload.masks.forEach((container: any) => {
      if (container.subMasks) processSubMasks(container.subMasks);
    });
  }

  const jobId = ++previewJobId;
  const roi = calculateROI();
  const { isWaveformVisible, activeWaveformChannel, setEditor } = useEditorStore.getState();

  try {
    const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
      jsAdjustments: payload,
      isInteractive: dragging,
      targetResolution: targetRes || null,
      roi: roi || null,
      requestAnalytics: shouldRequestAnalytics,
      computeWaveform: !!isWaveformVisible,
      activeWaveformChannel: activeWaveformChannel || null,
    });

    if (newlySentPatches.size > 0) {
      newlySentPatches.forEach((id) => patchesSentToBackend.add(id));
    }

    if (currentPath !== useEditorStore.getState().selectedImage?.path) return;

    if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobId) {
      latestRenderedJobId = jobId;

      const textDecoder = new TextDecoder();
      const prefix = textDecoder.decode(buffer.slice(0, 11));
      if (prefix === 'WGPU_RENDER') {
        setEditor((state) => {
          if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
          return { interactivePatch: null };
        });
        return;
      }

      if (dragging) {
        const view = new DataView(buffer);
        const patchX = view.getUint32(0, true);
        const patchY = view.getUint32(4, true);
        const patchW = view.getUint32(8, true);
        const patchH = view.getUint32(12, true);
        const fullW = view.getUint32(16, true);
        const fullH = view.getUint32(20, true);

        const imageBuffer = buffer.slice(24);
        const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);

        setEditor((state) => {
          const patch = state.interactivePatch;
          if (patch && patch.url) setTimeout(() => URL.revokeObjectURL(patch.url), 100);
          return {
            interactivePatch: {
              url,
              normX: patchX / fullW,
              normY: patchY / fullH,
              normW: patchW / fullW,
              normH: patchH / fullH,
            },
          };
        });
      } else {
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);

        if (
          currentPath !== useEditorStore.getState().selectedImage?.path ||
          jobId < latestRenderedJobId
        ) {
          URL.revokeObjectURL(url);
          return;
        }

        setEditor((state) => {
          const prevUrl = state.finalPreviewUrl;
          if (prevUrl && prevUrl.startsWith('blob:') && !globalImageCache.isProtected(prevUrl)) {
            setTimeout(() => {
              if (!globalImageCache.isProtected(prevUrl)) {
                URL.revokeObjectURL(prevUrl);
              }
            }, 250);
          }
          return { finalPreviewUrl: url };
        });

        setEditor((state) => {
          const patch = state.interactivePatch;
          if (patch && patch.url) {
            setTimeout(() => URL.revokeObjectURL(patch.url), 500);
          }
          return { interactivePatch: null };
        });
      }
    }
  } catch (err) {
    if (err !== 'Superseded or worker failed') {
      console.error('Failed to apply adjustments:', err);
    }
    if (!dragging) {
      setEditor((state) => {
        const patch = state.interactivePatch;
        if (patch && patch.url) URL.revokeObjectURL(patch.url);
        return { interactivePatch: null };
      });
    }
  }
}

// === 拖拽管线（in-flight 上限 + 待发队列） ===

function flushPipeline() {
  if (inFlightCount >= 3) return;
  if (!pendingApply) return;

  const { adjustments, targetRes } = pendingApply;
  pendingApply = null;

  inFlightCount += 1;

  executeApplyAdjustments(adjustments, true, targetRes).finally(() => {
    inFlightCount -= 1;
    if (pendingApply) {
      requestAnimationFrame(() => flushPipeline());
    }
  });
}

export function applyAdjustments(currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) {
  const { selectedImage } = useEditorStore.getState();
  if (!selectedImage?.isReady) return;

  if (dragging) {
    pendingApply = { adjustments: currentAdjustments, targetRes };
    flushPipeline();
  } else {
    pendingApply = null;
    executeApplyAdjustments(currentAdjustments, false, targetRes);
  }
}

// === 未裁剪预览（Crop 面板） ===

export function generateUncroppedPreview(currentAdjustments: Adjustments) {
  const { selectedImage } = useEditorStore.getState();
  if (!selectedImage?.isReady) return;
  invoke(Invokes.GenerateUncroppedPreview, { jsAdjustments: currentAdjustments }).catch((err) =>
    console.error('Failed to generate uncropped preview:', err),
  );
}

// === HiFi 缩放 ===

function calculateTargetRes(): number {
  const { appSettings } = useSettingsStore.getState();
  const { displaySize, originalSize } = useEditorStore.getState();
  const baseTargetRes = appSettings?.editorPreviewResolution || 1920;
  if (!(appSettings?.enableZoomHifi ?? true) || displaySize.width === 0) {
    return baseTargetRes;
  }

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const sharpnessFactor = 1.25;
  const zoomMultiplier = appSettings?.highResZoomMultiplier || 1.0;
  const effectiveDpr = appSettings?.useFullDpiRendering ? dpr : 1;

  let targetRes = Math.max(displaySize.width, displaySize.height) * effectiveDpr * sharpnessFactor * zoomMultiplier;
  targetRes = Math.max(targetRes, 512);

  if (originalSize && originalSize.width > 0 && originalSize.height > 0) {
    const origMax = Math.max(originalSize.width, originalSize.height);
    targetRes = Math.min(targetRes, origMax);
    if (targetRes >= origMax * 0.8) {
      targetRes = origMax;
    }
  }

  if (originalSize && targetRes !== Math.max(originalSize.width, originalSize.height)) {
    targetRes = Math.ceil(targetRes / 256) * 256;
  }

  return Math.round(targetRes);
}

/** E2 入口：仅在可升档时发起 HiFi 渲染（50ms 防抖） */
export function maybeRequestHiFiZoom() {
  const { activeView } = useUIStore.getState();
  const { selectedImage, displaySize, isSliderDragging, originalSize } = useEditorStore.getState();
  if (!(activeView === 'editor' && selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging)) return;

  let baseRes = calculateTargetRes();
  if (originalSize.width > 0 && originalSize.height > 0) {
    const maxRes = Math.max(originalSize.width, originalSize.height);
    if (baseRes > maxRes) baseRes = maxRes;
  }
  const finalRes = Math.round(baseRes);

  if (finalRes > currentRes) {
    requestHiFiZoomDebounced(finalRes, (adj, target) => applyAdjustments(adj, false, target));
  }
}

export function cancelHiFiZoom() {
  requestHiFiZoomDebounced.cancel();
}

// === 编辑器渲染调度（E3：拖拽实时 / 空闲落账） ===

export function clearDragIdleTimer() {
  if (dragIdleTimer) {
    clearTimeout(dragIdleTimer);
    dragIdleTimer = null;
  }
}

export function scheduleEditorRender(dragging: boolean) {
  const editor = useEditorStore.getState();
  if (!editor.selectedImage?.isReady) return;

  clearDragIdleTimer();

  const targetRes = calculateTargetRes();
  const renderAdjustments = editor.previewOverride ?? editor.adjustments;

  const { activeView } = useUIStore.getState();
  if (activeView !== 'editor') {
    if (dragging) return;
  }

  const { appSettings } = useSettingsStore.getState();

  if (dragging) {
    if (appSettings?.enableLivePreviews !== false) {
      applyAdjustments(renderAdjustments, true, targetRes);
    }
  } else {
    dragIdleTimer = setTimeout(() => {
      currentRes = targetRes;

      applyAdjustments(renderAdjustments, false, targetRes);

      const latest = useEditorStore.getState();
      if (latest.previewOverride) return;

      const selectedImage = latest.selectedImage;
      if (!selectedImage) return;

      getAppServices().saveAdjustmentsDebounced(selectedImage.path, latest.adjustments);

      const otherPaths = useLibraryStore
        .getState()
        .multiSelectedPaths.filter((p) => p !== selectedImage.path);
      if (appSettings?.copyPasteSettings?.autoSync && otherPaths.length > 0) {
        const prev = prevSyncSnapshot;
        if (prev && prev.path === selectedImage.path) {
          const delta: Partial<Adjustments> = {};
          const includedKeys = appSettings?.copyPasteSettings?.includedAdjustments || COPYABLE_ADJUSTMENT_KEYS;
          for (const key of Object.keys(latest.adjustments) as Array<keyof Adjustments>) {
            if (includedKeys.includes(key as string)) {
              if (JSON.stringify(latest.adjustments[key]) !== JSON.stringify(prev.adjustments[key])) {
                (delta as any)[key] = latest.adjustments[key];
              }
            }
          }
          if (Object.keys(delta).length > 0) {
            otherPaths.forEach((p) => globalImageCache.delete(p));
            invoke(Invokes.ApplyAdjustmentsToPaths, { paths: otherPaths, adjustments: delta }).catch((err) => {
              console.error('Failed to apply adjustments to multi-selection:', err);
            });
          }
        }
      }
      setPrevSyncSnapshot(selectedImage.path, latest.adjustments);
    }, 50);
  }
}
