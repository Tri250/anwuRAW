import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CropPanel from '../../src/components/panel/right/CropPanel';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../../src/utils/adjustments';
import { useEditorStore } from '../../src/store/useEditorStore';
import { debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { mockInvoke } from './setup';


// jsdom 未实现 PointerEvent；framer-motion 的键盘按压手势会构造该事件。
if (typeof (globalThis as any).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  (globalThis as any).PointerEvent = PointerEventPolyfill;
}

const IMAGE = {
  path: '/photos/test.dng',
  width: 4000,
  height: 3000,
  isRaw: true,
  isReady: true,
  thumbnailUrl: '',
  exif: {},
};

const makeAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments => ({
  ...INITIAL_ADJUSTMENTS,
  ...overrides,
});

const seedStore = (overrides: Partial<Adjustments> = {}, image: any = IMAGE) => {
  useEditorStore.setState({
    selectedImage: image,
    adjustments: makeAdjustments(overrides),
    overlayMode: 'thirds',
    overlayRotation: 0,
    isStraightenActive: false,
    isGuidedPerspectiveActive: false,
    isRotationActive: false,
    liveRotation: null,
  } as never);
};

const renderPanel = (overrides: Partial<Adjustments> = {}, image: any = IMAGE) => {
  seedStore(overrides, image);
  return render(<CropPanel />);
};

const adj = () => useEditorStore.getState().adjustments;

const getSlider = (label: string, scope: ParentNode = document.body): HTMLInputElement => {
  const labelEl = within(scope as HTMLElement).getByText(label, { selector: 'span' });
  const row = labelEl.closest('.slider-row');
  if (!row) throw new Error(`slider row not found for ${label}`);
  return row.querySelector('input[type="range"]') as HTMLInputElement;
};

const fineRotationSlider = (): HTMLInputElement =>
  document.querySelector('.slider-row input[type="range"]') as HTMLInputElement;

const presetEl = (name: string): HTMLElement =>
  screen.getByText(name, { selector: 'p' }).closest('[data-tooltip]') as HTMLElement;

const toolButton = (tooltip: string): HTMLButtonElement =>
  document.querySelector(`button[data-tooltip="${tooltip}"]`) as HTMLButtonElement;

const openTransformModal = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByText('变换'));
  return waitFor(() => {
    const pane = document.querySelector('.modal-adjustments-pane');
    if (!pane) throw new Error('transform modal not open');
    return pane as HTMLElement;
  });
};

const previewCalls = () =>
  mockInvoke.mock.calls
    .filter(([cmd]) => cmd === 'preview_geometry_transform')
    .map(([, args]) => args as any);

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

const DISTORTION_PARAMS = {
  k1: 0.12,
  k2: 0,
  k3: 0,
  model: 1,
  tca_vr: 1.0,
  tca_vb: 1.0,
  vig_k1: 0,
  vig_k2: 0,
  vig_k3: 0,
};

const ALL_PARAMS = {
  k1: 0.12,
  k2: 0.01,
  k3: 0,
  model: 1,
  tca_vr: 1.01,
  tca_vb: 0.99,
  vig_k1: 0.2,
  vig_k2: 0.02,
  vig_k3: 0,
};

interface LensMockOptions {
  myLenses?: Array<{ maker: string; model: string }>;
  makers?: string[];
  lenses?: string[];
  params?: any;
  autodetect?: any;
  preview?: any;
}

const installLensMocks = (options: LensMockOptions = {}) => {
  const preview = options.preview === undefined ? 'blob:lens-preview' : options.preview;
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'preview_geometry_transform':
        return Promise.resolve(preview);
      case 'load_settings':
        return Promise.resolve({ myLenses: options.myLenses ?? [] });
      case 'get_lensfun_makers':
        return Promise.resolve(options.makers ?? ['Canon', 'Nikon']);
      case 'get_lensfun_lenses_for_maker':
        return Promise.resolve(options.lenses ?? ['EF 50mm f/1.8', 'EF 24-70mm f/2.8']);
      case 'get_lens_distortion_params':
        return Promise.resolve(options.params === undefined ? DISTORTION_PARAMS : options.params);
      case 'autodetect_lens':
        if (options.autodetect === undefined) return Promise.resolve(null);
        return typeof options.autodetect === 'function' ? options.autodetect() : options.autodetect;
      default:
        return Promise.resolve(undefined);
    }
  });
};

const openLensModal = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByText('镜头'));
  return waitFor(() => {
    const pane = document.querySelector('.modal-adjustments-pane');
    if (!pane) throw new Error('lens modal not open');
    return pane as HTMLElement;
  });
};

beforeEach(() => {
  seedStore();
});

afterEach(() => {
  debouncedSetHistory.cancel();
  vi.restoreAllMocks();
});

