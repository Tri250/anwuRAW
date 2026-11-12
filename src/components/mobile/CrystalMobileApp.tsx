import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import {
  ChevronLeft,
  Contrast,
  Crop,
  ImageIcon,
  Layers,
  Loader2,
  Redo2,
  RotateCcw,
  Save,
  Sparkles,
  Undo2,
  User,
  Wand2,
  Waves,
} from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { toast } from 'react-toastify';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { Invokes } from '../ui/AppProperties';
import { Status } from '../ui/ExportImportProperties';
import ConfirmModal from '../modals/ConfirmModal';
import { pushExitLayer, removeExitLayer } from '../../utils/androidBackRegistry';
import { calculateCenteredCrop } from '../../utils/cropUtils';
import {
  haptic,
  matchAspectChip,
  summarizeExif,
  useCrystalAdjust,
  useImmersiveCropStore,
  useShowOriginalHold,
} from './crystalShared';
import { debouncedSave, debouncedSetHistory } from '../../hooks/useEditorActions';
import { selectAiModelDownloadStatus } from '../../store/useProcessStore';
import CrystalCategoryPanel from './CrystalCategoryPanel';
import CrystalPreview from './CrystalPreview';
import WatermarkExportPage from './WatermarkExportPage';

export type CrystalCategory = 'presets' | 'portrait' | 'filter' | 'tone' | 'compose' | 'ai' | 'fx';

/** 七大分类（图2/图3）：id + 专属色 token + 图标 */
const CATEGORIES: Array<{ id: CrystalCategory; labelKey: ParseKeys; color: string; icon: typeof Layers }> = [
  { id: 'presets', labelKey: 'crystal.categories.presets', color: 'var(--cx-cat-presets)', icon: Layers },
  { id: 'portrait', labelKey: 'crystal.categories.portrait', color: 'var(--cx-cat-portrait)', icon: User },
  { id: 'filter', labelKey: 'crystal.categories.filter', color: 'var(--cx-cat-filter)', icon: Wand2 },
  { id: 'tone', labelKey: 'crystal.categories.tone', color: 'var(--cx-cat-tone)', icon: Waves },
  { id: 'compose', labelKey: 'crystal.categories.compose', color: 'var(--cx-cat-compose)', icon: Crop },
  { id: 'ai', labelKey: 'crystal.categories.ai', color: 'var(--cx-cat-ai)', icon: Sparkles },
  { id: 'fx', labelKey: 'crystal.categories.fx', color: 'var(--cx-cat-fx)', icon: Contrast },
];

function CrystalTopBar({ camera, onBack, onSave }: { camera: string; onBack: () => void; onSave: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="cx-topbar">
      <button className="cx-icon-btn" onClick={onBack} aria-label={t('crystal.backToLibrary')}>
        <ChevronLeft size={22} />
      </button>
      {/* 审计 UX-4: 撤销/重做仅保留底栏一组（拇指可达），顶栏不再重复 */}
      <div className="cx-topbar-title">
        <div className="cx-title">{t('crystal.title')}</div>
        <div className="cx-subtitle">{camera || t('crystal.subtitleFallback')}</div>
      </div>
      <button className="cx-save-pill" onClick={onSave}>
        {t('crystal.save')}
      </button>
    </div>
  );
}

