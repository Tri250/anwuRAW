import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MasksPanel from '../../src/components/panel/right/MasksPanel';
import { Mask, SubMaskMode, ToolType } from '../../src/components/panel/right/Masks';
import {
  INITIAL_ADJUSTMENTS,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  type Adjustments,
} from '../../src/utils/adjustments';
import { Panel } from '../../src/components/ui/AppProperties';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { mockInvoke } from './setup';

const { showContextMenu } = vi.hoisted(() => ({ showContextMenu: vi.fn() }));

vi.mock('../../src/context/ContextMenuContext', () => ({
  useContextMenu: () => ({ showContextMenu }),
}));

vi.mock('../../src/components/panel/editor/Waveform', () => ({
  default: () => null,
}));

type MenuOption = {
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
  submenu?: MenuOption[];
  type?: unknown;
};

let loadedPresets: any[] = [];

const IMAGE = {
  path: '/photos/mask.dng',
  width: 4000,
  height: 3000,
  isRaw: true,
  isReady: true,
  thumbnailUrl: '',
  exif: {},
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const makeAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments =>
  ({
    ...INITIAL_ADJUSTMENTS,
    masks: [],
    aiPatches: [],
    ...overrides,
  }) as Adjustments;

const makeSubMask = (id: string, type: Mask, overrides: Record<string, any> = {}) => ({
  id,
  type,
  name: undefined,
  visible: true,
  invert: false,
  opacity: 100,
  mode: SubMaskMode.Additive,
  parameters: {},
  ...overrides,
});

const makeContainer = (id: string, name: string, subMasks: any[], overrides: Record<string, any> = {}) => ({
  ...clone(INITIAL_MASK_CONTAINER),
  id,
  name,
  subMasks,
  adjustments: clone(INITIAL_MASK_ADJUSTMENTS),
  ...overrides,
});

const seedStore = (overrides: Partial<Adjustments> = {}, extra: Record<string, any> = {}) => {
  useEditorStore.setState({
    selectedImage: IMAGE,
    adjustments: makeAdjustments(overrides),
    activeMaskContainerId: null,
    activeMaskId: null,
    copiedMask: null,
    brushSettings: { size: 50, feather: 50, opacity: 100, tool: ToolType.Brush },
    histogram: null,
    isGeneratingAiMask: false,
    isWaveformVisible: false,
    waveform: null,
    activeWaveformChannel: 'luma',
    waveformHeight: 220,
    patchesSentToBackend: new Set<string>(),
    activeAiPatchContainerId: null,
    activeAiSubMaskId: null,
    isMaskControlHovered: false,
    ...extra,
  } as never);
};

const renderPanel = (overrides: Partial<Adjustments> = {}, extra: Record<string, any> = {}) => {
  seedStore(overrides, extra);
  return render(<MasksPanel />);
};

const adj = () => useEditorStore.getState().adjustments;
const masks = () => adj().masks || [];
const menuOptions = (): MenuOption[] => (showContextMenu.mock.calls.at(-1)?.[2] || []) as MenuOption[];
const menuOption = (label: string): MenuOption | undefined => menuOptions().find((option) => option.label === label);
const runMenu = (option: MenuOption | undefined) => {
  if (!option?.onClick) throw new Error(`menu option without handler: ${option?.label}`);
  act(() => option.onClick!());
};
const getSlider = (label: string, scope: ParentNode = document.body): HTMLInputElement => {
  const labelEl = within(scope as HTMLElement).getByText(label, { selector: 'span' });
  const row = labelEl.closest('.slider-row');
  if (!row) throw new Error(`slider row not found: ${label}`);
  return row.querySelector('input[type="range"]') as HTMLInputElement;
};

const toolButton = (tooltip: string, scope: ParentNode = document.body): HTMLButtonElement | null =>
  (scope as HTMLElement).querySelector(`button[data-tooltip="${tooltip}"]`);

const tile = (name: string): HTMLElement => {
  const el = document.querySelector(`[data-tooltip="创建新 ${name} 蒙版"]`) as HTMLElement | null;
  if (!el) throw new Error(`mask tile not found: ${name}`);
  return el;
};

const containerRow = (name: string): HTMLElement => {
  const text = screen.getByText(name, { selector: 'p' });
  return text.closest('.group') as HTMLElement;
};

const subMaskRow = (name: string): HTMLElement => {
  const text = screen.getByText(name, { selector: 'p' });
  return text.closest('.group') as HTMLElement;
};

const settingsSection = (title: string): HTMLElement => {
  const heading = screen.getByText(title, { selector: 'h2' });
  return heading.closest('.bg-surface.rounded-lg') as HTMLElement;
};

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  loadedPresets = [];
  showContextMenu.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'load_presets') return Promise.resolve(loadedPresets);
    if (cmd === 'generate_ai_depth_mask') return Promise.resolve({});
    if (cmd === 'generate_ai_foreground_mask') return Promise.resolve({});
    if (cmd === 'generate_ai_sky_mask') return Promise.resolve({});
    if (cmd === 'precompute_ai_subject_mask') return Promise.resolve({});
    return Promise.resolve(undefined);
  });
  useSettingsStore.setState({ appSettings: null, osPlatform: 'linux' } as never);
  useProcessStore.setState({ aiModelDownloadStatus: null } as never);
  useUIStore.setState({
    uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true },
    activePanels: {
      leftTop: Panel.FolderTree,
      leftBottom: null,
      rightTop: Panel.Adjustments,
      rightBottom: null,
    },
    customEscapeHandler: null,
  } as never);
  seedStore();
});

afterEach(() => {
  debouncedSetHistory.cancel();
  vi.restoreAllMocks();
});

