import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BasicAdjustments from '../../src/components/adjustments/Basic';
import DetailsPanel from '../../src/components/adjustments/Details';
import ColorPanel from '../../src/components/adjustments/Color';
import ChannelMixer from '../../src/components/adjustments/ChannelMixer';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../../src/utils/adjustments';
import { WhiteBalanceMode } from '../../src/utils/whiteBalance';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { debouncedSetHistory } from '../../src/hooks/useEditorActions';

type Updater = (prev: Partial<Adjustments>) => Partial<Adjustments>;

const makeAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments => ({
  ...INITIAL_ADJUSTMENTS,
  ...overrides,
});

const renderWithSetter = (ui: (setAdjustments: ReturnType<typeof vi.fn>) => JSX.Element) => {
  const setAdjustments = vi.fn();
  const result = render(ui(setAdjustments));
  return { setAdjustments, ...result };
};

/** 通过可访问标签定位 Slider 行内的 range input */
const getSlider = (label: string, scope: HTMLElement = document.body): HTMLInputElement => {
  const labelEl = within(scope).getByText(label, { selector: 'span' });
  const row = labelEl.closest('.slider-row');
  if (!row) throw new Error(`slider row not found for ${label}`);
  return row.querySelector('input[type="range"]') as HTMLInputElement;
};

const getSection = (title: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name: title });
  const section = heading.closest('div.p-2');
  if (!section) throw new Error(`section not found for ${title}`);
  return section as HTMLElement;
};

const lastUpdater = (setAdjustments: ReturnType<typeof vi.fn>) =>
  setAdjustments.mock.calls.at(-1)![0] as Updater;

beforeEach(() => {
  useEditorStore.setState({
    adjustments: INITIAL_ADJUSTMENTS,
    selectedImage: null,
    activeCenterMarker: null,
    isHslPickerActive: false,
    hslTargetColor: null,
  } as never);
  useSettingsStore.setState({
    appSettings: null,
    osPlatform: 'linux',
  });
});

afterEach(() => {
  debouncedSetHistory.cancel();
  vi.restoreAllMocks();
});

describe('调整 · 基础面板(ToneMapper / EV / 基础滑块)', () => {
  it('渲染 5 种色调映射并切换 toneMapper', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <BasicAdjustments adjustments={makeAdjustments()} setAdjustments={set} />
    ));
    for (const name of ['基础', '经典', '电影化', 'AgX', '标准']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'AgX' }));
    const next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.toneMapper).toBe('agx');
    expect(next.sectionVisibility!.effects).toBe(true);
  });

  it('EV 偏移滑块写入 exposure', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <BasicAdjustments adjustments={makeAdjustments({ exposure: 0.5 })} setAdjustments={set} />
    ));
    const slider = getSlider('EV 偏移');
    fireEvent.change(slider, { target: { value: '1.25' } });
    const next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.exposure).toBe(1.25);
  });

  it('亮度/对比度/高光/阴影/白色/黑色滑块写入对应键', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <BasicAdjustments adjustments={makeAdjustments()} setAdjustments={set} />
    ));
    const cases: Array<[string, string, string, number]> = [
      ['亮度', 'brightness', '0.5', 0.5],
      ['对比度', 'contrast', '15', 15],
      ['高光', 'highlights', '-20', -20],
      ['阴影', 'shadows', '30', 30],
      ['白色', 'whites', '8', 8],
      ['黑色', 'blacks', '-9', -9],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSlider(label), { target: { value } });
      const next = lastUpdater(setAdjustments)(makeAdjustments());
      expect(next[key as keyof Adjustments]).toBe(expected);
    }
  });

  it('蒙版模式隐藏 ToneMapper 并改用 EV 偏移滑块', () => {
    render(
      <BasicAdjustments adjustments={makeAdjustments({ toneMapper: 'agx' })} setAdjustments={vi.fn()} isForMask />,
    );
    expect(screen.queryByRole('button', { name: 'AgX' })).not.toBeInTheDocument();
    expect(getSlider('EV 偏移')).toBeInTheDocument();
    expect(screen.queryByText('场景增强')).not.toBeInTheDocument();
  });
});

