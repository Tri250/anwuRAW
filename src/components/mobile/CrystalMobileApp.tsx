import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import {
  ChevronLeft,
  Contrast,
  Crop,
  ImageIcon,
  Layers,
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
import { useShallow } from 'zustand/react/shallow';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { Invokes } from '../ui/AppProperties';
import { Status } from '../ui/ExportImportProperties';
import ConfirmModal from '../modals/ConfirmModal';
import { pushExitLayer, removeExitLayer } from '../../utils/androidBackRegistry';
import { CRYSTAL_LONG_PRESS_MS, summarizeExif, useShowOriginalHold } from './crystalShared';
import CrystalCategoryPanel from './CrystalCategoryPanel';
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

const LONG_PRESS_MS = CRYSTAL_LONG_PRESS_MS;

function CrystalTopBar({
  camera,
  onBack,
  onSave,
}: {
  camera: string;
  onBack: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const canUndo = useEditorStore((s) => s.historyIndex > 0);
  const canRedo = useEditorStore((s) => s.historyIndex < s.history.length - 1);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  return (
    <div className="cx-topbar">
      <button className="cx-icon-btn" onClick={onBack} aria-label={t('crystal.backToLibrary')}>
        <ChevronLeft size={22} />
      </button>
      <button className="cx-icon-btn" onClick={undo} disabled={!canUndo} aria-label={t('crystal.undo')}>
        <Undo2 size={19} />
      </button>
      <button className="cx-icon-btn" onClick={redo} disabled={!canRedo} aria-label={t('crystal.redo')}>
        <Redo2 size={19} />
      </button>
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

function CrystalPreview() {
  const { t } = useTranslation();
  const { finalPreviewUrl, originalPreview, showOriginal, hasRenderedFirstFrame } = useEditorStore(
    useShallow((s) => ({
      finalPreviewUrl: s.finalPreviewUrl,
      originalPreview: s.originalPreview,
      showOriginal: s.showOriginal,
      hasRenderedFirstFrame: s.hasRenderedFirstFrame,
    })),
  );
  const url = showOriginal ? (originalPreview?.url ?? null) : finalPreviewUrl;
  // G11 预览区左下「原图｜对比」浮层：与底栏同手势、同渲染路径。
  const originalHold = useShowOriginalHold(0);
  const compareHold = useShowOriginalHold(LONG_PRESS_MS / 2);

  return (
    <div className="cx-preview">
      {url ? (
        <img className="cx-preview-img" src={url} alt={t('crystal.previewAlt')} draggable={false} />
      ) : (
        <div className="cx-preview-empty">{hasRenderedFirstFrame ? t('crystal.previewRendering') : ''}</div>
      )}
      <div className="cx-float-pills">
        <button className="cx-float-pill" {...originalHold}>
          {t('crystal.bottom.original')}
        </button>
        <button className="cx-float-pill" {...compareHold}>
          {t('crystal.bottom.compare')}
        </button>
      </div>
      {showOriginal && <div className="cx-preview-corner">{t('crystal.originalBadge')}</div>}
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
          onClick={() => onSelect(id)}
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
}: {
  onExport: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const canUndo = useEditorStore((s) => s.historyIndex > 0);
  const canRedo = useEditorStore((s) => s.historyIndex < s.history.length - 1);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const originalHold = useShowOriginalHold(0);
  const compareHold = useShowOriginalHold(LONG_PRESS_MS / 2);

  return (
    <div className="cx-bottombar">
      {/* 原图：按下即看原图 */}
      <button className="cx-bottom-btn" {...originalHold}>
        <span className="cx-b-icon">
          <ImageIcon size={19} />
        </span>
        {t('crystal.bottom.original')}
      </button>
      <button className="cx-bottom-btn" onClick={undo} disabled={!canUndo}>
        <span className="cx-b-icon">
          <Undo2 size={19} />
        </span>
        {t('crystal.bottom.undo')}
      </button>
      <button className="cx-bottom-btn" onClick={redo} disabled={!canRedo}>
        <span className="cx-b-icon">
          <Redo2 size={19} />
        </span>
        {t('crystal.bottom.redo')}
      </button>
      {/* 对比：按住看原图，松开恢复 */}
      <button className="cx-bottom-btn" {...compareHold}>
        <span className="cx-b-icon">
          <Contrast size={19} />
        </span>
        {t('crystal.bottom.compare')}
      </button>
      <button className="cx-bottom-btn" onClick={onReset}>
        <span className="cx-b-icon">
          <RotateCcw size={19} />
        </span>
        {t('crystal.bottom.reset')}
      </button>
      <button className="cx-bottom-btn cx-gold" onClick={onExport}>
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
export default function CrystalMobileApp({ onBackToLibrary }: { onBackToLibrary: () => void }) {
  const { t } = useTranslation();
  const [flow, setFlow] = useState<'edit' | 'export'>('edit');
  const [activeCategory, setActiveCategory] = useState<CrystalCategory>('presets');
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  const selectedImage = useEditorStore((s) => s.selectedImage);
  const resetHistory = useEditorStore((s) => s.resetHistory);
  const setEditor = useEditorStore((s) => s.setEditor);
  const exportState = useProcessStore((s) => s.exportState);
  const isExporting = [Status.Exporting, Status.Cancelling].includes(exportState.status);
  const osPlatform = useSettingsStore((s) => s.osPlatform);

  const exif = summarizeExif((selectedImage?.exif ?? null) as Record<string, unknown> | null);
  // 副标题：机型（截断）；无 EXIF 时回退画幅
  const cameraSubtitle = exif.camera || (selectedImage?.width ? `${selectedImage.width}×${selectedImage.height}` : '');

  // Android 返回键闭环：导出域 → 回编辑域；编辑域 → 回图库。
  useEffect(() => {
    if (osPlatform !== 'android') return;
    const handler = () => {
      if (useEditorStore.getState().showOriginal) {
        useEditorStore.getState().setEditor({ showOriginal: false });
        return;
      }
      if (flow === 'export') {
        setFlow('edit');
        return;
      }
      onBackToLibrary();
    };
    pushExitLayer(handler);
    return () => removeExitLayer(handler);
  }, [flow, onBackToLibrary, osPlatform]);

  const handleReset = useCallback(() => {
    const sel = useEditorStore.getState().selectedImage;
    // 与桌面重置语义一致：恢复初始参数、清 AI patch、重建历史栈，并持久化到 sidecar。
    const resetData = { ...INITIAL_ADJUSTMENTS, aiPatches: [] } as Adjustments;
    resetHistory(resetData);
    setEditor({ adjustments: resetData, showOriginal: false, previewOverride: null });
    if (sel) {
      invoke(Invokes.ResetAdjustmentsForPaths, { paths: [sel.path] }).catch(() => {});
    }
  }, [resetHistory, setEditor]);

  if (!selectedImage) return null;

  return (
    <div className="crystal-shell" data-flow={flow}>
      {flow === 'edit' ? (
        <div className="cx-app">
          <CrystalTopBar
            camera={cameraSubtitle}
            onBack={onBackToLibrary}
            onSave={() => setFlow('export')}
          />
          <CrystalPreview />
          <CrystalCatNavBar active={activeCategory} onSelect={setActiveCategory} />
          <CrystalCategoryPanel category={activeCategory} />
          <CrystalBottomBar onExport={() => setFlow('export')} onReset={() => setIsResetConfirmOpen(true)} />
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
        <WatermarkExportPage onBackToEdit={() => setFlow('edit')} onBackToLibrary={onBackToLibrary} isExporting={isExporting} />
      )}
    </div>
  );
}
