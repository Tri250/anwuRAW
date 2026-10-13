// W9-I3 索引数据源消费（依赖 B3 图库索引）：10 万张库的筛选/搜索下沉 SQLite 索引，
// 避免主线程全量 regex/EXIF 扫描导致的交互卡顿。
//
// 可牺牲性契约（AR-4）：索引是派生数据 —— 不可用 / 查询失败 / 覆盖率不足 一律返回 null，
// 调用方（useSortedLibrary）回退本地过滤，行为与无索引时完全一致。
//
// 语义分工：
//   SQL 层（索引列）  —— rating ≥ min / raw only-exclude / edited only-exclude
//   JS 层（回读记录） —— unrated 精确、色标（含 none 特例）、标签含排、文件名文本
//   不支持（回退）    —— 高级查询（iso:/aperture:/camera:… 需 exif）、虚拟副本（索引 1:N）
import { invoke } from '@tauri-apps/api/core';
import { Invokes, RawStatus, EditedStatus } from '../components/ui/AppProperties';
import type { ImageFile, FilterCriteria } from '../components/ui/AppProperties';

/** useLibraryStore 内的 SearchCriteria（结构等价，避免导出依赖）。 */
export interface SearchCriteriaShape {
  tags: string[];
  text: string;
  mode: string;
}

export const ADVANCED_QUERY_REGEX =
  /^(iso|aperture|f|shutter|s|focal|mm|rating|color|camera|make|model|lens)\s*(?::)?\s*(>=|<=|>|<|=)?\s*(.+)$/i;

/** 低于该规模时索引加速无收益，直接走本地过滤。 */
export const INDEX_ACCEL_THRESHOLD = 20_000;

export interface IndexRecord {
  path: string;
  folder: string;
  filename: string;
  isRaw: boolean;
  rating: number;
  edited: boolean;
  tags: string[] | null;
}

interface IndexStats {
  available: boolean;
  count: number | null;
}

/** filterCriteria + searchCriteria 的稳定指纹：索引结果只在与当前条件一致时被消费。 */
export function filterFingerprint(filterCriteria: FilterCriteria, searchCriteria: SearchCriteriaShape): string {
  return JSON.stringify({
    f: [
      filterCriteria.rating,
      filterCriteria.rawStatus,
      filterCriteria.editedStatus,
      [...(filterCriteria.colors || [])].sort(),
    ],
    s: [searchCriteria.tags, searchCriteria.text, searchCriteria.mode],
  });
}

/** 该筛选/搜索组合是否可由索引承担（高级查询与虚拟副本场景回退本地）。 */
export function indexAccelSupported(imageList: ImageFile[], searchCriteria: SearchCriteriaShape): boolean {
  if (searchCriteria.tags.some((tag) => ADVANCED_QUERY_REGEX.test(tag))) return false;
  // 虚拟副本与索引条目为多对一，path 集合短路会误匹配
  if (imageList.some((img) => img.path.includes('?vc='))) return false;
  return true;
}

/**
 * 查询索引，返回当前筛选+搜索语义下命中的 path 集合。
 * 返回 null 表示索引加速不可用（调用方必须回退本地过滤）。
 */
export async function queryIndexMatchedPaths(
  imageList: ImageFile[],
  filterCriteria: FilterCriteria,
  searchCriteria: SearchCriteriaShape,
): Promise<Set<string> | null> {
  if (imageList.length < INDEX_ACCEL_THRESHOLD) return null;
  if (!indexAccelSupported(imageList, searchCriteria)) return null;

  try {
    // 覆盖率守卫：索引未覆盖当前库（扫描落库滞后）→ 回退本地，绝不漏图
    const stats = await invoke<IndexStats>(Invokes.LibraryIndexStats);
    if (!stats?.available || (stats.count ?? 0) < imageList.length) return null;

    const dto: Record<string, unknown> = {};
    const { rating } = filterCriteria;
    if (typeof rating === 'number' && rating > 0) dto.minRating = rating;
    if (filterCriteria.rawStatus === RawStatus.RawOnly) dto.rawStatus = 'only';
    if (filterCriteria.rawStatus === RawStatus.NonRawOnly) dto.rawStatus = 'exclude';
    if (filterCriteria.editedStatus === EditedStatus.EditedOnly) dto.editedStatus = 'only';
    if (filterCriteria.editedStatus === EditedStatus.UneditedOnly) dto.editedStatus = 'exclude';

    const records = await invoke<IndexRecord[]>(Invokes.LibraryIndexQuery, { filter: dto });
    if (!Array.isArray(records)) return null;

    const lowerText = searchCriteria.text.trim().toLowerCase();
    const parsedTags = searchCriteria.tags.map((tag) => tag.toLowerCase());
    const colors = filterCriteria.colors || [];
    const needUnrated = rating === -1;

    const matched = new Set<string>();
    for (const rec of records) {
      if (needUnrated && rec.rating !== 0) continue;

      const tags = rec.tags ?? [];
      const lowerTags = tags.map((t) => t.toLowerCase().replace('user:', ''));

      if (colors.length > 0) {
        const colorTag = tags.find((t) => t.startsWith('color:'))?.substring(6);
        const hasColor = colorTag !== undefined && colors.includes(colorTag);
        const matchesNone = colorTag === undefined && colors.includes('none');
        if (!hasColor && !matchesNone) continue;
      }

      if (parsedTags.length > 0) {
        const ok =
          searchCriteria.mode === 'OR'
            ? parsedTags.some((pt) => lowerTags.some((h) => h.includes(pt)))
            : parsedTags.every((pt) => lowerTags.some((h) => h.includes(pt)));
        if (!ok) continue;
      }

      if (lowerText) {
        const filename = rec.filename.toLowerCase();
        if (!filename.includes(lowerText) && !lowerTags.some((t) => t.includes(lowerText))) continue;
      }

      matched.add(rec.path);
    }
    return matched;
  } catch {
    return null;
  }
}
