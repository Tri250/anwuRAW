/**
 * 触屏手势判定工具。
 *
 * 画布双击缩放（Android）：以 tap 间隔与位移双阈值判定，
 * 阈值对齐主流移动端惯例（Chrome/WebView 视为双击的上限约 300ms，位移 40px 内）。
 */
export const DOUBLE_TAP_MAX_DELAY_MS = 300;
export const DOUBLE_TAP_MAX_DISTANCE_PX = 40;

/**
 * Android 手机紧凑布局阈值（App.tsx 布局判定与 useAndroidBackHandler 共用，
 * 避免两处硬编码漂移导致返回键与紧凑面板节点不一致）。
 */
export const ANDROID_PHONE_MAX_WIDTH = 600;
export const ANDROID_PHONE_MAX_HEIGHT = 500;

export interface TapPoint {
  time: number;
  x: number;
  y: number;
}

/** 判定 current 是否构成对 lastTap 的双击（时间与位移均在阈值内）。lastTap 为 null 时必为否。 */
export function isDoubleTap(lastTap: TapPoint | null, current: TapPoint): boolean {
  if (!lastTap) return false;
  const elapsed = current.time - lastTap.time;
  if (elapsed < 0 || elapsed >= DOUBLE_TAP_MAX_DELAY_MS) return false;
  return Math.hypot(current.x - lastTap.x, current.y - lastTap.y) < DOUBLE_TAP_MAX_DISTANCE_PX;
}
