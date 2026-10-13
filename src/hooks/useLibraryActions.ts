/**
 * W9-I2 瘦身后的纯绑定层：图库操作逻辑在 services/libraryActionsService.ts。
 * handleImageSelect 由 App 经 appServiceRegistry 注册，服务层调用时读取。
 */
import * as libraryActionsService from '../services/libraryActionsService';

export function useLibraryActions() {
  return libraryActionsService;
}
