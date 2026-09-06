import { describe, it, expect } from 'vitest';
import {
  Mask,
  SubMaskMode,
  ToolType,
  formatMaskTypeName,
  getMaskTypeName,
  getSubMaskName,
  MASK_ICON_MAP,
  MASK_AI_TYPES,
  MASK_BASIC_TYPES,
  MASK_RANGE_TYPES,
  ALL_MASK_TYPES,
  AI_DIRECT_PATCH_TYPES,
  AI_TOUCH_UP_TYPES,
  AI_GENERATIVE_CREATION_TYPES,
  OTHERS_MASK_TYPES,
  AI_SUB_MASK_COMPONENT_TYPES,
  type MaskType,
  type SubMask,
} from '../../src/components/panel/right/Masks';

// === TC-MASK-* 系列:覆盖 Masks.tsx 的枚举与命名函数 ===

describe('TC-MASK-01 ~ TC-MASK-08: Mask / SubMaskMode / ToolType 枚举完备性', () => {
  it('TC-MASK-01: Mask 枚举值数量与去重', () => {
    const values = Object.values(Mask);
    expect(values).toHaveLength(17);
    expect(new Set(values).size).toBe(17);
  });

  it('TC-MASK-01: Mask 枚举值与后端 sub_mask.mask_type 字符串严格一致', () => {
    const expected = [
      'ai-depth',
      'ai-foreground',
      'ai-sky',
      'ai-subject',
      'all',
      'brush',
      'flow',
      'color',
      'linear',
      'luminance',
      'quick-eraser',
      'radial',
      'clone',
      'heal',
      'liquify',
      'retouch',
      'auto-erase',
    ];
    expect(Object.values(Mask).sort()).toEqual([...expected].sort());
  });

  it('TC-MASK-07: SubMaskMode 枚举与后端字符串一致', () => {
    expect(SubMaskMode.Additive).toBe('additive');
    expect(SubMaskMode.Subtractive).toBe('subtractive');
    expect(SubMaskMode.Intersect).toBe('intersect');
    expect(Object.values(SubMaskMode)).toHaveLength(3);
  });

  it('TC-MASK-08: ToolType 枚举 5 个值', () => {
    expect(ToolType.AiSeletor).toBe('ai-selector');
    expect(ToolType.Brush).toBe('brush');
    expect(ToolType.Eraser).toBe('eraser');
    expect(ToolType.GenerativeReplace).toBe('generative-replace');
    expect(ToolType.SelectSubject).toBe('select-subject');
    expect(Object.values(ToolType)).toHaveLength(5);
  });
});

describe('TC-MASK-02 ~ TC-MASK-05: formatMaskTypeName / getMaskTypeName / getSubMaskName', () => {
  it('TC-MASK-02: formatMaskTypeName 对全部 17 个 Mask 返回非空字符串', () => {
    for (const m of Object.values(Mask)) {
      const name = formatMaskTypeName(m);
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
      // 不应回退到首字母大写(表明 i18n key 缺失)
      expect(name).not.toBe(m.charAt(0).toUpperCase() + m.slice(1));
    }
  });

  it('TC-MASK-02: formatMaskTypeName 关键类型文案快照(zh-CN)', () => {
    expect(formatMaskTypeName(Mask.AiDepth)).toBe('深度');
    expect(formatMaskTypeName(Mask.AiSubject)).toBe('主体');
    expect(formatMaskTypeName(Mask.AiForeground)).toBe('前景');
    expect(formatMaskTypeName(Mask.AiSky)).toBe('天空');
    expect(formatMaskTypeName(Mask.All)).toBe('整个图像');
    expect(formatMaskTypeName(Mask.Brush)).toBe('画笔');
    expect(formatMaskTypeName(Mask.Flow)).toBe('流线');
    expect(formatMaskTypeName(Mask.Color)).toBe('颜色');
    expect(formatMaskTypeName(Mask.Linear)).toBe('线性');
    expect(formatMaskTypeName(Mask.Luminance)).toBe('亮度');
    expect(formatMaskTypeName(Mask.Radial)).toBe('径向');
    expect(formatMaskTypeName(Mask.Clone)).toBe('克隆');
    expect(formatMaskTypeName(Mask.Heal)).toBe('修复');
    expect(formatMaskTypeName(Mask.Liquify)).toBe('液化');
    expect(formatMaskTypeName(Mask.Retouch)).toBe('修饰');
    expect(formatMaskTypeName(Mask.QuickEraser)).toBe('快速橡皮擦');
    expect(formatMaskTypeName(Mask.AutoErase)).toBe('自动消除');
  });

  it('TC-MASK-02: formatMaskTypeName 未知类型回退首字母大写', () => {
    expect(formatMaskTypeName('unknown-type')).toBe('Unknown-type');
  });

  it('TC-MASK-03: getMaskTypeName id=others 优先级最高', () => {
    const maskType: MaskType = {
      disabled: false,
      icon: null,
      id: 'others',
      name: 'Depth',
      type: Mask.AiDepth,
    };
    expect(getMaskTypeName(maskType)).toBe('其他');
  });

  it('TC-MASK-04: getMaskTypeName QuickEraser + name="Quick Erase" 特殊分支', () => {
    const maskType: MaskType = {
      disabled: false,
      icon: null,
      name: 'Quick Erase',
      type: Mask.QuickEraser,
    };
    expect(getMaskTypeName(maskType)).toBe('快速擦除');
  });

  it('TC-MASK-04: QuickEraser 不带特殊 name 时回退到 type 文案', () => {
    const maskType: MaskType = {
      disabled: false,
      icon: null,
      name: 'Other name',
      type: Mask.QuickEraser,
    };
    expect(getMaskTypeName(maskType)).toBe('快速橡皮擦');
  });

  it('TC-MASK-05: getSubMaskName 自定义 name 优先', () => {
    const sub: Pick<SubMask, 'name' | 'type'> = {
      name: '我的天空蒙版',
      type: Mask.AiSky,
    };
    expect(getSubMaskName(sub)).toBe('我的天空蒙版');
  });

  it('TC-MASK-05: getSubMaskName name 为空白时回退到 formatMaskTypeName', () => {
    expect(getSubMaskName({ name: '', type: Mask.AiSky })).toBe('天空');
    expect(getSubMaskName({ name: '   ', type: Mask.AiSky })).toBe('天空');
    expect(getSubMaskName({ name: undefined, type: Mask.AiSky })).toBe('天空');
  });
});

