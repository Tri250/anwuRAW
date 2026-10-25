import React, { useCallback, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ExportPanel from '../../src/components/panel/right/ExportPanel';
import {
  AppSettings,
  Panel,
  SelectedImage,
  Theme,
} from '../../src/components/ui/AppProperties';
import {
  ExportPreset,
  ExportState,
  Status,
  WatermarkAnchor,
} from '../../src/components/ui/ExportImportProperties';
import { INITIAL_ADJUSTMENTS } from '../../src/utils/adjustments';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useUIStore } from '../../src/store/useUIStore';
import { mockInvoke, mockOpenDialog, mockPlatform, mockSaveDialog } from './setup';

// === TC-EXP-PANEL-* 系列：导出面板全部子功能 ===

type ExportPresetWithExtras = ExportPreset & {
  dpi?: number;
  colorSpace?: 'srgb' | 'displayP3' | 'adobeRgb' | 'proPhoto';
  bitDepth?: 8 | 16;
};

type BaseProps = Omit<React.ComponentProps<typeof ExportPanel>, 'exportState' | 'setExportState'>;

const IMAGE: SelectedImage = {
  path: '/photos/photo.jpg',
  width: 4000,
  height: 3000,
  isRaw: false,
  isReady: true,
  thumbnailUrl: '',
  exif: {},
};

const SECOND_IMAGE: SelectedImage = {
  ...IMAGE,
  path: '/photos/second.png',
  width: 2000,
  height: 2000,
};

const makePreset = (overrides: Partial<ExportPresetWithExtras> = {}): ExportPresetWithExtras => ({
  id: 'preset-a',
  name: '导出预设 A',
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
  ...overrides,
});

const makeSettings = (presets: ExportPreset[] = []): AppSettings =>
  ({ theme: Theme.Dark, lastRootPath: null, exportPresets: presets }) as AppSettings;

const idleState = (overrides: Partial<ExportState> = {}): ExportState => ({
  status: Status.Idle,
  errorMessage: '',
  progress: { current: 0, total: 0 },
  ...overrides,
});

function StatefulPanel({
  initialState,
  ...props
}: BaseProps & { initialState: ExportState }) {
  const [exportState, setExportState] = useState<ExportState>(initialState);
  // 与 useProcessStore.setExportState 一致：部分状态更新与函数更新都按字段合并
  const updateExportState = useCallback(
    (updater: Partial<ExportState> | ((state: ExportState) => Partial<ExportState>)) => {
      setExportState((prev) => ({
        ...prev,
        ...(typeof updater === 'function' ? updater(prev) : updater),
      }));
    },
    [],
  );
  return <ExportPanel {...props} exportState={exportState} setExportState={updateExportState} />;
}

const buildProps = (overrides: Partial<BaseProps> = {}): BaseProps => {
  const onSettingsChange = vi.fn();
  return {
    multiSelectedPaths: [],
    selectedImage: IMAGE,
    appSettings: makeSettings(),
    onSettingsChange,
    rootPaths: ['/photos'],
    isVisible: true,
    ...overrides,
  } as BaseProps;
};

const renderPanel = (overrides: Partial<BaseProps> = {}, state: Partial<ExportState> = {}) => {
  const props = buildProps(overrides);
  const setExportState = vi.fn();
  const view = render(
    <ExportPanel {...props} exportState={idleState(state)} setExportState={setExportState} />,
  );
  return { ...view, props, setExportState, onSettingsChange: props.onSettingsChange };
};

const renderStateful = (overrides: Partial<BaseProps> = {}, state: Partial<ExportState> = {}) => {
  const props = buildProps(overrides);
  const view = render(<StatefulPanel {...props} initialState={idleState(state)} />);
  return { ...view, props };
};

const mainButton = () => document.querySelector('button.h-11') as HTMLButtonElement;
const formatButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const dropdownByLabel = (label: string) =>
  screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement;
const sliderRow = (label: string) => {
  const labelEl = screen.getByText(label, { selector: 'span' });
  const row = labelEl.closest('.slider-row');
  if (!row) throw new Error(`slider row not found: ${label}`);
  return row as HTMLElement;
};
const sliderInput = (label: string) =>
  sliderRow(label).querySelector('input[type="range"]') as HTMLInputElement;
const sliderValue = (label: string) =>
  sliderRow(label).querySelector('.slider-value-display')?.textContent;
const changeSlider = (label: string, value: number) =>
  fireEvent.change(sliderInput(label), { target: { value: String(value) } });
const sectionByTitle = (title: string) => {
  const heading = screen.getByText(title, { selector: 'h3' });
  return heading.parentElement as HTMLElement;
};
const fileNamingInput = () =>
  sectionByTitle('文件命名').querySelector('input') as HTMLInputElement;

const selectDropdown = async (trigger: HTMLElement, optionLabel: string) => {
  fireEvent.click(trigger);
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: optionLabel }));
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
};

const openAdvanced = () => {
  fireEvent.click(screen.getByRole('button', { name: /导出设置/ }));
};

const estimateCalls = () =>
  mockInvoke.mock.calls.filter(([command]) => command === 'estimate_export_sizes');
const exportCalls = () => mockInvoke.mock.calls.filter(([command]) => command === 'export_images');

const watermarkPreview = () => {
  const logoText = screen.getByText('标志');
  const inner = logoText.parentElement as HTMLElement;
  const position = inner.parentElement as HTMLElement;
  const preview = position.parentElement as HTMLElement;
  return { inner, position, preview };
};

const enableWatermarkWithImage = async (path = '/wm/logo.png') => {
  fireEvent.click(screen.getByLabelText('添加水印'));
  mockOpenDialog.mockResolvedValueOnce(path);
  fireEvent.click(screen.getByRole('button', { name: '选择' }));
  const filename = path.split('/').pop()!;
  await screen.findByText(filename);
  await screen.findByRole('button', { name: /右下角/ });
  return filename;
};

