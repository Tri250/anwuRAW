import '@testing-library/jest-dom/vitest';
// jsdom 未实现 PointerEvent；framer-motion 的键盘按压手势会构造该事件。
if (typeof (globalThis as any).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  (globalThis as any).PointerEvent = PointerEventPolyfill;
}

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
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock('@clerk/react', () => ({
  useAuth: () => ({
    getToken: vi.fn().mockResolvedValue('mock-token'),
    isSignedIn: true,
  }),
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: { id: 'user_test', fullName: 'Test User', imageUrl: '' },
  }),
  useClerk: () => ({ signOut: vi.fn(), openSignIn: vi.fn() }),
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  Show: ({ children }: { children: React.ReactNode }) => children,
  SignIn: () => null,
}));

// 文件对话框:默认“用户取消”,测试可通过 mockSaveDialog/mockOpenDialog 覆盖
const mockSaveDialog = vi.fn().mockResolvedValue(null);
const mockOpenDialog = vi.fn().mockResolvedValue(null);
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => mockSaveDialog(...args),
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

const { mockPlatform } = vi.hoisted(() => ({ mockPlatform: vi.fn(() => 'linux') }));
vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => mockPlatform(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/home/test'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
  sep: () => '/',
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
  }),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('1.6.26'),
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

// jsdom 未实现 ResizeObserver(CollapsibleSection/dnd-kit 等折叠测量需要)
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

beforeEach(() => {
  mockInvoke.mockReset();
  // mockReset 会清空 mockResolvedValue(undefined),这里重新设置默认返回值
  mockInvoke.mockResolvedValue(undefined);
  mockSaveDialog.mockReset();
  mockSaveDialog.mockResolvedValue(null);
  mockOpenDialog.mockReset();
  mockOpenDialog.mockResolvedValue(null);
  mockPlatform.mockReset();
  mockPlatform.mockReturnValue('linux');
});

afterEach(() => {
  cleanup();
});

export { mockInvoke, mockSaveDialog, mockOpenDialog, mockPlatform };
