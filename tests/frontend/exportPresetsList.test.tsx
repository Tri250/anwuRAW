import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ExportPresetsList from '../../src/components/ui/ExportPresetsList';
import { AppSettings, Theme } from '../../src/components/ui/AppProperties';
import {
  ExportPreset,
  WatermarkAnchor,
} from '../../src/components/ui/ExportImportProperties';

// === TC-EXP-LIST-* 系列：导出预设下拉、新建、覆盖、删除 ===

const { mockUuid } = vi.hoisted(() => ({ mockUuid: vi.fn(() => 'generated-preset-id') }));
vi.mock('uuid', () => ({ v4: () => mockUuid() }));

const CURRENT_SETTINGS = {
  fileFormat: 'jpeg',
  jpegQuality: 88,
  enableResize: false,
  resizeMode: 'longEdge',
  resizeValue: 2048,
  dontEnlarge: true,
  keepMetadata: true,
  preserveTimestamps: false,
  stripGps: true,
  filenameTemplate: '{original_filename}_edited',
  enableWatermark: false,
  watermarkPath: null,
  watermarkAnchor: WatermarkAnchor.BottomRight,
  watermarkScale: 10,
  watermarkSpacing: 5,
  watermarkOpacity: 75,
};

const makePreset = (overrides: Partial<ExportPreset> = {}): ExportPreset => ({
  id: 'preset-a',
  name: '旅行导出',
  fileFormat: 'jpeg',
  jpegQuality: 90,
  enableResize: true,
  resizeMode: 'longEdge',
  resizeValue: 2048,
  dontEnlarge: true,
  keepMetadata: true,
  preserveTimestamps: false,
  stripGps: true,
  filenameTemplate: '{original_filename}_edited',
  enableWatermark: false,
  watermarkPath: null,
  watermarkAnchor: WatermarkAnchor.BottomRight,
  watermarkScale: 10,
  watermarkSpacing: 5,
  watermarkOpacity: 75,
  ...overrides,
});

const makeSettings = (presets: ExportPreset[]): AppSettings =>
  ({ theme: Theme.Dark, lastRootPath: null, exportPresets: presets }) as AppSettings;

const renderList = (
  presets: ExportPreset[] | null = [],
  overrides: Partial<React.ComponentProps<typeof ExportPresetsList>> = {},
) => {
  const onApplyPreset = vi.fn();
  const onSettingsChange = vi.fn();
  const appSettings = presets === null ? null : makeSettings(presets);
  const view = render(
    <ExportPresetsList
      appSettings={appSettings}
      currentSettings={CURRENT_SETTINGS}
      onApplyPreset={onApplyPreset}
      onSettingsChange={onSettingsChange}
      {...overrides}
    />,
  );
  return { ...view, onApplyPreset, onSettingsChange, appSettings };
};

const openDropdown = (triggerLabel = '选择一个预设...') => {
  const trigger = screen.getByRole('button', { name: new RegExp(triggerLabel) });
  fireEvent.click(trigger);
  return screen.getByRole('listbox');
};

const openCreate = () => {
  fireEvent.click(document.querySelector('[data-tooltip="将当前设置保存为新预设"]') as HTMLElement);
  return screen.getByPlaceholderText('预设名称') as HTMLInputElement;
};

const createRow = (input: HTMLInputElement) => input.closest('div') as HTMLElement;
const iconButton = (container: ParentNode, tooltip: string) =>
  container.querySelector(`[data-tooltip="${tooltip}"]`) as HTMLButtonElement;

beforeEach(() => {
  mockUuid.mockReset();
  mockUuid.mockReturnValue('generated-preset-id');
});

describe('ExportPresetsList · 展示与选择', () => {
  it('TC-EXP-LIST-01 渲染标题、下拉占位符与新建入口', () => {
    renderList();

    expect(screen.getByText('导出预设')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /选择一个预设/ })).toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="将当前设置保存为新预设"]')).toBeInTheDocument();
  });

  it('TC-EXP-LIST-02 下拉过滤内部 __last_used__ 预设并保留用户预设', () => {
    renderList([
      makePreset({ id: '__last_used__', name: '上次使用' }),
      makePreset({ id: 'preset-a', name: '旅行导出' }),
      makePreset({ id: 'preset-b', name: '网页导出' }),
    ]);

    const listbox = openDropdown();
    expect(within(listbox).queryByText('上次使用')).not.toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /旅行导出/ })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /网页导出/ })).toBeInTheDocument();
  });

  it('TC-EXP-LIST-03 选择预设时回调完整预设对象并显示所选名称', () => {
    const preset = makePreset({ id: 'preset-b', name: '网页导出', jpegQuality: 66 });
    const { onApplyPreset } = renderList([preset]);

    fireEvent.click(within(openDropdown()).getByRole('option', { name: /网页导出/ }));

    expect(onApplyPreset).toHaveBeenCalledTimes(1);
    expect(onApplyPreset).toHaveBeenCalledWith(preset);
    expect(screen.getByRole('button', { name: /网页导出/ })).toBeInTheDocument();
  });

  it('TC-EXP-LIST-04 无预设时下拉为空且不显示覆盖/删除按钮', () => {
    renderList();

    const listbox = openDropdown();
    expect(within(listbox).queryAllByRole('option')).toHaveLength(0);
    expect(document.querySelector('[data-tooltip="覆盖所选预设"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="删除预设"]')).not.toBeInTheDocument();
  });
});

