import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ZoomIn, ZoomOut, Move, X, Columns2, SlidersHorizontal } from 'lucide-react';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';

interface BeforeAfterCompareProps {
  beforeUrl: string | null;
  afterUrl: string | null;
  onClose(): void;
}

/**
 * Before / After 滑块拆分对比浮层。
 * 纯前端实现：After 与 Before 两张图像在同一容器内用 clip-path 剪切，
 * 拖动中缝滑块切换可见区域，支持缩放/平移以查看细节。
 * 数据源：After = 后端以当前调整渲染的预览(finalPreviewUrl)；
 *         Before = 后端以空调整渲染的原始预览(generate_preview_for_path)。
 */
export default function BeforeAfterCompare({ beforeUrl, afterUrl, onClose }: BeforeAfterCompareProps) {
  const { t } = useTranslation();
  const [sliderPosition, setSliderPosition] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [splitHorizontal, setSplitHorizontal] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (!isPanning && !isResizing) return;

    const handleMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (isResizing) {
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const px = (x / rect.width) * 100;
        const py = (y / rect.height) * 100;
        setSliderPosition(splitHorizontal ? py : px);
      } else if (isPanning) {
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        lastMousePos.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleUp = () => {
      setIsPanning(false);
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isPanning, isResizing, splitHorizontal]);

  const handlePanStart = (e: React.MouseEvent) => {
    if (isResizing) return;
    e.preventDefault();
    setIsPanning(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleDividerDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsResizing(true);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = rect.width / rect.height;
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;
    const delta = -e.deltaY * 0.001;
    const newZoom = Math.min(Math.max(0.5, zoom + delta), 4);
    const scaleRatio = newZoom / zoom;
    const newPanX = mouseX - (mouseX - pan.x) * scaleRatio;
    const newPanY = mouseY - (mouseY - pan.y) * scaleRatio;
    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
    void ratio;
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSliderPosition(50);
  };

  const imageStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transition: isPanning || isResizing ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
  };

  const clip = splitHorizontal
    ? { clipPath: `inset(${100 - sliderPosition}% 0 0 0)` }
    : { clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` };

  const dividerStyle = splitHorizontal
    ? { top: `${sliderPosition}%`, left: 0, right: 0, height: 2, width: '100%', cursor: 'row-resize' }
    : { left: `${sliderPosition}%`, top: 0, bottom: 0, width: 2, cursor: 'col-resize' };

  const canCompare = !!(beforeUrl && afterUrl);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="absolute inset-0 z-[95] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4 py-4"
    >
      <div className="w-full h-full max-w-6xl flex flex-col">
        {/* 顶部信息栏 */}
        <div className="flex items-center justify-between mb-2">
          <Text variant={TextVariants.heading} className="text-text-primary">
            {t('editor.compare.title')}
          </Text>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSplitHorizontal((v) => !v)}
              data-tooltip={t('editor.compare.toggleSplit')}
              className="p-2 rounded-lg bg-surface text-text-primary hover:bg-card-active transition-colors"
            >
              {splitHorizontal ? <Columns2 size={16} /> : <SlidersHorizontal size={16} />}
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.5))}
              data-tooltip={t('editor.compare.zoomOut')}
              className="p-2 rounded-lg bg-surface text-text-primary hover:bg-card-active transition-colors"
            >
              <ZoomOut size={16} />
            </button>
            <button
              onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
              data-tooltip={t('editor.compare.zoomIn')}
              className="p-2 rounded-lg bg-surface text-text-primary hover:bg-card-active transition-colors"
            >
              <ZoomIn size={16} />
            </button>
            <button
              onClick={resetView}
              className="px-2.5 py-2 rounded-lg bg-surface text-text-secondary hover:text-text-primary hover:bg-card-active transition-colors"
            >
              {t('editor.compare.reset')}
            </button>
            <button
              onClick={onClose}
              data-tooltip={t('editor.compare.close')}
              className="p-2 rounded-lg bg-surface text-text-primary hover:bg-card-active transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 对比图像区 */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden rounded-xl border border-border-color bg-black cursor-grab active:cursor-grabbing select-none"
          onMouseDown={handlePanStart}
          onWheel={handleWheel}
        >
          {canCompare ? (
            <>
              {/* After 层（底层）：w-full/h-full + object-contain 先适应容器，再通过 transform 缩放/平移 */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="w-full h-full origin-center" style={imageStyle}>
                  <img
                    src={afterUrl}
                    alt="After"
                    draggable={false}
                    className="w-full h-full object-contain select-none"
                  />
                </div>
              </div>

              {/* Before 层（上层，被 clip 裁剪） */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none" style={clip}>
                <div className="w-full h-full origin-center" style={imageStyle}>
                  <img
                    src={beforeUrl}
                    alt="Before"
                    draggable={false}
                    className="w-full h-full object-contain select-none"
                  />
                </div>
              </div>

              {/* 中缝分隔线 */}
              <div
                className="absolute bg-white z-10 shadow-[0_0_8px_rgba(0,0,0,0.8)]"
                style={dividerStyle}
                onMouseDown={handleDividerDown}
              >
                <div
                  className={`absolute bg-white rounded-full shadow-lg flex items-center justify-center gap-1 ${
                    splitHorizontal
                      ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2 py-2'
                      : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8'
                  }`}
                >
                  {splitHorizontal ? (
                    <div className="w-px h-3 bg-black/40 rounded-full mx-0.5" />
                  ) : (
                    <>
                      <div className="w-0.5 h-3 bg-black/40 rounded-full" />
                      <div className="w-0.5 h-3 bg-black/40 rounded-full" />
                    </>
                  )}
                </div>
              </div>

              {/* 标签 */}
              <Text
                as="div"
                variant={TextVariants.small}
                color={TextColors.white}
                weight={TextWeights.medium}
                className="absolute top-3 left-3 bg-black/60 backdrop-blur-xs px-2.5 py-1 rounded-md pointer-events-none z-0"
              >
                {t('editor.compare.before')}
              </Text>
              <Text
                as="div"
                variant={TextVariants.small}
                color={TextColors.white}
                weight={TextWeights.medium}
                className="absolute top-3 right-3 bg-accent/90 px-2.5 py-1 rounded-md pointer-events-none z-0"
              >
                {t('editor.compare.after')}
              </Text>

              {/* 底部提示 */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none z-0 flex items-center gap-2 px-3 py-1 bg-black/50 rounded-full">
                <Move size={12} className="text-text-secondary" />
                <Text as="span" variant={TextVariants.small} color={TextColors.secondary}>
                  {t('editor.compare.dragHint')}
                </Text>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <Text variant={TextVariants.body} color={TextColors.secondary}>
                {t('editor.compare.loading')}
              </Text>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
