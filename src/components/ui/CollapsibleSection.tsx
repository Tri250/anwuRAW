import { useRef, useEffect, useState } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import Text from './Text';
import { TextVariants, TextWeights } from '../../types/typography';
import { useLongPressMenu } from '../../hooks/useLongPressMenu';

interface CollapsibleSectionProps {
  canToggleVisibility?: boolean;
  children: any;
  isContentVisible: boolean;
  isOpen: boolean;
  onContextMenu?: any;
  onToggle: any;
  onToggleVisibility?: any;
  title: string;
}

export default function CollapsibleSection({
  canToggleVisibility = true,
  children,
  isContentVisible,
  isOpen,
  onContextMenu,
  onToggle,
  onToggleVisibility = () => {},
  title,
}: CollapsibleSectionProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const hoverTimeoutRef = useRef<any>(null);

  // 触屏设备（无 hover 能力）上 isHovering 永远不会变为 true，
  // 眼睛按钮将永久不可见导致分区启用/禁用无法触达——此处对纯触屏环境常显按钮
  const isHoverUnavailable =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none)').matches;
  const showEyeButton = isHoverUnavailable || isHovering || !isContentVisible;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) {
      return;
    }

    const updateMaxHeight = () => {
      if (isOpen) {
        const contentHeight = content.scrollHeight;
        wrapper.style.maxHeight = `${contentHeight}px`;
      } else {
        wrapper.style.maxHeight = '0px';
      }
    };

    updateMaxHeight();

    const resizeObserver = new ResizeObserver(updateMaxHeight);
    resizeObserver.observe(content);

    return () => resizeObserver.disconnect();
  }, [isOpen]);

  const handleMouseEnter = () => {
    if (!canToggleVisibility) {
      return;
    }
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovering(true);
    }, 250);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovering(false);
  };

  const handleVisibilityClick = (e: any) => {
    e.stopPropagation();
    onToggleVisibility();
  };

  // Android 无右键：长按分区标题打开分区上下文菜单（重置本分区等），
  // 只挂在标题行而非整个分区，避免长按滑块/输入时误弹菜单
  const longPress = useLongPressMenu(title, (e: any) => onContextMenu?.(e));

  return (
    <div className="bg-surface rounded-lg overflow-hidden shrink-0" onContextMenu={onContextMenu}>
      <div
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-card-active transition-colors duration-200"
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        onClick={() => {
          // 长按已弹出菜单：吞掉这次 click，避免同时折叠/展开分区
          if (longPress.triggeredRef.current) {
            longPress.triggeredRef.current = false;
            return;
          }
          onToggle();
        }}
        onContextMenu={(e: any) => {
          longPress.cancel();
          if (longPress.triggeredRef.current) {
            // 自定义长按已打开菜单，拦住原生 contextmenu 的冒泡，避免外层再次打开
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          // 未触发自定义长按时允许冒泡到外层 onContextMenu
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-2">
          <Text variant={TextVariants.title} weight={TextWeights.normal}>
            {title}
          </Text>
          {canToggleVisibility && (
            <div className="w-6 h-6 flex items-center justify-center">
              <button
                className={clsx(
                  'p-1 rounded-full text-text-secondary hover:bg-bg-primary z-10 transition-opacity duration-300',
                  showEyeButton ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                onClick={handleVisibilityClick}
                data-tooltip={
                  isContentVisible
                    ? t('ui.collapsibleSection.disableSection')
                    : t('ui.collapsibleSection.enableSection')
                }
              >
                {isContentVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          )}
        </div>
        <ChevronDown
          className={clsx('text-accent transition-transform duration-300', { 'rotate-180': isOpen })}
          size={20}
        />
      </div>
      <div ref={wrapperRef} className="overflow-hidden transition-all duration-300 ease-in-out">
        <div
          className={clsx(
            'px-4 pb-4 transition-opacity duration-300',
            !isContentVisible && 'opacity-30 pointer-events-none',
          )}
          ref={contentRef}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
