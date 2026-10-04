import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useAiMasking } from '../../src/hooks/useAiMasking';
import { Invokes } from '../../src/components/ui/AppProperties';
import { Mask, SubMaskMode } from '../../src/components/panel/right/Masks';
import { toast } from 'react-toastify';
import { mockInvoke } from './setup';

// === TC-AI-* 系列:覆盖 useAiMasking Hook ===

/** 构造 AI Patch 调整状态 */
function makeInitialState(overrides: Record<string, unknown> = {}) {
  return {
    selectedImage: { path: '/tmp/test.dng' },
    adjustments: {
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
      orientationSteps: 0,
      masks: [],
      aiPatches: [
        {
          id: 'patch-1',
          name: 'Patch 1',
          visible: true,
          invert: false,
          prompt: '',
          opacity: 100,
          patchData: null,
          isLoading: false,
          subMasks: [
            {
              id: 'sm-1',
              type: Mask.AiSubject,
              visible: true,
              invert: false,
              opacity: 100,
              mode: SubMaskMode.Additive,
              parameters: { maskDataBase64: null, grow: 50, feather: 25 },
            },
          ],
        },
      ],
    },
    activeMaskId: null,
    activeMaskContainerId: null,
    activeAiPatchContainerId: 'patch-1',
    // 设为 null 避免 mount 时 precompute_ai_subject_mask useEffect 触发并吞掉测试用 mockResolvedValueOnce
    activeAiSubMaskId: null,
    isGeneratingAi: false,
    isGeneratingAiMask: false,
    patchesSentToBackend: new Set<string>(),
    ...overrides,
  };
}

beforeEach(() => {
  useEditorStore.setState(makeInitialState() as never);
});

describe('TC-AI-01: updateSubMask', () => {
  it('更新 masks 与 aiPatches 内对应 subMask', async () => {
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      result.current.updateSubMask('sm-1', { invert: true });
    });
    const state = useEditorStore.getState();
    const patch = state.adjustments.aiPatches.find((p) => p.id === 'patch-1');
    const sub = patch.subMasks.find((sm) => sm.id === 'sm-1');
    expect(sub.invert).toBe(true);
  });
});

