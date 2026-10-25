import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useExportSettings } from '../../src/hooks/useExportSettings';
import {
  DEFAULT_EXPORT_DPI,
  ExportPreset,
  WatermarkAnchor,
} from '../../src/components/ui/ExportImportProperties';

// === TC-EXP-SET-* 系列：导出设置状态、预设回填与设置快照 ===

const FULL_PRESET: ExportPreset = {
  id: 'preset-full',
  name: '完整导出预设',
  fileFormat: 'png',
  jpegQuality: 42,
  enableResize: true,
  resizeMode: 'shortEdge',
  resizeValue: 1600,
  dontEnlarge: false,
  keepMetadata: false,
  preserveTimestamps: true,
  stripGps: false,
  exportMasks: true,
  preserveFolders: true,
  filenameTemplate: '{YYYY}_{original_filename}',
  enableWatermark: true,
  watermarkPath: '/watermarks/logo.png',
  watermarkAnchor: WatermarkAnchor.Center,
  watermarkScale: 25,
  watermarkSpacing: 3,
  watermarkOpacity: 55,
  lastExportPath: '/exports/last',
};

describe('useExportSettings · 默认值与设置快照', () => {
  it('TC-EXP-SET-01 返回全部默认导出设置', () => {
    const { result } = renderHook(() => useExportSettings());

    expect(result.current.fileFormat).toBe('jpeg');
    expect(result.current.jpegQuality).toBe(90);
    expect(result.current.dpi).toBe(DEFAULT_EXPORT_DPI);
    expect(result.current.enableResize).toBe(false);
    expect(result.current.resizeMode).toBe('longEdge');
    expect(result.current.resizeValue).toBe(2048);
    expect(result.current.dontEnlarge).toBe(true);
    expect(result.current.keepMetadata).toBe(true);
    expect(result.current.preserveTimestamps).toBe(false);
    expect(result.current.stripGps).toBe(true);
    expect(result.current.exportMasks).toBe(false);
    expect(result.current.preserveFolders).toBe(false);
    expect(result.current.filenameTemplate).toBe('{original_filename}_edited');
    expect(result.current.enableWatermark).toBe(false);
    expect(result.current.watermarkPath).toBeNull();
    expect(result.current.watermarkAnchor).toBe(WatermarkAnchor.BottomRight);
    expect(result.current.watermarkScale).toBe(10);
    expect(result.current.watermarkSpacing).toBe(5);
    expect(result.current.watermarkOpacity).toBe(75);
    expect(result.current.colorSpace).toBe('srgb');
    expect(result.current.bitDepth).toBe(8);
  });

  it('TC-EXP-SET-02 currentSettingsObject 跟随每个 setter 更新', () => {
    const { result } = renderHook(() => useExportSettings());

    act(() => {
      result.current.setFileFormat('tiff');
      result.current.setJpegQuality(77);
      result.current.setDpi(600);
      result.current.setEnableResize(true);
      result.current.setResizeMode('width');
      result.current.setResizeValue(3200);
      result.current.setDontEnlarge(false);
      result.current.setKeepMetadata(false);
      result.current.setPreserveTimestamps(true);
      result.current.setStripGps(false);
      result.current.setExportMasks(true);
      result.current.setPreserveFolders(true);
      result.current.setFilenameTemplate('{sequence}');
      result.current.setEnableWatermark(true);
      result.current.setWatermarkPath('/wm.png');
      result.current.setWatermarkAnchor(WatermarkAnchor.TopLeft);
      result.current.setWatermarkScale(30);
      result.current.setWatermarkSpacing(8);
      result.current.setWatermarkOpacity(60);
      result.current.setColorSpace('displayP3');
      result.current.setBitDepth(16);
    });

    expect(result.current.currentSettingsObject).toEqual({
      fileFormat: 'tiff',
      jpegQuality: 77,
      dpi: 600,
      enableResize: true,
      resizeMode: 'width',
      resizeValue: 3200,
      dontEnlarge: false,
      keepMetadata: false,
      preserveTimestamps: true,
      stripGps: false,
      exportMasks: true,
      preserveFolders: true,
      filenameTemplate: '{sequence}',
      enableWatermark: true,
      watermarkPath: '/wm.png',
      watermarkAnchor: WatermarkAnchor.TopLeft,
      watermarkScale: 30,
      watermarkSpacing: 8,
      watermarkOpacity: 60,
      colorSpace: 'displayP3',
      bitDepth: 16,
    });
  });
});

