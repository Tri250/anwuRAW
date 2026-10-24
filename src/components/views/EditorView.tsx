import { type RefObject, type PointerEvent as ReactPointerEvent, useRef, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';

import Editor from '../panel/Editor';
import BottomBar from '../panel/BottomBar';
import Resizer from '../ui/Resizer';
import { MobilePanelSwitcher } from '../panel/PanelSwitcher';

import { useEditorStore } from '../../store/useEditorStore';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useProcessStore } from '../../store/useProcessStore';

import { ImageFile, Orientation, Panel, ThumbnailAspectRatio } from '../ui/AppProperties';

interface EditorViewProps {
  transformWrapperRef: RefObject<any>;
  isResizing: boolean;
  isCompactPortrait: boolean;
  isAndroid: boolean;
  compactEditorPanelHeight: number;
  compactEditorPanelCollapsedHeight: number;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  sortedImageList: ImageFile[];
  createResizeHandler: (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => void;
  createResizeResetHandler: (stateKey: string) => () => void;
  handleBackToLibrary: () => void;
  handleEditorContextMenu: (...args: any) => void;
  handleThumbnailContextMenu: (...args: any) => void;
  handleMainLibraryContextMenu?: (...args: any) => void;
  handleImageClick: (...args: any) => void;
  handleClearSelection: () => void;
  handleCopyAdjustments: () => void;
  handlePasteAdjustments: () => void;
  handleRate: (...args: any) => void;
  handleZoomChange: (zoom: number) => void;
  handlePanelSelect: (panelId: any) => void;
  requestThumbnails: any;
  renderAppPanel: (panelId: any) => React.ReactNode;
}

export default function EditorView({
  transformWrapperRef,
  isResizing,
  isCompactPortrait,
  isAndroid,
  compactEditorPanelHeight,
  compactEditorPanelCollapsedHeight,
  thumbnailAspectRatio,
  sortedImageList,
  createResizeHandler,
  createResizeResetHandler,
  handleBackToLibrary,
  handleEditorContextMenu,
  handleThumbnailContextMenu,
  handleMainLibraryContextMenu,
  handleImageClick,
  handleClearSelection,
  handleCopyAdjustments,
  handlePasteAdjustments,
  handleRate,
  handleZoomChange,
  handlePanelSelect,
  requestThumbnails,
  renderAppPanel,
}: EditorViewProps) {
  const { t } = useTranslation();
  const { selectedImage } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
    })),
  );

  const { isFullScreen, isInstantTransition, uiVisibility, bottomPanelHeight, activePanel, setUI } = useUIStore(
    useShallow((state) => ({
      isFullScreen: state.isFullScreen,
      isInstantTransition: state.isInstantTransition,
      uiVisibility: state.uiVisibility,
      bottomPanelHeight: state.bottomPanelHeight,
      activePanel: state.activePanel,
      setUI: state.setUI,
    })),
  );

  const { multiSelectedPaths, imageRatings, isViewLoading } = useLibraryStore(
    useShallow((state) => ({
      multiSelectedPaths: state.multiSelectedPaths,
      imageRatings: state.imageRatings,
      isViewLoading: state.isViewLoading,
    })),
  );

  const { isCopied, isPasted } = useProcessStore(
    useShallow((state) => ({
      isCopied: state.isCopied,
      isPasted: state.isPasted,
    })),
  );

  // === 移动端面板滑动手势：上滑展开、下滑收起 ===
  // 与面板内容区垂直滚动互斥：仅在面板顶部/切换器区域或折叠态时识别滑动
  const touchStartRef = useRef<{ y: number; time: number; panelOpen: boolean } | null>(null);
  const SWIPE_THRESHOLD_PX = 44; // 滑动距离阈值（放宽自 56px：短滑也能可靠呼出）
  const SWIPE_MAX_DURATION_MS = 600; // 滑动最大持续时间（放宽自 400ms：慢滑也有效）

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isCompactPortrait) return;
    const t = e.touches[0];
    touchStartRef.current = {
      y: t.clientY,
      time: Date.now(),
      panelOpen: !!activePanel,
    };
  }, [isCompactPortrait, activePanel]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isCompactPortrait || !touchStartRef.current) return;
    const t = e.touches[0];
    const deltaY = touchStartRef.current.y - t.clientY; // 正值 = 上滑
    const absDelta = Math.abs(deltaY);
    if (absDelta > 12) {
      // 如果面板展开且内容区可滚动，仅在切换器/Resizer 区域（顶部 40px）识别滑动手势
      const isTopZone =
        touchStartRef.current.y <= (e.currentTarget.getBoundingClientRect().top + 40);
      if (touchStartRef.current.panelOpen && !isTopZone) {
        touchStartRef.current = null;
      }
      // 说明：原实现此处调用 e.preventDefault()，但 React 17+ 的 onTouchMove
      // 是 passive 监听，调用无效且报控制台警告；浏览器手势接管已由容器
      // touchAction 分态控制（折叠态 none / 展开态 pan-y），无需 JS 侧处理
    }
  }, [isCompactPortrait]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isCompactPortrait || !touchStartRef.current) return;
    const start = touchStartRef.current;
    const t = e.changedTouches[0];
    const deltaY = start.y - t.clientY; // 正值 = 上滑
    const absDelta = Math.abs(deltaY);
    const duration = Date.now() - start.time;
    touchStartRef.current = null;
    if (duration > SWIPE_MAX_DURATION_MS) return;
    if (absDelta < SWIPE_THRESHOLD_PX) return;
    if (deltaY > 0 && !start.panelOpen) {
      // 上滑且面板折叠 → 展开默认面板（调整）
      handlePanelSelect(Panel.Adjustments);
    } else if (deltaY < 0 && start.panelOpen) {
      // 下滑且面板展开 → 收起
      handlePanelSelect(null);
    }
  }, [isCompactPortrait, handlePanelSelect]);

  const editorNode = (
    <Editor
      onBackToLibrary={handleBackToLibrary}
      onContextMenu={handleEditorContextMenu}
      onImageSelect={handleImageClick}
      transformWrapperRef={transformWrapperRef}
    />
  );

  const editorBottomBarComponent = (
    <BottomBar
      avoidBottomInset={!isCompactPortrait}
      filmstripHeight={bottomPanelHeight}
      imageList={sortedImageList}
      imageRatings={imageRatings}
      isAndroid={isAndroid}
      isCopied={isCopied}
      isCopyDisabled={!selectedImage}
      isFilmstripVisible={uiVisibility.filmstrip}
      isLoading={isViewLoading}
      isPasted={isPasted}
      isPasteDisabled={useEditorStore.getState().copiedAdjustments === null}
      isRatingDisabled={!selectedImage}
      isResizing={isResizing}
      multiSelectedPaths={multiSelectedPaths}
      showQuickFilter={!isCompactPortrait}
      onClearSelection={handleClearSelection}
      onContextMenu={handleThumbnailContextMenu}
      onEmptyAreaContextMenu={handleMainLibraryContextMenu}
      onCopy={handleCopyAdjustments}
      onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
      onImageSelect={handleImageClick}
      onPaste={() => handlePasteAdjustments()}
      onRate={handleRate}
      onRequestThumbnails={requestThumbnails}
      onZoomChange={handleZoomChange}
      rating={imageRatings[selectedImage?.path || ''] || 0}
      selectedImage={selectedImage ?? undefined}
      setIsFilmstripVisible={(value: boolean) =>
        setUI((state) => ({ uiVisibility: { ...state.uiVisibility, filmstrip: value } }))
      }
      showFilmstrip={!isCompactPortrait}
      showZoomControls={!isAndroid}
      thumbnailAspectRatio={thumbnailAspectRatio}
      totalImages={sortedImageList.length}
    />
  );

  const editorBottomBarNode = (
    <div
      className={clsx(
        'flex flex-col w-full overflow-hidden shrink-0',
        !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
      )}
      style={{
        maxHeight: isFullScreen ? '0px' : '500px',
        opacity: isFullScreen ? 0 : 1,
      }}
    >
      {!isCompactPortrait && (
        <Resizer
          direction={Orientation.Horizontal}
          onMouseDown={createResizeHandler('bottom', bottomPanelHeight)}
          onDoubleClick={createResizeResetHandler('bottom')}
        />
      )}
      {editorBottomBarComponent}
    </div>
  );

  const editorMobilePanelNode = isCompactPortrait ? (
    <div
      className={clsx(
        // bottom-inset-safe：面板背景延伸到屏幕最底部，系统导航栏浮于其上，
        // 消除 WebView 被原生 insets 收缩后面板与屏幕底之间的灰带空隙
        'flex overflow-hidden shrink-0 flex-col bg-bg-secondary rounded-lg bottom-inset-safe',
        !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
      )}
      style={{
        // 折叠态高度叠加底部 inset：保证切换器(60px)+底栏(48px)完整不被系统栏裁切；
        // 展开态总高不变，由 border-box 的 padding 从内容区挤出 inset（内容区可滚动，无感）
        height: isFullScreen
          ? 0
          : activePanel
            ? compactEditorPanelHeight
            : `calc(${compactEditorPanelCollapsedHeight}px + var(--android-inset-bottom, 0px))`,
        opacity: isFullScreen ? 0 : 1,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {activePanel && !isFullScreen && (
        <Resizer
          direction={Orientation.Horizontal}
          onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
          onDoubleClick={createResizeResetHandler('compact')}
        />
      )}
      {/* 折叠态时内容区高度压缩为 0，避免 flex-1 展开形成大片白色空白；
          展开态时 flex-1 占据切换器与底栏之间的剩余空间 */}
      <div className={clsx('overflow-hidden relative', activePanel ? 'min-h-0 flex-1' : 'h-0')}>
        <AnimatePresence mode="wait">
          {activePanel && (
            <motion.div
              key={activePanel}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 overflow-y-auto custom-scrollbar"
            >
              {renderAppPanel(activePanel)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* 折叠态拖拽提示条：国内 App 标准交互，提示用户可上滑展开面板；
          整条为可点击按钮，直接打开「调整」面板（呼出最常用路径之一）；
          展开态由 Resizer 替代，提示条隐藏避免重复 */}
      {!activePanel && (
        <button
          type="button"
          onClick={() => handlePanelSelect(Panel.Adjustments)}
          aria-label={t('editor.switcher.swipeHint')}
          className="shrink-0 flex items-center justify-center gap-2 py-2 w-full"
        >
          <span className="text-[10px] leading-none text-text-secondary select-none">
            {t('editor.switcher.swipeHint')}
          </span>
          <div className="w-10 h-1 rounded-full bg-border-color/60" />
        </button>
      )}
      <MobilePanelSwitcher activePanel={activePanel} onPanelSelect={handlePanelSelect} />
      <div className="shrink-0 border-t border-surface">{editorBottomBarComponent}</div>
    </div>
  ) : null;

  return (
    <div className={clsx('flex grow h-full min-h-0', isCompactPortrait ? 'flex-col gap-2' : 'flex-col')}>
      <div className={clsx('flex-1 flex flex-col min-w-0', isCompactPortrait && 'min-h-0')}>{editorNode}</div>
      {isCompactPortrait ? editorMobilePanelNode : editorBottomBarNode}
    </div>
  );
}