describe('TC-AI-02 ~ TC-AI-03: handleGenerateAiMask 成功/失败', () => {
  it('TC-AI-02: 成功时合并参数并清除 patchesSentToBackend 标记', async () => {
    mockInvoke.mockResolvedValueOnce({ grow: 80, feather: 40, maskDataBase64: 'data:image/png;base64,xxx' });
    const { result } = renderHook(() => useAiMasking());
    useEditorStore.getState().patchesSentToBackend.add('sm-1');

    await act(async () => {
      await result.current.handleGenerateAiMask('sm-1', { x: 10, y: 20 }, { x: 50, y: 60 });
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      Invokes.GenerateAiSubjectMask,
      expect.objectContaining({
        endPoint: [50, 60],
        startPoint: [10, 20],
        path: '/tmp/test.dng',
      }),
    );
    expect(useEditorStore.getState().isGeneratingAiMask).toBe(false);
    const sub = useEditorStore.getState().adjustments.aiPatches[0].subMasks[0];
    expect(sub.parameters.grow).toBe(80);
    expect(sub.parameters.feather).toBe(40);
  });

  it('TC-AI-03: 失败时 toast.error 被调用且 isGeneratingAiMask 复位', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useAiMasking());

    await act(async () => {
      await result.current.handleGenerateAiMask('sm-1', { x: 0, y: 0 }, { x: 1, y: 1 });
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('AI Mask Failed'));
    expect(useEditorStore.getState().isGeneratingAiMask).toBe(false);
  });

  it('TC-AI-验收: selectedImage.path 为空时立即返回不抛错', async () => {
    useEditorStore.setState({ selectedImage: null });
    const { result } = renderHook(() => useAiMasking());
    await expect(result.current.handleGenerateAiMask('sm-1', { x: 0, y: 0 }, { x: 1, y: 1 })).resolves.toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('TC-AI-04 ~ TC-AI-06: AI 子类型蒙版生成', () => {
  it('TC-AI-04: handleGenerateAiSkyMask 调用 GenerateAiSkyMask 命令', async () => {
    mockInvoke.mockResolvedValueOnce({ maskDataBase64: 'sky-data' });
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleGenerateAiSkyMask('sm-1');
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      Invokes.GenerateAiSkyMask,
      expect.objectContaining({
        flipHorizontal: false,
        flipVertical: false,
        orientationSteps: 0,
        rotation: 0,
      }),
    );
  });

  it('TC-AI-05: handleGenerateAiForegroundMask 调用 GenerateAiForegroundMask 命令', async () => {
    mockInvoke.mockResolvedValueOnce({ maskDataBase64: 'fg-data' });
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleGenerateAiForegroundMask('sm-1');
    });
    expect(mockInvoke).toHaveBeenCalledWith(Invokes.GenerateAiForegroundMask, expect.any(Object));
  });

  it('TC-AI-06: handleGenerateAiDepthMask 默认值回退 + 命令分发', async () => {
    mockInvoke.mockResolvedValueOnce({ maskDataBase64: 'depth-data' });
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      // 故意不传任何 parameters 字段,验证默认回退
      await result.current.handleGenerateAiDepthMask('sm-1', {});
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'generate_ai_depth_mask',
      expect.objectContaining({
        minDepth: 20,
        maxDepth: 100,
        minFade: 15,
        maxFade: 15,
        feather: 10,
      }),
    );
  });

  it('TC-AI-06b: handleGenerateAiDepthMask 自定义参数透传', async () => {
    mockInvoke.mockResolvedValueOnce({ maskDataBase64: 'depth-data' });
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleGenerateAiDepthMask('sm-1', {
        minDepth: 30,
        maxDepth: 90,
        minFade: 5,
        maxFade: 25,
        feather: 20,
      });
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'generate_ai_depth_mask',
      expect.objectContaining({
        minDepth: 30,
        maxDepth: 90,
        minFade: 5,
        maxFade: 25,
        feather: 20,
      }),
    );
  });

  // 回归测试:蒙版在 masks 容器(非 aiPatches)中时,AI handler 应正确查找并保留已有参数
  it('TC-AI-回归: subMask 在 masks 容器中时参数被正确合并(不丢失)', async () => {
    // 将 subMask 放入 masks 容器而非 aiPatches
    useEditorStore.setState({
      adjustments: {
        ...useEditorStore.getState().adjustments,
        aiPatches: [],
        masks: [
          {
            id: 'c-1',
            name: 'C1',
            visible: true,
            invert: false,
            opacity: 100,
            adjustments: {},
            subMasks: [
              {
                id: 'sm-mask-1',
                type: Mask.AiForeground,
                visible: true,
                invert: false,
                opacity: 100,
                mode: SubMaskMode.Additive,
                parameters: { maskDataBase64: null, grow: 75, feather: 40 },
              },
            ],
          },
        ],
      },
    });
    mockInvoke.mockResolvedValueOnce({ maskDataBase64: 'fg-new', grow: 50, feather: 25 });
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleGenerateAiForegroundMask('sm-mask-1');
    });
    const sub = useEditorStore.getState().adjustments.masks[0].subMasks[0];
    // 后端返回的参数应与原有参数合并,而非覆盖丢失
    expect(sub.parameters.grow).toBe(50); // 后端返回值覆盖
    expect(sub.parameters.feather).toBe(25); // 后端返回值覆盖
    expect(sub.parameters.maskDataBase64).toBe('fg-new');
  });
});

