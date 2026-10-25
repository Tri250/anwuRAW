import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'react-toastify';
import EffectsPanel from '../../src/components/adjustments/Effects';
import {
  INITIAL_ADJUSTMENTS,
  createRelightLight,
  type Adjustments,
  type RelightLight,
} from '../../src/utils/adjustments';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { mockInvoke, mockOpenDialog } from './setup';

const { showContextMenu } = vi.hoisted(() => ({ showContextMenu: vi.fn() }));

vi.mock('../../src/context/ContextMenuContext', () => ({
  useContextMenu: () => ({ showContextMenu }),
}));

const makeAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments => ({
  ...INITIAL_ADJUSTMENTS,
  ...overrides,
});

const makeLight = (overrides: Partial<RelightLight> = {}): RelightLight => ({
  ...createRelightLight(0.5, 0.5),
  id: 'light-1',
  ...overrides,
});

const renderEffects = (adjustments: Adjustments, extra: Record<string, unknown> = {}) => {
  const setAdjustments = vi.fn();
  const handleLutSelect = vi.fn();
  const onLutHover = vi.fn();
  const onDragStateChange = vi.fn();
  const ui = (props: Record<string, unknown> = {}) => (
    <EffectsPanel
      adjustments={adjustments}
      setAdjustments={setAdjustments}
      handleLutSelect={handleLutSelect}
      onLutHover={onLutHover}
      appSettings={null}
      onDragStateChange={onDragStateChange}
      {...props}
      {...extra}
    />
  );
  const utils = render(ui());
  const rerenderWith = (nextAdjustments: Adjustments) =>
    utils.rerender(
      <EffectsPanel
        adjustments={nextAdjustments}
        setAdjustments={setAdjustments}
        handleLutSelect={handleLutSelect}
        onLutHover={onLutHover}
        appSettings={(extra.appSettings as never) ?? null}
        onDragStateChange={onDragStateChange}
      />,
    );
  const applyLast = (base: Adjustments = adjustments) => {
    const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
    if (!fn) throw new Error('no updater call');
    return fn(base) as Adjustments;
  };
  return { ...utils, setAdjustments, handleLutSelect, onLutHover, onDragStateChange, applyLast, rerenderWith };
};

const getSection = (title: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name: title });
  const section = heading.closest('div.p-2');
  if (!section) throw new Error(`section not found: ${title}`);
  return section as HTMLElement;
};

const getSliderIn = (scope: HTMLElement, label: string): HTMLInputElement => {
  const labelEl = within(scope).getByText(label, { selector: 'span' });
  const row = labelEl.closest('.slider-row');
  if (!row) throw new Error(`slider row not found: ${label}`);
  return row.querySelector('input[type="range"]') as HTMLInputElement;
};

const spatialRoot = (label: string): HTMLElement => {
  const checkbox = screen.getByRole('checkbox', { name: label });
  return checkbox.closest('label')!.parentElement as HTMLElement;
};

const menuOptions = () =>
  showContextMenu.mock.calls.at(-1)![2] as Array<{ label?: string; disabled?: boolean; onClick?: () => void }>;
const findMenuOption = (label: string) => menuOptions().find((option) => option.label === label);

const lutSwatch = (name: string): HTMLButtonElement => {
  const label = screen.getAllByText(name).find((node) => node.className.includes('absolute'))!;
  return label.closest('button') as HTMLButtonElement;
};

