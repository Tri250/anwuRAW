import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfigurePresetModal from '../../src/components/modals/ConfigurePresetModal';
import type { Preset } from '../../src/components/ui/AppProperties';

const makePreset = (overrides: Partial<Preset> = {}): Preset => ({
  id: 'p1',
  name: '已有预设',
  adjustments: {},
  ...overrides,
});

const setup = (props: Partial<React.ComponentProps<typeof ConfigurePresetModal>> = {}) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ConfigurePresetModal isOpen initialPreset={null} onClose={onClose} onSave={onSave} {...props} />,
  );
  return { ...view, onSave, onClose };
};

const saveButton = () => screen.getByRole('button', { name: '保存' });
const nameInput = () => screen.getByPlaceholderText('输入预设名称...');

describe('ConfigurePresetModal', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('关闭时不渲染对话框', () => {
    setup({ isOpen: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开时展示保存模式标题、输入框、两个开关与类型选择', () => {
    setup();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('保存新预设')).toBeInTheDocument();
    expect(nameInput()).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: '包含蒙版' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '包含裁剪与变换' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '风格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '工具' })).toBeInTheDocument();
  });

  it('名称为空或仅空白时禁用保存', () => {
    setup();
    expect(saveButton()).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect(saveButton()).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: '  夜景  ' } });
    expect(saveButton()).toBeEnabled();
  });

  it('保存时传递裁剪后的名称、开关状态与风格类型', () => {
    const { onSave, onClose } = setup();
    fireEvent.change(nameInput(), { target: { value: '  夜景  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '包含蒙版' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '包含裁剪与变换' }));
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith('夜景', true, true, 'style');
    expect(onClose).toHaveBeenCalled();
  });

  it('可切换为工具类型并保存', () => {
    const { onSave } = setup();
    fireEvent.change(nameInput(), { target: { value: '降噪' } });
    fireEvent.click(screen.getByRole('button', { name: '工具' }));
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith('降噪', false, false, 'tool');
  });

  it('回车键触发保存，Esc 键触发关闭', () => {
    const { onSave, onClose } = setup();
    fireEvent.change(nameInput(), { target: { value: '回车保存' } });
    fireEvent.keyDown(nameInput(), { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('回车保存', false, false, 'style');

    fireEvent.keyDown(nameInput(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('点击取消按钮关闭', () => {
    const { onClose, onSave } = setup();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('点击遮罩关闭，点击对话框内容不关闭', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('保存新预设'));
    fireEvent.click(nameInput());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭动画结束后卸载对话框', async () => {
    const view = setup();
    view.rerender(<ConfigurePresetModal isOpen={false} initialPreset={null} onClose={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 1000 });
  });

  it('配置已有预设时回填名称、开关、类型与标题', () => {
    setup({
      initialPreset: makePreset({
        name: '暖色',
        includeMasks: true,
        includeCropTransform: false,
        presetType: 'tool',
        adjustments: { masks: [{ id: 'm1' }] },
      }),
    });

    expect(screen.getByText('配置预设')).toBeInTheDocument();
    expect(nameInput()).toHaveValue('暖色');
    expect(screen.getByRole('checkbox', { name: '包含蒙版' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '包含裁剪与变换' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '工具' })).toHaveClass('text-button-text');
  });

  it('未显式声明时从蒙版内容推断包含蒙版', () => {
    setup({ initialPreset: makePreset({ includeMasks: undefined, adjustments: { masks: [{ id: 'm1' }] } }) });
    expect(screen.getByRole('checkbox', { name: '包含蒙版' })).toBeChecked();
  });

  it('未显式声明时从几何键推断包含裁剪与变换', () => {
    setup({ initialPreset: makePreset({ includeCropTransform: undefined, adjustments: { rotation: 0, crop: null } }) });
    expect(screen.getByRole('checkbox', { name: '包含裁剪与变换' })).toBeChecked();
  });

  it('显式 false 优先于内容推断', () => {
    setup({
      initialPreset: makePreset({
        includeMasks: false,
        includeCropTransform: false,
        adjustments: { masks: [{ id: 'm1' }], rotation: 90 },
      }),
    });
    expect(screen.getByRole('checkbox', { name: '包含蒙版' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '包含裁剪与变换' })).not.toBeChecked();
  });

  it('空调整与空名称的已有预设回填为未启用状态', () => {
    setup({ initialPreset: makePreset({ name: '', adjustments: {} }) });
    expect(nameInput()).toHaveValue('');
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '包含蒙版' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '包含裁剪与变换' })).not.toBeChecked();
  });
});
