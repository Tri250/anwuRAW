import { create } from 'zustand';
import { Progress } from '../components/ui/AppProperties';
import { ExportState, ImportState, Status } from '../components/ui/ExportImportProperties';
import { Adjustments } from '../utils/adjustments';
import * as renderEngine from './renderEngine';

export interface ExternalEditSession {
  source: string;
  output: string;
  format: string;
  jpegQuality: number;
}

/** W9-I1 合成处理状态机：四合成模态共用的单数据流状态。 */
export type ComposeKind = 'panorama' | 'hdr' | 'focusStack' | 'multiExposure';
export type ComposePhase = 'idle' | 'processing' | 'done' | 'error';

export interface ComposeRun {
  kind: ComposeKind;
  phase: ComposePhase;
  message: string | null;
  error: string | null;
}

const COMPOSE_KINDS: ComposeKind[] = ['panorama', 'hdr', 'focusStack', 'multiExposure'];

const idleComposeRun = (kind: ComposeKind): ComposeRun => ({ kind, phase: 'idle', message: null, error: null });

const initialComposeRuns = (): Record<ComposeKind, ComposeRun> =>
  Object.fromEntries(COMPOSE_KINDS.map((k) => [k, idleComposeRun(k)])) as Record<ComposeKind, ComposeRun>;

const initialComposeEpochs = (): Record<ComposeKind, number> =>
  Object.fromEntries(COMPOSE_KINDS.map((k) => [k, 0])) as Record<ComposeKind, number>;

interface ProcessState {
  exportState: ExportState;
  importState: ImportState;
  isIndexing: boolean;
  indexingProgress: Progress;
  thumbnails: Record<string, string>;
  mediumThumbnails: Record<string, string>;
  thumbnailProgress: Progress;
  previews: Record<string, { url: string; thumbKey: string; timestamp: number }>;
  aiModelDownloadStatus: string | null;
  aiModelDownloadError: { model: string; reason: 'offline' | 'failed' } | null;
  copiedFilePaths: Array<string>;
  isCopied: boolean;
  isPasted: boolean;
  initialFileToOpen: string | null;
  externalEditSession: ExternalEditSession | null;
  composeRuns: Record<ComposeKind, ComposeRun>;

  setProcess: (state: Partial<ProcessState> | ((state: ProcessState) => Partial<ProcessState>)) => void;
  setExportState: (updater: Partial<ExportState> | ((state: ExportState) => Partial<ExportState>)) => void;
  setImportState: (updater: Partial<ImportState> | ((state: ImportState) => Partial<ImportState>)) => void;
  setPreview: (path: string, url: string, thumbKey: string) => void;
  clearPreviews: () => void;
  /** W9-I1：登记新一轮合成任务，返回本次任务的 epoch（动作入口调用）。 */
  beginCompose: (kind: ComposeKind, message?: string) => number;
  /** W9-I1：进度事件（事件入口调用）；epoch 传入 null 表示仅 phase 守卫，epoch 不匹配或已落账时丢弃。 */
  trackComposeMessage: (kind: ComposeKind, epoch: number | null, message: string) => void;
  /** W9-I1：任务落账（完成/失败）；epoch 传入 null 表示仅 phase 守卫，epoch 不匹配或非 processing 态时丢弃。 */
  composeSettled: (kind: ComposeKind, epoch: number | null, opts?: { error?: string; finalMessage?: string | null }) => void;
  /** W9-I1：模态关闭时失效当前任务；此后该 kind 的一切旧事件均被丢弃。 */
  resetCompose: (kind: ComposeKind) => void;

  // === W9-I2 渲染链路入口（AR-10：渲染管线仅存在于 store 层，实现见 renderEngine） ===
  /** 应用调整并请求预览渲染（拖拽态走 in-flight 管线） */
  applyAdjustments: (adjustments: Adjustments, dragging?: boolean, targetRes?: number) => void;
  /** 直接执行一次渲染（绕过拖拽管线） */
  executeApplyAdjustments: (adjustments: Adjustments, dragging?: boolean, targetRes?: number) => void;
  /** 未裁剪预览（Crop 面板） */
  generateUncroppedPreview: (adjustments: Adjustments) => void;
  /** HiFi 缩放升档请求（50ms 防抖，仅升分辨率） */
  maybeRequestHiFiZoom: () => void;
  cancelHiFiZoom: () => void;
  /** 编辑器渲染调度：拖拽实时 / 空闲 50ms 落账（含自动保存与多选同步） */
  scheduleEditorRender: (dragging: boolean) => void;
  clearDragIdleTimer: () => void;
}

let exportTimeout: ReturnType<typeof setTimeout>;
let importTimeout: ReturnType<typeof setTimeout>;
let copyTimeout: ReturnType<typeof setTimeout>;
let pasteTimeout: ReturnType<typeof setTimeout>;

/** W9-I1 合成任务 epoch（模块级，跨 store 重建保持单调）。 */
const composeEpochs = initialComposeEpochs();

const MAX_PREVIEW_CACHE_SIZE = 10;