beforeEach(() => {
  showContextMenu.mockReset();
  mockInvoke.mockReset().mockResolvedValue(undefined);
  mockOpenDialog.mockReset().mockResolvedValue(null);
  vi.spyOn(toast, 'error').mockImplementation((() => 0) as never);
  useEditorStore.setState({
    activeRelightLightId: null,
    isRelightPickerActive: false,
    isWbPickerActive: false,
    isHslPickerActive: false,
    activeCenterMarker: null,
  } as never);
  useProcessStore.setState({ aiModelDownloadStatus: null } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('效果 · 创意', () => {
  it('发光/光晕/光线耀斑滑块写入对应键', () => {
    const { setAdjustments } = renderEffects(makeAdjustments());
    const creative = getSection('创意');
    const cases: Array<[string, string, string, number]> = [
      ['发光', 'glowAmount', '25', 25],
      ['光晕', 'halationAmount', '14', 14],
      ['光线耀斑', 'flareAmount', '8', 8],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSliderIn(creative, label), { target: { value } });
      const next = setAdjustments.mock.calls.at(-1)![0](makeAdjustments());
      expect(next[key]).toBe(expected);
    }
  });

  it('蒙版模式保留发光/光晕但隐藏光线耀斑与空间/LUT/暗角/颗粒', () => {
    renderEffects(makeAdjustments(), { isForMask: true });
    expect(screen.getByRole('heading', { name: '创意' })).toBeInTheDocument();
    expect(screen.queryByText('光线耀斑')).not.toBeInTheDocument();
    expect(screen.queryByText('空间')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'LUT' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '暗角' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '颗粒' })).not.toBeInTheDocument();
  });

  it('adjustmentVisibility 可分别隐藏创意/空间/LUT/暗角/颗粒', () => {
    renderEffects(makeAdjustments(), {
      appSettings: {
        adjustmentVisibility: { creative: false, lensBlur: false, lut: false, vignette: false, grain: false },
      },
    });
    for (const title of ['创意', '空间', 'LUT', '暗角', '颗粒']) {
      expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
    }
  });
});

describe('效果 · 镜头模糊', () => {
  it('启用且无深度图时调用生成命令,成功写入深度图', async () => {
    let resolveDepth: (value: string) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_full_image_depth_map') {
        return new Promise<string>((resolve) => {
          resolveDepth = resolve;
        });
      }
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments({ lensBlurEnabled: false, lensBlurDepthMap: null });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('checkbox', { name: '镜头模糊' }));
    expect(mockInvoke).toHaveBeenCalledWith('generate_full_image_depth_map', { jsAdjustments: base });
    expect(await screen.findByText('正在计算 AI 深度图...')).toBeInTheDocument();

    await act(async () => resolveDepth('DEPTH_B64'));
    await waitFor(() => {
      const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
      expect(fn!(base).lensBlurDepthMap).toBe('DEPTH_B64');
    });
  });

  it('深度图生成失败时关闭镜头模糊并提示错误', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_full_image_depth_map') return Promise.reject(new Error('GPU OOM'));
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments({ lensBlurEnabled: false, lensBlurDepthMap: null });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('checkbox', { name: '镜头模糊' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('GPU OOM')));
    await waitFor(() => {
      const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
      expect(fn!(base).lensBlurEnabled).toBe(false);
    });
  });

  it('已有深度图时启用不重复生成', () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === 'list_luts' ? Promise.resolve([]) : Promise.resolve(undefined)));
    renderEffects(makeAdjustments({ lensBlurEnabled: false, lensBlurDepthMap: 'EXISTING' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '镜头模糊' }));
    expect(mockInvoke).not.toHaveBeenCalledWith('generate_full_image_depth_map', expect.anything());
  });

  it('数量/扩散滑块、散景形状与散景重置写入设置', () => {
    const base = makeAdjustments({ lensBlurEnabled: true, lensBlurDepthMap: 'DEPTH' });
    const { setAdjustments } = renderEffects(base);
    const lens = spatialRoot('镜头模糊');
    fireEvent.change(getSliderIn(lens, '数量'), { target: { value: '66' } });
    expect(setAdjustments.mock.calls.at(-1)![0](base).lensBlurAmount).toBe(66);
    fireEvent.change(getSliderIn(lens, '扩散'), { target: { value: '12' } });
    expect(setAdjustments.mock.calls.at(-1)![0](base).lensBlurDiffusion).toBe(12);

    for (const [title, shape] of [
      ['六边形', 'hexagon'],
      ['八边形', 'octagon'],
      ['气泡（环形）', 'ring'],
      ['圆形', 'circle'],
    ] as const) {
      fireEvent.click(lens.querySelector(`button[data-tooltip="${title}"]`) as HTMLButtonElement);
      expect(setAdjustments.mock.calls.at(-1)![0](base).lensBlurShape).toBe(shape);
    }
    fireEvent.click(within(lens).getByText('散景形状'));
    expect(setAdjustments.mock.calls.at(-1)![0](base).lensBlurShape).toBe('circle');
  });

  it('深度范围标签点击恢复默认范围', () => {
    const base = makeAdjustments({
      lensBlurEnabled: true,
      lensBlurDepthMap: 'DEPTH',
      lensBlurMinDepth: 30,
      lensBlurMaxDepth: 90,
      lensBlurMinFade: 5,
      lensBlurMaxFade: 7,
    });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(within(spatialRoot('镜头模糊')).getByText('深度范围'));
    const next = setAdjustments.mock.calls.at(-1)![0](base);
    expect(next.lensBlurMinDepth).toBe(20);
    expect(next.lensBlurMaxDepth).toBe(100);
    expect(next.lensBlurMinFade).toBe(20);
    expect(next.lensBlurMaxFade).toBe(20);
  });
});

