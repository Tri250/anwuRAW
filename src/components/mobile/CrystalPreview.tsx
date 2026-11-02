import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsLeftRight, Loader2, RotateCcw, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../store/useEditorStore';
import { useShowOriginalHold } from './crystalShared';

/* ---------------------------------------------------------------------------
 * P2 预览区升级：双指缩放 + 平移 + 双击缩放 + 前后对比分割滑杆。
 * 手势基于 Pointer Events（WebView 触摸/鼠标统一），坐标锚定变换中心，
 * 平移按 contain 适配尺寸钳制边界，切图/切分类/进对比自动复位。
 * ------------------------------------------------------------------------- */

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 14;
const ZOOM_STEP = 2;

interface Transform {
  scale: number;
  x: number;
  y: number;
}
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

interface GestureState {
  mode: 'none' | 'pan' | 'pinch';
  startT: Transform;
  startPt: { x: number; y: number };
  startDist: number;
  moved: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

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
      originalPreview: s.originalPreview,
      showOriginal: s.showOriginal,
      hasRenderedFirstFrame: s.hasRenderedFirstFrame,
    })),
  );
  const url = showOriginal ? (originalPreview?.url ?? null) : finalPreviewUrl;
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [divider, setDivider] = useState(0.5);
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
    moved: false,
  });
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

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

  /* 切图 / 切分类 / 进入对比 → 复位缩放 */
  useEffect(() => {
    setTransform(IDENTITY);
  }, [compare, activeCategory, selectedPath]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (compareRef.current || !urlRef.current) return;
    if ((e.target as HTMLElement).closest('button')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.mode = 'pan';
      g.startPt = { x: e.clientX, y: e.clientY };
      g.startT = transformRef.current;
      g.moved = false;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.mode = 'pinch';
      g.startT = transformRef.current;
      g.startDist = Math.max(dist(a, b), 1);
      g.moved = true;
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      const cur = transformRef.current;
      if (g.mode === 'pan' && pointers.current.size === 1) {
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
    [clampPan],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      const wasSingleTap = g.mode === 'pan' && !g.moved && transformRef.current.scale <= 1;
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
        if (wasSingleTap) {
          const now = performance.now();
          const prev = lastTap.current;
          if (prev && now - prev.t < DOUBLE_TAP_MS && dist(prev, { x: e.clientX, y: e.clientY }) < TAP_SLOP * 2) {
            lastTap.current = null;
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

  /* 对比分割滑杆：整层可拖动 */
  const dragDivider = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const update = (clientX: number) => setDivider(clamp((clientX - rect.left) / rect.width, 0.02, 0.98));
    update(e.clientX);
  }, []);

  const originalHold = useShowOriginalHold(0);
  const compareAvailable = Boolean(originalPreview?.url);

  return (
    <div
      className="cx-preview"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="cx-preview-stage"
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transition: gesture.current.mode === 'none' ? 'transform 0.2s ease-out' : 'none',
        }}
      >
        {url ? (
          <img ref={imgRef} className="cx-preview-img" src={url} alt={t('crystal.previewAlt')} draggable={false} />
        ) : (
          <div className="cx-preview-empty">
            <Loader2 size={18} className="animate-spin" />
            {hasRenderedFirstFrame && <span>{t('crystal.previewRendering')}</span>}
          </div>
        )}
      </div>

      {transform.scale > 1.01 && !compare && (
        <button className="cx-zoom-chip" onClick={resetZoom} aria-label={t('crystal.previewResetZoom')}>
          <RotateCcw size={11} />
          {transform.scale.toFixed(1)}×
        </button>
      )}

      {/* G11 原图按住快捷键（对比模式交由分割滑杆接管） */}
      {!compare && (
        <div className="cx-float-pills">
          <button className="cx-float-pill" {...originalHold}>
            {t('crystal.bottom.original')}
          </button>
          <button
            className="cx-float-pill"
            onClick={() => compareAvailable && onCompareChange(true)}
            disabled={!compareAvailable}
          >
            {t('crystal.bottom.compare')}
          </button>
        </div>
      )}

      {/* P2 前后对比：原图 | 效果 分割滑杆，整层拖动 */}
      {compare && url && originalPreview?.url && (
        <div className="cx-compare-layer" onPointerDown={dragDivider} onPointerMove={dragDivider}>
          <img className="cx-compare-img" src={url} alt={t('crystal.previewAlt')} draggable={false} />
          <img
            className="cx-compare-img cx-compare-origin"
            src={originalPreview.url}
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
            onClick={() => onCompareChange(false)}
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
