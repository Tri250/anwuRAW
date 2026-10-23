import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes } from '../components/ui/AppProperties';
import { Status } from '../components/ui/ExportImportProperties';

export function useFileOperations(
  refreshImageList: () => Promise<void>,
  refreshAllFolderTrees: () => Promise<void>,
  handleImageSelect: (path: string) => void,
  handleBackToLibrary: () => void,
  sortedImageList: any[],
) {
  const { t } = useTranslation();
  const getParentDir = (filePath: string): string => {
    const separator = filePath.includes('/') ? '/' : '\\';
    const lastSeparatorIndex = filePath.lastIndexOf(separator);
    if (lastSeparatorIndex === -1) return '';
    return filePath.substring(0, lastSeparatorIndex);
  };

  const executeDelete = useCallback(
    async (pathsToDelete: Array<string>, options = { includeAssociated: false }) => {
      if (!pathsToDelete || pathsToDelete.length === 0) return;

      const { libraryActivePath, setLibrary } = useLibraryStore.getState();
      const { selectedImage } = useEditorStore.getState();
      const { activeView } = useUIStore.getState(); // <-- Check active view

      // Determine the active path based on the current view
      const activePath = selectedImage && activeView === 'editor' ? selectedImage.path : libraryActivePath;
      let nextImagePath: string | null = null;

      if (activePath) {
        const physicalPath = activePath.split('?vc=')[0];
        const isActiveImageDeleted = pathsToDelete.some((p) => p === activePath || p === physicalPath);

        if (isActiveImageDeleted) {
          const currentIndex = sortedImageList.findIndex((img) => img.path === activePath);
          if (currentIndex !== -1) {
            const nextCandidate = sortedImageList
              .slice(currentIndex + 1)
              .find((img) => !pathsToDelete.includes(img.path));

            if (nextCandidate) {
              nextImagePath = nextCandidate.path;
            } else {
              const prevCandidate = sortedImageList
                .slice(0, currentIndex)
                .reverse()
                .find((img) => !pathsToDelete.includes(img.path));

              if (prevCandidate) {
                nextImagePath = prevCandidate.path;
              }
            }
          }
        } else {
          nextImagePath = activePath;
        }
      }

      try {
        const command = options.includeAssociated ? 'delete_files_with_associated' : 'delete_files_from_disk';
        await invoke(command, { paths: pathsToDelete });
        await refreshImageList();

        // 切图竞态守卫:删除期间(await 窗口)用户可能已切换编辑器选中图或库激活图,
        // 若选中状况已变化,不得用删除前 activePath 的导航决策覆盖用户的新选择
        const endView = useUIStore.getState().activeView;
        const endSelected = useEditorStore.getState().selectedImage;
        const endActivePath =
          endSelected && endView === 'editor' ? endSelected.path : useLibraryStore.getState().libraryActivePath;
        if (endActivePath !== activePath) return;

        if (selectedImage && activeView === 'editor') {
          const physicalPath = selectedImage.path.split('?vc=')[0];
          const isFileBeingEditedDeleted = pathsToDelete.some((p) => p === selectedImage.path || p === physicalPath);

          if (isFileBeingEditedDeleted) {
            if (nextImagePath) {
              handleImageSelect(nextImagePath);
            } else {
              handleBackToLibrary();
            }
          }
        } else {
          if (nextImagePath) {
            setLibrary({ multiSelectedPaths: [nextImagePath], libraryActivePath: nextImagePath });
          } else {
            setLibrary({ multiSelectedPaths: [], libraryActivePath: null });
          }

          if (selectedImage) {
            const physicalPath = selectedImage.path.split('?vc=')[0];
            if (pathsToDelete.some((p) => p === selectedImage.path || p === physicalPath)) {
              useEditorStore.getState().setEditor({ selectedImage: null });
            }
          }
        }
      } catch (err) {
        console.error('Failed to delete files:', err);
        toast.error(i18n.t('toasts.deleteFilesFailed', { error: String(err) }));
      }
    },
    [refreshImageList, handleBackToLibrary, sortedImageList, handleImageSelect],
  );

  const handleDeleteSelected = useCallback(() => {
    const { multiSelectedPaths, imageList } = useLibraryStore.getState();
    const { setUI } = useUIStore.getState();

    const pathsToDelete = multiSelectedPaths;
    if (pathsToDelete.length === 0) {
      return;
    }

    const isSingle = pathsToDelete.length === 1;

    const selectionHasVirtualCopies =
      isSingle &&
      !pathsToDelete[0].includes('?vc=') &&
      imageList.some((image) => image.path.startsWith(`${pathsToDelete[0]}?vc=`));

    let modalTitle = t('library.deleteModal.title');
    let modalMessage = '';
    let confirmText = t('library.deleteModal.delete');

    if (selectionHasVirtualCopies) {
      modalTitle = t('library.deleteModal.titleWithVirtualCopies');
      modalMessage = t('library.deleteModal.messageWithVirtualCopies');
      confirmText = t('library.deleteModal.deleteAll');
    } else if (isSingle) {
      modalMessage = t('library.deleteModal.messageSingle');
      confirmText = t('library.deleteModal.deleteSelectedOnly');
    } else {
      modalMessage = t('library.deleteModal.messagePlural', { count: pathsToDelete.length });
      confirmText = t('library.deleteModal.deleteSelectedOnly');
    }

    setUI({
      confirmModalState: {
        confirmText,
        confirmVariant: 'destructive',
        isOpen: true,
        message: modalMessage,
        onConfirm: () => executeDelete(pathsToDelete, { includeAssociated: false }),
        title: modalTitle,
      },
    });
  }, [executeDelete, t]);

  const handleCreateFolder = useCallback(
    async (folderName: string) => {
      const { folderActionTarget } = useUIStore.getState();

      if (folderName && folderName.trim() !== '' && folderActionTarget) {
        try {
          await invoke(Invokes.CreateFolder, { path: `${folderActionTarget}/${folderName.trim()}` });
          await refreshAllFolderTrees();
        } catch (err) {
          toast.error(i18n.t('toasts.createFolderFailed', { error: String(err) }));
        }
      }
    },
    [refreshAllFolderTrees],
  );

  const handleRenameFolder = useCallback(
    async (newName: string) => {
      const { folderActionTarget } = useUIStore.getState();
      const { rootPaths, currentFolderPath, setLibrary } = useLibraryStore.getState();
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();

      if (newName && newName.trim() !== '' && folderActionTarget) {
        try {
          const oldPath = folderActionTarget;
          const trimmedNewName = newName.trim();

          await invoke(Invokes.RenameFolder, { path: oldPath, newName: trimmedNewName });

          const parentDir = getParentDir(oldPath);
          const separator = oldPath.includes('/') ? '/' : '\\';
          const newPath = parentDir ? `${parentDir}${separator}${trimmedNewName}` : trimmedNewName;

          const newAppSettings = { ...appSettings } as any;
          let settingsChanged = false;

          if (rootPaths.includes(oldPath)) {
            const newRoots = rootPaths.map((r) => (r === oldPath ? newPath : r));
            setLibrary({ rootPaths: newRoots });
            newAppSettings.rootFolders = newRoots;
            settingsChanged = true;
          }
          if (currentFolderPath?.startsWith(oldPath)) {
            const newCurrentPath = currentFolderPath.replace(oldPath, newPath);
            setLibrary({ currentFolderPath: newCurrentPath });
          }

          const currentPins = appSettings?.pinnedFolders || [];
          if (currentPins.includes(oldPath)) {
            const newPins = currentPins
              .map((p: string) => (p === oldPath ? newPath : p))
              .sort((a: string, b: string) => a.localeCompare(b));
            newAppSettings.pinnedFolders = newPins;
            settingsChanged = true;
          }

          if (settingsChanged) {
            handleSettingsChange(newAppSettings);
          }

          await refreshAllFolderTrees();
        } catch (err) {
          toast.error(i18n.t('toasts.renameFolderFailed', { error: String(err) }));
        }
      }
    },
    [refreshAllFolderTrees],
  );

  const handleSaveRename = useCallback(
    async (nameTemplate: string) => {
      const { renameTargetPaths, setUI } = useUIStore.getState();
      const { selectedImage } = useEditorStore.getState();
      const { libraryActivePath, setLibrary } = useLibraryStore.getState();

      if (renameTargetPaths.length > 0 && nameTemplate) {
        try {
          const newPaths: Array<string> = await invoke(Invokes.RenameFiles, {
            nameTemplate,
            paths: renameTargetPaths,
          });

          await refreshImageList();

          if (selectedImage && renameTargetPaths.includes(selectedImage.path)) {
            const oldPathIndex = renameTargetPaths.indexOf(selectedImage.path);
            if (newPaths[oldPathIndex]) {
              handleImageSelect(newPaths[oldPathIndex]);
            } else {
              handleBackToLibrary();
            }
          }

          if (libraryActivePath && renameTargetPaths.includes(libraryActivePath)) {
            const oldPathIndex = renameTargetPaths.indexOf(libraryActivePath);
            if (newPaths[oldPathIndex]) {
              setLibrary({ libraryActivePath: newPaths[oldPathIndex] });
            } else {
              setLibrary({ libraryActivePath: null });
            }
          }

          setLibrary({ multiSelectedPaths: newPaths });
        } catch (err) {
          toast.error(i18n.t('toasts.renameFilesFailed', { error: String(err) }));
        }
      }
      setUI({ renameTargetPaths: [] });
    },
    [refreshImageList, handleImageSelect, handleBackToLibrary],
  );

  const handleRenameFiles = useCallback((paths: Array<string>) => {
    if (paths && paths.length > 0) {
      useUIStore.getState().setUI({ renameTargetPaths: paths, isRenameFileModalOpen: true });
    }
  }, []);

  const startImportFiles = useCallback(async (sourcePaths: string[], destinationFolder: string, settings: any) => {
    if (sourcePaths.length === 0 || !destinationFolder) return;

    try {
      await invoke(Invokes.ImportFiles, { destinationFolder, settings, sourcePaths });
    } catch (err) {
      console.error('Failed to start import:', err);
      useProcessStore
        .getState()
        .setImportState({ status: Status.Error, errorMessage: `Failed to start import: ${err}` });
    }
  }, []);

  const handleStartImport = useCallback(
    async (settings: any) => {
      const { importTargetFolder, importSourcePaths } = useUIStore.getState();
      if (!importTargetFolder) return;
      await startImportFiles(importSourcePaths, importTargetFolder, settings);
    },
    [startImportFiles],
  );

  const handleImportClick = useCallback(
    async (targetPath: string) => {
      const { supportedTypes, osPlatform } = useSettingsStore.getState();
      const { setUI } = useUIStore.getState();
      const isAndroid = osPlatform === 'android';

      try {
        const nonRaw = supportedTypes?.nonRaw || [];
        const raw = supportedTypes?.raw || [];

        const expandExtensions = (exts: string[]) => {
          return Array.from(new Set(exts.flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()])));
        };

        const processedNonRaw = expandExtensions(nonRaw);
        const processedRaw = expandExtensions(raw);
        const allImageExtensions = [...processedNonRaw, ...processedRaw];

        const typeFilters = isAndroid
          ? []
          : [
              { name: t('library.importDialog.allSupported'), extensions: allImageExtensions },
              { name: t('library.importDialog.rawImages'), extensions: processedRaw },
              { name: t('library.importDialog.standardImages'), extensions: processedNonRaw },
              { name: t('library.importDialog.allFiles'), extensions: ['*'] },
            ];

        const selected = await open({
          filters: typeFilters,
          multiple: true,
          title: t('library.importDialog.title'),
        });

        if (Array.isArray(selected) && selected.length > 0) {
          const invalidExtensions = new Set<string>();
          const allowedExtensions = new Set(allImageExtensions.map((e) => e.toLowerCase()));

          const resolvedFiles = await Promise.all(
            selected.map(async (path) => {
              if (isAndroid) {
                try {
                  return await invoke<string>('resolve_android_content_uri_name', { uriStr: path });
                } catch (e) {
                  console.error('Failed to resolve URI:', e);
                  return path;
                }
              }
              return path;
            }),
          );

          const validFiles = selected.filter((originalPath, index) => {
            const resolvedName = resolvedFiles[index];
            const ext = resolvedName.split('.').pop()?.toLowerCase() || 'unknown';

            if (!allowedExtensions.has(ext)) {
              invalidExtensions.add(`.${ext}`);
              return false;
            }
            return true;
          });

          if (invalidExtensions.size > 0) {
            const extList = Array.from(invalidExtensions).join(', ');
            toast.error(i18n.t('toasts.unsupportedFormat', { formats: extList }));
            return;
          }

          if (isAndroid) {
            const DEFAULT_IMPORT_SETTINGS = {
              filenameTemplate: '{original_filename}',
              organizeByDate: false,
              dateFolderFormat: 'YYYY/MM-DD',
              deleteAfterImport: false,
            };
            await startImportFiles(validFiles, targetPath, DEFAULT_IMPORT_SETTINGS);
            return;
          }

          setUI({ importSourcePaths: validFiles, importTargetFolder: targetPath, isImportModalOpen: true });
        }
      } catch (err) {
        console.error('Failed to open file dialog for import:', err);
      }
    },
    [startImportFiles],
  );

  const handlePasteFiles = useCallback(
    async (mode = 'copy') => {
      const { copiedFilePaths, setProcess } = useProcessStore.getState();
      const { currentFolderPath, setLibrary } = useLibraryStore.getState();

      if (copiedFilePaths.length === 0 || !currentFolderPath) return;

      try {
        if (mode === 'copy') {
          await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
        } else {
          await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
          setProcess({ copiedFilePaths: [] });
          setLibrary({ multiSelectedPaths: [] });
          await refreshAllFolderTrees();
        }
        await refreshImageList();
      } catch (err) {
        toast.error(
          i18n.t(mode === 'copy' ? 'toasts.copyFilesFailed' : 'toasts.moveFilesFailed', { error: String(err) }),
        );
      }
    },
    [refreshImageList, refreshAllFolderTrees],
  );

  return {
    executeDelete,
    handleDeleteSelected,
    handleCreateFolder,
    handleRenameFolder,
    handleSaveRename,
    handleRenameFiles,
    handleStartImport,
    startImportFiles,
    handleImportClick,
    handlePasteFiles,
  };
}
