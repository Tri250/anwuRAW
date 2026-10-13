/**
 * W9-I2 导出设置 store：原 useExportSettings 的 20 个 useState 下放为全局状态。
 * 导出设置生命周期与应用一致（面板关闭不再丢失），W9-I5 的 ICC/色深/队列进度扩展点。
 */
import { create } from 'zustand';
import { ExportPreset, WatermarkAnchor } from '../components/ui/ExportImportProperties';

export type ExportColorSpace = 'srgb' | 'displayP3' | 'adobeRgb' | 'proPhoto';

export interface ExportSettings {
  fileFormat: string;
  jpegQuality: number;
  enableResize: boolean;
  resizeMode: string;
  resizeValue: number;
  dontEnlarge: boolean;
  keepMetadata: boolean;
  preserveTimestamps: boolean;
  stripGps: boolean;
  exportMasks: boolean;
  preserveFolders: boolean;
  filenameTemplate: string;
  enableWatermark: boolean;
  watermarkPath: string | null;
  watermarkAnchor: WatermarkAnchor;
  watermarkScale: number;
  watermarkSpacing: number;
  watermarkOpacity: number;
  colorSpace: ExportColorSpace;
  bitDepth: 8 | 16;
}

const INITIAL_EXPORT_SETTINGS: ExportSettings = {
  fileFormat: 'jpeg',
  jpegQuality: 90,
  enableResize: false,
  resizeMode: 'longEdge',
  resizeValue: 2048,
  dontEnlarge: true,
  keepMetadata: true,
  preserveTimestamps: false,
  stripGps: true,
  exportMasks: false,
  preserveFolders: false,
  filenameTemplate: '{original_filename}_edited',
  enableWatermark: false,
  watermarkPath: null,
  watermarkAnchor: WatermarkAnchor.BottomRight,
  watermarkScale: 10,
  watermarkSpacing: 5,
  watermarkOpacity: 75,
  colorSpace: 'srgb',
  bitDepth: 8,
};

interface ExportSettingsState extends ExportSettings {
  updateSettings: (patch: Partial<ExportSettings>) => void;
  applyPreset: (preset: ExportPreset) => void;
}

export const useExportStore = create<ExportSettingsState>((set) => ({
  ...INITIAL_EXPORT_SETTINGS,

  updateSettings: (patch) => set(patch),

  applyPreset: (preset) =>
    set({
      fileFormat: preset.fileFormat,
      jpegQuality: preset.jpegQuality,
      enableResize: preset.enableResize,
      resizeMode: preset.resizeMode,
      resizeValue: preset.resizeValue,
      dontEnlarge: preset.dontEnlarge,
      keepMetadata: preset.keepMetadata,
      preserveTimestamps: preset.preserveTimestamps ?? false,
      stripGps: preset.stripGps,
      exportMasks: preset.exportMasks ?? false,
      preserveFolders: preset.preserveFolders ?? false,
      filenameTemplate: preset.filenameTemplate,
      enableWatermark: preset.enableWatermark,
      watermarkPath: preset.watermarkPath,
      watermarkAnchor: preset.watermarkAnchor as WatermarkAnchor,
      watermarkScale: preset.watermarkScale,
      watermarkSpacing: preset.watermarkSpacing,
      watermarkOpacity: preset.watermarkOpacity,
      colorSpace: ((preset as any).colorSpace ?? 'srgb') as ExportColorSpace,
      bitDepth: ((preset as any).bitDepth ?? 8) as 8 | 16,
    }),
}));

/** 服务层/CLI 参数构造用：取当前导出设置快照 */
export function getExportSettings(): ExportSettings {
  const s = useExportStore.getState();
  const { updateSettings: _u, applyPreset: _a, ...settings } = s;
  return settings;
}