describe('useExportSettings · handleApplyPreset', () => {
  it('TC-EXP-SET-03 完整预设回填所有字段', () => {
    const { result } = renderHook(() => useExportSettings());

    act(() => result.current.handleApplyPreset(FULL_PRESET));

    expect(result.current.fileFormat).toBe('png');
    expect(result.current.jpegQuality).toBe(42);
    expect(result.current.enableResize).toBe(true);
    expect(result.current.resizeMode).toBe('shortEdge');
    expect(result.current.resizeValue).toBe(1600);
    expect(result.current.dontEnlarge).toBe(false);
    expect(result.current.keepMetadata).toBe(false);
    expect(result.current.preserveTimestamps).toBe(true);
    expect(result.current.stripGps).toBe(false);
    expect(result.current.exportMasks).toBe(true);
    expect(result.current.preserveFolders).toBe(true);
    expect(result.current.filenameTemplate).toBe('{YYYY}_{original_filename}');
    expect(result.current.enableWatermark).toBe(true);
    expect(result.current.watermarkPath).toBe('/watermarks/logo.png');
    expect(result.current.watermarkAnchor).toBe(WatermarkAnchor.Center);
    expect(result.current.watermarkScale).toBe(25);
    expect(result.current.watermarkSpacing).toBe(3);
    expect(result.current.watermarkOpacity).toBe(55);
    // FULL_PRESET 未声明 dpi/colorSpace/bitDepth（旧版预设），使用确定性回退
    expect(result.current.dpi).toBe(DEFAULT_EXPORT_DPI);
    expect(result.current.colorSpace).toBe('srgb');
    expect(result.current.bitDepth).toBe(8);
  });

  it('TC-EXP-SET-04 旧版预设缺少可选字段时回退到安全默认值', () => {
    const { result } = renderHook(() => useExportSettings());
    const legacyPreset = {
      ...FULL_PRESET,
      enableResize: false,
      preserveTimestamps: undefined,
      exportMasks: undefined,
      preserveFolders: undefined,
      watermarkPath: null,
      watermarkAnchor: WatermarkAnchor.TopRight,
    } as unknown as ExportPreset;

    act(() => result.current.handleApplyPreset(FULL_PRESET));
    act(() => result.current.handleApplyPreset(legacyPreset));

    expect(result.current.preserveTimestamps).toBe(false);
    expect(result.current.exportMasks).toBe(false);
    expect(result.current.preserveFolders).toBe(false);
    expect(result.current.watermarkPath).toBeNull();
    expect(result.current.watermarkAnchor).toBe(WatermarkAnchor.TopRight);
    // 重复应用同一类预设不应叠加/残留旧值
    expect(result.current.watermarkScale).toBe(25);
  });

  it('TC-EXP-SET-05 新字段会覆盖旧值，而缺省字段不会被上一次预设残留污染', () => {
    const { result } = renderHook(() => useExportSettings());

    act(() =>
      result.current.handleApplyPreset({
        ...FULL_PRESET,
        dpi: 1200,
        colorSpace: 'adobeRgb',
        bitDepth: 16,
      } as ExportPreset),
    );
    expect(result.current.dpi).toBe(1200);
    expect(result.current.colorSpace).toBe('adobeRgb');
    expect(result.current.bitDepth).toBe(16);

    act(() =>
      result.current.handleApplyPreset({
        ...FULL_PRESET,
        dpi: undefined,
        colorSpace: undefined,
        bitDepth: undefined,
      } as unknown as ExportPreset),
    );
    expect(result.current.dpi).toBe(DEFAULT_EXPORT_DPI);
    expect(result.current.colorSpace).toBe('srgb');
    expect(result.current.bitDepth).toBe(8);
  });
});
