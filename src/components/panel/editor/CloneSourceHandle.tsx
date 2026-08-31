import { useRef } from 'react';

interface CloneSourceHandleProps {
  sx: number;
  sy: number;
  imageScale: number;
  imageWidth: number;
  imageHeight: number;
  onMove: (sx: number, sy: number) => void;
  onCommit: () => void;
}

/**
 * Clone/Heal 仿制源点十字标。可拖动：原生 Pointer Capture 实现，拖动增量 / imageScale
 * 换算回图像坐标并实时更新源点，Lift 时提交。全部端侧，无模拟。
 */
export default function CloneSourceHandle({
  sx,
  sy,
  imageScale,
  imageWidth,
  imageHeight,
  onMove,
  onCommit,
}: CloneSourceHandleProps) {
  const dragging = useRef(false);
  const posRef = useRef({ x: sx, y: sy });
  posRef.current = { x: sx, y: sy };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    dragging.current = true;
    posRef.current = { x: sx, y: sy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const scale = Math.max(imageScale, 1e-3);
    let nx = posRef.current.x + e.movementX / scale;
    let ny = posRef.current.y + e.movementY / scale;
    nx = Math.max(0, Math.min(imageWidth, nx));
    ny = Math.max(0, Math.min(imageHeight, ny));
    posRef.current = { x: nx, y: ny };
    onMove(nx, ny);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放则忽略 */
    }
    onCommit();
  };

  return (
    <div
      className="pointer-events-auto absolute z-[5]"
      style={{
        left: 0,
        top: 0,
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      <div
        className="relative h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: 0, top: 0 }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* 圆形指示 */}
        <div
          className="absolute inset-0 rounded-full border-[3px]"
          style={{ borderColor: '#22d3ee', boxShadow: '0 0 10px rgba(34,211,238,0.6)' }}
        />
        {/* 十字线 */}
        <div className="absolute left-1/2 top-1/2 h-9 w-px -translate-x-1/2 -translate-y-1/2 bg-cyan-400/90" />
        <div className="absolute left-1/2 top-1/2 h-px w-9 -translate-x-1/2 -translate-y-1/2 bg-cyan-400/90" />
        {/* 中心点 */}
        <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
      </div>
    </div>
  );
}