describe('TC-MASK-06: MASK_ICON_MAP 完备性', () => {
  it('TC-MASK-06: 17 个 Mask 均有 icon 映射', () => {
    for (const m of Object.values(Mask)) {
      expect(MASK_ICON_MAP[m]).toBeDefined();
      // lucide icon 是 forwardRef 组件
      expect(typeof MASK_ICON_MAP[m]).toBe('object');
    }
    expect(Object.keys(MASK_ICON_MAP)).toHaveLength(17);
  });
});

describe('TC-PANEL-04 / TC-PANEL-05: Mask 类型分组合集', () => {
  it('TC-PANEL-04: MASK_AI_TYPES 4 项且 type 正确', () => {
    expect(MASK_AI_TYPES).toHaveLength(4);
    expect(MASK_AI_TYPES.map((m) => m.type)).toEqual([
      Mask.AiSubject,
      Mask.AiSky,
      Mask.AiForeground,
      Mask.AiDepth,
    ]);
  });

  it('TC-PANEL-04: MASK_BASIC_TYPES 4 项且 type 正确', () => {
    expect(MASK_BASIC_TYPES).toHaveLength(4);
    expect(MASK_BASIC_TYPES.map((m) => m.type)).toEqual([
      Mask.Brush,
      Mask.Linear,
      Mask.Radial,
      Mask.Flow,
    ]);
  });

  it('TC-PANEL-04: MASK_RANGE_TYPES 3 项且 type 正确', () => {
    expect(MASK_RANGE_TYPES).toHaveLength(3);
    expect(MASK_RANGE_TYPES.map((m) => m.type)).toEqual([Mask.Color, Mask.Luminance, Mask.All]);
  });

  it('TC-PANEL-04: ALL_MASK_TYPES = AI + 基础 + 范围 共 11 项', () => {
    expect(ALL_MASK_TYPES).toHaveLength(11);
  });

  it('TC-PANEL-04: ALL_MASK_TYPES 各项 disabled === false', () => {
    for (const m of ALL_MASK_TYPES) {
      expect(m.disabled).toBe(false);
      expect(m.icon).toBeDefined();
      expect(typeof m.name).toBe('string');
    }
  });

  it('TC-PANEL-05: AI_DIRECT_PATCH_TYPES 3 项(Clone/Heal/AutoErase)', () => {
    expect(AI_DIRECT_PATCH_TYPES).toHaveLength(3);
    expect(AI_DIRECT_PATCH_TYPES.map((m) => m.type)).toEqual([Mask.Clone, Mask.Heal, Mask.AutoErase]);
  });

  it('TC-PANEL-05: AI_TOUCH_UP_TYPES 2 项(Liquify/Retouch)', () => {
    expect(AI_TOUCH_UP_TYPES).toHaveLength(2);
    expect(AI_TOUCH_UP_TYPES.map((m) => m.type)).toEqual([Mask.Liquify, Mask.Retouch]);
  });

  it('TC-PANEL-05: AI_GENERATIVE_CREATION_TYPES 6 项', () => {
    expect(AI_GENERATIVE_CREATION_TYPES).toHaveLength(6);
    expect(AI_GENERATIVE_CREATION_TYPES.map((m) => m.type)).toEqual([
      Mask.QuickEraser,
      Mask.AiSubject,
      Mask.AiForeground,
      Mask.Brush,
      Mask.Linear,
      Mask.Radial,
    ]);
  });

  it('TC-PANEL-05: OTHERS_MASK_TYPES 6 项', () => {
    expect(OTHERS_MASK_TYPES).toHaveLength(6);
    expect(OTHERS_MASK_TYPES.map((m) => m.type)).toEqual([
      Mask.AiDepth,
      Mask.Color,
      Mask.Luminance,
      Mask.Brush,
      Mask.Flow,
      Mask.All,
    ]);
  });

  it('TC-PANEL-05: AI_SUB_MASK_COMPONENT_TYPES = 直接修复 + 触点修饰 + 生成创建', () => {
    expect(AI_SUB_MASK_COMPONENT_TYPES).toHaveLength(3 + 2 + 6);
  });
});