describe('蒙版 · 空状态与创建入口', () => {
  it('未选择图像时显示空状态', () => {
    useEditorStore.setState({ selectedImage: null, adjustments: makeAdjustments() } as never);
    render(<MasksPanel />);
    expect(screen.getByText('未选择图像。')).toBeInTheDocument();
    expect(screen.queryByText('AI 选择')).not.toBeInTheDocument();
  });

  it('无蒙版时渲染三组共 11 个创建入口，工具栏波形按钮因调整面板可见而禁用', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: '蒙版' })).toBeInTheDocument();
    expect(screen.getByText('AI 选择')).toBeInTheDocument();
    expect(screen.getByText('基本工具')).toBeInTheDocument();
    expect(screen.getByText('范围与全局')).toBeInTheDocument();

    for (const name of ['主体', '天空', '前景', '深度', '画笔', '线性', '径向', '流线', '颜色', '亮度', '整个图像']) {
      expect(tile(name)).toBeInTheDocument();
    }

    const waveformButton = document.querySelector(
      'button[data-tooltip="在调整面板中切换分析"]',
    ) as HTMLButtonElement;
    expect(waveformButton).toBeDisabled();
    expect(toolButton('重置蒙版')).toBeInTheDocument();
  });

  it('点击画笔入口创建第一个容器与组件，自动选中、展开并切到画笔工具', () => {
    renderPanel();
    fireEvent.click(tile('画笔'));

    expect(masks()).toHaveLength(1);
    expect(masks()[0].name).toBe('蒙版 1');
    expect(masks()[0].subMasks[0].type).toBe(Mask.Brush);
    expect(masks()[0].subMasks[0].mode).toBe(SubMaskMode.Additive);
    expect(useEditorStore.getState().activeMaskContainerId).toBe(masks()[0].id);
    expect(useEditorStore.getState().activeMaskId).toBe(masks()[0].subMasks[0].id);
    expect(useEditorStore.getState().brushSettings?.tool).toBe(ToolType.Brush);
    expect(screen.getByText('画笔 属性')).toBeInTheDocument();
  });

  it('点击径向入口写入初始绘制哨兵值、尺寸与半径', () => {
    renderPanel();
    fireEvent.click(tile('径向'));
    const radial = masks()[0].subMasks[0];
    expect(radial.type).toBe(Mask.Radial);
    expect(radial.parameters.isInitialDraw).toBe(true);
    expect(radial.parameters.startX).toBe(-10000);
    expect(radial.parameters.centerX).toBe(-10000);
    expect(radial.parameters.radiusX).toBe(0);
  });

  it('点击线性入口按图像短边计算 range 并写入初始绘制哨兵值', () => {
    renderPanel();
    fireEvent.click(tile('线性'));
    const linear = masks()[0].subMasks[0];
    expect(linear.type).toBe(Mask.Linear);
    expect(linear.parameters.range).toBe(300);
    expect(linear.parameters.isInitialDraw).toBe(true);
    expect(linear.parameters.startX).toBe(-10000);
  });

  it('点击颜色/亮度入口写入容差、扩展、羽化与去除杂色默认值', () => {
    renderPanel();
    fireEvent.click(tile('颜色'));
    const color = masks()[0].subMasks[0];
    expect(color.type).toBe(Mask.Color);
    expect(color.parameters).toMatchObject({
      isInitialDraw: true,
      targetX: -10000,
      targetY: -10000,
      tolerance: 20,
      grow: 0,
      feather: 35,
      decontaminate: 0,
    });
  });

  it('右键创建入口强制新建容器，左键按下不会误触发', () => {
    renderPanel();
    const linearTile = tile('线性');
    fireEvent.mouseDown(linearTile, { button: 0 });
    expect(masks()).toHaveLength(0);

    fireEvent.mouseDown(linearTile, { button: 2 });
    expect(masks()).toHaveLength(1);
    expect(masks()[0].subMasks[0].type).toBe(Mask.Linear);
  });

  it('点击整个图像入口创建无参数的全局蒙版', () => {
    renderPanel();
    fireEvent.click(tile('整个图像'));
    expect(masks()[0].subMasks[0].type).toBe(Mask.All);
    expect(masks()[0].subMasks[0].parameters).toEqual({});
  });

  it.each([
    ['天空', Mask.AiSky, 'generate_ai_sky_mask'],
    ['前景', Mask.AiForeground, 'generate_ai_foreground_mask'],
    ['深度', Mask.AiDepth, 'generate_ai_depth_mask'],
  ])('AI 入口“%s”创建对应组件并触发生成', async (label, type, command) => {
    renderPanel();
    fireEvent.click(tile(label));
    expect(masks()[0].subMasks[0].type).toBe(type);

    await waitFor(() =>
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === command)).toBe(true),
    );
    await waitFor(() => expect(useEditorStore.getState().isGeneratingAiMask).toBe(false));

    if (type === Mask.AiDepth) {
      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === command)!;
      expect(call[1]).toMatchObject({ minDepth: 20, maxDepth: 80, minFade: 15, maxFade: 15 });
    }
  });

  it('AI 主体入口只创建组件，不直接调用生成命令', () => {
    renderPanel();
    fireEvent.click(tile('主体'));
    expect(masks()[0].subMasks[0].type).toBe(Mask.AiSubject);
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'generate_ai_subject_mask')).toBe(false);
  });

  it('“添加新蒙版”上下文菜单创建第二个容器，并支持嵌套文件夹式菜单', async () => {
    renderPanel();
    fireEvent.click(tile('画笔'));
    expect(masks()).toHaveLength(1);

    fireEvent.click(await screen.findByText('添加新蒙版'));
    expect(showContextMenu).toHaveBeenCalled();
    const radial = menuOption('径向')!;
    expect(radial).toBeTruthy();
    runMenu(radial);

    expect(masks()).toHaveLength(2);
    expect(masks()[1].name).toBe('蒙版 2');
    expect(masks()[1].subMasks[0].type).toBe(Mask.Radial);
  });
});

