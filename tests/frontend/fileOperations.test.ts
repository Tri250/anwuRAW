import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileOperations } from '../../src/hooks/useFileOperations';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useUIStore } from '../../src/store/useUIStore';
import { mockInvoke } from './setup';

// === TC-DEL-* 系列:executeDelete 切图竞态守卫 + 删除确认弹窗文案 i18n ===

const IMAGE_A = '/photos/a.jpg';
const IMAGE_B = '/photos/b.jpg';
const IMAGE_C = '/photos/c.jpg';

function makeImageList() {
  return [{ path: IMAGE_A }, { path: IMAGE_B }, { path: IMAGE_C }];
}

function setupStores(overrides: Record<string, unknown> = {}) {
  useLibraryStore.setState({
    libraryActivePath: IMAGE_A,
    multiSelectedPaths: [IMAGE_A],
    imageList: makeImageList(),
    setLibrary: useLibraryStore.getState().setLibrary,
    ...overrides,
  } as never);
  useEditorStore.setState({ selectedImage: null } as never);
  useUIStore.setState({ activeView: 'library' } as never);
}

function setupHook(sortedImageList = makeImageList()) {
  const refreshImageList = vi.fn().mockResolvedValue(undefined);
  const refreshAllFolderTrees = vi.fn().mockResolvedValue(undefined);
  const handleImageSelect = vi.fn();
  const handleBackToLibrary = vi.fn();
  const { result } = renderHook(() =>
    useFileOperations(refreshImageList, refreshAllFolderTrees, handleImageSelect, handleBackToLibrary, sortedImageList),
  );
  return { result, refreshImageList, handleImageSelect, handleBackToLibrary };
}

describe('executeDelete 竞态守卫', () => {
  beforeEach(() => {
    setupStores();
  });

  it('TC-DEL-01 删除期间未切图:导航决策生效,库激活图推进到下一张', async () => {
    const { result } = setupHook();
    mockInvoke.mockResolvedValueOnce(undefined);

    await act(async () => {
      await result.current.executeDelete([IMAGE_A]);
    });

    expect(mockInvoke).toHaveBeenCalledWith('delete_files_from_disk', { paths: [IMAGE_A] });
    const lib = useLibraryStore.getState();
    expect(lib.libraryActivePath).toBe(IMAGE_B);
    expect(lib.multiSelectedPaths).toEqual([IMAGE_B]);
  });

  it('TC-DEL-02 删除期间用户已切换激活图:守卫早退,不得覆盖用户新选择', async () => {
    const { result, handleImageSelect, handleBackToLibrary } = setupHook();
    // await 窗口内模拟用户切图:库激活图改为 c.jpg
    mockInvoke.mockImplementationOnce(async () => {
      await Promise.resolve();
      useLibraryStore.setState({ libraryActivePath: IMAGE_C } as never);
    });

    await act(async () => {
      await result.current.executeDelete([IMAGE_A]);
    });

    // 守卫生效:不回写导航决策、不触发选中回调
    expect(useLibraryStore.getState().libraryActivePath).toBe(IMAGE_C);
    expect(useLibraryStore.getState().multiSelectedPaths).toEqual([IMAGE_A]);
    expect(handleImageSelect).not.toHaveBeenCalled();
    expect(handleBackToLibrary).not.toHaveBeenCalled();
  });

  it('TC-DEL-03 编辑器视图删除期间切换选中图:守卫早退', async () => {
    useEditorStore.setState({ selectedImage: { path: IMAGE_A } } as never);
    useUIStore.setState({ activeView: 'editor' } as never);
    const { result, handleImageSelect, handleBackToLibrary } = setupHook();
    // await 窗口内用户切换到编辑器选中 c.jpg
    mockInvoke.mockImplementationOnce(async () => {
      await Promise.resolve();
      useEditorStore.setState({ selectedImage: { path: IMAGE_C } } as never);
    });

    await act(async () => {
      await result.current.executeDelete([IMAGE_A]);
    });

    expect(handleImageSelect).not.toHaveBeenCalled();
    expect(handleBackToLibrary).not.toHaveBeenCalled();
  });

  it('TC-DEL-04 编辑器视图删除当前编辑图且无后续候选:回退到图库', async () => {
    useEditorStore.setState({ selectedImage: { path: IMAGE_A } } as never);
    useUIStore.setState({ activeView: 'editor' } as never);
    const { result, handleBackToLibrary } = setupHook([{ path: IMAGE_A }]);

    await act(async () => {
      await result.current.executeDelete([IMAGE_A]);
    });

    expect(handleBackToLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('handleDeleteSelected 确认弹窗文案 i18n', () => {
  beforeEach(() => {
    setupStores();
  });

  it('TC-DEL-05 单图删除:标题/正文/确认按钮使用本地化文案', () => {
    const { result } = setupHook();
    act(() => {
      result.current.handleDeleteSelected();
    });

    const state = useUIStore.getState().confirmModalState;
    expect(state.isOpen).toBe(true);
    expect(state.title).toBe('删除所选图像？');
    expect(state.message).toBe('所选图像将从磁盘永久移除，且无法撤销。');
    expect(state.confirmText).toBe('仅删除所选');
  });

  it('TC-DEL-06 多图删除:正文包含数量插值', () => {
    useLibraryStore.setState({ multiSelectedPaths: [IMAGE_A, IMAGE_B, IMAGE_C] } as never);
    const { result } = setupHook();
    act(() => {
      result.current.handleDeleteSelected();
    });

    const state = useUIStore.getState().confirmModalState;
    expect(state.title).toBe('删除所选图像？');
    expect(state.message).toBe('所选的 3 张图像将从磁盘永久移除，且无法撤销。');
  });

  it('TC-DEL-07 所选图像含虚拟副本:提示将连同虚拟副本一并删除', () => {
    useLibraryStore.setState({
      multiSelectedPaths: [IMAGE_A],
      imageList: [...makeImageList(), { path: `${IMAGE_A}?vc=1` }],
    } as never);
    const { result } = setupHook([...makeImageList(), { path: `${IMAGE_A}?vc=1` }]);
    act(() => {
      result.current.handleDeleteSelected();
    });

    const state = useUIStore.getState().confirmModalState;
    expect(state.title).toBe('删除图像及其虚拟副本？');
    expect(state.confirmText).toBe('全部删除');
  });
});
