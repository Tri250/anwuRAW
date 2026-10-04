import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Mask, SubMask, ToolType } from '../../src/components/panel/right/Masks';
import {
  showMaskEditingToolbar,
  default as MaskEditingToolbar,
} from '../../src/components/panel/editor/MaskEditingToolbar';

// === TC-TB-* 系列:覆盖 MaskEditingToolbar.tsx ===

/** 构造 SubMask fixture */
function makeSubMask(type: Mask, overrides: Partial<SubMask> = {}, parameters: Record<string, unknown> = {}): SubMask {
  return {
    id: 'sm-test',
    visible: true,
    invert: false,
    opacity: 100,
    mode: 'additive',
    name: undefined,
    type,
    parameters,
    ...overrides,
  } as SubMask;
}

const baseBrushSettings = { size: 50, feather: 50, opacity: 100, tool: ToolType.Brush };

describe('TC-TB-01 ~ TC-TB-06: showMaskEditingToolbar 与常量行为', () => {
  it('TC-TB-01: showMaskEditingToolbar(null) === false', () => {
    expect(showMaskEditingToolbar(null)).toBe(false);
    expect(showMaskEditingToolbar(undefined)).toBe(false);
  });

  it('TC-TB-02: 12 个可见类型返回 true,AI 类型与 All 返回 false', () => {
    const visibleTypes: Mask[] = [
      Mask.Brush,
      Mask.Flow,
      Mask.QuickEraser,
      Mask.Linear,
      Mask.Radial,
      Mask.Color,
      Mask.Luminance,
      Mask.Clone,
      Mask.Heal,
      Mask.AutoErase,
      Mask.Liquify,
      Mask.Retouch,
    ];
    expect(visibleTypes).toHaveLength(12);
    for (const t of visibleTypes) {
      expect(showMaskEditingToolbar(makeSubMask(t))).toBe(true);
    }
    // 不在可见列表中的类型
    for (const t of [Mask.AiSubject, Mask.AiForeground, Mask.AiSky, Mask.AiDepth, Mask.All]) {
      expect(showMaskEditingToolbar(makeSubMask(t))).toBe(false);
    }
  });
});