describe('调整 · 细节面板', () => {
  it('锐度/阈值/清晰度/去雾/结构滑块写入数值', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <DetailsPanel adjustments={makeAdjustments()} setAdjustments={set} appSettings={null} />
    ));
    const cases: Array<[string, string, string, number]> = [
      ['锐度', 'sharpness', '40', 40],
      ['阈值', 'sharpnessThreshold', '22', 22],
      ['清晰度', 'clarity', '-10', -10],
      ['去雾', 'dehaze', '16', 16],
      ['结构', 'structure', '12', 12],
      ['亮度', 'lumaNoiseReduction', '35', 35],
      ['颜色', 'colorNoiseReduction', '25', 25],
      ['红/青', 'chromaticAberrationRedCyan', '7', 7],
      ['蓝/黄', 'chromaticAberrationBlueYellow', '-8', -8],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSlider(label), { target: { value } });
      const next = lastUpdater(setAdjustments)(makeAdjustments());
      expect(next[key as keyof Adjustments]).toBe(expected);
    }
  });

  it('居中控制 pointerdown 激活画布中心标记', () => {
    render(<DetailsPanel adjustments={makeAdjustments()} setAdjustments={vi.fn()} appSettings={null} />);
    fireEvent.pointerDown(getSlider('居中').closest('[data-center-marker-controls]')!);
    expect(useEditorStore.getState().activeCenterMarker).toBe('centre');
  });

  it('蒙版模式隐藏居中与色差,降噪下限放宽到 -100', () => {
    render(<DetailsPanel adjustments={makeAdjustments()} setAdjustments={vi.fn()} appSettings={null} isForMask />);
    expect(screen.queryByText('居中')).not.toBeInTheDocument();
    expect(screen.queryByText('色差')).not.toBeInTheDocument();
    expect(getSlider('亮度').min).toBe('-100');
    expect(getSlider('颜色').min).toBe('-100');
    expect(screen.queryByText('AI 降噪')).not.toBeInTheDocument();
  });

  it('AI 降噪开关写入 aiDenoiseEnabled', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <DetailsPanel adjustments={makeAdjustments({ aiDenoiseEnabled: false })} setAdjustments={set} appSettings={null} />
    ));
    const toggle = screen.getByRole('checkbox', { name: /AI 降噪/ });
    fireEvent.click(toggle);
    const next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.aiDenoiseEnabled).toBe(true);
  });

  it('启用 AI 降噪后强度/细节滑块写入数值', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <DetailsPanel adjustments={makeAdjustments({ aiDenoiseEnabled: true })} setAdjustments={set} appSettings={null} />
    ));
    fireEvent.change(getSlider('数量'), { target: { value: '55' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).aiDenoiseAmount).toBe(55);
    fireEvent.change(getSlider('细节'), { target: { value: '33' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).aiDenoiseDetail).toBe(33);
  });

  it('AI 降噪进行中显示进度百分比', () => {
    useEditorStore.setState({
      selectedImage: { path: '/tmp/a.dng' },
      aiDenoiseProgress: { '/tmp/a.dng': 0.42 },
    } as never);
    render(
      <DetailsPanel adjustments={makeAdjustments({ aiDenoiseEnabled: true })} setAdjustments={vi.fn()} appSettings={null} />,
    );
    expect(screen.getByText('正在进行 AI 降噪...')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('adjustmentVisibility 可隐藏锐化/质感/降噪/色差分区', () => {
    render(
      <DetailsPanel
        adjustments={makeAdjustments()}
        setAdjustments={vi.fn()}
        appSettings={{ adjustmentVisibility: { sharpening: false, presence: false, noiseReduction: false, chromaticAberration: false } } as any}
      />,
    );
    expect(screen.queryByText('锐化')).not.toBeInTheDocument();
    expect(screen.queryByText('质感')).not.toBeInTheDocument();
    expect(screen.queryByText('降噪')).not.toBeInTheDocument();
    expect(screen.queryByText('色差')).not.toBeInTheDocument();
  });
});

describe('调整 · 颜色面板', () => {
  it('相对白平衡:色温/色调滑块写入 temperature/tint', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <ColorPanel adjustments={makeAdjustments()} setAdjustments={set} appSettings={null} />
    ));
    const wb = getSection('白平衡');
    fireEvent.change(getSlider('色温', wb), { target: { value: '25' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).temperature).toBe(25);
    fireEvent.change(getSlider('色调', wb), { target: { value: '-14' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).tint).toBe(-14);
  });

  it('K 按钮切换到开尔文模式并持久化设置', async () => {
    const appSettings = { whiteBalanceMode: WhiteBalanceMode.Relative } as any;
    useSettingsStore.setState({ appSettings });
    const { setAdjustments } = renderWithSetter((set) => (
      <ColorPanel
        adjustments={makeAdjustments()}
        setAdjustments={set}
        appSettings={appSettings}
        asShotWhiteBalance={{ temperature: 5500, tint: 5 }}
      />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'K' }));
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().appSettings?.whiteBalanceMode).toBe(WhiteBalanceMode.Kelvin);
    });
    expect(useSettingsStore.getState().appSettings?.whiteBalanceMode).toBe('kelvin');
    expect(setAdjustments).not.toHaveBeenCalled();
  });

  it('开尔文模式色温滑块映射 2000–50000K 并写入绝对白平衡', () => {
    const setAdjustments = vi.fn();
    const appSettings = { whiteBalanceMode: WhiteBalanceMode.Kelvin } as any;
    render(
      <ColorPanel
        adjustments={makeAdjustments()}
        setAdjustments={setAdjustments}
        appSettings={appSettings}
        asShotWhiteBalance={{ temperature: 5500, tint: 5 }}
      />,
    );
    const section = getSection('白平衡');
    const slider = getSlider('色温', section);
    // 对数刻度:range 位置是 ln(K),两端分别对应 2000K / 50000K
    expect(Number(slider.min)).toBeCloseTo(Math.log(2000), 5);
    expect(Number(slider.max)).toBeCloseTo(Math.log(50000), 5);
    expect(section.querySelector('.slider-value-display')!.textContent).toBe('5500K');

    fireEvent.change(slider, { target: { value: String(Math.log(4000)) } });
    const changed = lastUpdater(setAdjustments)(makeAdjustments());
    expect(changed.whiteBalance).toEqual({ temperature: 4000, tint: 5 });
    expect(changed.temperature).toBe(0);
    expect(changed.tint).toBe(0);
  });

  it('白平衡选取器按钮触发 toggleWbPicker', () => {
    const toggleWbPicker = vi.fn();
    render(
      <ColorPanel
        adjustments={makeAdjustments()}
        setAdjustments={vi.fn()}
        appSettings={null}
        toggleWbPicker={toggleWbPicker}
      />,
    );
    const button = getSection('白平衡').querySelector('button[data-tooltip="白平衡选取器"]') as HTMLButtonElement;
    fireEvent.click(button);
    expect(toggleWbPicker).toHaveBeenCalledTimes(1);
  });

  it('鲜艳度/饱和度/色相滑块写入顶层键', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <ColorPanel adjustments={makeAdjustments()} setAdjustments={set} appSettings={null} />
    ));
    fireEvent.change(getSlider('鲜艳度'), { target: { value: '22' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).vibrance).toBe(22);
    fireEvent.change(getSlider('饱和度', getSection('质感')), { target: { value: '-9' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).saturation).toBe(-9);
    fireEvent.change(getSlider('色相', getSection('色相')), { target: { value: '15' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).hue).toBe(15);
  });

  it('HSL 色块切换与三滑块写入当前颜色通道', async () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <ColorPanel
        adjustments={makeAdjustments({ hsl: { ...INITIAL_ADJUSTMENTS.hsl, blues: { hue: 10, saturation: 20, luminance: 30 } } })}
        setAdjustments={set}
        appSettings={null}
      />
    ));
    const mixer = getSection('颜色混合器');
    fireEvent.click(within(mixer).getByRole('button', { name: '选择 蓝色 颜色' }));
    // Slider 对 value 变化有 300ms 过渡动画,等待动画结束再断言
    await waitFor(() => expect(getSlider('色相', mixer).value).toBe('10'));
    expect(getSlider('饱和度', mixer).value).toBe('20');
    expect(getSlider('亮度', mixer).value).toBe('30');

    fireEvent.change(getSlider('色相', mixer), { target: { value: '40' } });
    let next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.hsl!.blues.hue).toBe(40);
    expect(next.hsl!.reds).toEqual(INITIAL_ADJUSTMENTS.hsl.reds);

    fireEvent.change(getSlider('饱和度', mixer), { target: { value: '-5' } });
    next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.hsl!.blues.saturation).toBe(-5);

    fireEvent.change(getSlider('亮度', mixer), { target: { value: '12' } });
    next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.hsl!.blues.luminance).toBe(12);
  });

  it('HSL 吸管按钮切换编辑器取色状态', () => {
    render(<ColorPanel adjustments={makeAdjustments()} setAdjustments={vi.fn()} appSettings={null} />);
    const button = getSection('颜色混合器').querySelector('button[data-tooltip]') as HTMLButtonElement;
    fireEvent.click(button);
    expect(useEditorStore.getState().isHslPickerActive).toBe(true);
  });

  it('画布取色结果 hslTargetColor 自动切换目标色块并清空标记', async () => {
    const adjustments = makeAdjustments({
      hsl: {
        ...INITIAL_ADJUSTMENTS.hsl,
        greens: { hue: 42, saturation: -7, luminance: 11 },
      },
    });
    render(<ColorPanel adjustments={adjustments} setAdjustments={vi.fn()} appSettings={null} />);
    const mixer = getSection('颜色混合器');

    await act(async () => {
      useEditorStore.setState({ hslTargetColor: 'greens' } as never);
    });

    await waitFor(() => expect(useEditorStore.getState().hslTargetColor).toBeNull());
    await waitFor(() => expect(getSlider('色相', mixer).value).toBe('42'));
    expect(getSlider('饱和度', mixer).value).toBe('-7');
    expect(getSlider('亮度', mixer).value).toBe('11');
  });

  it('颜色分级:3-way 显示三色轮,全局 tab 显示全局色轮,混合/平衡写入数值', async () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <ColorPanel adjustments={makeAdjustments()} setAdjustments={set} appSettings={null} />
    ));
    const grading = getSection('颜色分级');
    expect(await within(grading).findByText('中间调')).toBeInTheDocument();
    expect(within(grading).getByText('高光')).toBeInTheDocument();
    expect(within(grading).getByText('阴影')).toBeInTheDocument();

    // 第二个 tab(全局)是前两个无 tooltip 按钮中的第二个
    const tabButtons = Array.from(grading.querySelectorAll('button')).filter((b) => !b.dataset.tooltip);
    fireEvent.click(tabButtons[1]);
    expect(await within(grading).findByText('全局')).toBeInTheDocument();

    fireEvent.change(getSlider('混合', grading), { target: { value: '70' } });
    let next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.colorGrading!.blending).toBe(70);
    fireEvent.change(getSlider('平衡', grading), { target: { value: '-25' } });
    next = lastUpdater(setAdjustments)(makeAdjustments());
    expect(next.colorGrading!.balance).toBe(-25);
  });

  it('颜色校准:阴影色调与红/绿/蓝原色色相、饱和度写入正确键', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <ColorPanel adjustments={makeAdjustments()} setAdjustments={set} appSettings={null} />
    ));
    const calibration = getSection('颜色校准');
    fireEvent.change(getSlider('色调', calibration), { target: { value: '18' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).colorCalibration!.shadowsTint).toBe(18);

    fireEvent.change(getSlider('色相', calibration), { target: { value: '11' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).colorCalibration!.redHue).toBe(11);
    fireEvent.change(getSlider('饱和度', calibration), { target: { value: '12' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).colorCalibration!.redSaturation).toBe(12);

    fireEvent.click(within(calibration).getByRole('button', { name: '选择 绿色 颜色' }));
    fireEvent.change(getSlider('色相', calibration), { target: { value: '-7' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).colorCalibration!.greenHue).toBe(-7);

    fireEvent.click(within(calibration).getByRole('button', { name: '选择 蓝色 颜色' }));
    fireEvent.change(getSlider('饱和度', calibration), { target: { value: '19' } });
    expect(lastUpdater(setAdjustments)(makeAdjustments()).colorCalibration!.blueSaturation).toBe(19);
  });

  it('蒙版模式隐藏 K/选取器/颜色校准,色相标题改为局部色调', () => {
    render(<ColorPanel adjustments={makeAdjustments()} setAdjustments={vi.fn()} appSettings={null} isForMask />);
    expect(screen.queryByRole('button', { name: 'K' })).not.toBeInTheDocument();
    expect(screen.queryByText('颜色校准')).not.toBeInTheDocument();
    expect(screen.getByText('局部色调')).toBeInTheDocument();
  });
});