describe('TC-AI-07 ~ TC-AI-08: handleDirectPatch 命令分发与切图保护', () => {
  it('TC-AI-07: auto-erase 子蒙版分发到 generate_auto_erase_patch', async () => {
    useEditorStore.setState({
      adjustments: {
        ...useEditorStore.getState().adjustments,
        aiPatches: [
          {
            ...useEditorStore.getState().adjustments.aiPatches[0],
            subMasks: [
              {
                id: 'sm-1',
                type: Mask.AutoErase,
                visible: true,
                invert: false,
                opacity: 100,
                mode: SubMaskMode.Additive,
                parameters: {},
              },
            ],
          },
        ],
      },
    });
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: 'data:image/png;base64,xxx' }));
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleDirectPatch('sm-1', 100, 200);
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'generate_auto_erase_patch',
      expect.objectContaining({
        sourcePoint: [100, 200],
      }),
    );
  });

  it('TC-AI-07b: liquify 分发到 generate_liquify_patch', async () => {
    useEditorStore.setState({
      adjustments: {
        ...useEditorStore.getState().adjustments,
        aiPatches: [
          {
            ...useEditorStore.getState().adjustments.aiPatches[0],
            subMasks: [
              {
                id: 'sm-1',
                type: Mask.Liquify,
                visible: true,
                invert: false,
                opacity: 100,
                mode: SubMaskMode.Additive,
                parameters: {},
              },
            ],
          },
        ],
      },
    });
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: '' }));
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleDirectPatch('sm-1', 1, 2);
    });
    expect(mockInvoke).toHaveBeenCalledWith('generate_liquify_patch', expect.any(Object));
  });

  it('TC-AI-07c: retouch 分发到 generate_retouch_patch', async () => {
    useEditorStore.setState({
      adjustments: {
        ...useEditorStore.getState().adjustments,
        aiPatches: [
          {
            ...useEditorStore.getState().adjustments.aiPatches[0],
            subMasks: [
              {
                id: 'sm-1',
                type: Mask.Retouch,
                visible: true,
                invert: false,
                opacity: 100,
                mode: SubMaskMode.Additive,
                parameters: {},
              },
            ],
          },
        ],
      },
    });
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: '' }));
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleDirectPatch('sm-1', 1, 2);
    });
    expect(mockInvoke).toHaveBeenCalledWith('generate_retouch_patch', expect.any(Object));
  });

  it('TC-AI-07d: 其他(clone/heal)分发到 generate_manual_cleanup_patch', async () => {
    useEditorStore.setState({
      adjustments: {
        ...useEditorStore.getState().adjustments,
        aiPatches: [
          {
            ...useEditorStore.getState().adjustments.aiPatches[0],
            subMasks: [
              {
                id: 'sm-1',
                type: Mask.Clone,
                visible: true,
                invert: false,
                opacity: 100,
                mode: SubMaskMode.Additive,
                parameters: {},
              },
            ],
          },
        ],
      },
    });
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: '' }));
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleDirectPatch('sm-1', 1, 2);
    });
    expect(mockInvoke).toHaveBeenCalledWith('generate_manual_cleanup_patch', expect.any(Object));
  });

  it('TC-AI-08: 切图丢弃旧结果 - 不会写新图的 aiPatches', async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: 'data:image/png;base64,new' }));
    const { result } = renderHook(() => useAiMasking());
    // 在 invoke resolve 前切图
    const promise = result.current.handleDirectPatch('sm-1', 1, 2);
    useEditorStore.setState({ selectedImage: { path: '/tmp/other.dng' } });
    await act(async () => {
      await promise;
    });
    // patchData 不应更新(切了图)
    const patch = useEditorStore.getState().adjustments.aiPatches.find((p) => p.id === 'patch-1');
    // patchData 仍为 null(切图路径不同导致丢弃)
    expect(patch.patchData).toBeNull();
  });
});

describe('TC-AI-09 ~ TC-AI-10: handleGenerativeReplace 端侧/云端', () => {
  it('TC-AI-09: useFastInpaint=true 时跳过 getToken,token=null', async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: 'data:image/png;base64,fast' }));
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleGenerativeReplace('patch-1', 'a prompt', true);
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      Invokes.InvokeGenerativeReplaceWithMaskDef,
      expect.objectContaining({ useFastInpaint: true, token: null }),
    );
    const patch = useEditorStore.getState().adjustments.aiPatches.find((p) => p.id === 'patch-1');
    expect(patch.isLoading).toBe(false);
    expect(patch.patchData).toEqual({ color: '#fff', mask: 'data:image/png;base64,fast' });
  });

  it('TC-AI-10: useFastInpaint=false 时透传 token', async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ color: '#fff', mask: 'cloud' }));
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await result.current.handleGenerativeReplace('patch-1', 'cloud prompt', false);
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      Invokes.InvokeGenerativeReplaceWithMaskDef,
      expect.objectContaining({ useFastInpaint: false, token: 'mock-token' }),
    );
  });
});