describe('效果 · 重新打光', () => {
  it('启用且无法线贴图时调用生成命令,成功写入法线贴图', async () => {
    let resolveNormal: (value: string) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_relight_normal_map') {
        return new Promise<string>((resolve) => {
          resolveNormal = resolve;
        });
      }
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments({ relightEnabled: false, relightNormalMap: null });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('checkbox', { name: '重新打光' }));
    expect(await screen.findByText('正在计算 AI 法线贴图...')).toBeInTheDocument();
    await act(async () => resolveNormal('NORMAL_B64'));
    await waitFor(() => {
      const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
      expect(fn!(base).relightNormalMap).toBe('NORMAL_B64');
    });
  });

  it('法线贴图生成失败时关闭重新打光并提示', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_relight_normal_map') return Promise.reject('NO_MODEL');
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments({ relightEnabled: false, relightNormalMap: null });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('checkbox', { name: '重新打光' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('NO_MODEL')));
    const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
    expect(fn!(base).relightEnabled).toBe(false);
  });

  it('关闭重新打光同时退出灯光拾取状态', () => {
    useEditorStore.setState({ isRelightPickerActive: true } as never);
    renderEffects(makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '重新打光' }));
    expect(useEditorStore.getState().isRelightPickerActive).toBe(false);
  });

  it('环境光/柔和度/光泽与阴影柔和度滑块写入全局重新打光参数', () => {
    const base = makeAdjustments({
      relightEnabled: true,
      relightNormalMap: 'NORMAL',
      relightShadows: true,
    });
    const { setAdjustments } = renderEffects(base);
    const relight = spatialRoot('重新打光');
    const cases: Array<[string, string, string, number]> = [
      ['环境光', 'relightAmbient', '22', 22],
      ['柔和度', 'relightSoftness', '35', 35],
      ['光泽', 'relightShine', '18', 18],
      ['阴影柔和度', 'relightShadowSoftness', '44', 44],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSliderIn(relight, label), { target: { value } });
      expect(setAdjustments.mock.calls.at(-1)![0](base)[key]).toBe(expected);
    }
    fireEvent.click(screen.getByRole('checkbox', { name: '阴影' }));
    expect(setAdjustments.mock.calls.at(-1)![0](base).relightShadows).toBe(false);
  });

  it('点光源显示强度/深度/衰减/色温/色调并写入选中灯光', () => {
    const light = makeLight({ type: 'point' });
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [light] });
    useEditorStore.setState({ activeRelightLightId: light.id } as never);
    const { setAdjustments } = renderEffects(base);
    const relight = spatialRoot('重新打光');
    expect(within(relight).getByText('深度')).toBeInTheDocument();
    expect(within(relight).getByText('衰减')).toBeInTheDocument();
    expect(within(relight).queryByText('角度')).not.toBeInTheDocument();
    expect(within(relight).queryByText('光锥')).not.toBeInTheDocument();

    const cases: Array<[string, keyof RelightLight, string, number]> = [
      ['强度', 'intensity', '80', 80],
      ['深度', 'depth', '15', 15],
      ['衰减', 'radius', '55', 55],
      ['色温', 'temperature', '-20', -20],
      ['色调', 'tint', '12', 12],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSliderIn(relight, label), { target: { value } });
      const next = setAdjustments.mock.calls.at(-1)![0](base);
      expect(next.relightLights[0][key]).toBe(expected);
    }
  });

  it('聚光灯额外显示光锥/羽化/角度/仰角,平行光隐藏深度/衰减/光锥', () => {
    const spot = makeLight({ type: 'spot' });
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [spot] });
    useEditorStore.setState({ activeRelightLightId: spot.id } as never);
    const { rerenderWith, setAdjustments } = renderEffects(base);
    const relight = spatialRoot('重新打光');
    for (const label of ['深度', '衰减', '光锥', '羽化', '角度', '仰角']) {
      expect(within(relight).getByText(label)).toBeInTheDocument();
    }
    fireEvent.change(getSliderIn(relight, '光锥'), { target: { value: '70' } });
    expect(setAdjustments.mock.calls.at(-1)![0](base).relightLights[0].cone).toBe(70);
    fireEvent.change(getSliderIn(relight, '角度'), { target: { value: '45' } });
    expect(setAdjustments.mock.calls.at(-1)![0](base).relightLights[0].angle).toBe(45);

    const directional = makeLight({ type: 'directional' });
    rerenderWith({ ...base, relightLights: [directional] });
    const dirRoot = spatialRoot('重新打光');
    expect(within(dirRoot).queryByText('深度')).not.toBeInTheDocument();
    expect(within(dirRoot).queryByText('衰减')).not.toBeInTheDocument();
    expect(within(dirRoot).queryByText('光锥')).not.toBeInTheDocument();
    expect(within(dirRoot).getByText('角度')).toBeInTheDocument();
    expect(within(dirRoot).getByText('仰角')).toBeInTheDocument();
  });

  it('灯光类型下拉切换写入 type', () => {
    const light = makeLight({ type: 'point' });
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [light] });
    useEditorStore.setState({ activeRelightLightId: light.id } as never);
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('button', { name: '点光源' }));
    fireEvent.click(screen.getByRole('option', { name: '聚光灯' }));
    expect(setAdjustments.mock.calls.at(-1)![0](base).relightLights[0].type).toBe('spot');
  });

  it('添加灯光创建唯一 id 并激活拾取', () => {
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [] });
    const { setAdjustments } = renderEffects(base);
    expect(screen.getByText('添加或选择一个灯光，然后在图像上点击或拖动以放置。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加灯光' }));
    const next = setAdjustments.mock.calls.at(-1)![0](base);
    expect(next.relightLights).toHaveLength(1);
    expect(next.relightLights![0].id).toBeTruthy();
    expect(useEditorStore.getState().activeRelightLightId).toBe(next.relightLights![0].id);
    expect(useEditorStore.getState().isRelightPickerActive).toBe(true);
  });

  it('点击灯光色块选中并再次点击退出拾取', () => {
    const light = makeLight();
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [light] });
    renderEffects(base);
    const swatch = screen.getByRole('button', { name: '灯光 1' });
    fireEvent.click(swatch);
    expect(useEditorStore.getState().activeRelightLightId).toBe(light.id);
    expect(useEditorStore.getState().isRelightPickerActive).toBe(true);
    expect(useEditorStore.getState().isWbPickerActive).toBe(false);

    fireEvent.click(swatch);
    expect(useEditorStore.getState().isRelightPickerActive).toBe(false);
  });

  it('右键灯光菜单可复制灯光并激活副本', () => {
    const light = makeLight();
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [light] });
    useEditorStore.setState({ activeRelightLightId: light.id } as never);
    const { setAdjustments } = renderEffects(base);
    const swatch = screen.getByRole('button', { name: '灯光 1' });
    fireEvent.contextMenu(swatch.parentElement!, { clientX: 10, clientY: 10 });
    expect(menuOptions().map((option) => option.label)).toEqual(['复制灯光', '移除灯光']);
    findMenuOption('复制灯光')!.onClick!();
    const next = setAdjustments.mock.calls.at(-1)![0](base);
    expect(next.relightLights).toHaveLength(2);
    expect(next.relightLights![1].id).not.toBe(light.id);
    expect(next.relightLights![1].color).toBe(light.color);
    expect(useEditorStore.getState().activeRelightLightId).toBe(next.relightLights![1].id);
  });

  it('右键菜单移除灯光并清理激活状态', () => {
    const light = makeLight();
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [light] });
    useEditorStore.setState({ activeRelightLightId: light.id } as never);
    const { setAdjustments } = renderEffects(base);
    const swatch = screen.getByRole('button', { name: '灯光 1' });
    fireEvent.contextMenu(swatch.parentElement!, { clientX: 10, clientY: 10 });
    findMenuOption('移除灯光')!.onClick!();
    expect(setAdjustments.mock.calls.at(-1)![0](base).relightLights).toEqual([]);
    expect(useEditorStore.getState().activeRelightLightId).toBeNull();
    expect(useEditorStore.getState().isRelightPickerActive).toBe(false);
  });

  it('悬停灯光显示快捷删除按钮', () => {
    const light = makeLight();
    const base = makeAdjustments({ relightEnabled: true, relightNormalMap: 'NORMAL', relightLights: [light] });
    useEditorStore.setState({ activeRelightLightId: null } as never);
    const { setAdjustments } = renderEffects(base);
    const wrapper = screen.getByRole('button', { name: '灯光 1' }).parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    const remove = wrapper.querySelector('button[data-tooltip="移除灯光"]') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    fireEvent.click(remove);
    expect(setAdjustments.mock.calls.at(-1)![0](base).relightLights).toEqual([]);
  });
});

