import { useEditorStore } from '../../store/useEditorStore';

/* ---------------------------------------------------------------------------
 * P0-2 移动端 1:1 视口金字塔（借鉴 RawLab 移动端 ROI 渐进缩放）：
 * CrystalPreview 的平移/捏合手势持续写入这里（纯对象，零 React 重渲染），
 * 手势结束时 flushMobileViewport() 一次性上报 displaySize / baseRenderSize /
 * mobileRoi 到 editor store（与桌面 Editor.handleDisplaySizeChange 同构），
 * 由 useImageProcessing 的既有管线完成放大分辨率的重渲染；
 * hi-fi ROI 补丁由 CrystalPreview 直接经 apply_adjustments patch_mode 请求，
 * 后端按交互补丁的 16 字节头打包返回。
 * ------------------------------------------------------------------------- */

export interface MobileViewport {
  /** 当前缩放（1 = contain 适配态） */
  scale: number;
  /** 可视区域相对预览图（含裁剪结果）的归一化 ROI，1x 时为 null */
  roi: [number, number, number, number] | null;
  /** 预览图 1x contain 显示矩形（相对预览容器，px） */
  imgRect: { left: number; top: number; width: number; height: number } | null;
  containerW: number;
  containerH: number;
}

const viewport: MobileViewport = { scale: 1, roi: null, imgRect: null, containerW: 0, containerH: 0 };

export function setMobileViewport(next: Partial<MobileViewport>): void {
  Object.assign(viewport, next);
}

export function getMobileViewport(): MobileViewport {
  return viewport;
}

/** 手势结束 / 双击缩放 / 复位后调用：把当前视口上报进 store 并触发 ROI 渲染。
 * 放大态：上报 displaySize（= contain 矩形 × 缩放）与 ROI，驱动金字塔中/高层级；
 * 1x 态：仅复位 ROI 并把 displaySize 归零（回退到 editorPreviewResolution 基准，
 * 与既有移动端行为一致，避免 1x 画质被 contain 尺寸拉低）。 */
export function flushMobileViewport(): void {
  const store = useEditorStore.getState();
  const rect = viewport.imgRect;
  if (viewport.scale > 1.01 && rect && rect.width >= 1 && rect.height >= 1) {
    store.setEditor({
      displaySize: {
        width: Math.round(rect.width * viewport.scale),
        height: Math.round(rect.height * viewport.scale),
      },
      baseRenderSize: {
        width: rect.width,
        height: rect.height,
        offsetX: rect.left,
        offsetY: rect.top,
        containerWidth: viewport.containerW,
        containerHeight: viewport.containerH,
      },
      mobileRoi: viewport.roi,
      mobileRoiVersion: store.mobileRoiVersion + 1,
    });
  } else {
    store.setEditor({
      displaySize: { width: 0, height: 0 },
      mobileRoi: null,
      mobileRoiVersion: store.mobileRoiVersion + 1,
    });
  }
}

/**
 * 由 transform 状态解析归一化 ROI。stage 变换为
 * `translate(x, y) scale(s)`（原点 = 容器中心），可视区域 = 容器矩形与
 * 变换后图像矩形的交集，除以图像矩形即归一化 ROI。
 * 返回 null 表示 1x 全图（或退化情形）。
 */
export function computeMobileRoi(
  scale: number,
  x: number,
  y: number,
  rect: MobileViewport['imgRect'],
): [number, number, number, number] | null {
  if (!rect || scale <= 1.01) return null;
  const cx = viewport.containerW / 2;
  const cy = viewport.containerH / 2;
  // 中心缩放：图像矩形绕容器中心缩放后平移
  const left = cx + (rect.left - cx) * scale + x;
  const top = cy + (rect.top - cy) * scale + y;
  const width = rect.width * scale;
  const height = rect.height * scale;
  const vx0 = Math.max(0, left);
  const vy0 = Math.max(0, top);
  const vx1 = Math.min(viewport.containerW, left + width);
  const vy1 = Math.min(viewport.containerH, top + height);
  if (vx1 <= vx0 || vy1 <= vy0) return null;
  let nx = (vx0 - left) / width;
  let ny = (vy0 - top) / height;
  let nw = (vx1 - vx0) / width;
  let nh = (vy1 - vy0) / height;
  // 2px 边缘内缩（与桌面 calculateROI 同参），防止补丁边缘采样越界
  const padX = 2 / (rect.width * scale);
  const padY = 2 / (rect.height * scale);
  nx = Math.min(1, nx + padX);
  ny = Math.min(1, ny + padY);
  nw = Math.max(0, nw - padX * 2);
  nh = Math.max(0, nh - padY * 2);
  if (nw <= 0 || nh <= 0) return null;
  if (nx + nw > 1) nw = 1 - nx;
  if (ny + nh > 1) nh = 1 - ny;
  if (nw > 0.999 && nh > 0.999) return null;
  return [nx, ny, nw, nh];
}