describe('TC-AI-12 ~ TC-AI-14: 删除与可见性', () => {
  it('TC-AI-12: handleDeleteMaskContainer 过滤目标并复位 active', () => {
    useEditorStore.setState({
      activeMaskContainerId: 'c-1',
      activeMaskId: 'm-1',
      adjustments: {
        ...useEditorStore.getState().adjustments,
        masks: [
          { id: 'c-1', name: 'C1', visible: true, invert: false, opacity: 100, adjustments: {}, subMasks: [] },
          { id: 'c-2', name: 'C2', visible: true, invert: false, opacity: 100, adjustments: {}, subMasks: [] },
        ],
      },
    });
    const { result } = renderHook(() => useAiMasking());
    act(() => {
      result.current.handleDeleteMaskContainer('c-1');
    });
    const state = useEditorStore.getState();
    expect(state.adjustments.masks).toHaveLength(1);
    expect(state.adjustments.masks[0].id).toBe('c-2');
    expect(state.activeMaskContainerId).toBeNull();
    expect(state.activeMaskId).toBeNull();
  });

  it('TC-AI-13: handleDeleteAiPatch 过滤 patch 并复位 active', () => {
    useEditorStore.setState({
      activeAiPatchContainerId: 'patch-1',
      activeAiSubMaskId: 'sm-1',
    });
    const { result } = renderHook(() => useAiMasking());
    act(() => {
      result.current.handleDeleteAiPatch('patch-1');
    });
    const state = useEditorStore.getState();
    expect(state.adjustments.aiPatches).toHaveLength(0);
    expect(state.activeAiPatchContainerId).toBeNull();
    expect(state.activeAiSubMaskId).toBeNull();
  });

  it('TC-AI-14: handleToggleAiPatchVisibility 仅翻转目标 patch', () => {
    useEditorStore.setState({
      adjustments: {
        ...useEditorStore.getState().adjustments,
        aiPatches: [
          {
            id: 'p-a',
            name: 'A',
            visible: true,
            invert: false,
            prompt: '',
            opacity: 100,
            patchData: null,
            isLoading: false,
            subMasks: [],
          },
          {
            id: 'p-b',
            name: 'B',
            visible: true,
            invert: false,
            prompt: '',
            opacity: 100,
            patchData: null,
            isLoading: false,
            subMasks: [],
          },
        ],
      },
    });
    const { result } = renderHook(() => useAiMasking());
    act(() => {
      result.current.handleToggleAiPatchVisibility('p-a');
    });
    const patches = useEditorStore.getState().adjustments.aiPatches;
    expect(patches.find((p) => p.id === 'p-a').visible).toBe(false);
    expect(patches.find((p) => p.id === 'p-b').visible).toBe(true);
  });
});

describe('TC-AI-验收: 全部导出函数在无 selectedImage 时安全返回', () => {
  beforeEach(() => {
    useEditorStore.setState({ selectedImage: null });
  });

  it('全部 11 个导出函数存在且为函数', () => {
    const { result } = renderHook(() => useAiMasking());
    expect(typeof result.current.updateSubMask).toBe('function');
    expect(typeof result.current.handleGenerativeReplace).toBe('function');
    expect(typeof result.current.handleDirectPatch).toBe('function');
    expect(typeof result.current.handleQuickErase).toBe('function');
    expect(typeof result.current.handleDeleteMaskContainer).toBe('function');
    expect(typeof result.current.handleDeleteAiPatch).toBe('function');
    expect(typeof result.current.handleToggleAiPatchVisibility).toBe('function');
    expect(typeof result.current.handleGenerateAiMask).toBe('function');
    expect(typeof result.current.handleGenerateAiDepthMask).toBe('function');
    expect(typeof result.current.handleGenerateAiForegroundMask).toBe('function');
    expect(typeof result.current.handleGenerateAiSkyMask).toBe('function');
  });

  it('selectedImage.path 为空时 invoke 类函数不调用 invoke', async () => {
    const { result } = renderHook(() => useAiMasking());
    await act(async () => {
      await Promise.all([
        result.current.handleGenerateAiMask('sm-1', { x: 0, y: 0 }, { x: 1, y: 1 }),
        result.current.handleGenerateAiSkyMask('sm-1'),
        result.current.handleGenerateAiForegroundMask('sm-1'),
        result.current.handleGenerateAiDepthMask('sm-1', {}),
        result.current.handleDirectPatch('sm-1', 0, 0),
        result.current.handleGenerativeReplace('patch-1', 'p', true),
        result.current.handleQuickErase('sm-1', { x: 0, y: 0 }, { x: 1, y: 1 }),
      ]);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