export const useProcessStore = create<ProcessState>((set, get) => ({
  exportState: { errorMessage: '', progress: { current: 0, total: 0 }, status: Status.Idle },
  importState: { errorMessage: '', path: '', progress: { current: 0, total: 0 }, status: Status.Idle },
  isIndexing: false,
  indexingProgress: { current: 0, total: 0 },
  thumbnails: {},
  mediumThumbnails: {},
  thumbnailProgress: { current: 0, total: 0 },
  previews: {},
  aiModelDownloadStatus: null,
  aiModelDownloadError: null,
  copiedFilePaths: [],
  isCopied: false,
  isPasted: false,
  initialFileToOpen: null,
  externalEditSession: null,
  composeRuns: initialComposeRuns(),

  beginCompose: (kind, message) => {
    const epoch = (composeEpochs[kind] += 1);
    set((prev) => ({
      composeRuns: {
        ...prev.composeRuns,
        [kind]: { kind, phase: 'processing', message: message ?? null, error: null },
      },
    }));
    return epoch;
  },

  trackComposeMessage: (kind, epoch, message) => {
    if (epoch !== null && composeEpochs[kind] !== epoch) return;
    set((prev) => {
      const run = prev.composeRuns[kind];
      if (run.phase !== 'processing') return prev;
      return {
        composeRuns: { ...prev.composeRuns, [kind]: { ...run, message } },
      };
    });
  },

  composeSettled: (kind, epoch, opts) => {
    if (epoch !== null && composeEpochs[kind] !== epoch) return;
    set((prev) => {
      const run = prev.composeRuns[kind];
      const erroring = Boolean(opts?.error);
      // processing → done/error；失败态更新（保存重试再失败）允许 error → error，
      // 保存失败覆盖完成态允许 done → error；迟到的完成事件不可逆写 done/error。
      if (run.phase !== 'processing' && !(erroring && (run.phase === 'done' || run.phase === 'error')))
        return prev;
      return {
        composeRuns: {
          ...prev.composeRuns,
          [kind]: {
            ...run,
            phase: opts?.error ? 'error' : 'done',
            error: opts?.error ?? null,
            message: opts?.finalMessage !== undefined ? opts.finalMessage : null,
          },
        },
      };
    });
  },

  resetCompose: (kind) => {
    composeEpochs[kind] += 1;
    set((prev) => ({
      composeRuns: { ...prev.composeRuns, [kind]: idleComposeRun(kind) },
    }));
  },

  // === W9-I2 渲染链路入口（薄委托 renderEngine） ===
  applyAdjustments: (adjustments, dragging = false, targetRes) =>
    renderEngine.applyAdjustments(adjustments, dragging, targetRes),
  executeApplyAdjustments: (adjustments, dragging = false, targetRes) =>
    renderEngine.executeApplyAdjustments(adjustments, dragging, targetRes),
  generateUncroppedPreview: (adjustments) => renderEngine.generateUncroppedPreview(adjustments),
  maybeRequestHiFiZoom: () => renderEngine.maybeRequestHiFiZoom(),
  cancelHiFiZoom: () => renderEngine.cancelHiFiZoom(),
  scheduleEditorRender: (dragging) => renderEngine.scheduleEditorRender(dragging),
  clearDragIdleTimer: () => renderEngine.clearDragIdleTimer(),

  setProcess: (updater) => {
    set((prev) => {
      const nextState = typeof updater === 'function' ? updater(prev) : updater;
      return { ...prev, ...nextState };
    });

    const state = get();
    if (state.isCopied) {
      clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => set({ isCopied: false }), 1000);
    }
    if (state.isPasted) {
      clearTimeout(pasteTimeout);
      pasteTimeout = setTimeout(() => set({ isPasted: false }), 1000);
    }
  },

  setExportState: (updater) => {
    set((prev) => ({
      exportState: { ...prev.exportState, ...(typeof updater === 'function' ? updater(prev.exportState) : updater) },
    }));

    const status = get().exportState.status;

    clearTimeout(exportTimeout);

    if ([Status.Success, Status.Error, Status.Cancelled].includes(status)) {
      exportTimeout = setTimeout(() => {
        set((prev) => ({
          exportState: {
            ...prev.exportState,
            status: Status.Idle,
            errorMessage: '',
            progress: { current: 0, total: 0 },
          },
        }));
      }, 5000);
    }
  },

  setImportState: (updater) => {
    set((prev) => ({
      importState: { ...prev.importState, ...(typeof updater === 'function' ? updater(prev.importState) : updater) },
    }));

    const status = get().importState.status;

    clearTimeout(importTimeout);

    if ([Status.Success, Status.Error, Status.Cancelled].includes(status)) {
      importTimeout = setTimeout(() => {
        set((prev) => ({
          importState: {
            ...prev.importState,
            status: Status.Idle,
            errorMessage: '',
            progress: { current: 0, total: 0 },
          },
        }));
      }, 5000);
    }
  },

  setPreview: (path, url, thumbKey) => {
    set((state) => {
      const newPreviews = { ...state.previews };

      if (newPreviews[path] && newPreviews[path].url !== url) {
        URL.revokeObjectURL(newPreviews[path].url);
      }

      newPreviews[path] = { url, thumbKey, timestamp: Date.now() };

      const keys = Object.keys(newPreviews);
      if (keys.length > MAX_PREVIEW_CACHE_SIZE) {
        let oldestPath = keys[0];
        let oldestTime = newPreviews[oldestPath].timestamp;

        for (let i = 1; i < keys.length; i++) {
          const key = keys[i];
          if (newPreviews[key].timestamp < oldestTime) {
            oldestTime = newPreviews[key].timestamp;
            oldestPath = key;
          }
        }

        if (oldestPath !== path) {
          URL.revokeObjectURL(newPreviews[oldestPath].url);
          delete newPreviews[oldestPath];
        }
      }

      return { previews: newPreviews };
    });
  },

  clearPreviews: () => {
    set((state) => {
      Object.values(state.previews).forEach((p) => URL.revokeObjectURL(p.url));
      return { previews: {} };
    });
  },
}));