describe('调整 · 通道混合器', () => {
  it('默认恒等矩阵时重置禁用,9 个滑块渲染', () => {
    render(<ChannelMixer adjustments={makeAdjustments()} setAdjustments={vi.fn()} />);
    // 表头 1 个 + 3 行滑块各 1 个
    expect(screen.getAllByText('R')).toHaveLength(4);
    expect(screen.getAllByText('G')).toHaveLength(4);
    expect(screen.getAllByText('B')).toHaveLength(4);
    expect(screen.getByRole('button', { name: '重置' })).toBeDisabled();
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(9);
  });

  it('修改 R←G 权重写入 channelMixer', () => {
    const { setAdjustments } = renderWithSetter((set) => (
      <ChannelMixer adjustments={makeAdjustments()} setAdjustments={set} />
    ));
    const rows = document.querySelectorAll('.space-y-2 > .grid');
    expect(rows).toHaveLength(3);
    const redRowSliders = rows[0].querySelectorAll('input[type="range"]');
    fireEvent.change(redRowSliders[1], { target: { value: '25' } });
    const changed = setAdjustments.mock.calls.at(-1)![0] as Partial<Adjustments>;
    expect(changed.channelMixer!.red_from_green).toBe(25);
  });

  it('非恒等矩阵时重置按钮可用', () => {
    const dirty = makeAdjustments({ channelMixer: { ...INITIAL_ADJUSTMENTS.channelMixer!, red_from_green: 25 } });
    render(<ChannelMixer adjustments={dirty} setAdjustments={vi.fn()} />);
    expect(screen.getByRole('button', { name: '重置' })).toBeEnabled();
  });

  it('行首圆点只重置该输出行', () => {
    const setAdjustments = vi.fn();
    render(<ChannelMixer adjustments={makeAdjustments()} setAdjustments={setAdjustments} />);
    const rowReset = screen.getByRole('button', { name: '红 重置' });
    fireEvent.click(rowReset);
    const changed = setAdjustments.mock.calls.at(-1)![0] as Partial<Adjustments>;
    expect(changed.channelMixer!.red_from_red).toBe(100);
    expect(changed.channelMixer!.red_from_green).toBe(0);
  });

  it('整表重置恢复恒等矩阵', () => {
    const dirty = makeAdjustments({
      channelMixer: { ...INITIAL_ADJUSTMENTS.channelMixer!, red_from_green: 25, blue_from_red: -10 },
    });
    const setAdjustments = vi.fn();
    render(<ChannelMixer adjustments={dirty} setAdjustments={setAdjustments} />);
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    const changed = setAdjustments.mock.calls.at(-1)![0] as Partial<Adjustments>;
    expect(changed.channelMixer).toEqual(INITIAL_ADJUSTMENTS.channelMixer);
  });

  it('外部数据缺字段时补齐恒等默认值', () => {
    render(
      <ChannelMixer
        adjustments={makeAdjustments({ channelMixer: { red_from_red: 50 } as any })}
        setAdjustments={vi.fn()}
      />,
    );
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(9);
  });
});
