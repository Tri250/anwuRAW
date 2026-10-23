import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useLongPressMenu } from '../../src/hooks/useLongPressMenu';

const pointer = (pointerType: string, clientX: number, clientY: number) =>
  ({ pointerType, clientX, clientY }) as any;

describe('useLongPressMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC-M-LP-01 触屏按住 500ms 触发菜单并传入按下坐标', () => {
    const onContextMenu = vi.fn();
    const { result } = renderHook(() => useLongPressMenu('a.jpg', onContextMenu));

    act(() => result.current.onPointerDown(pointer('touch', 12, 34)));
    act(() => vi.advanceTimersByTime(499));
    expect(onContextMenu).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0]).toMatchObject({ clientX: 12, clientY: 34 });
    expect(onContextMenu.mock.calls[0][1]).toBe('a.jpg');
    expect(result.current.triggeredRef.current).toBe(true);
  });

  it('TC-M-LP-02 手指移动超过 10px 视为滚动,取消长按', () => {
    const onContextMenu = vi.fn();
    const { result } = renderHook(() => useLongPressMenu('a.jpg', onContextMenu));

    act(() => result.current.onPointerDown(pointer('touch', 0, 0)));
    act(() => result.current.onPointerMove(pointer('touch', 11, 0)));
    act(() => vi.advanceTimersByTime(500));

    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('TC-M-LP-03 鼠标不触发长按(桌面保留右键)', () => {
    const onContextMenu = vi.fn();
    const { result } = renderHook(() => useLongPressMenu('a.jpg', onContextMenu));

    act(() => result.current.onPointerDown(pointer('mouse', 0, 0)));
    act(() => vi.advanceTimersByTime(500));

    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('TC-M-LP-04 卸载时清理未触发的定时器', () => {
    const onContextMenu = vi.fn();
    const { result, unmount } = renderHook(() => useLongPressMenu('a.jpg', onContextMenu));

    act(() => result.current.onPointerDown(pointer('touch', 0, 0)));
    unmount();
    act(() => vi.advanceTimersByTime(500));

    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
