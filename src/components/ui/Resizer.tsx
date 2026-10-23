import clsx from 'clsx';
import type { MouseEventHandler, PointerEventHandler } from 'react';
import { Orientation } from './AppProperties';

interface ResizerProps {
  direction: Orientation;
  onMouseDown: PointerEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
}

const Resizer = ({ direction, onMouseDown, onDoubleClick }: ResizerProps) => (
  <div
    className={clsx(
      'shrink-0 bg-transparent z-10 touch-none flex items-center justify-center',
      {
        'w-2 cursor-col-resize': direction === Orientation.Vertical,
        // 移动端水平 Resizer 触控区域从 8px 扩展至 20px（含内边距），
        // 中央保留 4px 视觉线，两侧 8px 透明可触控区域确保手指能可靠命中
        'h-5 cursor-row-resize': direction === Orientation.Horizontal,
      },
    )}
    role="separator"
    aria-orientation={direction === Orientation.Vertical ? 'vertical' : 'horizontal'}
    onPointerDown={onMouseDown}
    onDoubleClick={onDoubleClick}
    style={{ touchAction: 'none' }}
  >
    {direction === Orientation.Horizontal && (
      <div className="w-10 h-1 rounded-full bg-border-color/60" />
    )}
  </div>
);

export default Resizer;