describe('裁剪与变换 · 裁剪面板', () => {
  it('未选择图像时显示空状态', () => {
    useEditorStore.setState({ selectedImage: null, adjustments: INITIAL_ADJUSTMENTS } as never);
    render(<CropPanel />);
    expect(screen.getByText('未选择图像。')).toBeInTheDocument();
    expect(screen.queryByText('宽高比')).not.toBeInTheDocument();
  });

  it('渲染全部预设、叠加按钮与默认自由比例', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: '裁剪与变换' })).toBeInTheDocument();
    for (const name of ['自由', '原始', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9', '65:24', '自定义']) {
      expect(screen.getByText(name, { selector: 'p' })).toBeInTheDocument();
    }
    expect(presetEl('自由').className).toContain('bg-accent');
    expect(toolButton('切换方向')).toBeDisabled();
    expect(document.querySelector('button[data-tooltip="叠加：三分法"]')).toBeInTheDocument();
    expect(fineRotationSlider()).toBeInTheDocument();
  });

  it('预设写入比例并生成居中裁剪；再次点击当前预设切换纵横', () => {
    renderPanel();
    fireEvent.click(screen.getByText('1:1'));
    expect(adj().aspectRatio).toBe(1);
    expect(adj().crop).toEqual({ unit: 'px', x: 500, y: 0, width: 3000, height: 3000 });
    expect(presetEl('1:1').className).toContain('bg-accent');

    fireEvent.click(screen.getByText('4:3'));
    expect(adj().aspectRatio).toBeCloseTo(4 / 3, 6);
    // 已有裁剪时保持面积不变
    expect(adj().crop!.width / adj().crop!.height).toBeCloseTo(4 / 3, 2);
    const area = adj().crop!.width * adj().crop!.height;
    expect(area).toBeGreaterThan(8_900_000);
    expect(area).toBeLessThan(9_100_000);

    // 再次点击当前预设 → 取倒数
    fireEvent.click(screen.getByText('4:3'));
    expect(adj().aspectRatio).toBeCloseTo(3 / 4, 6);

    // 原始比例 = 图像宽高比
    fireEvent.click(screen.getByText('原始'));
    expect(adj().aspectRatio).toBeCloseTo(4 / 3, 6);

    // 自由裁剪只清空比例约束
    fireEvent.click(screen.getByText('自由'));
    expect(adj().aspectRatio).toBeNull();
    expect(presetEl('自由').className).toContain('bg-accent');
  });

  it('非预设比例的“原始”预设保持激活且禁用方向切换', () => {
    renderPanel({}, { ...IMAGE, width: 4000, height: 2500 });
    fireEvent.click(screen.getByText('原始'));
    expect(adj().aspectRatio).toBeCloseTo(1.6, 6);
    expect(presetEl('原始').className).toContain('bg-accent');
    expect(toolButton('切换方向')).toBeDisabled();
  });

  it('方向切换按钮在横纵比例间反转并更新图标', () => {
    renderPanel({ aspectRatio: 4 / 3 });
    const heading = screen.getByRole('heading', { name: '宽高比' });
    const orientationButton = heading.querySelectorAll('button')[1] as HTMLButtonElement;
    expect(orientationButton.querySelector('svg')!.getAttribute('class')).toContain('lucide-rectangle-horizontal');

    fireEvent.click(orientationButton);
    expect(adj().aspectRatio).toBeCloseTo(0.75, 6);
    expect(orientationButton.querySelector('svg')!.getAttribute('class')).toContain('lucide-rectangle-vertical');

    fireEvent.click(orientationButton);
    expect(adj().aspectRatio).toBeCloseTo(4 / 3, 6);
    expect(orientationButton.querySelector('svg')!.getAttribute('class')).toContain('lucide-rectangle-horizontal');
  });

  it('纵向偏好影响预设与自定义比例的默认方向', async () => {
    renderPanel({ aspectRatio: 0.75 });
    fireEvent.click(screen.getByText('16:9'));
    expect(adj().aspectRatio).toBeCloseTo(9 / 16, 6);

    // 纵向偏好保留，自由后自定义仍为纵向 1/1.618
    fireEvent.click(screen.getByText('自由'));
    await wait(20);
    fireEvent.click(screen.getByText('自定义'));
    expect(adj().aspectRatio).toBeCloseTo(1 / 1.618, 6);
  });

  it('自定义比例输入、应用与 Esc 还原', async () => {
    renderPanel();
    fireEvent.click(screen.getByText('自定义'));
    expect(adj().aspectRatio).toBeCloseTo(1.618, 6);
    expect(presetEl('自定义').className).toContain('bg-accent');

    const widthInput = screen.getByPlaceholderText('宽') as HTMLInputElement;
    const heightInput = screen.getByPlaceholderText('高') as HTMLInputElement;
    await waitFor(() => expect(widthInput.value).toBe('161.8'));
    expect(heightInput.value).toBe('100');

    fireEvent.change(widthInput, { target: { name: 'customW', value: '7' } });
    fireEvent.change(heightInput, { target: { name: 'customH', value: '3' } });
    fireEvent.blur(widthInput);
    expect(adj().aspectRatio).toBeCloseTo(7 / 3, 6);

    // Esc 放弃未提交的输入并恢复为当前比例
    fireEvent.change(widthInput, { target: { name: 'customW', value: '2.5' } });
    fireEvent.keyDown(widthInput, { key: 'Escape' });
    expect(widthInput.value).toBe('233.3');
    expect(adj().aspectRatio).toBeCloseTo(7 / 3, 6);
  });

  it('构图叠加按钮与 O / Shift+O 循环全部 8 种叠加', () => {
    renderPanel();
    const overlayButton = screen.getByRole('heading', { name: '宽高比' }).querySelectorAll('button')[0] as HTMLButtonElement;
    fireEvent.click(overlayButton);
    expect(useEditorStore.getState().overlayMode).toBe('diagonal');

    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      fireEvent.keyDown(window, { key: 'o' });
      seen.push(useEditorStore.getState().overlayMode);
    }
    expect(seen).toEqual([
      'goldenTriangle',
      'goldenSpiral',
      'phiGrid',
      'armature',
      'center',
      'none',
      'thirds',
      'diagonal',
    ]);

    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(window, { key: 'O', shiftKey: true });
    }
    expect(useEditorStore.getState().overlayRotation).toBe(0);
    fireEvent.keyDown(window, { key: 'O', shiftKey: true });
    expect(useEditorStore.getState().overlayRotation).toBe(1);

    act(() => useEditorStore.getState().setEditor({ overlayMode: 'goldenSpiral' }));
    expect(toolButton('叠加：螺旋（Shift+O 旋转）')).toBeInTheDocument();
  });

  it('输入框聚焦或带修饰键时忽略叠加快捷键', async () => {
    renderPanel();
    fireEvent.click(screen.getByText('自定义'));
    const widthInput = screen.getByPlaceholderText('宽') as HTMLInputElement;
    widthInput.focus();
    fireEvent.keyDown(window, { key: 'o' });
    expect(useEditorStore.getState().overlayMode).toBe('thirds');

    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(useEditorStore.getState().overlayMode).toBe('thirds');
    await wait(20);
  });

  it('精细旋转滑块写入 rotation，重置按钮恢复 0', async () => {
    renderPanel({ rotation: 12.3 });
    const slider = fineRotationSlider();
    expect(Number(slider.min)).toBe(-45);
    expect(Number(slider.max)).toBe(45);
    expect(Number(slider.step)).toBeCloseTo(0.1, 6);
    expect(document.querySelector('.slider-value-display')!.textContent).toBe('12.3°');

    fireEvent.change(slider, { target: { value: '20' } });
    expect(adj().rotation).toBe(20);

    const reset = document.querySelector('button[data-tooltip="重置精细旋转"]') as HTMLButtonElement;
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(adj().rotation).toBe(0);
    expect(useEditorStore.getState().liveRotation).toBeNull();
    await waitFor(() => expect(slider.value).toBe('0'));
  });

  it('旋转滑块拖动期间写入 liveRotation，释放后提交到 adjustment', () => {
    renderPanel({ rotation: 0 });
    const slider = fineRotationSlider();
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 20,
      right: 200,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseDown(slider, { button: 0, clientX: 100 });
    expect(useEditorStore.getState().isRotationActive).toBe(true);

    fireEvent.mouseMove(window, { clientX: 200 });
    expect(useEditorStore.getState().liveRotation).toBe(45);

    fireEvent.mouseUp(window);
    expect(useEditorStore.getState().isRotationActive).toBe(false);
    expect(useEditorStore.getState().liveRotation).toBeNull();
    expect(adj().rotation).toBe(45);
  });

  it('拉直工具切换全局状态', () => {
    renderPanel();
    const straighten = document.querySelector('button[data-tooltip="拉直工具（S）"]') as HTMLButtonElement;
    fireEvent.click(straighten);
    expect(useEditorStore.getState().isStraightenActive).toBe(true);
    fireEvent.click(straighten);
    expect(useEditorStore.getState().isStraightenActive).toBe(false);
  });

  it('旋转后自动裁剪黑边（400ms 防抖），关闭开关后不再改写裁剪', async () => {
    renderPanel({ rotation: 5 });
    const toggle = document.querySelector('label button[aria-pressed]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(adj().crop).toBeNull();

    await wait(500);
    const autoCrop = adj().crop;
    expect(autoCrop).not.toBeNull();
    expect(autoCrop!.width).toBeGreaterThan(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      useEditorStore.setState({ adjustments: { ...adj(), rotation: 12 } } as never);
    });
    await wait(500);
    expect(adj().crop).toEqual(autoCrop);
  });

  it('AI 自动拉直把弧度结果累加到当前旋转', async () => {
    renderPanel({ rotation: 10 });
    mockInvoke.mockResolvedValueOnce(Math.PI / 4);

    fireEvent.click(toolButton('AI 自动拉直'));
    await waitFor(() => expect(adj().rotation).toBeCloseTo(55, 6));
    expect(mockInvoke).toHaveBeenCalledWith('detect_straighten_angle', { path: IMAGE.path });
  });

  it('AI 自动拉直失败时保持原旋转并记录错误', async () => {
    renderPanel({ rotation: 10 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce(new Error('detect failed'));

    fireEvent.click(toolButton('AI 自动拉直'));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(adj().rotation).toBe(10);
  });

  it('向左/向右旋转 90° 更新 orientationSteps 与交互比例', () => {
    renderPanel({ aspectRatio: 4 / 3, orientationSteps: 0, rotation: 8 });
    fireEvent.click(screen.getByText('向左旋转'));
    expect(adj().orientationSteps).toBe(3);
    expect(adj().aspectRatio).toBeCloseTo(0.75, 6);
    expect(adj().rotation).toBe(0);
    expect(adj().crop).not.toBeNull();

    fireEvent.click(screen.getByText('向右旋转'));
    expect(adj().orientationSteps).toBe(0);
    expect(adj().aspectRatio).toBeCloseTo(4 / 3, 6);
  });

  it('水平/垂直翻转独立切换并高亮', () => {
    renderPanel();
    const h = screen.getByText('水平翻转').closest('[data-tooltip]') as HTMLElement;
    const v = screen.getByText('垂直翻转').closest('[data-tooltip]') as HTMLElement;

    fireEvent.click(h);
    expect(adj().flipHorizontal).toBe(true);
    expect(adj().flipVertical).toBe(false);
    expect(h.className).toContain('bg-accent');

    fireEvent.click(v);
    expect(adj().flipVertical).toBe(true);
    expect(v.className).toContain('bg-accent');

    fireEvent.click(h);
    expect(adj().flipHorizontal).toBe(false);
    expect(h.className).not.toContain('bg-accent');
  });

  it('重置恢复比例、裁剪、方向、几何、引导线与镜头字段', async () => {
    renderPanel({
      aspectRatio: 0.75,
      crop: { unit: 'px', x: 10, y: 20, width: 100, height: 200 },
      flipHorizontal: true,
      flipVertical: true,
      orientationSteps: 2,
      rotation: 12,
      transformDistortion: 5,
      transformVertical: 6,
      transformHorizontal: 7,
      transformRotate: 8,
      transformAspect: 9,
      transformScale: 120,
      transformXOffset: 10,
      transformYOffset: 11,
      guidedPerspective: {
        enabled: true,
        autoCrop: false,
        lines: [{ id: 'l1', type: 'vertical', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } }],
      },
      lensCorrectionMode: 'auto',
      lensMaker: 'Canon',
      lensModel: 'EF 50mm',
      lensDistortionAmount: 80,
      lensVignetteAmount: 70,
      lensTcaAmount: 60,
      lensDistortionEnabled: false,
      lensTcaEnabled: false,
      lensVignetteEnabled: false,
      lensDistortionParams: DISTORTION_PARAMS,
    });
    act(() => useEditorStore.getState().setEditor({ overlayMode: 'none', overlayRotation: 2 }));

    fireEvent.click(toolButton('重置裁剪和变换'));

    const reset = adj();
    expect(reset.aspectRatio).toBeCloseTo(4 / 3, 6);
    expect(reset.crop).toEqual(INITIAL_ADJUSTMENTS.crop);
    expect(reset.flipHorizontal).toBe(false);
    expect(reset.flipVertical).toBe(false);
    expect(reset.orientationSteps).toBe(0);
    expect(reset.rotation).toBe(0);
    expect(reset.transformDistortion).toBe(0);
    expect(reset.transformVertical).toBe(0);
    expect(reset.transformHorizontal).toBe(0);
    expect(reset.transformRotate).toBe(0);
    expect(reset.transformAspect).toBe(0);
    expect(reset.transformScale).toBe(100);
    expect(reset.transformXOffset).toBe(0);
    expect(reset.transformYOffset).toBe(0);
    expect(reset.guidedPerspective).toEqual(INITIAL_ADJUSTMENTS.guidedPerspective);
    expect(reset.lensMaker).toBeNull();
    expect(reset.lensModel).toBeNull();
    expect(reset.lensDistortionAmount).toBe(100);
    expect(reset.lensVignetteAmount).toBe(100);
    expect(reset.lensTcaAmount).toBe(100);
    expect(reset.lensDistortionEnabled).toBe(true);
    expect(reset.lensTcaEnabled).toBe(true);
    expect(reset.lensVignetteEnabled).toBe(true);
    expect(reset.lensDistortionParams).toBeNull();
    expect(useEditorStore.getState().overlayMode).toBe('thirds');
    expect(useEditorStore.getState().liveRotation).toBeNull();
  });

  it('引导透视开关切换绘图状态', () => {
    renderPanel();
    const button = screen.getByRole('button', { name: /引导透视/ });
    fireEvent.click(button);
    expect(useEditorStore.getState().isGuidedPerspectiveActive).toBe(true);
    expect(screen.getByText('绘图中')).toBeInTheDocument();
    expect(screen.getByText('取消')).toBeInTheDocument();

    fireEvent.click(button);
    expect(useEditorStore.getState().isGuidedPerspectiveActive).toBe(false);
  });

  it('引导线列表显示数量并在删除时更新 enabled 状态', () => {
    renderPanel({
      guidedPerspective: {
        enabled: true,
        autoCrop: true,
        lines: [
          { id: 'l1', type: 'vertical', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } },
          { id: 'l2', type: 'horizontal', p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
          { id: 'l3', type: 'vertical', p1: { x: 1, y: 0 }, p2: { x: 1, y: 1 } },
        ],
      },
    });
    expect(screen.getByText('活跃引导线')).toBeInTheDocument();
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
    expect(screen.getByText('vertical Guide #1')).toBeInTheDocument();

    const row = screen.getByText('vertical Guide #1').closest('.flex.items-center.gap-2') as HTMLElement;
    fireEvent.click(within(row).getByRole('button'));
    expect(adj().guidedPerspective!.lines).toHaveLength(2);
    expect(adj().guidedPerspective!.enabled).toBe(true);

    const row2 = screen.getByText('horizontal Guide #1').closest('.flex.items-center.gap-2') as HTMLElement;
    fireEvent.click(within(row2).getByRole('button'));
    expect(adj().guidedPerspective!.lines).toHaveLength(1);
    expect(adj().guidedPerspective!.enabled).toBe(false);
  });
});