describe('蒙版 · 容器的选择与编辑', () => {
  it('挂载时自动选择最后一个容器并展开、显示调整设置', async () => {
    const a = makeContainer('c-a', '蒙版 A', [makeSubMask('s-a', Mask.Linear, { name: '组件 A' })]);
    const b = makeContainer('c-b', '蒙版 B', [makeSubMask('s-b', Mask.Radial, { name: '组件 B' })]);
    renderPanel({ masks: [a, b] });

    await waitFor(() => expect(useEditorStore.getState().activeMaskContainerId).toBe('c-b'));
    expect(useEditorStore.getState().activeMaskId).toBeNull();
    expect(await screen.findByText('组件 B')).toBeInTheDocument();
    expect(screen.getByText('蒙版属性')).toBeInTheDocument();
  });

  it('点击容器行选中容器，点击文件夹图标可折叠/展开组件', async () => {
    const c = makeContainer('c1', '蒙版 1', [
      makeSubMask('s1', Mask.Linear, { name: '组件一' }),
      makeSubMask('s2', Mask.Radial, { name: '组件二' }),
    ]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's2' });
    expect(await screen.findByText('组件二')).toBeInTheDocument();

    fireEvent.click(containerRow('蒙版 1'));
    expect(useEditorStore.getState().activeMaskContainerId).toBe('c1');
    expect(useEditorStore.getState().activeMaskId).toBeNull();

    const folderIcon = containerRow('蒙版 1').querySelector('.lucide-folder-open, .lucide-folder')!;
    fireEvent.click(folderIcon);
    await waitFor(() => expect(screen.queryByText('组件一')).not.toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('蒙版 1', { selector: 'p' }));
    expect(await screen.findByText('组件一')).toBeInTheDocument();
  });

  it('容器右键菜单重命名：Enter 提交，空白名称被忽略', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    fireEvent.contextMenu(containerRow('蒙版 1'));
    runMenu(menuOptions()[0]);
    const input = screen.getByDisplayValue('蒙版 1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '人像蒙版' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(masks()[0].name).toBe('人像蒙版');

    fireEvent.contextMenu(containerRow('人像蒙版'));
    runMenu(menuOptions()[0]);
    const blank = screen.getByDisplayValue('人像蒙版') as HTMLInputElement;
    fireEvent.change(blank, { target: { value: '   ' } });
    fireEvent.keyDown(blank, { key: 'Enter' });
    expect(masks()[0].name).toBe('人像蒙版');
  });

  it('容器眼睛按钮切换可见性并更新提示', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    const hide = document.querySelector('button[data-tooltip="隐藏蒙版"]') as HTMLButtonElement;
    fireEvent.mouseEnter(hide);
    expect(useEditorStore.getState().isMaskControlHovered).toBe(true);
    fireEvent.click(hide);
    expect(masks()[0].visible).toBe(false);
    expect(document.querySelector('button[data-tooltip="显示蒙版"]')).toBeInTheDocument();
    fireEvent.mouseLeave(document.querySelector('button[data-tooltip="显示蒙版"]')!);
    expect(useEditorStore.getState().isMaskControlHovered).toBe(false);
  });

  it('复制蒙版会在原容器之后插入新 ID 的副本并重置调整', async () => {
    const source = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })], {
      adjustments: { ...clone(INITIAL_MASK_ADJUSTMENTS), exposure: 1.2 },
    });
    const tail = makeContainer('c2', '蒙版 2', [makeSubMask('s2', Mask.Radial, { name: '组件二' })]);
    renderPanel({ masks: [source, tail] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    fireEvent.contextMenu(containerRow('蒙版 1'));
    const duplicate = menuOptions()[1];
    expect(duplicate.label).toBe('复制蒙版');
    runMenu(duplicate);

    expect(masks()).toHaveLength(3);
    expect(masks()[1].name).toBe('蒙版 1 副本');
    expect(masks()[1].id).not.toBe('c1');
    expect(masks()[1].subMasks[0].id).not.toBe('s1');
    expect(masks()[1].adjustments.exposure).toBe(0);
    expect(masks()[2].id).toBe('c2');
    expect(useEditorStore.getState().activeMaskContainerId).toBe(masks()[1].id);
    expect(useEditorStore.getState().activeMaskId).toBeNull();
  });

  it('复制并反转蒙版生成独立反转容器，名称带“反转”后缀', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })], {
      invert: true,
    });
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    fireEvent.contextMenu(containerRow('蒙版 1'));
    runMenu(menuOptions()[2]);

    expect(masks()).toHaveLength(2);
    expect(masks()[1].name).toBe('蒙版 1 反转');
    expect(masks()[1].invert).toBe(false);
    expect(masks()[1].subMasks[0].id).not.toBe('s1');
  });

  it('复制、粘贴蒙版：无剪贴板时禁用，复制后可插入并保持名称与调整', async () => {
    const source = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })], {
      adjustments: { ...clone(INITIAL_MASK_ADJUSTMENTS), exposure: 0.7 },
    });
    const target = makeContainer('c2', '蒙版 2', [makeSubMask('s2', Mask.Radial, { name: '组件二' })]);
    renderPanel({ masks: [source, target] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    fireEvent.contextMenu(containerRow('蒙版 2'));
    expect(menuOptions()[4].label).toBe('粘贴蒙版');
    expect(menuOptions()[4].disabled).toBe(true);
    runMenu(menuOptions()[0]);
    fireEvent.keyDown(screen.getByDisplayValue('蒙版 2'), { key: 'Enter' });

    fireEvent.contextMenu(containerRow('蒙版 1'));
    runMenu(menuOptions()[3]); // copy
    expect(useEditorStore.getState().copiedMask?.id).toBe('c1');

    fireEvent.contextMenu(containerRow('蒙版 2'));
    expect(menuOptions()[4].disabled).toBe(false);
    runMenu(menuOptions()[4]);

    expect(masks()).toHaveLength(3);
    expect(masks()[2].name).toBe('蒙版 1');
    expect(masks()[2].adjustments.exposure).toBe(0.7);
    expect(masks()[2].subMasks[0].id).not.toBe('s1');
  });

  it('粘贴蒙版调整只覆盖目标容器的 adjustments', async () => {
    const source = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear)], {
      adjustments: { ...clone(INITIAL_MASK_ADJUSTMENTS), exposure: 1.5, saturation: 30 },
    });
    const target = makeContainer('c2', '蒙版 2', [makeSubMask('s2', Mask.Radial)], {
      adjustments: { ...clone(INITIAL_MASK_ADJUSTMENTS), exposure: -1, saturation: 0 },
    });
    renderPanel({ masks: [source, target] }, { activeMaskContainerId: 'c1' });
    await waitFor(() => expect(screen.getAllByText('线性').length).toBeGreaterThan(0));

    fireEvent.contextMenu(containerRow('蒙版 1'));
    runMenu(menuOptions()[3]);
    fireEvent.contextMenu(containerRow('蒙版 2'));
    runMenu(menuOptions()[5]);

    expect(masks()[1].adjustments.exposure).toBe(1.5);
    expect(masks()[1].adjustments.saturation).toBe(30);
    expect(masks()[1].name).toBe('蒙版 2');
  });

  it('应用预设子菜单：无预设时显示禁用项，有预设时合并调整与分区可见性', async () => {
    loadedPresets = [
      {
        preset: {
          id: 'p1',
          name: '暖色',
          adjustments: { exposure: 1.1, sectionVisibility: { basic: true } },
        },
      },
      {
        folder: {
          id: 'f1',
          name: '文件夹',
          children: [{ id: 'p2', name: '冷色', adjustments: { exposure: -1 } }],
        },
      },
    ];
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear)]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });

    await waitFor(() => {
      fireEvent.contextMenu(containerRow('蒙版 1'));
      expect(menuOption('应用预设')?.submenu?.map((o) => o.label)).toEqual(['暖色', '文件夹']);
    });
    const presetMenu = menuOption('应用预设')!;
    expect(presetMenu.submenu![1].submenu!.map((o) => o.label)).toEqual(['冷色']);

    runMenu(presetMenu.submenu![0]);
    expect(masks()[0].adjustments.exposure).toBe(1.1);
  });

  it('应用预设子菜单：没有预设时显示禁用的“无预设”', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear)]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('load_presets'));

    fireEvent.contextMenu(containerRow('蒙版 1'));
    const preset = menuOption('应用预设')!;
    await waitFor(() => expect(preset.submenu?.[0]?.label).toBe('无预设'));
    expect(preset.submenu![0].disabled).toBe(true);
  });

  it('重置蒙版调整恢复初始蒙版调整对象', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear)], {
      adjustments: { ...clone(INITIAL_MASK_ADJUSTMENTS), exposure: 2, contrast: 30 },
    });
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('load_presets'));

    fireEvent.contextMenu(containerRow('蒙版 1'));
    runMenu(menuOptions()[8]);
    expect(masks()[0].adjustments).toEqual(INITIAL_MASK_ADJUSTMENTS);
  });

  it('删除蒙版：右键菜单与行内垃圾桶均可删除并清理选中状态', async () => {
    const a = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear)]);
    const b = makeContainer('c2', '蒙版 2', [makeSubMask('s2', Mask.Radial)]);
    renderPanel({ masks: [a, b] }, { activeMaskContainerId: 'c1', activeMaskId: 's1' });
    await waitFor(() => expect(screen.getAllByText('线性').length).toBeGreaterThan(0));

    fireEvent.contextMenu(containerRow('蒙版 1'));
    runMenu(menuOptions()[9]);
    expect(masks().map((m) => m.id)).toEqual(['c2']);
    expect(useEditorStore.getState().activeMaskContainerId).toBeNull();
    expect(useEditorStore.getState().activeMaskId).toBeNull();

    const trash = containerRow('蒙版 2').querySelectorAll('button')[1];
    fireEvent.click(trash);
    expect(masks()).toHaveLength(0);
  });

  it('点击列表标题空白处取消全部选择', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1' });
    await screen.findByText('组件一');

    const listTitle = screen.getAllByRole('heading', { name: '蒙版' }).at(-1)!;
    fireEvent.click(listTitle);
    expect(useEditorStore.getState().activeMaskContainerId).toBeNull();
    expect(useEditorStore.getState().activeMaskId).toBeNull();
  });

  it('重置全部蒙版清空 masks / aiPatches / 补丁记录与激活态', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear)]);
    const patches = new Set<string>(['s1']);
    renderPanel(
      {
        masks: [c],
        aiPatches: [{ id: 'p1' } as any],
      },
      {
        activeMaskContainerId: 'c1',
        activeMaskId: 's1',
        patchesSentToBackend: patches,
        activeAiPatchContainerId: 'p1',
        activeAiSubMaskId: 's1',
      },
    );

    fireEvent.click(toolButton('重置蒙版')!);
    expect(masks()).toEqual([]);
    expect(adj().aiPatches).toEqual([]);
    expect(useEditorStore.getState().activeMaskContainerId).toBeNull();
    expect(useEditorStore.getState().activeMaskId).toBeNull();
    expect(patches.size).toBe(0);
    expect(useEditorStore.getState().activeAiPatchContainerId).toBeNull();
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();
  });
});

