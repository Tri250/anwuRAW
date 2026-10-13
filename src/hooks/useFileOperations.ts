/**
 * W9-I2 瘦身后的纯绑定层：文件操作逻辑在 services/fileOperationsService.ts。
 * 导航依赖（刷新/选图/返回图库）由 App 经 appServiceRegistry 注册，服务层调用时读取。
 */
import * as fileOperationsService from '../services/fileOperationsService';

export function useFileOperations() {
  return fileOperationsService;
}
