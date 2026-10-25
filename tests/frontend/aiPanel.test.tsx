import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AIPanel from '../../src/components/panel/right/AIPanel';
import { Mask, SubMaskMode, ToolType } from '../../src/components/panel/right/Masks';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../../src/utils/adjustments';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { toast } from 'react-toastify';
import { mockInvoke } from './setup';

const { showContextMenu } = vi.hoisted(() => ({ showContextMenu: vi.fn() }));
const clerk = vi.hoisted(() => ({ isSignedIn: true, plan: undefined as string | undefined }));

// 可编程的 dnd-kit 替身：让测试直接驱动拖拽开始/结束，并模拟落点高亮状态
const dnd = vi.hoisted(() => ({
  onDragStart: null as ((event: any) => void) | null,
  onDragEnd: null as ((event: any) => void) | null,
  activeId: null as string | null,
  overId: null as string | null,
}));

vi.mock('../../src/context/ContextMenuContext', () => ({
  useContextMenu: () => ({ showContextMenu }),
}));

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ isSignedIn: clerk.isSignedIn, getToken: vi.fn(async () => 'mock-token') }),
  useUser: () => ({
    isLoaded: true,
    isSignedIn: clerk.isSignedIn,
    user: clerk.isSignedIn
      ? { id: 'user_test', fullName: 'Test User', imageUrl: '', publicMetadata: clerk.plan ? { plan: clerk.plan } : {} }
      : null,
  }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react');
  return {
    DndContext: ({ children, onDragStart, onDragEnd }: any) => {
      dnd.onDragStart = onDragStart;
      dnd.onDragEnd = onDragEnd;
      return React.createElement('div', { 'data-testid': 'dnd-context' }, children);
    },
    DragOverlay: ({ children }: any) => React.createElement('div', { 'data-testid': 'drag-overlay' }, children),
    PointerSensor: class PointerSensor {},
    useSensor: () => ({}),
    useSensors: () => [],
    useDraggable: ({ id }: any) => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      isDragging: dnd.activeId === id,
    }),
    useDroppable: ({ id }: any) => ({
      setNodeRef: () => {},
      isOver: dnd.overId === id,
    }),
    pointerWithin: () => [],
    closestCenter: () => [],
  };
});

type MenuOption = {
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
  submenu?: MenuOption[];
  type?: unknown;
};

const IMAGE = {
  path: '/photos/ai.dng',
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
    ...clone(INITIAL_ADJUSTMENTS),
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

const makePatch = (id: string, name: string, subMasks: any[], overrides: Record<string, any> = {}) => ({
  id,
  invert: false,
  isLoading: false,
  name,
  patchData: null,
  prompt: '',
  subMasks,
  visible: true,
  ...overrides,
});

const seedStore = (overrides: Partial<Adjustments> = {}, extra: Record<string, any> = {}) => {
  useEditorStore.setState({
    selectedImage: IMAGE,
    adjustments: makeAdjustments(overrides),
    activeAiPatchContainerId: null,
    activeAiSubMaskId: null,
    brushSettings: { size: 50, feather: 50, opacity: 100, tool: ToolType.Brush },
    isGeneratingAi: false,
    isGeneratingAiMask: false,
    isAIConnectorConnected: generativeEnabled,
    isSliderDragging: false,
    patchesSentToBackend: new Set<string>(),
    ...extra,
  } as never);
};

const renderPanel = (overrides: Partial<Adjustments> = {}, extra: Record<string, any> = {}) => {
  seedStore(overrides, extra);
  return render(<AIPanel />);
};

const adj = () => useEditorStore.getState().adjustments;
const patches = () => adj().aiPatches || [];
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

const tile = (name: string): HTMLElement => {
  const el = document.querySelector(`[data-tooltip="创建新的 ${name} 编辑"]`) as HTMLElement | null;
  if (!el) throw new Error(`creation tile not found: ${name}`);
  return el;
};

const row = (name: string): HTMLElement => {
  const text = screen.getByText(name, { selector: 'p' });
  return text.closest('.group') as HTMLElement;
};

const settingsSection = (title: string): HTMLElement => {
  const heading = screen.getByText(title, { selector: 'h2' });
  return heading.closest('.bg-surface.rounded-lg') as HTMLElement;
};

const panelRoot = (): HTMLElement =>
  document.querySelector('.flex.flex-col.h-full.select-none.overflow-hidden') as HTMLElement;

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

const dragStart = (data: any, id = 'active-id') =>
  act(() => dnd.onDragStart?.({ active: { id, data: { current: data } } }));
const dragEnd = (data: any, over: { id: string; data?: { current: any } } | null = null, id = 'active-id') =>
  act(() =>
    dnd.onDragEnd?.({
      active: { id, data: { current: data } },
      over: over ? { id: over.id, data: over.data ?? { current: undefined } } : null,
    }),
  );

let generativeEnabled = false;
const enableGenerative = () => {
  generativeEnabled = true;
  useSettingsStore.setState({ appSettings: { aiProvider: 'ai-connector' } as never } as never);
};

const seedPatch = (
  type: Mask,
  options: {
    id?: string;
    name?: string;
    subName?: string;
    params?: Record<string, any>;
    patch?: Record<string, any>;
    sub?: Record<string, any>;
    extra?: Record<string, any>;
    withSubMask?: boolean;
  } = {},
) => {
  const id = options.id || 'p1';
  const sub = makeSubMask('s1', type, {
    name: options.subName ?? '组件一',
    parameters: options.params ?? {},
    ...options.sub,
  });
  const patch = makePatch(id, options.name || '编辑 1', options.withSubMask === false ? [] : [sub], options.patch);
  const activeSubMaskId = options.withSubMask === false ? null : sub.id;
  seedStore({ aiPatches: [patch] }, { activeAiPatchContainerId: id, activeAiSubMaskId: activeSubMaskId, ...options.extra });
  return render(<AIPanel />);
};

const settingsTitleFor = (type: Mask): string => {
  const standalone = [Mask.Clone, Mask.Heal, Mask.AutoErase, Mask.Liquify, Mask.Retouch].includes(type);
  return standalone ? '选区属性' : '组件一 属性';
};

beforeEach(() => {
  showContextMenu.mockReset();
  clerk.isSignedIn = true;
  clerk.plan = undefined;
  generativeEnabled = false;
  dnd.onDragStart = null;
  dnd.onDragEnd = null;
  dnd.activeId = null;
  dnd.overId = null;
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'generate_ai_foreground_mask') return Promise.resolve({});
    return Promise.resolve(undefined);
  });
  useSettingsStore.setState({ appSettings: { aiProvider: 'cpu' } as never, osPlatform: 'linux' } as never);
  useProcessStore.setState({ aiModelDownloadStatus: null } as never);
  useUIStore.setState({ customEscapeHandler: null } as never);
  seedStore();
});