describe('效果 · 雾', () => {
  it('八项雾参数滑块写入对应键', () => {
    const base = makeAdjustments({ fogEnabled: true, fogDepthMap: 'FOG_DEPTH' });
    const { setAdjustments } = renderEffects(base);
    const fog = spatialRoot('雾');
    const cases: Array<[string, string, string, number]> = [
      ['数量', 'fogAmount', '70', 70],
      ['起始距离', 'fogStart', '15', 15],
      ['密度', 'fogDensity', '35', 35],
      ['地面雾', 'fogHeight', '10', 10],
      ['变化', 'fogVariation', '45', 45],
      ['发光', 'fogGlow', '12', 12],
      ['色温', 'fogTemperature', '-9', -9],
      ['色调', 'fogTint', '6', 6],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSliderIn(fog, label), { target: { value } });
      expect(setAdjustments.mock.calls.at(-1)![0](base)[key]).toBe(expected);
    }
  });

  it('启用且无深度图时生成成功写入 fogDepthMap', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_full_image_depth_map') return Promise.resolve('FOG_B64');
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments({ fogEnabled: false, fogDepthMap: null });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('checkbox', { name: '雾' }));
    await waitFor(() => {
      const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
      expect(fn!(base).fogDepthMap).toBe('FOG_B64');
    });
  });

  it('深度图生成失败关闭雾并提示', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_full_image_depth_map') return Promise.reject(new Error('NO_DEPTH'));
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments({ fogEnabled: false, fogDepthMap: null });
    const { setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('checkbox', { name: '雾' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('NO_DEPTH')));
    const fn = [...setAdjustments.mock.calls].reverse().find(([arg]) => typeof arg === 'function')?.[0];
    expect(fn!(base).fogEnabled).toBe(false);
  });
});