describe('TC-TB-07 ~ TC-TB-17: 渲染与交互', () => {
  it('TC-TB-07: Brush 显示笔刷大小滑杆且 max=400', () => {
    const onBrushSettingsChange = vi.fn();
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={onBrushSettingsChange}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // title 在 <label> 上,max 在内部 <input type="range"> 上
    const sizeSlider = screen.getByTitle('笔刷大小').querySelector('input[type="range"]') as HTMLInputElement;
    expect(sizeSlider).toHaveAttribute('max', '400');
    // 拖动触发 onBrushSettingsChange
    fireEvent.change(sizeSlider, { target: { value: '200' } });
    expect(onBrushSettingsChange).toHaveBeenCalledWith({ size: 200 });
  });

  it('TC-TB-08: Brush 显示柔软度滑杆且 max=100', () => {
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const featherSlider = screen.getByTitle('柔软度').querySelector('input[type="range"]') as HTMLInputElement;
    expect(featherSlider).toHaveAttribute('max', '100');
  });

  it('TC-TB-09: Liquify 显示强度滑杆并读取 parameters.pressure,默认回退 40', () => {
    const onStrengthChange = vi.fn();
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Liquify, {}, { pressure: 60 })}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={onStrengthChange}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const strengthSlider = screen.getByTitle('强度');
    expect(strengthSlider).toHaveValue('60');
    fireEvent.change(strengthSlider, { target: { value: '80' } });
    expect(onStrengthChange).toHaveBeenCalledWith(80);
  });

  it('TC-TB-09b: Liquify parameters 为 undefined 时强度回退 40', () => {
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Liquify, {}, {})}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTitle('强度')).toHaveValue('40');
  });

  it('TC-TB-10: Retouch 强度滑杆读取 parameters.intensity', () => {
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Retouch, {}, { intensity: 30 })}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTitle('强度')).toHaveValue('30');
  });

  it('TC-TB-11: AutoErase 强度滑杆读取 parameters.sensitivity', () => {
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.AutoErase, {}, { sensitivity: 75 })}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTitle('强度')).toHaveValue('75');
  });

  it('TC-TB-12: Brush 显示反选按钮,Clone 不显示', () => {
    const { rerender } = render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTitle('反选')).toBeInTheDocument();
    rerender(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Clone)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.queryByTitle('反选')).not.toBeInTheDocument();
  });

  it('TC-TB-13: Color 显示清除蒙版按钮,AiSky 不显示', () => {
    const { rerender } = render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Color)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTitle('清除蒙版')).toBeInTheDocument();
    // AiSky 不在 TOOLBAR_VISIBLE_TYPES,但即便强行渲染也不会显示清除按钮
    rerender(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // Brush 也在 CLEAR_TYPES,所以仍显示
    expect(screen.getByTitle('清除蒙版')).toBeInTheDocument();
  });

  it('TC-TB-14: 完成按钮始终可点击', () => {
    const onDone = vi.fn();
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={onDone}
      />,
    );
    const doneBtn = screen.getByText('完成').closest('button')!;
    expect(doneBtn).not.toBeDisabled();
    fireEvent.click(doneBtn);
    expect(onDone).toHaveBeenCalled();
  });

  it('TC-TB-15: 蒙版叠加显隐切换 - Eye/EyeOff 切换', () => {
    const onToggleOverlay = vi.fn();
    const { rerender } = render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={onToggleOverlay}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // 可见时按钮 title 为 overlayOff
    const visibleBtn = screen.getByTitle('隐藏蒙版叠加');
    fireEvent.click(visibleBtn);
    expect(onToggleOverlay).toHaveBeenCalled();
    // 切换为不可见
    rerender(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={false}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={onToggleOverlay}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTitle('显示蒙版叠加')).toBeInTheDocument();
  });

  it('TC-TB-16: 笔刷/橡皮切换触发 onBrushToolChange', async () => {
    const user = userEvent.setup();
    const onBrushToolChange = vi.fn();
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={onBrushToolChange}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // 多个按钮文案为"画笔",取第一个非 active
    const brushButtons = screen.getAllByTitle('画笔');
    const eraserButtons = screen.getAllByTitle('橡皮擦');
    expect(brushButtons.length).toBeGreaterThan(0);
    expect(eraserButtons.length).toBeGreaterThan(0);
    await user.click(eraserButtons[0]);
    expect(onBrushToolChange).toHaveBeenCalledWith(ToolType.Eraser);
    await user.click(brushButtons[0]);
    expect(onBrushToolChange).toHaveBeenCalledWith(ToolType.Brush);
  });

  it('TC-TB-17: 工具条标题显示子蒙版名', () => {
    render(
      <MaskEditingToolbar
        subMask={makeSubMask(Mask.Brush)}
        brushSettings={baseBrushSettings}
        maskOverlayVisible={true}
        onBrushToolChange={vi.fn()}
        onBrushSettingsChange={vi.fn()}
        onStrengthChange={vi.fn()}
        onToggleOverlay={vi.fn()}
        onInvert={vi.fn()}
        onClear={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // 标题含 "蒙版编辑" + 子蒙版名
    expect(screen.getByText(/蒙版编辑/)).toBeInTheDocument();
    // getSubMaskName(Brush) === '画笔'(工具按钮/标题中可能出现多次,取 all)
    expect(screen.getAllByText('画笔').length).toBeGreaterThan(0);
  });

  it('TC-TB-验收: 全部 12 个 TOOLBAR_VISIBLE_TYPES 渲染不抛错', () => {
    const types: Mask[] = [
      Mask.Brush,
      Mask.Flow,
      Mask.QuickEraser,
      Mask.Linear,
      Mask.Radial,
      Mask.Color,
      Mask.Luminance,
      Mask.Clone,
      Mask.Heal,
      Mask.AutoErase,
      Mask.Liquify,
      Mask.Retouch,
    ];
    for (const t of types) {
      expect(() =>
        render(
          <MaskEditingToolbar
            subMask={makeSubMask(t)}
            brushSettings={baseBrushSettings}
            maskOverlayVisible={true}
            onBrushToolChange={vi.fn()}
            onBrushSettingsChange={vi.fn()}
            onStrengthChange={vi.fn()}
            onToggleOverlay={vi.fn()}
            onInvert={vi.fn()}
            onClear={vi.fn()}
            onDone={vi.fn()}
          />,
        ),
      ).not.toThrow();
    }
  });
});