afterEach(() => {
  debouncedSetHistory.cancel();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('图像修复 · 空状态与创建入口', () => {
  it('未选择图像时显示空状态且不渲染工具网格', () => {
    useEditorStore.setState({ selectedImage: null, adjustments: makeAdjustments() } as never);
    render(<AIPanel />);
    expect(screen.getByText('未选择图像。')).toBeInTheDocument();
    expect(screen.queryByText('手动清理')).not.toBeInTheDocument();
    expect(screen.queryByText('添加新编辑')).not.toBeInTheDocument();
  });

  it('渲染标题、重置按钮与三组共 11 个创建入口', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: '图像修复' })).toBeInTheDocument();
    expect(document.querySelector('button[data-tooltip="重置图像修复"]')).toBeInTheDocument();
    expect(screen.getByText('手动清理')).toBeInTheDocument();
    expect(screen.getByText('润色')).toBeInTheDocument();
    expect(screen.getByText('生成式编辑')).toBeInTheDocument();
    for (const name of ['克隆', '修复', '自动消除', '液化', '修饰', '快速橡皮擦', '主体', '前景', '画笔', '线性', '径向']) {
      expect(tile(name)).toBeInTheDocument();
    }
  });

  it('AI 生成进行中时创建入口呈禁用外观', () => {
    renderPanel({}, { isGeneratingAi: true });
    const el = tile('克隆');
    expect(el.className).toContain('opacity-50');
    expect(el.className).toContain('cursor-not-allowed');
    expect(el.dataset.tooltip).toBe('创建新的 克隆 编辑');
  });

  it.each([
    ['克隆', Mask.Clone, '克隆 1'],
    ['修复', Mask.Heal, '修复 1'],
    ['自动消除', Mask.AutoErase, '自动消除 1'],
    ['液化', Mask.Liquify, '液化 1'],
    ['修饰', Mask.Retouch, '修饰 1'],
  ])('创建独立编辑「%s」：自动选中、画笔尺寸 100、隐藏生成式替换区', async (label, type, expectedName) => {
    renderPanel();
    fireEvent.click(tile(label));

    expect(patches()).toHaveLength(1);
    expect(patches()[0].name).toBe(expectedName);
    expect(patches()[0].subMasks[0].type).toBe(type);
    expect(useEditorStore.getState().activeAiPatchContainerId).toBe(patches()[0].id);
    expect(useEditorStore.getState().activeAiSubMaskId).toBe(patches()[0].subMasks[0].id);
    expect(useEditorStore.getState().brushSettings).toMatchObject({ size: 100, tool: ToolType.Brush });

    expect(await screen.findByText('选区属性')).toBeInTheDocument();
    expect(screen.queryByText('生成式替换')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('添加新组件')).not.toBeInTheDocument();
    expect(screen.getByText('画笔大小')).toBeInTheDocument();
  });

  it('创建快速擦除：容器展开、可选组件、显示快速擦除说明', async () => {
    renderPanel();
    fireEvent.click(tile('快速橡皮擦'));

    expect(patches()[0].name).toBe('快速擦除 1');
    const sub = patches()[0].subMasks[0];
    expect(sub.type).toBe(Mask.QuickEraser);
    expect(sub.parameters).toMatchObject({ grow: 75, feather: 75 });

    expect(await screen.findByText('快速橡皮擦 属性')).toBeInTheDocument();
    await screen.findByText('快速擦除 1');
    expect(await screen.findByText('添加新组件')).toBeInTheDocument();
    expect(screen.getByText('填充选区以移除对象。')).toBeInTheDocument();
    expect(screen.getByText('生成式替换')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修复选区' })).toBeInTheDocument();
  });

  it('创建主体编辑：默认参数、展开并触发预计算', async () => {
    renderPanel();
    fireEvent.click(tile('主体'));

    expect(patches()[0].name).toBe('AI 编辑 1');
    const sub = patches()[0].subMasks[0];
    expect(sub.type).toBe(Mask.AiSubject);
    expect(sub.parameters).toMatchObject({ grow: 50, feather: 25 });

    expect(await screen.findByText('主体 属性')).toBeInTheDocument();
    await screen.findByText('AI 编辑 1');
    expect(await screen.findByText('添加新组件')).toBeInTheDocument();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('precompute_ai_subject_mask', expect.anything()));
  });

  it('创建前景编辑：自动触发生成并合并蒙版参数', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_ai_foreground_mask') return Promise.resolve({ maskDataBase64: 'fg' });
      return Promise.resolve(undefined);
    });
    renderPanel();
    fireEvent.click(tile('前景'));

    expect(patches()[0].subMasks[0].type).toBe(Mask.AiForeground);
    await waitFor(() =>
      expect(patches()[0].subMasks[0].parameters).toMatchObject({ maskDataBase64: 'fg' }),
    );
    expect(mockInvoke).toHaveBeenCalledWith('generate_ai_foreground_mask', expect.anything());
  });

  it('创建画笔编辑：强制画笔工具与尺寸 100', async () => {
    renderPanel();
    fireEvent.click(tile('画笔'));

    expect(patches()[0].subMasks[0].type).toBe(Mask.Brush);
    expect(useEditorStore.getState().brushSettings).toMatchObject({ size: 100, tool: ToolType.Brush });
    expect(await screen.findByText('画笔 属性')).toBeInTheDocument();
    expect(screen.getByText('画笔大小')).toBeInTheDocument();
  });

  it('创建线性编辑：按短边写入 range 与初始绘制哨兵值', () => {
    renderPanel();
    fireEvent.click(tile('线性'));
    const linear = patches()[0].subMasks[0];
    expect(linear.type).toBe(Mask.Linear);
    expect(linear.parameters.range).toBe(300);
    expect(linear.parameters.isInitialDraw).toBe(true);
    expect(linear.parameters.startX).toBe(-10000);
    expect(linear.parameters.endY).toBe(-10000);
  });

  it('创建径向编辑：羽化归一化并写入感测哨兵值', () => {
    renderPanel();
    fireEvent.click(tile('径向'));
    const radial = patches()[0].subMasks[0];
    expect(radial.type).toBe(Mask.Radial);
    expect(radial.parameters.feather).toBe(0.5);
    expect(radial.parameters.radiusX).toBe(0);
    expect(radial.parameters.centerX).toBe(-10000);
    expect(radial.parameters.isInitialDraw).toBe(true);
  });

  it('重复创建独立编辑按数量递增命名', async () => {
    renderPanel();
    fireEvent.click(tile('克隆'));
    await screen.findByText('克隆 1');
    fireEvent.click(screen.getByText('添加新编辑'));
    runMenu(menuOption('克隆'));
    expect(patches().map((p) => p.name)).toEqual(['克隆 1', '克隆 2']);
  });

  it('从全局“添加新编辑”菜单创建生成式编辑并按总数命名', async () => {
    seedStore({ aiPatches: [makePatch('old', '克隆 1', [makeSubMask('old-s', Mask.Clone)])] });
    render(<AIPanel />);
    fireEvent.click(screen.getByText('添加新编辑'));

    expect(showContextMenu).toHaveBeenCalled();
    expect(menuOptions().filter((o) => o.label).map((o) => o.label)).toEqual([
      '克隆',
      '修复',
      '自动消除',
      '液化',
      '修饰',
      '快速橡皮擦',
      '主体',
      '前景',
      '画笔',
      '线性',
      '径向',
    ]);
    runMenu(menuOption('画笔'));
    expect(patches()).toHaveLength(2);
    expect(patches()[1].name).toBe('AI 编辑 2');
    expect(patches()[1].subMasks[0].type).toBe(Mask.Brush);
  });

  it('生成中点击重置不会清空编辑列表', () => {
    seedStore(
      { aiPatches: [makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })])] },
      { isGeneratingAi: true },
    );
    render(<AIPanel />);
    fireEvent.click(document.querySelector('button[data-tooltip="重置图像修复"]')!);
    expect(patches()).toHaveLength(1);
  });

  it('重置图像修复清空所有编辑与选中状态', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel(
      { aiPatches: [patch] },
      { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's1' },
    );
    expect(await screen.findByText('编辑 1')).toBeInTheDocument();
    fireEvent.click(document.querySelector('button[data-tooltip="重置图像修复"]')!);
    expect(patches()).toEqual([]);
    expect(useEditorStore.getState().activeAiPatchContainerId).toBeNull();
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();
  });
});

describe('图像修复 · 连接状态', () => {
  it('内置 CPU 显示就绪与说明', () => {
    renderPanel();
    expect(screen.getByText('内置 AI：')).toBeInTheDocument();
    expect(screen.getByText('就绪')).toBeInTheDocument();
    expect(screen.getByText('使用基础本地 CPU。在设置中选择云端或 AI 连接器以使用生成式替换。')).toBeInTheDocument();
  });

  it('AI 连接器已连接与未连接状态', () => {
    useSettingsStore.setState({ appSettings: { aiProvider: 'ai-connector' } as never } as never);
    renderPanel({}, { isAIConnectorConnected: true });
    expect(screen.getByText('AI 连接器：')).toBeInTheDocument();
    expect(screen.getByText('已连接到本地生成式后端。')).toBeInTheDocument();

    cleanup();
    renderPanel({}, { isAIConnectorConnected: false });
    expect(screen.getByText('未检测到')).toBeInTheDocument();
    expect(screen.getByText('仅可使用简单修复。请启动您的本地后端。')).toBeInTheDocument();
  });

  it('云端未订阅显示需要升级', () => {
    useSettingsStore.setState({ appSettings: { aiProvider: 'cloud' } as never } as never);
    renderPanel();
    expect(screen.getByText('云端 AI：')).toBeInTheDocument();
    expect(screen.getByText('需要升级')).toBeInTheDocument();
    expect(screen.getByText('需要 Pro 订阅。请在设置中升级。')).toBeInTheDocument();
  });

  it('云端已订阅显示就绪并拉取月度用量', async () => {
    clerk.plan = 'pro';
    useSettingsStore.setState({ appSettings: { aiProvider: 'cloud' } as never } as never);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requests: 120, limit: 500, month: '2026-10' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    expect(screen.getByText('云端 AI：')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('120 / 500 请求')).toBeInTheDocument());
    expect(screen.getByText('月度使用量')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5000/usage', expect.anything());
  });

  it('云端未登录显示未登录', () => {
    clerk.isSignedIn = false;
    useSettingsStore.setState({ appSettings: { aiProvider: 'cloud' } as never } as never);
    renderPanel();
    expect(screen.getByText('未登录')).toBeInTheDocument();
    expect(screen.getByText('通过设置登录以使用云端 AI。')).toBeInTheDocument();
  });
});

