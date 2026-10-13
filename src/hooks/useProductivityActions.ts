/**
 * W9-I2 瘦身后的纯绑定层：生产力工具（合成/降噪/拼贴）逻辑在 services/productivityService.ts。
 * refreshImageList 由 App 经 appServiceRegistry 注册，服务层调用时读取。
 */
import * as productivityService from '../services/productivityService';

export function useProductivityActions() {
  return productivityService;
}
