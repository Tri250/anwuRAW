import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ControlsPanel from '../../src/components/panel/right/ControlsPanel';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../../src/utils/adjustments';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useUIStore } from '../../src/store/useUIStore';
import { debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { mockInvoke } from './setup';

const { showContextMenu } = vi.hoisted(() => ({ showContextMenu: vi.fn() }));

vi.mock('../../src/context/ContextMenuContext', () => ({
  useContextMenu: () => ({ showContextMenu }),
}));

type WaveformStubProps = {
  waveformData: unknown;
  histogram: unknown;
  displayMode: string;
  setDisplayMode: (mode: string) => void;
  showClipping?: boolean;
  onToggleClipping?: () => void;
  onHistogramZoneAdjust?: (zone: string, deltaX: number, containerWidth: number) => void;
  onHistogramZoneReset?: (zone: string) => void;
  onHistogramZoneDragStateChange?: (isDragging: boolean) => void;
  theme?: string;
};

vi.mock('../../src/components/panel/editor/Waveform', () => ({
  default: (props: WaveformStubProps) => (
    <div
      data-testid="waveform-stub"
      data-mode={props.displayMode}
      data-clipping={String(props.showClipping)}
      data-theme={props.theme}
    >
      <button onClick={props.onToggleClipping}>toggle-clipping</button>
      <button onClick={() => props.onHistogramZoneAdjust?.('exposure', 100, 200)}>adjust-exposure</button>
      <button onClick={() => props.onHistogramZoneAdjust?.('exposure', 1000, 200)}>adjust-exposure-large</button>
      <button onClick={() => props.onHistogramZoneAdjust?.('exposure', -1000, 200)}>adjust-exposure-negative</button>
      <button onClick={() => props.onHistogramZoneAdjust?.('exposure', 0, 200)}>adjust-noop</button>
      <button onClick={() => props.onHistogramZoneAdjust?.('exposure', 100, 0)}>adjust-zero-width</button>
      <button onClick={() => props.onHistogramZoneAdjust?.('bogus', 100, 200)}>adjust-bogus</button>
      <button onClick={() => props.onHistogramZoneReset?.('exposure')}>reset-exposure</button>
      <button onClick={() => props.onHistogramZoneReset?.('bogus')}>reset-bogus</button>
      <button onClick={() => props.onHistogramZoneDragStateChange?.(true)}>drag-start</button>
      <button onClick={() => props.onHistogramZoneDragStateChange?.(false)}>drag-end</button>
      <button onClick={() => props.setDisplayMode('rgb')}>mode-rgb</button>
    </div>
  ),
}));

type SectionStubProps = {
  adjustments: Adjustments;
  setAdjustments: (value: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => void;
  isWbPickerActive?: boolean;
  toggleWbPicker?: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
};

vi.mock('../../src/components/adjustments/sectionRegistry', () => {
  const makeStub = (name: string) =>
    function SectionStub(props: SectionStubProps) {
      return (
        <div data-testid={`section-${name}`} data-exposure={String(props.adjustments.exposure)}>
          <button onClick={() => props.setAdjustments((prev) => ({ ...prev, exposure: 3 }))}>
            {`section-bump-${name}`}
          </button>
          <button onClick={() => props.toggleWbPicker?.()}>{`section-wb-${name}`}</button>
          <button onClick={() => props.onDragStateChange?.(true)}>{`section-drag-${name}`}</button>
        </div>
      );
    };

  return {
    ADJUSTMENT_SECTION_COMPONENTS: {
      basic: makeStub('basic'),
      curves: makeStub('curves'),
      color: makeStub('color'),
      details: makeStub('details'),
      effects: makeStub('effects'),
      channel_mixer: makeStub('channel_mixer'),
    },
  };
});

type MenuOption = {
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: unknown;
};

const IMAGE = {
  path: '/photos/control.dng',
  width: 4000,
  height: 3000,
  isRaw: true,
  isReady: true,
  thumbnailUrl: '',
  exif: {},
};

const makeAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments =>
  ({
    ...INITIAL_ADJUSTMENTS,
    ...overrides,
  }) as Adjustments;

const seedStores = (
  adjustments: Partial<Adjustments> = {},
  extra: Record<string, unknown> = {},
) => {
  useEditorStore.setState({
    selectedImage: IMAGE,
    adjustments: makeAdjustments(adjustments),
    copiedSectionAdjustments: null,
    histogram: null,
    isWbPickerActive: false,
    isWaveformVisible: false,
    waveform: null,
    activeWaveformChannel: 'luma',
    waveformHeight: 256,
    isSliderDragging: false,
    ...extra,
  } as never);
  useSettingsStore.setState({ appSettings: null, theme: 'dark', osPlatform: 'linux' } as never);
  useUIStore.setState({
    collapsibleSectionsState: {
      basic: true,
      color: true,
      curves: true,
      details: true,
      effects: true,
    },
  } as never);
};

const renderPanel = (adjustments: Partial<Adjustments> = {}, extra: Record<string, unknown> = {}) => {
  seedStores(adjustments, extra);
  return render(<ControlsPanel />);
};

const adj = () => useEditorStore.getState().adjustments;

const toolButton = (tooltip: string): HTMLButtonElement | null =>
  document.querySelector(`button[data-tooltip="${tooltip}"]`);

const sectionRoot = (title: string): HTMLElement => {
  const heading = screen.getByText(title, { selector: 'h2' });
  const root = heading.closest('.bg-surface.rounded-lg');
  if (!root) throw new Error(`section root not found: ${title}`);
  return root as HTMLElement;
};

const menuOptions = (): MenuOption[] => (showContextMenu.mock.calls.at(-1)?.[2] || []) as MenuOption[];

const runMenu = (option: MenuOption | undefined) => {
  if (!option?.onClick) throw new Error(`menu option without handler: ${option?.label}`);
  act(() => option.onClick!());
};

// jsdom 未实现 PointerEvent，testing-library 会退化为普通 Event 而丢失 clientY；
// 这里用 MouseEvent 承载 pointer 类型并补齐 pointerId/pointerType。
const firePointer = (
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { pointerId: number; clientY: number; pointerType?: string; button?: number },
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY: init.clientY,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'touch' });
  fireEvent(target, event);
};