describe('图像修复 · 编辑列表与容器操作', () => {
  const seedOne = () => {
    const sub = makeSubMask('s1', Mask.Brush, { name: '组件一' });
    const patch = makePatch('p1', '编辑 1', [sub]);
    seedStore({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    return render(<AIPanel />);
  };

  it('渲染编辑标题、容器名称与添加新编辑入口', async () => {
    seedOne();
    expect(await screen.findByText('编辑')).toBeInTheDocument();
    expect(screen.getByText('编辑 1')).toBeInTheDocument();
    expect(screen.getByText('添加新编辑')).toBeInTheDocument();
  });

  it('点击容器行仅选中容器并显示“选区属性”', async () => {
    seedOne();
    await screen.findByText('组件一');
    fireEvent.click(row('编辑 1'));
    expect(useEditorStore.getState().activeAiPatchContainerId).toBe('p1');
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();
    expect(await screen.findByText('选区属性')).toBeInTheDocument();
  });

  it('文件夹图标与双击名称折叠/展开组件', async () => {
    seedOne();
    await screen.findByText('组件一');
    fireEvent.click(row('编辑 1').querySelector('.lucide-folder-open, .lucide-wand-2')!);
    await waitFor(() => expect(screen.queryByText('组件一')).not.toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText('编辑 1', { selector: 'p' }));
    expect(await screen.findByText('组件一')).toBeInTheDocument();
  });

  it('容器右键菜单结构完整，重命名支持 Enter 与空白忽略', async () => {
    seedOne();
    await screen.findByText('组件一');

    fireEvent.contextMenu(row('编辑 1'));
    expect(menuOptions().map((o) => o.label)).toEqual([
      '重命名',
      '复制编辑',
      '复制并反转编辑',
      '复制编辑',
      '粘贴编辑',
      undefined,
      '重置选区',
      '删除编辑',
    ]);
    expect(menuOptions()[4].disabled).toBe(true);

    runMenu(menuOptions()[0]);
    const input = screen.getByDisplayValue('编辑 1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '人像修复' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(patches()[0].name).toBe('人像修复');

    fireEvent.contextMenu(row('人像修复'));
    runMenu(menuOptions()[0]);
    const blank = screen.getByDisplayValue('人像修复') as HTMLInputElement;
    fireEvent.change(blank, { target: { value: '   ' } });
    fireEvent.blur(blank);
    expect(patches()[0].name).toBe('人像修复');
  });

  it('复制编辑在原位置之后插入新 ID 副本', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    renderPanel({ aiPatches: [a, b] }, { activeAiPatchContainerId: 'a' });
    await screen.findByText('组件甲');

    fireEvent.contextMenu(row('编辑 A'));
    runMenu(menuOptions()[1]);

    expect(patches().map((p) => p.name)).toEqual(['编辑 A', '编辑 A Copy', '编辑 B']);
    expect(patches()[1].id).not.toBe('a');
    expect(patches()[1].subMasks[0].id).not.toBe('a1');
    expect(patches()[1].patchData).toBeNull();
    expect(useEditorStore.getState().activeAiPatchContainerId).toBe(patches()[1].id);
  });

  it('复制并反转编辑翻转容器反转标记并重命名', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })], { invert: false });
    renderPanel({ aiPatches: [a] }, { activeAiPatchContainerId: 'a' });
    await screen.findByText('组件甲');

    fireEvent.contextMenu(row('编辑 A'));
    runMenu(menuOptions()[2]);

    expect(patches()).toHaveLength(2);
    expect(patches()[1].name).toBe('编辑 A 反转');
    expect(patches()[1].invert).toBe(true);
    expect(patches()[1].subMasks[0].id).not.toBe('a1');
  });

  it('复制与粘贴编辑：菜单禁用联动，粘贴插入到目标之后并保留名称', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })], {
      patchData: { old: true },
    });
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    renderPanel({ aiPatches: [a, b] }, { activeAiPatchContainerId: 'a' });
    await screen.findByText('组件甲');

    fireEvent.contextMenu(row('编辑 A'));
    runMenu(menuOptions()[3]); // copy
    fireEvent.contextMenu(row('编辑 B'));
    expect(menuOptions()[4].disabled).toBe(false);
    runMenu(menuOptions()[4]);

    expect(patches().map((p) => p.name)).toEqual(['编辑 A', '编辑 B', '编辑 A']);
    expect(patches()[2].id).not.toBe('a');
    expect(patches()[2].subMasks[0].id).not.toBe('a1');
    expect(patches()[2].patchData).toBeNull();
    expect(patches()[2].name).toBe('编辑 A');
  });

  it('重置选区清空容器全部组件，且菜单只对普通编辑显示该项', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const s = makePatch('s', '克隆 1', [makeSubMask('s1', Mask.Clone, { name: '克隆组件' })]);
    renderPanel({ aiPatches: [a, s] }, { activeAiPatchContainerId: 'a' });
    await screen.findByText('组件甲');

    fireEvent.contextMenu(row('编辑 A'));
    runMenu(menuOptions()[6]);
    expect(patches()[0].subMasks).toEqual([]);

    fireEvent.contextMenu(row('克隆 1'));
    expect(menuOptions().map((o) => o.label)).toEqual([
      '重命名',
      '复制编辑',
      '复制并反转编辑',
      '复制编辑',
      '粘贴编辑',
      undefined,
      '删除编辑',
    ]);
  });

  it('容器可见性按钮切换 visible 与提示', async () => {
    seedOne();
    await screen.findByText('组件一');
    const hide = row('编辑 1').querySelector('button[data-tooltip="隐藏编辑"]') as HTMLButtonElement;
    fireEvent.click(hide);
    expect(patches()[0].visible).toBe(false);
    expect(row('编辑 1').querySelector('button[data-tooltip="显示编辑"]')).toBeInTheDocument();
  });

  it('行内垃圾桶与右键删除清理选中并保留其余编辑', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    renderPanel({ aiPatches: [a, b] }, { activeAiPatchContainerId: 'a', activeAiSubMaskId: 'a1' });
    await screen.findByText('组件甲');

    fireEvent.click(row('编辑 A').querySelectorAll('button')[1]);
    expect(patches().map((p) => p.id)).toEqual(['b']);
    expect(useEditorStore.getState().activeAiPatchContainerId).toBeNull();
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();

    fireEvent.contextMenu(row('编辑 B'));
    runMenu(menuOptions().at(-1));
    expect(patches()).toEqual([]);
  });

  it('独立编辑行点击同时选中容器与首组件，不提供展开与添加组件', async () => {
    const s = makePatch('s', '克隆 1', [makeSubMask('s1', Mask.Clone, { name: '克隆组件' })]);
    renderPanel({ aiPatches: [s] });
    await screen.findByText('克隆 1');

    fireEvent.click(row('克隆 1'));
    expect(useEditorStore.getState().activeAiPatchContainerId).toBe('s');
    expect(useEditorStore.getState().activeAiSubMaskId).toBe('s1');
    expect(await screen.findByText('选区属性')).toBeInTheDocument();
    expect(screen.queryByText('添加新组件')).not.toBeInTheDocument();
    expect(screen.queryByText('克隆组件')).not.toBeInTheDocument();
  });

  it('面板空白处右键：粘贴编辑禁用并提供新增编辑子菜单', async () => {
    seedOne();
    await screen.findByText('编辑 1');
    fireEvent.contextMenu(panelRoot());
    expect(menuOptions().map((o) => o.label)).toEqual(['粘贴编辑', '添加新编辑']);
    expect(menuOptions()[0].disabled).toBe(true);
    const submenu = menuOptions()[1].submenu!;
    expect(submenu.filter((o) => o.label).map((o) => o.label)).toEqual([
      '克隆',
      '修复',
      '自动消除',
      '液化',
      '修饰',
      '快速橡皮擦',
      '主体',
      '前景',
      '画笔',
      '线性',
      '径向',
    ]);
    runMenu(submenu.find((o) => o.label === '线性'));
    expect(patches()).toHaveLength(2);
    expect(patches()[1].subMasks[0].type).toBe(Mask.Linear);
  });

  it('复制编辑后可从面板菜单粘贴到列表末尾', async () => {
    seedOne();
    await screen.findByText('编辑 1');
    fireEvent.contextMenu(row('编辑 1'));
    runMenu(menuOptions()[3]);
    fireEvent.contextMenu(panelRoot());
    expect(menuOptions()[0].disabled).toBe(false);
    runMenu(menuOptions()[0]);
    expect(patches().map((p) => p.name)).toEqual(['编辑 1', '编辑 1']);
    expect(patches()[1].id).not.toBe('p1');
  });

  it('未选择图像时面板右键不弹菜单', () => {
    useEditorStore.setState({ selectedImage: null, adjustments: makeAdjustments() } as never);
    render(<AIPanel />);
    fireEvent.contextMenu(panelRoot());
    expect(showContextMenu).not.toHaveBeenCalled();
  });

  it('容器加载中时行图标显示加载指示器', async () => {
    const p = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })], { isLoading: true });
    renderPanel({ aiPatches: [p] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('编辑 1');
    await waitFor(
      () => expect(row('编辑 1').querySelector('.lucide-loader-circle')).toBeInTheDocument(),
      { timeout: 1500 },
    );
  });
});

