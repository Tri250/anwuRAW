/**
 * W9-I2 瘦身后的纯绑定层：预设状态与 CRUD 在 store/usePresetStore.ts。
 * 本 hook 仅做多面板共享订阅与首载触发。
 */
import { useEffect } from 'react';
import { usePresetStore } from '../store/usePresetStore';

export { PresetListType } from '../store/usePresetStore';
export type { PresetImportFailure, PresetImportResult, UserPreset } from '../store/usePresetStore';

export function usePresets() {
  const presets = usePresetStore((state) => state.presets);
  const isLoading = usePresetStore((state) => state.isLoading);

  useEffect(() => {
    usePresetStore.getState().ensureLoaded();
  }, []);

  const {
    addPreset,
    addFolder,
    configurePreset,
    deleteItem,
    duplicatePreset,
    exportPresetsToFile,
    importPresetsFromFile,
    importPresetsFromFiles,
    importLegacyPresetsFromFile,
    movePreset,
    overwritePreset,
    loadPresets,
    toggleFavorite,
    renameItem,
    reorderItems,
    sortAllPresetsAlphabetically,
  } = usePresetStore.getState();

  return {
    addPreset,
    addFolder,
    configurePreset,
    deleteItem,
    duplicatePreset,
    exportPresetsToFile,
    importPresetsFromFile,
    importPresetsFromFiles,
    importLegacyPresetsFromFile,
    isLoading,
    movePreset,
    overwritePreset,
    presets,
    refreshPresets: loadPresets,
    toggleFavorite,
    renameItem,
    reorderItems,
    sortAllPresetsAlphabetically,
  };
}
