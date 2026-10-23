import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Dropdown from '../../src/components/ui/Dropdown';

// === TC-UI-DROPDOWN:Dropdown 硬编码默认文案 i18n 化回归 ===

const options = [
  { label: '选项 A', value: 'a' },
  { label: '选项 B', value: 'b' },
];

describe('Dropdown 默认文案 i18n 兜底', () => {
  it('未传 placeholder 时显示本地化默认值(zh-CN: 选择一个选项)', () => {
    render(<Dropdown options={options} value={null} onChange={vi.fn()} />);
    expect(screen.getByText('选择一个选项')).toBeInTheDocument();
  });

  it('显式传入 placeholder 时优先使用调用点文案', () => {
    render(<Dropdown options={options} value={null} onChange={vi.fn()} placeholder="自定义提示" />);
    expect(screen.getByText('自定义提示')).toBeInTheDocument();
    expect(screen.queryByText('选择一个选项')).not.toBeInTheDocument();
  });

  it('键盘输入唤起搜索框时,搜索占位符使用本地化默认值(筛选选项...)', () => {
    render(<Dropdown options={options} value={null} onChange={vi.fn()} />);
    const container = screen.getByText('选择一个选项').closest('div.relative') as HTMLElement;
    fireEvent.keyDown(container, { key: 'a' });
    const searchInput = screen.getByPlaceholderText('筛选选项...');
    expect(searchInput).toBeInTheDocument();
  });

  it('选中项显示选项 label 而非占位符', () => {
    render(<Dropdown options={options} value="b" onChange={vi.fn()} />);
    expect(screen.getByText('选项 B')).toBeInTheDocument();
    expect(screen.queryByText('选择一个选项')).not.toBeInTheDocument();
  });
});
