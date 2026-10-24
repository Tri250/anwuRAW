import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useAndroidBackHandler } from '../../src/hooks/useAndroidBackHandler';
import { useUIStore } from '../../src/store/useUIStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { Panel } from '../../src/components/ui/AppProperties';

const setViewport = (w: number, h: number) => {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  // 同步 stub visualViewport，与真实 Android WebView 行为一致
  Object.defineProperty(window, 'visualViewport', {
    value: { width: w, height: h },
    configurable: true,
  });
};

describe('useAndroidBackHandler', () => {
  beforeEach(() => {
    useSettingsStore.setState({ osPlatform: 'android' });
    // 手机竖屏典型视口（412×892），命中紧凑布局判定
    setViewport(412, 892);
    useUIStore.setState({
      activeView: 'library',
      isFullScreen: false,
      activePanel: Panel.Adjustments,
      isSettingsOpen: false,
      isLibraryExportPanelVisible: false,
    });
    useEditorStore.setState({
      isStraightenActive: false,
      activeMaskId: null,
      activeMaskContainerId: null,
      activeAiPatchContainerId: null,
      activeAiSubMaskId: null,
    });
    useLibraryStore.setState({ rootPaths: [] });
  });

  afterEach(() => {
    useSettingsStore.setState({ osPlatform: '' });
    delete (window as any).__handleAndroidBack;
  });

  // 每个用例独立挂载 hook（afterEach 的 cleanup 会卸载并删除全局处理器）
  const mount = () => {
    renderHook(() => useAndroidBackHandler());
    return (window as any).__handleAndroidBack as () => boolean;
  };

  const handleBack = (handler: () => boolean): boolean => {
    let result = false;
    act(() => {
      result = handler();
    });
    return result;
  };

  it('非 Android 平台不注册返回键处理器', () => {
    useSettingsStore.setState({ osPlatform: 'macos' });
    renderHook(() => useAndroidBackHandler());
    expect((window as any).__handleAndroidBack).toBeUndefined();
  });

  it('Android 平台注册返回键处理器', () => {
    expect(mount()).toBeTypeOf('function');
  });

  it('确认弹窗打开时优先关闭弹窗并消费返回键', () => {
    const handler = mount();
    const ui = useUIStore.getState();
    useUIStore.setState({ confirmModalState: { ...ui.confirmModalState, isOpen: true } });

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(useUIStore.getState().confirmModalState.isOpen).toBe(false);
  });

  it('编辑器中浏览型紧凑面板展开时,返回键保持面板常驻并派发 Escape', () => {
    const handler = mount();
    useUIStore.setState({ activeView: 'editor', activePanel: Panel.Adjustments });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const result = handleBack(handler);

    expect(result).toBe(true);
    // v1.6.21 面板常驻展开：返回键不再收起面板，activePanel 保持原状
    expect(useUIStore.getState().activePanel).toBe(Panel.Adjustments);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0][0] as KeyboardEvent;
    expect(event.key).toBe('Escape');
    dispatchSpy.mockRestore();
  });

  it('裁剪面板展开时交由 Escape 退出裁剪模式,返回键已消费', () => {
    const handler = mount();
    useUIStore.setState({ activeView: 'editor', activePanel: Panel.Crop });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(useUIStore.getState().activePanel).toBe(Panel.Crop);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0][0] as KeyboardEvent;
    expect(event.key).toBe('Escape');
    dispatchSpy.mockRestore();
  });

  it('蒙版面板存在选中容器时,返回键交由 Escape 关闭选中态(面板保持)', () => {
    const handler = mount();
    useUIStore.setState({ activeView: 'editor', activePanel: Panel.Masks });
    useEditorStore.setState({ activeMaskContainerId: 'container-1' });

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(useUIStore.getState().activePanel).toBe(Panel.Masks);
  });

  it('全屏模式下返回键交由 Escape 退出全屏', () => {
    const handler = mount();
    useUIStore.setState({ activeView: 'editor', isFullScreen: true, activePanel: Panel.Adjustments });

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(useUIStore.getState().activePanel).toBe(Panel.Adjustments);
  });

  it('带图库根目录的库视图返回键已消费(Escape 触发返回主页)', () => {
    const handler = mount();
    useLibraryStore.setState({ rootPaths: ['/storage/emulated/0/DCIM'] });

    const result = handleBack(handler);

    expect(result).toBe(true);
  });

  it('应用主页(无根目录)返回键不消费,交由原生侧退至后台', () => {
    const handler = mount();
    useLibraryStore.setState({ rootPaths: [] });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const result = handleBack(handler);

    expect(result).toBe(false);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    dispatchSpy.mockRestore();
  });

  it('社区预设页返回键回到图库,不退出应用', () => {
    const handler = mount();
    useUIStore.setState({ activeView: 'community' });
    useLibraryStore.setState({ rootPaths: [] });

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(useUIStore.getState().activeView).toBe('library');
  });

  it('长按菜单打开时返回键只关闭菜单,不退出主页或退到后台', () => {
    const handler = mount();
    // 无根目录 = 主页：若无菜单，该场景会返回 false 让原生侧退到后台
    useLibraryStore.setState({ rootPaths: [] });
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0][0] as KeyboardEvent).key).toBe('Escape');
    dispatchSpy.mockRestore();
    menu.remove();
  });

  it('平板宽视口(桌面布局)不收起 activePanel,退回 Escape 兜底', () => {
    const handler = mount();
    setViewport(800, 1280);
    useUIStore.setState({ activeView: 'editor', activePanel: Panel.Adjustments });

    const result = handleBack(handler);

    expect(result).toBe(true);
    expect(useUIStore.getState().activePanel).toBe(Panel.Adjustments);
  });
});
