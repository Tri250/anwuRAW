import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePresets, PresetListType } from '../../src/hooks/usePresets';
import type { UserPreset } from '../../src/hooks/usePresets';
import { INITIAL_ADJUSTMENTS } from '../../src/utils/adjustments';
import { Invokes } from '../../src/components/ui/AppProperties';
import type { Preset } from '../../src/components/ui/AppProperties';
import { mockInvoke } from './setup';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const makePreset = (id: string, name: string, adjustments: Record<string, unknown> = {}, extra: Partial<Preset> = {}): Preset => ({
  id,
  name,
  adjustments: { ...(clone(INITIAL_ADJUSTMENTS) as Record<string, unknown>), ...adjustments },
  ...extra,
});

const makeFolder = (id: string, name: string, children: Preset[] = []): UserPreset => ({
  folder: { id, name, children },
});

const BASE_ADJUSTMENTS = {
  ...clone(INITIAL_ADJUSTMENTS),
  brightness: 10,
  contrast: 25,
  rotation: 5,
  masks: [{ id: 'mask-base', type: 'linear', name: '基础蒙版' }],
} as never;

const emptyAdjustments = () => clone(INITIAL_ADJUSTMENTS) as never;

const saveCalls = () => mockInvoke.mock.calls.filter((call) => call[0] === Invokes.SavePresets);

const setup = async (initial: UserPreset[], adjustments: unknown = BASE_ADJUSTMENTS) => {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === Invokes.LoadPresets) return Promise.resolve(initial);
    return Promise.resolve(undefined);
  });
  const rendered = renderHook(() => usePresets(adjustments as never));
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
};

const flushSave = async () => {
  await act(async () => {
    vi.advanceTimersByTime(500);
    await Promise.resolve();
  });
};

