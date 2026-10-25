import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import PresetsPanel from '../../src/components/panel/right/PresetsPanel';
import { useEditorStore } from '../../src/store/useEditorStore';
import { INITIAL_ADJUSTMENTS } from '../../src/utils/adjustments';
import { Invokes } from '../../src/components/ui/AppProperties';
import type { Preset } from '../../src/components/ui/AppProperties';
import { PresetListType } from '../../src/hooks/usePresets';
import { toast } from 'react-toastify';
import { debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { mockInvoke, mockSaveDialog, mockOpenDialog, mockPlatform } from './setup';

const { showContextMenu } = vi.hoisted(() => ({ showContextMenu: vi.fn() }));

vi.mock('../../src/context/ContextMenuContext', () => ({
  useContextMenu: () => ({ showContextMenu }),
}));

const { dnd } = vi.hoisted(() => ({
  dnd: {
    onDragStart: null as ((event: any) => void) | null,
    onDragEnd: null as ((event: any) => void) | null,
  },
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
    useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const IMAGE = {
  path: '/photos/preset.dng',
  width: 4000,
  height: 3000,
  isRaw: true,
  isReady: true,
  thumbnailUrl: '',
  exif: {},
};

const BASE_ADJUSTMENTS = {
  ...clone(INITIAL_ADJUSTMENTS),
  brightness: 20,
  masks: [{ id: 'base-mask', type: 'linear', name: '基础蒙版' }],
} as never;

const DEFAULT_EMPTY_TEXT = '尚未保存预设。创建您自己的预设、从文件导入或探索社区预设。';
const NO_FAVORITES_TEXT = '还没有收藏的预设。点击预设上的星标即可收藏。';

const seedStore = (image: unknown = IMAGE, adjustments: unknown = BASE_ADJUSTMENTS) => {
  useEditorStore.setState({
    selectedImage: image,
    adjustments: clone(adjustments as object),
    isSliderDragging: false,
    activeAiPatchContainerId: null,
    activeAiSubMaskId: null,
  } as never);
};

const makePreset = (id: string, name: string, adjustments: Record<string, unknown> = {}, extra: Partial<Preset> = {}): Preset => ({
  id,
  name,
  adjustments,
  ...extra,
});

const root = (id: string, name: string, adjustments: Record<string, unknown> = {}, extra: Partial<Preset> = {}) => ({
  preset: makePreset(id, name, adjustments, extra),
});

const folder = (id: string, name: string, children: Preset[] = []) => ({
  folder: { id, name, children },
});

const onNavigate = vi.fn();

const mount = async (
  list: unknown[],
  options: {
    image?: unknown;
    adjustments?: unknown;
    preview?: () => Promise<unknown>;
  } = {},
) => {
  seedStore(options.image === undefined ? IMAGE : options.image, options.adjustments ?? BASE_ADJUSTMENTS);
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === Invokes.LoadPresets) return Promise.resolve(list);
    if (cmd === Invokes.GeneratePresetPreview) {
      return options.preview ? options.preview() : Promise.resolve(new Uint8Array([1, 2, 3]));
    }
    return Promise.resolve(undefined);
  });
  const view = render(<PresetsPanel onNavigateToCommunity={onNavigate} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
};

const currentAdjustments = () => useEditorStore.getState().adjustments;
const presetName = (name: string) => screen.getByText(name, { selector: 'p' });
const itemRoot = (name: string) => presetName(name).closest('.cursor-grabbing') as HTMLElement;
const emptyText = () => screen.getByText(DEFAULT_EMPTY_TEXT);
const byTooltip = (tip: string) => document.querySelector(`[data-tooltip="${tip}"]`) as HTMLElement | null;
const headerButton = (tip: string) => byTooltip(tip) as HTMLElement;
const tooltipElement = (rootElement: HTMLElement, tip: string) =>
  Array.from(rootElement.querySelectorAll('[data-tooltip]')).find((element) => element.getAttribute('data-tooltip') === tip);

const latestOptions = (): any[] => (showContextMenu.mock.calls.at(-1)?.[2] || []) as any[];
const findOption = (label: string) => latestOptions().find((option) => option.label === label);
const clickOption = async (label: string) => {
  const option = findOption(label);
  if (!option) {
    throw new Error(`菜单项不存在: ${label}; 现有: ${latestOptions().map((o) => o.label ?? '---').join(', ')}`);
  }
  await act(async () => {
    await option.onClick?.();
  });
};

const rootArea = () => document.querySelector('.grow.overflow-y-auto.p-3.space-y-2') as HTMLElement;

const openPresetMenu = (name: string) => {
  fireEvent.contextMenu(presetName(name));
};
const openFolderMenu = (name: string) => {
  fireEvent.contextMenu(presetName(name));
};
const openBackgroundMenu = () => {
  fireEvent.contextMenu(rootArea());
};

const intensitySlider = () =>
  screen.getByText('数量', { selector: 'span' }).closest('.slider-row')?.querySelector('input[type=range]') as HTMLInputElement;

const changeIntensity = (value: number) => {
  fireEvent.change(intensitySlider(), { target: { value: String(value) } });
};

const applyPreset = (name: string) => {
  fireEvent.click(presetName(name));
};

const folderHeader = (name: string) => presetName(name).closest('.cursor-pointer') as HTMLElement;
const folderCount = (name: string) => folderHeader(name).querySelector('.ml-auto')?.textContent?.trim();

const visibleRootNames = () =>
  Array.from(document.querySelectorAll('.grow.overflow-y-auto.p-3.space-y-2 > div'))
    .map((node) => node.querySelector('p')?.textContent?.trim())
    .filter(Boolean);

const dragStart = (id: string) => act(() => dnd.onDragStart?.({ active: { id } }));
const dragEnd = (id: string, over: any, type?: string) =>
  act(() => {
    dnd.onDragEnd?.({
      active: { id, data: { current: type ? { type } : undefined } },
      over,
    });
  });

describe('PresetsPanel', () => {
  beforeEach(() => {
    let blobIndex = 0;
    (URL as any).createObjectURL = vi.fn(() => `blob:preset-${++blobIndex}`);
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    showContextMenu.mockReset();
    onNavigate.mockReset();
  });

  afterEach(() => {
    debouncedSetHistory.cancel();
    vi.restoreAllMocks();
  });

  describe('空状态与头部操作', () => {
    it('未选择图像时显示提示', async () => {
      seedStore(null);
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.LoadPresets ? Promise.resolve([]) : Promise.resolve(undefined),
      );
      render(<PresetsPanel onNavigateToCommunity={onNavigate} />);
      expect(await screen.findByText('未选择图像。')).toBeInTheDocument();
    });

    it('首次加载且无缓存时显示加载状态', () => {
      seedStore();
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.LoadPresets ? new Promise(() => {}) : Promise.resolve(undefined),
      );
      render(<PresetsPanel onNavigateToCommunity={onNavigate} />);
      expect(screen.getByText(/加载预设中/)).toBeInTheDocument();
    });

    it('加载完成且没有预设时显示空状态', async () => {
      await mount([]);
      expect(emptyText()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /获取社区预设/ })).toBeInTheDocument();
    });

    it('空状态的社区按钮与头部探索按钮都会导航到社区', async () => {
      await mount([]);
      fireEvent.click(screen.getByRole('button', { name: /获取社区预设/ }));
      expect(onNavigate).toHaveBeenCalledTimes(1);
      fireEvent.click(headerButton('探索社区预设'));
      expect(onNavigate).toHaveBeenCalledTimes(2);
    });

    it('没有预设时收藏与导出按钮禁用，导入与新建可用', async () => {
      await mount([]);
      expect(headerButton('仅显示收藏')).toBeDisabled();
      expect(headerButton('将所有预设导出为 .rrpreset 文件')).toBeDisabled();
      expect(headerButton('从 .rrpreset 文件导入预设')).toBeEnabled();
      expect(headerButton('保存为新预设')).toBeEnabled();
    });

    it('存在预设但没有收藏时收藏筛选仍可点击并展示空收藏提示', async () => {
      await mount([root('p1', '普通预设')]);
      expect(headerButton('仅显示收藏')).toBeEnabled();
      expect(headerButton('将所有预设导出为 .rrpreset 文件')).toBeEnabled();

      fireEvent.click(headerButton('仅显示收藏'));
      expect(await screen.findByText(NO_FAVORITES_TEXT)).toBeInTheDocument();
    });

    it('头部新建按钮打开保存预设对话框', async () => {
      await mount([]);
      fireEvent.click(headerButton('保存为新预设'));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('保存新预设')).toBeInTheDocument();
    });
  });

  describe('预设项渲染与预览', () => {
    it('渲染根预设名称与风格/工具类型标记', async () => {
      await mount([
        root('p1', '暖阳', { brightness: 10 }),
        root('p2', '锐化', { sharpness: 10 }, { presetType: 'tool' }),
      ]);

      expect(presetName('暖阳')).toBeInTheDocument();
      expect(presetName('锐化')).toBeInTheDocument();
      expect(screen.getByText('风格')).toBeInTheDocument();
      expect(screen.getByText('工具')).toBeInTheDocument();
    });

    it('预设预览生成成功后显示图片与 blob 地址', async () => {
      await mount([root('p1', '暖阳')]);
      const image = await screen.findByAltText('暖阳 preview');
      expect(image).toHaveAttribute('src', expect.stringContaining('blob:preset-'));
      expect(mockInvoke).toHaveBeenCalledWith(Invokes.GeneratePresetPreview, expect.any(Object));
    });

    it('预览生成普通失败时记录错误且不显示图片', async () => {
      await mount([root('p1', '暖阳')], { preview: () => Promise.reject(new Error('boom')) });
      await waitFor(() => expect(console.error).toHaveBeenCalled());
      expect(screen.queryByAltText('暖阳 preview')).toBeNull();
    });

    it('预览因原图未加载而取消时静默停止队列', async () => {
      await mount([root('p1', '暖阳'), root('p2', '冷色')], {
        preview: () => Promise.reject(new Error('No original image loaded')),
      });
      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith(Invokes.GeneratePresetPreview, expect.any(Object)));
      expect(console.error).not.toHaveBeenCalled();
      expect(screen.queryByAltText('暖阳 preview')).toBeNull();
      expect(screen.queryByAltText('冷色 preview')).toBeNull();
    });

    it('按蒙版与裁剪变换标记显示支持提示', async () => {
      await mount([
        root('p1', '带蒙版', { masks: [{ id: 'm1' }] }),
        root('p2', '带变换', { rotation: 90 }),
        root('p3', '全功能', { masks: [{ id: 'm2' }], rotation: 90 }),
      ]);

      expect(tooltipElement(itemRoot('带蒙版'), '支持 蒙版')).toBeDefined();
      expect(tooltipElement(itemRoot('带变换'), '支持 裁剪与变换')).toBeDefined();
      expect(tooltipElement(itemRoot('全功能'), '支持 蒙版 + 裁剪与变换')).toBeDefined();
    });

    it('没有蒙版与变换时不显示支持角标', async () => {
      await mount([root('p1', '纯色', { brightness: 10 })]);
      expect(itemRoot('纯色').querySelector('[data-tooltip^="支持"]')).toBeNull();
      expect(itemRoot('纯色').querySelector('.lucide-layers')).toBeNull();
      expect(itemRoot('纯色').querySelector('.lucide-crop')).toBeNull();
    });

    it('点击星标切换收藏状态与提示文本', async () => {
      await mount([root('p1', '暖阳')]);
      const star = itemRoot('暖阳').querySelector('button') as HTMLButtonElement;
      expect(star).toHaveAttribute('data-tooltip', '添加到收藏');
      fireEvent.click(star);

      expect(itemRoot('暖阳').querySelector('button')).toHaveAttribute('data-tooltip', '取消收藏');
      expect(itemRoot('暖阳').querySelector('.lucide-star.fill-amber-400')).not.toBeNull();
    });
  });

  describe('应用预设与强度混合', () => {
    it('点击预设应用调整并显示强度滑块', async () => {
      await mount([root('p1', '暖阳', { brightness: 80 })]);
      applyPreset('暖阳');

      expect(currentAdjustments().brightness).toBe(80);
      expect(await screen.findByText('数量')).toBeInTheDocument();
      expect(intensitySlider()).toHaveValue('100');
    });

    it('再次点击已应用的预设恢复应用前的调整并隐藏滑块', async () => {
      await mount([root('p1', '暖阳', { brightness: 80, contrast: 40 })]);
      applyPreset('暖阳');
      expect(currentAdjustments().brightness).toBe(80);

      applyPreset('暖阳');
      expect(currentAdjustments().brightness).toBe(20);
      expect(currentAdjustments().contrast).toBe(0);
      await waitFor(() => expect(screen.queryByText('数量')).toBeNull());
    });

    it('未包含蒙版的预设不会覆盖当前蒙版', async () => {
      await mount([root('p1', '暖阳', { brightness: 80, masks: [{ id: 'preset-mask' }] })]);
      applyPreset('暖阳');
      expect((currentAdjustments().masks as any[]).map((mask) => mask.id)).toEqual(['base-mask']);
    });

    it('标记包含蒙版时会应用预设内的蒙版', async () => {
      await mount([
        root('p1', '暖阳', { brightness: 80, masks: [{ id: 'preset-mask' }] }, { includeMasks: true }),
      ]);
      applyPreset('暖阳');
      expect((currentAdjustments().masks as any[]).map((mask) => mask.id)).toEqual(['preset-mask']);
    });

    it('未包含裁剪变换的预设不会覆盖当前几何项', async () => {
      await mount([root('p1', '暖阳', { rotation: 90, flipHorizontal: true })]);
      applyPreset('暖阳');
      expect(currentAdjustments().rotation).toBe(0);
      expect(currentAdjustments().flipHorizontal).toBe(false);
    });

    it('标记包含裁剪变换时会应用预设内的几何项', async () => {
      await mount([
        root('p1', '暖阳', { rotation: 90, flipHorizontal: true }, { includeCropTransform: true }),
      ]);
      applyPreset('暖阳');
      expect(currentAdjustments().rotation).toBe(90);
      expect(currentAdjustments().flipHorizontal).toBe(true);
    });

    it('强度 50 时以应用前调整为基准进行数值混合', async () => {
      await mount([root('p1', '暖阳', { brightness: 80, contrast: 40 })]);
      applyPreset('暖阳');
      changeIntensity(50);

      expect(currentAdjustments().brightness).toBe(50);
      expect(currentAdjustments().contrast).toBe(20);
      expect(screen.getByText('50', { selector: '.slider-value-display' })).toBeInTheDocument();
    });

    it('强度 0 时完全回退到应用前调整', async () => {
      await mount([root('p1', '暖阳', { brightness: 80, contrast: 40 })]);
      applyPreset('暖阳');
      changeIntensity(0);

      expect(currentAdjustments().brightness).toBe(20);
      expect(currentAdjustments().contrast).toBe(0);
    });

    it('强度超过 100 时可放大预设效果', async () => {
      await mount([root('p1', '暖阳', { brightness: 80 })]);
      applyPreset('暖阳');
      changeIntensity(200);

      expect(currentAdjustments().brightness).toBe(140);
    });

    it('强度混合会按 x 坐标合并曲线并插值', async () => {
      await mount([
        root('p1', '曲线预设', {
          curves: {
            red: [{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }],
            green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
            blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
            luma: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          },
        }),
      ]);
      applyPreset('曲线预设');
      changeIntensity(50);

      expect(currentAdjustments().curves.red).toEqual([
        { x: 0, y: 0 },
        { x: 128, y: 164 },
        { x: 255, y: 255 },
      ]);
    });

    it('切换到另一张图片会清除当前预设与强度状态', async () => {
      await mount([root('p1', '暖阳', { brightness: 80 })]);
      applyPreset('暖阳');
      expect(screen.getByText('数量')).toBeInTheDocument();

      act(() => {
        useEditorStore.setState({ selectedImage: { ...IMAGE, path: '/photos/other.dng' } } as never);
      });

      await waitFor(() => expect(screen.queryByText('数量')).toBeNull());
    });
  });

  describe('收藏筛选', () => {
    it('仅显示收藏的根预设', async () => {
      await mount([
        root('p1', '收藏根', { brightness: 5 }, { favorite: true }),
        root('p2', '普通根'),
      ]);
      fireEvent.click(headerButton('仅显示收藏'));

      expect(presetName('收藏根')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('普通根')).toBeNull());
      expect(headerButton('显示全部')).toBeInTheDocument();
    });

    it('文件夹只显示收藏的子预设且计数同步', async () => {
      await mount([
        folder('f1', '风景', [
          makePreset('c1', '收藏子', {}, { favorite: true }),
          makePreset('c2', '普通子'),
        ]),
        root('p1', '收藏根', {}, { favorite: true }),
      ]);
      fireEvent.click(headerButton('仅显示收藏'));

      expect(folderCount('风景')).toBe('1');
      fireEvent.click(presetName('风景'));
      expect(await screen.findByText('收藏子')).toBeInTheDocument();
      expect(screen.queryByText('普通子')).toBeNull();
    });

    it('取消最后一个收藏后显示空收藏提示且筛选按钮禁用', async () => {
      await mount([root('p1', '收藏根', {}, { favorite: true })]);
      fireEvent.click(headerButton('仅显示收藏'));
      const star = itemRoot('收藏根').querySelector('button') as HTMLButtonElement;
      fireEvent.click(star);

      expect(await screen.findByText(NO_FAVORITES_TEXT)).toBeInTheDocument();
      expect(headerButton('显示全部')).toBeDisabled();
    });

    it('再次点击筛选按钮恢复显示全部', async () => {
      await mount([
        root('p1', '收藏根', {}, { favorite: true }),
        root('p2', '普通根'),
      ]);
      fireEvent.click(headerButton('仅显示收藏'));
      await waitFor(() => expect(screen.queryByText('普通根')).toBeNull());
      fireEvent.click(headerButton('显示全部'));
      expect(await screen.findByText('普通根')).toBeInTheDocument();
    });
  });

  describe('文件夹', () => {
    it('展开文件夹显示子预设并切换图标', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设', { brightness: 5 })])]);
      expect(folderCount('风景')).toBe('1');
      expect(folderHeader('风景').querySelector('.lucide-folder')).not.toBeNull();

      fireEvent.click(presetName('风景'));

      expect(await screen.findByText('子预设')).toBeInTheDocument();
      expect(folderHeader('风景').querySelector('.lucide-folder-open')).not.toBeNull();
      expect(await screen.findByAltText('子预设 preview')).toBeInTheDocument();
    });

    it('再次点击文件夹收起子预设', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')])]);
      fireEvent.click(presetName('风景'));
      await screen.findByText('子预设');

      fireEvent.click(presetName('风景'));
      await waitFor(() => expect(screen.queryByText('子预设')).toBeNull());
      expect(folderHeader('风景').querySelector('.lucide-folder')).not.toBeNull();
    });

    it('点击文件夹图标同样切换展开状态', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')])]);
      const icon = folderHeader('风景').querySelector('.lucide-folder') as Element;
      fireEvent.click(icon);
      expect(await screen.findByText('子预设')).toBeInTheDocument();
    });

    it('文件夹内的预设可被应用', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设', { brightness: 70 })])]);
      fireEvent.click(presetName('风景'));
      fireEvent.click(await screen.findByText('子预设'));
      expect(currentAdjustments().brightness).toBe(70);
    });

    it('空文件夹展开后仍显示计数 0 且不渲染子容器', async () => {
      await mount([folder('f1', '空文件夹')]);
      expect(folderCount('空文件夹')).toBe('0');
      fireEvent.click(presetName('空文件夹'));
      expect(folderHeader('空文件夹').querySelector('.lucide-folder-open')).not.toBeNull();
      expect(document.querySelector('.ml-4.pl-2')).toBeNull();
    });
  });

  describe('右键菜单与增删改', () => {
    it('预设菜单包含收藏、覆盖、配置、复制、导出与删除', async () => {
      await mount([root('p1', '暖阳')]);
      openPresetMenu('暖阳');
      expect(latestOptions().map((option) => option.label ?? '---')).toEqual([
        '添加到收藏',
        '覆盖',
        '配置预设',
        '---',
        '复制预设',
        '导出预设',
        '---',
        '删除预设',
      ]);
    });

    it('已收藏预设的菜单显示取消收藏', async () => {
      await mount([root('p1', '暖阳', {}, { favorite: true })]);
      openPresetMenu('暖阳');
      expect(findOption('取消收藏')).toBeDefined();
      expect(findOption('添加到收藏')).toBeUndefined();
    });

    it('通过菜单收藏预设', async () => {
      await mount([root('p1', '暖阳')]);
      openPresetMenu('暖阳');
      await clickOption('添加到收藏');
      expect(itemRoot('暖阳').querySelector('button')).toHaveAttribute('data-tooltip', '取消收藏');
      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith(Invokes.SavePresets, expect.any(Object)));
    });

    it('文件夹菜单包含重命名、导出与删除', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')])]);
      openFolderMenu('风景');
      expect(latestOptions().map((option) => option.label ?? '---')).toEqual([
        '重命名文件夹',
        '导出文件夹',
        '---',
        '删除文件夹',
      ]);
    });

    it('重命名文件夹后列表同步更新', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')])]);
      openFolderMenu('风景');
      await clickOption('重命名文件夹');
      const dialog = await screen.findByRole('dialog');
      const input = within(dialog).getByPlaceholderText('输入新的文件夹名称...');
      expect(input).toHaveValue('风景');
      fireEvent.change(input, { target: { value: '山川' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      expect(await screen.findByText('山川', { selector: 'p' })).toBeInTheDocument();
      expect(screen.queryByText('风景', { selector: 'p' })).toBeNull();
    });

    it('重命名文件夹对话框在名称未变化时禁用保存', async () => {
      await mount([folder('f1', '风景')]);
      openFolderMenu('风景');
      await clickOption('重命名文件夹');
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('button', { name: '保存' })).toBeDisabled();
    });

    it('新建文件夹为空状态时可创建', async () => {
      await mount([]);
      openBackgroundMenu();
      await clickOption('新建文件夹');
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByPlaceholderText('输入文件夹名称...'), { target: { value: '旅行' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await screen.findByText('旅行', { selector: 'p' })).toBeInTheDocument();
      expect(folderCount('旅行')).toBe('0');
    });

    it('背景菜单包含新建预设、新建文件夹与排序', async () => {
      await mount([root('p1', '暖阳')]);
      openBackgroundMenu();
      expect(latestOptions().map((option) => option.label ?? '---')).toEqual([
        '新建预设',
        '新建文件夹',
        '---',
        '全部按字母排序',
      ]);
      expect(findOption('全部按字母排序')?.disabled).toBe(false);
    });

    it('空列表时背景菜单的排序项禁用', async () => {
      await mount([]);
      openBackgroundMenu();
      expect(findOption('全部按字母排序')?.disabled).toBe(true);
    });

    it('背景菜单新建预设打开配置对话框', async () => {
      await mount([]);
      openBackgroundMenu();
      await clickOption('新建预设');
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('保存新预设')).toBeInTheDocument();
    });

    it('通过表头新建预设并包含蒙版标记', async () => {
      await mount([]);
      fireEvent.click(headerButton('保存为新预设'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByPlaceholderText('输入预设名称...'), { target: { value: '新预设' } });
      fireEvent.click(within(dialog).getByRole('checkbox', { name: '包含蒙版' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      expect(await screen.findByText('新预设', { selector: 'p' })).toBeInTheDocument();
      expect(tooltipElement(itemRoot('新预设'), '支持 蒙版')).toBeDefined();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('通过表头新建工具类型预设', async () => {
      await mount([]);
      fireEvent.click(headerButton('保存为新预设'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByPlaceholderText('输入预设名称...'), { target: { value: '工具预设' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '工具' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      expect(await screen.findByText('工具预设', { selector: 'p' })).toBeInTheDocument();
      expect(within(itemRoot('工具预设')).getByText('工具')).toBeInTheDocument();
    });

    it('通过菜单配置已有预设并改名', async () => {
      await mount([root('p1', '暖阳', { brightness: 5 })]);
      openPresetMenu('暖阳');
      await clickOption('配置预设');
      const dialog = await screen.findByRole('dialog');
      expect(screen.getByText('配置预设')).toBeInTheDocument();
      const input = within(dialog).getByPlaceholderText('输入预设名称...');
      expect(input).toHaveValue('暖阳');
      fireEvent.change(input, { target: { value: '夕阳' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      expect(await screen.findByText('夕阳', { selector: 'p' })).toBeInTheDocument();
      expect(screen.queryByText('暖阳', { selector: 'p' })).toBeNull();
    });

    it('复制预设插入副本并生成预览', async () => {
      await mount([root('p1', '暖阳', { brightness: 5 }, { favorite: true })]);
      openPresetMenu('暖阳');
      await clickOption('复制预设');

      expect(await screen.findByText('暖阳 副本', { selector: 'p' })).toBeInTheDocument();
      expect(visibleRootNames()).toEqual(['暖阳', '暖阳 副本']);
      await waitFor(() =>
        expect(mockInvoke.mock.calls.filter((call) => call[0] === Invokes.GeneratePresetPreview).length).toBeGreaterThanOrEqual(2),
      );
    });

    it('覆盖预设使用当前编辑器调整并可再次应用', async () => {
      await mount([root('p1', '暖阳', { brightness: 1 })]);
      openPresetMenu('暖阳');
      await clickOption('覆盖');

      act(() => {
        useEditorStore.setState({
          adjustments: { ...clone(BASE_ADJUSTMENTS as object), brightness: 0 },
        } as never);
      });
      applyPreset('暖阳');
      expect(currentAdjustments().brightness).toBe(20);
    });

    it('删除预设先隐藏再从列表移除', async () => {
      await mount([root('p1', '暖阳'), root('p2', '保留')]);
      openPresetMenu('暖阳');
      await clickOption('删除预设');

      await waitFor(() => expect(screen.queryByText('暖阳', { selector: 'p' })).toBeNull());
      expect(presetName('保留')).toBeInTheDocument();
      expect(visibleRootNames()).toEqual(['保留']);
    });

    it('删除文件夹连同子预设一起移除', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')]), root('p2', '保留')]);
      openFolderMenu('风景');
      await clickOption('删除文件夹');

      await waitFor(() => expect(screen.queryByText('风景', { selector: 'p' })).toBeNull());
      expect(screen.queryByText('子预设')).toBeNull();
      expect(presetName('保留')).toBeInTheDocument();
    });

    it('背景菜单排序按字母重排文件夹与根预设', async () => {
      await mount([
        root('pc', 'c预设'),
        folder('fz', 'Z文件夹', [makePreset('p10', 'A10'), makePreset('p2', 'a2')]),
        root('pa', 'A预设'),
        folder('fa', 'a文件夹'),
      ]);
      expect(visibleRootNames()).toEqual(['Z文件夹', 'a文件夹', 'c预设', 'A预设']);

      openBackgroundMenu();
      await clickOption('全部按字母排序');

      await waitFor(() => expect(visibleRootNames()).toEqual(['a文件夹', 'Z文件夹', 'A预设', 'c预设']));
    });
  });

  describe('导入与导出', () => {
    it('导入对话框取消时不调用后端', async () => {
      await mount([]);
      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockOpenDialog).toHaveBeenCalled();
      expect(mockInvoke.mock.calls.some((call) => call[0] === Invokes.HandleImportPresetsFromFiles)).toBe(false);
    });

    it('导入多个文件成功后刷新列表并记录失败项', async () => {
      await mount([]);
      const optionArgs = mockOpenDialog.getMockImplementation();
      expect(optionArgs).toBeTruthy();
      mockOpenDialog.mockResolvedValue(['/tmp/a.rrpreset', '/tmp/b.xmp']);
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === Invokes.LoadPresets) return Promise.resolve([]);
        if (cmd === Invokes.HandleImportPresetsFromFiles) {
          return Promise.resolve({
            presets: [root('new', '导入预设')],
            failures: [{ fileName: 'b.xmp', error: 'bad' }],
          });
        }
        return Promise.resolve(undefined);
      });

      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));

      expect(await screen.findByText('导入预设', { selector: 'p' })).toBeInTheDocument();
      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportPresetsFromFiles, {
        filePaths: ['/tmp/a.rrpreset', '/tmp/b.xmp'],
      });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('b.xmp'));
      const call = mockOpenDialog.mock.calls.at(-1)?.[0] as any;
      expect(call.multiple).toBe(true);
      expect(call.filters[0].extensions).toEqual(['rrpreset', 'xmp', 'lrtemplate']);
    });

    it('导入单个字符串路径也会按数组处理', async () => {
      await mount([]);
      mockOpenDialog.mockResolvedValue('/tmp/single.rrpreset');
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === Invokes.LoadPresets) return Promise.resolve([]);
        if (cmd === Invokes.HandleImportPresetsFromFiles) {
          return Promise.resolve({ presets: [root('new', '单文件预设')], failures: [] });
        }
        return Promise.resolve(undefined);
      });

      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));
      expect(await screen.findByText('单文件预设', { selector: 'p' })).toBeInTheDocument();
      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportPresetsFromFiles, {
        filePaths: ['/tmp/single.rrpreset'],
      });
    });

    it('Android 导入使用空过滤器并解析文件名后仅保留受支持扩展名', async () => {
      mockPlatform.mockReturnValue('android');
      await mount([]);
      mockOpenDialog.mockResolvedValue(['content://a/one.rrpreset', 'content://a/two.txt', 'content://a/three.XMP']);
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        if (cmd === Invokes.LoadPresets) return Promise.resolve([]);
        if (cmd === 'resolve_android_content_uri_name') {
          if (args.uriStr.endsWith('one.rrpreset')) return Promise.resolve('/sdcard/one.rrpreset');
          if (args.uriStr.endsWith('two.txt')) return Promise.resolve('/sdcard/two.txt');
          return Promise.resolve('/sdcard/three.XMP');
        }
        if (cmd === Invokes.HandleImportPresetsFromFiles) {
          return Promise.resolve({ presets: [root('new', '安卓导入')], failures: [] });
        }
        return Promise.resolve(undefined);
      });

      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));

      expect(await screen.findByText('安卓导入', { selector: 'p' })).toBeInTheDocument();
      expect(mockOpenDialog.mock.calls.at(-1)?.[0]).toMatchObject({ filters: [] });
      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportPresetsFromFiles, {
        filePaths: ['content://a/one.rrpreset', 'content://a/three.XMP'],
      });
    });

    it('Android 导入全部为不支持类型时不再调用后端', async () => {
      mockPlatform.mockReturnValue('android');
      await mount([]);
      mockOpenDialog.mockResolvedValue(['content://a/one.txt']);
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === Invokes.LoadPresets) return Promise.resolve([]);
        if (cmd === 'resolve_android_content_uri_name') return Promise.resolve('/sdcard/one.txt');
        return Promise.resolve(undefined);
      });

      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));
      await waitFor(() => expect(console.warn).toHaveBeenCalled());
      expect(mockInvoke.mock.calls.some((call) => call[0] === Invokes.HandleImportPresetsFromFiles)).toBe(false);
    });

    it('Android 文件名解析失败时回退原始路径进行扩展名过滤', async () => {
      mockPlatform.mockReturnValue('android');
      await mount([]);
      mockOpenDialog.mockResolvedValue(['content://a/fallback.rrpreset']);
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === Invokes.LoadPresets) return Promise.resolve([]);
        if (cmd === 'resolve_android_content_uri_name') return Promise.reject(new Error('nope'));
        if (cmd === Invokes.HandleImportPresetsFromFiles) {
          return Promise.resolve({ presets: [], failures: [] });
        }
        return Promise.resolve(undefined);
      });

      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportPresetsFromFiles, {
          filePaths: ['content://a/fallback.rrpreset'],
        }),
      );
    });

    it('导入对话框抛出异常时记录错误且不崩溃', async () => {
      await mount([]);
      mockOpenDialog.mockRejectedValue(new Error('dialog broken'));
      fireEvent.click(headerButton('从 .rrpreset 文件导入预设'));
      await waitFor(() => expect(console.error).toHaveBeenCalledWith('Failed to import presets:', expect.any(Error)));
    });

    it('导出全部预设通过保存对话框写入后端', async () => {
      const list = [root('p1', '暖阳'), folder('f1', '风景', [makePreset('c1', '子预设')])];
      await mount(list);
      mockSaveDialog.mockResolvedValue('/tmp/all.rrpreset');

      fireEvent.click(headerButton('将所有预设导出为 .rrpreset 文件'));

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleExportPresetsToFile, {
          presetsToExport: list,
          filePath: '/tmp/all.rrpreset',
        }),
      );
      const options = mockSaveDialog.mock.calls.at(-1)?.[0] as any;
      expect(options.defaultPath).toBe('all_presets.rrpreset');
      expect(options.title).toBe('导出所有预设');
    });

    it('导出全部取消时不调用后端', async () => {
      await mount([root('p1', '暖阳')]);
      mockSaveDialog.mockResolvedValue(null);
      fireEvent.click(headerButton('将所有预设导出为 .rrpreset 文件'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockInvoke.mock.calls.some((call) => call[0] === Invokes.HandleExportPresetsToFile)).toBe(false);
    });

    it('从预设菜单导出单个预设并清理非法文件名字符', async () => {
      await mount([root('p1', '暖/阳', { brightness: 5 })]);
      mockSaveDialog.mockResolvedValue('/tmp/single.rrpreset');
      openPresetMenu('暖/阳');
      await clickOption('导出预设');

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleExportPresetsToFile, {
          presetsToExport: [{ preset: expect.objectContaining({ id: 'p1' }) }],
          filePath: '/tmp/single.rrpreset',
        }),
      );
      const options = mockSaveDialog.mock.calls.at(-1)?.[0] as any;
      expect(options.defaultPath).toBe('暖_阳.rrpreset');
      expect(options.title).toBe('导出 预设');
    });

    it('从文件夹菜单导出整个文件夹', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')])]);
      mockSaveDialog.mockResolvedValue('/tmp/folder.rrpreset');
      openFolderMenu('风景');
      await clickOption('导出文件夹');

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleExportPresetsToFile, {
          presetsToExport: [
            expect.objectContaining({ folder: expect.objectContaining({ id: 'f1' }) }),
          ],
          filePath: '/tmp/folder.rrpreset',
        }),
      );
      const options = mockSaveDialog.mock.calls.at(-1)?.[0] as any;
      expect(options.defaultPath).toBe('风景.rrpreset');
      expect(options.title).toBe('导出 文件夹');
    });

    it('Android 导出全部跳过保存对话框并提示完成', async () => {
      mockPlatform.mockReturnValue('android');
      await mount([root('p1', '暖阳')]);

      fireEvent.click(headerButton('将所有预设导出为 .rrpreset 文件'));

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleExportPresetsToFile, {
          presetsToExport: [expect.objectContaining({ preset: expect.objectContaining({ id: 'p1' }) })],
          filePath: 'all_presets.rrpreset',
        }),
      );
      expect(mockSaveDialog).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('导出完成：all_presets.rrpreset');
    });

    it('Android 导出单个预设使用名称作为文件名', async () => {
      mockPlatform.mockReturnValue('android');
      await mount([root('p1', '暖阳', { brightness: 5 })]);
      openPresetMenu('暖阳');
      await clickOption('导出预设');

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleExportPresetsToFile, {
          presetsToExport: [expect.objectContaining({ preset: expect.objectContaining({ id: 'p1' }) })],
          filePath: '暖阳.rrpreset',
        }),
      );
      expect(mockSaveDialog).not.toHaveBeenCalled();
    });

    it('导出失败时记录错误', async () => {
      await mount([root('p1', '暖阳', { brightness: 5 })]);
      mockSaveDialog.mockResolvedValue('/tmp/fail.rrpreset');
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === Invokes.LoadPresets) return Promise.resolve([root('p1', '暖阳', { brightness: 5 })]);
        if (cmd === Invokes.HandleExportPresetsToFile) return Promise.reject(new Error('disk full'));
        return Promise.resolve(undefined);
      });

      fireEvent.click(headerButton('将所有预设导出为 .rrpreset 文件'));
      await waitFor(() =>
        expect(console.error).toHaveBeenCalledWith('Failed to export all presets:', expect.any(Error)),
      );
    });
  });

  describe('拖拽编排', () => {
    it('拖拽开始时在浮层展示预设并可结束清空', async () => {
      await mount([root('p1', '暖阳')]);
      dragStart('p1');
      expect(within(screen.getByTestId('drag-overlay')).getByText('暖阳')).toBeInTheDocument();

      dragEnd('p1', null);
      expect(within(screen.getByTestId('drag-overlay')).queryByText('暖阳')).toBeNull();
    });

    it('拖拽开始时在浮层展示文件夹及计数', async () => {
      await mount([folder('f1', '风景', [makePreset('c1', '子预设')])]);
      dragStart('f1');
      const overlay = within(screen.getByTestId('drag-overlay'));
      expect(overlay.getByText('风景')).toBeInTheDocument();
      expect(overlay.getByText('1')).toBeInTheDocument();
    });

    it('未知 id 启动拖拽时不显示浮层内容', async () => {
      await mount([root('p1', '暖阳')]);
      dragStart('missing');
      expect(screen.getByTestId('drag-overlay')).toBeEmptyDOMElement();
    });

    it('把根预设拖到文件夹上会移入并自动展开', async () => {
      await mount([root('p1', '暖阳'), folder('f1', '风景', [makePreset('c1', '子预设')])]);
      dragEnd('p1', { id: 'f1', data: { current: { type: PresetListType.Folder } } }, PresetListType.Preset);

      await waitFor(() => expect(folderCount('风景')).toBe('2'));
      // 等待 AnimatePresence 退出动画完成，旧根节点被移除
      await waitFor(() =>
        expect(screen.getAllByText('暖阳', { selector: 'p' })).toHaveLength(1),
      );
      expect(presetName('暖阳').closest('.ml-4')).not.toBeNull();
      expect(visibleRootNames()).toEqual(['风景']);
    });

    it('把根预设拖到另一个根预设上会重排', async () => {
      await mount([root('p1', '甲'), root('p2', '乙'), root('p3', '丙')]);
      dragEnd('p1', { id: 'p3', data: { current: { type: PresetListType.Preset } } }, PresetListType.Preset);

      await waitFor(() => expect(visibleRootNames()).toEqual(['乙', '丙', '甲']));
    });

    it('把文件夹拖到另一个文件夹上会重排文件夹顺序', async () => {
      await mount([folder('f1', '甲文件夹'), folder('f2', '乙文件夹'), root('p1', '根')]);
      dragEnd('f1', { id: 'f2', data: { current: { type: PresetListType.Folder } } }, PresetListType.Folder);

      await waitFor(() => expect(visibleRootNames()).toEqual(['乙文件夹', '甲文件夹', '根']));
    });

    it('把文件夹内预设拖到根区域会移出文件夹', async () => {
      await mount([root('p1', '根'), folder('f1', '文件夹', [makePreset('c1', '子预设')])]);
      fireEvent.click(presetName('文件夹'));
      await screen.findByText('子预设');

      dragEnd('c1', { id: 'root', data: { current: undefined } }, PresetListType.Preset);

      await waitFor(() => expect(presetName('子预设').closest('.ml-4')).toBeNull());
      expect(folderCount('文件夹')).toBe('0');
      expect(visibleRootNames()).toEqual(['文件夹', '根', '子预设']);
    });

    it('把文件夹内预设拖到同文件夹另一预设上会重排', async () => {
      await mount([
        folder('f1', '文件夹', [makePreset('c1', '甲'), makePreset('c2', '乙'), makePreset('c3', '丙')]),
      ]);
      fireEvent.click(presetName('文件夹'));
      await screen.findByText('甲');

      dragEnd('c3', { id: 'c1', data: { current: { type: PresetListType.Preset } } }, PresetListType.Preset);

      await waitFor(() =>
        expect(Array.from(document.querySelectorAll('.ml-4 p.truncate')).map((node) => node.textContent)).toEqual([
          '丙',
          '甲',
          '乙',
        ]),
      );
    });

    it('把预设拖入另一个文件夹会移动并展开目标', async () => {
      await mount([
        folder('f1', '甲文件夹', [makePreset('c1', '子预设')]),
        folder('f2', '乙文件夹', [makePreset('c2', '目标')]),
      ]);
      fireEvent.click(presetName('甲文件夹'));
      await screen.findByText('子预设');

      dragEnd('c1', { id: 'f2', data: { current: { type: PresetListType.Folder } } }, PresetListType.Preset);

      await waitFor(() => expect(folderCount('甲文件夹')).toBe('0'));
      expect(folderCount('乙文件夹')).toBe('2');
      await waitFor(() => expect(screen.getAllByText('子预设', { selector: 'p' })).toHaveLength(1));
      expect(presetName('子预设').closest('.ml-4')).not.toBeNull();
    });

    it('把文件夹内预设拖到无落点时移到根列表末尾', async () => {
      await mount([root('p1', '根'), folder('f1', '文件夹', [makePreset('c1', '子预设')])]);
      fireEvent.click(presetName('文件夹'));
      await screen.findByText('子预设');

      dragEnd('c1', null, PresetListType.Preset);

      await waitFor(() => expect(presetName('子预设').closest('.ml-4')).toBeNull());
      expect(visibleRootNames()).toEqual(['文件夹', '根', '子预设']);
    });

    it('根预设未落到任何目标时保持不变', async () => {
      await mount([root('p1', '甲'), root('p2', '乙')]);
      dragEnd('p1', null, PresetListType.Preset);
      expect(visibleRootNames()).toEqual(['甲', '乙']);
    });

    it('拖到自身时不产生变化', async () => {
      await mount([root('p1', '甲'), root('p2', '乙')]);
      dragEnd('p1', { id: 'p1', data: { current: { type: PresetListType.Preset } } }, PresetListType.Preset);
      expect(visibleRootNames()).toEqual(['甲', '乙']);
    });
  });

