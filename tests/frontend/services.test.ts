// W9-I2: 业务服务层（fileOperations/libraryActions/productivity）下放行为锁定
//   - 服务函数无 React 依赖，经 appServiceRegistry 读取导航依赖（fail fast）
//   - 文件操作：删除后 next-path 计算、重命名模态、移动粘贴清理
//   - 图库操作：评分 IPC + 本地同步、清除选择的视图分支
//   - 生产力工具：合成入口 epoch 接线（begin/composeSettled）、保存失败落账
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mockInvoke } from './setup';
import { Invokes } from '../../src/components/ui/AppProperties';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { registerAppServices, resetAppServices } from '../../src/services/appServiceRegistry';
import * as fileOps from '../../src/services/fileOperationsService';
import * as libraryActions from '../../src/services/libraryActionsService';
import * as productivity from '../../src/services/productivityService';

const refreshImageList = vi.fn();
const refreshAllFolderTrees = vi.fn();
const handleImageSelect = vi.fn();
const handleBackToLibrary = vi.fn();

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  registerAppServices({
    refreshImageList,
    refreshAllFolderTrees,
    handleImageSelect,
    handleBackToLibrary,
    getSortedImageList: () => [{ path: '/a.png' }, { path: '/b.png' }, { path: '/c.png' }],
    getTransformState: () => null,
    saveAdjustmentsDebounced: vi.fn(),
  });
  (['panorama', 'hdr', 'focusStack', 'multiExposure'] as const).forEach((k) =>
    useProcessStore.getState().resetCompose(k),
  );
  vi.clearAllMocks();
});

afterEach(() => {
  resetAppServices();
});

describe('fileOperationsService（W9-I2）', () => {
  it('TC-SVC-01: executeDelete 删除当前激活图后自动选中下一条', async () => {
    useLibraryStore.setState({
      multiSelectedPaths: ['/a.png'],
      libraryActivePath: '/a.png',
      imageList: [],
      rootPaths: [],
      pinnedFolders: [],
    } as never);
    useEditorStore.setState({ selectedImage: null } as never);
    useUIStore.setState({ activeView: 'library' } as never);
    mockInvoke.mockResolvedValueOnce(undefined);

    await fileOps.executeDelete(['/a.png']);

    expect(mockInvoke).toHaveBeenCalledWith('delete_files_from_disk', { paths: ['/a.png'] });
    expect(refreshImageList).toHaveBeenCalledTimes(1);
    const lib = useLibraryStore.getState();
    expect(lib.libraryActivePath).toBe('/b.png');
    expect(lib.multiSelectedPaths).toEqual(['/b.png']);
  });

  it('TC-SVC-02: executeDelete 删除非激活图时保持当前选择', async () => {
    useLibraryStore.setState({
      multiSelectedPaths: ['/a.png'],
      libraryActivePath: '/a.png',
      imageList: [],
      rootPaths: [],
      pinnedFolders: [],
    } as never);
    useEditorStore.setState({ selectedImage: null } as never);
    useUIStore.setState({ activeView: 'library' } as never);
    mockInvoke.mockResolvedValueOnce(undefined);

    await fileOps.executeDelete(['/c.png']);

    const lib = useLibraryStore.getState();
    expect(lib.libraryActivePath).toBe('/a.png');
    expect(lib.multiSelectedPaths).toEqual(['/a.png']);
  });

  it('TC-SVC-03: handleRenameFiles 打开重命名模态并登记目标路径', () => {
    useUIStore.setState({ renameTargetPaths: [], isRenameFileModalOpen: false } as never);

    fileOps.handleRenameFiles(['/x.png', '/y.png']);

    const ui = useUIStore.getState();
    expect(ui.renameTargetPaths).toEqual(['/x.png', '/y.png']);
    expect(ui.isRenameFileModalOpen).toBe(true);
  });

  it('TC-SVC-04: handlePasteFiles move 模式清空剪贴板并双刷新', async () => {
    useProcessStore.setState({ copiedFilePaths: ['/a.png'] } as never);
    useLibraryStore.setState({ currentFolderPath: '/dest', multiSelectedPaths: ['/a.png'] } as never);
    mockInvoke.mockResolvedValueOnce(undefined);

    await fileOps.handlePasteFiles('move');

    expect(mockInvoke).toHaveBeenCalledWith(Invokes.MoveFiles, {
      sourcePaths: ['/a.png'],
      destinationFolder: '/dest',
    });
    expect(useProcessStore.getState().copiedFilePaths).toEqual([]);
    expect(useLibraryStore.getState().multiSelectedPaths).toEqual([]);
    expect(refreshAllFolderTrees).toHaveBeenCalledTimes(1);
    expect(refreshImageList).toHaveBeenCalledTimes(1);
  });
});

