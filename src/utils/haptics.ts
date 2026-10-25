/**
 * 触觉反馈：国内主流修图 App 标准手感（面板切换、模式切换等关键交互）。
 * WebView 可能不支持 vibrate（桌面端/部分 Android WebView），安全调用不抛错。
 */
export const hapticFeedback = (durationMs = 10) => {
  try {
    navigator.vibrate?.(durationMs);
  } catch {
    /* vibrate 不可用时静默忽略 */
  }
};
