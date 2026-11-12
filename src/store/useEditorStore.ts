import { create } from 'zustand';
import { Adjustments, INITIAL_ADJUSTMENTS, MaskContainer, AiPatch } from '../utils/adjustments';
import { SelectedImage, WaveformData, BrushSettings, CompareView } from '../components/ui/AppProperties';
import { ChannelConfig } from '../components/adjustments/Curves';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../components/panel/right/Masks';
import { OverlayMode } from '../components/panel/right/CropPanel';
import { DEFAULT_SOFT_PROOFING, SoftProofingSettings } from '../utils/softProofing';

export type CenterMarker = 'vignette' | 'centre';

// When a history navigation swaps in an adjustments snapshot, any AI patch /
// mask-data blob whose object identity differs from the live state was never
// sent to the backend under that content. Drop the sent markers so the next
// render payload re-ships the actual data instead of the backend hydrating a
// newer cached blob (e.g. undoing a patch regeneration).
const syncSentPatchMarkers = (prev: Adjustments, next: Adjustments, sent: Set<string>) => {
  const prevPatches = prev.aiPatches || [];
  (next.aiPatches || []).forEach((patch: AiPatch) => {
    const prevPatch = prevPatches.find((p: AiPatch) => p.id === patch.id);
    if (!prevPatch || prevPatch.patchData !== patch.patchData) {
      sent.delete(patch.id);
    }
    const prevSubMasks = prevPatch?.subMasks || [];
    (patch.subMasks || []).forEach((sm: any) => {
      const prevSm = prevSubMasks.find((p: any) => p.id === sm.id);
      if (!prevSm || prevSm.parameters !== sm.parameters) {
        sent.delete(sm.id);
      }
    });
  });

  const prevMasks = prev.masks || [];
  (next.masks || []).forEach((container: MaskContainer) => {
    const prevContainer = prevMasks.find((m: MaskContainer) => m.id === container.id);
    (container.subMasks || []).forEach((sm: any) => {
      const prevSm = prevContainer?.subMasks?.find((p: any) => p.id === sm.id);
      if (!prevSm || prevSm.parameters !== sm.parameters) {
        sent.delete(sm.id);
      }
    });
  });
};

interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

// ---------------------------------------------------------------------------
// G-2（v2.1.22 审计）：AI 效果图（深度/雾度/法线）与蒙版位图以 base64 大字段
// 形式驻留在 Adjustments 中。撤销栈保存 50 份完整快照时，这些几 MB 级的
// 字段被成倍复制，是 Android 端 OOM 的主要来源。
// 处理策略：入栈前剥离大字段（栈内只留结构），恢复时按内容重新注水；
// 活动的 adjustments 状态始终保持完整数据，管线行为不变。
// 效果图对同一张源图是确定性结果，蒙版位图按 subMask.id 索引，撤销/重做
// 语义与全量快照完全一致。
// ---------------------------------------------------------------------------
const HISTORY_EFFECT_MAP_KEYS = ['lensBlurDepthMap', 'fogDepthMap', 'relightNormalMap'] as const;
type HistoryEffectMapKey = (typeof HISTORY_EFFECT_MAP_KEYS)[number];

const effectMapRehydrate: Record<HistoryEffectMapKey, string | null> = {
  lensBlurDepthMap: null,
  fogDepthMap: null,
  relightNormalMap: null,
};
const maskDataRehydrate = new Map<string, string>();

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const captureHeavyFields = (adj: Adjustments): void => {
  HISTORY_EFFECT_MAP_KEYS.forEach((key) => {
    if (isNonEmptyString(adj[key])) effectMapRehydrate[key] = adj[key] as string;
  });
  (adj.masks || []).forEach((container) =>
    (container.subMasks || []).forEach((sm: any) => {
      const b64 = sm?.parameters?.maskDataBase64;
      if (isNonEmptyString(b64) && sm?.id) maskDataRehydrate.set(sm.id, b64);
    })
  );
};