describe('libraryActionsService（W9-I2）', () => {
  it('TC-SVC-05: handleRate 调用评分 IPC 并同步 imageRatings', async () => {
    useLibraryStore.setState({
      multiSelectedPaths: ['/a.png'],
      libraryActivePath: '/a.png',
      imageList: [],
      imageRatings: {},
    } as never);
    useEditorStore.setState({ selectedImage: null } as never);
    mockInvoke.mockResolvedValueOnce(undefined);

    await libraryActions.handleRate(4);

    expect(mockInvoke).toHaveBeenCalledWith(Invokes.SetRatingForPaths, { paths: ['/a.png'], rating: 4 });
    expect(useLibraryStore.getState().imageRatings['/a.png']).toBe(4);
  });

  it('TC-SVC-06: handleRate 同分再点切换为 0（取消评分）', async () => {
    useLibraryStore.setState({
      multiSelectedPaths: ['/a.png'],
      libraryActivePath: '/a.png',
      imageList: [],
      imageRatings: { '/a.png': 4 },
    } as never);
    useEditorStore.setState({ selectedImage: null } as never);
    mockInvoke.mockResolvedValueOnce(undefined);

    await libraryActions.handleRate(4);

    expect(mockInvoke).toHaveBeenCalledWith(Invokes.SetRatingForPaths, { paths: ['/a.png'], rating: 0 });
    expect(useLibraryStore.getState().imageRatings['/a.png']).toBe(0);
  });

  it('TC-SVC-07: handleClearSelection 图库视图清空选择与编辑器激活态', () => {
    useUIStore.setState({ activeView: 'library' } as never);
    useEditorStore.setState({
      selectedImage: { path: '/x.png' },
      activeMaskId: 'm1',
      activeMaskContainerId: 'c1',
    } as never);

    libraryActions.handleClearSelection();

    const lib = useLibraryStore.getState();
    const ed = useEditorStore.getState();
    expect(lib.multiSelectedPaths).toEqual([]);
    expect(lib.libraryActivePath).toBeNull();
    expect(ed.selectedImage).toBeNull();
    expect(ed.activeMaskId).toBeNull();
    expect(ed.activeMaskContainerId).toBeNull();
  });

  it('TC-SVC-08: handleClearSelection 编辑器视图保留当前图选择', () => {
    useUIStore.setState({ activeView: 'editor' } as never);
    useEditorStore.setState({ selectedImage: { path: '/x.png' } } as never);

    libraryActions.handleClearSelection();

    const lib = useLibraryStore.getState();
    const ed = useEditorStore.getState();
    expect(lib.multiSelectedPaths).toEqual(['/x.png']);
    expect(lib.libraryActivePath).toBe('/x.png');
    expect(ed.selectedImage).not.toBeNull();
  });
});

describe('productivityService（W9-I2）', () => {
  it('TC-SVC-09: handleStartPanorama 进入 processing，invoke 失败落账 error', async () => {
    useUIStore.setState({
      panoramaModalState: {
        isOpen: true,
        stitchingSourcePaths: ['/1.png', '/2.png'],
        finalImageBase64: 'old',
        progress: { current: 0, total: 0 },
        status: 'Idle',
        errorMessage: '',
      } as never,
    } as never);
    mockInvoke.mockRejectedValueOnce(new Error('boom'));

    productivity.handleStartPanorama(['/1.png', '/2.png']);

    expect(useProcessStore.getState().composeRuns.panorama.phase).toBe('processing');
    expect(useUIStore.getState().panoramaModalState.finalImageBase64).toBeNull();

    await flushAsync();
    await vi.waitFor(() => {
      expect(useProcessStore.getState().composeRuns.panorama.phase).toBe('error');
    });
    expect(useProcessStore.getState().composeRuns.panorama.error).toContain('boom');
  });

  it('TC-SVC-10: handleSavePanorama 源路径缺失时抛错并落账 error', async () => {
    useProcessStore.getState().beginCompose('panorama');
    useUIStore.setState({
      panoramaModalState: {
        isOpen: true,
        stitchingSourcePaths: [],
        finalImageBase64: null,
        progress: { current: 0, total: 0 },
        status: 'Idle',
        errorMessage: '',
      } as never,
    } as never);

    await expect(productivity.handleSavePanorama()).rejects.toThrow('Source paths');
    expect(useProcessStore.getState().composeRuns.panorama.phase).toBe('error');
  });

  it('TC-SVC-11: handleSaveCollage 保存成功并刷新图库', async () => {
    mockInvoke.mockResolvedValueOnce('/saved.png');

    const saved = await productivity.handleSaveCollage('base64data', '/1.png');

    expect(saved).toBe('/saved.png');
    expect(mockInvoke).toHaveBeenCalledWith(Invokes.SaveCollage, { base64Data: 'base64data', firstPathStr: '/1.png' });
    expect(refreshImageList).toHaveBeenCalledTimes(1);
  });
});

describe('appServiceRegistry fail fast（W9-I2）', () => {
  it('TC-SVC-12: 未注册依赖时服务调用立即报错而非深层 undefined', async () => {
    resetAppServices();
    await expect(fileOps.executeDelete(['/a.png'])).rejects.toThrow('AppServices not registered');
  });
});