describe('图像修复 · 组件操作', () => {
  const seedContainer = (subMasks = [
    makeSubMask('s1', Mask.Brush, { name: '组件一' }),
    makeSubMask('s2', Mask.Linear, { name: '组件二' }),
    makeSubMask('s3', Mask.Radial, { name: '组件三' }),
  ]) => {
    const patch = makePatch('p1', '编辑 1', subMasks);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's2' });
  };

  it('点击组件行选中组件并显示“组件 属性”', async () => {
    seedContainer();
    await screen.findByText('组件一');
    expect(screen.getByText('组件二 属性')).toBeInTheDocument();
    fireEvent.click(row('组件一'));
    expect(useEditorStore.getState().activeAiSubMaskId).toBe('s1');
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
  });

  it('组件右键菜单完整，重命名支持失焦提交', async () => {
    seedContainer();
    await screen.findByText('组件一');

    fireEvent.contextMenu(row('组件一'));
    expect(menuOptions().map((o) => o.label)).toEqual([
      '重命名',
      '复制组件',
      '复制并反转组件',
      '复制组件',
      '粘贴组件',
      undefined,
      '删除组件',
    ]);
    expect(menuOptions()[4].disabled).toBe(true);

    runMenu(menuOptions()[0]);
    const input = screen.getByDisplayValue('组件一') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '遮罩层' } });
    fireEvent.blur(input);
    expect(patches()[0].subMasks[0].name).toBe('遮罩层');
  });

  it('复制组件在原组件后插入新 ID 副本', async () => {
    seedContainer();
    await screen.findByText('组件一');
    fireEvent.contextMenu(row('组件一'));
    runMenu(menuOptions()[1]);
    expect(patches()[0].subMasks).toHaveLength(4);
    expect(patches()[0].subMasks[1].name).toBe('组件一 Copy');
    expect(patches()[0].subMasks[1].id).not.toBe('s1');
    expect(useEditorStore.getState().activeAiSubMaskId).toBe(patches()[0].subMasks[1].id);
  });

  it('复制并反转组件生成独立容器，父容器保持不变', async () => {
    seedContainer();
    await screen.findByText('组件二');

    fireEvent.contextMenu(row('组件二'));
    runMenu(menuOptions()[2]);

    expect(patches()).toHaveLength(2);
    expect(patches()[1].name).toBe('组件二 反转');
    expect(patches()[1].subMasks).toHaveLength(1);
    expect(patches()[1].subMasks[0].invert).toBe(true);
    expect(patches()[1].subMasks[0].id).not.toBe('s2');
    expect(patches()[1].invert).toBe(false);
    expect(patches()[0].subMasks[1].invert).toBe(false);
  });

  it('复制/粘贴组件支持跨容器粘贴并生成新 ID', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    renderPanel({ aiPatches: [a, b] }, { activeAiPatchContainerId: 'a', activeAiSubMaskId: 'a1' });
    await screen.findByText('组件甲');

    fireEvent.contextMenu(row('组件甲'));
    runMenu(menuOptions()[3]); // copy
    fireEvent.contextMenu(row('组件甲'));
    expect(menuOptions()[4].disabled).toBe(false);

    fireEvent.click(row('编辑 B').querySelector('.lucide-wand-sparkles')!);
    await screen.findByText('组件乙');
    fireEvent.contextMenu(row('组件乙'));
    runMenu(menuOptions()[4]);
    expect(patches()[1].subMasks).toHaveLength(2);
    expect(patches()[1].subMasks[1].id).not.toBe('a1');
    expect(patches()[1].subMasks[1].name).toBe('组件甲');
  });

  it('删除组件清除选中并保留其余组件', async () => {
    seedContainer();
    await screen.findByText('组件一');
    fireEvent.contextMenu(row('组件二'));
    runMenu(menuOptions()[6]);
    expect(patches()[0].subMasks.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();

    const trash = Array.from(row('组件三').querySelectorAll('button')).at(-1) as HTMLButtonElement;
    fireEvent.click(trash);
    expect(patches()[0].subMasks.map((s) => s.id)).toEqual(['s1']);
  });

  it('第二个及之后的组件循环切换添加/减去/相交模式', async () => {
    seedContainer();
    await screen.findByText('组件二');
    const button = () => row('组件二').querySelector('[data-tooltip]') as HTMLButtonElement;
    expect(button().dataset.tooltip).toBe('切换到减去');
    fireEvent.click(button());
    expect(patches()[0].subMasks[1].mode).toBe(SubMaskMode.Subtractive);
    expect(button().dataset.tooltip).toBe('切换到相交');
    fireEvent.click(button());
    expect(patches()[0].subMasks[1].mode).toBe(SubMaskMode.Intersect);
    expect(button().dataset.tooltip).toBe('切换到添加');
    fireEvent.click(button());
    expect(patches()[0].subMasks[1].mode).toBe(SubMaskMode.Additive);
  });

  it('悬停第二个组件时显示序号，离开后恢复图标', async () => {
    seedContainer();
    await screen.findByText('组件二');
    const target = row('组件二');
    expect(target.querySelector('.lucide-triangle-right')).toBeInTheDocument();

    fireEvent.mouseEnter(target);
    await wait(200);
    expect(within(target).getByText('2')).toBeInTheDocument();

    fireEvent.mouseLeave(target);
    await waitFor(() => expect(within(target).queryByText('2')).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it('父容器隐藏时组件行呈半透明', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })], { visible: false });
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');
    expect(row('组件一').className).toContain('opacity-50');
  });

  it('“添加新组件”菜单仅包含非独立类型，并支持减去/相交子菜单', async () => {
    seedContainer();
    await screen.findByText('组件一');
    fireEvent.click(screen.getByText('添加新组件'));

    expect(menuOptions().filter((o) => o.label).map((o) => o.label)).toEqual([
      '快速橡皮擦',
      '主体',
      '前景',
      '画笔',
      '线性',
      '径向',
      '从编辑中减去',
      '与编辑相交',
    ]);
    runMenu(menuOption('从编辑中减去')!.submenu!.find((o) => o.label === '线性'));
    expect(patches()[0].subMasks).toHaveLength(4);
    expect(patches()[0].subMasks[3].type).toBe(Mask.Linear);
    expect(patches()[0].subMasks[3].mode).toBe(SubMaskMode.Subtractive);

    fireEvent.click(screen.getByText('添加新组件'));
    runMenu(menuOption('与编辑相交')!.submenu!.find((o) => o.label === '径向'));
    expect(patches()[0].subMasks[4].type).toBe(Mask.Radial);
    expect(patches()[0].subMasks[4].mode).toBe(SubMaskMode.Intersect);
  });

  it('空容器仅显示基础添加项，不含减去/相交', async () => {
    const patch = makePatch('p1', '编辑 1', []);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    fireEvent.click(await screen.findByText('添加新组件'));
    expect(menuOptions().filter((o) => o.label).map((o) => o.label)).toEqual([
      '快速橡皮擦',
      '主体',
      '前景',
      '画笔',
      '线性',
      '径向',
    ]);
  });

  it('未选中且已有组件的展开容器不显示“添加新组件”', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [
      makeSubMask('b1', Mask.Linear, { name: '组件乙' }),
      makeSubMask('b2', Mask.Radial, { name: '组件丙' }),
    ]);
    renderPanel({ aiPatches: [a, b] }, { activeAiPatchContainerId: 'b', activeAiSubMaskId: 'b1' });
    await screen.findByText('组件乙');
    fireEvent.click(row('编辑 A').querySelector('.lucide-wand-sparkles, .lucide-folder-open')!);
    expect(await screen.findByText('组件甲')).toBeInTheDocument();
    expect(screen.getAllByText('添加新组件')).toHaveLength(1);
  });

  it('AI 蒙版生成 200ms 后在对应组件行显示分析指示器', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.AiSubject, { name: '主体组件', parameters: { grow: 50, feather: 25 } }),
    ]);
    renderPanel(
      { aiPatches: [patch] },
      { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's1', isGeneratingAiMask: true },
    );
    await screen.findByText('主体组件');
    expect(row('主体组件').querySelector('.lucide-loader-circle')).toBeNull();
    await waitFor(
      () => expect(row('主体组件').querySelector('.lucide-loader-circle')).toBeInTheDocument(),
      { timeout: 1500 },
    );
  });

  it('快速擦除组件在父容器加载时立即显示分析指示器', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.QuickEraser, { name: '快擦组件' })], {
      isLoading: true,
    });
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('快擦组件');
    await waitFor(() => expect(row('快擦组件').querySelector('.lucide-loader-circle')).toBeInTheDocument());
  });

  it('非 AI 组件在生成状态下不显示分析指示器', async () => {
    seedContainer([makeSubMask('s1', Mask.Brush, { name: '普通组件' })]);
    await screen.findByText('普通组件');
    await wait(300);
    expect(row('普通组件').querySelector('.lucide-loader-circle')).toBeNull();
  });
});

