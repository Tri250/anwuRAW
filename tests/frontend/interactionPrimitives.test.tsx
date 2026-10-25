import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CollapsibleSection from '../../src/components/ui/CollapsibleSection';
import Dropdown from '../../src/components/ui/Dropdown';
import Slider from '../../src/components/ui/Slider';
import Switch from '../../src/components/ui/Switch';
import Resizer from '../../src/components/ui/Resizer';
import { Orientation } from '../../src/components/ui/AppProperties';

// === TC-UX-UI：共享交互原语的键盘、焦点、禁用与语义回归 ===

describe('UX 交互原语 · 折叠分区', () => {
  const renderSection = (disableCollapse = false) => {
    const onToggle = vi.fn();
    const onToggleVisibility = vi.fn();
    render(
      <CollapsibleSection
        disableCollapse={disableCollapse}
        isContentVisible={true}
        isOpen={true}
        onToggle={onToggle}
        onToggleVisibility={onToggleVisibility}
        title="基础"
      >
        <div>分区内容</div>
      </CollapsibleSection>,
    );
    return { onToggle, onToggleVisibility };
  };

  it('标题行暴露 button 语义与 aria-expanded，Enter 可折叠', () => {
    const { onToggle } = renderSection();
    const header = screen.getByRole('button', { name: '基础' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('Space 也可折叠，且不会触发页面滚动默认行为', () => {
    const { onToggle } = renderSection();
    const header = screen.getByRole('button', { name: '基础' });
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    header.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('眼睛按钮有可访问名称与 aria-pressed，点击只切换可见性不折叠', () => {
    const { onToggle, onToggleVisibility } = renderSection();
    const eye = screen.getByRole('button', { name: '禁用部分' });
    expect(eye).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(eye);
    expect(onToggleVisibility).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('禁用手风琴时（Android）标题不再是 button，也不显示折叠箭头', () => {
    renderSection(true);
    expect(screen.queryByRole('button', { name: '基础' })).not.toBeInTheDocument();
    expect(document.querySelector('.rotate-180')).toBeNull();
  });
});

describe('UX 交互原语 · 下拉选择', () => {
  const options = [
    { label: '苹果', value: 'apple' },
    { label: '香蕉', value: 'banana', disabled: true },
    { label: '樱桃', value: 'cherry' },
  ];

  const renderDropdown = (value: string | null = null) => {
    const onChange = vi.fn();
    render(<Dropdown options={options} value={value} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /选择一个选项|苹果|樱桃/ });
    return { onChange, trigger };
  };

  it('ArrowDown 打开列表并聚焦第一个可用选项，跳过 disabled 项', async () => {
    const { trigger } = renderDropdown();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: '苹果' })).toHaveFocus());
  });

  it('ArrowUp 从末尾进入，连续方向键在可用选项间循环', async () => {
    const { trigger } = renderDropdown();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByRole('option', { name: '樱桃' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('option', { name: '樱桃' }), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: '苹果' })).toHaveFocus());
  });

  it('Home/End 跳到首个/末个可用选项', async () => {
    const { trigger } = renderDropdown();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: '苹果' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('option', { name: '苹果' }), { key: 'End' });
    await waitFor(() => expect(screen.getByRole('option', { name: '樱桃' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('option', { name: '樱桃' }), { key: 'Home' });
    await waitFor(() => expect(screen.getByRole('option', { name: '苹果' })).toHaveFocus());
  });

  it('Enter 选择当前选项，关闭列表并把焦点还给触发按钮', async () => {
    const { trigger, onChange } = renderDropdown();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { name: '苹果' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('option', { name: '苹果' }), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('apple');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('Escape 关闭列表且不改变选择，焦点回到触发按钮', async () => {
    const { trigger, onChange } = renderDropdown('apple');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('option', { name: '樱桃' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('键入可打印字符打开搜索并过滤，Enter 选择唯一结果', async () => {
    const { trigger, onChange } = renderDropdown();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: '樱' });
    const search = await screen.findByPlaceholderText('筛选选项...');
    expect(screen.getByRole('option', { name: '樱桃' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '苹果' })).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('cherry');
  });

  it('点击外部关闭列表，触发按钮 aria-expanded 同步', async () => {
    const { trigger } = renderDropdown();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('UX 交互原语 · 滑块', () => {
  const renderSlider = (disabled = false) => {
    const onChange = vi.fn();
    render(
      <Slider
        defaultValue={0}
        disabled={disabled}
        label="曝光"
        max={5}
        min={-5}
        onChange={onChange}
        step={0.1}
        suffix="EV"
        value={1.2}
      />,
    );
    return { onChange };
  };

  it('range 输入暴露可访问名称，数值显示作为可编辑按钮', () => {
    renderSlider();
    expect(screen.getByRole('slider', { name: '曝光' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '曝光: 1.2EV' })).toBeInTheDocument();
  });

  it('Enter 进入数值编辑，输入后 Enter 提交数值', () => {
    const { onChange } = renderSlider();
    fireEvent.keyDown(screen.getByRole('button', { name: '曝光: 1.2EV' }), { key: 'Enter' });
    const input = screen.getByRole('textbox', { name: '曝光' });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target: { value: 2.5 } }));
  });

  it('数值编辑中 ArrowUp/ArrowDown 按 step 调整', () => {
    const { onChange } = renderSlider();
    fireEvent.click(screen.getByRole('button', { name: '曝光: 1.2EV' }));
    const input = screen.getByRole('textbox', { name: '曝光' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target: { value: 1.3 } }));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target: { value: 1.2 } }));
  });

  it('悬停标签显示重置提示，点击标签恢复默认值', () => {
    const { onChange } = renderSlider();
    const label = screen.getByText('曝光');
    fireEvent.mouseEnter(label.parentElement as HTMLElement);
    expect(screen.getByText('重置')).toHaveAttribute('aria-hidden', 'false');
    fireEvent.click(label.parentElement as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: { value: 0 } }));
  });

  it('禁用时 range 原生 disabled，数值显示不可聚焦且无按钮语义', () => {
    renderSlider(true);
    expect(screen.getByRole('slider', { name: '曝光' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /曝光:/ })).not.toBeInTheDocument();
  });
});

describe('UX 交互原语 · 开关与分隔条', () => {
  it('点击开关标签切换，禁用时 input 原生 disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch label="启用" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByText('启用'));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Switch label="启用" checked={false} disabled onChange={onChange} />);
    expect(screen.getByRole('checkbox', { name: '启用' })).toBeDisabled();
  });

  it('分隔条暴露 separator 语义与方向', () => {
    const { rerender } = render(<Resizer direction={Orientation.Horizontal} onMouseDown={vi.fn()} />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    rerender(<Resizer direction={Orientation.Vertical} onMouseDown={vi.fn()} />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });
});