const stripHeavyFields = (adj: Adjustments): Adjustments => {
  const hasEffectMap = HISTORY_EFFECT_MAP_KEYS.some((key) => isNonEmptyString(adj[key]));
  const hasMaskData = (adj.masks || []).some((container) =>
    (container.subMasks || []).some((sm: any) => isNonEmptyString(sm?.parameters?.maskDataBase64))
  );
  if (!hasEffectMap && !hasMaskData) return adj;
  const out: any = { ...adj };
  HISTORY_EFFECT_MAP_KEYS.forEach((key) => {
    out[key] = null;
  });
  if (hasMaskData) {
    out.masks = (adj.masks || []).map((container) => ({
      ...container,
      subMasks: (container.subMasks || []).map((sm: any) => {
        const b64 = sm?.parameters?.maskDataBase64;
        if (isNonEmptyString(b64)) {
          return { ...sm, parameters: { ...sm.parameters, maskDataBase64: null } };
        }
        return sm;
      }),
    }));
  }
  return out;
};

const rehydrateHeavyFields = (adj: Adjustments): Adjustments => {
  let out = adj;
  HISTORY_EFFECT_MAP_KEYS.forEach((key) => {
    if (out[key] == null && effectMapRehydrate[key]) {
      if (out === adj) out = { ...adj };
      out[key] = effectMapRehydrate[key];
    }
  });
  const masks = out.masks;
  if (masks && masks.length) {
    let changed = false;
    const nextMasks = masks.map((container) => {
      let containerChanged = false;
      const subMasks = (container.subMasks || []).map((sm: any) => {
        const p = sm?.parameters;
        if (p && p.maskDataBase64 == null && sm?.id && maskDataRehydrate.has(sm.id)) {
          containerChanged = true;
          return { ...sm, parameters: { ...p, maskDataBase64: maskDataRehydrate.get(sm.id) } };
        }
        return sm;
      });
      if (containerChanged) {
        changed = true;
        return { ...container, subMasks };
      }
      return container;
    });
    if (changed) out = { ...out, masks: nextMasks };
  }
  return out;
};

interface BaseRenderSize extends ImageDimensions {
  containerHeight: number;
  containerWidth: number;
  offsetX: number;
  offsetY: number;
}

interface EditorState {
  // Core Image & Adjustments
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  previewOverride: Adjustments | null;

  // History State
  history: Adjustments[];
  historyIndex: number;

  // Previews & Overlays
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;
  compareView: CompareView;
  splitPosition: number;
  originalPreview: { path: string; url: string | null } | null;
  softProofing: SoftProofingSettings;

  // Analytics
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  zoom: number;
  displaySize: ImageDimensions;
  previewSize: ImageDimensions;
  baseRenderSize: BaseRenderSize;
  originalSize: ImageDimensions;

  // Tools State
  isRotationActive: boolean;
  overlayMode: OverlayMode;
  overlayRotation: number;
  isStraightenActive: boolean;
  isAutoStraightening: boolean;
  isWbPickerActive: boolean;
  isRelightPickerActive: boolean;
  isTargetedAdjustmentActive: boolean;
  activeRelightLightId: string | null;
  activeCenterMarker: CenterMarker | null;
  isGuidedPerspectiveActive: boolean;
  liveRotation: number | null;
  brushSettings: BrushSettings | null;

  // Masks & AI
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  isMaskControlHovered: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  aiDenoiseProgress: Record<string, number>;
  isAIConnectorConnected: boolean;
  hasRenderedFirstFrame: boolean;
  /** v2.1.16 Windows 灰屏自检修复：wgpu 显示看门狗判定显示失效后的会话级
   *  降级标记。为 true 时前端恢复渲染 JPEG 预览（isWgpuActive 视为 false），
   *  重启应用后复位（后端 force_cpu_preview 同步复位）。 */
  wgpuDisplayFailed: boolean;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: any | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Adjustments | null;