describe('效果 · LUT', () => {
  it('已选 LUT 显示名称与强度滑块,清除按钮写入空值', () => {
    const base = makeAdjustments({ lutPath: '/luts/portra.cube', lutName: 'Portra', lutIntensity: 80 });
    const { setAdjustments } = renderEffects(base);
    const lut = getSection('LUT');
    expect(within(lut).getByText('Portra')).toBeInTheDocument();
    fireEvent.change(getSliderIn(lut, '强度'), { target: { value: '65' } });
    expect(setAdjustments.mock.calls.at(-1)![0](base).lutIntensity).toBe(65);

    fireEvent.click(lut.querySelector('button[data-tooltip="清除 LUT"]') as HTMLButtonElement);
    const cleared = setAdjustments.mock.calls.at(-1)![0](base);
    expect(cleared.lutPath).toBeNull();
    expect(cleared.lutName).toBeNull();
    expect(cleared.lutIntensity).toBe(100);
  });

  it('展开列表加载内置与自定义 LUT,点击选择/再次点击清除并上报悬停', async () => {
    const entries = [
      { name: '内置胶片', path: '/builtin/film.cube', isBuiltIn: true },
      { name: '我的风格', path: '/custom/mine.cube', isBuiltIn: false },
    ];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_luts') return Promise.resolve(entries);
      return Promise.resolve(undefined);
    });
    const base = makeAdjustments();
    const { handleLutSelect, onLutHover, rerenderWith, setAdjustments } = renderEffects(base);
    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    expect(await screen.findByText('内置胶片')).toBeInTheDocument();
    expect(screen.getByText('我的风格')).toBeInTheDocument();

    const builtInSwatch = lutSwatch('内置胶片');
    fireEvent.mouseEnter(builtInSwatch);
    expect(onLutHover).toHaveBeenCalledWith('/builtin/film.cube', true);
    fireEvent.mouseLeave(builtInSwatch);
    expect(onLutHover).toHaveBeenCalledWith(null, undefined);

    fireEvent.click(builtInSwatch);
    expect(handleLutSelect).toHaveBeenCalledWith('/builtin/film.cube', true);

    fireEvent.click(lutSwatch('我的风格'));
    expect(handleLutSelect).toHaveBeenCalledWith('/custom/mine.cube', false);

    // 当前已选中的 LUT 再次点击 = 清除
    rerenderWith({ ...base, lutPath: '/builtin/film.cube', lutName: '内置胶片' });
    fireEvent.click(lutSwatch('内置胶片'));
    const cleared = setAdjustments.mock.calls.at(-1)![0](base);
    expect(cleared.lutPath).toBeNull();
  });

  it('导入 LUT 调用 open 与 import_luts 并刷新列表', async () => {
    mockOpenDialog.mockResolvedValue('/tmp/new.cube');
    const imported = [{ name: 'NewLut', path: '/tmp/new.cube', isBuiltIn: false }];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_luts') return Promise.resolve([]);
      if (cmd === 'import_luts') return Promise.resolve(imported);
      return Promise.resolve(undefined);
    });
    renderEffects(makeAdjustments());
    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    const importButton = await screen.findByRole('button', { name: '导入配置文件' });
    fireEvent.click(importButton);
    await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('import_luts', { sourcePaths: ['/tmp/new.cube'] }),
    );
    expect(await screen.findByText('NewLut')).toBeInTheDocument();
  });
});

