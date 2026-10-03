import { v4 as uuidv4 } from 'uuid';
import { Mask, SubMaskMode, SubMask, formatMaskTypeName } from '../components/panel/right/Masks';
import { ImageDimensions } from '../hooks/useImageRenderSize';

export const createSubMask = (
  type: Mask,
  imageDimensions: ImageDimensions,
  mode: SubMaskMode = SubMaskMode.Additive,
): SubMask => {
  const { width, height } = imageDimensions || { width: 1000, height: 1000 };
  const common = {
    id: uuidv4(),
    visible: true,
    invert: false,
    opacity: 100,
    mode,
    name: formatMaskTypeName(type),
    type,
  };

  switch (type) {
    case Mask.Radial:
      return {
        ...common,
        parameters: {
          centerX: width / 2,
          centerY: height / 2,
          radiusX: width / 4,
          radiusY: width / 4,
          rotation: 0,
          feather: 0.5,
        },
      };
    case Mask.Linear:
      return {
        ...common,
        parameters: { startX: width * 0.25, startY: height / 2, endX: width * 0.75, endY: height / 2, range: 50 },
      };
    case Mask.Brush:
      return { ...common, parameters: { lines: [] } };
    case Mask.Flow:
      return { ...common, parameters: { lines: [], flow: 10 } };
    case Mask.AiSubject:
      return { ...common, parameters: { maskDataBase64: null, grow: 50, feather: 25 } };
    case Mask.AiForeground:
      return { ...common, parameters: { maskDataBase64: null, grow: 50, feather: 25 } };
    case Mask.QuickEraser:
      return { ...common, parameters: { maskDataBase64: null, grow: 75, feather: 75 } };
    // 修复类工具：统一在工厂里补齐默认参数，避免经 MasksPanel 等非 AIPanel 入口创建时
    // 丢失 sensitivity / pressure / intensity / liquifyMode 等关键字段，导致后端回落兜底值
    // 与前端面板展示值不一致。
    case Mask.Clone:
      return { ...common, parameters: { lines: [] } };
    case Mask.Heal:
      return { ...common, parameters: { lines: [] } };
    case Mask.AutoErase:
      return { ...common, parameters: { sensitivity: 55 } };
    case Mask.Liquify:
      return { ...common, parameters: { lines: [], pressure: 40, liquifyMode: 'push' } };
    case Mask.Retouch:
      return { ...common, parameters: { lines: [], intensity: 40 } };
    default:
      return { ...common, parameters: {} };
  }
};
