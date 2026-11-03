import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Crop } from 'react-image-crop';
import { ChevronsLeftRight, Loader2, Move, RotateCcw, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../store/useEditorStore';
import { getOrientedDimensions, moveCropInsideBounds } from '../../utils/cropUtils';
import { useCrystalAdjust, haptic } from './crystalShared';

/* ---------------------------------------------------------------------------
 * P2 预览区升级：双指缩放 + 平移 + 双击缩放 + 前后对比分割滑杆。
 * 手势基于 Pointer Events（WebView 触摸/鼠标统一），坐标锚定变换中心，
 * 平移按 contain 适配尺寸钳制边界，切图/切分类/进对比自动复位。
 * v2.1.13：构图模式下支持单指拖动平移裁剪窗口（moveCropInsideBounds 边界钳制），
 * 预览叠加三分构图网格；修复对比滑杆悬空跟随、缩放过渡不复位等问题。
 * ------------------------------------------------------------------------- */

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 14;
const ZOOM_STEP = 2;
const CROP_HINT_MS = 6000;

interface Transform {
  scale: number;
  x: number;
  y: number;
}
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

interface GestureState {
  mode: 'none' | 'pan' | 'pinch' | 'crop';
  startT: Transform;
  startPt: { x: number; y: number };
  startDist: number;
  startCrop: Crop | null;
  moved: boolean;
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
  const url = showOriginal ? (originalPreview ?? null) : finalPreviewUrl;
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const crop = useEditorStore((s) => s.adjustments.crop ?? null);
  const orientationSteps = useEditorStore((s) => s.adjustments.orientationSteps ?? 0);
  const rotation = useEditorStore((s) => s.adjustments.rotation ?? 0);
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
  });
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const dividerDragging = useRef(false);

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

  /* 切图 / 切分类 / 进入对比 → 复位缩放；进入对比 → 分割线回中 */
  useEffect(() => {
    setTransform(IDENTITY);
  }, [compare, activeCategory, selectedPath]);
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (compareRef.current || !urlRef.current) return;
      if ((e.target as HTMLElement).closest('button')) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.currentTarget.setPointerCapture(e.pointerId);
      const g = gesture.current;
      if (pointers.current.size === 1) {
        const canCropDrag = activeCategory === 'compose' && transformRef.current.scale <= 1 && Boolean(crop);
        g.mode = canCropDrag ? 'crop' : 'pan';
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
    [clampPan, moveCropBy],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      // 静止点击即视为 tap（含缩放状态），双击可在 1x ↔ 2x 间切换
      const wasSingleTap = g.mode === 'pan' && !g.moved;
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

  /* 对比分割滑杆：仅按住拖动时跟随（修复悬空移动跟手 bug） */
  const dragDivider = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointerdown') {
      // 关闭按钮等交互元素不参与滑杆拖动，避免 pointer capture 吞掉 click
      if ((e.target as HTMLElement).closest('button')) return;
      dividerDragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (!dividerDragging.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDivider(clamp((e.clientX - rect.left) / rect.width, 0.02, 0.98));
  }, []);
  const endDividerDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dividerDragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      className="cx-preview"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
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
          <>
            {/* 审计 FD-9：首帧渲染前以原图模糊放大占位，避免纯黑/空白闪烁 */}
            {originalPreview && (
              <img
                src={originalPreview}
                alt=""
                aria-hidden
                draggable={false}
                className="cx-preview-skeleton"
              />
            )}
            <div className="cx-preview-empty">
              <Loader2 size={18} className="animate-spin" />
              {/* 审计 P-反馈：冷启动首帧未渲染时仅 spinner 无文案，补「加载中」区分「渲染中」 */}
              <span>{t(hasRenderedFirstFrame ? 'crystal.previewRendering' : 'crystal.previewLoading')}</span>
            </div>
          </>
        )}
      </div>

      {/* 构图三分网格（对齐图像实际显示区，取景辅助；放大时隐藏） */}
      {showGrid && !compare && url && transform.scale <= 1.01 && (
        <div
          className="cx-preview-grid"
          aria-hidden
          style={
            imgRect
              ? { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height, right: 'auto', bottom: 'auto' }
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

      {/* 审计 UX-3/FD-3: 「原图｜对比」浮层已移除（与底栏重复且遮挡画面），
          原图长按与分屏对比统一收敛到底栏。 */}

      {/* 构图模式：拖动画面移动裁剪窗口的发现性提示 */}
      {cropHintVisible && !compare && (
        <div className="cx-crop-hint" role="status">
          <Move size={11} />
          {t('crystal.compose.cropHint')}
        </div>
      )}

      {/* P2 前后对比：原图 | 效果 分割滑杆，整层拖动 */}
      {compare && url && originalPreview && (
        <div
          className="cx-compare-layer"
          onPointerDown={dragDivider}
          onPointerMove={dragDivider}
          onPointerUp={endDividerDrag}
          onPointerCancel={endDividerDrag}
        >
          <img className="cx-compare-img" src={url} alt={t('crystal.previewAlt')} draggable={false} />
          <img
            className="cx-compare-img cx-compare-origin"
            src={originalPreview}
            alt={t('crystal.originalBadge')}
            draggable={false}
            style={{ clipPath: `inset(0 ${(1 - divider) * 100}% 0 0)` }}
          />
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

      {showOriginal && !compare && <div className="cx-preview-corner">{t('crystal.originalBadge')}</div>}
    </div>
  );
}
