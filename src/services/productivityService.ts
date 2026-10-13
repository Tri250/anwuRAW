/**
 * W9-I2 生产力工具服务层：全景/HDR/焦点堆栈/多重曝光合成入口与降噪/拼贴保存逻辑
 * 自 useProductivityActions 下放。refreshImageList 经 appServiceRegistry 读取，
 * 无 React 依赖，函数身份模块级稳定。
 */
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { getAppServices } from './appServiceRegistry';
import { Invokes } from '../components/ui/AppProperties';

export function handleStartPanorama(paths: string[]) {
  // W9-I1：处理状态单源化到 useProcessStore（动作入口），uiStore 只保留成果数据。
  const epoch = useProcessStore.getState().beginCompose('panorama', 'Starting panorama process...');
  useUIStore.setState((state) => ({
    panoramaModalState: { ...state.panoramaModalState, finalImageBase64: null },
  }));
  invoke(Invokes.StitchPanorama, { paths }).catch((err) => {
    useProcessStore.getState().composeSettled('panorama', epoch, { error: String(err) });
  });
}

export async function handleSavePanorama(): Promise<string> {
  const { panoramaModalState } = useUIStore.getState();
  const { refreshImageList } = getAppServices();
  if (panoramaModalState.stitchingSourcePaths.length === 0) {
    const err = 'Source paths for panorama not found.';
    useProcessStore.getState().composeSettled('panorama', null, { error: err });
    throw new Error(err);
  }
  try {
    const savedPath: string = await invoke(Invokes.SavePanorama, {
      firstPathStr: panoramaModalState.stitchingSourcePaths[0],
    });
    await refreshImageList();
    return savedPath;
  } catch (err) {
    console.error('Failed to save panorama:', err);
    useProcessStore.getState().composeSettled('panorama', null, { error: String(err) });
    throw err;
  }
}

export function handleStartFocusStack(paths: string[]) {
  // W9-I1：处理状态单源化到 useProcessStore（动作入口），uiStore 只保留成果数据。
  const epoch = useProcessStore.getState().beginCompose('focusStack', 'Starting focus stacking process...');
  useUIStore.setState((state) => ({
    focusStackModalState: { ...state.focusStackModalState, finalImageBase64: null, depthMapBase64: null },
  }));
  invoke(Invokes.StitchFocusStack, { paths }).catch((err) => {
    useProcessStore.getState().composeSettled('focusStack', epoch, { error: String(err) });
  });
}

export async function handleSaveFocusStack(): Promise<string> {
  const { focusStackModalState } = useUIStore.getState();
  const { refreshImageList } = getAppServices();
  if (focusStackModalState.sourcePaths.length === 0) {
    const err = 'Source paths for focus stack not found.';
    useProcessStore.getState().composeSettled('focusStack', null, { error: err });
    throw new Error(err);
  }
  try {
    const savedPath: string = await invoke(Invokes.SaveFocusStack, {
      firstPathStr: focusStackModalState.sourcePaths[0],
    });
    await refreshImageList();
    return savedPath;
  } catch (err) {
    console.error('Failed to save focus stack:', err);
    useProcessStore.getState().composeSettled('focusStack', null, { error: String(err) });
    throw err;
  }
}

export function handleStartHdr(paths: string[]) {
  // W9-I1：处理状态单源化到 useProcessStore（动作入口），uiStore 只保留成果数据。
  const epoch = useProcessStore.getState().beginCompose('hdr', 'Starting HDR process...');
  useUIStore.setState((state) => ({
    hdrModalState: { ...state.hdrModalState, finalImageBase64: null },
  }));
  invoke(Invokes.MergeHdr, { paths }).catch((err) => {
    useProcessStore.getState().composeSettled('hdr', epoch, { error: String(err) });
  });
}

export async function handleSaveHdr(): Promise<string> {
  const { hdrModalState } = useUIStore.getState();
  const { refreshImageList } = getAppServices();
  if (hdrModalState.stitchingSourcePaths.length === 0) {
    const err = 'Source paths for HDR not found.';
    useProcessStore.getState().composeSettled('hdr', null, { error: err });
    throw new Error(err);
  }
  try {
    const savedPath: string = await invoke(Invokes.SaveHdr, { firstPathStr: hdrModalState.stitchingSourcePaths[0] });
    await refreshImageList();
    return savedPath;
  } catch (err) {
    console.error('Failed to save HDR image:', err);
    useProcessStore.getState().composeSettled('hdr', null, { error: String(err) });
    throw err;
  }
}

export async function handleApplyDenoise(intensity: number, method: 'ai' | 'bm3d') {
  const { denoiseModalState } = useUIStore.getState();
  if (denoiseModalState.targetPaths.length === 0) return;

  useUIStore.setState((state) => ({
    denoiseModalState: {
      ...state.denoiseModalState,
      isProcessing: true,
      error: null,
      progressMessage: 'Starting engine...',
    },
  }));

  try {
    await invoke(Invokes.ApplyDenoising, {
      path: denoiseModalState.targetPaths[0],
      intensity: intensity,
      method: method,
    });
  } catch (err) {
    useUIStore.setState((state) => ({
      denoiseModalState: { ...state.denoiseModalState, isProcessing: false, error: String(err) },
    }));
  }
}

export async function handleBatchDenoise(intensity: number, method: 'ai' | 'bm3d', paths: string[]) {
  const { refreshImageList } = getAppServices();
  try {
    const savedPaths: string[] = await invoke('batch_denoise_images', { paths, intensity, method });
    await refreshImageList();
    return savedPaths;
  } catch (err) {
    useUIStore.setState((state) => ({ denoiseModalState: { ...state.denoiseModalState, error: String(err) } }));
    throw err;
  }
}

export async function handleSaveDenoisedImage(): Promise<string> {
  const { denoiseModalState } = useUIStore.getState();
  const { refreshImageList } = getAppServices();
  if (denoiseModalState.targetPaths.length === 0) throw new Error('No target path');
  const savedPath = await invoke<string>(Invokes.SaveDenoisedImage, {
    originalPathStr: denoiseModalState.targetPaths[0],
  });
  await refreshImageList();
  return savedPath;
}

export async function handleSaveCollage(base64Data: string, firstPath: string): Promise<string> {
  const { refreshImageList } = getAppServices();
  try {
    const savedPath: string = await invoke(Invokes.SaveCollage, { base64Data, firstPathStr: firstPath });
    await refreshImageList();
    return savedPath;
  } catch (err) {
    console.error('Failed to save collage:', err);
    throw err;
  }
}