  // Actions
  setEditor: (updater: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  pushHistory: (newAdjustments: Adjustments) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: (initialState: Adjustments) => void;
  goToHistoryIndex: (index: number) => void;
  applyRevision: (revision: Adjustments) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedImage: null,
  adjustments: INITIAL_ADJUSTMENTS,
  previewOverride: null,
  history: [INITIAL_ADJUSTMENTS],
  historyIndex: 0,

  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  compareView: 'off',
  splitPosition: 0.5,
  originalPreview: null,
  softProofing: DEFAULT_SOFT_PROOFING,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },

  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  isStraightenActive: false,
  isAutoStraightening: false,
  isWbPickerActive: false,
  isRelightPickerActive: false,
  isTargetedAdjustmentActive: false,
  activeRelightLightId: null,
  activeCenterMarker: null,
  isGuidedPerspectiveActive: false,
  liveRotation: null,

  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 50, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  aiDenoiseProgress: {},
  isMaskControlHovered: false,
  hasRenderedFirstFrame: false,
  wgpuDisplayFailed: false,
  patchesSentToBackend: new Set<string>(),

  setEditor: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),

  pushHistory: (newAdj) =>
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      captureHeavyFields(newAdj);
      // G-2: 大字段不入栈，恢复时由 rehydrateHeavyFields 注水。
      newHistory.push(stripHeavyFields(newAdj));
      if (newHistory.length > 50) newHistory.shift();
      return { history: newHistory, historyIndex: newHistory.length - 1 };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        const restored = rehydrateHeavyFields(state.history[newIndex]);
        syncSentPatchMarkers(state.adjustments, restored, state.patchesSentToBackend);
        return { historyIndex: newIndex, adjustments: restored };
      }
      return state;
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        const restored = rehydrateHeavyFields(state.history[newIndex]);
        syncSentPatchMarkers(state.adjustments, restored, state.patchesSentToBackend);
        return { historyIndex: newIndex, adjustments: restored };
      }
      return state;
    }),

  resetHistory: (initialState) =>
    set({
      history: [stripHeavyFields(captureAndResetHeavy(initialState))],
      historyIndex: 0,
      adjustments: initialState,
    }),

  goToHistoryIndex: (index) =>
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        const restored = rehydrateHeavyFields(state.history[index]);
        syncSentPatchMarkers(state.adjustments, restored, state.patchesSentToBackend);
        return { historyIndex: index, adjustments: restored };
      }
      return state;
    }),

  // Swaps the whole adjustment state for a revision loaded from disk. It goes
  // through the same truncate-and-push path as normal edits, so undo/redo keeps
  // working across the jump without merging stale fields.
  applyRevision: (revision) =>
    set((state) => {
      if (revision === state.adjustments) return state;
      syncSentPatchMarkers(state.adjustments, revision, state.patchesSentToBackend);
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      captureHeavyFields(revision);
      // G-2: 同 pushHistory，栈内剥离大字段；当前 adjustments 保留完整数据。
      newHistory.push(stripHeavyFields(revision));
      if (newHistory.length > 50) newHistory.shift();
      return {
        adjustments: revision,
        history: newHistory,
        historyIndex: newHistory.length - 1,
        showOriginal: false,
        previewOverride: null,
      };
    }),
}));

// G-2: resetHistory 时换图/清空编辑，先清掉上一张图的大字段缓存再记录新
// 快照，避免跨图累积内存，也防止旧图的效果图被注水进新图的状态。
const captureAndResetHeavy = (initialState: Adjustments): Adjustments => {
  maskDataRehydrate.clear();
  effectMapRehydrate.lensBlurDepthMap = null;
  effectMapRehydrate.fogDepthMap = null;
  effectMapRehydrate.relightNormalMap = null;
  captureHeavyFields(initialState);
  return initialState;
};