beforeEach(() => {
  useEditorStore.setState({ adjustments: structuredClone(INITIAL_ADJUSTMENTS) } as never);
  useUIStore.setState({
    activePanels: {
      leftTop: Panel.Export,
      leftBottom: null,
      rightTop: Panel.Adjustments,
      rightBottom: null,
    },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('导出 · 空状态与上下文', () => {
  it('TC-EXP-PANEL-01 编辑器未选图时显示提示且仅禁用主按钮', () => {
    renderPanel({ selectedImage: null });

    expect(screen.getByText('未选择要导出的图像。')).toBeInTheDocument();
    expect(screen.queryByText('文件设置')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回图库' })).not.toBeInTheDocument();
    expect(mainButton()).toBeDisabled();
    expect(mainButton()).toHaveTextContent('导出 图像');
  });

  it('TC-EXP-PANEL-02 图库上下文只认多选路径，空选择时显示图库空状态并可关闭', () => {
    const onClose = vi.fn();
    renderPanel({ onClose, multiSelectedPaths: [], selectedImage: IMAGE });

    expect(screen.getByText('未选择图像。')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: '返回图库' });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mainButton()).toBeDisabled();
  });

  it('TC-EXP-PANEL-03 多选路径优先于当前编辑图并显示批量数量与文件命名', () => {
    renderPanel({
      multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path],
      selectedImage: IMAGE,
    });

    expect(mainButton()).toHaveTextContent('导出 2 图像');
    expect(screen.getByText('文件命名')).toBeInTheDocument();
    expect(fileNamingInput().value).toBe('{original_filename}_edited');
  });

  it('TC-EXP-PANEL-04 编辑器多选优先于当前图，数量用于按钮与命名区', () => {
    renderPanel({
      selectedImage: SECOND_IMAGE,
      multiSelectedPaths: [SECOND_IMAGE.path],
    });

    expect(mainButton()).toHaveTextContent('导出 图像');
    expect(screen.queryByText('文件命名')).not.toBeInTheDocument();
  });
});

describe('导出 · 文件格式与参数可见性', () => {
  it('TC-EXP-PANEL-05 切换全部格式时质量/DPI/位深/元数据区按能力显示', () => {
    renderPanel();

    // JPEG
    expect(formatButton('JPEG').className).toContain('bg-accent');
    expect(screen.getByText('质量')).toBeInTheDocument();
    expect(screen.getByLabelText('分辨率')).toHaveValue('300');
    expect(screen.queryByText('位深')).not.toBeInTheDocument();
    expect(screen.getByText('元数据')).toBeInTheDocument();

    // PNG
    fireEvent.click(formatButton('PNG'));
    expect(formatButton('PNG').className).toContain('bg-accent');
    expect(screen.queryByText('质量')).not.toBeInTheDocument();
    expect(screen.getByLabelText('分辨率')).toBeInTheDocument();
    expect(screen.getByText('位深')).toBeInTheDocument();
    expect(screen.queryByText('元数据')).not.toBeInTheDocument();

    // TIFF
    fireEvent.click(formatButton('TIFF'));
    expect(screen.queryByText('质量')).not.toBeInTheDocument();
    expect(screen.getByLabelText('分辨率')).toBeInTheDocument();
    expect(screen.getByText('位深')).toBeInTheDocument();

    // WebP
    fireEvent.click(formatButton('WebP'));
    expect(screen.getByText('质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('分辨率')).not.toBeInTheDocument();
    expect(screen.queryByText('位深')).not.toBeInTheDocument();

    // JPEG XL
    fireEvent.click(formatButton('JPEG XL'));
    expect(screen.getByText('质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('分辨率')).not.toBeInTheDocument();
    expect(screen.getByText('位深')).toBeInTheDocument();

    // AVIF
    fireEvent.click(formatButton('AVIF'));
    expect(screen.queryByText('质量')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('分辨率')).not.toBeInTheDocument();
    expect(screen.queryByText('位深')).not.toBeInTheDocument();

    // CUBE LUT：仅保留文件设置与高级中的保留文件夹
    fireEvent.click(formatButton('CUBE LUT'));
    expect(screen.queryByText('质量')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('分辨率')).not.toBeInTheDocument();
    expect(screen.queryByText('图像大小')).not.toBeInTheDocument();
    expect(screen.queryByText('色彩输出')).not.toBeInTheDocument();
    expect(screen.queryByText('水印')).not.toBeInTheDocument();
    expect(mainButton()).toHaveTextContent('导出 LUT');
    openAdvanced();
    expect(screen.getByLabelText('保留文件夹结构')).toBeInTheDocument();
    expect(screen.queryByLabelText('将文件时间戳设为 EXIF 拍摄日期')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('将蒙版导出为单独文件')).not.toBeInTheDocument();
  });

  it('TC-EXP-PANEL-06 质量滑块可调，JPEG XL 在 100 时显示无损文案', () => {
    renderPanel();
    fireEvent.click(formatButton('JPEG XL'));
    expect(sliderValue('质量')).toBe('90');

    changeSlider('质量', 100);
    expect(sliderValue('质量（无损）')).toBe('100');

    changeSlider('质量（无损）', 55);
    expect(screen.getByText('质量')).toBeInTheDocument();
    expect(sliderValue('质量')).toBe('55');
  });

  it('TC-EXP-PANEL-07 DPI 仅接受 1..65535 的整数，非法输入失焦后回显当前值', () => {
    renderPanel();
    const input = screen.getByLabelText('分辨率') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '600' } });
    expect(input.value).toBe('600');
    fireEvent.blur(input);
    expect(input.value).toBe('600');

    fireEvent.change(input, { target: { value: '70000' } });
    expect(input.value).toBe('70000');
    fireEvent.blur(input);
    expect(input.value).toBe('600');

    fireEvent.change(input, { target: { value: '12.5' } });
    fireEvent.blur(input);
    expect(input.value).toBe('600');

    fireEvent.change(input, { target: { value: '65535' } });
    fireEvent.blur(input);
    expect(input.value).toBe('65535');
  });

  it('TC-EXP-PANEL-08 多图命名支持变量在光标处插入并按顺序追加', () => {
    renderPanel({ multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path] });
    const input = fileNamingInput();
    expect(screen.getAllByText(/^\{/).filter((el) => el.tagName === 'BUTTON')).toHaveLength(7);

    input.focus();
    input.setSelectionRange(0, 0);
    fireEvent.click(screen.getByText('{YYYY}', { selector: 'button' }));
    expect(input.value).toBe('{YYYY}{original_filename}_edited');

    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.click(screen.getByText('{sequence}', { selector: 'button' }));
    expect(input.value).toBe('{YYYY}{original_filename}_edited{sequence}');
  });

  it('TC-EXP-PANEL-09 单图不渲染命名区与变量按钮', () => {
    renderPanel();
    expect(screen.queryByText('文件命名')).not.toBeInTheDocument();
    expect(screen.queryByText('{sequence}', { selector: 'button' })).not.toBeInTheDocument();
  });
});

describe('导出 · 图像大小 / 色彩 / 元数据', () => {
  it('TC-EXP-PANEL-10 调整大小开关展开模式、像素与不放大选项', async () => {
    renderPanel();
    fireEvent.click(formatButton('PNG'));

    const resizeSwitch = screen.getByLabelText('调整大小以适应') as HTMLInputElement;
    expect(resizeSwitch).not.toBeChecked();
    expect(screen.queryByText('像素')).not.toBeInTheDocument();
    fireEvent.click(resizeSwitch);
    expect(resizeSwitch).toBeChecked();
    expect(screen.getByText('像素')).toBeInTheDocument();

    await selectDropdown(dropdownByLabel('长边'), '宽度');
    expect(dropdownByLabel('宽度')).toBeInTheDocument();
    const valueInput = document.querySelector('input[type="number"]') as HTMLInputElement;
    expect(valueInput.value).toBe('2048');
    fireEvent.change(valueInput, { target: { value: '1024' } });
    expect(valueInput.value).toBe('1024');

    const dontEnlarge = screen.getByLabelText('不放大') as HTMLInputElement;
    expect(dontEnlarge).toBeChecked();
    fireEvent.click(dontEnlarge);
    expect(dontEnlarge).not.toBeChecked();
  });

  it('TC-EXP-PANEL-11 非 sRGB JPEG 显示 ICC 提示，切 PNG 后提示消失且可选 16-bit', () => {
    renderPanel();
    expect(screen.queryByText(/嵌入 ICC 配置文件/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Display P3' }));
    expect(screen.getByText(/嵌入 ICC 配置文件/)).toBeInTheDocument();

    fireEvent.click(formatButton('PNG'));
    expect(screen.queryByText(/嵌入 ICC 配置文件/)).not.toBeInTheDocument();
    expect(screen.getByText('文件更小，标准屏幕显示')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '16-bit' }));
    expect(screen.getByText('文件更大，无色调断裂，适合继续编辑')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16-bit' }).className).toContain('border-accent');

    fireEvent.click(formatButton('JPEG'));
    expect(screen.getByText(/嵌入 ICC 配置文件/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sRGB' }));
    expect(screen.queryByText(/嵌入 ICC 配置文件/)).not.toBeInTheDocument();
  });

  it('TC-EXP-PANEL-12 JPEG 元数据与 GPS 开关联动，其他格式隐藏整段', () => {
    renderPanel();
    const keep = screen.getByLabelText('保存时包含元数据') as HTMLInputElement;
    const gps = screen.getByLabelText('移除 GPS 数据') as HTMLInputElement;
    expect(keep).toBeChecked();
    expect(gps).toBeChecked();

    fireEvent.click(keep);
    expect(keep).not.toBeChecked();
    expect(screen.queryByLabelText('移除 GPS 数据')).not.toBeInTheDocument();

    fireEvent.click(keep);
    const gpsAgain = screen.getByLabelText('移除 GPS 数据') as HTMLInputElement;
    expect(gpsAgain).toBeChecked();
    fireEvent.click(gpsAgain);
    expect(gpsAgain).not.toBeChecked();

    fireEvent.click(formatButton('PNG'));
    expect(screen.queryByText('元数据')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('保存时包含元数据')).not.toBeInTheDocument();
  });
});

describe('导出 · 水印', () => {
  it('TC-EXP-PANEL-13 启用水印后选择图片，锚点/三滑块/预览出现并可清除', async () => {
    mockInvoke.mockImplementation((command, args?: { path?: string }) => {
      if (command === 'get_image_dimensions' && args?.path === '/wm/logo.png') {
        return Promise.resolve({ width: 400, height: 200 });
      }
      return Promise.resolve(undefined);
    });
    renderPanel();

    fireEvent.click(screen.getByLabelText('添加水印'));
    expect(screen.queryByRole('button', { name: /右下角/ })).not.toBeInTheDocument();
    expect(screen.queryByText('预览')).not.toBeInTheDocument();

    mockOpenDialog.mockResolvedValueOnce('/wm/logo.png');
    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [expect.objectContaining({ extensions: ['png'] })],
      }),
    );

    expect(await screen.findByText('logo.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /右下角/ })).toBeInTheDocument();
    expect(screen.getByText('缩放')).toBeInTheDocument();
    expect(screen.getByText('间距')).toBeInTheDocument();
    expect(screen.getByText('不透明度')).toBeInTheDocument();
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('标志')).toBeInTheDocument();

    await waitFor(() => expect(watermarkPreview().inner.style.aspectRatio).toBe('2'));
    expect(parseFloat(watermarkPreview().preview.style.aspectRatio)).toBeCloseTo(4 / 3, 5);

    fireEvent.click(document.querySelector('.image-picker-clear') as HTMLElement);
    expect(screen.queryByText('logo.png')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /右下角/ })).not.toBeInTheDocument();
    expect(screen.queryByText('标志')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择' })).toBeInTheDocument();
  });

  it('TC-EXP-PANEL-14 九种水印锚点产生对应定位样式', async () => {
    renderPanel();
    await enableWatermarkWithImage();
    await waitFor(() => expect(watermarkPreview().inner.style.aspectRatio).toBe('1'));

    const cases: Array<[string, string, Partial<Record<'top' | 'bottom' | 'left' | 'right' | 'transform', string>>]> = [
      ['左上角', WatermarkAnchor.TopLeft, { top: '3.75%', left: '3.75%' }],
      ['顶部居中', WatermarkAnchor.TopCenter, { top: '3.75%', left: '50%', transform: 'translateX(-50%)' }],
      ['右上角', WatermarkAnchor.TopRight, { top: '3.75%', right: '3.75%' }],
      ['左侧居中', WatermarkAnchor.CenterLeft, { top: '50%', left: '3.75%', transform: 'translateY(-50%)' }],
      ['居中', WatermarkAnchor.Center, { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }],
      ['右侧居中', WatermarkAnchor.CenterRight, { top: '50%', right: '3.75%', transform: 'translateY(-50%)' }],
      ['左下角', WatermarkAnchor.BottomLeft, { bottom: '3.75%', left: '3.75%' }],
      ['底部居中', WatermarkAnchor.BottomCenter, { bottom: '3.75%', left: '50%', transform: 'translateX(-50%)' }],
      ['右下角', WatermarkAnchor.BottomRight, { bottom: '3.75%', right: '3.75%' }],
    ];

    let currentLabel = '右下角';
    for (const [label, , expected] of cases) {
      if (label !== currentLabel) {
        await selectDropdown(dropdownByLabel(currentLabel), label);
        currentLabel = label;
      }
      const { position, inner, preview } = watermarkPreview();
      expect(position.style.width).toBe('7.5%');
      expect(position.style.opacity).toBe('0.75');
      expect(inner.className).toContain('w-full');
      expect(parseFloat(preview.style.aspectRatio)).toBeCloseTo(4 / 3, 5);
      expect(position.style.top).toBe(expected.top ?? '');
      expect(position.style.bottom).toBe(expected.bottom ?? '');
      expect(position.style.left).toBe(expected.left ?? '');
      expect(position.style.right).toBe(expected.right ?? '');
      expect(position.style.transform).toBe(expected.transform ?? '');
    }
  });

  it('TC-EXP-PANEL-15 水印参数写入导出设置（路径、锚点、缩放、间距、不透明度）', async () => {
    renderPanel();
    await enableWatermarkWithImage('/wm/logo.png');
    await selectDropdown(dropdownByLabel('右下角'), '居中');
    changeSlider('缩放', 20);
    changeSlider('间距', 12);
    changeSlider('不透明度', 40);
    expect(sliderValue('缩放')).toBe('20');
    expect(sliderValue('间距')).toBe('12');
    expect(sliderValue('不透明度')).toBe('40');

    mockSaveDialog.mockResolvedValue('/out/photo_edited.jpg');
    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(exportCalls()[0][1].exportSettings.watermark).toEqual({
      path: '/wm/logo.png',
      anchor: WatermarkAnchor.Center,
      scale: 20,
      spacing: 12,
      opacity: 40,
    });
  });

  it('TC-EXP-PANEL-16 图库上下文用首图尺寸，主图失败回退 3:2、水印失败回退 1:1', async () => {
    useUIStore.setState({
      activePanels: {
        leftTop: Panel.FolderTree,
        leftBottom: null,
        rightTop: Panel.Adjustments,
        rightBottom: null,
      },
    } as never);
    mockInvoke.mockImplementation((command, args?: { path?: string }) => {
      if (command !== 'get_image_dimensions') return Promise.resolve(undefined);
      if (args?.path === '/lib/first.jpg') return Promise.reject(new Error('missing'));
      if (args?.path === '/wm/logo.png') return Promise.resolve({ width: 400, height: 100 });
      return Promise.resolve({ width: 1000, height: 500 });
    });
    renderPanel({
      onClose: vi.fn(),
      selectedImage: null,
      multiSelectedPaths: ['/lib/first.jpg'],
    });

    await enableWatermarkWithImage();
    await waitFor(() => {
      expect(parseFloat(watermarkPreview().preview.style.aspectRatio)).toBeCloseTo(3 / 2, 5);
      expect(watermarkPreview().inner.style.aspectRatio).toBe('4');
    });
  });

  it('TC-EXP-PANEL-17 图库主图尺寸读取成功时预览采用真实宽高比', async () => {
    useUIStore.setState({
      activePanels: {
        leftTop: Panel.FolderTree,
        leftBottom: null,
        rightTop: Panel.Adjustments,
        rightBottom: null,
      },
    } as never);
    mockInvoke.mockImplementation((command, args?: { path?: string }) => {
      if (command !== 'get_image_dimensions') return Promise.resolve(undefined);
      if (args?.path === '/lib/panorama.jpg') return Promise.resolve({ width: 2000, height: 500 });
      return Promise.resolve(undefined);
    });
    renderPanel({
      onClose: vi.fn(),
      selectedImage: null,
      multiSelectedPaths: ['/lib/panorama.jpg'],
    });

    await enableWatermarkWithImage();
    await waitFor(() => {
      expect(parseFloat(watermarkPreview().preview.style.aspectRatio)).toBeCloseTo(4, 5);
    });
  });

  it('TC-EXP-PANEL-18 水印开关关闭后隐藏全部水印控件', () => {
    renderPanel();
    const watermarkSwitch = screen.getByLabelText('添加水印') as HTMLInputElement;
    fireEvent.click(watermarkSwitch);
    expect(screen.getByRole('button', { name: '选择' })).toBeInTheDocument();
    fireEvent.click(watermarkSwitch);
    expect(screen.queryByRole('button', { name: '选择' })).not.toBeInTheDocument();
  });
});

describe('导出 · 高级选项', () => {
  it('TC-EXP-PANEL-19 编辑器高级设置含三个开关，可展开收起', () => {
    renderPanel();
    expect(screen.queryByLabelText('保留文件夹结构')).not.toBeInTheDocument();

    openAdvanced();
    const preserveFolders = screen.getByLabelText('保留文件夹结构') as HTMLInputElement;
    const timestamps = screen.getByLabelText('将文件时间戳设为 EXIF 拍摄日期') as HTMLInputElement;
    const masks = screen.getByLabelText('将蒙版导出为单独文件') as HTMLInputElement;
    expect(preserveFolders).not.toBeChecked();
    expect(timestamps).not.toBeChecked();
    expect(masks).not.toBeChecked();

    fireEvent.click(preserveFolders);
    fireEvent.click(timestamps);
    fireEvent.click(masks);
    expect(preserveFolders).toBeChecked();
    expect(timestamps).toBeChecked();
    expect(masks).toBeChecked();
  });

  it('TC-EXP-PANEL-20 图库上下文隐藏导出蒙版，仅保留文件夹与时间戳', () => {
    renderPanel({ onClose: vi.fn(), multiSelectedPaths: [IMAGE.path] });
    openAdvanced();
    expect(screen.getByLabelText('保留文件夹结构')).toBeInTheDocument();
    expect(screen.getByLabelText('将文件时间戳设为 EXIF 拍摄日期')).toBeInTheDocument();
    expect(screen.queryByLabelText('将蒙版导出为单独文件')).not.toBeInTheDocument();
  });

  it('TC-EXP-PANEL-21 LUT 格式隐藏时间戳与蒙版高级项', () => {
    renderPanel();
    fireEvent.click(formatButton('CUBE LUT'));
    openAdvanced();
    expect(screen.getByLabelText('保留文件夹结构')).toBeInTheDocument();
    expect(screen.queryByLabelText('将文件时间戳设为 EXIF 拍摄日期')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('将蒙版导出为单独文件')).not.toBeInTheDocument();
  });
});

describe('导出 · 大小估算', () => {
  it('TC-EXP-PANEL-22 估算成功显示单图大小，格式变化使用新扩展名重新估算', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(2 * 1024 * 1024);
      return Promise.resolve(undefined);
    });
    renderPanel();
    fireEvent.click(formatButton('PNG'));

    await waitFor(
      () => expect(screen.getByText('预计文件大小：约 2 MB')).toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(estimateCalls()).toHaveLength(1);
    expect(estimateCalls()[0][1]).toMatchObject({
      paths: [IMAGE.path],
      outputFormat: 'png',
      currentEditPath: IMAGE.path,
      exportSettings: expect.objectContaining({ dpi: 300, colorSpace: 'srgb', bitDepth: 8 }),
    });
  });

  it('TC-EXP-PANEL-23 多图显示总大小与单图平均大小', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(3 * 1024 * 1024);
      return Promise.resolve(undefined);
    });
    renderPanel({ multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path] });

    await waitFor(
      () => expect(screen.getByText(/预计总大小：约 3 MB.*1\.5 MB/)).toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(estimateCalls()[0][1].paths).toEqual([IMAGE.path, SECOND_IMAGE.path]);
  });

  it('TC-EXP-PANEL-24 估算期间显示加载文案，成功后展示大小', async () => {
    let resolveEstimate!: (value: number) => void;
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') {
        return new Promise<number>((resolve) => {
          resolveEstimate = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    renderPanel();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(screen.getByText('正在估算大小...')).toBeInTheDocument();

    await act(async () => {
      resolveEstimate(512);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('预计文件大小：约 512 字节')).toBeInTheDocument());
  });

  it('TC-EXP-PANEL-25 估算失败/零字节时分别隐藏结果或显示 0 字节', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.reject(new Error('estimate failed'));
      return Promise.resolve(undefined);
    });
    const first = renderPanel();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(screen.queryByText(/预计文件大小/)).not.toBeInTheDocument();
    first.unmount();

    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(0);
      return Promise.resolve(undefined);
    });
    renderPanel();
    await waitFor(
      () => expect(screen.getByText('预计文件大小：约 0 字节')).toBeInTheDocument(),
      { timeout: 2500 },
    );
  });

  it('TC-EXP-PANEL-26 调整参数变化会订阅 store 重新估算并携带最新调整', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(1024);
      return Promise.resolve(undefined);
    });
    renderPanel();
    await waitFor(() => expect(estimateCalls()).toHaveLength(1), { timeout: 2500 });

    const nextAdjustments = { ...structuredClone(INITIAL_ADJUSTMENTS), exposure: 1.25 };
    act(() => {
      useEditorStore.setState({ adjustments: nextAdjustments } as never);
    });

    await waitFor(() => expect(estimateCalls()).toHaveLength(2), { timeout: 2500 });
    expect(estimateCalls()[1][1]).toMatchObject({
      currentEditAdjustments: expect.objectContaining({ exposure: 1.25 }),
      currentEditPath: IMAGE.path,
    });
  });

  it('TC-EXP-PANEL-27 DPI、色彩空间与位深变化都会重新估算', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(1024);
      return Promise.resolve(undefined);
    });
    renderPanel();
    await waitFor(() => expect(estimateCalls()).toHaveLength(1), { timeout: 2500 });

    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '600' } });
    await waitFor(() => expect(estimateCalls()).toHaveLength(2), { timeout: 2500 });
    expect(estimateCalls()[1][1].exportSettings.dpi).toBe(600);

    fireEvent.click(screen.getByRole('button', { name: 'Display P3' }));
    await waitFor(() => expect(estimateCalls()).toHaveLength(3), { timeout: 2500 });
    expect(estimateCalls()[2][1].exportSettings.colorSpace).toBe('displayP3');

    fireEvent.click(formatButton('PNG'));
    await waitFor(() => expect(estimateCalls()).toHaveLength(4), { timeout: 2500 });
    fireEvent.click(screen.getByRole('button', { name: '16-bit' }));
    await waitFor(() => expect(estimateCalls()).toHaveLength(5), { timeout: 2500 });
    expect(estimateCalls()[4][1].exportSettings.bitDepth).toBe(16);
  });

  it('TC-EXP-PANEL-28 面板未激活或不可见时不发起估算', async () => {
    useUIStore.setState({
      activePanels: {
        leftTop: Panel.FolderTree,
        leftBottom: null,
        rightTop: Panel.Adjustments,
        rightBottom: null,
      },
    } as never);
    const inactive = renderPanel();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(estimateCalls()).toHaveLength(0);
    inactive.unmount();

    renderPanel({ isVisible: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(estimateCalls()).toHaveLength(0);
  });

  it('TC-EXP-PANEL-29 面板从非激活切到导出时补发估算', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(1024);
      return Promise.resolve(undefined);
    });
    useUIStore.setState({
      activePanels: {
        leftTop: Panel.FolderTree,
        leftBottom: null,
        rightTop: Panel.Adjustments,
        rightBottom: null,
      },
    } as never);
    renderPanel();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(estimateCalls()).toHaveLength(0);

    act(() => {
      useUIStore.setState({
        activePanels: {
          leftTop: Panel.Export,
          leftBottom: null,
          rightTop: Panel.Adjustments,
          rightBottom: null,
        },
      } as never);
    });
    await waitFor(() => expect(estimateCalls()).toHaveLength(1), { timeout: 2500 });
  });

  it('TC-EXP-PANEL-52 图库导出浮层在右侧面板未激活时仍执行大小估算', async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === 'estimate_export_sizes') return Promise.resolve(2048);
      return Promise.resolve(undefined);
    });
    useUIStore.setState({
      activePanels: {
        leftTop: Panel.FolderTree,
        leftBottom: null,
        rightTop: Panel.Adjustments,
        rightBottom: null,
      },
    } as never);
    renderPanel({
      onClose: vi.fn(),
      selectedImage: null,
      multiSelectedPaths: ['/lib/one.jpg', '/lib/two.jpg'],
    });

    await waitFor(
      () => expect(screen.getByText(/预计总大小：约 2 KB/)).toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(estimateCalls()[0][1].exportSettings.exportMasks).toBeUndefined();
  });
});

