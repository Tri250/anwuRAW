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
      newHistory.push(newAdj);
      if (newHistory.length > 50) newHistory.shift();
      return { history: newHistory, historyIndex: newHistory.length - 1 };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        syncSentPatchMarkers(state.adjustments, state.history[newIndex], state.patchesSentToBackend);
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        syncSentPatchMarkers(state.adjustments, state.history[newIndex], state.patchesSentToBackend);
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  resetHistory: (initialState) =>
    set({
      history: [initialState],
      historyIndex: 0,
      adjustments: initialState,
    }),

  goToHistoryIndex: (index) =>
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        syncSentPatchMarkers(state.adjustments, state.history[index], state.patchesSentToBackend);
        return { historyIndex: index, adjustments: state.history[index] };
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
      newHistory.push(revision);
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