describe('图像修复 · 设置面板', () => {
  it('未选中编辑时设置面板呈禁用占位状态', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] });
    const title = await screen.findByText('选区属性');
    const root = title.closest('.space-y-2') as HTMLElement;
    expect(root.className).toContain('opacity-50');
    expect(root.className).toContain('pointer-events-none');
    expect(screen.getByRole('button', { name: '修复选区' })).toBeDisabled();
  });

  it('独立编辑隐藏生成式替换区且不显示反转开关', async () => {
    seedPatch(Mask.Clone, { patch: { invert: true } });
    expect(await screen.findByText('选区属性')).toBeInTheDocument();
    expect(screen.queryByText('生成式替换')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('画笔大小')).toBeInTheDocument();
  });

  it('生成式后端不可用时显示端侧提示与基础修复说明', async () => {
    seedPatch(Mask.Brush, { params: { lines: [] } });
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
    expect(screen.getByText('端侧 AI 修复：离线可用，照片数据不离开本设备。')).toBeInTheDocument();
    expect(screen.getByText('基于周围像素填充选区。')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '使用基础图像修复' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('例如，一片花海')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修复选区' })).toBeEnabled();
  });

  it('生成式后端可用时默认显示提示词输入与“使用 AI 生成”', async () => {
    enableGenerative();
    seedPatch(Mask.Brush, { params: { lines: [] }, patch: { prompt: '旧提示' } });
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
    expect(screen.getByText('描述您想要在选定区域生成的内容。')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('例如，一片花海') as HTMLInputElement;
    expect(input.value).toBe('旧提示');
    expect(screen.getByRole('button', { name: '使用 AI 生成' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '使用基础图像修复' })).not.toBeChecked();
  });

  it('快速擦除在生成式后端下默认勾选基础修复并显示专属说明', async () => {
    enableGenerative();
    seedPatch(Mask.QuickEraser, { params: { grow: 75, feather: 75 } });
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '使用基础图像修复' })).toBeChecked();
    expect(screen.getByText('填充选区以移除对象。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修复选区' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByPlaceholderText('例如，一片花海')).not.toBeInTheDocument());
  });

  it('切换基础修复开关：隐藏/显示提示词并切换说明与按钮文案', async () => {
    enableGenerative();
    seedPatch(Mask.Brush, { params: { lines: [] } });
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
    const toggle = screen.getByRole('checkbox', { name: '使用基础图像修复' });

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByPlaceholderText('例如，一片花海')).not.toBeInTheDocument());
    expect(screen.getByText('基于周围像素填充选区。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修复选区' })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(await screen.findByPlaceholderText('例如，一片花海')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用 AI 生成' })).toBeInTheDocument();
  });

  it('提示词失焦写回容器 prompt', async () => {
    enableGenerative();
    seedPatch(Mask.Brush, { params: { lines: [] } });
    const input = (await screen.findByPlaceholderText('例如，一片花海')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '蓝色天空' } });
    fireEvent.blur(input);
    expect(patches()[0].prompt).toBe('蓝色天空');
  });

  it('基础修复生成成功：传递 useFastInpaint/token 并写入 patchData 与 Inpaint 名称', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'invoke_generative_replace_with_mask_def'
        ? Promise.resolve(JSON.stringify({ patchDataBase64: 'basic' }))
        : Promise.resolve(undefined),
    );
    seedPatch(Mask.Brush, { params: { lines: [] } });
    fireEvent.click(await screen.findByRole('button', { name: '修复选区' }));

    await waitFor(() => expect(patches()[0].patchData).toEqual({ patchDataBase64: 'basic' }));
    expect(patches()[0].name).toBe('Inpaint');
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'invoke_generative_replace_with_mask_def')!;
    expect(call[1]).toMatchObject({ useFastInpaint: true, token: null, path: IMAGE.path });
    await waitFor(() => expect(useEditorStore.getState().activeAiPatchContainerId).toBeNull());
  });

  it('生成式 AI 生成成功：Enter 提交提示词并更新名称', async () => {
    enableGenerative();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'invoke_generative_replace_with_mask_def'
        ? Promise.resolve(JSON.stringify({ patchDataBase64: 'gen' }))
        : Promise.resolve(undefined),
    );
    seedPatch(Mask.Brush, { params: { lines: [] } });
    const input = (await screen.findByPlaceholderText('例如，一片花海')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '一只白猫' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(patches()[0].patchData).toEqual({ patchDataBase64: 'gen' }));
    expect(patches()[0].name).toBe('一只白猫');
    expect(patches()[0].prompt).toBe('一只白猫');
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'invoke_generative_replace_with_mask_def')!;
    expect(call[1]).toMatchObject({ useFastInpaint: false, token: 'mock-token' });
  });

  it('生成失败时恢复加载状态并提示错误', async () => {
    enableGenerative();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'invoke_generative_replace_with_mask_def'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(undefined),
    );
    seedPatch(Mask.Brush, { params: { lines: [] } });
    fireEvent.click(await screen.findByRole('button', { name: '使用 AI 生成' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(patches()[0].isLoading).toBe(false);
    expect(useEditorStore.getState().isGeneratingAi).toBe(false);
    expect(patches()[0].patchData).toBeNull();
  });

  it('生成中按钮禁用并显示“生成中...”', async () => {
    enableGenerative();
    seedPatch(Mask.Brush, { params: { lines: [] }, extra: { isGeneratingAi: true } });
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '生成中...' });
    expect(button).toBeDisabled();
    expect(screen.getByPlaceholderText('例如，一片花海')).toBeDisabled();
  });

  it('容器自身加载时按钮禁用并显示“生成中...”', async () => {
    seedPatch(Mask.Brush, { params: { lines: [] }, patch: { isLoading: true } });
    expect(await screen.findByText('组件一 属性')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成中...' })).toBeDisabled();
  });

  it('没有组件时生成按钮禁用', async () => {
    enableGenerative();
    seedPatch(Mask.Brush, { withSubMask: false });
    expect(await screen.findByText('选区属性')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用 AI 生成' })).toBeDisabled();
  });

  it('模型下载状态：生成式替换区仅在 Inpainting 时展示下载提示', async () => {
    useProcessStore.setState({ aiModelDownloadStatus: 'Inpainting 45%' } as never);
    seedPatch(Mask.Brush, { params: { lines: [] } });
    expect(await screen.findByText('下载中：')).toBeInTheDocument();
    expect(screen.getByText('Inpainting 45%')).toBeInTheDocument();

    cleanup();
    useProcessStore.setState({ aiModelDownloadStatus: 'Depth 10%' } as never);
    seedPatch(Mask.Brush, { params: { lines: [] } });
    await screen.findByText('组件一 属性');
    expect(screen.queryByText('下载中：')).not.toBeInTheDocument();
  });

  it('AI 蒙版组件展示模型下载提示', async () => {
    useProcessStore.setState({ aiModelDownloadStatus: 'Subject 30%' } as never);
    seedPatch(Mask.AiSubject, { params: { grow: 50, feather: 25 } });
    expect(await screen.findByText('AI 模型下载中：')).toBeInTheDocument();
    expect(screen.getByText('Subject 30%')).toBeInTheDocument();
  });

  it('容器反转开关写入容器 invert', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1', activeAiSubMaskId: null });
    await screen.findByText('选区属性');
    fireEvent.click(screen.getByRole('checkbox', { name: '反转选区' }));
    expect(patches()[0].invert).toBe(true);
  });

  it('组件反转开关写入组件 invert', async () => {
    seedPatch(Mask.Brush, { params: { lines: [] } });
    await screen.findByText('组件一 属性');
    fireEvent.click(screen.getByRole('checkbox', { name: '反转组件' }));
    expect(patches()[0].subMasks[0].invert).toBe(true);
  });

  it('径向羽化滑块按 100 倍归一化写入', async () => {
    seedPatch(Mask.Radial, { params: { feather: 0.5 } });
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');
    const feather = getSlider('羽化', scope);
    await waitFor(() => expect(feather.value).toBe('50'));
    fireEvent.change(feather, { target: { value: '70' } });
    expect(patches()[0].subMasks[0].parameters.feather).toBe(0.7);
  });

  it('自动消除灵敏度滑块与松手触发自动消除补丁', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'generate_auto_erase_patch' ? Promise.resolve(JSON.stringify({ patched: true })) : Promise.resolve(undefined),
    );
    seedPatch(Mask.AutoErase, { params: { sensitivity: 60, sourceX: 12, sourceY: 34 } });
    await screen.findByText('选区属性');
    const scope = settingsSection('选区属性');
    expect(getSlider('灵敏度', scope)).toBeInTheDocument();
    expect(getSlider('画笔大小', scope)).toBeInTheDocument();

    fireEvent.click(within(scope).getByText('灵敏度', { selector: 'span' }));
    await waitFor(() =>
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'generate_auto_erase_patch')).toBe(true),
    );
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'generate_auto_erase_patch')!;
    expect(call[1]).toMatchObject({ sourcePoint: [12, 34] });
    await waitFor(() => expect(patches()[0].patchData).toEqual({ patched: true }));
  });

  it('液化压力滑块、模式下拉与模式变更触发补丁重算', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'generate_liquify_patch' ? Promise.resolve(JSON.stringify({ warped: true })) : Promise.resolve(undefined),
    );
    seedPatch(Mask.Liquify, {
      params: { pressure: 40, lines: [{ x: 1 }], liquifyMode: 'push' },
    });
    await screen.findByText('选区属性');
    const scope = settingsSection('选区属性');
    expect(getSlider('压力', scope)).toBeInTheDocument();
    fireEvent.change(getSlider('压力', scope), { target: { value: '66' } });
    expect(patches()[0].subMasks[0].parameters.pressure).toBe(66);

    const trigger = within(scope).getByRole('button', { name: /推动/ });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: '捏合' }));
    expect(patches()[0].subMasks[0].parameters.liquifyMode).toBe('pinch');
    await waitFor(() => expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'generate_liquify_patch')).toBe(true));
  });

  it('液化模式无笔画时不触发补丁重算', async () => {
    seedPatch(Mask.Liquify, { params: { pressure: 40, lines: [], liquifyMode: 'push' } });
    await screen.findByText('选区属性');
    const scope = settingsSection('选区属性');
    fireEvent.click(within(scope).getByRole('button', { name: /推动/ }));
    fireEvent.click(await screen.findByRole('option', { name: '膨胀' }));
    await wait(50);
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'generate_liquify_patch')).toBe(false);
  });

  it('修饰强度滑块：有笔画时松手触发修饰补丁', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'generate_retouch_patch' ? Promise.resolve(JSON.stringify({ retouched: true })) : Promise.resolve(undefined),
    );
    seedPatch(Mask.Retouch, { params: { intensity: 40, lines: [{ x: 1 }] } });
    await screen.findByText('选区属性');
    const scope = settingsSection('选区属性');
    fireEvent.click(within(scope).getByText('强度', { selector: 'span' }));
    await waitFor(() => expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'generate_retouch_patch')).toBe(true));
  });

  it('修饰强度无笔画时不触发补丁', async () => {
    seedPatch(Mask.Retouch, { params: { intensity: 40, lines: [] } });
    await screen.findByText('选区属性');
    const scope = settingsSection('选区属性');
    fireEvent.click(within(scope).getByText('强度', { selector: 'span' }));
    await wait(50);
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'generate_retouch_patch')).toBe(false);
  });

  it.each([
    [Mask.AiSubject, { grow: 50, feather: 25 }, '扩展', 50, '羽化', 25],
    [Mask.AiSky, { grow: 0, feather: 0 }, '扩展', 0, '羽化', 0],
    [Mask.QuickEraser, { grow: 75, feather: 75 }, '扩展', 75, '羽化', 75],
  ])('类型 %s 渲染扩展/羽化滑块并写回参数', async (type, params, labelA, valueA, labelB, valueB) => {
    seedPatch(type as Mask, { params });
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');
    const grow = getSlider(labelA, scope);
    const feather = getSlider(labelB, scope);
    await waitFor(() => expect(grow.value).toBe(String(valueA)));
    expect(Number(feather.value)).toBe(valueB);
    fireEvent.change(grow, { target: { value: '20' } });
    expect(patches()[0].subMasks[0].parameters.grow).toBe(20);
  });

  it.each([
    [Mask.Brush, {}],
    [Mask.Clone, {}],
    [Mask.Heal, {}],
    [Mask.AutoErase, { sensitivity: 55 }],
    [Mask.Liquify, { pressure: 40 }],
    [Mask.Retouch, { intensity: 40 }],
  ])('类型 %s 显示画笔工具并可切换添加/擦除', async (type, params) => {
    seedPatch(type as Mask, { params });
    expect(await screen.findByText('画笔大小')).toBeInTheDocument();
    const scope = settingsSection(settingsTitleFor(type as Mask));
    fireEvent.change(getSlider('画笔大小', scope), { target: { value: '120' } });
    fireEvent.change(getSlider('画笔羽化', scope), { target: { value: '30' } });
    fireEvent.change(getSlider('画笔不透明度', scope), { target: { value: '80' } });
    expect(useEditorStore.getState().brushSettings).toMatchObject({ size: 120, feather: 30, opacity: 80 });
    fireEvent.click(within(scope).getByRole('button', { name: '擦除' }));
    expect(useEditorStore.getState().brushSettings?.tool).toBe(ToolType.Eraser);
    fireEvent.click(within(scope).getByRole('button', { name: '添加' }));
    expect(useEditorStore.getState().brushSettings?.tool).toBe(ToolType.Brush);
  });

  it('线性组件不渲染参数滑块', async () => {
    seedPatch(Mask.Linear, { params: { range: 300 } });
    await screen.findByText('组件一 属性');
    const scope = settingsSection('组件一 属性');
    expect(within(scope).queryAllByRole('slider')).toHaveLength(0);
    expect(within(scope).queryByText('画笔大小')).not.toBeInTheDocument();
  });

  it('折叠/展开生成式替换与属性分区', async () => {
    seedPatch(Mask.Brush, { params: { lines: [] } });
    await screen.findByText('组件一 属性');
    const generative = settingsSection('生成式替换');
    const properties = settingsSection('组件一 属性');
    expect(generative.querySelector('.lucide-chevron-down')!.getAttribute('class')).toContain('rotate-180');

    fireEvent.click(screen.getByText('生成式替换', { selector: 'h2' }));
    expect(generative.querySelector('.lucide-chevron-down')!.getAttribute('class')).not.toContain('rotate-180');
    fireEvent.click(screen.getByText('组件一 属性', { selector: 'h2' }));
    expect(properties.querySelector('.lucide-chevron-down')!.getAttribute('class')).not.toContain('rotate-180');
  });

  it('点击设置面板不会取消当前选择', async () => {
    seedPatch(Mask.Brush, { params: { lines: [] } });
    await screen.findByText('组件一 属性');
    fireEvent.click(screen.getByText('组件一 属性', { selector: 'h2' }));
    expect(useEditorStore.getState().activeAiPatchContainerId).toBe('p1');
    expect(useEditorStore.getState().activeAiSubMaskId).toBe('s1');
  });
});

