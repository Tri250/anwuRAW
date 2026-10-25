import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CurveGraph from '../../src/components/adjustments/Curves';
import {
  INITIAL_ADJUSTMENTS,
  DEFAULT_PARAMETRIC_CURVE_SETTINGS,
  getDefaultCurves,
  type Adjustments,
  type Coord,
} from '../../src/utils/adjustments';
import { CURVE_TONE_PRESETS } from '../../src/components/adjustments/curvePresets';
import { useSettingsStore } from '../../src/store/useSettingsStore';

const { showContextMenu } = vi.hoisted(() => ({ showContextMenu: vi.fn() }));

vi.mock('../../src/context/ContextMenuContext', () => ({
  useContextMenu: () => ({ showContextMenu }),
}));

const makeAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments => ({
  ...INITIAL_ADJUSTMENTS,
  curves: getDefaultCurves(),
  pointCurves: getDefaultCurves(),
  parametricCurve: {
    luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
  },
  curveMode: 'point',
  ...overrides,
});

const renderCurves = (adjustments: Adjustments, extra: Record<string, unknown> = {}) => {
  const setAdjustments = vi.fn();
  const onDragStateChange = vi.fn();
  const utils = render(
    <CurveGraph
      adjustments={adjustments}
      setAdjustments={setAdjustments}
      histogram={null}
      theme="dark"
      onDragStateChange={onDragStateChange}
      {...extra}
    />,
  );
  const applyLast = () => setAdjustments.mock.calls.at(-1)![0](adjustments) as Adjustments;
  return { ...utils, setAdjustments, onDragStateChange, applyLast };
};

const getSlider = (label: string): HTMLInputElement => {
  const labelEl = screen.getByText(label, { selector: 'span' });
  const row = labelEl.closest('.slider-row');
  if (!row) throw new Error(`slider row not found: ${label}`);
  return row.querySelector('input[type="range"]') as HTMLInputElement;
};

const getMenuOptions = () => showContextMenu.mock.calls.at(-1)![2] as Array<{ label?: string; disabled?: boolean; onClick?: () => void }>;
const findOption = (label: string) => getMenuOptions().find((option) => option.label === label);
const graphSvg = () => document.querySelector('svg[viewBox="0 0 255 255"]') as SVGSVGElement;
const graphSurface = () => graphSvg().parentElement as HTMLElement;
const graphCircles = () => graphSvg().querySelectorAll('circle');