describe('导出 · 预设与初始化', () => {
  it('TC-EXP-PANEL-30 首次加载应用 __last_used__ 预设（含 DPI 显示）且只应用一次', () => {
    const lastUsed = makePreset({
      id: '__last_used__',
      name: '__last_used__',
      jpegQuality: 55,
      dpi: 600,
    });
    const settings1 = makeSettings([lastUsed]);
    const { props, setExportState, rerender } = renderPanel({ appSettings: settings1 });

    expect(sliderValue('质量')).toBe('55');
    expect(screen.getByLabelText('分辨率')).toHaveValue('600');

    const settings2 = makeSettings([
      makePreset({ ...lastUsed, jpegQuality: 70, dpi: 800 }),
    ]);
    rerender(
      <ExportPanel
        {...props}
        appSettings={settings2}
        exportState={idleState()}
        setExportState={setExportState}
      />,
    );
    expect(sliderValue('质量')).toBe('55');
    expect(screen.getByLabelText('分辨率')).toHaveValue('600');
  });

  it('TC-EXP-PANEL-31 面板不可见时延迟应用 __last_used__，可见后立即生效', () => {
    const lastUsed = makePreset({ id: '__last_used__', name: '__last_used__', jpegQuality: 64 });
    const { props, setExportState, rerender } = renderPanel({
      appSettings: makeSettings([lastUsed]),
      isVisible: false,
    });
    expect(sliderValue('质量')).toBe('90');

    rerender(
      <ExportPanel
        {...props}
        isVisible
        exportState={idleState()}
        setExportState={setExportState}
      />,
    );
    expect(sliderValue('质量')).toBe('64');
  });

  it('TC-EXP-PANEL-32 选择导出预设后格式、缩放、位深与 DPI 同步回填', async () => {
    const preset = makePreset({
      id: 'preset-png',
      name: 'PNG 预设',
      fileFormat: 'png',
      enableResize: true,
      resizeMode: 'width',
      resizeValue: 1234,
      dontEnlarge: false,
      bitDepth: 16,
      colorSpace: 'proPhoto',
      dpi: 450,
    });
    renderPanel({ appSettings: makeSettings([preset]) });

    await selectDropdown(dropdownByLabel('选择一个预设'), 'PNG 预设');

    expect(formatButton('PNG').className).toContain('bg-accent');
    expect(screen.getByLabelText('调整大小以适应')).toBeChecked();
    expect((document.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('1234');
    expect(screen.getByLabelText('不放大')).not.toBeChecked();
    expect(screen.getByText('文件更大，无色调断裂，适合继续编辑')).toBeInTheDocument();
    expect(screen.getByLabelText('分辨率')).toHaveValue('450');
  });
});

describe('导出 · 输出路径与参数', () => {
  it('TC-EXP-PANEL-33 单图走保存对话框，使用上次目录与文件名模板并提交完整设置', async () => {
    const lastUsed = makePreset({
      id: '__last_used__',
      name: '__last_used__',
      lastExportPath: '/exports/last',
    });
    const other = makePreset({ id: 'preset-other', name: '其他预设' });
    const settings = makeSettings([lastUsed, other]);
    mockSaveDialog.mockResolvedValue('/out/photo_edited.jpg');
    const { onSettingsChange } = renderPanel({ appSettings: settings });

    changeSlider('质量', 80);
    fireEvent.change(screen.getByLabelText('分辨率'), { target: { value: '600' } });
    fireEvent.click(screen.getByLabelText('保存时包含元数据')); // false
    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(mockSaveDialog).toHaveBeenCalledTimes(1);
    const dialogArgs = mockSaveDialog.mock.calls[0][0];
    expect(dialogArgs.title).toBe('保存编辑后的图像');
    expect(dialogArgs.defaultPath).toBe('/exports/last/photo_edited.jpg');
    expect(dialogArgs.filters).toHaveLength(7);
    expect(dialogArgs.filters[0]).toEqual({ name: 'JPEG', extensions: ['jpg', 'jpeg'] });

    expect(exportCalls()[0][1]).toEqual({
      paths: [IMAGE.path],
      outputFolderOrFile: '/out/photo_edited.jpg',
      isExplicitFilePath: true,
      baseOriginFolders: ['/photos'],
      exportSettings: {
        filenameTemplate: '{original_filename}_edited',
        jpegQuality: 80,
        dpi: 600,
        keepMetadata: false,
        preserveTimestamps: false,
        preserveFolders: false,
        colorSpace: 'srgb',
        bitDepth: 8,
        resize: null,
        stripGps: true,
        exportMasks: false,
        watermark: null,
      },
      outputFormat: 'jpg',
      currentEditPath: IMAGE.path,
      currentEditAdjustments: useEditorStore.getState().adjustments,
    });

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    const updated = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(updated.exportPresets).toHaveLength(2);
    expect(updated.exportPresets![0]).toEqual(other);
    expect(updated.exportPresets![1]).toMatchObject({
      id: '__last_used__',
      name: '__last_used__',
      lastExportPath: '/out',
      jpegQuality: 80,
      dpi: 600,
      keepMetadata: false,
      colorSpace: 'srgb',
      bitDepth: 8,
    });
  });

  it('TC-EXP-PANEL-34 PNG + 缩放 + 16-bit + 保留文件夹走目录选择并提交对应设置', async () => {
    mockOpenDialog.mockResolvedValue('/out/tree');
    const { onSettingsChange } = renderPanel();

    fireEvent.click(formatButton('PNG'));
    fireEvent.click(screen.getByLabelText('调整大小以适应'));
    await selectDropdown(dropdownByLabel('长边'), '宽度');
    fireEvent.change(document.querySelector('input[type="number"]') as HTMLInputElement, {
      target: { value: '1024' },
    });
    fireEvent.click(screen.getByLabelText('不放大'));
    fireEvent.click(screen.getByRole('button', { name: 'Display P3' }));
    fireEvent.click(screen.getByRole('button', { name: '16-bit' }));
    openAdvanced();
    fireEvent.click(screen.getByLabelText('保留文件夹结构'));

    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(mockSaveDialog).not.toHaveBeenCalled();
    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '选择文件夹以导出 1 张图像',
        directory: true,
        defaultPath: undefined,
      }),
    );
    const args = exportCalls()[0][1];
    expect(args.outputFolderOrFile).toBe('/out/tree');
    expect(args.isExplicitFilePath).toBe(false);
    expect(args.outputFormat).toBe('png');
    expect(args.exportSettings.resize).toEqual({
      mode: 'width',
      value: 1024,
      dontEnlarge: false,
    });
    expect(args.exportSettings).toMatchObject({
      preserveFolders: true,
      colorSpace: 'displayP3',
      bitDepth: 16,
    });
    expect(onSettingsChange.mock.calls[0][0].exportPresets[0].lastExportPath).toBe('/out/tree');
  });

  it('TC-EXP-PANEL-35 多图自动在无变量模板后追加 _sequence 并刷新输入框', async () => {
    mockOpenDialog.mockResolvedValue('/out');
    renderPanel({ multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path] });
    const input = fileNamingInput();
    fireEvent.change(input, { target: { value: 'batch' } });

    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(mockOpenDialog.mock.calls[0][0]).toMatchObject({
      title: '选择文件夹以导出 2 张图像',
      directory: true,
      defaultPath: undefined,
    });
    expect(exportCalls()[0][1]).toMatchObject({
      paths: [IMAGE.path, SECOND_IMAGE.path],
      outputFolderOrFile: '/out',
      isExplicitFilePath: false,
      outputFormat: 'jpg',
      exportSettings: expect.objectContaining({ filenameTemplate: 'batch_{sequence}' }),
    });
    expect(input.value).toBe('batch_{sequence}');
  });

  it('TC-EXP-PANEL-36 模板已含序列或原文件名时不会重复追加', async () => {
    mockOpenDialog.mockResolvedValue('/out');
    renderPanel({ multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path] });
    fireEvent.change(fileNamingInput(), {
      target: { value: 'keep_{original_filename}_{YYYY}' },
    });

    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(exportCalls()[0][1].exportSettings.filenameTemplate).toBe(
      'keep_{original_filename}_{YYYY}',
    );
  });

  it('TC-EXP-PANEL-37 图库上下文导出多选路径且 exportMasks 为 undefined', async () => {
    mockOpenDialog.mockResolvedValue('/out/library');
    renderPanel({
      onClose: vi.fn(),
      selectedImage: IMAGE,
      multiSelectedPaths: ['/lib/a.jpg', '/lib/b.jpg'],
    });

    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    const args = exportCalls()[0][1];
    expect(args.paths).toEqual(['/lib/a.jpg', '/lib/b.jpg']);
    expect(args.exportSettings.exportMasks).toBeUndefined();
    expect(args.currentEditPath).toBe(IMAGE.path);
  });

  it('TC-EXP-PANEL-38 取消保存对话框不导出、不切换状态、不写上次目录', async () => {
    mockSaveDialog.mockResolvedValue(null);
    const { setExportState, onSettingsChange } = renderPanel();

    fireEvent.click(mainButton());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSaveDialog).toHaveBeenCalledTimes(1);
    expect(exportCalls()).toHaveLength(0);
    expect(setExportState).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(mainButton()).toHaveTextContent('导出 图像');
  });

  it('TC-EXP-PANEL-39 取消目录选择不导出', async () => {
    mockOpenDialog.mockResolvedValue(null);
    const { setExportState } = renderPanel({
      multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path],
    });
    fireEvent.click(mainButton());
    await act(async () => {
      await Promise.resolve();
    });
    expect(exportCalls()).toHaveLength(0);
    expect(setExportState).not.toHaveBeenCalled();
  });

  it('TC-EXP-PANEL-40 appSettings 为 null 时仍可导出，使用相对默认名且不写设置', async () => {
    mockSaveDialog.mockResolvedValue('/out/photo_edited.jpg');
    const { onSettingsChange } = renderPanel({ appSettings: null });

    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(mockSaveDialog.mock.calls[0][0].defaultPath).toBe('photo_edited.jpg');
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('TC-EXP-PANEL-41 后端返回字符串错误时显示原始信息', async () => {
    mockSaveDialog.mockResolvedValue('/out/photo_edited.jpg');
    mockInvoke.mockImplementation((command) => {
      if (command === 'export_images') return Promise.reject('磁盘已满');
      return Promise.resolve(undefined);
    });
    renderStateful();
    fireEvent.click(mainButton());

    await waitFor(() => expect(mainButton()).toHaveTextContent('磁盘已满'));
    expect(mainButton().className).toContain('bg-red-500/20');
  });

  it('TC-EXP-PANEL-42 后端返回非字符串错误时回退“导出失败”', async () => {
    mockSaveDialog.mockResolvedValue('/out/photo_edited.jpg');
    mockInvoke.mockImplementation((command) => {
      if (command === 'export_images') return Promise.reject(new Error('io error'));
      return Promise.resolve(undefined);
    });
    renderStateful();
    fireEvent.click(mainButton());

    await waitFor(() => expect(mainButton()).toHaveTextContent('导出失败'));
  });
});

