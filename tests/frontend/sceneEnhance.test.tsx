import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BasicAdjustments from '../../src/components/adjustments/Basic';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../src/utils/adjustments';

// === TC-SCENE-* 系列:覆盖「场景增强」操作链路 ===
// 链路:Basic.tsx applySceneEnhance → setAdjustments(updater) → 后端 GPU 管线
// 重点回归:确定性治理域(切换场景不残留)、section 可见性强制开启、自动按钮联动

type Updater = (prev: Partial<Adjustments>) => Partial<Adjustments>;

const renderBasic = (overrides: Partial<Adjustments> = {}, onAutoAdjust?: () => void) => {
  const setAdjustments = vi.fn();
  render(
    <BasicAdjustments
      adjustments={{ ...INITIAL_ADJUSTMENTS, ...overrides }}
      setAdjustments={setAdjustments}
      onAutoAdjust={onAutoAdjust}
    />,
  );
  return { setAdjustments };
};

const applyUpdater = (updater: unknown, prev: Partial<Adjustments>) => {
  expect(typeof updater).toBe('function');
  return (updater as Updater)(prev);
};

const clickScene = (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
};

describe('TC-SCENE-01: 场景预设应用确定性治理域', () => {
  it('应用「人像」后治理域键全部落位,且域外参数(曲线/亮度/锐化)保留', () => {
    const prev: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      brightness: 1.5,
      sharpness: 30,
      curves: INITIAL_ADJUSTMENTS.curves,
      dehaze: 25,
      lumaNoiseReduction: 40,
    };
    const { setAdjustments } = renderBasic(prev);
    clickScene('人像');

    expect(setAdjustments).toHaveBeenCalledTimes(1);
    const next = applyUpdater(setAdjustments.mock.calls[0][0], prev);

    // 校准值生效
    expect(next.contrast).toBe(6);
    expect(next.vibrance).toBe(10);
    // 治理域残留清零:上一状态的 dehaze/NR 不泄漏
    expect(next.dehaze).toBe(0);
    expect(next.lumaNoiseReduction).toBe(0);
    expect(next.colorNoiseReduction).toBe(0);
    expect(next.temperature).toBe(0);
    expect(next.tint).toBe(0);
    // 域外用户创作参数保留
    expect(next.brightness).toBe(1.5);
    expect(next.sharpness).toBe(30);
    expect(next.curves).toBe(prev.curves);
    // 蒙版/几何等其余字段原样保留
    expect(next.masks).toBe(prev.masks);
    expect(next.crop).toBe(prev.crop);
  });

  it('应用「风景」后再应用「夜景」:NR 落位且 dehaze 归零(切换场景不残留)', () => {
    const { setAdjustments } = renderBasic();
    clickScene('风景');
    const afterLandscape = applyUpdater(setAdjustments.mock.calls[0][0], INITIAL_ADJUSTMENTS);
    expect(afterLandscape.dehaze).toBe(14);

    // 用真实 store 语义串联第二次更新
    clickScene('夜景');
    const afterNight = applyUpdater(setAdjustments.mock.calls[1][0], afterLandscape);
    expect(afterNight.lumaNoiseReduction).toBe(24);
    expect(afterNight.colorNoiseReduction).toBe(18);
    expect(afterNight.dehaze).toBe(0);
    expect(afterNight.saturation).toBe(8);
  });

  it('同一场景重复应用结果幂等(同一场景 = 同一结果)', () => {
    const { setAdjustments } = renderBasic({ ...INITIAL_ADJUSTMENTS, saturation: 90, exposure: 3 });
    clickScene('暖阳');
    const first = applyUpdater(setAdjustments.mock.calls[0][0], INITIAL_ADJUSTMENTS);
    clickScene('暖阳');
    const second = applyUpdater(setAdjustments.mock.calls[1][0], first);
    for (const key of Object.keys(first)) {
      expect(JSON.stringify(second[key])).toBe(JSON.stringify(first[key]));
    }
  });
});

describe('TC-SCENE-02: 场景预设强制开启所属 section 可见性', () => {
  it('basic/color/details 被隐藏时应用场景会重新开启,其余 section 状态保留', () => {
    const prev: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      sectionVisibility: {
        ...INITIAL_ADJUSTMENTS.sectionVisibility,
        basic: false,
        color: false,
        details: false,
        effects: false,
        curves: true,
      },
    };
    const { setAdjustments } = renderBasic(prev);
    clickScene('人像');

    const next = applyUpdater(setAdjustments.mock.calls[0][0], prev);
    expect(next.sectionVisibility?.basic).toBe(true);
    expect(next.sectionVisibility?.color).toBe(true);
    expect(next.sectionVisibility?.details).toBe(true);
    // 未治理的 section 不被顺手打开
    expect(next.sectionVisibility?.effects).toBe(false);
    expect(next.sectionVisibility?.curves).toBe(true);
  });
});

describe('TC-SCENE-03: 「自动」按钮与蒙版路径', () => {
  it('点击「自动」触发 onAutoAdjust 回调(复用后端 perform_auto_analysis 链路)', () => {
    const onAutoAdjust = vi.fn();
    renderBasic({}, onAutoAdjust);
    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(onAutoAdjust).toHaveBeenCalledTimes(1);
  });

  it('isForMask=true(蒙版局部调整)不渲染场景增强块', () => {
    const setAdjustments = vi.fn();
    render(
      <BasicAdjustments
        adjustments={INITIAL_ADJUSTMENTS}
        setAdjustments={setAdjustments}
        isForMask
        onAutoAdjust={() => {}}
      />,
    );
    expect(screen.queryByText('场景增强')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '人像' })).not.toBeInTheDocument();
  });

  it('未提供 onAutoAdjust 时不渲染「自动」按钮,场景预设仍可用', () => {
    renderBasic();
    expect(screen.queryByRole('button', { name: '自动' })).not.toBeInTheDocument();
    clickScene('人像');
    expect(screen.getByRole('button', { name: '人像' })).toBeTruthy();
  });
});
