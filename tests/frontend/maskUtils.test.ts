import { describe, it, expect } from 'vitest';
import { Mask, SubMaskMode } from '../../src/components/panel/right/Masks';
import { createSubMask } from '../../src/utils/maskUtils';

// 测试用图像尺寸(与 maskUtils 默认回退一致)
const DIMS = { width: 1000, height: 1000 };

// === TC-CREATE-* 系列:覆盖 createSubMask 工厂函数 ===

describe('TC-CREATE-01 ~ TC-CREATE-11: createSubMask 工厂函数', () => {
  it('TC-CREATE-01: 默认字段齐全且符合 SubMask 接口', () => {
    const sm = createSubMask(Mask.Radial, DIMS);
    expect(sm.id).toBeTruthy();
    expect(typeof sm.id).toBe('string');
    expect(sm.id.length).toBeGreaterThan(0);
    expect(sm.visible).toBe(true);
    expect(sm.invert).toBe(false);
    expect(sm.opacity).toBe(100);
    expect(sm.mode).toBe(SubMaskMode.Additive);
    expect(sm.name).toBe('径向');
    expect(sm.type).toBe(Mask.Radial);
    expect(sm.parameters).toBeTypeOf('object');
  });

  it('TC-CREATE-02: Radial 默认参数几何中心位于图像中心', () => {
    const sm = createSubMask(Mask.Radial, DIMS);
    expect(sm.parameters).toEqual({
      centerX: 500,
      centerY: 500,
      radiusX: 250,
      radiusY: 250,
      rotation: 0,
      feather: 0.5,
    });
  });

  it('TC-CREATE-03: Linear 默认参数位于水平中线', () => {
    const sm = createSubMask(Mask.Linear, DIMS);
    expect(sm.parameters).toEqual({
      startX: 250,
      startY: 500,
      endX: 750,
      endY: 500,
      range: 50,
    });
  });

  it('TC-CREATE-04: Brush 默认空笔迹', () => {
    const sm = createSubMask(Mask.Brush, DIMS);
    expect(sm.parameters).toEqual({ lines: [] });
  });

  it('TC-CREATE-05: Flow 默认 flow=10(与后端 default_line_flow 一致)', () => {
    const sm = createSubMask(Mask.Flow, DIMS);
    expect(sm.parameters).toEqual({ lines: [], flow: 10 });
  });

  it('TC-CREATE-06: AI Subject 默认参数与 SUB_MASK_CONFIG 一致', () => {
    const sm = createSubMask(Mask.AiSubject, DIMS);
    expect(sm.parameters).toEqual({
      maskDataBase64: null,
      grow: 50,
      feather: 25,
    });
  });

  it('TC-CREATE-07: AI Foreground 默认参数', () => {
    const sm = createSubMask(Mask.AiForeground, DIMS);
    expect(sm.parameters).toEqual({
      maskDataBase64: null,
      grow: 50,
      feather: 25,
    });
  });

  it('TC-CREATE-08: QuickEraser 默认参数 grow=75/feather=75', () => {
    const sm = createSubMask(Mask.QuickEraser, DIMS);
    expect(sm.parameters).toEqual({
      maskDataBase64: null,
      grow: 75,
      feather: 75,
    });
  });

  it('TC-CREATE-09: 其他类型默认空参数对象', () => {
    for (const type of [Mask.Color, Mask.Luminance, Mask.All, Mask.AiSky, Mask.AiDepth, Mask.Clone, Mask.Heal, Mask.AutoErase, Mask.Liquify, Mask.Retouch]) {
      const sm = createSubMask(type, DIMS);
      expect(sm.parameters).toEqual({});
    }
  });

  it('TC-CREATE-10: imageDimensions 为 null 时不抛异常,回退到 1000x1000', () => {
    expect(() => createSubMask(Mask.Radial, null as never)).not.toThrow();
    const sm = createSubMask(Mask.Radial, null as never);
    expect(sm.parameters.centerX).toBe(500);
  });

  it('TC-CREATE-10: 不同图像尺寸下几何参数成比例', () => {
    const sm = createSubMask(Mask.Radial, { width: 2000, height: 1000 });
    expect(sm.parameters.centerX).toBe(1000);
    expect(sm.parameters.centerY).toBe(500);
    expect(sm.parameters.radiusX).toBe(500); // width / 4
    expect(sm.parameters.radiusY).toBe(500); // width / 4
  });

  it('TC-CREATE-11: 自定义 mode 透传', () => {
    const sm = createSubMask(Mask.Brush, DIMS, SubMaskMode.Subtractive);
    expect(sm.mode).toBe(SubMaskMode.Subtractive);
    const sm2 = createSubMask(Mask.Brush, DIMS, SubMaskMode.Intersect);
    expect(sm2.mode).toBe(SubMaskMode.Intersect);
  });

  it('TC-CREATE-验收: 全部 17 种 Mask 类型经 createSubMask 调用不抛异常', () => {
    for (const type of Object.values(Mask)) {
      expect(() => createSubMask(type, DIMS)).not.toThrow();
    }
  });

  it('TC-CREATE-验收: 每次调用生成新 id(uuid v4)', () => {
    const a = createSubMask(Mask.Brush, DIMS);
    const b = createSubMask(Mask.Brush, DIMS);
    expect(a.id).not.toBe(b.id);
  });
});