describe('导出 · Android 路径', () => {
  it('TC-EXP-PANEL-43 Android 单图跳过保存对话框，直接以文件名导出', async () => {
    mockPlatform.mockReturnValue('android');
    const { onSettingsChange } = renderPanel();
    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(mockSaveDialog).not.toHaveBeenCalled();
    expect(mockOpenDialog).not.toHaveBeenCalled();
    expect(exportCalls()[0][1]).toMatchObject({
      paths: [IMAGE.path],
      outputFolderOrFile: 'photo_edited.jpg',
      isExplicitFilePath: true,
      outputFormat: 'jpg',
    });
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('TC-EXP-PANEL-44 Android 多图跳过目录选择，输出目录为空字符串', async () => {
    mockPlatform.mockReturnValue('android');
    renderPanel({ multiSelectedPaths: [IMAGE.path, SECOND_IMAGE.path] });
    fireEvent.click(mainButton());
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    expect(mockSaveDialog).not.toHaveBeenCalled();
    expect(mockOpenDialog).not.toHaveBeenCalled();
    expect(exportCalls()[0][1]).toMatchObject({
      outputFolderOrFile: '',
      isExplicitFilePath: false,
    });
  });
});

describe('导出 · 取消与状态机', () => {
  it('TC-EXP-PANEL-45 导出中点击主按钮调用取消并进入取消中状态', async () => {
    renderStateful({}, {
      status: Status.Exporting,
      progress: { current: 1, total: 2 },
    });
    expect(mainButton()).toHaveTextContent('导出中…（1/2）');
    expect(screen.getByText('取消导出')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(mainButton());
      await Promise.resolve();
    });

    expect(mockInvoke).toHaveBeenCalledWith('cancel_export');
    expect(mainButton()).toHaveTextContent('正在取消导出…');
    expect(mainButton()).toBeDisabled();
  });

  it('TC-EXP-PANEL-46 取消失败回滚到导出中并记录错误', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInvoke.mockImplementation((command) => {
      if (command === 'cancel_export') return Promise.reject(new Error('cancel failed'));
      return Promise.resolve(undefined);
    });
    renderStateful({}, {
      status: Status.Exporting,
      progress: { current: 0, total: 2 },
    });

    await act(async () => {
      fireEvent.click(mainButton());
      await Promise.resolve();
    });

    await waitFor(() => expect(mainButton()).toHaveTextContent('导出中…（0/2）'));
    expect(mainButton()).toBeEnabled();
    expect(consoleSpy).toHaveBeenCalledWith('Failed to cancel:', expect.any(Error));
  });

  it('TC-EXP-PANEL-47 导出中禁用格式、DSP 与高级入口，主按钮仍可取消', () => {
    renderPanel({}, { status: Status.Exporting, progress: { current: 0, total: 1 } });

    expect(formatButton('JPEG')).toBeDisabled();
    expect(formatButton('PNG')).toBeDisabled();
    expect(screen.getByLabelText('分辨率')).toBeDisabled();
    expect(screen.getByLabelText('保存时包含元数据')).toBeDisabled();
    expect(screen.getByLabelText('调整大小以适应')).toBeDisabled();
    expect(screen.getByRole('button', { name: /导出设置/ })).toBeDisabled();
    expect(mainButton()).toBeEnabled();
  });

  it.each([
    [Status.Success, '导出成功！'],
    [Status.Cancelled, '导出已取消'],
    [Status.Cancelling, '正在取消导出…'],
  ])('TC-EXP-PANEL-48 状态 %s 显示 %s', (status, label) => {
    renderPanel({}, { status });
    expect(mainButton()).toHaveTextContent(label);
    if (status === Status.Cancelling) expect(mainButton()).toBeDisabled();
  });

  it('TC-EXP-PANEL-49 Error 状态优先显示自定义错误，空错误回退默认文案', () => {
    const first = renderPanel({}, { status: Status.Error, errorMessage: '写入失败' });
    expect(mainButton()).toHaveTextContent('写入失败');
    first.unmount();

    renderPanel({}, { status: Status.Error, errorMessage: '' });
    expect(mainButton()).toHaveTextContent('导出失败');
  });

  it('TC-EXP-PANEL-50 无图时任意非导出状态主按钮均禁用', () => {
    renderPanel({ selectedImage: null }, { status: Status.Success });
    expect(mainButton()).toBeDisabled();
  });

  it.each([
    ['JPEG', [], '导出 图像'],
    ['JPEG', [IMAGE.path, SECOND_IMAGE.path], '导出 2 图像'],
    ['CUBE LUT', [], '导出 LUT'],
    ['CUBE LUT', [IMAGE.path, SECOND_IMAGE.path], '导出 2 LUT'],
  ])('TC-EXP-PANEL-51 %s / %s 张时按钮文案为 %s', (format, paths, label) => {
    renderPanel({ multiSelectedPaths: paths });
    fireEvent.click(formatButton(format));
    expect(mainButton()).toHaveTextContent(label);
  });
});