describe('ExportPresetsList · 新建预设', () => {
  it('TC-EXP-LIST-05 空名称/纯空格时保存按钮禁用，输入后启用', () => {
    renderList([]);
    const input = openCreate();
    const save = createRow(input).querySelectorAll('button')[0] as HTMLButtonElement;

    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: '  新的预设  ' } });
    expect(save).toBeEnabled();
  });

  it('TC-EXP-LIST-06 保存新预设：追加、裁剪名称、写入当前设置并选中新项', () => {
    const existing = makePreset({ id: 'preset-a', name: '旅行导出' });
    const { onSettingsChange, onApplyPreset, appSettings, rerender } = renderList([existing]);
    const input = openCreate();
    fireEvent.change(input, { target: { value: '  新的预设  ' } });

    fireEvent.click(createRow(input).querySelectorAll('button')[0]);

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    const updated = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(updated.theme).toBe(appSettings!.theme);
    expect(updated.exportPresets).toHaveLength(2);
    expect(updated.exportPresets![0]).toEqual(existing);
    expect(updated.exportPresets![1]).toMatchObject({
      id: 'generated-preset-id',
      name: '新的预设',
      ...CURRENT_SETTINGS,
    });
    expect(onApplyPreset).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('预设名称')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="覆盖所选预设"]')).toBeInTheDocument();

    // 父组件持久化后回传新设置：下拉应显示刚创建并选中的预设
    rerender(
      <ExportPresetsList
        appSettings={updated}
        currentSettings={CURRENT_SETTINGS}
        onApplyPreset={onApplyPreset}
        onSettingsChange={onSettingsChange}
      />,
    );
    expect(screen.getByRole('button', { name: /新的预设/ })).toBeInTheDocument();
  });

  it('TC-EXP-LIST-07 输入名称后按 Enter 保存，按取消按钮退出且不回调', () => {
    const { onSettingsChange } = renderList([]);
    let input = openCreate();
    fireEvent.change(input, { target: { value: '回车创建' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSettingsChange).toHaveBeenCalledTimes(1);

    input = openCreate();
    fireEvent.change(input, { target: { value: '取消创建' } });
    fireEvent.click(createRow(input).querySelectorAll('button')[1]);
    expect(screen.queryByPlaceholderText('预设名称')).not.toBeInTheDocument();
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-tooltip="将当前设置保存为新预设"]')).toBeInTheDocument();
  });

  it('TC-EXP-LIST-08 appSettings 为 null 时新建入口仍可打开但保存不产生回调', () => {
    const { onSettingsChange } = renderList(null);
    const input = openCreate();
    fireEvent.change(input, { target: { value: '孤立预设' } });
    fireEvent.click(createRow(input).querySelectorAll('button')[0]);

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('预设名称')).toBeInTheDocument();
  });
});

describe('ExportPresetsList · 覆盖与删除', () => {
  const selectPreset = (name: string) => {
    fireEvent.click(within(openDropdown()).getByRole('option', { name: new RegExp(name) }));
  };

  it('TC-EXP-LIST-09 覆盖所选预设：合并当前设置并显示 1.5 秒已保存状态', async () => {
    const original = makePreset({ id: 'preset-a', name: '旅行导出', jpegQuality: 90 });
    const other = makePreset({ id: 'preset-b', name: '网页导出', jpegQuality: 70 });
    const { onSettingsChange } = renderList([original, other]);
    selectPreset('旅行导出');

    const overwrite = iconButton(document, '覆盖所选预设');
    fireEvent.click(overwrite);

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    const updated = onSettingsChange.mock.calls[0][0] as AppSettings;
    expect(updated.exportPresets!.find((p) => p.id === 'preset-a')).toMatchObject({
      id: 'preset-a',
      name: '旅行导出',
      ...CURRENT_SETTINGS,
    });
    expect(updated.exportPresets!.find((p) => p.id === 'preset-b')).toEqual(other);

    const saved = document.querySelector('[data-tooltip="已保存！"]') as HTMLButtonElement;
    expect(saved).toBeInTheDocument();
    expect(saved).toBeDisabled();
    expect(saved.querySelector('.lucide-check')).toBeInTheDocument();

    await waitFor(
      () => {
        const reset = document.querySelector('[data-tooltip="覆盖所选预设"]') as HTMLButtonElement;
        expect(reset).toBeEnabled();
        expect(reset.querySelector('.lucide-save')).toBeInTheDocument();
      },
      { timeout: 2500 },
    );
  });

  it('TC-EXP-LIST-10 默认预设只能选择，不显示覆盖/删除操作', () => {
    renderList([makePreset({ id: 'default-1', name: '默认 JPEG' })]);
    selectPreset('默认 JPEG');

    expect(screen.getByRole('button', { name: /默认 JPEG/ })).toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="覆盖所选预设"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="删除预设"]')).not.toBeInTheDocument();
  });

  it('TC-EXP-LIST-11 删除所选预设：从列表移除、重置选择并隐藏操作按钮', () => {
    const target = makePreset({ id: 'preset-a', name: '旅行导出' });
    const keep = makePreset({ id: 'preset-b', name: '网页导出' });
    const { onSettingsChange } = renderList([target, keep]);
    selectPreset('旅行导出');

    fireEvent.click(iconButton(document, '删除预设'));

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ exportPresets: [keep] }),
    );
    expect(screen.getByRole('button', { name: /选择一个预设/ })).toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="删除预设"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tooltip="覆盖所选预设"]')).not.toBeInTheDocument();
  });
});