describe('图像修复 · 选择同步与 Esc', () => {
  it('挂载时自动展开选中容器并打开设置面板', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    expect(await screen.findByText('组件一')).toBeInTheDocument();
    expect(screen.getByText('编辑设置')).toBeInTheDocument();
    expect(screen.getByText('选区属性')).toBeInTheDocument();
  });

  it('选中容器 ID 已不存在时清理激活状态', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'missing', activeAiSubMaskId: 's1' });
    await waitFor(() => expect(useEditorStore.getState().activeAiPatchContainerId).toBeNull());
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();
  });

  it('独立容器激活但组件为空时自动选中首组件', async () => {
    const patch = makePatch('p1', '克隆 1', [makeSubMask('s1', Mask.Clone, { name: '克隆组件' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await waitFor(() => expect(useEditorStore.getState().activeAiSubMaskId).toBe('s1'));
  });

  it('Esc 依次取消重命名、组件选择、容器选择，随后清空自定义处理器', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel(
      { aiPatches: [patch] },
      { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's1' },
    );
    await screen.findByText('组件一');

    fireEvent.contextMenu(row('组件一'));
    runMenu(menuOptions()[0]);
    expect(screen.getByDisplayValue('组件一')).toBeInTheDocument();

    act(() => useUIStore.getState().customEscapeHandler?.());
    expect(screen.queryByDisplayValue('组件一')).not.toBeInTheDocument();
    expect(useEditorStore.getState().activeAiSubMaskId).toBe('s1');

    act(() => useUIStore.getState().customEscapeHandler?.());
    expect(useEditorStore.getState().activeAiSubMaskId).toBeNull();
    expect(useEditorStore.getState().activeAiPatchContainerId).toBe('p1');

    act(() => useUIStore.getState().customEscapeHandler?.());
    expect(useEditorStore.getState().activeAiPatchContainerId).toBeNull();
    await waitFor(() => expect(useUIStore.getState().customEscapeHandler).toBeNull());
  });
});

describe('图像修复 · 拖拽编排', () => {
  it('从创建入口拖拽创建新编辑并显示拖拽浮层', async () => {
    renderPanel();
    const data = { type: 'Creation', maskType: Mask.Brush };
    dnd.activeId = 'create-ai-brush';
    await dragStart(data);
    expect(within(screen.getByTestId('drag-overlay')).getByText('画笔')).toBeInTheDocument();
    expect(useEditorStore.getState().isSliderDragging).toBe(true);

    dragEnd(data);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].subMasks[0].type).toBe(Mask.Brush);
    expect(useEditorStore.getState().isSliderDragging).toBe(false);
  });

  it('拖拽创建独立编辑走独立分支', () => {
    renderPanel();
    const data = { type: 'Creation', maskType: Mask.Clone };
    dragStart(data);
    dragEnd(data);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].name).toBe('克隆 1');
  });

  it('拖拽容器到另一容器上调整顺序并显示浮层', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    const c = makePatch('c', '编辑 C', [makeSubMask('c1', Mask.Radial, { name: '组件丙' })]);
    renderPanel({ aiPatches: [a, b, c] });
    await screen.findByText('编辑 A');

    dnd.activeId = 'a';
    dnd.overId = 'b';
    dragStart({ type: 'Container', item: a }, 'a');
    expect(within(screen.getByTestId('drag-overlay')).getByText('编辑 A')).toBeInTheDocument();
    expect(row('编辑 B').className).toContain('border-t-2');

    dragEnd({ type: 'Container', item: a }, { id: 'b', data: { current: { type: 'Container', item: b } } }, 'a');
    expect(patches().map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('拖拽容器到子组件上按所属容器排序，拖到列表根移动到末尾', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    const c = makePatch('c', '编辑 C', [makeSubMask('c1', Mask.Radial, { name: '组件丙' })]);
    renderPanel({ aiPatches: [a, b, c] });
    await screen.findByText('编辑 A');
    fireEvent.click(row('编辑 C').querySelector('.lucide-wand-sparkles, .lucide-folder-open')!);
    await screen.findByText('组件丙');

    dragStart({ type: 'Container', item: a }, 'a');
    dragEnd({ type: 'Container', item: a }, { id: 'c1', data: { current: { type: 'SubMask', item: c.subMasks[0], parentId: 'c' } } }, 'a');
    expect(patches().map((p) => p.id)).toEqual(['b', 'c', 'a']);

    dragStart({ type: 'Container', item: b }, 'b');
    dragEnd({ type: 'Container', item: b }, { id: 'ai-list-root' }, 'b');
    expect(patches().map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('拖拽容器到自身或无落点时保持顺序', async () => {
    const a = makePatch('a', '编辑 A', [makeSubMask('a1', Mask.Brush, { name: '组件甲' })]);
    const b = makePatch('b', '编辑 B', [makeSubMask('b1', Mask.Linear, { name: '组件乙' })]);
    renderPanel({ aiPatches: [a, b] });
    await screen.findByText('编辑 A');

    dragStart({ type: 'Container', item: a }, 'a');
    dragEnd({ type: 'Container', item: a }, { id: 'a', data: { current: { type: 'Container', item: a } } }, 'a');
    expect(patches().map((p) => p.id)).toEqual(['a', 'b']);

    dragStart({ type: 'Container', item: a }, 'a');
    dragEnd({ type: 'Container', item: a }, null, 'a');
    expect(patches().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('拖动组件到同容器另一组件上调整顺序', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
      makeSubMask('s3', Mask.Radial, { name: '组件三' }),
    ]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');

    dragStart({ type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' }, 's1');
    expect(within(screen.getByTestId('drag-overlay')).getByText('组件一')).toBeInTheDocument();
    dragEnd(
      { type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' },
      { id: 's3', data: { current: { type: 'SubMask', item: patch.subMasks[2], parentId: 'p1' } } },
      's1',
    );
    expect(patches()[0].subMasks.map((s) => s.id)).toEqual(['s2', 's1', 's3']);
  });

  it('拖动组件到同容器行上移动到末尾', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
      makeSubMask('s3', Mask.Radial, { name: '组件三' }),
    ]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');
    dragStart({ type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' }, 's1');
    dragEnd(
      { type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' },
      { id: 'p1', data: { current: { type: 'Container', item: patch } } },
      's1',
    );
    expect(patches()[0].subMasks.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  });

  it('跨容器拖拽组件插入到目标组件之前', async () => {
    const a = makePatch('a', '编辑 A', [
      makeSubMask('a1', Mask.Brush, { name: '组件甲' }),
      makeSubMask('a2', Mask.Linear, { name: '组件乙' }),
    ]);
    const b = makePatch('b', '编辑 B', [
      makeSubMask('b1', Mask.Radial, { name: '组件丙' }),
      makeSubMask('b2', Mask.QuickEraser, { name: '组件丁' }),
    ]);
    renderPanel({ aiPatches: [a, b] }, { activeAiPatchContainerId: 'a' });
    await screen.findByText('组件甲');
    fireEvent.click(row('编辑 B').querySelector('.lucide-wand-sparkles, .lucide-folder-open')!);
    await screen.findByText('组件丙');

    dragStart({ type: 'SubMask', item: a.subMasks[0], parentId: 'a' }, 'a1');
    dragEnd(
      { type: 'SubMask', item: a.subMasks[0], parentId: 'a' },
      { id: 'b2', data: { current: { type: 'SubMask', item: b.subMasks[1], parentId: 'b' } } },
      'a1',
    );
    expect(patches()[0].subMasks.map((s) => s.id)).toEqual(['a2']);
    expect(patches()[1].subMasks.map((s) => s.id)).toEqual(['b1', 'a1', 'b2']);
  });

  it('拖动组件到列表根拆分为新编辑并自动选中', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
    ]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');

    dragStart({ type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' }, 's1');
    dragEnd({ type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' }, { id: 'ai-list-root' }, 's1');

    expect(patches()).toHaveLength(2);
    expect(patches()[1].name).toBe('AI 编辑 2');
    expect(patches()[1].subMasks.map((s) => s.id)).toEqual(['s1']);
    expect(patches()[0].subMasks.map((s) => s.id)).toEqual(['s2']);
    await waitFor(() => expect(useEditorStore.getState().activeAiPatchContainerId).toBe(patches()[1].id));
    expect(useEditorStore.getState().activeAiSubMaskId).toBe('s1');
  });

  it('拖动组件无落点也会拆分为新编辑', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');
    dragStart({ type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' }, 's1');
    dragEnd({ type: 'SubMask', item: patch.subMasks[0], parentId: 'p1' }, null, 's1');
    expect(patches()).toHaveLength(2);
    expect(patches()[1].subMasks[0].id).toBe('s1');
  });

  it('独立编辑组件禁止拖入其他容器，普通组件也禁止拖入独立容器', async () => {
    const standalone = makePatch('s', '克隆 1', [makeSubMask('sc', Mask.Clone, { name: '克隆组件' })]);
    const normal = makePatch('n', '编辑 N', [makeSubMask('nb', Mask.Brush, { name: '普通组件' })]);
    renderPanel({ aiPatches: [standalone, normal] }, { activeAiPatchContainerId: 'n' });
    await screen.findByText('普通组件');

    dragStart({ type: 'SubMask', item: standalone.subMasks[0], parentId: 's' }, 'sc');
    dragEnd(
      { type: 'SubMask', item: standalone.subMasks[0], parentId: 's' },
      { id: 'n', data: { current: { type: 'Container', item: normal } } },
      'sc',
    );
    expect(patches()[0].subMasks).toHaveLength(1);
    expect(patches()[1].subMasks).toHaveLength(1);

    dragStart({ type: 'SubMask', item: normal.subMasks[0], parentId: 'n' }, 'nb');
    dragEnd(
      { type: 'SubMask', item: normal.subMasks[0], parentId: 'n' },
      { id: 's', data: { current: { type: 'Container', item: standalone } } },
      'nb',
    );
    expect(patches()[0].subMasks).toHaveLength(1);
    expect(patches()[1].subMasks).toHaveLength(1);
  });

  it('缺少源容器或源组件时拖拽组件不产生变化', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');

    dragStart({ type: 'SubMask', item: patch.subMasks[0] }, 's1');
    dragEnd({ type: 'SubMask', item: patch.subMasks[0] }, { id: 'ai-list-root' }, 's1');
    expect(patches()).toHaveLength(1);

    dragStart({ type: 'SubMask', item: makeSubMask('missing', Mask.Brush), parentId: 'p1' }, 'missing');
    dragEnd({ type: 'SubMask', item: makeSubMask('missing', Mask.Brush), parentId: 'p1' }, { id: 'ai-list-root' }, 'missing');
    expect(patches()).toHaveLength(1);
  });

  it('拖拽创建编辑时若已存在编辑则显示拖放提示并延迟创建', async () => {
    const patch = makePatch('p1', '编辑 1', [makeSubMask('s1', Mask.Brush, { name: '组件一' })]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1' });
    await screen.findByText('组件一');

    dnd.overId = 'ai-list-root';
    dragStart({ type: 'Creation', maskType: Mask.Radial });
    expect(screen.getByText('拖放到此处以创建新编辑')).toBeInTheDocument();

    dragEnd({ type: 'Creation', maskType: Mask.Radial });
    expect(patches()).toHaveLength(1);
  });

describe('图像修复 · 用户交互体验', () => {
  it('创建入口为可聚焦按钮，Enter/Space 可创建，生成中呈 aria-disabled', async () => {
    const first = renderPanel();
    const clone = screen.getByRole('button', { name: '克隆' });
    expect(clone).toHaveAttribute('tabindex', '0');
    clone.focus();
    fireEvent.keyDown(clone, { key: 'Enter' });
    expect(patches()).toHaveLength(1);
    expect(patches()[0].subMasks[0].type).toBe(Mask.Clone);

    first.unmount();
    renderPanel();
    const heal = screen.getByRole('button', { name: '修复' });
    fireEvent.keyDown(heal, { key: ' ' });
    expect(patches()).toHaveLength(1);
    expect(patches()[0].subMasks[0].type).toBe(Mask.Heal);

    cleanup();
    renderPanel({}, { isGeneratingAi: true });
    const disabled = tile('克隆');
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).toHaveAttribute('tabindex', '-1');
    fireEvent.click(disabled);
    fireEvent.keyDown(disabled, { key: 'Enter' });
    expect(patches()).toHaveLength(0);
  });

  it('工具栏重置按钮具备可访问名称', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '重置图像修复' })).toBeEnabled();
  });

  it('容器展开器支持键盘折叠/展开并同步 aria-expanded', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
    ]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's2' });
    await screen.findByText('组件二');

    const collapse = screen.getByRole('button', { name: '编辑 1 · 折叠编辑' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    collapse.focus();
    fireEvent.keyDown(collapse, { key: 'Enter' });
    const expand = screen.getByRole('button', { name: '编辑 1 · 展开编辑' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(expand, { key: ' ' });
    expect(screen.getByRole('button', { name: '编辑 1 · 折叠编辑' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('容器显隐、组件模式与删除按钮通过名称和 aria-pressed 反馈状态', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
    ]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's2' });
    await screen.findByText('组件二');

    const editEye = screen.getByRole('button', { name: '隐藏编辑' });
    expect(editEye).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(editEye);
    expect(screen.getByRole('button', { name: '显示编辑' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '删除编辑' })).toBeInTheDocument();

    const componentRow = row('组件二');
    const mode = within(componentRow).getByRole('button', { name: '切换到减去' });
    fireEvent.click(mode);
    expect(within(componentRow).getByRole('button', { name: '切换到相交' })).toBeInTheDocument();
    expect(within(componentRow).getByRole('button', { name: '删除组件' })).toBeInTheDocument();
  });

  it('生成式替换分区支持键盘折叠并暴露 aria-expanded', async () => {
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
    ]);
    renderPanel({ aiPatches: [patch] }, { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's2' });
    await screen.findByText('组件二');

    const header = screen.getByRole('button', { name: '生成式替换' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    header.focus();
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(header, { key: ' ' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('生成中按钮暴露 aria-busy，下载进度以 status 区域播报', async () => {
    enableGenerative();
    const patch = makePatch('p1', '编辑 1', [
      makeSubMask('s1', Mask.Brush, { name: '组件一' }),
      makeSubMask('s2', Mask.Linear, { name: '组件二' }),
    ]);
    useProcessStore.setState({ aiModelDownloadStatus: 'Inpainting 30%' } as never);
    renderPanel(
      { aiPatches: [patch] },
      { activeAiPatchContainerId: 'p1', activeAiSubMaskId: 's2', isGeneratingAi: true },
    );
    await screen.findByText('组件二');

    const generating = screen.getByRole('button', { name: /生成中/ });
    expect(generating).toHaveAttribute('aria-busy', 'true');
    expect(generating).toBeDisabled();

    const progress = await screen.findByText('Inpainting 30%');
    const status = progress.closest('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('下载中');
  });
});
});