describe('导出 · 键盘、焦点与状态反馈体验', () => {
  it('格式按钮暴露 aria-pressed，切换后仅当前格式为按下态', () => {
    renderPanel();
    expect(formatButton('JPEG')).toHaveAttribute('aria-pressed', 'true');
    expect(formatButton('PNG')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(formatButton('PNG'));
    expect(formatButton('JPEG')).toHaveAttribute('aria-pressed', 'false');
    expect(formatButton('PNG')).toHaveAttribute('aria-pressed', 'true');
  });

  it('色彩空间与位深按钮暴露 aria-pressed，选择后状态同步', () => {
    renderPanel();
    fireEvent.click(formatButton('PNG'));

    const displayP3 = screen.getByRole('button', { name: 'Display P3' });
    const bit16 = screen.getByRole('button', { name: '16-bit' });
    expect(displayP3).toHaveAttribute('aria-pressed', 'false');
    expect(bit16).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(displayP3);
    fireEvent.click(bit16);
    expect(displayP3).toHaveAttribute('aria-pressed', 'true');
    expect(bit16).toHaveAttribute('aria-pressed', 'true');
  });

  it('高级选项按钮同步 aria-expanded 与 aria-controls', () => {
    renderPanel();
    const advanced = screen.getByRole('button', { name: /导出设置/ });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(advanced).toHaveAttribute('aria-controls', 'export-advanced-options');

    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('export-advanced-options')).toBeInTheDocument();
  });

  it('底部状态是 polite live region，导出中主按钮 aria-busy', () => {
    renderPanel({}, { status: Status.Exporting, progress: { current: 1, total: 2 } });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(mainButton()).toHaveAttribute('aria-busy', 'true');
  });

  it('质量滑块可用键盘进入数值编辑并提交，aria 名称可定位', async () => {
    renderPanel();
    const valueButton = screen.getByRole('button', { name: '质量: 90' });
    fireEvent.keyDown(valueButton, { key: 'Enter' });
    const input = screen.getByRole('textbox', { name: '质量' });
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: '质量: 80' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('slider', { name: '质量' })).toHaveValue('80'));
  });

