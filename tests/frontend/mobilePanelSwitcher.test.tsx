import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobilePanelSwitcher } from '../../src/components/panel/PanelSwitcher';
import { Panel } from '../../src/components/ui/AppProperties';

// === TC-M-PANEL-* 系列:移动端面板切换器(Compact 模式主导航)交互与无障碍回归 ===

describe('MobilePanelSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TC-M-PANEL-01 渲染 7 个面板按钮,全部具备可访问名称(图标按钮 WCAG 4.1.2)', () => {
    render(<MobilePanelSwitcher activePanel={null} onPanelSelect={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(7);
    for (const btn of buttons) {
      expect(btn.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('TC-M-PANEL-02 点击未激活面板:回调携带面板 id', () => {
    const onPanelSelect = vi.fn();
    render(<MobilePanelSwitcher activePanel={null} onPanelSelect={onPanelSelect} />);

    fireEvent.click(screen.getByRole('button', { name: '调整' }));
    expect(onPanelSelect).toHaveBeenCalledWith(Panel.Adjustments);
  });

  it('TC-M-PANEL-03 点击已激活面板:回调携带 null(收起面板)', () => {
    const onPanelSelect = vi.fn();
    render(<MobilePanelSwitcher activePanel={Panel.Adjustments} onPanelSelect={onPanelSelect} />);

    fireEvent.click(screen.getByRole('button', { name: '调整' }));
    expect(onPanelSelect).toHaveBeenCalledWith(null);
  });

  it('TC-M-PANEL-04 激活面板 aria-pressed=true,其余为 false', () => {
    render(<MobilePanelSwitcher activePanel={Panel.Masks} onPanelSelect={vi.fn()} />);

    const active = screen.getByRole('button', { name: '蒙版' });
    expect(active.getAttribute('aria-pressed')).toBe('true');

    const inactive = screen.getByRole('button', { name: '导出' });
    expect(inactive.getAttribute('aria-pressed')).toBe('false');
  });
});
