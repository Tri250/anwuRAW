import { type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
    >
      {activePanel && !isFullScreen && (
        <Resizer
          direction={Orientation.Horizontal}
          onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
          onDoubleClick={createResizeResetHandler('compact')}
        />
      )}
      <div className="min-h-0 flex-1 overflow-hidden relative">
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
