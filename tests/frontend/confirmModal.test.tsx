import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfirmModal from '../../src/components/modals/ConfirmModal';

// === TC-MODAL-01~04:ConfirmModal 确认守卫与键盘交互回归 ===

describe('ConfirmModal', () => {
  const title = '删除所选图像？';
  const message = '所选图像将从磁盘永久移除，且无法撤销。';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TC-MODAL-01 双击确认按钮时 onConfirm 仅触发一次(退场动画窗口防重)', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmModal isOpen title={title} message={message} onConfirm={onConfirm} onClose={onClose} />);

    const confirmBtn = await screen.findByRole('button', { name: '确认' });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('TC-MODAL-02 连续两次 Enter 确认同样只触发一次 onConfirm', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmModal isOpen title={title} message={message} onConfirm={onConfirm} onClose={onClose} />);

    // React 合成键盘事件沿 target 祖先链冒泡,需派发到模态内层元素
    const titleEl = await screen.findByText(title);
    fireEvent.keyDown(titleEl, { key: 'Enter' });
    fireEvent.keyDown(titleEl, { key: 'Enter' });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('TC-MODAL-03 Escape 触发 onClose 且不触发 onConfirm', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmModal isOpen title={title} message={message} onConfirm={onConfirm} onClose={onClose} />);

    const titleEl = await screen.findByText(title);
    fireEvent.keyDown(titleEl, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('TC-MODAL-04 重新打开后确认守卫复位,可再次触发 onConfirm', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <ConfirmModal isOpen title={title} message={message} onConfirm={onConfirm} onClose={onClose} />,
    );

    const confirmBtn = await screen.findByRole('button', { name: '确认' });
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<ConfirmModal isOpen={false} title={title} message={message} onConfirm={onConfirm} onClose={onClose} />);
    rerender(<ConfirmModal isOpen title={title} message={message} onConfirm={onConfirm} onClose={onClose} />);

    const confirmBtn2 = await screen.findByRole('button', { name: '确认' });
    fireEvent.click(confirmBtn2);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
  });

  it('TC-MODAL-05 未传文案时使用本地化默认按钮文案(zh-CN: 取消/确认)', async () => {
    render(<ConfirmModal isOpen title={title} message={message} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument();
  });
});