describe('usePresets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let uuid = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `uuid-${++uuid}` as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('加载与刷新', () => {
    it('挂载时加载预设并在完成后关闭 loading', async () => {
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.LoadPresets ? Promise.resolve([{ preset: makePreset('p1', '预设一') }]) : Promise.resolve(undefined),
      );
      const { result } = renderHook(() => usePresets(emptyAdjustments()));
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.presets).toHaveLength(1);
      expect(mockInvoke).toHaveBeenCalledWith(Invokes.LoadPresets);
    });

    it('加载失败时清空列表并关闭 loading', async () => {
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.LoadPresets ? Promise.reject(new Error('load failed')) : Promise.resolve(undefined),
      );
      const { result } = renderHook(() => usePresets(emptyAdjustments()));
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.presets).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });

    it('refreshPresets 重新读取后端列表', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '旧预设') }]);
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.LoadPresets ? Promise.resolve([{ preset: makePreset('p2', '新预设') }]) : Promise.resolve(undefined),
      );

      await act(async () => {
        await result.current.refreshPresets();
      });

      expect(result.current.presets).toHaveLength(1);
      expect(result.current.presets[0].preset?.name).toBe('新预设');
    });
  });

  describe('addPreset', () => {
    it('新建风格预设时复制全部可复制调整，默认排除蒙版与几何项', async () => {
      const { result } = await setup([]);
      let created: Preset | null = null;
      act(() => {
        created = result.current.addPreset('我的风格');
      });

      const preset = created as unknown as Preset;
      expect(preset.name).toBe('我的风格');
      expect(preset.presetType).toBe('style');
      expect(preset.includeMasks).toBe(false);
      expect(preset.includeCropTransform).toBe(false);
      expect(preset.adjustments.brightness).toBe(10);
      expect(preset.adjustments.contrast).toBe(25);
      expect(preset.adjustments.masks).toBeUndefined();
      expect(preset.adjustments.rotation).toBeUndefined();
      expect(result.current.presets).toEqual([{ preset }]);
    });

    it('新建工具预设只保留与默认值不同的调整', async () => {
      const { result } = await setup([]);
      let created: Preset | null = null;
      act(() => {
        created = result.current.addPreset('我的工具', null, false, false, 'tool');
      });

      const preset = created as unknown as Preset;
      expect(preset.presetType).toBe('tool');
      expect(preset.adjustments.brightness).toBe(10);
      expect(preset.adjustments.contrast).toBe(25);
      expect(preset.adjustments).not.toHaveProperty('saturation');
      expect(preset.adjustments).not.toHaveProperty('temperature');
    });

    it('按标记包含蒙版与裁剪变换调整', async () => {
      const { result } = await setup([]);
      let created: Preset | null = null;
      act(() => {
        created = result.current.addPreset('完整预设', null, true, true);
      });

      const preset = created as unknown as Preset;
      expect(preset.includeMasks).toBe(true);
      expect(preset.includeCropTransform).toBe(true);
      expect(preset.adjustments.masks).toEqual(BASE_ADJUSTMENTS.masks);
      expect(preset.adjustments.rotation).toBe(5);
    });

    it('可把新预设直接加入指定文件夹', async () => {
      const { result } = await setup([makeFolder('f1', '风景')]);
      act(() => {
        result.current.addPreset('暖色', 'f1');
      });

      expect(result.current.presets[0].folder?.children).toHaveLength(1);
      expect(result.current.presets[0].folder?.children[0].name).toBe('暖色');
      expect(result.current.presets[0].folder?.children[0].adjustments.masks).toBeUndefined();
    });

    it('后端保存经过 500ms 去抖且只写入最后一次结果', async () => {
      const { result } = await setup([]);
      act(() => {
        result.current.addPreset('第一个');
      });
      act(() => {
        result.current.addPreset('第二个');
      });

      expect(saveCalls()).toHaveLength(0);
      await flushSave();

      const calls = saveCalls();
      expect(calls).toHaveLength(1);
      const saved = calls[0][1] as { presets: UserPreset[] };
      expect(saved.presets).toHaveLength(2);
      expect(saved.presets.map((item) => item.preset?.name)).toEqual(['第一个', '第二个']);
    });
  });

  describe('addFolder', () => {
    it('存在根预设时把文件夹插到第一个根预设之前', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '根预设') },
        makeFolder('f1', '已有文件夹'),
      ]);

      act(() => {
        result.current.addFolder('新文件夹');
      });

      expect(result.current.presets.map((item) => item.preset?.name ?? item.folder?.name)).toEqual([
        '新文件夹',
        '根预设',
        '已有文件夹',
      ]);
      await flushSave();
      expect(saveCalls()).toHaveLength(1);
    });

    it('没有根预设时追加到列表末尾', async () => {
      const { result } = await setup([makeFolder('f1', '已有文件夹')]);
      act(() => {
        result.current.addFolder('新文件夹');
      });
      expect(result.current.presets).toHaveLength(2);
      expect(result.current.presets[1].folder?.name).toBe('新文件夹');
      expect(result.current.presets[1].folder?.children).toEqual([]);
    });
  });

  describe('deleteItem', () => {
    it('删除根预设', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '保留') },
        { preset: makePreset('p2', '删除') },
      ]);
      act(() => result.current.deleteItem('p2'));
      expect(result.current.presets).toHaveLength(1);
      expect(result.current.presets[0].preset?.name).toBe('保留');
    });

    it('删除文件夹', async () => {
      const { result } = await setup([
        makeFolder('f1', '文件夹', [makePreset('p1', '子预设')]),
        { preset: makePreset('p2', '根预设') },
      ]);
      act(() => result.current.deleteItem('f1'));
      expect(result.current.presets).toHaveLength(1);
      expect(result.current.presets[0].preset?.name).toBe('根预设');
    });

    it('删除文件夹内的子预设而保留文件夹', async () => {
      const { result } = await setup([
        makeFolder('f1', '文件夹', [makePreset('p1', '保留'), makePreset('p2', '删除')]),
      ]);
      act(() => result.current.deleteItem('p2'));
      expect(result.current.presets).toHaveLength(1);
      expect(result.current.presets[0].folder?.children.map((p) => p.name)).toEqual(['保留']);
    });
  });

  describe('renameItem', () => {
    it('重命名根预设', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '旧名') }]);
      act(() => result.current.renameItem('p1', '新名'));
      expect(result.current.presets[0].preset?.name).toBe('新名');
    });

    it('重命名文件夹', async () => {
      const { result } = await setup([makeFolder('f1', '旧文件夹')]);
      act(() => result.current.renameItem('f1', '新文件夹'));
      expect(result.current.presets[0].folder?.name).toBe('新文件夹');
    });

    it('重命名文件夹内子预设', async () => {
      const { result } = await setup([makeFolder('f1', '文件夹', [makePreset('p1', '旧名')])]);
      act(() => result.current.renameItem('p1', '新名'));
      expect(result.current.presets[0].folder?.children[0].name).toBe('新名');
    });

    it('未知 id 不修改列表', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '预设') }]);
      const before = result.current.presets;
      act(() => result.current.renameItem('missing', '新名'));
      expect(result.current.presets[0].preset?.name).toBe('预设');
      expect(result.current.presets).toEqual(before);
    });
  });

  describe('configurePreset', () => {
    it('未知 id 返回 null', async () => {
      const { result } = await setup([]);
      let updated: Preset | null = null;
      act(() => {
        updated = result.current.configurePreset('missing', '名称', false, false, 'style');
      });
      expect(updated).toBeNull();
    });

    it('更新根预设的名称与标记，并按标记删除蒙版和几何项', async () => {
      const { result } = await setup([
        {
          preset: makePreset('p1', '旧名', { masks: [{ id: 'm' }], rotation: 15 }, {
            includeMasks: true,
            includeCropTransform: true,
          }),
        },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.configurePreset('p1', '新名', false, false, 'style');
      });

      const preset = updated as unknown as Preset;
      expect(preset.name).toBe('新名');
      expect(preset.includeMasks).toBe(false);
      expect(preset.includeCropTransform).toBe(false);
      expect(preset.adjustments).not.toHaveProperty('masks');
      expect(preset.adjustments).not.toHaveProperty('rotation');
      expect(result.current.presets[0].preset?.name).toBe('新名');
    });

    it('风格转工具时删除等于默认值的调整', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '风格', { brightness: 30, contrast: 0 }, { presetType: 'style' }) },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.configurePreset('p1', '工具', false, false, 'tool');
      });

      const preset = updated as unknown as Preset;
      expect(preset.presetType).toBe('tool');
      expect(preset.adjustments.brightness).toBe(30);
      expect(preset.adjustments).not.toHaveProperty('contrast');
    });

    it('工具转风格时补齐缺失的可复制调整为默认值', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '工具', { brightness: 30 }, { presetType: 'tool' }) },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.configurePreset('p1', '风格', false, false, 'style');
      });

      const preset = updated as unknown as Preset;
      expect(preset.presetType).toBe('style');
      expect(preset.adjustments.brightness).toBe(30);
      expect(preset.adjustments.contrast).toBe(0);
      expect(preset.adjustments.temperature).toBe(0);
      expect(preset.adjustments).not.toHaveProperty('masks');
      expect(preset.adjustments).not.toHaveProperty('rotation');
    });

    it('工具转风格且包含蒙版与变换时补齐对应默认值', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '工具', { brightness: 5 }, { presetType: 'tool' }) },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.configurePreset('p1', '风格', true, true, 'style');
      });

      const preset = updated as unknown as Preset;
      expect(preset.adjustments.masks).toEqual([]);
      expect(preset.adjustments.rotation).toBe(0);
      expect(preset.adjustments.crop).toBeNull();
    });

    it('更新文件夹内的子预设', async () => {
      const { result } = await setup([makeFolder('f1', '文件夹', [makePreset('p1', '旧名')])]);
      let updated: Preset | null = null;
      act(() => {
        updated = result.current.configurePreset('p1', '子预设新名', false, false, 'style');
      });
      expect(updated).not.toBeNull();
      expect(result.current.presets[0].folder?.children[0].name).toBe('子预设新名');
    });
  });

  describe('overwritePreset', () => {
    it('用当前调整为根预设生成新内容并保留名称', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '预设', { brightness: 1 }, { includeMasks: true, includeCropTransform: true }) },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.overwritePreset('p1');
      });

      const preset = updated as unknown as Preset;
      expect(preset.name).toBe('预设');
      expect(preset.adjustments.brightness).toBe(10);
      expect(preset.adjustments.contrast).toBe(25);
      expect(preset.adjustments.masks).toEqual(BASE_ADJUSTMENTS.masks);
      expect(preset.adjustments.rotation).toBe(5);
    });

    it('从已有内容推断标记并可覆盖文件夹内的子预设', async () => {
      const { result } = await setup([
        makeFolder('f1', '文件夹', [
          { id: 'p1', name: '子预设', adjustments: { masks: [{ id: 'old' }], rotation: 1 } } as Preset,
        ]),
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.overwritePreset('p1');
      });

      const preset = updated as unknown as Preset;
      expect(preset.includeMasks).toBe(true);
      expect(preset.includeCropTransform).toBe(true);
      expect(preset.adjustments.masks).toEqual(BASE_ADJUSTMENTS.masks);
      expect(preset.adjustments.rotation).toBe(5);
    });

    it('显式排除标记时不会写入蒙版和几何项', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '预设', { brightness: 1 }, { includeMasks: false, includeCropTransform: false }) },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.overwritePreset('p1');
      });

      const preset = updated as unknown as Preset;
      expect(preset.adjustments).not.toHaveProperty('masks');
      expect(preset.adjustments).not.toHaveProperty('rotation');
      expect(preset.adjustments.brightness).toBe(10);
    });

    it('工具类型覆盖时只保留非默认调整', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '工具', {}, { presetType: 'tool', includeMasks: false, includeCropTransform: false }) },
      ]);

      let updated: Preset | null = null;
      act(() => {
        updated = result.current.overwritePreset('p1');
      });

      const preset = updated as unknown as Preset;
      expect(preset.presetType).toBe('tool');
      expect(preset.adjustments.brightness).toBe(10);
      expect(preset.adjustments).not.toHaveProperty('saturation');
    });

    it('未知 id 返回 null 且不写入', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '预设') }]);
      let updated: Preset | null = null;
      act(() => {
        updated = result.current.overwritePreset('missing');
      });
      expect(updated).toBeNull();
      expect(saveCalls()).toHaveLength(0);
    });
  });

  describe('duplicatePreset', () => {
    it('复制根预设并插入到原项之后，深拷贝调整且不继承收藏', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '原预设', { brightness: 40 }, { favorite: true }) },
        { preset: makePreset('p2', '后一个') },
      ]);

      let duplicated: Preset | null = null;
      act(() => {
        duplicated = result.current.duplicatePreset('p1');
      });

      const copy = duplicated as unknown as Preset;
      expect(copy.name).toBe('原预设 副本');
      expect(copy.id).not.toBe('p1');
      expect(copy.favorite).toBe(false);
      expect(copy.adjustments.brightness).toBe(40);
      expect(copy.adjustments).not.toBe(result.current.presets[0].preset?.adjustments);
      expect(result.current.presets.map((item) => item.preset?.name)).toEqual(['原预设', '原预设 副本', '后一个']);
    });

    it('复制文件夹内子预设并插入到原子项之后', async () => {
      const { result } = await setup([
        makeFolder('f1', '文件夹', [makePreset('p1', '甲'), makePreset('p2', '乙')]),
      ]);

      act(() => {
        result.current.duplicatePreset('p1');
      });

      expect(result.current.presets[0].folder?.children.map((p) => p.name)).toEqual(['甲', '甲 副本', '乙']);
    });

    it('未知 id 或 null 返回 null', async () => {
      const { result } = await setup([]);
      expect(result.current.duplicatePreset('missing')).toBeNull();
      expect(result.current.duplicatePreset(null)).toBeNull();
    });
  });

  describe('movePreset', () => {
    it('根预设移入文件夹并追加到末尾', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '根') },
        makeFolder('f1', '文件夹', [makePreset('p2', '子')]),
      ]);

      act(() => result.current.movePreset('p1', 'f1'));

      expect(result.current.presets[0].preset).toBeUndefined();
      expect(result.current.presets[0].folder?.children.map((p) => p.name)).toEqual(['子', '根']);
    });

    it('根预设按 overId 插入到文件夹内指定位置', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '根') },
        makeFolder('f1', '文件夹', [makePreset('p2', '甲'), makePreset('p3', '乙')]),
      ]);

      act(() => result.current.movePreset('p1', 'f1', 'p3'));

      expect(result.current.presets[0].folder?.children.map((p) => p.name)).toEqual(['甲', '根', '乙']);
    });

    it('overId 不存在时追加到文件夹末尾', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '根') },
        makeFolder('f1', '文件夹', [makePreset('p2', '子')]),
      ]);

      act(() => result.current.movePreset('p1', 'f1', 'missing'));

      expect(result.current.presets[0].folder?.children.map((p) => p.name)).toEqual(['子', '根']);
    });

    it('子预设移出文件夹并按 overId 插入根列表', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '根一') },
        makeFolder('f1', '文件夹', [makePreset('p2', '子')]),
        { preset: makePreset('p3', '根二') },
      ]);

      act(() => result.current.movePreset('p2', null, 'p3'));

      expect(result.current.presets[1].folder?.children).toEqual([]);
      expect(result.current.presets[0].preset?.name).toBe('根一');
      expect(result.current.presets[2].preset?.name).toBe('子');
      expect(result.current.presets[3].preset?.name).toBe('根二');
    });

    it('子预设移出文件夹且无 overId 时放到根列表末尾', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '根') },
        makeFolder('f1', '文件夹', [makePreset('p2', '子')]),
      ]);

      act(() => result.current.movePreset('p2', null));

      expect(result.current.presets[0].preset?.name).toBe('根');
      expect(result.current.presets[1].folder?.children).toEqual([]);
      expect(result.current.presets[2].preset?.name).toBe('子');
      expect(result.current.presets[2].folder).toBeUndefined();
    });

    it('文件夹之间移动子预设', async () => {
      const { result } = await setup([
        makeFolder('f1', '甲文件夹', [makePreset('p1', '子')]),
        makeFolder('f2', '乙文件夹', [makePreset('p2', '目标')]),
      ]);

      act(() => result.current.movePreset('p1', 'f2', 'p2'));

      expect(result.current.presets[0].folder?.children).toEqual([]);
      expect(result.current.presets[1].folder?.children.map((p) => p.name)).toEqual(['子', '目标']);
    });

    it('根列表内移动根预设时按 overId 插入', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '甲') },
        { preset: makePreset('p2', '乙') },
        { preset: makePreset('p3', '丙') },
      ]);

      act(() => result.current.movePreset('p1', null, 'p3'));

      expect(result.current.presets.map((item) => item.preset?.name)).toEqual(['乙', '甲', '丙']);
    });

    it('未知预设不修改列表', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '甲') }]);
      act(() => result.current.movePreset('missing', null));
      expect(result.current.presets).toHaveLength(1);
      expect(result.current.presets[0].preset?.name).toBe('甲');
    });
  });

  describe('reorderItems', () => {
    it('重排根层级条目', async () => {
      const { result } = await setup([
        { preset: makePreset('p1', '甲') },
        makeFolder('f1', '文件夹'),
        { preset: makePreset('p2', '乙') },
      ]);

      act(() => result.current.reorderItems('p1', 'p2'));

      expect(result.current.presets.map((item) => item.preset?.name ?? item.folder?.name)).toEqual([
        '文件夹',
        '乙',
        '甲',
      ]);
    });

    it('重排同一文件夹内的子预设', async () => {
      const { result } = await setup([
        makeFolder('f1', '文件夹', [makePreset('p1', '甲'), makePreset('p2', '乙'), makePreset('p3', '丙')]),
      ]);

      act(() => result.current.reorderItems('p3', 'p1'));

      expect(result.current.presets[0].folder?.children.map((p) => p.name)).toEqual(['丙', '甲', '乙']);
    });

    it('无法匹配时保持原列表引用不变', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '甲') }]);
      const before = result.current.presets;
      act(() => result.current.reorderItems('missing', 'p1'));
      expect(result.current.presets).toBe(before);
    });
  });

  describe('toggleFavorite', () => {
    it('切换根预设收藏状态', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '甲') }]);
      act(() => result.current.toggleFavorite('p1'));
      expect(result.current.presets[0].preset?.favorite).toBe(true);
      act(() => result.current.toggleFavorite('p1'));
      expect(result.current.presets[0].preset?.favorite).toBe(false);
    });

    it('切换文件夹内子预设收藏状态', async () => {
      const { result } = await setup([makeFolder('f1', '文件夹', [makePreset('p1', '甲')])]);
      act(() => result.current.toggleFavorite('p1'));
      expect(result.current.presets[0].folder?.children[0].favorite).toBe(true);
    });

    it('null 或未知 id 不写入后端', async () => {
      const { result } = await setup([{ preset: makePreset('p1', '甲') }]);
      act(() => result.current.toggleFavorite(null));
      act(() => result.current.toggleFavorite('missing'));
      expect(saveCalls()).toHaveLength(0);
      expect(result.current.presets[0].preset?.favorite).toBeUndefined();
    });
  });

  describe('sortAllPresetsAlphabetically', () => {
    it('按名称排序文件夹、根预设与文件夹子项（忽略大小写并用数字排序）', async () => {
      const { result } = await setup([
        { preset: makePreset('pc', 'c预设') },
        makeFolder('fz', 'Z文件夹', [makePreset('p10', 'A10'), makePreset('p2', 'a2'), makePreset('pb', 'b')]),
        { preset: makePreset('pa', 'A预设') },
        makeFolder('fa', 'a文件夹'),
      ]);

      act(() => result.current.sortAllPresetsAlphabetically());

      expect(result.current.presets.map((item) => item.folder?.name ?? item.preset?.name)).toEqual([
        'a文件夹',
        'Z文件夹',
        'A预设',
        'c预设',
      ]);
      expect(result.current.presets[1].folder?.children.map((p) => p.name)).toEqual(['a2', 'A10', 'b']);
    });
  });

  describe('导入导出', () => {
    it('importPresetsFromFile 成功时替换列表并切换 loading', async () => {
      const { result } = await setup([]);
      const imported = [{ preset: makePreset('new', '导入预设') }];
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.HandleImportPresetsFromFile ? Promise.resolve(imported) : Promise.resolve(undefined),
      );

      await act(async () => {
        await result.current.importPresetsFromFile('/tmp/a.rrpreset');
      });

      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportPresetsFromFile, { filePath: '/tmp/a.rrpreset' });
      expect(result.current.presets).toEqual(imported);
      expect(result.current.isLoading).toBe(false);
    });

    it('importPresetsFromFile 失败时抛出并复位 loading', async () => {
      const { result } = await setup([]);
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.HandleImportPresetsFromFile ? Promise.reject(new Error('bad')) : Promise.resolve(undefined),
      );

      await expect(
        act(async () => {
          await result.current.importPresetsFromFile('/tmp/bad.rrpreset');
        }),
      ).rejects.toThrow('bad');
      expect(result.current.isLoading).toBe(false);
    });

    it('importLegacyPresetsFromFile 成功时替换列表', async () => {
      const { result } = await setup([]);
      const imported = [{ preset: makePreset('legacy', '旧版预设') }];
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.HandleImportLegacyPresetsFromFile ? Promise.resolve(imported) : Promise.resolve(undefined),
      );

      await act(async () => {
        await result.current.importLegacyPresetsFromFile('/tmp/legacy.xmp');
      });

      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportLegacyPresetsFromFile, {
        filePath: '/tmp/legacy.xmp',
      });
      expect(result.current.presets).toEqual(imported);
    });

    it('importLegacyPresetsFromFile 失败时抛出并复位 loading', async () => {
      const { result } = await setup([]);
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.HandleImportLegacyPresetsFromFile ? Promise.reject(new Error('legacy bad')) : Promise.resolve(undefined),
      );

      await expect(
        act(async () => {
          await result.current.importLegacyPresetsFromFile('/tmp/bad.xmp');
        }),
      ).rejects.toThrow('legacy bad');
      expect(result.current.isLoading).toBe(false);
    });

    it('importPresetsFromFiles 返回导入结果并应用 presets', async () => {
      const { result } = await setup([]);
      const outcome = {
        presets: [{ preset: makePreset('multi', '批量导入') }],
        failures: [{ fileName: 'bad.xmp', error: 'parse' }],
      };
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.HandleImportPresetsFromFiles ? Promise.resolve(outcome) : Promise.resolve(undefined),
      );

      let returned: unknown;
      await act(async () => {
        returned = await result.current.importPresetsFromFiles(['/tmp/a.rrpreset', '/tmp/b.xmp']);
      });

      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleImportPresetsFromFiles, {
        filePaths: ['/tmp/a.rrpreset', '/tmp/b.xmp'],
      });
      expect(returned).toEqual(outcome);
      expect(result.current.presets).toEqual(outcome.presets);
      expect(result.current.isLoading).toBe(false);
    });

    it('importPresetsFromFiles 失败时抛出并复位 loading', async () => {
      const { result } = await setup([]);
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === Invokes.HandleImportPresetsFromFiles ? Promise.reject(new Error('multi bad')) : Promise.resolve(undefined),
      );

      await expect(
        act(async () => {
          await result.current.importPresetsFromFiles(['/tmp/a.rrpreset']);
        }),
      ).rejects.toThrow('multi bad');
      expect(result.current.isLoading).toBe(false);
    });

    it('exportPresetsToFile 传递完整参数', async () => {
      const { result } = await setup([]);
      mockInvoke.mockReset();
      mockInvoke.mockResolvedValue(undefined);
      const items = [{ preset: makePreset('p1', '导出') }];

      await act(async () => {
        await result.current.exportPresetsToFile(items, '/tmp/out.rrpreset');
      });

      expect(mockInvoke).toHaveBeenCalledWith(Invokes.HandleExportPresetsToFile, {
        presetsToExport: items,
        filePath: '/tmp/out.rrpreset',
      });
    });

    it('exportPresetsToFile 失败时抛出', async () => {
      const { result } = await setup([]);
      mockInvoke.mockReset();
      mockInvoke.mockRejectedValue(new Error('export bad'));
      await expect(result.current.exportPresetsToFile([], '/tmp/x.rrpreset')).rejects.toThrow('export bad');
    });
  });
});