function CrystalCatNavBar({ active, onSelect }: { active: CrystalCategory; onSelect: (id: CrystalCategory) => void }) {
  const { t } = useTranslation();
  return (
    <div className="cx-catnav">
      {CATEGORIES.map(({ id, labelKey, color, icon: Icon }) => (
        <button
          key={id}
          className={`cx-cat-item ${active === id ? 'is-active' : ''}`}
          style={{ ['--cx-cat-color' as string]: color }}
          onClick={() => {
            haptic(6);
            onSelect(id);
          }}
        >
          <span className="cx-cat-icon">
            <Icon size={20} />
          </span>
          <span className="cx-cat-label">{t(labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

function CrystalBottomBar({
  onExport,
  onReset,
  onCompare,
}: {
  onExport: () => void;
  onReset: () => void;
  onCompare: () => void;
}) {
  const { t } = useTranslation();
  const canUndo = useEditorStore((s) => s.historyIndex > 0);
  const canRedo = useEditorStore((s) => s.historyIndex < s.history.length - 1);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const originalHold = useShowOriginalHold(0);

  return (
    <div className="cx-bottombar">
      {/* 原图：按下即看原图 */}
      <button className="cx-bottom-btn" {...originalHold}>
        <span className="cx-b-icon">
          <ImageIcon size={19} />
        </span>
        {t('crystal.bottom.original')}
      </button>
      <button
        className="cx-bottom-btn"
        onClick={() => {
          haptic(6);
          undo();
        }}
        disabled={!canUndo}
      >
        <span className="cx-b-icon">
          <Undo2 size={19} />
        </span>
        {t('crystal.bottom.undo')}
      </button>
      <button
        className="cx-bottom-btn"
        onClick={() => {
          haptic(6);
          redo();
        }}
        disabled={!canRedo}
      >
        <span className="cx-b-icon">
          <Redo2 size={19} />
        </span>
        {t('crystal.bottom.redo')}
      </button>
      {/* 对比：进入前后对比分割视图，再点退出 */}
      <button
        className="cx-bottom-btn"
        onClick={() => {
          haptic(6);
          onCompare();
        }}
      >
        <span className="cx-b-icon">
          <Contrast size={19} />
        </span>
        {t('crystal.bottom.compare')}
      </button>
      <button
        className="cx-bottom-btn"
        onClick={() => {
          haptic(6);
          onReset();
        }}
      >
        <span className="cx-b-icon">
          <RotateCcw size={19} />
        </span>
        {t('crystal.bottom.reset')}
      </button>
      <button
        className="cx-bottom-btn cx-gold"
        onClick={() => {
          haptic([10, 30, 10]);
          onExport();
        }}
      >
        <span className="cx-b-icon">
          <Save size={19} />
        </span>
        {t('crystal.bottom.save')}
      </button>
    </div>
  );
}

/**
 * 透影 Crystal 移动视图层主壳。
 * 编辑域（黑金）/ 导出域（青绿）双流程；复用全局 ImageProcessingManager
 * 渲染管线与 50 步撤销栈，仅 UI 全新。
 */

/* D-CP-01: 沉浸裁剪浮层比例 chips —— 与构图面板 ASPECT_CHIPS 同值同 key
 * （面板文件不在本次改动范围，枚举镜像；labelKey 复用既有词条，无新增 key）。 */
const IMMERSIVE_ASPECT_CHIPS: Array<{ labelKey: ParseKeys; value: number | null }> = [
  { labelKey: 'crystal.compose.free', value: null },
  { labelKey: 'crystal.compose.ratio11', value: 1 },
  { labelKey: 'crystal.compose.ratio43', value: 4 / 3 },
  { labelKey: 'crystal.compose.ratio32', value: 3 / 2 },
  { labelKey: 'crystal.compose.ratio169', value: 16 / 9 },
  { labelKey: 'crystal.compose.ratio916', value: 9 / 16 },
];

/** 沉浸式裁剪浮层：底部比例 chips + 取消/重置/确认三胶囊（不拦截预览手势） */
function ImmersiveCropOverlay({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const aspectRatio = useEditorStore((s) => s.adjustments.aspectRatio ?? null);
  const { applyPatch } = useCrystalAdjust();

  /* 与构图面板 activeAspect 同源：按用户所选宽比做正/逆双向匹配以高亮 chip。
   * C-1（v2.1.22 审计）：匹配口径与 crystalShared.matchAspectChip 统一——
   * 先精确、再倒数（排除 1:1 自倒数），避免竖构图高亮跳到横构图。 */
  const activeAspect = useMemo(
    () => matchAspectChip(IMMERSIVE_ASPECT_CHIPS, aspectRatio),
    [aspectRatio],
  );

  /* 与构图面板 rotateChip / 桌面 CropPanel.applyAspectRatio 同源：面积保持的居中裁剪。
   * 选「自由」时清空 aspectRatio 与裁剪框（与面板行为一致），随后可单指重新画框。 */
  const applyAspect = useCallback(
    (value: number | null) => {
      const fresh = useEditorStore.getState().adjustments;
      const newCrop =
        value && selectedImage?.width && selectedImage?.height
          ? calculateCenteredCrop(
              selectedImage.width,
              selectedImage.height,
              fresh.orientationSteps || 0,
              value,
              fresh.rotation || 0,
            )
          : null;
      applyPatch({ aspectRatio: value, crop: newCrop }, { enableTools: false });
    },
    [applyPatch, selectedImage],
  );

  /* 重置：仅清除裁剪框（保留比例选择），无框时为 no-op 避免空历史条目 */
  const resetCrop = useCallback(() => {
    if (!useEditorStore.getState().adjustments.crop) return;
    applyPatch({ crop: null }, { enableTools: false });
  }, [applyPatch]);

  return (
    <div className="cx-imm">
      <div className="cx-imm-chips">
        {IMMERSIVE_ASPECT_CHIPS.map(({ labelKey, value }) => (
          <button
            key={labelKey}
            className={`cx-chip ${activeAspect === value ? 'is-active' : ''}`}
            onClick={() => {
              haptic(6);
              applyAspect(value);
            }}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="cx-imm-actions">
        <button
          className="cx-imm-btn"
          onClick={() => {
            haptic(6);
            onCancel();
          }}
        >
          {t('modals.confirm.cancel')}
        </button>
        <button
          className="cx-imm-btn"
          onClick={() => {
            haptic(6);
            resetCrop();
          }}
        >
          {t('crystal.bottom.reset')}
        </button>
        <button
          className="cx-imm-btn cx-imm-btn-primary"
          onClick={() => {
            haptic([8, 20, 8]);
            onConfirm();
          }}
        >
          {t('modals.confirm.confirm')}
        </button>
      </div>
    </div>
  );
}

export default function CrystalMobileApp({ onBackToLibrary }: { onBackToLibrary: () => void }) {
  const { t } = useTranslation();
  const [flow, setFlow] = useState<'edit' | 'export'>('edit');
  const [activeCategory, setActiveCategory] = useState<CrystalCategory>('presets');
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  const selectedImage = useEditorStore((s) => s.selectedImage);
  const resetHistory = useEditorStore((s) => s.resetHistory);
  const setEditor = useEditorStore((s) => s.setEditor);
  const exportState = useProcessStore((s) => s.exportState);
  const isExporting = [Status.Exporting, Status.Cancelling].includes(exportState.status);
  const modelDownloadStatus = useProcessStore(selectAiModelDownloadStatus);
  const osPlatform = useSettingsStore((s) => s.osPlatform);

  const exif = summarizeExif((selectedImage?.exif ?? null) as Record<string, unknown> | null);
  // 副标题：机型（截断）；无 EXIF 时回退画幅
  const cameraSubtitle = exif.camera || (selectedImage?.width ? `${selectedImage.width}×${selectedImage.height}` : '');

  // 审计修复（底栏-对比）：对比分割层依赖 originalPreview，而 originalPreview
  // 仅在 compareView !== 'off' 时由主管线 renderOriginal 产出。此前移动端只翻
  // 本地 isCompareOpen，从未写 compareView → 分割视图永远不渲染（死键）。
  // 现与桌面同源：开启时置 compareView='horizontal' 触发 renderOriginal；
  // 关闭/离开时复位 'off'，由 useImageProcessing 清理 effect 统一释放
  // originalPreview 并调用 ReleaseOriginalPreview，保证链路完整闭环。
  const setCompareOpen = useCallback(
    (open: boolean) => {
      setIsCompareOpen(open);
      setEditor({ compareView: open ? 'horizontal' : 'off' });
    },
    [setEditor],
  );

  // 离开编辑域（切导出/回图库/卸载）时强制退出对比态，防 store 残留。
  // 沉浸裁剪态同理：退出壳层即放弃（不回滚——编辑域已整体离开）。
  useEffect(
    () => () => {
      useEditorStore.getState().setEditor({ compareView: 'off', showOriginal: false, previewOverride: null });
      useImmersiveCropStore.getState().exit();
    },
    [],
  );

  // S-2（v2.1.22 审计）：离开编辑域的统一清理。App.tsx 返回图库时编辑壳只是
  // CSS hidden 并不卸载，仅靠 unmount 清理无法覆盖「回图库」路径——compareView
  // 残留会让主管线在图库界面继续渲染原图预览，重进编辑还带着对比态。
  // 切导出/回图库/卸载三条路径都显式走这里。
  const leaveEditDomain = useCallback(() => {
    useEditorStore.getState().setEditor({ compareView: 'off', showOriginal: false, previewOverride: null });
    useImmersiveCropStore.getState().exit();
  }, []);

  const handleBackToLibrary = useCallback(() => {
    leaveEditDomain();
    onBackToLibrary();
  }, [leaveEditDomain, onBackToLibrary]);

  /* D-CP-01: 沉浸裁剪取消 —— 按进入前快照整体回滚（含 crop/aspectRatio）。
   * 先冲销会话内防抖历史推送，避免回滚值又被补进撤销栈；回滚走 setEditor
   * 直写（不产生新撤销点）。快照标识（所选图路径）不匹配时丢弃回滚。 */
  const cancelImmersive = useCallback(() => {
    const { snapshot, exit } = useImmersiveCropStore.getState();
    exit();
    if (!snapshot) return;
    const sel = useEditorStore.getState().selectedImage;
    if (snapshot.imagePath && sel && sel.path !== snapshot.imagePath) return;
    debouncedSetHistory.cancel();
    useEditorStore.getState().setEditor({ adjustments: snapshot.adjustments });
  }, []);

  /* D-CP-01: 沉浸裁剪确认 —— 裁剪参数已在会话内实时写入（applyPatch →
   * 既有 debounced pushHistory），确认即冲刷撤销点并退出沉浸态。 */
  const confirmImmersive = useCallback(() => {
    debouncedSetHistory.flush();
    useImmersiveCropStore.getState().exit();
  }, []);

  // Android 返回键闭环：对比视图 → 回编辑；导出域 → 回编辑域；编辑域 → 回图库。
  // UX：导出进行中消费返回事件但不切域——进度反馈在导出页内，离开即丢失。
  // G-4（v2.1.22 审计）：handler 逻辑走 ref 读取每次渲染的最新闭包，effect
  // 只注册/注销一次（原实现依赖 9 项含 t/flow/isExporting，任何变化都会
  // remove+push 把本层顶到栈顶，破坏与其他注册层的 LIFO 约定）。
  const backActionRef = useRef<() => void>(() => {});
  backActionRef.current = () => {
    // D-CP-01: 沉浸裁剪激活时为顶层退出层——返回键 = 取消回滚（不跳库、不透传）
    if (useImmersiveCropStore.getState().active) {
      cancelImmersive();
      return;
    }
    // FD-1: 确认弹窗打开时，返回键优先关闭弹窗，而非穿透到流程切换/退出图库
    if (isResetConfirmOpen) {
      setIsResetConfirmOpen(false);
      return;
    }
    if (isCompareOpen) {
      setCompareOpen(false);
      return;
    }
    if (useEditorStore.getState().showOriginal) {
      useEditorStore.getState().setEditor({ showOriginal: false, previewOverride: null });
      return;
    }
    if (flow === 'export') {
      if (isExporting) {
        // FD-7: 导出进行中不静默吞掉返回事件，给出进度提示（复用 CTA 文案键）
        toast.info(t('crystal.export.exporting'));
        return;
      }
      setFlow('edit');
      return;
    }
    handleBackToLibrary();
  };
  useEffect(() => {
    if (osPlatform !== 'android') return;
    const handler = () => backActionRef.current();
    pushExitLayer(handler);
    return () => removeExitLayer(handler);
  }, [osPlatform]);

  // S-1（v2.1.22 审计）：重置=先落盘成功、再动内存态。
  // 旧实现 `.catch(() => {})` 吞错：sidecar 写失败后内存已重置，下次切回
  // 编辑 LoadMetadata 会带回旧参数，用户的重置"悄悄失效"。现与桌面
  // handleResetAdjustments 同序：await invoke，失败 toast 且保持内存态不变；
  // 成功后再重置内存与撤销栈。同时冲销待写入的 sidecar 防抖，避免旧参数
  // 在重置落盘后又追写回 sidecar。
  const handleReset = useCallback(async () => {
    const sel = useEditorStore.getState().selectedImage;
    // 与桌面重置语义一致：恢复初始参数、清 AI patch、重建历史栈，并持久化到 sidecar。
    // 审计修复：先取消待写入的历史推送（500ms 防抖），否则重置后旧参数会被
    // 补推进撤销栈——重置后撤销键可用且"撤销"会复活重置前的编辑。
    debouncedSetHistory.cancel();
    if (!sel) {
      const resetData = { ...INITIAL_ADJUSTMENTS, aiPatches: [] } as Adjustments;
      resetHistory(resetData);
      setEditor({ adjustments: resetData, showOriginal: false, previewOverride: null });
      return;
    }
    debouncedSave.cancel();
    try {
      await invoke(Invokes.ResetAdjustmentsForPaths, { paths: [sel.path] });
    } catch (err) {
      console.error('[crystal] reset sidecar write failed:', err);
      toast.error(t('crystal.resetFailed'));
      return;
    }
    const resetData = { ...INITIAL_ADJUSTMENTS, aiPatches: [] } as Adjustments;
    resetHistory(resetData);
    setEditor({ adjustments: resetData, showOriginal: false, previewOverride: null });
  }, [resetHistory, setEditor, t]);

  const goExport = useCallback(() => {
    setCompareOpen(false);
    leaveEditDomain();
    setFlow('export');
  }, [leaveEditDomain, setCompareOpen]);

  // D-CP-01: 沉浸裁剪激活态（.cx-app 挂 is-fullscreen-crop + 渲染浮层）
  const immersiveActive = useImmersiveCropStore((s) => s.active);

  if (!selectedImage) return null;

  return (
    <div className="crystal-shell" data-flow={flow}>
      {flow === 'edit' ? (
        <div className={`cx-app${immersiveActive ? ' is-fullscreen-crop' : ''}`}>
          <CrystalTopBar camera={cameraSubtitle} onBack={handleBackToLibrary} onSave={goExport} />
          {modelDownloadStatus && (
            <div className="cx-dl-pill" role="status">
              <Loader2 size={11} className="animate-spin" />
              {t('crystal.ai.modelDownloading')} · {modelDownloadStatus}
            </div>
          )}
          <CrystalPreview compare={isCompareOpen} onCompareChange={setCompareOpen} activeCategory={activeCategory} />
          <CrystalCatNavBar active={activeCategory} onSelect={setActiveCategory} />
          <CrystalCategoryPanel category={activeCategory} />
          <CrystalBottomBar
            onExport={goExport}
            onReset={() => setIsResetConfirmOpen(true)}
            onCompare={() => setCompareOpen(!isCompareOpen)}
          />
          {immersiveActive && <ImmersiveCropOverlay onCancel={cancelImmersive} onConfirm={confirmImmersive} />}
          <ConfirmModal
            isOpen={isResetConfirmOpen}
            title={t('crystal.resetConfirm.title')}
            message={t('crystal.resetConfirm.message')}
            confirmVariant="danger"
            onClose={() => setIsResetConfirmOpen(false)}
            onConfirm={handleReset}
          />
        </div>
      ) : (
        <WatermarkExportPage onBackToEdit={() => setFlow('edit')} onBackToLibrary={handleBackToLibrary} />
      )}
    </div>
  );
}
