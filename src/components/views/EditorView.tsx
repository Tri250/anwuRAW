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
import { getImageFlag } from '../../utils/imageFlags';

interface EditorViewProps {
  transformWrapperRef: RefObject<any>;
  isResizing: boolean;
  isCompactPortrait: boolean;
  isAndroid: boolean;
  compactEditorPanelHeight: number;
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
  handleToggleFlag: (...args: any) => void;
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
  handleToggleFlag,
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

  // === 移动端面板常驻展开（v1.6.21 反馈「面板不要折叠」） ===
  // 面板容器不存在折叠态：activePanel 意外为 null 时兜底打开「调整」，
  // 上/下滑展开折叠手势、重复点击 tab 折叠、返回键折叠路径均已移除，
  // 底部面板区域始终以 compactEditorPanelHeight 高度渲染当前面板内容
  const effectivePanel = activePanel ?? Panel.Adjustments;

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
      onToggleFlag={handleToggleFlag}
      flag={getImageFlag(sortedImageList, selectedImage?.path)}
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
        // 面板常驻展开：总高固定为 compactEditorPanelHeight，由 border-box 的
        // padding 从内容区挤出底部 inset（内容区可滚动，无感），不再有折叠高度分支
        height: isFullScreen ? 0 : compactEditorPanelHeight,
        opacity: isFullScreen ? 0 : 1,
      }}
    >
      {!isFullScreen && (
        <Resizer
          direction={Orientation.Horizontal}
          onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
          onDoubleClick={createResizeResetHandler('compact')}
        />
      )}
      {/* 内容区占据切换器与底栏之间的全部剩余空间，面板切换走 AnimatePresence 过渡 */}
      <div className="overflow-hidden relative min-h-0 flex-1">
        <AnimatePresence mode="wait">
          {!isFullScreen && (
            <motion.div
              key={effectivePanel}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 overflow-y-auto custom-scrollbar"
            >
              {renderAppPanel(effectivePanel)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <MobilePanelSwitcher activePanel={effectivePanel} onPanelSelect={handlePanelSelect} />
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
