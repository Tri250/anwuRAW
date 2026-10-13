/**
 * W9-I2 图库操作服务层：评分/色标/标签/EXIF/选择/相册管理逻辑自 useLibraryActions 下放。
 * handleImageSelect 经 appServiceRegistry 读取，无 React 依赖，函数身份模块级稳定。
 */
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { Invokes, ImageFile, AlbumItem, Album, AlbumGroup } from '../components/ui/AppProperties';
import { globalImageCache } from '../utils/ImageLRUCache';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeSortedLibrary } from '../hooks/useSortedLibrary';
import { expandGroupedPaths } from '../utils/imageGrouping';
import { getAppServices } from './appServiceRegistry';

export async function handleRate(newRating: number, paths?: string[]) {
  const { multiSelectedPaths, imageList, imageRatings, setLibrary } = useLibraryStore.getState();
  const { selectedImage } = useEditorStore.getState();

  const selectedPaths =
    paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
  if (selectedPaths.length === 0) return;

  const groupingMode = useSettingsStore.getState().appSettings?.grouping ?? 'off';
  const pathsToRate = expandGroupedPaths(imageList, selectedPaths, groupingMode);

  const currentRating = imageRatings[selectedPaths[0]] || 0;
  const finalRating = newRating === currentRating ? 0 : newRating;

  try {
    await invoke(Invokes.SetRatingForPaths, { paths: pathsToRate, rating: finalRating });
    setLibrary((state) => {
      const newRatings = { ...state.imageRatings };
      pathsToRate.forEach((p) => {
        newRatings[p] = finalRating;
      });
      return { imageRatings: newRatings };
    });
  } catch (err) {
    toast.error(`评分失败: ${err}`);
  }
}

export async function handleSetColorLabel(color: string | null, paths?: string[]) {
  const { multiSelectedPaths, libraryActivePath, imageList, setLibrary } = useLibraryStore.getState();
  const { selectedImage } = useEditorStore.getState();

  const selectedPaths =
    paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
  if (selectedPaths.length === 0) return;

  const groupingMode = useSettingsStore.getState().appSettings?.grouping ?? 'off';
  const pathsToUpdate = expandGroupedPaths(imageList, selectedPaths, groupingMode);

  const primaryPath = selectedImage?.path || libraryActivePath;
  const primaryImage = imageList.find((img: ImageFile) => img.path === primaryPath);
  let currentColor = null;
  if (primaryImage && primaryImage.tags) {
    const colorTag = primaryImage.tags.find((tag: string) => tag.startsWith('color:'));
    if (colorTag) currentColor = colorTag.substring(6);
  }
  const finalColor = color !== null && color === currentColor ? null : color;

  try {
    await invoke(Invokes.SetColorLabelForPaths, { paths: pathsToUpdate, color: finalColor });
    setLibrary((state) => ({
      imageList: state.imageList.map((image: ImageFile) => {
        if (pathsToUpdate.includes(image.path)) {
          const otherTags = (image.tags || []).filter((tag: string) => !tag.startsWith('color:'));
          const newTags = finalColor ? [...otherTags, `color:${finalColor}`] : otherTags;
          return { ...image, tags: newTags };
        }
        return image;
      }),
    }));
  } catch (err) {
    toast.error(`Failed to set color label: ${err}`);
  }
}

export function handleTagsChanged(changedPaths: string[], newTags: { tag: string; isUser: boolean }[]) {
  const { imageList } = useLibraryStore.getState();
  const groupingMode = useSettingsStore.getState().appSettings?.grouping ?? 'off';
  const pathsToUpdate = expandGroupedPaths(imageList, changedPaths, groupingMode);

  useLibraryStore.getState().setLibrary((state) => ({
    imageList: state.imageList.map((image) => {
      if (pathsToUpdate.includes(image.path)) {
        const colorTags = (image.tags || []).filter((t) => t.startsWith('color:'));
        const prefixedNewTags = newTags.map((t) => (t.isUser ? `user:${t.tag}` : t.tag));
        const finalTags = [...colorTags, ...prefixedNewTags].sort();
        return { ...image, tags: finalTags.length > 0 ? finalTags : null };
      }
      return image;
    }),
  }));
}

