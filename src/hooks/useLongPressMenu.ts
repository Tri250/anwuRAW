import { useCallback, useEffect, useRef } from 'react';

/**
 * 触屏长按打开右键菜单。
 * Android 端没有鼠标右键，原生 contextmenu 在不同 WebView 版本中触发时机不一致，
 * 因此显式实现 500ms 长按；手指移动超过 10px 视为滚动/拖拽并取消。
 * 触发后需吞掉紧随其后的 click，避免同时选中/打开图片。
 */
export function useLongPressMenu(path: string, onContextMenu?: any) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const triggeredRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      triggeredRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        triggeredRef.current = true;
        // 触觉反馈：国内 App 标准手感，提示用户长按已触发（WebView 可能无 vibrate 能力，安全调用）
        try {
          navigator.vibrate?.(10);
        } catch {
          /* 忽略不支持振动的环境 */
        }
        onContextMenu?.(
          { preventDefault() {}, stopPropagation() {}, clientX: e.clientX, clientY: e.clientY },
          path,
        );
      }, 500);
    },
    [cancel, onContextMenu, path],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' || timerRef.current === null) return;
      if (Math.hypot(e.clientX - startRef.current.x, e.clientY - startRef.current.y) > 10) cancel();
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  return {
    cancel,
    triggeredRef,
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}