describe('效果 · 暗角与颗粒', () => {
  it('暗角四个滑块写入数值,中心标记 pointerdown 激活画布标记', () => {
    const base = makeAdjustments();
    const { setAdjustments } = renderEffects(base);
    const vignette = getSection('暗角');
    const cases: Array<[string, string, string, number]> = [
      ['数量', 'vignetteAmount', '-35', -35],
      ['中点', 'vignetteMidpoint', '60', 60],
      ['圆度', 'vignetteRoundness', '25', 25],
      ['羽化', 'vignetteFeather', '70', 70],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSliderIn(vignette, label), { target: { value } });
      expect(setAdjustments.mock.calls.at(-1)![0](base)[key]).toBe(expected);
    }
    useEditorStore.setState({ isWbPickerActive: true, isHslPickerActive: true } as never);
    fireEvent.pointerDown(vignette.querySelector('[data-center-marker-controls="vignette"]') as HTMLElement);
    expect(useEditorStore.getState().activeCenterMarker).toBe('vignette');
    expect(useEditorStore.getState().isWbPickerActive).toBe(false);
    expect(useEditorStore.getState().isHslPickerActive).toBe(false);
  });

  it('颗粒数量/大小/粗糙度滑块写入数值', () => {
    const base = makeAdjustments();
    const { setAdjustments } = renderEffects(base);
    const grain = getSection('颗粒');
    const cases: Array<[string, string, string, number]> = [
      ['数量', 'grainAmount', '40', 40],
      ['大小', 'grainSize', '55', 55],
      ['粗糙度', 'grainRoughness', '30', 30],
    ];
    for (const [label, key, value, expected] of cases) {
      fireEvent.change(getSliderIn(grain, label), { target: { value } });
      expect(setAdjustments.mock.calls.at(-1)![0](base)[key]).toBe(expected);
    }
  });
});
