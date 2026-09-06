import '@testing-library/jest-dom/vitest';
import { vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// === i18n 初始化:加载 zh-CN 与 en,确保 formatMaskTypeName 等函数返回真实本地化字符串 ===
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../../src/i18n/locales/zh-CN.json';
import en from '../../src/i18n/locales/en.json';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: {
        'zh-CN': { translation: zhCN },
        en: { translation: en },
      },
      lng: 'zh-CN',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  }
});

// === Mock Tauri invoke:用 vi.fn 暴露,允许每个测试自定义返回值 ===
// 默认返回已 resolve 的 Promise,避免 hook 中 .catch()/.then() 链调用时报 undefined 错误。
// 测试可通过 mockInvoke.mockResolvedValueOnce / mockRejectedValueOnce 覆盖具体行为。
const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@clerk/react', () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue('mock-token') }),
}));

// React-Toastify 的 toast.error 在 jsdom 中触发副作用,做静默 mock
vi.mock('react-toastify', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
  Flip: ({ children }: { children: React.ReactNode }) => children,
  ToastContainer: () => null,
}));

beforeEach(() => {
  mockInvoke.mockReset();
  // mockReset 会清空 mockResolvedValue(undefined),这里重新设置默认返回值
  mockInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

export { mockInvoke };
