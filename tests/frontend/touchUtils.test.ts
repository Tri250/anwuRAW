import { describe, expect, it } from 'vitest';

import { DOUBLE_TAP_MAX_DELAY_MS, DOUBLE_TAP_MAX_DISTANCE_PX, isDoubleTap } from '../../src/utils/touchUtils';

describe('touchUtils.isDoubleTap', () => {
  const firstTap = { time: 1000, x: 100, y: 100 };

  it('TC-M-TAP-01 无前次 tap 时判定为否（首次触摸不缩放）', () => {
    expect(isDoubleTap(null, { time: 1100, x: 100, y: 100 })).toBe(false);
  });

  it('TC-M-TAP-02 间隔与位移均在阈值内判定为双击', () => {
    expect(isDoubleTap(firstTap, { time: 1000 + DOUBLE_TAP_MAX_DELAY_MS - 1, x: 100, y: 100 })).toBe(true);
    expect(
      isDoubleTap(firstTap, {
        time: 1000 + DOUBLE_TAP_MAX_DELAY_MS - 1,
        x: 100 + DOUBLE_TAP_MAX_DISTANCE_PX - 1,
        y: 100,
      }),
    ).toBe(true);
  });

  it('TC-M-TAP-03 间隔达到上限时判定为否（两次独立单击）', () => {
    expect(isDoubleTap(firstTap, { time: 1000 + DOUBLE_TAP_MAX_DELAY_MS, x: 100, y: 100 })).toBe(false);
  });

  it('TC-M-TAP-04 位移达到上限时判定为否（远距离第二次 tap 非双击）', () => {
    expect(
      isDoubleTap(firstTap, { time: 1100, x: 100 + DOUBLE_TAP_MAX_DISTANCE_PX, y: 100 }),
    ).toBe(false);
    expect(
      isDoubleTap(firstTap, { time: 1100, x: 100, y: 100 + DOUBLE_TAP_MAX_DISTANCE_PX - 0.5 }),
    ).toBe(true);
  });

  it('TC-M-TAP-05 时间倒流（时钟异常）判定为否', () => {
    expect(isDoubleTap(firstTap, { time: 900, x: 100, y: 100 })).toBe(false);
  });
});
