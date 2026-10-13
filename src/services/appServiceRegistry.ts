import { Adjustments } from '../utils/adjustments';

/**
 * W9-I2 服务层依赖注册表。
 *
 * hooks 装配层把"导航刷新/图像选择/变换状态/自动保存"等运行时依赖注册进来，
 * 服务层与 store 层（renderEngine 等）在调用时读取，避免 hooks 逐层透传回调，
 * 也避免 store 反向 import hooks 形成模块环。
 */

export interface TransformState {
  scale: number;
  positionX: number;
  positionY: number;
}

export interface AppServices {
  /** 刷新当前图库视图（App 的 handleLibraryRefresh） */
  refreshImageList: () => Promise<void>;
  /** 刷新所有文件夹树 */
  refreshAllFolderTrees: () => Promise<void>;
  /** 选择图片并打开编辑器 */
  handleImageSelect: (path: string, openInEditor?: boolean) => void;
  /** 返回图库视图 */
  handleBackToLibrary: () => void;
  /** 当前排序后的图库列表（删除后next-path计算用） */
  getSortedImageList: () => any[];
  /** react-zoom-pan-pinch 变换状态（ROI 计算用），未挂载时返回 null */
  getTransformState: () => TransformState | null;
  /** 编辑器防抖自动保存（debouncedSave） */
  saveAdjustmentsDebounced: (path: string, adjustments: Adjustments) => void;
}

const services: Partial<AppServices> = {};

/** 合并注册（幂等）；App/useImageProcessing 每次渲染刷新闭包，保证无过期状态 */
export function registerAppServices(partial: Partial<AppServices>) {
  Object.assign(services, partial);
}

/** 取服务；缺失即抛错（装配遗漏 fail fast，而非深层 undefined 调用） */
export function getAppServices(): AppServices {
  const missing = (Object.keys(
    {
      refreshImageList: null,
      refreshAllFolderTrees: null,
      handleImageSelect: null,
      handleBackToLibrary: null,
      getSortedImageList: null,
      getTransformState: null,
      saveAdjustmentsDebounced: null,
    } as Record<keyof AppServices, null>,
  ) as Array<keyof AppServices>).filter((key) => typeof services[key] !== 'function');

  if (missing.length > 0) {
    throw new Error(`AppServices not registered: ${missing.join(', ')}`);
  }
  return services as AppServices;
}

/** 测试/重置用 */
export function resetAppServices() {
  for (const key of Object.keys(services) as Array<keyof AppServices>) {
    delete services[key];
  }
}
