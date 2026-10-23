import { useEffect } from 'react';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { Panel } from '../components/ui/AppProperties';

/**
 * 与 App.tsx 中 isCompactPortrait 的 Android 判定保持一致：
 * 竖屏且视口宽 ≤ 600(ANDROID_PHONE_MAX_WIDTH)，或横屏手机(视口高 ≤ 500 / ANDROID_PHONE_MAX_HEIGHT)。
 * 仅在这两种紧凑布局下才存在移动端面板节点(MobilePanelSwitcher + activePanel)。
 */
function isCompactPortraitViewport(): boolean {
  if (typeof window === 'undefined') return false;
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  return vw > 0 && ((vh > vw && vw <= 600) || vh <= 500);
}

/**
 * Android 返回键统一入口（由 MainActivity.onBackPressedDispatcher 调用）。
 *
 * 处理层级（从高到低）：
 * 1. 各类模态弹窗 → 逐个关闭
 * 2. 全屏浮层面板（设置 / 库导出）
 * 3. 移动端紧凑编辑面板（浏览型：调整/元数据/预设/导出等）→ 收起面板
 * 4. 其余编辑态（拉直/蒙版选中/裁剪/全屏）与视图层级 → 派发 Escape 交由快捷键系统逐层退出
 *
 * 返回值：是否消费了本次返回事件。返回 false 表示已无任何可退出的层级
 * （应用主页/社区页），MainActivity 据此 moveTaskToBack 将应用退至后台，
 * 修复此前主页返回键完全无响应的问题。
 */
export function useAndroidBackHandler() {
  useEffect(() => {
    const osPlatform = useSettingsStore.getState().osPlatform;
    if (osPlatform !== 'android') return;

    (window as any).__handleAndroidBack = (): boolean => {
      const ui = useUIStore.getState();

      if (ui.confirmModalState.isOpen) {
        ui.setUI((state: any) => ({ confirmModalState: { ...state.confirmModalState, isOpen: false } }));
        return true;
      }
      if (ui.isCreateFolderModalOpen) {
        ui.setUI({ isCreateFolderModalOpen: false });
        return true;
      }
      if (ui.isRenameFolderModalOpen) {
        ui.setUI({ isRenameFolderModalOpen: false });
        return true;
      }
      if (ui.isRenameFileModalOpen) {
        ui.setUI({ isRenameFileModalOpen: false });
        return true;
      }
      if (ui.isImportModalOpen) {
        ui.setUI({ isImportModalOpen: false });
        return true;
      }
      if (ui.isCopyPasteSettingsModalOpen) {
        ui.setUI({ isCopyPasteSettingsModalOpen: false });
        return true;
      }
      if (ui.isCreateAlbumModalOpen) {
        ui.setUI({ isCreateAlbumModalOpen: false });
        return true;
      }
      if (ui.isCreateAlbumGroupModalOpen) {
        ui.setUI({ isCreateAlbumGroupModalOpen: false });
        return true;
      }
      if (ui.isRenameAlbumModalOpen) {
        ui.setUI({ isRenameAlbumModalOpen: false });
        return true;
      }
      if (ui.panoramaModalState.isOpen) {
        ui.setUI({
          panoramaModalState: {
            isOpen: false,
            isProcessing: false,
            progressMessage: '',
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: [],
          },
        });
        return true;
      }
      if (ui.hdrModalState.isOpen) {
        ui.setUI({
          hdrModalState: {
            isOpen: false,
            isProcessing: false,
            progressMessage: '',
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: [],
          },
        });
        return true;
      }
      if (ui.negativeModalState.isOpen) {
        ui.setUI((state: any) => ({ negativeModalState: { ...state.negativeModalState, isOpen: false } }));
        return true;
      }
      if (ui.denoiseModalState.isOpen) {
        ui.setUI((state: any) => ({ denoiseModalState: { ...state.denoiseModalState, isOpen: false } }));
        return true;
      }
      if (ui.cullingModalState.isOpen) {
        ui.setUI({
          cullingModalState: { isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] },
        });
        return true;
      }
      if (ui.collageModalState.isOpen) {
        ui.setUI({ collageModalState: { isOpen: false, sourceImages: [] } });
        return true;
      }
      if (ui.focusStackModalState.isOpen) {
        ui.setUI({
          focusStackModalState: {
            isOpen: false,
            isProcessing: false,
            progressMessage: '',
            finalImageBase64: null,
            depthMapBase64: null,
            error: null,
            sourcePaths: [],
          },
        });
        return true;
      }

      // 模态弹窗全部关闭后，再依次收起 Android 端全屏浮层面板（设置 / 库导出）
      if (ui.isSettingsOpen) {
        ui.setUI({ isSettingsOpen: false });
        return true;
      }
      if (ui.isLibraryExportPanelVisible) {
        ui.setUI({ isLibraryExportPanelVisible: false });
        return true;
      }

      // 再收起移动端紧凑编辑面板：返回键应先收起浏览型面板，而非直接退出编辑器。
      // 裁剪面板属编辑模式，交由 Escape 兜底切回调整面板（面板保持展开）；
      // 蒙版/AI 面板若存在选中容器（或拉直等编辑态），同样先由 Escape 关闭选中态，面板保持展开。
      const editorState = useEditorStore.getState();
      const hasEscapeSelectionState =
        editorState.isStraightenActive ||
        editorState.isWbPickerActive ||
        editorState.isHslPickerActive ||
        ui.customEscapeHandler ||
        editorState.activeAiSubMaskId ||
        editorState.activeAiPatchContainerId ||
        editorState.activeMaskId ||
        editorState.activeMaskContainerId;
      if (
        ui.activeView === 'editor' &&
        !ui.isFullScreen &&
        !hasEscapeSelectionState &&
        ui.activePanel &&
        ui.activePanel !== Panel.Crop &&
        isCompactPortraitViewport()
      ) {
        ui.setUI({ activePanel: null });
        return true;
      }

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
      );

      // 判定 Escape 是否消费了本次返回（与 useKeyboardShortcuts 的 Escape 分支保持同序）。
      // 全部未命中说明已处于应用主页等无可退出层级，返回 false 让原生侧退至后台。
      const editor = useEditorStore.getState();
      const library = useLibraryStore.getState();
      const isInputFocused =
        document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if (isInputFocused) return true;
      if (
        editor.isStraightenActive ||
        editor.isWbPickerActive ||
        editor.isHslPickerActive ||
        ui.customEscapeHandler
      ) {
        return true;
      }
      if (
        editor.activeAiSubMaskId ||
        editor.activeAiPatchContainerId ||
        editor.activeMaskId ||
        editor.activeMaskContainerId
      ) {
        return true;
      }
      if (ui.activePanel === Panel.Crop) return true;
      if (ui.isFullScreen) return true;
      if (ui.activeView === 'editor') return true;
      if (ui.activeView === 'library' && (library.rootPaths?.length ?? 0) > 0) return true;
      return false;
    };

    return () => {
      delete (window as any).__handleAndroidBack;
    };
  }, []);
}