describe('导出 · 文件命名与终态播报体验', () => {
  it('多图时文件名模板输入具备可访问名称，变量按钮可插入占位符', () => {
    renderPanel({ selectedImage: null, multiSelectedPaths: ['/a.jpg', '/b.jpg'] });
    const input = screen.getByRole('textbox', { name: '文件命名' });
    expect(input).toHaveValue('{original_filename}_edited');

    fireEvent.change(input, { target: { value: 'batch_' } });
    fireEvent.click(screen.getByRole('button', { name: '{sequence}' }));
    expect(input.value).toBe('batch_{sequence}');
  });

  it('导出成功终态通过隐藏 status 区域礼貌播报', () => {
    renderPanel({}, { status: Status.Success });
    const success = screen.getAllByText('导出成功！').find((el) => el.closest('[role="status"]'));
    const status = success?.closest('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  it('导出失败终态播报具体错误，并保留主按钮可读状态', () => {
    renderPanel({}, { status: Status.Error, errorMessage: '磁盘空间不足' });
    const error = screen.getAllByText('磁盘空间不足').find((el) => el.closest('[role="status"]'));
    const status = error?.closest('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(mainButton()).toHaveTextContent('磁盘空间不足');
  });

  it('导出进行中格式选择禁用且主按钮暴露 aria-busy', () => {
    renderPanel({}, { status: Status.Exporting, progress: { current: 1, total: 2 } });
    expect(mainButton()).toHaveAttribute('aria-busy', 'true');
    expect(formatButton('JPEG')).toBeDisabled();
    expect(formatButton('JPEG')).toHaveAttribute('aria-pressed', 'true');
  });
});
});
