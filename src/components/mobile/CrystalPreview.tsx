import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import type { Crop } from 'react-image-crop';
import { ChevronsLeftRight, Loader2, Move, RotateCcw, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../store/useEditorStore';
import { getOrientedDimensions, isCropWithinBounds, moveCropInsideBounds } from '../../utils/cropUtils';
import { useCrystalAdjust, haptic, useImmersiveCropStore } from './crystalShared';

/* ---------------------------------------------------------------------------
 * P2 预览区升级：双指缩放 + 平移 + 双击缩放 + 前后对比分割滑杆。
 * 手势基于 Pointer Events（WebView 触摸/鼠标统一），坐标锚定变换中心，
 * 平移按 contain 适配尺寸钳制边界，切图/切分类/进对比自动复位。
 * v2.1.13：构图模式下支持单指拖动平移裁剪窗口（moveCropInsideBounds 边界钳制），
 * 预览叠加三分构图网格；修复对比滑杆悬空跟随、缩放过渡不复位等问题。
 * v2.1.19（D-CP-02/P1）：裁剪框 4 角 + 4 边手柄（命中半径 ≥44px）八向调整尺寸，
 * 锁定比例时以对角/对边中点为锚点等比缩放；cropResize 与 pan/pinch/crop/cropDraw
 * 五种手势模式互斥。D-CP-03：左上角手势状态胶囊消除 atOneX 隐式条件。
 * ------------------------------------------------------------------------- */

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 14;
const ZOOM_STEP = 2;
const CROP_HINT_MS = 6000;

/** 裁剪手柄方向：4 角 + 4 边（八向） */
type CropHandleDir = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'w' | 's' | 'e';
const CORNER_DIRS: ReadonlyArray<CropHandleDir> = ['nw', 'ne', 'sw', 'se'];
const EDGE_DIRS: ReadonlyArray<CropHandleDir> = ['n', 'w', 's', 'e'];

interface Transform {
  scale: number;
  x: number;
  y: number;
}
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

interface GestureState {
  mode: 'none' | 'pan' | 'pinch' | 'crop' | 'cropDraw' | 'cropResize';
  startT: Transform;
  startPt: { x: number; y: number };
  startDist: number;
  startCrop: Crop | null;
  moved: boolean;
  /** cropResize 模式下的手柄方向（其余模式为 null） */
  resizeDir: CropHandleDir | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** 定向后的源像素尺寸（裁剪坐标系基于定向后的宽高） */
const orientedSize = (w: number, h: number, steps: number): [number, number] => {
  const { width, height } = getOrientedDimensions(w, h, steps);
  return [width, height];
};

/** 桌面预设可能携带 '%' 单位裁剪；统一换算为定向坐标系下的 px 裁剪。 */
function toPxCrop(crop: Crop | null, w: number, h: number): Crop | null {
  if (!crop || !w || !h) return null;
  if (crop.unit === '%') {
    return {
      unit: 'px',
      x: (crop.x / 100) * w,
      y: (crop.y / 100) * h,
      width: (crop.width / 100) * w,
      height: (crop.height / 100) * h,
    };
  }
  return { ...crop, unit: 'px' };
}

export default function CrystalPreview({
  compare,
  onCompareChange,
  activeCategory,
}: {
  compare: boolean;
  onCompareChange: (next: boolean) => void;
  activeCategory: string;
}) {
  const { t } = useTranslation();
  const { finalPreviewUrl, originalPreview, showOriginal, hasRenderedFirstFrame } = useEditorStore(
    useShallow((s) => ({
      finalPreviewUrl: s.finalPreviewUrl,
      originalPreview: s.originalPreview?.url,
      showOriginal: s.showOriginal,
      hasRenderedFirstFrame: s.hasRenderedFirstFrame,
    })),
  );
  // 审计修复（底栏-原图）：showOriginal 时 originalPreview 可能尚未渲染完成，
  // 回落到 finalPreviewUrl（配合 previewOverride，松开前主管线已把原图渲染进该 url），
  // 避免出现"长按原图却显示加载动画"的死区。
  const url = showOriginal ? (originalPreview ?? finalPreviewUrl) : finalPreviewUrl;
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const crop = useEditorStore((s) => s.adjustments.crop ?? null);
  const orientationSteps = useEditorStore((s) => s.adjustments.orientationSteps ?? 0);
  const rotation = useEditorStore((s) => s.adjustments.rotation ?? 0);
  /* D-CP-02: 比例锁定来源。与移动构图面板 chip 语义一致：正数比例锁比例，
   * null/0（默认原比例在面板中显示为「自由」）不锁。 */
  const aspectRatio = useEditorStore((s) => s.adjustments.aspectRatio ?? null);
  /* D-CP-01: 沉浸式裁剪激活态（进入时复位缩放，保证手柄/网格可见） */
  const immersive = useImmersiveCropStore((s) => s.active);
  const { applyPatch } = useCrystalAdjust();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [divider, setDivider] = useState(0.5);
  const [gesturing, setGesturing] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [cropHintVisible, setCropHintVisible] = useState(false);
  /* v2.1.13 审计 F-网格：三分网格对齐图像实际显示区（contain 留白不画线） */
  const [imgRect, setImgRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const urlRef = useRef(url);
  urlRef.current = url;

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<GestureState>({
    mode: 'none',
    startT: IDENTITY,
    startPt: { x: 0, y: 0 },
    startDist: 0,
    startCrop: null,
    moved: false,
    resizeDir: null,
  });
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  /* C-2：对比视图独立缩放态（结构说明见下方手势实现处） */
  const [compareTransform, setCompareTransform] = useState<Transform>(IDENTITY);
  const compareTransformRef = useRef(compareTransform);
  compareTransformRef.current = compareTransform;
  const comparePointers = useRef(new Map<number, { x: number; y: number }>());
  const compareGesture = useRef<{
    mode: 'none' | 'pan' | 'pinch' | 'divider';
    startT: Transform;
    startPt: { x: number; y: number };
    startDist: number;
    moved: boolean;
  }>({ mode: 'none', startT: IDENTITY, startPt: { x: 0, y: 0 }, startDist: 0, moved: false });
  const compareLastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  /* 构图分类下展示三分网格；存在裁剪时展示拖动提示（首次拖动或超时后消失） */
  const cropActive = activeCategory === 'compose' && Boolean(crop);
  useEffect(() => {
    setShowGrid(activeCategory === 'compose');
  }, [activeCategory]);

  /* 网格对齐图像显示区：img 元素在 contain 下即实际显示矩形（缩放 >1 时网格无意义，跳过） */
  const measureImgRect = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container || !img.naturalWidth || transformRef.current.scale > 1.01) return;
    const ir = img.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    if (!ir.width || !ir.height) return;
    setImgRect({ left: ir.left - cr.left, top: ir.top - cr.top, width: ir.width, height: ir.height });
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureImgRect());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measureImgRect]);
  useEffect(() => {
    measureImgRect();
  }, [url, measureImgRect]);
  /* 缩放复位回 1x 后重测（放大期间网格隐藏） */
  useEffect(() => {
    if (showGrid && transform.scale <= 1.01) measureImgRect();
  }, [showGrid, transform.scale, measureImgRect]);
  useEffect(() => {
    if (!cropActive || compare) {
      setCropHintVisible(false);
      return;
    }
    setCropHintVisible(true);
    const timer = window.setTimeout(() => setCropHintVisible(false), CROP_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [cropActive, compare, selectedPath]);

  /* D-CP-02: 裁剪框屏幕矩形（1x 布局坐标、相对容器）。
   * 映射与 drawCropTo/moveCropBy 同源：裁剪坐标 = 定向坐标系源像素，
   * 显示区 = img contain 适配矩形（imgRect 已按 ≤1x 测量）。 */
  const cropFrameRect = useMemo(() => {
    if (!crop || !imgRect || compare) return null;
    const [W, H] = orientedSize(selectedImage?.width ?? 0, selectedImage?.height ?? 0, orientationSteps);
    const px = toPxCrop(crop, W, H);
    if (!px || !W || !H) return null;
    return {
      left: imgRect.left + (px.x / W) * imgRect.width,
      top: imgRect.top + (px.y / H) * imgRect.height,
      width: (px.width / W) * imgRect.width,
      height: (px.height / H) * imgRect.height,
    };
  }, [crop, imgRect, compare, selectedImage, orientationSteps]);

  /* 边界钳制：按 contain 适配尺寸计算可平移范围 */
  const clampPan = useCallback((next: Transform): Transform => {
    const rect = containerRef.current?.getBoundingClientRect();
    const img = imgRef.current;
    if (!rect || !img || !img.naturalWidth || next.scale <= 1) return next.scale <= 1 ? IDENTITY : next;
    const fit = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const maxX = Math.max(0, (img.naturalWidth * fit * next.scale - rect.width) / 2);
    const maxY = Math.max(0, (img.naturalHeight * fit * next.scale - rect.height) / 2);
    return { scale: next.scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
  }, []);

  /* 以屏幕点 p 为锚点缩放（保持 p 下内容不动） */
  const zoomAt = useCallback(
    (px: number, py: number, targetScale: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cur = transformRef.current;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const k = clamp(targetScale, MIN_SCALE, MAX_SCALE) / cur.scale;
      setTransform(
        clampPan({
          scale: clamp(targetScale, MIN_SCALE, MAX_SCALE),
          x: px - cx - k * (px - cx - cur.x),
          y: py - cy - k * (py - cy - cur.y),
        }),
      );
    },
    [clampPan],
  );

  const resetZoom = useCallback(() => setTransform(IDENTITY), []);

  /* 切图 / 切分类 / 进入对比 / 进入沉浸裁剪 → 复位缩放；进入对比 → 分割线回中 */
  useEffect(() => {
    setTransform(IDENTITY);
    // C-2：对比视图的独立缩放态同步复位
    setCompareTransform(IDENTITY);
    comparePointers.current.clear();
    compareGesture.current.mode = 'none';
  }, [compare, activeCategory, selectedPath, immersive]);
  useEffect(() => {
    if (compare) setDivider(0.5);
  }, [compare]);

  /* 滚轮/触控板缩放（桌面调试与精确检视用） */
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (compare || !urlRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cur = transformRef.current;
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE));
    },
    [zoomAt],
  );

  /* 裁剪窗口拖动：屏幕位移 → 定向坐标系源像素位移（内容跟随手指） */
  const moveCropBy = useCallback(
    (startCrop: Crop, dxScreen: number, dyScreen: number) => {
      const img = imgRef.current;
      const sel = useEditorStore.getState().selectedImage;
      if (!img || !sel?.width || !sel?.height || startCrop.width <= 0 || startCrop.height <= 0) return;
      const { width: W, height: H } = getOrientedDimensions(sel.width, sel.height, orientationSteps);
      const scaleX = startCrop.width / Math.max(1, img.clientWidth);
      const scaleY = startCrop.height / Math.max(1, img.clientHeight);
      const next = moveCropInsideBounds(
        startCrop,
        Math.round(-dxScreen * scaleX),
        Math.round(-dyScreen * scaleY),
        W,
        H,
        rotation,
      );
      applyPatch({ crop: next }, { enableTools: false });
      setCropHintVisible(false);
    },
    [applyPatch, orientationSteps, rotation],
  );

  /* 裁剪绘制（自由裁剪闭环）：构图分类下无裁剪时，单指拖拽直接画框。
   * 此前「自由」比例将 crop 置 null 后无任何起框手段（拖动落入 pan 且 1x 下
   * no-op），自由裁剪链路为死端；此处以屏幕两点映射定向坐标源像素矩形。 */
  const drawCropTo = useCallback(
    (clientX: number, clientY: number) => {
      const img = imgRef.current;
      const sel = useEditorStore.getState().selectedImage;
      if (!img || !sel?.width || !sel?.height) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const { width: W, height: H } = getOrientedDimensions(sel.width, sel.height, orientationSteps);
      const sx = W / rect.width;
      const sy = H / rect.height;
      const x0 = clamp((gesture.current.startPt.x - rect.left) * sx, 0, W);
      const y0 = clamp((gesture.current.startPt.y - rect.top) * sy, 0, H);
      const x1 = clamp((clientX - rect.left) * sx, 0, W);
      const y1 = clamp((clientY - rect.top) * sy, 0, H);
      /* 最小尺寸：24px 或 5% 取大，避免误触产生碎片裁剪 */
      const minW = Math.min(Math.max(24, W * 0.05), W);
      const minH = Math.min(Math.max(24, H * 0.05), H);
      const next = moveCropInsideBounds(
        {
          unit: 'px',
          x: Math.round(Math.min(x0, x1)),
          y: Math.round(Math.min(y0, y1)),
          width: Math.round(Math.max(Math.abs(x1 - x0), minW)),
          height: Math.round(Math.max(Math.abs(y1 - y0), minH)),
        },
        0,
        0,
        W,
        H,
        rotation,
      );
      applyPatch({ crop: next }, { enableTools: false });
    },
    [applyPatch, orientationSteps, rotation],
  );

  /* D-CP-02: 裁剪框手柄调整（八向）。屏幕指针 → 定向坐标源像素，锚点 =
   * 对角（角手柄）/ 对边中点（边手柄）；锁定比例时以拖动主导轴等比推导
   * 另一边，自由比例各轴独立。越界钳制：rotation=0 直接夹取；有拉直角时
   * 以 isCropWithinBounds 判定、等比向中心二分收缩（与 zoomCrop 同策略）。 */
  const resizeCropTo = useCallback(
    (startCrop: Crop, dir: CropHandleDir, clientX: number, clientY: number) => {
      const img = imgRef.current;
      const sel = useEditorStore.getState().selectedImage;
      if (!img || !sel?.width || !sel?.height) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const { width: W, height: H } = getOrientedDimensions(sel.width, sel.height, orientationSteps);
      const sx = W / rect.width;
      const sy = H / rect.height;
      const px = clamp((clientX - rect.left) * sx, 0, W);
      const py = clamp((clientY - rect.top) * sy, 0, H);
      const c = startCrop;
      const right = c.x + c.width;
      const bottom = c.y + c.height;
      const midX = c.x + c.width / 2;
      const midY = c.y + c.height / 2;
      const aspect = aspectRatio && aspectRatio > 0 ? aspectRatio : null;
      /* 最小尺寸：24px 或 5% 取大（与 drawCropTo 同阈值），避免收缩成碎片框 */
      const minW = Math.min(Math.max(24, W * 0.05), W);
      const minH = Math.min(Math.max(24, H * 0.05), H);
      const isCorner = dir.length === 2;
      let next: Crop;

      if (isCorner) {
        const ax = dir.includes('w') ? right : c.x;
        const ay = dir.includes('n') ? bottom : c.y;
        const dw = px - ax;
        const dh = py - ay;
        let w: number;
        let h: number;
        if (aspect) {
          /* 以对角为固定点、拖动主导轴定宽，等比推导高 */
          w = clamp(Math.max(Math.abs(dw), Math.abs(dh) * aspect, minW), minW, Math.min(W, H * aspect));
          h = w / aspect;
        } else {
          w = Math.max(Math.abs(dw), minW);
          h = Math.max(Math.abs(dh), minH);
        }
        next = { unit: 'px', x: dw >= 0 ? ax : ax - w, y: dh >= 0 ? ay : ay - h, width: w, height: h };
      } else if (dir === 'w' || dir === 'e') {
        const ax = dir === 'w' ? right : c.x;
        let w = Math.max(Math.abs(px - ax), minW);
        w = aspect ? clamp(w, minW, Math.min(W, H * aspect)) : Math.min(w, W);
        const h = aspect ? w / aspect : c.height;
        next = {
          unit: 'px',
          x: dir === 'e' ? ax : ax - w,
          y: aspect ? midY - h / 2 : c.y,
          width: w,
          height: h,
        };
      } else {
        const ay = dir === 'n' ? bottom : c.y;
        let h = Math.max(Math.abs(py - ay), minH);
        h = aspect ? clamp(h, minH, Math.min(H, W / aspect)) : Math.min(h, H);
        const w = aspect ? h * aspect : c.width;
        next = {
          unit: 'px',
          x: aspect ? midX - w / 2 : c.x,
          y: dir === 's' ? ay : ay - h,
          width: w,
          height: h,
        };
      }

      let final = next;
      if (rotation === 0) {
        final = {
          unit: 'px',
          x: clamp(next.x, 0, Math.max(0, W - next.width)),
          y: clamp(next.y, 0, Math.max(0, H - next.height)),
          width: Math.min(next.width, W),
          height: Math.min(next.height, H),
        };
      } else if (!isCropWithinBounds(next, W, H, rotation)) {
        /* 拉直角下直接夹取不合法：以矩形中心等比收缩至四角回到图内 */
        const cx = next.x + next.width / 2;
        const cy = next.y + next.height / 2;
        let lo = 0;
        let hi = 1;
        let best: Crop | null = null;
        for (let i = 0; i < 14; i++) {
          const t = (lo + hi) / 2;
          const w = next.width * t;
          const h = next.height * t;
          const test: Crop = { unit: 'px', x: cx - w / 2, y: cy - h / 2, width: w, height: h };
          if (w >= minW && h >= minH && isCropWithinBounds(test, W, H, rotation)) {
            best = test;
            lo = t;
          } else {
            hi = t;
          }
        }
        final =
          best ??
          {
            unit: 'px',
            x: clamp(next.x, 0, Math.max(0, W - next.width)),
            y: clamp(next.y, 0, Math.max(0, H - next.height)),
            width: next.width,
            height: next.height,
          };
      }

      const rounded: Crop = {
        unit: 'px',
        x: Math.round(final.x),
        y: Math.round(final.y),
        width: Math.round(final.width),
        height: Math.round(final.height),
      };
      rounded.x = clamp(rounded.x, 0, Math.max(0, W - rounded.width));
      rounded.y = clamp(rounded.y, 0, Math.max(0, H - rounded.height));
      applyPatch({ crop: rounded }, { enableTools: false });
    },
    [applyPatch, aspectRatio, orientationSteps, rotation],
  );

  /* D-CP-02: 手柄按下 → cropResize 模式。stopPropagation 阻断容器
   * pan/crop/cropDraw 判定；指针捕获到容器，后续 move/up 走容器统一处理，
   * 保证同一时间仅一个手势模式（与 pinch/pan/单指平移互斥）。 */
  const onHandlePointerDown = useCallback(
    (dir: CropHandleDir) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (compareRef.current || !urlRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      containerRef.current?.setPointerCapture(e.pointerId);
      const g = gesture.current;
      g.mode = 'cropResize';
      g.resizeDir = dir;
      g.startPt = { x: e.clientX, y: e.clientY };
      g.startT = transformRef.current;
      g.startCrop = toPxCrop(
        crop,
        ...orientedSize(selectedImage?.width ?? 0, selectedImage?.height ?? 0, orientationSteps),
      );
      g.moved = false;
      setGesturing(true);
      haptic(5);
    },
    [crop, orientationSteps, selectedImage],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (compareRef.current || !urlRef.current) return;
      if ((e.target as HTMLElement).closest('button')) return;
      const g = gesture.current;
      if (g.mode === 'cropResize') {
        // P-4（v2.1.22 审计）：手柄调整进行中，新触点不入 pointer 表、不做捕获。
        // 其后续 move/up 因不在表中直接被忽略——旧实现「仅记录点位供 up 清理」
        // 会把第二根手指也驱动 resizeCropTo（裁剪框跳变），并在部分抬指顺序下
        // 让手势态滞留在 cropResize。
        return;
      }
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.currentTarget.setPointerCapture(e.pointerId);
      if (pointers.current.size === 1) {
        const atOneX = transformRef.current.scale <= 1;
        const canCropDrag = activeCategory === 'compose' && atOneX && Boolean(crop);
        const canCropDraw = activeCategory === 'compose' && atOneX && !crop;
        g.mode = canCropDrag ? 'crop' : canCropDraw ? 'cropDraw' : 'pan';
        g.startPt = { x: e.clientX, y: e.clientY };
        g.startT = transformRef.current;
        g.startCrop = canCropDrag
          ? toPxCrop(crop, ...orientedSize(selectedImage?.width ?? 0, selectedImage?.height ?? 0, orientationSteps))
          : null;
        g.moved = false;
        setGesturing(true);
      } else if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        g.mode = 'pinch';
        g.startT = transformRef.current;
        g.startDist = Math.max(dist(a, b), 1);
        g.moved = true;
        setGesturing(true);
      }
    },
    [activeCategory, crop, selectedImage],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      const cur = transformRef.current;
      if (g.mode === 'crop' && pointers.current.size === 1 && g.startCrop) {
        const dx = e.clientX - g.startPt.x;
        const dy = e.clientY - g.startPt.y;
        if (Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
        moveCropBy(g.startCrop, dx, dy);
      } else if (g.mode === 'cropResize' && g.startCrop && g.resizeDir) {
        /* D-CP-02: 手柄八向调整（单指，与其他手势互斥） */
        resizeCropTo(g.startCrop, g.resizeDir, e.clientX, e.clientY);
      } else if (g.mode === 'cropDraw' && pointers.current.size === 1) {
        /* 自由裁剪绘制：超过点击阈值才开始画框，保留双击缩放语义 */
        if (Math.hypot(e.clientX - g.startPt.x, e.clientY - g.startPt.y) > TAP_SLOP) g.moved = true;
        if (!g.moved) return;
        drawCropTo(e.clientX, e.clientY);
      } else if (g.mode === 'pan' && pointers.current.size === 1) {
        if (cur.scale <= 1) return;
        const dx = e.clientX - g.startPt.x;
        const dy = e.clientY - g.startPt.y;
        if (Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
        setTransform(clampPan({ scale: cur.scale, x: g.startT.x + dx, y: g.startT.y + dy }));
      } else if (g.mode === 'pinch' && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const d = Math.max(dist(a, b), 1);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = clamp((g.startT.scale * d) / g.startDist, MIN_SCALE, MAX_SCALE);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const k = scale / g.startT.scale;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const midRel = { x: mid.x - rect.left, y: mid.y - rect.top };
        setTransform(
          clampPan({
            scale,
            x: midRel.x - cx - k * (midRel.x - cx - g.startT.x),
            y: midRel.y - cy - k * (midRel.y - cy - g.startT.y),
          }),
        );
      }
    },
    [clampPan, moveCropBy, drawCropTo, resizeCropTo],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      // 静止点击即视为 tap（含缩放状态；cropDraw 未动也算 tap），双击可在 1x ↔ 2x 间切换
      const wasSingleTap = (g.mode === 'pan' || g.mode === 'cropDraw') && !g.moved;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 1 && g.mode === 'pinch') {
        // 双指收单指：以剩余指为基准重置平移起点，禁止随后触发双击
        const [p] = [...pointers.current.values()];
        g.mode = 'pan';
        g.startPt = p;
        g.startT = transformRef.current;
        g.moved = true;
        return;
      }
      if (pointers.current.size === 0) {
        g.mode = 'none';
        g.resizeDir = null;
        g.startCrop = null;
        setGesturing(false);
        if (wasSingleTap) {
          const now = performance.now();
          const prev = lastTap.current;
          if (prev && now - prev.t < DOUBLE_TAP_MS && dist(prev, { x: e.clientX, y: e.clientY }) < TAP_SLOP * 2) {
            lastTap.current = null;
            haptic(8);
            if (transformRef.current.scale > 1.01) {
              resetZoom();
            } else {
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) zoomAt(e.clientX - rect.left, e.clientY - rect.top, ZOOM_STEP);
            }
          } else {
            lastTap.current = { t: now, x: e.clientX, y: e.clientY };
          }
        }
      }
    },
    [resetZoom, zoomAt],
  );

  /* P-2（v2.1.22 审计）：pointercancel 独立处理。
   * 取消由浏览器/系统接管（滚动仲裁、来电、手势冲突）触发，复用 onPointerUp
   * 会把「未移动的取消」误记为 tap，随后一次真实点击即被拼成伪双击缩放。
   * 这里只做指针表清理与手势态收敛，不做任何 tap 判定。 */
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 1 && g.mode === 'pinch') {
      // 双指收单指：以剩余指为基准重置平移起点
      const [p] = [...pointers.current.values()];
      g.mode = 'pan';
      g.startPt = p;
      g.startT = transformRef.current;
      g.moved = true;
      return;
    }
    if (pointers.current.size === 0) {
      g.mode = 'none';
      g.resizeDir = null;
      g.startCrop = null;
      setGesturing(false);
    }
  }, []);

  /* ---------------------------------------------------------------------------
   * C-2（v2.1.22 审计）：对比视图缩放/平移。
   * 结构关键：分割线 clip-path 定义在「未变换」的裁剪容器（cx-compare-clip，
   * 图层坐标系）上，两张图共享同一个 cx-compare-zoom 变换——任意缩放/平移下，
   * 分割边缘始终精确贴住分割线手柄。手势：1x 单指拖分割线（与旧行为一致）、
   * 放大后单指平移画面、双指捏合缩放、双击 1x↔2x、滚轮精确缩放。
   * ------------------------------------------------------------------------- */
  const compareZoomAt = useCallback(
    (px: number, py: number, targetScale: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cur = compareTransformRef.current;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const k = clamp(targetScale, MIN_SCALE, MAX_SCALE) / cur.scale;
      setCompareTransform(
        clampPan({
          scale: clamp(targetScale, MIN_SCALE, MAX_SCALE),
          x: px - cx - k * (px - cx - cur.x),
          y: py - cy - k * (py - cy - cur.y),
        }),
      );
    },
    [clampPan],
  );

  const onComparePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    comparePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = compareGesture.current;
    if (comparePointers.current.size === 1) {
      g.mode = compareTransformRef.current.scale > 1.01 ? 'pan' : 'divider';
      g.startPt = { x: e.clientX, y: e.clientY };
      g.startT = compareTransformRef.current;
      g.moved = false;
    } else if (comparePointers.current.size === 2) {
      const [a, b] = [...comparePointers.current.values()];
      g.mode = 'pinch';
      g.startT = compareTransformRef.current;
      g.startDist = Math.max(dist(a, b), 1);
      g.moved = true;
    }
  }, []);

  const onComparePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!comparePointers.current.has(e.pointerId)) return;
      comparePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = compareGesture.current;
      const cur = compareTransformRef.current;
      if (g.mode === 'divider' && comparePointers.current.size === 1) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) setDivider(clamp((e.clientX - rect.left) / rect.width, 0.02, 0.98));
      } else if (g.mode === 'pan' && comparePointers.current.size === 1) {
        if (cur.scale <= 1) return;
        const dx = e.clientX - g.startPt.x;
        const dy = e.clientY - g.startPt.y;
        if (Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
        setCompareTransform(clampPan({ scale: cur.scale, x: g.startT.x + dx, y: g.startT.y + dy }));
      } else if (g.mode === 'pinch' && comparePointers.current.size >= 2) {
        const [a, b] = [...comparePointers.current.values()];
        const d = Math.max(dist(a, b), 1);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = clamp((g.startT.scale * d) / g.startDist, MIN_SCALE, MAX_SCALE);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const k = scale / g.startT.scale;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const midRel = { x: mid.x - rect.left, y: mid.y - rect.top };
        setCompareTransform(
          clampPan({
            scale,
            x: midRel.x - cx - k * (midRel.x - cx - g.startT.x),
            y: midRel.y - cy - k * (midRel.y - cy - g.startT.y),
          }),
        );
      }
    },
    [clampPan],
  );

  const onComparePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = compareGesture.current;
      const wasTap = (g.mode === 'pan' || g.mode === 'divider') && !g.moved;
      comparePointers.current.delete(e.pointerId);
      if (comparePointers.current.size === 1 && g.mode === 'pinch') {
        const [p] = [...comparePointers.current.values()];
        g.mode = 'pan';
        g.startPt = p;
        g.startT = compareTransformRef.current;
        g.moved = true;
        return;
      }
      if (comparePointers.current.size === 0) {
        g.mode = 'none';
        if (wasTap) {
          const now = performance.now();
          const prev = compareLastTap.current;
          if (prev && now - prev.t < DOUBLE_TAP_MS && dist(prev, { x: e.clientX, y: e.clientY }) < TAP_SLOP * 2) {
            compareLastTap.current = null;
            haptic(8);
            if (compareTransformRef.current.scale > 1.01) {
              setCompareTransform(IDENTITY);
            } else {
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) compareZoomAt(e.clientX - rect.left, e.clientY - rect.top, ZOOM_STEP);
            }
          } else {
            compareLastTap.current = { t: now, x: e.clientX, y: e.clientY };
          }
        }
      }
    },
    [compareZoomAt],
  );

  const onCompareWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cur = compareTransformRef.current;
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      compareZoomAt(e.clientX - rect.left, e.clientY - rect.top, clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE));
    },
    [compareZoomAt],
  );

  return (
    <div
      className="cx-preview"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="cx-preview-stage"
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transition: gesturing ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        {url ? (
          <img
            ref={imgRef}
            className="cx-preview-img"
            src={url}
            alt={t('crystal.previewAlt')}
            draggable={false}
            onLoad={measureImgRect}
          />
        ) : (
          <div className="cx-preview-empty">
            <Loader2 size={18} className="animate-spin" />
            {/* 审计 P-反馈：冷启动首帧未渲染时仅 spinner 无文案，补「加载中」区分「渲染中」 */}
            <span>{t(hasRenderedFirstFrame ? 'crystal.previewRendering' : 'crystal.previewLoading')}</span>
          </div>
        )}
      </div>

      {/* 构图三分网格（对齐图像实际显示区，取景辅助；放大时隐藏） */}
      {showGrid && !compare && url && transform.scale <= 1.01 && (
        <div
          className="cx-preview-grid"
          aria-hidden
          style={
            imgRect
              ? {
                  left: imgRect.left,
                  top: imgRect.top,
                  width: imgRect.width,
                  height: imgRect.height,
                  right: 'auto',
                  bottom: 'auto',
                }
              : undefined
          }
        >
          <span className="cx-grid-line cx-grid-v" style={{ left: '33.333%' }} />
          <span className="cx-grid-line cx-grid-v" style={{ left: '66.666%' }} />
          <span className="cx-grid-line cx-grid-h" style={{ top: '33.333%' }} />
          <span className="cx-grid-line cx-grid-h" style={{ top: '66.666%' }} />
        </div>
      )}

      {transform.scale > 1.01 && !compare && (
        <button
          className="cx-zoom-chip"
          onClick={() => {
            haptic(6);
            resetZoom();
          }}
          aria-label={t('crystal.previewResetZoom')}
        >
          <RotateCcw size={11} />
          {transform.scale.toFixed(1)}×
        </button>
      )}

      {/* D-CP-02: 裁剪框 + 4角/4边手柄（仅构图分类 1x 态显示；框外压暗，手柄 ≥44px 命中） */}
      {cropFrameRect && activeCategory === 'compose' && !compare && transform.scale <= 1.01 && (
        <div className="cx-crop-overlay">
          <div
            className="cx-crop-frame"
            style={{
              left: cropFrameRect.left,
              top: cropFrameRect.top,
              width: cropFrameRect.width,
              height: cropFrameRect.height,
            }}
          >
            {CORNER_DIRS.map((dir) => (
              <div
                key={dir}
                className={`cx-crop-handle cx-crop-corner cx-crop-${dir}`}
                onPointerDown={onHandlePointerDown(dir)}
              />
            ))}
            {EDGE_DIRS.map((dir) => (
              <div
                key={dir}
                className={`cx-crop-handle cx-crop-edge cx-crop-${dir}`}
                onPointerDown={onHandlePointerDown(dir)}
              />
            ))}
          </div>
        </div>
      )}

      {/* D-CP-03: 手势状态胶囊——消除 1x 下裁剪/缩放互斥的隐式条件（左上角，fade 150ms）。
          三个 gestureState key 待主控统一补入 en.json 词条，先按仓库惯例 as ParseKeys。 */}
      {activeCategory === 'compose' && !compare && url && (
        <div className="cx-gesture-capsule" role="status">
          {transform.scale > 1.01
            ? t('crystal.compose.gestureState.pinch' as ParseKeys)
            : crop
              ? t('crystal.compose.gestureState.moveResize' as ParseKeys)
              : t('crystal.compose.gestureState.draw' as ParseKeys)}
        </div>
      )}

      {/* 审计 UX-3/FD-3: 「原图｜对比」浮层已移除（与底栏重复且遮挡画面），
          原图长按与分屏对比统一收敛到底栏。 */}

      {/* 构图模式：拖动画面移动裁剪窗口的发现性提示 */}
      {cropHintVisible && !compare && (
        <div className="cx-crop-hint" role="status">
          <Move size={11} />
          {t('crystal.compose.cropHint')}
        </div>
      )}

      {/* P2 前后对比：原图 | 效果 分割滑杆；C-2 缩放结构见 onComparePointerDown 注释 */}
      {compare && url && originalPreview && (
        <div
          className="cx-compare-layer"
          onPointerDown={onComparePointerDown}
          onPointerMove={onComparePointerMove}
          onPointerUp={onComparePointerUp}
          onPointerCancel={onComparePointerUp}
          onWheel={onCompareWheel}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* 效果图：跟随 compareTransform */}
          <div
            className="cx-compare-zoom"
            style={{
              transform: `translate3d(${compareTransform.x}px, ${compareTransform.y}px, 0) scale(${compareTransform.scale})`,
              transition: gesturing ? 'none' : 'transform 0.2s ease-out',
            }}
          >
            <img className="cx-compare-img" src={url} alt={t('crystal.previewAlt')} draggable={false} />
          </div>
          {/* 原图：clip 定义在未变换的裁剪容器上（分割边缘恒贴分割线），内容再随同一变换 */}
          <div className="cx-compare-clip" style={{ clipPath: `inset(0 ${(1 - divider) * 100}% 0 0)` }}>
            <div
              className="cx-compare-zoom"
              style={{
                transform: `translate3d(${compareTransform.x}px, ${compareTransform.y}px, 0) scale(${compareTransform.scale})`,
                transition: gesturing ? 'none' : 'transform 0.2s ease-out',
              }}
            >
              <img
                className="cx-compare-img cx-compare-origin"
                src={originalPreview}
                alt={t('crystal.originalBadge')}
                draggable={false}
              />
            </div>
          </div>
          <div className="cx-compare-divider" style={{ left: `${divider * 100}%` }}>
            <div className="cx-compare-handle">
              <ChevronsLeftRight size={16} />
            </div>
          </div>
          <span className="cx-compare-tag cx-compare-tag-l">{t('crystal.bottom.original')}</span>
          <span className="cx-compare-tag cx-compare-tag-r">{t('crystal.previewEdited')}</span>
          <button
            className="cx-compare-close"
            onClick={() => {
              haptic(6);
              onCompareChange(false);
            }}
            aria-label={t('crystal.previewCloseCompare')}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* C-3（v2.1.22 审计）：进入对比但原图预览尚未渲染时给出明确加载反馈，
          而不是整层静默不渲染（用户只会看到"点了没反应"）。 */}
      {compare && url && !originalPreview && (
        <div className="cx-compare-loading" role="status">
          <Loader2 size={18} className="animate-spin" />
          <span>{t('crystal.previewRendering')}</span>
        </div>
      )}

      {showOriginal && !compare && <div className="cx-preview-corner">{t('crystal.originalBadge')}</div>}
    </div>
  );
}