describe('裁剪与变换 · 变换模态', () => {
  it('打开时回填 8 个滑块；预览缺失时应用禁用，取消关闭', async () => {
    mockInvoke.mockImplementation(() => Promise.resolve(undefined));
    renderPanel({ transformDistortion: 12, transformVertical: -5, transformScale: 120 });
    const pane = await openTransformModal();

    expect(within(pane).getAllByRole('slider')).toHaveLength(8);
    await waitFor(() => expect(getSlider('数量', pane).value).toBe('12'));
    expect(getSlider('垂直', pane).value).toBe('-5');
    expect(getSlider('缩放', pane).value).toBe('120');
    expect(screen.queryByAltText('Transform Preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(document.querySelector('.modal-adjustments-pane')).toBeNull());
  });

  it('8 个滑块修改后应用写回全部 transform 字段', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    const pane = await openTransformModal();
    await screen.findByAltText('Transform Preview');

    fireEvent.change(getSlider('数量', pane), { target: { value: '20' } });
    fireEvent.change(getSlider('垂直', pane), { target: { value: '-15' } });
    fireEvent.change(getSlider('水平', pane), { target: { value: '30' } });
    fireEvent.change(getSlider('旋转', pane), { target: { value: '10.5' } });
    fireEvent.change(getSlider('纵横比', pane), { target: { value: '5' } });
    fireEvent.change(getSlider('缩放', pane), { target: { value: '130' } });
    fireEvent.change(getSlider('X 轴', pane), { target: { value: '-20' } });
    fireEvent.change(getSlider('Y 轴', pane), { target: { value: '25' } });

    expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '应用' }));

    expect(adj().transformDistortion).toBe(20);
    expect(adj().transformVertical).toBe(-15);
    expect(adj().transformHorizontal).toBe(30);
    expect(adj().transformRotate).toBe(10.5);
    expect(adj().transformAspect).toBe(5);
    expect(adj().transformScale).toBe(130);
    expect(adj().transformXOffset).toBe(-20);
    expect(adj().transformYOffset).toBe(25);
  });

  it('重置变换恢复默认参数并刷新预览', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    const pane = await openTransformModal();
    await screen.findByAltText('Transform Preview');

    fireEvent.change(getSlider('数量', pane), { target: { value: '40' } });
    fireEvent.click(toolButton('重置变换'));
    await waitFor(() => expect(getSlider('数量', pane).value).toBe('0'));
    await waitFor(() => expect(previewCalls().at(-1)?.params.distortion).toBe(0));
  });

  it('网格开关切换三分线，交互时显示密集网格', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    const pane = await openTransformModal();
    await screen.findByAltText('Transform Preview');

    const gridRoot = document.querySelector('.modal-preview-pane .z-10') as HTMLElement;
    const thirds = gridRoot.children[0] as HTMLElement;
    const dense = gridRoot.children[1] as HTMLElement;
    expect(thirds.className).toContain('opacity-100');
    expect(dense.className).toContain('opacity-0');

    fireEvent.pointerDown(pane.querySelector('.grow')!);
    expect(dense.className).toContain('opacity-100');
    fireEvent.mouseUp(window);
    expect(dense.className).toContain('opacity-0');

    fireEvent.click(toolButton('切换网格'));
    expect(thirds.className).toContain('opacity-0');
  });

  it('辅助线开关以 showLines 参数请求预览', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    await openTransformModal();
    await screen.findByAltText('Transform Preview');

    fireEvent.click(toolButton('切换辅助线'));
    await waitFor(() => expect(previewCalls().some((call) => call.showLines === true)).toBe(true));
    expect(toolButton('切换辅助线').className).toContain('bg-white/20');

    await wait(60);
    fireEvent.click(toolButton('切换辅助线'));
    await waitFor(() => expect(previewCalls().at(-1)?.showLines).toBe(false));
  });

  it('缩放按钮、滚轮与重置缩放更新百分比，拖拽平移预览', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    await openTransformModal();
    const img = await screen.findByAltText('Transform Preview');

    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.click(toolButton('放大'));
    expect(screen.getByText('125%')).toBeInTheDocument();
    fireEvent.click(toolButton('缩小'));
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.click(toolButton('放大'));
    fireEvent.click(toolButton('放大'));
    expect(screen.getByText('150%')).toBeInTheDocument();
    fireEvent.click(toolButton('重置缩放'));
    expect(screen.getByText('100%')).toBeInTheDocument();

    const container = document.querySelector('.modal-preview-pane .flex-1') as HTMLElement;
    fireEvent.mouseDown(container, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 140 });
    fireEvent.mouseUp(window);

    const transformed = img.parentElement!.parentElement as HTMLElement;
    expect(transformed.style.transform).toBe('translate(60px, 40px) scale(1)');
  });

  it('按住对比使用默认参数预览并显示原始标记', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    await openTransformModal();
    await screen.findByAltText('Transform Preview');

    const compare = toolButton('按住以对比');
    const previewPane = document.querySelector('.modal-preview-pane') as HTMLElement;
    fireEvent.mouseDown(compare);
    expect(await within(previewPane).findByText('原始')).toBeInTheDocument();
    expect(compare.className).toContain('bg-accent');
    await waitFor(() => expect(previewCalls().at(-1)?.params.distortion).toBe(0));
    expect(previewCalls().at(-1)?.showLines).toBe(false);

    fireEvent.mouseUp(compare);
    expect(within(previewPane).queryByText('原始')).not.toBeInTheDocument();
  });

  it('存在蒙版时显示几何偏移警告', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel({ masks: [{ id: 'm1' } as any] });
    await openTransformModal();
    expect(screen.getByText(/变换会更新基础几何形状/)).toBeInTheDocument();
    expect(screen.getByText(/AI 蒙版需要重新生成/)).toBeInTheDocument();
  });

  it('Esc 关闭变换模态', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_geometry_transform' ? 'blob:transform-preview' : undefined),
    );
    renderPanel();
    await openTransformModal();
    await screen.findByAltText('Transform Preview');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.modal-adjustments-pane')).toBeNull(), { timeout: 1500 });
  });
});

