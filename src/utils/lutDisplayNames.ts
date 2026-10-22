import i18n from 'i18next';
import { MASTER_RECIPES } from './masterRecipes';

/** 内置胶片 LUT 显示名映射：后端 list_luts 的 file_stem（稳定标识）→ ui.lut.builtInNames.<slug> */
const BUILTIN_FILM_NAME_KEYS: Record<string, string> = {
  'F-Pro 400H': 'fPro400H',
  'K-Ektar 100': 'kEktar100',
  'K-Gold 200': 'kGold200',
  'K-Portra 400': 'kPortra400',
  'K-Vision 250D Cinematic': 'kVision250DCinematic',
  'K-Vision 500T Cinematic': 'kVision500TCinematic',
};

/**
 * LUT 显示名汉化层。
 *
 * 配方名（lutName = MASTER_RECIPES[].name）与内置胶片名（后端文件名）是参与
 * 激活态比对与会话持久化的稳定标识，不直接改动；本函数仅在显示层输出本地化名称，
 * 用户自定义 LUT 原样返回。
 */
export const getLutDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  const recipe = MASTER_RECIPES.find((item) => item.name === name);
  if (recipe) {
    return i18n.t(`adjustments.basic.scene.recipes.${recipe.id}.name`, { defaultValue: recipe.name });
  }
  const filmKey = BUILTIN_FILM_NAME_KEYS[name];
  if (filmKey) {
    return i18n.t(`ui.lut.builtInNames.${filmKey}`, { defaultValue: name });
  }
  return name;
};