export async function handleUpdateExif(paths: Array<string> | undefined, updates: Record<string, string>) {
  const { multiSelectedPaths, imageList, setLibrary } = useLibraryStore.getState();
  const { selectedImage, setEditor } = useEditorStore.getState();

  const pathsToUpdate =
    paths && paths.length > 0
      ? paths
      : multiSelectedPaths.length > 0
        ? multiSelectedPaths
        : selectedImage
          ? [selectedImage.path]
          : [];
  if (pathsToUpdate.length === 0) return;

  const physicalPathsSet = new Set(pathsToUpdate.map((p) => p.split('?vc=')[0]));
  const physicalPathsArray = Array.from(physicalPathsSet);

  try {
    await invoke(Invokes.UpdateExifFields, { paths: physicalPathsArray, updates });

    setEditor((state) => {
      if (!state.selectedImage || !physicalPathsSet.has(state.selectedImage.path.split('?vc=')[0])) return state;
      return { selectedImage: { ...state.selectedImage, exif: { ...(state.selectedImage.exif || {}), ...updates } } };
    });

    setLibrary((state) => ({
      imageList: state.imageList.map((img) => {
        if (physicalPathsSet.has(img.path.split('?vc=')[0])) {
          return { ...img, exif: { ...(img.exif || {}), ...updates } };
        }
        return img;
      }),
    }));

    pathsToUpdate.forEach((p) => {
      const cached = globalImageCache.get(p);
      if (cached && cached.selectedImage) {
        globalImageCache.set(p, {
          ...cached,
          selectedImage: { ...cached.selectedImage, exif: { ...(cached.selectedImage.exif || {}), ...updates } },
        });
      }
    });
  } catch (err) {
    toast.error(`Failed to update metadata: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function handleClearSelection() {
  const activeView = useUIStore.getState().activeView;
  const { selectedImage } = useEditorStore.getState();

  if (activeView === 'editor' && selectedImage) {
    useLibraryStore.getState().setLibrary({
      multiSelectedPaths: [selectedImage.path],
      libraryActivePath: selectedImage.path,
      selectionAnchorPath: selectedImage.path,
    });
  } else {
    useLibraryStore.getState().setLibrary({
      multiSelectedPaths: [],
      libraryActivePath: null,
      selectionAnchorPath: null,
    });

    useEditorStore.getState().setEditor({
      selectedImage: null,
      finalPreviewUrl: null,
      uncroppedAdjustedPreviewUrl: null,
      histogram: null,
      waveform: null,
      activeMaskId: null,
      activeMaskContainerId: null,
      activeAiPatchContainerId: null,
      activeAiSubMaskId: null,
      isWbPickerActive: false,
    });
  }
}

export function handleMultiSelectClick(
  path: string,
  event: any,
  options: {
    onSimpleClick(p: string, isAlreadySelected: boolean): void;
    updateLibraryActivePath: boolean;
    shiftAnchor: string | null;
  },
) {
  const libraryState = useLibraryStore.getState();
  const { multiSelectedPaths, setLibrary } = libraryState;
  const { ctrlKey, metaKey, shiftKey } = event;
  const isCtrlPressed = ctrlKey || metaKey;
  const { shiftAnchor, onSimpleClick, updateLibraryActivePath } = options;

  const isAlreadySelected = multiSelectedPaths.includes(path);

  if (shiftKey && shiftAnchor) {
    const sortedImageList = computeSortedLibrary(libraryState, useSettingsStore.getState());
    const anchorIndex = sortedImageList.findIndex((f) => f.path === shiftAnchor);
    const currentIndex = sortedImageList.findIndex((f) => f.path === path);

    if (anchorIndex !== -1 && currentIndex !== -1) {
      const start = Math.min(anchorIndex, currentIndex);
      const end = Math.max(anchorIndex, currentIndex);
      const range = sortedImageList.slice(start, end + 1).map((f) => f.path);
      const baseSelection = isCtrlPressed ? multiSelectedPaths : [];
      const newSelection = Array.from(new Set([...baseSelection, ...range]));

      setLibrary({ multiSelectedPaths: newSelection, selectionAnchorPath: path });
      if (updateLibraryActivePath) setLibrary({ libraryActivePath: path });
    }
  } else if (isCtrlPressed) {
    const newSelection = new Set(multiSelectedPaths);
    if (newSelection.has(path)) newSelection.delete(path);
    else newSelection.add(path);

    const newSelectionArray = Array.from(newSelection);
    setLibrary({ multiSelectedPaths: newSelectionArray, selectionAnchorPath: path });

    if (updateLibraryActivePath) {
      if (newSelectionArray.includes(path)) setLibrary({ libraryActivePath: path });
      else if (newSelectionArray.length > 0)
        setLibrary({ libraryActivePath: newSelectionArray[newSelectionArray.length - 1] });
      else setLibrary({ libraryActivePath: null });
    }
  } else {
    onSimpleClick(path, isAlreadySelected);
  }
}

export function handleLibraryImageSingleClick(path: string, event: any) {
  const { selectionAnchorPath, libraryActivePath, setLibrary } = useLibraryStore.getState();
  const { handleImageSelect } = getAppServices();
  handleMultiSelectClick(path, event, {
    shiftAnchor: selectionAnchorPath ?? libraryActivePath,
    updateLibraryActivePath: true,
    onSimpleClick: (p: string, isAlreadySelected: boolean) => {
      if (isAlreadySelected) {
        setLibrary({ libraryActivePath: p, selectionAnchorPath: p });
      } else {
        setLibrary({ multiSelectedPaths: [p], libraryActivePath: p, selectionAnchorPath: p });
      }
      if (handleImageSelect) {
        handleImageSelect(p, false);
      }
    },
  });
}

export function handleImageClick(path: string, event: any) {
  const { selectionAnchorPath, libraryActivePath, setLibrary } = useLibraryStore.getState();
  const { selectedImage } = useEditorStore.getState();
  const inEditor = !!selectedImage;
  const { handleImageSelect } = getAppServices();

  handleMultiSelectClick(path, event, {
    shiftAnchor: selectionAnchorPath ?? (inEditor ? selectedImage.path : libraryActivePath),
    updateLibraryActivePath: !inEditor,
    onSimpleClick: (p: string, isAlreadySelected: boolean) => {
      if (!isAlreadySelected) {
        setLibrary({ multiSelectedPaths: [p] });
      }
      if (handleImageSelect) handleImageSelect(p);
      setLibrary({ selectionAnchorPath: p });
    },
  });
}

export async function refreshAllFolderTrees() {
  const { rootPaths, expandedFolders, setLibrary } = useLibraryStore.getState();
  const { appSettings } = useSettingsStore.getState();

  const showImageCounts = appSettings?.enableFolderImageCounts ?? false;
  const pinnedFolders = appSettings?.pinnedFolders || [];
  const expandedArray = Array.from(expandedFolders);

  try {
    const updates: any = {};

    if (rootPaths && rootPaths.length > 0) {
      const treesData = await invoke(Invokes.GetPinnedFolderTrees, {
        paths: rootPaths,
        expandedFolders: expandedArray,
        showImageCounts,
      });
      updates.folderTrees = treesData;
    } else {
      updates.folderTrees = [];
    }

    if (pinnedFolders && pinnedFolders.length > 0) {
      const pinnedTreesData = await invoke(Invokes.GetPinnedFolderTrees, {
        paths: pinnedFolders,
        expandedFolders: expandedArray,
        showImageCounts,
      });
      updates.pinnedFolderTrees = pinnedTreesData;
    } else {
      updates.pinnedFolderTrees = [];
    }

    if (Object.keys(updates).length > 0) {
      setLibrary(updates);
    }
  } catch (err) {
    console.error('Failed to refresh folder trees:', err);
  }
}

export async function handleTogglePinFolder(path: string) {
  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
  const { expandedFolders, setLibrary } = useLibraryStore.getState();
  if (!appSettings) return;

  const currentPins = appSettings.pinnedFolders || [];
  const isPinned = currentPins.includes(path);
  const newPins = isPinned
    ? currentPins.filter((p: string) => p !== path)
    : [...currentPins, path].sort((a, b) => a.localeCompare(b));

  handleSettingsChange({ ...appSettings, pinnedFolders: newPins });

  try {
    const trees = (await invoke(Invokes.GetPinnedFolderTrees, {
      paths: newPins,
      expandedFolders: Array.from(expandedFolders),
      showImageCounts: appSettings.enableFolderImageCounts ?? false,
    })) as any[];
    setLibrary({ pinnedFolderTrees: trees });
  } catch (err) {
    toast.error(`Failed to refresh pinned folders: ${err}`);
  }
}

export async function handleCreateAlbumItem(name: string, type: 'album' | 'group') {
  const { albumTree, setLibrary } = useLibraryStore.getState();
  const { albumActionTarget } = useUIStore.getState();

  const newTree = structuredClone(albumTree);
  const newItem: AlbumItem =
    type === 'album'
      ? ({ type: 'album', id: crypto.randomUUID(), name, images: [] } as Album)
      : ({ type: 'group', id: crypto.randomUUID(), name, children: [] } as AlbumGroup);

  let actualTarget = albumActionTarget;

  const findNode = (nodes: AlbumItem[], id: string): AlbumItem | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.type === 'group') {
        const found = findNode((n as AlbumGroup).children, id);
        if (found) return found;
      }
    }
    return undefined;
  };

  const findParentId = (nodes: AlbumItem[], childId: string, parentId: string | null): string | null | undefined => {
    for (const n of nodes) {
      if (n.id === childId) return parentId;
      if (n.type === 'group') {
        const found = findParentId((n as AlbumGroup).children, childId, n.id);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  if (actualTarget) {
    const targetNode = findNode(newTree, actualTarget);
    if (targetNode && targetNode.type === 'album') {
      const pId = findParentId(newTree, actualTarget, null);
      actualTarget = pId === undefined ? null : pId;
    }
  }

  const insert = (nodes: AlbumItem[], target: string | null): boolean => {
    if (!target) {
      nodes.push(newItem);
      return true;
    }
    for (const n of nodes) {
      if (n.id === target && n.type === 'group') {
        (n as AlbumGroup).children.push(newItem);
        return true;
      } else if (n.type === 'group') {
        if (insert((n as AlbumGroup).children, target)) return true;
      }
    }
    return false;
  };

  if (insert(newTree, actualTarget)) {
    try {
      await invoke(Invokes.SaveAlbums, { tree: newTree });
      const sortedTree = await invoke(Invokes.GetAlbums);
      setLibrary({ albumTree: sortedTree as AlbumItem[] });
    } catch (err) {
      toast.error(`Failed to create: ${err}`);
    }
  }
}

export async function handleRenameAlbumItem(newName: string) {
  const { albumTree, setLibrary } = useLibraryStore.getState();
  const { albumActionTarget } = useUIStore.getState();
  if (!albumActionTarget) return;

  const newTree = structuredClone(albumTree);

  const rename = (nodes: AlbumItem[]) => {
    for (const n of nodes) {
      if (n.id === albumActionTarget) {
        n.name = newName;
        return true;
      }
      if (n.type === 'group' && rename((n as AlbumGroup).children)) return true;
    }
    return false;
  };

  if (rename(newTree)) {
    try {
      await invoke(Invokes.SaveAlbums, { tree: newTree });
      const sortedTree = await invoke(Invokes.GetAlbums);
      setLibrary({ albumTree: sortedTree as AlbumItem[] });
    } catch (err) {
      toast.error(`Failed to rename: ${err}`);
    }
  }
}
