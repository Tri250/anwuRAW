/**
 * W9-I2 文件操作服务层：删除/建夹/重命名/导入/粘贴逻辑自 useFileOperations 下放。
 * 导航依赖（refreshImageList/refreshAllFolderTrees/handleImageSelect/handleBackToLibrary）
 * 与当前排序列表经 appServiceRegistry 读取，无 React 依赖，函数身份模块级稳定。
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'react-toastify';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAppServices } from './appServiceRegistry';
import { Invokes } from '../components/ui/AppProperties';
import { Status } from '../components/ui/ExportImportProperties';

const getParentDir = (filePath: string): string => {
  const separator = filePath.includes('/') ? '/' : '\\';
  const lastSeparatorIndex = filePath.lastIndexOf(separator);
  if (lastSeparatorIndex === -1) return '';
  return filePath.substring(0, lastSeparatorIndex);
};

export async function executeDelete(pathsToDelete: Array<string>, options = { includeAssociated: false }) {
  if (!pathsToDelete || pathsToDelete.length === 0) return;

  const { refreshImageList, handleImageSelect, handleBackToLibrary, getSortedImageList } = getAppServices();
  const { libraryActivePath, setLibrary } = useLibraryStore.getState();
  const { selectedImage } = useEditorStore.getState();
  const { activeView } = useUIStore.getState();
  const sortedImageList = getSortedImageList();

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
    toast.error(`Failed to delete files: ${err}`);
  }
}

export function handleDeleteSelected() {
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

  let modalTitle = 'Confirm Delete';
  let modalMessage = '';
  let confirmText = 'Delete';

  if (selectionHasVirtualCopies) {
    modalTitle = 'Delete Image and All Virtual Copies?';
    modalMessage = `Are you sure you want to permanently delete this image and all of its virtual copies? This action cannot be undone.`;
    confirmText = 'Delete All';
  } else if (isSingle) {
    modalMessage = `Are you sure you want to permanently delete this image? This action cannot be undone. Right-click for more options (e.g., deleting associated files).`;
    confirmText = 'Delete Selected Only';
  } else {
    modalMessage = `Are you sure you want to permanently delete these ${pathsToDelete.length} images? This action cannot be undone. Right-click for more options (e.g., deleting associated files).`;
    confirmText = 'Delete Selected Only';
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
}

export async function handleCreateFolder(folderName: string) {
  const { folderActionTarget } = useUIStore.getState();
  const { refreshAllFolderTrees } = getAppServices();

  if (folderName && folderName.trim() !== '' && folderActionTarget) {
    try {
      await invoke(Invokes.CreateFolder, { path: `${folderActionTarget}/${folderName.trim()}` });
      await refreshAllFolderTrees();
    } catch (err) {
      toast.error(`Failed to create folder: ${err}`);
    }
  }
}

export async function handleRenameFolder(newName: string) {
  const { folderActionTarget } = useUIStore.getState();
  const { rootPaths, currentFolderPath, setLibrary } = useLibraryStore.getState();
  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
  const { refreshAllFolderTrees } = getAppServices();

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
      toast.error(`Failed to rename folder: ${err}`);
    }
  }
}

export async function handleSaveRename(nameTemplate: string) {
  const { renameTargetPaths, setUI } = useUIStore.getState();
  const { selectedImage } = useEditorStore.getState();
  const { libraryActivePath, setLibrary } = useLibraryStore.getState();
  const { refreshImageList, handleImageSelect, handleBackToLibrary } = getAppServices();

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
      toast.error(`Failed to rename files: ${err}`);
    }
  }
  setUI({ renameTargetPaths: [] });
}

export function handleRenameFiles(paths: Array<string>) {
  if (paths && paths.length > 0) {
    useUIStore.getState().setUI({ renameTargetPaths: paths, isRenameFileModalOpen: true });
  }
}

export async function startImportFiles(sourcePaths: string[], destinationFolder: string, settings: any) {
  if (sourcePaths.length === 0 || !destinationFolder) return;

  try {
    await invoke(Invokes.ImportFiles, { destinationFolder, settings, sourcePaths });
  } catch (err) {
    console.error('Failed to start import:', err);
    useProcessStore
      .getState()
      .setImportState({ status: Status.Error, errorMessage: `Failed to start import: ${err}` });
  }
}

export async function handleStartImport(settings: any) {
  const { importTargetFolder, importSourcePaths } = useUIStore.getState();
  if (!importTargetFolder) return;
  await startImportFiles(importSourcePaths, importTargetFolder, settings);
}

export async function handleImportClick(targetPath: string) {
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
          { name: 'All Supported Images', extensions: allImageExtensions },
          { name: 'RAW Images', extensions: processedRaw },
          { name: 'Standard Images (JPEG, PNG, etc.)', extensions: processedNonRaw },
          { name: 'All Files', extensions: ['*'] },
        ];

    const selected = await open({
      filters: typeFilters,
      multiple: true,
      title: 'Select files to import',
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
        toast.error(`Unsupported file format(s) detected: ${extList}`);
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
}

export async function handlePasteFiles(mode = 'copy') {
  const { copiedFilePaths, setProcess } = useProcessStore.getState();
  const { currentFolderPath, setLibrary } = useLibraryStore.getState();
  const { refreshImageList, refreshAllFolderTrees } = getAppServices();

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
    toast.error(`Failed to ${mode} files: ${err}`);
  }
}