describe('预设 · 用户交互体验', () => {
  it('预设项以按钮语义暴露选中态，Enter 与 Space 均可应用', async () => {
    await mount([root('p1', '暖色', { brightness: 40 }), root('p2', '冷色', { brightness: -10 })]);
    const warm = screen.getByRole('button', { name: '暖色' });
    expect(warm).toHaveAttribute('role', 'button');
    expect(warm).toHaveAttribute('tabindex', '0');
    expect(warm).toHaveAttribute('aria-pressed', 'false');

    warm.focus();
    fireEvent.keyDown(warm, { key: 'Enter' });
    await waitFor(() => expect(currentAdjustments().brightness).toBe(40));
    expect(warm).toHaveAttribute('aria-pressed', 'true');

    const cool = screen.getByRole('button', { name: '冷色' });
    fireEvent.keyDown(cool, { key: ' ' });
    await waitFor(() => expect(currentAdjustments().brightness).toBe(-10));
    expect(cool).toHaveAttribute('aria-pressed', 'true');
    expect(warm).toHaveAttribute('aria-pressed', 'false');
  });

  it('预设项内的滑块按键不会误触发预设应用', async () => {
    await mount([root('p1', '暖色', { brightness: 40 })]);
    const warm = screen.getByRole('button', { name: '暖色' });
    fireEvent.click(warm);
    await waitFor(() => expect(warm).toHaveAttribute('aria-pressed', 'true'));

    const slider = intensitySlider();
    const before = currentAdjustments().brightness;
    slider.focus();
    fireEvent.keyDown(slider, { key: ' ' });
    expect(currentAdjustments().brightness).toBe(before);
  });

  it('收藏星标暴露名称与按下态，点击后即时同步', async () => {
    await mount([root('p1', '暖色', {}, { favorite: false })]);
    const favorite = screen.getByRole('button', { name: '添加到收藏' });
    expect(favorite).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(favorite);

    const unfavorite = await screen.findByRole('button', { name: '取消收藏' });
    expect(unfavorite).toHaveAttribute('aria-pressed', 'true');

    // 收藏变更使用 500ms 防抖持久化；等待落盘，避免测试结束后残留定时器
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(mockInvoke).toHaveBeenCalledWith(Invokes.SavePresets, expect.anything());
  });

  it('收藏筛选按钮同步 aria-pressed 与提示名称', async () => {
    await mount([root('p1', '暖色', {}, { favorite: true })]);
    const filter = screen.getByRole('button', { name: '仅显示收藏' });
    expect(filter).toBeEnabled();
    expect(filter).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(filter);
    const showAll = screen.getByRole('button', { name: '显示全部' });
    expect(showAll).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '暖色' })).toBeInTheDocument();
  });

  it('头部导入、导出、新建与社区入口均具备可访问名称', async () => {
    await mount([root('p1', '暖色')]);
    for (const name of ['探索社区预设', '从 .rrpreset 文件导入预设', '将所有预设导出为 .rrpreset 文件', '保存为新预设']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
  });

  it('空列表时禁用收藏筛选与导出，并说明可用操作', async () => {
    await mount([]);
    expect(screen.getByRole('button', { name: '仅显示收藏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '将所有预设导出为 .rrpreset 文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '探索社区预设' })).toBeEnabled();
  });

  it('文件夹展开器支持键盘与 aria-expanded，并播报展开状态', async () => {
    await mount([folder('f1', '风景', [makePreset('p1', '青绿', { brightness: 5 })])]);
    const expand = screen.getByRole('button', { name: '风景 · 展开文件夹' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');

    expand.focus();
    fireEvent.keyDown(expand, { key: 'Enter' });
    const collapse = screen.getByRole('button', { name: '风景 · 折叠文件夹' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '青绿' })).toBeInTheDocument();

    fireEvent.keyDown(collapse, { key: ' ' });
    expect(screen.getByRole('button', { name: '风景 · 展开文件夹' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('加载状态位于 polite status 区域', () => {
    seedStore();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === Invokes.LoadPresets ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    render(<PresetsPanel onNavigateToCommunity={onNavigate} />);
    const text = screen.getByText(/加载预设中/);
    const status = text.closest('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });
});
});