describe('蒙版 · 组件（子蒙版）操作', () => {
  const seedTwoComponents = (activeMaskId: string | null = 's2') =>
    renderPanel(
      {
        masks: [
          makeContainer('c1', '蒙版 1', [
            makeSubMask('s1', Mask.Linear, { name: '组件一' }),
            makeSubMask('s2', Mask.Radial, { name: '组件二' }),
            makeSubMask('s3', Mask.All, { name: '组件三' }),
          ]),
        ],
      },
      { activeMaskContainerId: 'c1', activeMaskId },
    );

  it('点击组件行选中并显示“组件属性”，取消选择后回到蒙版属性', async () => {
    const c = makeContainer('c1', '蒙版 1', [
      makeSubMask('s1', Mask.Linear, { name: '组件一' }),
      makeSubMask('s2', Mask.Radial, { name: '组件二' }),
    ]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');
    expect(screen.getByText('蒙版属性')).toBeInTheDocument();

    fireEvent.click(subMaskRow('组件一'));
    expect(useEditorStore.getState().activeMaskId).toBe('s1');
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();

    fireEvent.click(containerRow('蒙版 1'));
    expect(useEditorStore.getState().activeMaskId).toBeNull();
    expect(await screen.findByText('蒙版属性')).toBeInTheDocument();
  });

  it('组件右键菜单重命名：失焦提交，Enter 也可提交', async () => {
    seedTwoComponents();
    await screen.findByText('组件一');

    fireEvent.contextMenu(subMaskRow('组件一'));
    expect(menuOptions().map((o) => o.label).slice(0, 5)).toEqual([
      '重命名',
      '复制组件',
      '复制并反转组件',
      '复制组件',
      '粘贴组件',
    ]);
    runMenu(menuOptions()[0]);
    const input = screen.getByDisplayValue('组件一') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '底色' } });
    fireEvent.blur(input);
    expect(masks()[0].subMasks[0].name).toBe('底色');

    fireEvent.contextMenu(subMaskRow('底色'));
    runMenu(menuOptions()[0]);
    const input2 = screen.getByDisplayValue('底色') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: '主体层' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(masks()[0].subMasks[0].name).toBe('主体层');
  });

  it('复制组件在源组件后插入新 ID 副本，名称追加“副本”', async () => {
    seedTwoComponents();
    await screen.findByText('组件一');

    fireEvent.contextMenu(subMaskRow('组件一'));
    runMenu(menuOptions()[1]);

    expect(masks()[0].subMasks).toHaveLength(4);
    expect(masks()[0].subMasks[1].name).toBe('组件一 副本');
    expect(masks()[0].subMasks[1].id).not.toBe('s1');
    expect(useEditorStore.getState().activeMaskId).toBe(masks()[0].subMasks[1].id);
  });

  it('复制并反转组件创建独立容器，仅包含反转后的组件副本', async () => {
    seedTwoComponents();
    await screen.findByText('组件一');

    fireEvent.contextMenu(subMaskRow('组件二'));
    runMenu(menuOptions()[2]);

    expect(masks()).toHaveLength(2);
    expect(masks()[1].name).toBe('组件二 反转');
    expect(masks()[1].subMasks).toHaveLength(1);
    expect(masks()[1].subMasks[0].id).not.toBe('s2');
    expect(masks()[1].subMasks[0].invert).toBe(true);
    expect(masks()[1].invert).toBe(false);
    expect(masks()[0].subMasks[1].invert).toBe(false);
  });

  it('复制/粘贴组件：无剪贴板时禁用，跨容器粘贴生成新 ID', async () => {
    const source = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    const target = makeContainer('c2', '蒙版 2', [makeSubMask('s2', Mask.Radial, { name: '组件二' })]);
    renderPanel({ masks: [source, target] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');
    fireEvent.click(containerRow('蒙版 2').querySelector('.lucide-folder-open, .lucide-folder')!);
    await screen.findByText('组件二');

    fireEvent.contextMenu(subMaskRow('组件一'));
    expect(menuOptions()[4].disabled).toBe(true);

    runMenu(menuOptions()[3]); // copy
    fireEvent.contextMenu(subMaskRow('组件二'));
    expect(menuOptions()[4].disabled).toBe(false);
    runMenu(menuOptions()[4]);

    expect(masks()[1].subMasks).toHaveLength(2);
    expect(masks()[1].subMasks[1].id).not.toBe('s1');
    expect(masks()[1].subMasks[1].name).toBe('组件一');
    expect(useEditorStore.getState().activeMaskId).toBe(masks()[1].subMasks[1].id);
  });

  it('删除组件清除选中并保留其余组件', async () => {
    seedTwoComponents('s1');
    await screen.findByText('组件一');

    fireEvent.contextMenu(subMaskRow('组件一'));
    runMenu(menuOptions()[6]);

    expect(masks()[0].subMasks.map((sm: any) => sm.id)).toEqual(['s2', 's3']);
    expect(useEditorStore.getState().activeMaskId).toBeNull();

    const trash = Array.from(subMaskRow('组件二').querySelectorAll('button')).at(-1) as HTMLButtonElement;
    fireEvent.click(trash);
    expect(masks()[0].subMasks.map((sm: any) => sm.id)).toEqual(['s3']);
  });

  it('第二个及之后的组件可循环切换 添加→减去→相交 模式', async () => {
    seedTwoComponents();
    await screen.findByText('组件二');

    const modeButton = (): HTMLButtonElement => subMaskRow('组件二').querySelector('[data-tooltip]') as HTMLButtonElement;
    expect(modeButton().dataset.tooltip).toBe('切换到减去');
    fireEvent.click(modeButton());
    expect(masks()[0].subMasks[1].mode).toBe(SubMaskMode.Subtractive);

    expect(modeButton().dataset.tooltip).toBe('切换到相交');
    fireEvent.click(modeButton());
    expect(masks()[0].subMasks[1].mode).toBe(SubMaskMode.Intersect);

    expect(modeButton().dataset.tooltip).toBe('切换到添加');
    fireEvent.click(modeButton());
    expect(masks()[0].subMasks[1].mode).toBe(SubMaskMode.Additive);
  });

  it('组件可见性按钮切换 visible 并维护悬停状态', async () => {
    seedTwoComponents();
    await screen.findByText('组件一');

    const hide = subMaskRow('组件一').querySelector('button[data-tooltip="隐藏组件"]') as HTMLButtonElement;
    fireEvent.mouseEnter(hide);
    expect(useEditorStore.getState().isMaskControlHovered).toBe(true);
    fireEvent.click(hide);
    expect(masks()[0].subMasks[0].visible).toBe(false);
    expect(subMaskRow('组件一').querySelector('button[data-tooltip="显示组件"]')).toBeInTheDocument();
    fireEvent.mouseLeave(subMaskRow('组件一').querySelector('button[data-tooltip="显示组件"]')!);
    expect(useEditorStore.getState().isMaskControlHovered).toBe(false);
  });

  it('悬停第二个组件时序号图标替换为序号（总数大于 1）', async () => {
    seedTwoComponents();
    await screen.findByText('组件二');
    const row = subMaskRow('组件二');
    expect(row.querySelector('.lucide-circle')).toBeInTheDocument();

    fireEvent.mouseEnter(row);
    await wait(200);
    expect(within(row).getByText('2')).toBeInTheDocument();

    fireEvent.mouseLeave(row);
    await waitFor(() => expect(within(row).queryByText('2')).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it('“添加新组件”菜单支持添加、减去、相交三种模式', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    const addComponent = screen.getByText('添加新组件');
    fireEvent.click(addComponent);
    expect(menuOptions().map((o) => o.label).filter(Boolean)).toEqual(
      expect.arrayContaining(['主体', '画笔', '整个图像', '从蒙版中减去', '与蒙版相交']),
    );

    const subtract = menuOption('从蒙版中减去')!;
    runMenu(subtract.submenu!.find((o) => o.label === '画笔'));
    expect(masks()[0].subMasks).toHaveLength(2);
    expect(masks()[0].subMasks[1].type).toBe(Mask.Brush);
    expect(masks()[0].subMasks[1].mode).toBe(SubMaskMode.Subtractive);

    fireEvent.click(screen.getByText('添加新组件'));
    runMenu(menuOption('与蒙版相交')!.submenu!.find((o) => o.label === '径向'));
    expect(masks()[0].subMasks[2].type).toBe(Mask.Radial);
    expect(masks()[0].subMasks[2].mode).toBe(SubMaskMode.Intersect);
  });

  it('仅选中容器显示“添加新组件”，未选中的已展开容器不显示', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    const other = makeContainer('c2', '蒙版 2', [
      makeSubMask('s2', Mask.Radial, { name: '组件二' }),
      makeSubMask('s3', Mask.All, { name: '组件三' }),
    ]);
    renderPanel({ masks: [c, other] }, { activeMaskContainerId: 'c2', activeMaskId: null });
    await screen.findByText('组件二');

    const folderIcon = containerRow('蒙版 1').querySelector('.lucide-folder-open, .lucide-folder')!;
    fireEvent.click(folderIcon);
    expect(await screen.findByText('组件一')).toBeInTheDocument();
    expect(screen.getAllByText('添加新组件')).toHaveLength(1);
  });
});

describe('蒙版 · 设置面板', () => {
  const seedComponent = (type: Mask, params: Record<string, any> = {}, extra: Record<string, any> = {}) => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', type, { name: '组件一', parameters: params })]);
    seedStore({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1', ...extra });
    return render(<MasksPanel />);
  };

  const seedContainer = (extra: Record<string, any> = {}) => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })], extra);
    seedStore({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: null });
    return render(<MasksPanel />);
  };

  it('容器属性：反转开关、不透明度与预设选择入口', async () => {
    seedContainer();
    await screen.findByText('蒙版属性');

    const invert = screen.getByRole('checkbox', { name: '反转蒙版' });
    fireEvent.click(invert);
    expect(masks()[0].invert).toBe(true);

    const opacity = getSlider('不透明度', settingsSection('蒙版属性'));
    await waitFor(() => expect(opacity.value).toBe('100'));
    fireEvent.change(opacity, { target: { value: '65' } });
    expect(masks()[0].opacity).toBe(65);

    expect(screen.getByText('应用预设')).toBeInTheDocument();
    expect(screen.getByText('选择')).toBeInTheDocument();
  });

  it('组件属性：反转、不透明度写入子蒙版', async () => {
    seedComponent(Mask.Linear, { feather: 0.4 });
    await screen.findByText('组件一 属性');

    fireEvent.click(screen.getByRole('checkbox', { name: '反转组件' }));
    expect(masks()[0].subMasks[0].invert).toBe(true);

    const scope = settingsSection('组件一 属性');
    const opacity = getSlider('不透明度', scope);
    await waitFor(() => expect(opacity.value).toBe('100'));
    fireEvent.change(opacity, { target: { value: '40' } });
    expect(masks()[0].subMasks[0].opacity).toBe(40);
  });

  it('设置面板的预设按钮打开预设上下文菜单并应用所选预设', async () => {
    loadedPresets = [
      { preset: { id: 'p1', name: '电影感', adjustments: { exposure: 0.8, sectionVisibility: { color: false } } } },
    ];
    seedContainer();
    await screen.findByText('蒙版属性');
    await waitFor(() => {
      fireEvent.click(screen.getByText('选择'));
      expect(menuOption('电影感')).toBeTruthy();
    });

    runMenu(menuOption('电影感'));
    expect(masks()[0].adjustments.exposure).toBe(0.8);
    expect(masks()[0].adjustments.sectionVisibility.color).toBe(false);
  });

  it('设置面板无预设时显示禁用的“未找到预设”', async () => {
    seedContainer();
    await screen.findByText('蒙版属性');
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('load_presets'));

    fireEvent.click(screen.getByText('选择'));
    await waitFor(() => expect(menuOptions()?.[0]?.label).toBe('未找到预设'));
    expect(menuOptions()[0].disabled).toBe(true);
  });

  it.each([
    [Mask.Linear, { feather: 0.5 }, ['羽化'], 2],
    [Mask.Radial, { feather: 0.5 }, ['羽化'], 2],
    [Mask.Color, {}, ['容差', '扩展', '羽化', '去除杂色'], 5],
    [Mask.Luminance, {}, ['容差', '扩展', '羽化', '去除杂色'], 5],
    [Mask.AiSubject, { grow: 50, feather: 25 }, ['扩展', '羽化', '去除杂色'], 4],
    [Mask.AiForeground, { grow: 50, feather: 25 }, ['扩展', '羽化', '去除杂色'], 4],
    [Mask.AiSky, { grow: 0, feather: 0 }, ['扩展', '羽化', '去除杂色'], 4],
    [Mask.All, {}, [], 1],
  ])('组件类型 %s 渲染正确的参数滑块', async (type, params, labels, count) => {
    seedComponent(type, params);
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');
    expect(within(scope).getAllByRole('slider')).toHaveLength(count);
    for (const label of labels) expect(getSlider(label, scope)).toBeInTheDocument();
  });

  it('颜色参数滑块写入 tolerance / grow / feather / decontaminate', async () => {
    seedComponent(Mask.Color);
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');

    fireEvent.change(getSlider('容差', scope), { target: { value: '55' } });
    fireEvent.change(getSlider('扩展', scope), { target: { value: '-20' } });
    fireEvent.change(getSlider('羽化', scope), { target: { value: '70' } });
    fireEvent.change(getSlider('去除杂色', scope), { target: { value: '15' } });

    expect(masks()[0].subMasks[0].parameters).toMatchObject({
      tolerance: 55,
      grow: -20,
      feather: 70,
      decontaminate: 15,
    });
  });

  it('AI 深度组件渲染深度范围与全局羽化，点击深度范围标题重置参数', async () => {
    seedComponent(Mask.AiDepth, { minDepth: 10, maxDepth: 90, minFade: 5, maxFade: 5, feather: 15 });
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');
    expect(screen.getByText('深度范围')).toBeInTheDocument();
    expect(getSlider('全局羽化', scope)).toBeInTheDocument();
    expect(getSlider('去除杂色', scope)).toBeInTheDocument();

    fireEvent.click(screen.getByText('深度范围'));
    expect(masks()[0].subMasks[0].parameters).toMatchObject({
      minDepth: 20,
      maxDepth: 80,
      minFade: 15,
      maxFade: 15,
    });
  });

  it('画笔工具：大小/羽化/不透明度与画笔/橡皮擦切换', async () => {
    seedComponent(Mask.Brush);
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');

    fireEvent.change(getSlider('画笔大小', scope), { target: { value: '120' } });
    fireEvent.change(getSlider('画笔羽化', scope), { target: { value: '30' } });
    fireEvent.change(getSlider('画笔不透明度', scope), { target: { value: '80' } });
    expect(useEditorStore.getState().brushSettings).toMatchObject({ size: 120, feather: 30, opacity: 80 });

    fireEvent.click(within(scope).getByRole('button', { name: '橡皮擦' }));
    expect(useEditorStore.getState().brushSettings?.tool).toBe(ToolType.Eraser);
    fireEvent.click(within(scope).getByRole('button', { name: '画笔' }));
    expect(useEditorStore.getState().brushSettings?.tool).toBe(ToolType.Brush);
  });

  it('流线组件显示流量滑块并写入 flow 参数', async () => {
    seedComponent(Mask.Flow, { flow: 10 });
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');
    expect(getSlider('流量', scope)).toBeInTheDocument();
    expect(getSlider('画笔大小', scope)).toBeInTheDocument();

    fireEvent.change(getSlider('流量', scope), { target: { value: '45' } });
    expect(masks()[0].subMasks[0].parameters.flow).toBe(45);
  });

  it('AI 组件在模型下载时显示下载状态提示', async () => {
    useProcessStore.setState({ aiModelDownloadStatus: '45%' } as never);
    seedComponent(Mask.AiSubject, { grow: 50, feather: 25 });
    await screen.findByText('组件一 属性');
    expect(screen.getByText('AI 模型下载中：')).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('展开基础/曲线/颜色/细节/效果五个调整分区，不显示通道混合器', async () => {
    seedComponent(Mask.Linear);
    await screen.findByText('组件一 属性');

    for (const section of ['基础', '曲线', '颜色', '细节', '效果']) {
      expect(screen.getByText(section, { selector: 'h2' })).toBeInTheDocument();
    }
    expect(screen.queryByText('通道混合器')).not.toBeInTheDocument();
    expect(screen.queryByText('分离色调')).not.toBeInTheDocument();
  });

  it('点击分区标题折叠/展开，并受焦点模式影响只保留一个分区', async () => {
    useSettingsStore.setState({ appSettings: { enableFocusMode: true } as never } as never);
    seedComponent(Mask.Linear);
    await screen.findByText('组件一 属性');

    const basicChevron = settingsSection('基础').querySelector('.lucide-chevron-down')!;
    const curvesChevron = settingsSection('曲线').querySelector('.lucide-chevron-down')!;
    expect(basicChevron.getAttribute('class')).toContain('rotate-180');

    fireEvent.click(screen.getByText('曲线', { selector: 'h2' }));
    expect(curvesChevron.getAttribute('class')).toContain('rotate-180');
    expect(basicChevron.getAttribute('class')).not.toContain('rotate-180');

    const settingsChevron = settingsSection('组件一 属性').querySelector('.lucide-chevron-down')!;
    expect(settingsChevron.getAttribute('class')).not.toContain('rotate-180');
  });

  it('分区眼睛按钮切换 sectionVisibility', async () => {
    seedComponent(Mask.Linear);
    await screen.findByText('组件一 属性');
    const basic = settingsSection('基础');

    const disable = basic.querySelector('button[data-tooltip="禁用部分"]') as HTMLButtonElement;
    expect(masks()[0].adjustments.sectionVisibility.basic).toBe(true);
    fireEvent.click(disable);
    expect(masks()[0].adjustments.sectionVisibility.basic).toBe(false);
    expect(basic.querySelector('button[data-tooltip="启用部分"]')).toBeInTheDocument();
  });

  it('分区右键菜单复制、粘贴、重置基础设置', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })], {
      adjustments: { ...clone(INITIAL_MASK_ADJUSTMENTS), exposure: 0.5 },
    });
    seedStore({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1' });
    render(<MasksPanel />);
    await screen.findByText('组件一 属性');

    const basic = settingsSection('基础');
    fireEvent.contextMenu(basic);
    expect(menuOptions().map((o) => o.label)).toEqual(['复制 基础 设置', '粘贴设置', undefined, '重置 基础 设置']);
    expect(menuOptions()[1].disabled).toBe(true);
    runMenu(menuOptions()[0]);

    act(() => {
      useEditorStore.setState({
        adjustments: {
          ...adj(),
          masks: adj().masks.map((m) => ({ ...m, adjustments: { ...m.adjustments, exposure: 2 } })),
        },
      } as never);
    });

    fireEvent.contextMenu(settingsSection('基础'));
    expect(menuOptions()[1].disabled).toBe(false);
    runMenu(menuOptions()[1]);
    expect(masks()[0].adjustments.exposure).toBe(0.5);
    expect(masks()[0].adjustments.sectionVisibility.basic).toBe(true);

    act(() => {
      useEditorStore.setState({
        adjustments: {
          ...adj(),
          masks: adj().masks.map((m) => ({ ...m, adjustments: { ...m.adjustments, exposure: 3 } })),
        },
      } as never);
    });
    fireEvent.contextMenu(settingsSection('基础'));
    runMenu(menuOptions()[3]);
    expect(masks()[0].adjustments.exposure).toBe(0);
  });

  it('删除全部容器后保留设置面板占位并禁用交互', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    fireEvent.click(containerRow('蒙版 1').querySelectorAll('button')[1]);
    expect(masks()).toHaveLength(0);
    const title = await screen.findByText('蒙版属性');
    const root = title.closest('.space-y-2') as HTMLElement;
    expect(root.className).toContain('opacity-50');
    expect(root.className).toContain('pointer-events-none');
  });
});