describe('裁剪与变换 · 镜头校正模态', () => {
  it('打开后显示手动模式、镜头下拉、校正开关与数据库声明', async () => {
    installLensMocks({
      myLenses: [{ maker: 'Canon', model: 'EF 50mm f/1.8' }],
      params: null,
    });
    renderPanel();
    const pane = await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    expect(screen.getByRole('button', { name: '手动' })).toBeInTheDocument();
    expect(screen.getByText('手动选择')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择已保存的镜头' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择制造商' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '畸变' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '色差' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '暗角' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Lensfun 项目' })).toHaveAttribute('href', 'https://lensfun.github.io/');
    expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
    expect(within(pane).queryAllByRole('slider')).toHaveLength(0);
  });

  it('选择已保存镜头后加载参数、启用畸变并支持开关与数量', async () => {
    installLensMocks({
      myLenses: [{ maker: 'Canon', model: 'EF 50mm f/1.8' }],
      params: DISTORTION_PARAMS,
    });
    renderPanel();
    const pane = await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '选择已保存的镜头' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Canon - EF 50mm f/1.8' }));

    await waitFor(() => expect(screen.getByRole('checkbox', { name: '畸变' })).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: '畸变' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '色差' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '暗角' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Canon' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'EF 50mm f/1.8' })).toBeInTheDocument());

    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(1));
    const amount = within(pane).getByRole('slider') as HTMLInputElement;
    expect(Number(amount.min)).toBe(0);
    expect(Number(amount.max)).toBe(200);
    expect(amount.value).toBe('100');

    fireEvent.change(amount, { target: { value: '150' } });
    await waitFor(() => expect(previewCalls().at(-1)?.params.lens_distortion_amount).toBe(1.5));
    expect(mockInvoke).toHaveBeenCalledWith('get_lens_distortion_params', {
      maker: 'Canon',
      model: 'EF 50mm f/1.8',
      focalLength: null,
      aperture: null,
      distance: null,
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '畸变' }));
    await waitFor(() => expect(within(pane).queryAllByRole('slider')).toHaveLength(0));
    fireEvent.click(screen.getByRole('checkbox', { name: '畸变' }));
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(1));
  });

  it('手动选择制造商与型号时联动加载镜头列表和畸变参数', async () => {
    installLensMocks({ params: DISTORTION_PARAMS });
    renderPanel();
    const pane = await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '选择制造商' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Canon' }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('get_lensfun_lenses_for_maker', { maker: 'Canon' }));

    const modelTrigger = await screen.findByRole('button', { name: '选择镜头型号' });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole('option', { name: 'EF 50mm f/1.8' }));

    await waitFor(() => expect(screen.getByRole('checkbox', { name: '畸变' })).toBeEnabled());
    expect(mockInvoke).toHaveBeenCalledWith('get_lens_distortion_params', {
      maker: 'Canon',
      model: 'EF 50mm f/1.8',
      focalLength: null,
      aperture: null,
      distance: null,
    });
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(1));
  });

  it('自动检测成功：检测中提示、回填镜头并启用校正', async () => {
    let resolveDetect!: (value: any) => void;
    const pending = new Promise((resolve) => {
      resolveDetect = resolve;
    });
    installLensMocks({ autodetect: pending, params: DISTORTION_PARAMS });
    renderPanel(
      {},
      {
        ...IMAGE,
        exif: {
          Make: 'Canon',
          LensModel: 'EF 50mm f/1.8',
          FocalLength: '50',
          FNumber: '2.8',
          SubjectDistance: '5',
        },
      },
    );
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(await screen.findByText('检测 EXIF 中...')).toBeInTheDocument();

    await act(async () => {
      resolveDetect(['Canon', 'EF 50mm f/1.8']);
    });
    expect(await screen.findByText('Canon - EF 50mm f/1.8')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('autodetect_lens', { maker: 'Canon', model: 'EF 50mm f/1.8' });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '畸变' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '手动' }));
    expect(screen.getByText('手动选择')).toBeInTheDocument();
  });

  it('缺少 EXIF 或镜头型号时自动检测直接提示未找到', async () => {
    installLensMocks({});
    renderPanel({}, { ...IMAGE, exif: null });
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(await screen.findByText('未找到镜头配置文件')).toBeInTheDocument();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'autodetect_lens')).toBe(false);
  });

  it('有制造商但缺少镜头型号时不调用自动检测', async () => {
    installLensMocks({});
    renderPanel({}, { ...IMAGE, exif: { Make: 'Canon' } });
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(await screen.findByText('未找到镜头配置文件')).toBeInTheDocument();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'autodetect_lens')).toBe(false);
  });

  it('自动检测无结果时清空镜头并提示未找到', async () => {
    installLensMocks({ autodetect: Promise.resolve(null) });
    renderPanel({}, { ...IMAGE, exif: { Make: 'Canon', LensModel: 'Unknown Lens' } });
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(await screen.findByText('未找到镜头配置文件')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('autodetect_lens', { maker: 'Canon', model: 'Unknown Lens' });
  });

  it('自动检测异常时提示未找到', async () => {
    installLensMocks({ autodetect: () => Promise.reject(new Error('detect boom')) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPanel({}, { ...IMAGE, exif: { Make: 'Canon', LensModel: 'EF 50mm f/1.8' } });
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(await screen.findByText('未找到镜头配置文件')).toBeInTheDocument();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });

  it('重置镜头校正恢复默认参数与手动模式', async () => {
    installLensMocks({
      myLenses: [{ maker: 'Canon', model: 'EF 50mm f/1.8' }],
      params: DISTORTION_PARAMS,
    });
    renderPanel();
    const pane = await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '选择已保存的镜头' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Canon - EF 50mm f/1.8' }));
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(1));
    fireEvent.change(within(pane).getByRole('slider'), { target: { value: '150' } });

    fireEvent.click(toolButton('重置镜头校正'));
    await waitFor(() => expect(within(pane).queryAllByRole('slider')).toHaveLength(0));
    expect(screen.getByRole('button', { name: '选择制造商' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'EF 50mm f/1.8' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '畸变' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '畸变' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(adj().lensCorrectionMode).toBe('manual');
    expect(adj().lensMaker).toBeNull();
    expect(adj().lensModel).toBeNull();
    expect(adj().lensDistortionParams).toBeNull();
    expect(adj().lensDistortionAmount).toBe(100);
    expect(adj().lensDistortionEnabled).toBe(true);
  });

  it('应用镜头校正写回 store', async () => {
    installLensMocks({
      myLenses: [{ maker: 'Canon', model: 'EF 50mm f/1.8' }],
      params: DISTORTION_PARAMS,
    });
    renderPanel();
    const pane = await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '选择已保存的镜头' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Canon - EF 50mm f/1.8' }));
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(1));
    fireEvent.change(within(pane).getByRole('slider'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));

    expect(adj().lensCorrectionMode).toBe('manual');
    expect(adj().lensMaker).toBe('Canon');
    expect(adj().lensModel).toBe('EF 50mm f/1.8');
    expect(adj().lensDistortionAmount).toBe(150);
    expect(adj().lensDistortionEnabled).toBe(true);
    expect(adj().lensDistortionParams).toEqual(DISTORTION_PARAMS);
  });

  it('三项校正可用时同时显示三个数量滑块并写回各自数值', async () => {
    installLensMocks({
      myLenses: [{ maker: 'Canon', model: 'EF 24-70mm f/2.8' }],
      lenses: ['EF 24-70mm f/2.8'],
      params: ALL_PARAMS,
    });
    renderPanel();
    const pane = await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    fireEvent.click(screen.getByRole('button', { name: '选择已保存的镜头' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Canon - EF 24-70mm f/2.8' }));
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(3));

    for (const name of ['畸变', '色差', '暗角']) {
      expect(screen.getByRole('checkbox', { name })).toBeEnabled();
      expect(screen.getByRole('checkbox', { name })).toBeChecked();
    }

    const sliders = within(pane).getAllByRole('slider') as HTMLInputElement[];
    fireEvent.change(sliders[0], { target: { value: '110' } });
    fireEvent.change(sliders[1], { target: { value: '120' } });
    fireEvent.change(sliders[2], { target: { value: '130' } });

    fireEvent.click(screen.getByRole('checkbox', { name: '色差' }));
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(2));
    fireEvent.click(screen.getByRole('checkbox', { name: '色差' }));
    await waitFor(() => expect(within(pane).getAllByRole('slider')).toHaveLength(3));

    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(adj().lensDistortionAmount).toBe(110);
    expect(adj().lensTcaAmount).toBe(120);
    expect(adj().lensVignetteAmount).toBe(130);
  });

  it('按住对比显示原始并关闭镜头开关进行预览', async () => {
    installLensMocks({ params: ALL_PARAMS });
    renderPanel({
      lensDistortionAmount: 110,
      lensTcaAmount: 120,
      lensVignetteAmount: 130,
      lensDistortionParams: ALL_PARAMS,
    });
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');

    const compare = toolButton('按住以对比');
    const previewPane = document.querySelector('.modal-preview-pane') as HTMLElement;
    fireEvent.mouseDown(compare);
    expect(await within(previewPane).findByText('原始')).toBeInTheDocument();
    await waitFor(() => {
      const last = previewCalls().at(-1);
      expect(last?.params.lens_distortion_enabled).toBe(false);
      expect(last?.params.lens_tca_enabled).toBe(false);
      expect(last?.params.lens_vignette_enabled).toBe(false);
      expect(last?.params.lens_distortion_amount).toBe(1.1);
    });

    fireEvent.mouseUp(compare);
    expect(within(previewPane).queryByText('原始')).not.toBeInTheDocument();
  });

  it('缩放按钮、滚轮、重置缩放与拖拽平移', async () => {
    installLensMocks({});
    renderPanel();
    await openLensModal();
    const img = await screen.findByAltText('Lens Correction Preview');
    const container = document.querySelector('.modal-preview-pane .flex-1') as HTMLElement;

    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.click(toolButton('放大'));
    expect(screen.getByText('125%')).toBeInTheDocument();
    fireEvent.click(toolButton('缩小'));
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.wheel(container, { deltaY: -500 });
    expect(screen.getByText('150%')).toBeInTheDocument();
    fireEvent.click(toolButton('重置缩放'));
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.mouseDown(container, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 140 });
    fireEvent.mouseUp(window);
    const transformed = img.parentElement!.parentElement as HTMLElement;
    expect(transformed.style.transform).toBe('translate(60px, 40px) scale(1)');
  });

  it('存在蒙版时显示警告，点击遮罩关闭模态', async () => {
    installLensMocks({});
    renderPanel({ masks: [{ id: 'm1' } as any] });
    await openLensModal();
    await screen.findByAltText('Lens Correction Preview');
    expect(screen.getByText(/镜头校正会更新基础几何形状/)).toBeInTheDocument();
    expect(screen.getByText(/AI 蒙版需要重新生成/)).toBeInTheDocument();

    const backdrop = document.querySelector('.fixed.inset-0.z-50') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    await waitFor(() => expect(document.querySelector('.modal-adjustments-pane')).toBeNull(), { timeout: 1500 });
  });

describe('裁剪与变换 · 用户交互体验', () => {
  it('裁剪预设为原生按钮，选中态通过 aria-pressed 暴露并支持键盘激活', async () => {
    const user = userEvent.setup();
    renderPanel();
    const free = screen.getByRole('button', { name: '自由' });
    const square = screen.getByRole('button', { name: '1:1' });
    expect(free.tagName).toBe('BUTTON');
    expect(free).toHaveAttribute('type', 'button');
    expect(free).toHaveAttribute('aria-pressed', 'true');
    expect(square).toHaveAttribute('aria-pressed', 'false');

    square.focus();
    await user.keyboard('{Enter}');
    expect(adj().aspectRatio).toBe(1);
    expect(square).toHaveAttribute('aria-pressed', 'true');
    expect(free).toHaveAttribute('aria-pressed', 'false');

    const fourThree = screen.getByRole('button', { name: '4:3' });
    fourThree.focus();
    await user.keyboard(' ');
    expect(adj().aspectRatio).toBeCloseTo(4 / 3, 6);
    expect(fourThree).toHaveAttribute('aria-pressed', 'true');
  });

  it('方向与几何磁贴均为可聚焦按钮，键盘可旋转与翻转', async () => {
    const user = userEvent.setup();
    renderPanel();
    for (const name of ['向左旋转', '向右旋转', '水平翻转', '垂直翻转', '变换', '镜头']) {
      const tile = screen.getByRole('button', { name });
      expect(tile.tagName).toBe('BUTTON');
      expect(tile).toHaveAttribute('type', 'button');
      expect(tile).toHaveAttribute('tabindex', '0');
    }

    const rotateLeft = screen.getByRole('button', { name: '向左旋转' });
    rotateLeft.focus();
    await user.keyboard('{Enter}');
    expect(adj().orientationSteps).toBe(3);
    expect(rotateLeft).toHaveAttribute('tabindex', '0');

    const flipH = screen.getByRole('button', { name: '水平翻转' });
    expect(flipH).toHaveAttribute('aria-pressed', 'false');
    flipH.focus();
    await user.keyboard(' ');
    expect(adj().flipHorizontal).toBe(true);
    expect(flipH).toHaveAttribute('aria-pressed', 'true');
  });

  it('自动裁剪开关与旋转归零按钮具备可访问名称和禁用反馈', async () => {
    const user = userEvent.setup();
    renderPanel({ rotation: 12 });
    const autoCrop = screen.getByRole('button', { name: '旋转后自动裁剪黑边' });
    expect(autoCrop).toHaveAttribute('aria-pressed', 'true');
    await user.click(autoCrop);
    expect(autoCrop).toHaveAttribute('aria-pressed', 'false');

    const resetFine = screen.getByRole('button', { name: '重置精细旋转' });
    expect(resetFine).toBeEnabled();
    resetFine.focus();
    await user.keyboard('{Enter}');
    expect(adj().rotation).toBe(0);
    expect(resetFine).toBeDisabled();
  });

  it('自由比例下方向切换禁用并说明原因，选择比例后恢复可用', async () => {
    renderPanel();
    const toggle = screen.getByRole('button', { name: '切换方向' });
    expect(toggle).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '4:3' }));
    const enabledToggle = screen.getByRole('button', { name: '切换为纵向' });
    expect(enabledToggle).toBeEnabled();
    fireEvent.click(enabledToggle);
    expect(adj().aspectRatio).toBeCloseTo(3 / 4, 6);
    expect(screen.getByRole('button', { name: '切换为横向' })).toBeEnabled();
  });

  it('拉直与 AI 拉直入口以可访问名称和按下态反馈状态', () => {
    renderPanel();
    const straighten = screen.getByRole('button', { name: '拉直工具（S）' });
    expect(straighten).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(straighten);
    expect(straighten).toHaveAttribute('aria-pressed', 'true');
    expect(useEditorStore.getState().isStraightenActive).toBe(true);

    expect(screen.getByRole('button', { name: 'AI 自动拉直' })).toBeEnabled();
  });

  it('变换模态以 dialog 语义暴露模态名称', async () => {
    renderPanel();
    await openTransformModal();
    const dialog = screen.getByRole('dialog', { name: '变换' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('镜头校正模态以 dialog 语义暴露模态名称', async () => {
    installLensMocks({});
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '镜头' }));
    const dialog = await screen.findByRole('dialog', { name: '镜头校正' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
});