beforeEach(() => {
  showContextMenu.mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  seedStores();
});

afterEach(() => {
  debouncedSetHistory.cancel();
  vi.restoreAllMocks();
});

describe('调整面板外壳 · 基础渲染', () => {
  it('未选择图像时显示空状态，自动与重置按钮禁用，波形按钮仍可用', () => {
    renderPanel({}, { selectedImage: null });

    expect(screen.getByText('调整', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('未选择图像。')).toBeInTheDocument();
    expect(screen.queryByText('基础', { selector: 'h2' })).not.toBeInTheDocument();

    expect(toolButton('自动调整图像')).toBeDisabled();
    expect(toolButton('重置调整')).toBeDisabled();
    expect(toolButton('切换分析显示')).toBeEnabled();
  });

  it('选择图像后按注册表顺序渲染六个调整分区并传入当前调整值', () => {
    renderPanel({ exposure: 1.25 });

    const headings = Array.from(document.querySelectorAll('h2')).map((el) => el.textContent);
    expect(headings).toEqual(['调整', '基础', '曲线', '颜色', '细节', '效果', '通道混合器']);

    for (const name of ['basic', 'curves', 'color', 'details', 'effects', 'channel_mixer']) {
      expect(screen.getByTestId(`section-${name}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('section-basic').dataset.exposure).toBe('1.25');
  });

  it('分区组件通过 ControlsPanel 注入的 setter 更新调整并开启分区回调', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'section-bump-basic' }));
    expect(adj().exposure).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'section-wb-basic' }));
    expect(useEditorStore.getState().isWbPickerActive).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'section-drag-color' }));
    expect(useEditorStore.getState().isSliderDragging).toBe(true);
  });
});

describe('调整面板外壳 · 顶部工具栏', () => {
  it('自动调整调用后端并合并结果与分区可见性', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'calculate_auto_adjustments') {
        return Promise.resolve({
          exposure: 1.4,
          contrast: 12,
          sectionVisibility: { color: false },
        });
      }
      return Promise.resolve(undefined);
    });
    renderPanel();

    fireEvent.click(toolButton('自动调整图像')!);

    await waitFor(() => expect(adj().exposure).toBe(1.4));
    expect(adj().contrast).toBe(12);
    expect(adj().sectionVisibility.color).toBe(false);
    expect(adj().sectionVisibility.basic).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('calculate_auto_adjustments');
  });

  it('图像尚未就绪或未选择时自动调整不触发后端', async () => {
    renderPanel({}, { selectedImage: { ...IMAGE, isReady: false } });
    fireEvent.click(toolButton('自动调整图像')!);
    await act(async () => {});
    expect(mockInvoke).not.toHaveBeenCalledWith('calculate_auto_adjustments');

    useEditorStore.setState({ selectedImage: null } as never);
    fireEvent.click(toolButton('自动调整图像')!);
    await act(async () => {});
    expect(mockInvoke).not.toHaveBeenCalledWith('calculate_auto_adjustments');
  });

  it('重置调整只恢复分区字段与分区可见性，保留裁剪、蒙版等非分区状态', () => {
    const crop = { x: 1, y: 2, width: 30, height: 40 };
    renderPanel(
      {
        exposure: 2,
        contrast: 30,
        saturation: 25,
        toneMapper: 'agx',
        vignetteAmount: -50,
        channelMixer: { ...INITIAL_ADJUSTMENTS.channelMixer!, red_from_green: 25 },
        sectionVisibility: {
          basic: false,
          curves: false,
          color: false,
          details: false,
          effects: false,
          channel_mixer: false,
        },
        crop: crop as never,
        masks: [{ id: 'mask-1' }] as never,
      },
    );

    fireEvent.click(toolButton('重置调整')!);

    expect(adj().exposure).toBe(INITIAL_ADJUSTMENTS.exposure);
    expect(adj().contrast).toBe(INITIAL_ADJUSTMENTS.contrast);
    expect(adj().saturation).toBe(INITIAL_ADJUSTMENTS.saturation);
    expect(adj().toneMapper).toBe(INITIAL_ADJUSTMENTS.toneMapper);
    expect(adj().vignetteAmount).toBe(INITIAL_ADJUSTMENTS.vignetteAmount);
    expect(adj().channelMixer).toEqual(INITIAL_ADJUSTMENTS.channelMixer);
    expect(adj().sectionVisibility).toEqual(INITIAL_ADJUSTMENTS.sectionVisibility);
    expect(adj().crop).toEqual(crop);
    expect(adj().masks).toHaveLength(1);
  });
});

describe('调整面板外壳 · 分区折叠与可见性', () => {
  it('点击分区标题折叠/展开并写入 UI 状态', () => {
    renderPanel();
    const basic = sectionRoot('基础');
    expect(basic.querySelector('.lucide-chevron-down')!.getAttribute('class')).toContain('rotate-180');

    fireEvent.click(screen.getByText('基础', { selector: 'h2' }));
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(false);
    expect(basic.querySelector('.lucide-chevron-down')!.getAttribute('class')).not.toContain('rotate-180');

    fireEvent.click(screen.getByText('基础', { selector: 'h2' }));
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(true);
  });

  it('焦点模式打开某分区时关闭其他分区，关闭当前分区不移除其他分区', () => {
    seedStores({}, {});
    useSettingsStore.setState({ appSettings: { enableFocusMode: true } as never } as never);
    render(<ControlsPanel />);

    fireEvent.click(screen.getByText('曲线', { selector: 'h2' }));
    expect(useUIStore.getState().collapsibleSectionsState.curves).toBe(false);
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(true);

    fireEvent.click(screen.getByText('曲线', { selector: 'h2' }));
    expect(useUIStore.getState().collapsibleSectionsState).toMatchObject({
      basic: false,
      curves: true,
      color: false,
      details: false,
      effects: false,
    });

    fireEvent.click(screen.getByText('细节', { selector: 'h2' }));
    expect(useUIStore.getState().collapsibleSectionsState).toMatchObject({
      basic: false,
      curves: false,
      color: false,
      details: true,
      effects: false,
    });
  });

  it('Android 上取消折叠：无折叠箭头，点击标题不改变折叠状态', () => {
    seedStores({}, {});
    useSettingsStore.setState({ osPlatform: 'android' } as never);
    render(<ControlsPanel />);

    const basic = sectionRoot('基础');
    expect(basic.querySelector('.lucide-chevron-down')).toBeNull();
    fireEvent.click(screen.getByText('基础', { selector: 'h2' }));
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(true);
  });

  it('分区眼睛按钮切换 sectionVisibility，缺失可见性时回退初始值', () => {
    renderPanel({ sectionVisibility: undefined as never });
    const basic = sectionRoot('基础');

    fireEvent.click(basic.querySelector('button[data-tooltip="禁用部分"]')!);
    expect(adj().sectionVisibility.basic).toBe(false);
    expect(basic.querySelector('.opacity-30')).toBeInTheDocument();

    fireEvent.click(basic.querySelector('button[data-tooltip="启用部分"]')!);
    expect(adj().sectionVisibility.basic).toBe(true);
    expect(basic.querySelector('.opacity-30')).toBeNull();
  });
});

describe('调整面板外壳 · 分区右键菜单', () => {
  it('无剪贴板时粘贴禁用，复制后记录分区与值且不改变调整', () => {
    renderPanel({ exposure: 0.7 });
    fireEvent.contextMenu(sectionRoot('基础'));

    expect(menuOptions().map((option) => option.label)).toEqual([
      '复制 基础 设置',
      '粘贴设置',
      undefined,
      '重置 基础 设置',
    ]);
    expect(menuOptions()[1].disabled).toBe(true);
    runMenu(menuOptions()[1]);
    expect(adj().exposure).toBe(0.7);

    runMenu(menuOptions()[0]);
    expect(useEditorStore.getState().copiedSectionAdjustments).toEqual({
      section: 'basic',
      values: expect.objectContaining({ exposure: 0.7 }),
    });
  });

  it('复制颜色分区深拷贝嵌套对象，粘贴仅作用于同名分区并强制启用', () => {
    renderPanel({
      saturation: 42,
      hsl: {
        ...INITIAL_ADJUSTMENTS.hsl,
        reds: { hue: 15, saturation: 5, luminance: 3 },
      },
      sectionVisibility: {
        ...INITIAL_ADJUSTMENTS.sectionVisibility,
        color: false,
      },
    });

    fireEvent.contextMenu(sectionRoot('颜色'));
    runMenu(menuOptions()[0]);
    const copied = useEditorStore.getState().copiedSectionAdjustments;
    expect(copied.section).toBe('color');
    expect(copied.values.saturation).toBe(42);
    expect(copied.values.hsl.reds.hue).toBe(15);

    act(() => {
      useEditorStore.setState({
        adjustments: {
          ...adj(),
          saturation: 0,
          hsl: {
            ...adj().hsl,
            reds: { hue: 90, saturation: 0, luminance: 0 },
          },
        },
      } as never);
    });

    fireEvent.contextMenu(sectionRoot('基础'));
    expect(menuOptions()[1].label).toBe('粘贴 基础 设置');
    expect(menuOptions()[1].disabled).toBe(true);

    fireEvent.contextMenu(sectionRoot('颜色'));
    expect(menuOptions()[1].label).toBe('粘贴 颜色 设置');
    expect(menuOptions()[1].disabled).toBe(false);
    runMenu(menuOptions()[1]);

    expect(adj().saturation).toBe(42);
    expect(adj().hsl.reds.hue).toBe(15);
    expect(adj().sectionVisibility.color).toBe(true);
    // 深拷贝：后续修改源对象不影响已复制内容
    act(() => {
      useEditorStore.setState({
        adjustments: {
          ...adj(),
          hsl: {
            ...adj().hsl,
            reds: { hue: 77, saturation: 0, luminance: 0 },
          },
        },
      } as never);
    });
    expect(useEditorStore.getState().copiedSectionAdjustments.values.hsl.reds.hue).toBe(15);
  });

  it('重置分区恢复该分区默认值并保持其他分区不变', () => {
    renderPanel({
      exposure: 1.5,
      saturation: 30,
      hue: 12,
      colorGrading: { ...INITIAL_ADJUSTMENTS.colorGrading!, blending: 70 },
    });

    fireEvent.contextMenu(sectionRoot('颜色'));
    expect(menuOptions()[3].label).toBe('重置 颜色 设置');
    runMenu(menuOptions()[3]);

    expect(adj().saturation).toBe(INITIAL_ADJUSTMENTS.saturation);
    expect(adj().hue).toBe(INITIAL_ADJUSTMENTS.hue);
    expect(adj().colorGrading).toEqual(INITIAL_ADJUSTMENTS.colorGrading);
    expect(adj().exposure).toBe(1.5);
    expect(adj().sectionVisibility.color).toBe(true);
  });

  it('分区缺失 sectionVisibility 时重置仍按初始可见性补全', () => {
    renderPanel({ exposure: 2, sectionVisibility: undefined as never });

    fireEvent.contextMenu(sectionRoot('基础'));
    runMenu(menuOptions()[3]);

    expect(adj().exposure).toBe(0);
    expect(adj().sectionVisibility).toEqual(INITIAL_ADJUSTMENTS.sectionVisibility);
  });
});

describe('调整面板外壳 · 波形与直方图交互', () => {
  it('切换波形显示并按裁剪/分区/通道参数操作调整', async () => {
    renderPanel({ exposure: 0 });
    expect(screen.queryByTestId('waveform-stub')).not.toBeInTheDocument();

    fireEvent.click(toolButton('切换分析显示')!);
    expect(useEditorStore.getState().isWaveformVisible).toBe(true);
    const stub = screen.getByTestId('waveform-stub');
    expect(stub.dataset.mode).toBe('luma');
    expect(stub.dataset.clipping).toBe('false');
    expect(stub.dataset.theme).toBe('dark');

    fireEvent.click(screen.getByText('toggle-clipping'));
    expect(adj().showClipping).toBe(true);
    expect(stub.dataset.clipping).toBe('true');

    fireEvent.click(screen.getByText('adjust-exposure'));
    expect(adj().exposure).toBe(1.25);
    fireEvent.click(screen.getByText('reset-exposure'));
    expect(adj().exposure).toBe(0);

    fireEvent.click(screen.getByText('adjust-bogus'));
    fireEvent.click(screen.getByText('adjust-zero-width'));
    const beforeNoop = useEditorStore.getState().adjustments;
    fireEvent.click(screen.getByText('adjust-noop'));
    expect(useEditorStore.getState().adjustments).toBe(beforeNoop);

    fireEvent.click(screen.getByText('drag-start'));
    expect(useEditorStore.getState().isSliderDragging).toBe(true);
    fireEvent.click(screen.getByText('drag-end'));
    expect(useEditorStore.getState().isSliderDragging).toBe(false);

    fireEvent.click(screen.getByText('mode-rgb'));
    expect(useEditorStore.getState().activeWaveformChannel).toBe('rgb');
    expect(stub.dataset.mode).toBe('rgb');

    fireEvent.click(toolButton('切换分析显示')!);
    expect(useEditorStore.getState().isWaveformVisible).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('waveform-stub')).not.toBeInTheDocument());
  });

  it('直方图分区拖动按宽度换算并夹取上下限', () => {
    renderPanel({ exposure: 4.9 }, { isWaveformVisible: true });

    fireEvent.click(screen.getByText('adjust-exposure-large'));
    expect(adj().exposure).toBe(5);

    act(() => {
      useEditorStore.setState({ adjustments: { ...adj(), exposure: -4.9 } } as never);
    });
    fireEvent.click(screen.getByText('adjust-exposure-negative'));
    expect(adj().exposure).toBe(-5);

    fireEvent.click(screen.getByText('reset-bogus'));
    expect(adj().exposure).toBe(-5);
  });

  it('波形开关与通道切换在存在设置对象时持久化', async () => {
    const appSettings = {
      isWaveformVisible: false,
      activeWaveformChannel: 'luma',
      waveformHeight: 256,
    };
    seedStores({}, {});
    useSettingsStore.setState({ appSettings: appSettings as never } as never);
    render(<ControlsPanel />);

    fireEvent.click(toolButton('切换分析显示')!);
    await waitFor(() =>
      expect(useSettingsStore.getState().appSettings?.isWaveformVisible).toBe(true),
    );
    expect(mockInvoke).toHaveBeenCalledWith('save_settings', expect.anything());

    fireEvent.click(screen.getByText('mode-rgb'));
    await waitFor(() =>
      expect(useSettingsStore.getState().appSettings?.activeWaveformChannel).toBe('rgb'),
    );
  });

  it('拖动分隔条更新高度并夹取 150–450，忽略非左键与不匹配指针', async () => {
    const appSettings = {
      isWaveformVisible: true,
      activeWaveformChannel: 'luma',
      waveformHeight: 256,
    };
    seedStores({}, { isWaveformVisible: true, waveformHeight: 256 });
    useSettingsStore.setState({ appSettings: appSettings as never } as never);
    render(<ControlsPanel />);

    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');

    firePointer(separator, 'pointerdown', { pointerId: 7, clientY: 100, pointerType: 'touch' });
    firePointer(separator, 'pointermove', { pointerId: 8, clientY: 200 });
    expect(useEditorStore.getState().waveformHeight).toBe(256);

    firePointer(separator, 'pointermove', { pointerId: 7, clientY: 500 });
    expect(useEditorStore.getState().waveformHeight).toBe(450);
    firePointer(separator, 'pointerup', { pointerId: 7 });
    await waitFor(() =>
      expect(useSettingsStore.getState().appSettings?.waveformHeight).toBe(450),
    );

    firePointer(screen.getByRole('separator'), 'pointerdown', {
      pointerId: 9,
      clientY: 200,
      pointerType: 'mouse',
      button: 2,
    });
    firePointer(separator, 'pointermove', { pointerId: 9, clientY: 600 });
    expect(useEditorStore.getState().waveformHeight).toBe(450);

    act(() => {
      useEditorStore.setState({ waveformHeight: 100 } as never);
    });
    firePointer(screen.getByRole('separator'), 'pointerdown', {
      pointerId: 10,
      clientY: 300,
      pointerType: 'touch',
    });
    firePointer(separator, 'pointermove', { pointerId: 10, clientY: 100 });
    expect(useEditorStore.getState().waveformHeight).toBe(150);
    firePointer(separator, 'pointerup', { pointerId: 10 });
  });
});

describe('调整面板 · 键盘与可访问交互体验', () => {
  it('分区标题可用 Enter 折叠/展开，aria-expanded 同步', () => {
    renderPanel();
    const header = screen.getByRole('button', { name: '基础' });
    expect(header).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(false);
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(header, { key: ' ' });
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(true);
  });

  it('眼睛按钮暴露名称与 aria-pressed，键盘触发不会折叠分区', () => {
    renderPanel();
    const basic = sectionRoot('基础');
    const eye = basic.querySelector('button[aria-label="禁用部分"]') as HTMLButtonElement;
    expect(eye).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(eye);
    expect(adj().sectionVisibility.basic).toBe(false);
    expect(basic.querySelector('button[aria-label="启用部分"]')).toHaveAttribute('aria-pressed', 'false');
    expect(useUIStore.getState().collapsibleSectionsState.basic).toBe(true);
  });

  it('顶部工具栏图标按钮具备可访问名称，波形按钮暴露 aria-pressed', () => {
    renderPanel({}, { isWaveformVisible: true });
    expect(screen.getByRole('button', { name: '自动调整图像' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重置调整' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '切换分析显示' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Android 取消折叠时标题不再暴露 button 语义', () => {
    seedStores({}, {});
    useSettingsStore.setState({ osPlatform: 'android' } as never);
    render(<ControlsPanel />);
    expect(screen.queryByRole('button', { name: '基础' })).not.toBeInTheDocument();
  });
});