describe('蒙版 · 波形、转义与异步状态', () => {
  it('调整面板不可见时波形按钮可切换分析区显示', async () => {
    useUIStore.setState({
      activePanels: {
        leftTop: Panel.FolderTree,
        leftBottom: null,
        rightTop: Panel.Masks,
        rightBottom: null,
      },
    } as never);
    renderPanel();
    const toggle = document.querySelector('button[data-tooltip="切换分析显示"]') as HTMLButtonElement;
    expect(toggle).toBeEnabled();
    expect(useEditorStore.getState().isWaveformVisible).toBe(false);

    fireEvent.click(toggle);
    expect(useEditorStore.getState().isWaveformVisible).toBe(true);
    fireEvent.click(document.querySelector('button[data-tooltip="切换分析显示"]')!);
    expect(useEditorStore.getState().isWaveformVisible).toBe(false);
  });

  it('Esc 自定义处理器依次取消重命名、组件选择、容器选择', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1' });
    await screen.findByText('组件一');

    fireEvent.contextMenu(subMaskRow('组件一'));
    runMenu(menuOptions()[0]);
    expect(screen.getByDisplayValue('组件一')).toBeInTheDocument();

    act(() => useUIStore.getState().customEscapeHandler?.());
    expect(screen.queryByDisplayValue('组件一')).not.toBeInTheDocument();
    expect(useEditorStore.getState().activeMaskId).toBe('s1');

    act(() => useUIStore.getState().customEscapeHandler?.());
    expect(useEditorStore.getState().activeMaskId).toBeNull();
    expect(useEditorStore.getState().activeMaskContainerId).toBe('c1');

    act(() => useUIStore.getState().customEscapeHandler?.());
    expect(useEditorStore.getState().activeMaskContainerId).toBeNull();
  });

  it('AI 生成开始后 200ms 在组件行显示分析指示器', async () => {
    const c = makeContainer('c1', '蒙版 1', [
      makeSubMask('s1', Mask.AiSubject, { name: '主体组件', parameters: { maskDataBase64: 'x' } }),
    ]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1', isGeneratingAiMask: true });
    await screen.findByText('主体组件');

    expect(subMaskRow('主体组件').querySelector('.lucide-loader-circle')).toBeNull();
    await waitFor(() => expect(subMaskRow('主体组件').querySelector('.lucide-loader-circle')).toBeInTheDocument(), {
      timeout: 1500,
    });
  });

  it('普通组件在 AI 生成状态下不显示分析指示器', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '线性组件' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1', isGeneratingAiMask: true });
    await screen.findByText('线性组件');
    await wait(300);
    expect(subMaskRow('线性组件').querySelector('.lucide-loader-circle')).toBeNull();
  });

describe('蒙版 · 用户交互体验', () => {
  it('创建入口以按钮语义暴露，Enter 与 Space 均可创建蒙版', async () => {
    const first = renderPanel();
    const brush = screen.getByRole('button', { name: '画笔' });
    expect(brush).toHaveAttribute('role', 'button');
    expect(brush).toHaveAttribute('tabindex', '0');
    expect(brush).not.toHaveAttribute('aria-disabled');

    brush.focus();
    expect(document.activeElement).toBe(brush);
    fireEvent.keyDown(brush, { key: 'Enter' });
    expect(masks()).toHaveLength(1);
    expect(masks()[0].subMasks[0].type).toBe(Mask.Brush);

    first.unmount();
    renderPanel();
    const all = screen.getByRole('button', { name: '整个图像' });
    fireEvent.keyDown(all, { key: ' ' });
    expect(masks()).toHaveLength(1);
    expect(masks()[0].subMasks[0].type).toBe(Mask.All);
  });

  it('工具栏分析按钮暴露禁用原因与按下态，重置按钮具备可访问名称', () => {
    renderPanel();
    const analytics = screen.getByRole('button', { name: '在调整面板中切换分析' });
    expect(analytics).toBeDisabled();
    expect(analytics).toHaveAttribute('aria-pressed', 'false');

    const reset = screen.getByRole('button', { name: '重置蒙版' });
    expect(reset).toBeEnabled();
  });

  it('容器展开器支持键盘折叠/展开，并同步 aria-expanded', async () => {
    const c = makeContainer('c1', '蒙版 1', [
      makeSubMask('s1', Mask.Linear, { name: '组件一' }),
      makeSubMask('s2', Mask.Radial, { name: '组件二' }),
    ]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    const collapse = screen.getByRole('button', { name: '蒙版 1 · 折叠蒙版' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    collapse.focus();
    fireEvent.keyDown(collapse, { key: 'Enter' });

    const expand = screen.getByRole('button', { name: '蒙版 1 · 展开蒙版' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(expand, { key: ' ' });
    expect(screen.getByRole('button', { name: '蒙版 1 · 折叠蒙版' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('容器与组件的显隐、模式按钮通过名称和 aria-pressed 反馈状态', async () => {
    const c = makeContainer('c1', '蒙版 1', [
      makeSubMask('s1', Mask.Linear, { name: '组件一' }),
      makeSubMask('s2', Mask.Radial, { name: '组件二' }),
    ]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's2' });
    await screen.findByText('组件二');

    const maskEye = screen.getByRole('button', { name: '隐藏蒙版' });
    expect(maskEye).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(maskEye);
    expect(screen.getByRole('button', { name: '显示蒙版' })).toHaveAttribute('aria-pressed', 'false');

    const row = subMaskRow('组件二');
    const compEye = within(row).getByRole('button', { name: '隐藏组件' });
    expect(compEye).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(compEye);
    expect(within(row).getByRole('button', { name: '显示组件' })).toHaveAttribute('aria-pressed', 'false');

    const mode = within(row).getByRole('button', { name: '切换到减去' });
    fireEvent.click(mode);
    expect(within(row).getByRole('button', { name: '切换到相交' })).toBeInTheDocument();
  });

  it('蒙版属性分区可通过键盘折叠并更新 aria-expanded', async () => {
    const c = makeContainer('c1', '蒙版 1', [makeSubMask('s1', Mask.Linear, { name: '组件一' })]);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1' });
    await screen.findByText('组件一');

    const header = screen.getByRole('button', { name: '蒙版属性' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    header.focus();
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(header, { key: ' ' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('AI 模型下载进度以 status 区域礼貌播报', async () => {
    const c = makeContainer('c1', '天空蒙版', [makeSubMask('s1', Mask.AiSky, { name: '天空 1' })]);
    useProcessStore.setState({ aiModelDownloadStatus: '45%' } as never);
    renderPanel({ masks: [c] }, { activeMaskContainerId: 'c1', activeMaskId: 's1' });

    const progress = await screen.findByText('45%');
    const status = progress.closest('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('AI 模型下载中');
    expect(status).toHaveTextContent('45%');
  });
});
});