beforeEach(() => {
  showContextMenu.mockReset();
  useSettingsStore.setState({ osPlatform: 'linux' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('曲线 · 点曲线', () => {
  it('渲染四通道按钮与 10 个色调预设', () => {
    renderCurves(makeAdjustments());
    for (const channel of ['亮度', '红色', '绿色', '蓝色']) {
      expect(screen.getByTitle(`${channel} 通道`)).toBeInTheDocument();
    }
    // 预设按钮按 i18n 文案逐个存在
    expect(screen.getByRole('button', { name: '原图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提亮' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '压暗' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'S 曲线' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '低对比' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '褪色' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '胶片' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暖调' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '冷调' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '人像' })).toBeInTheDocument();
  });

  it('点击通道按钮切换当前编辑通道', () => {
    renderCurves(makeAdjustments());
    fireEvent.click(screen.getByTitle('红色 通道'));
    // 切换后右键菜单文案携带红色通道
    fireEvent.contextMenu(graphSurface());
    expect(getMenuOptions()[0].label).toBe('复制 红色 点曲线');
  });

  it('双击画布将当前通道曲线重置为对角线', () => {
    const dirty = makeAdjustments({
      curves: {
        ...getDefaultCurves(),
        luma: [
          { x: 0, y: 0 },
          { x: 100, y: 160 },
          { x: 255, y: 255 },
        ],
      },
    });
    const { applyLast } = renderCurves(dirty);
    fireEvent.doubleClick(graphSurface());
    expect(applyLast().curves.luma).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
  });

  it('在画布空白处按下新增控制点并写入当前通道', () => {
    const { setAdjustments } = renderCurves(makeAdjustments());
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 255,
      height: 255,
      right: 255,
      bottom: 255,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.mouseDown(graphSurface(), { clientX: 127.5, clientY: 127.5, button: 0 });
    const next = setAdjustments.mock.calls.at(-1)![0](makeAdjustments()) as Adjustments;
    expect(next.curves.luma).toHaveLength(3);
    expect(next.curves.luma[1].x).toBeCloseTo(127.5, 1);
    expect(next.curves.luma[1].y).toBeCloseTo(127.5, 1);
  });

  it('右键中间控制点删除该点,首尾点不可删除', () => {
    const dirty = makeAdjustments({
      curves: {
        ...getDefaultCurves(),
        luma: [
          { x: 0, y: 0 },
          { x: 100, y: 160 },
          { x: 255, y: 255 },
        ],
      },
    });
    const { setAdjustments, applyLast } = renderCurves(dirty);
    const circles = graphCircles();
    fireEvent.contextMenu(circles[0]);
    expect(setAdjustments).not.toHaveBeenCalled();
    fireEvent.contextMenu(circles[1]);
    expect(applyLast().curves.luma).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
  });

  it('拖动控制点更新坐标并限制相邻点顺序', () => {
    const dirty = makeAdjustments({
      curves: {
        ...getDefaultCurves(),
        luma: [
          { x: 0, y: 0 },
          { x: 128, y: 128 },
          { x: 255, y: 255 },
        ],
      },
    });
    const { setAdjustments, onDragStateChange } = renderCurves(dirty);
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 255,
      height: 255,
      right: 255,
      bottom: 255,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const middle = graphCircles()[1];
    fireEvent.mouseDown(middle, { button: 0, clientX: 128, clientY: 128 });
    expect(onDragStateChange).toHaveBeenLastCalledWith(true);
    fireEvent.mouseMove(window, { clientX: 300, clientY: 20 });
    const next = setAdjustments.mock.calls.at(-1)![0](dirty) as Adjustments;
    // x 被限制在下一个控制点之前
    expect(next.curves.luma[1].x).toBeLessThan(255);
    expect(next.curves.luma[1].y).toBeGreaterThan(200);
    fireEvent.mouseUp(window);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
  });

  it('右键菜单:复制/粘贴仅在剪贴板有数据后可用', () => {
    const { setAdjustments, applyLast } = renderCurves(makeAdjustments());
    fireEvent.contextMenu(graphSurface());
    const options = getMenuOptions();
    expect(options.map((o) => o.label)).toEqual([
      '复制 亮度 点曲线',
      '粘贴点曲线',
      '从参数曲线粘贴',
      undefined,
      '重置 亮度 点曲线',
    ]);
    expect(findOption('粘贴点曲线')!.disabled).toBe(true);
    expect(findOption('从参数曲线粘贴')!.disabled).toBe(true);

    findOption('复制 亮度 点曲线')!.onClick!();
    fireEvent.click(screen.getByTitle('蓝色 通道'));
    fireEvent.contextMenu(graphSurface());
    expect(findOption('粘贴点曲线')!.disabled).toBe(false);
    findOption('粘贴点曲线')!.onClick!();
    const next = applyLast();
    expect(next.curves.blue).toEqual(makeAdjustments().curves.luma);
    expect(setAdjustments).toHaveBeenCalled();
  });

  it('右键菜单可重置当前通道与所有通道', () => {
    const dirty = makeAdjustments({
      curves: {
        ...getDefaultCurves(),
        red: [
          { x: 0, y: 0 },
          { x: 90, y: 140 },
          { x: 255, y: 255 },
        ],
      },
    });
    const { applyLast } = renderCurves(dirty);
    fireEvent.contextMenu(graphSurface());
    expect(findOption('重置所有点曲线')).toBeTruthy();
    findOption('重置 亮度 点曲线')!.onClick!();
    expect(applyLast().curves.luma).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);

    fireEvent.contextMenu(graphSurface());
    findOption('重置所有点曲线')!.onClick!();
    const all = applyLast().curves;
    for (const channel of ['luma', 'red', 'green', 'blue'] as const) {
      expect(all[channel]).toEqual([
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ]);
    }
  });

  it('参数曲线复制后可粘贴到点曲线通道', () => {
    const { applyLast } = renderCurves(makeAdjustments({ curveMode: 'parametric' }));
    fireEvent.contextMenu(graphSurface());
    findOption('复制 亮度 参数曲线')!.onClick!();
    fireEvent.click(document.querySelector('button[data-tooltip="点曲线"]') as HTMLButtonElement);
    fireEvent.contextMenu(graphSurface());
    const pasteFromParam = findOption('从参数曲线粘贴')!;
    expect(pasteFromParam.disabled).toBe(false);
    pasteFromParam.onClick!();
    expect(applyLast().curves.luma).toHaveLength(7);
  });
});

describe('曲线 · 参数曲线', () => {
  it('切换到参数曲线保存点曲线并生成四通道参数点', () => {
    const point = makeAdjustments();
    const { applyLast } = renderCurves(point);
    fireEvent.click(document.querySelector('button[data-tooltip="参数曲线"]') as HTMLButtonElement);
    const next = applyLast();
    expect(next.curveMode).toBe('parametric');
    expect(next.pointCurves).toBe(point.curves);
    for (const channel of ['luma', 'red', 'green', 'blue'] as const) {
      expect(next.curves[channel]).toHaveLength(7);
      expect(next.curves[channel][0]).toEqual({ x: 0, y: 0 });
      expect(next.curves[channel][6]).toEqual({ x: 255, y: 255 });
    }
  });

  it('切换回点曲线恢复保存的点曲线数据', () => {
    const saved = {
      luma: [
        { x: 0, y: 0 },
        { x: 128, y: 150 },
        { x: 255, y: 255 },
      ],
      red: [
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ],
      green: [
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ],
      blue: [
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ],
    } as Record<'luma' | 'red' | 'green' | 'blue', Coord[]>;
    const { applyLast } = renderCurves(makeAdjustments({ curveMode: 'parametric', pointCurves: saved }));
    fireEvent.click(document.querySelector('button[data-tooltip="点曲线"]') as HTMLButtonElement);
    const next = applyLast();
    expect(next.curveMode).toBe('point');
    expect(next.curves).toBe(saved);
  });

  it('六项参数滑块写入当前通道并同步重建曲线点', () => {
    const { setAdjustments } = renderCurves(makeAdjustments({ curveMode: 'parametric' }));
    const cases: Array<[string, keyof typeof DEFAULT_PARAMETRIC_CURVE_SETTINGS, string, number, number]> = [
      ['白色色阶', 'whiteLevel', '-10', -10, 0],
      ['高光', 'highlights', '20', 20, 1],
      ['亮部', 'lights', '15', 15, 2],
      ['暗部', 'darks', '-12', -12, 3],
      ['阴影', 'shadows', '30', 30, 4],
      ['黑色色阶', 'blackLevel', '8', 8, 0],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSlider(label), { target: { value } });
      const next = setAdjustments.mock.calls.at(-1)![0](makeAdjustments({ curveMode: 'parametric' })) as Adjustments;
      expect(next.parametricCurve!.luma[key]).toBe(expected);
      expect(next.curves.luma).toHaveLength(7);
    }
  });

  it('参数滑块作用于当前选中通道', () => {
    const { setAdjustments } = renderCurves(makeAdjustments({ curveMode: 'parametric' }));
    fireEvent.click(screen.getByTitle('蓝色 通道'));
    fireEvent.change(getSlider('高光'), { target: { value: '25' } });
    const next = setAdjustments.mock.calls.at(-1)![0](makeAdjustments({ curveMode: 'parametric' })) as Adjustments;
    expect(next.parametricCurve!.blue.highlights).toBe(25);
    expect(next.parametricCurve!.luma.highlights).toBe(0);
  });

  it('双击分隔条恢复该分隔点默认值', () => {
    const custom = {
      luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, split1: 40 },
      red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    };
    const { applyLast } = renderCurves(makeAdjustments({ curveMode: 'parametric', parametricCurve: custom }));
    const split1 = document.querySelectorAll('button.cursor-ew-resize')[0];
    fireEvent.doubleClick(split1);
    expect(applyLast().parametricCurve!.luma.split1).toBe(DEFAULT_PARAMETRIC_CURVE_SETTINGS.split1);
  });

  it('双击画布重置当前通道参数曲线', () => {
    const custom = {
      luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, highlights: 40, shadows: -30 },
      red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    };
    const { applyLast } = renderCurves(makeAdjustments({ curveMode: 'parametric', parametricCurve: custom }));
    fireEvent.doubleClick(graphSurface());
    expect(applyLast().parametricCurve!.luma).toEqual(DEFAULT_PARAMETRIC_CURVE_SETTINGS);
  });

  it('参数曲线右键菜单:复制/粘贴/重置当前通道', () => {
    const custom = {
      luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, highlights: 20 },
      red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, lights: 10 },
      green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
      blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
    };
    const { applyLast } = renderCurves(makeAdjustments({ curveMode: 'parametric', parametricCurve: custom }));
    fireEvent.contextMenu(graphSurface());
    expect(getMenuOptions().map((o) => o.label)).toEqual([
      '复制 亮度 参数曲线',
      '粘贴参数曲线',
      undefined,
      '重置 亮度 参数曲线',
      '重置所有参数曲线',
    ]);
    expect(findOption('粘贴参数曲线')).toBeTruthy();

    findOption('复制 亮度 参数曲线')!.onClick!();
    fireEvent.click(screen.getByTitle('绿色 通道'));
    fireEvent.contextMenu(graphSurface());
    expect(findOption('粘贴参数曲线')!.disabled).toBe(false);
    findOption('粘贴参数曲线')!.onClick!();
    expect(applyLast().parametricCurve!.green).toEqual(custom.luma);

    fireEvent.contextMenu(graphSurface());
    findOption('重置 绿色 参数曲线')!.onClick!();
    expect(applyLast().parametricCurve!.green).toEqual(DEFAULT_PARAMETRIC_CURVE_SETTINGS);

    fireEvent.contextMenu(graphSurface());
    findOption('重置所有参数曲线')!.onClick!();
    const next = applyLast().parametricCurve!;
    for (const channel of ['luma', 'red', 'green', 'blue'] as const) {
      expect(next[channel]).toEqual(DEFAULT_PARAMETRIC_CURVE_SETTINGS);
    }
  });
});

describe('曲线 · 预设与显示', () => {
  it('应用暖调预设:写入色调参数、四通道曲线并展开曲线分区', () => {
    const { applyLast } = renderCurves(makeAdjustments({ sectionVisibility: { ...INITIAL_ADJUSTMENTS.sectionVisibility, curves: false } }));
    fireEvent.click(screen.getByRole('button', { name: '暖调' }));
    const next = applyLast();
    expect(next.temperature).toBe(14);
    expect(next.vibrance).toBe(6);
    expect(next.curveMode).toBe('point');
    const warm = CURVE_TONE_PRESETS.find((preset) => preset.id === 'warm')!;
    expect(next.pointCurves!.red).toEqual(warm.curves.red);
    expect(next.pointCurves!.luma).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
    expect(next.curves.red).toEqual(warm.curves.red);
    expect(next.sectionVisibility!.curves).toBe(true);
  });

  it('S 曲线预设写入对比度并生成平滑曲线', () => {
    const { applyLast } = renderCurves(makeAdjustments());
    fireEvent.click(screen.getByRole('button', { name: 'S 曲线' }));
    const next = applyLast();
    expect(next.contrast).toBe(5);
    expect(next.curves.luma.length).toBeGreaterThan(2);
    expect(next.curves.luma.length).toBeLessThanOrEqual(16);
  });

  it('原图预设恢复全通道对角线', () => {
    const dirty = makeAdjustments({
      contrast: 30,
      curves: {
        ...getDefaultCurves(),
        luma: [
          { x: 0, y: 20 },
          { x: 255, y: 240 },
        ],
      },
    });
    const { applyLast } = renderCurves(dirty);
    fireEvent.click(screen.getByRole('button', { name: '原图' }));
    const next = applyLast();
    expect(next.contrast).toBe(0);
    expect(next.curves.luma).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
  });

  it('渲染直方图路径', () => {
    const histogram = {
      luma: Array.from({ length: 256 }, (_, i) => (i < 128 ? i : 255 - i)),
      red: Array.from({ length: 256 }, () => 1),
      green: Array.from({ length: 256 }, () => 2),
      blue: Array.from({ length: 256 }, () => 3),
    };
    renderCurves(makeAdjustments(), { histogram });
    expect(graphSvg().querySelector('path[fill="var(--color-accent)"]')).toBeTruthy();
  });

  it('曲线数据缺失时显示不可用提示', () => {
    renderCurves(makeAdjustments({ curves: undefined as never }));
    expect(screen.getByText('曲线数据不可用。')).toBeInTheDocument();
  });

  it('Android 平台提供更多选项入口打开同一右键菜单', () => {
    useSettingsStore.setState({ osPlatform: 'android' } as never);
    renderCurves(makeAdjustments());
    fireEvent.click(screen.getByRole('button', { name: '更多选项' }));
    expect(showContextMenu).toHaveBeenCalledTimes(1);
    expect(getMenuOptions()[0].label).toBe('复制 亮度 点曲线');
  });

  it('更多选项仅 Android 渲染', () => {
    renderCurves(makeAdjustments());
    expect(screen.queryByRole('button', { name: '更多选项' })).not.toBeInTheDocument();
  });
});
