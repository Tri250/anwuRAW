// W9-I3 图库虚拟化 10 万张 + 索引数据源消费（依赖 B3）
//
// 两层断言：
//   A. 索引查询语义与本地过滤（computeSortedLibrary）完全对齐 —— 指纹一致才消费捷径，
//      任何不支持场景（高级查询/虚拟副本/覆盖率不足/索引不可用）必须回退 null。
//   B. LibraryGrid 挂载 100,000 张时渲染节点数有界（虚拟化生效），
//      挂载与滚动交互的主线程耗时低于掉帧预算（粗粒度 jsdom 预算）。
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { mockInvoke } from './setup';
import {
  INDEX_ACCEL_THRESHOLD,
  indexAccelSupported,
  filterFingerprint,
  queryIndexMatchedPaths,
} from '../../src/services/libraryIndexService';
import type { SearchCriteriaShape } from '../../src/services/libraryIndexService';
import { computeSortedLibrary } from '../../src/hooks/useSortedLibrary';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import LibraryGrid from '../../src/components/panel/library/LibraryGrid';
import {
  Invokes,
  ImageFile,
  FilterCriteria,
  RawStatus,
  EditedStatus,
  LibraryViewMode,
  LibraryDisplayMode,
  ThumbnailAspectRatio,
} from '../../src/components/ui/AppProperties';

const TOTAL = INDEX_ACCEL_THRESHOLD * 1.2; // 24,000 张：满足索引加速门槛

function buildImageList(count: number): ImageFile[] {
  const list: ImageFile[] = [];
  for (let i = 0; i < count; i++) {
    const tags: string[] = [];
    if (i % 5 === 0) tags.push('color:red');
    if (i % 7 === 0) tags.push('user:portrait');
    if (i % 11 === 0) tags.push('travel');
    list.push({
      path: `/lib/folder${i % 10}/IMG_${String(i).padStart(6, '0')}.jpg`,
      modified: 1700000000 + i,
      is_edited: i % 4 === 0,
      rating: i % 6,
      tags: tags.length > 0 ? tags : null,
      exif: null,
      is_virtual_copy: false,
      is_cloud_placeholder: false,
      is_raw: i % 3 === 0,
      group_id: null,
    });
  }
  return list;
}

function buildIndexRecords(list: ImageFile[]) {
  return list.map((img) => {
    const parts = img.path.split('/');
    return {
      path: img.path,
      folder: parts.slice(0, -1).join('/'),
      filename: parts[parts.length - 1],
      isRaw: img.is_raw,
      rating: img.rating,
      edited: img.is_edited,
      tags: img.tags,
    };
  });
}

/** 模拟 SQL 层（索引列语义），JS 层（色标/标签/文本）由被测服务完成。 */
function mockIndexBackend(records: ReturnType<typeof buildIndexRecords>) {
  mockInvoke.mockImplementation(async (cmd: string, args?: { filter?: Record<string, unknown> }) => {
    if (cmd === Invokes.LibraryIndexStats) return { available: true, count: records.length };
    if (cmd === Invokes.LibraryIndexQuery) {
      const f = (args?.filter ?? {}) as {
        minRating?: number;
        rawStatus?: string;
        editedStatus?: string;
      };
      return records.filter(
        (r) =>
          (f.minRating == null || r.rating >= f.minRating) &&
          (f.rawStatus !== 'only' || r.isRaw) &&
          (f.rawStatus !== 'exclude' || !r.isRaw) &&
          (f.editedStatus !== 'only' || r.edited) &&
          (f.editedStatus !== 'exclude' || !r.edited),
      );
    }
    return undefined;
  });
}

const BASE_FILTER = { colors: [] as string[], rating: 0, rawStatus: RawStatus.All };
const BASE_SEARCH: SearchCriteriaShape = { tags: [], text: '', mode: 'OR' };

function localPaths(
  list: ImageFile[],
  filterCriteria: FilterCriteria,
  searchCriteria: SearchCriteriaShape,
  ratings: Record<string, number>,
) {
  const out = computeSortedLibrary(
    {
      imageList: list,
      imageRatings: ratings,
      filterCriteria,
      searchCriteria,
      sortCriteria: { key: 'name', order: 'asc' },
    },
    { appSettings: null },
  );
  return new Set(out.map((img) => img.path));
}

describe('W9-I3 索引消费：回退语义', () => {
  it('低于阈值不触发查询（零 invoke）', async () => {
    const list = buildImageList(10);
    const matched = await queryIndexMatchedPaths(list, BASE_FILTER, BASE_SEARCH);
    expect(matched).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('高级查询标签（iso:/camera:）回退本地', async () => {
    const list = buildImageList(TOTAL);
    expect(indexAccelSupported(list, { tags: ['iso:100'], text: '', mode: 'OR' })).toBe(false);
    expect(indexAccelSupported(list, { tags: ['camera:sony'], text: '', mode: 'AND' })).toBe(false);
    const matched = await queryIndexMatchedPaths(list, BASE_FILTER, { tags: ['iso:100'], text: '', mode: 'OR' });
    expect(matched).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('虚拟副本库回退本地（索引 1:N 不可短路）', () => {
    const list = buildImageList(10);
    list[0] = { ...list[0], path: `${list[0].path}?vc=1`, is_virtual_copy: true };
    expect(indexAccelSupported(list, BASE_SEARCH)).toBe(false);
  });

  it('索引不可用 / 覆盖率不足 / invoke 抛错 → null', async () => {
    const list = buildImageList(TOTAL);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === Invokes.LibraryIndexStats) return { available: false, count: null };
      return [];
    });
    expect(await queryIndexMatchedPaths(list, BASE_FILTER, BASE_SEARCH)).toBeNull();

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === Invokes.LibraryIndexStats) return { available: true, count: 100 }; // 覆盖率不足
      return [];
    });
    expect(await queryIndexMatchedPaths(list, BASE_FILTER, BASE_SEARCH)).toBeNull();

    mockInvoke.mockRejectedValue(new Error('index corrupted'));
    expect(await queryIndexMatchedPaths(list, BASE_FILTER, BASE_SEARCH)).toBeNull();
  });
});

describe('W9-I3 索引消费：与本地过滤语义对齐', () => {
  const list = buildImageList(TOTAL);
  const records = buildIndexRecords(list);
  const ratings: Record<string, number> = {};
  list.forEach((img) => (ratings[img.path] = img.rating));

  beforeEach(() => mockIndexBackend(records));

  async function assertParity(filterCriteria: FilterCriteria, searchCriteria: SearchCriteriaShape) {
    const matched = await queryIndexMatchedPaths(list, filterCriteria, searchCriteria);
    expect(matched).not.toBeNull();
    const expected = localPaths(list, filterCriteria, searchCriteria, ratings);
    expect(matched!.size).toBe(expected.size);
    for (const p of expected) expect(matched!.has(p)).toBe(true);
  }

  it('rating ≥ 3', () => assertParity({ ...BASE_FILTER, rating: 3 }, BASE_SEARCH));

  it('unrated（-1）精确语义', () => assertParity({ ...BASE_FILTER, rating: -1 }, BASE_SEARCH));

  it('色标过滤（含 none 特例）', () => assertParity({ ...BASE_FILTER, colors: ['red', 'none'] }, BASE_SEARCH));

  it('标签搜索 OR 模式', () => assertParity(BASE_FILTER, { tags: ['portrait', 'travel'], text: '', mode: 'OR' }));

  it('标签搜索 AND 模式', () => assertParity(BASE_FILTER, { tags: ['portrait', 'travel'], text: '', mode: 'AND' }));

  it('文件名文本搜索', () => assertParity(BASE_FILTER, { tags: [], text: 'IMG_000', mode: 'OR' }));

  it('组合条件（raw + edited + 色标 + 文本）', () =>
    assertParity(
      { ...BASE_FILTER, rawStatus: RawStatus.RawOnly, editedStatus: EditedStatus.EditedOnly, colors: ['red'] },
      { tags: [], text: 'IMG_00', mode: 'OR' },
    ));

  it('指纹随条件变化（捷径失效判定）', () => {
    const a = filterFingerprint(BASE_FILTER, BASE_SEARCH);
    const b = filterFingerprint({ ...BASE_FILTER, rating: 3 }, BASE_SEARCH);
    const c = filterFingerprint(BASE_FILTER, { ...BASE_SEARCH, text: 'x' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('store 接线：捷径集合写入后 computeGroupedLibrary 消费且与本地结果一致', async () => {
    const filterCriteria = { ...BASE_FILTER, rating: 3 };
    const matched = await queryIndexMatchedPaths(list, filterCriteria, BASE_SEARCH);
    const fingerprint = filterFingerprint(filterCriteria, BASE_SEARCH);

    const store = useLibraryStore.getState();
    store.setLibrary({
      imageList: list,
      imageRatings: ratings,
      filterCriteria,
      indexMatchedPaths: matched,
      indexMatchedKey: fingerprint,
    });

    const shortcutOut = computeSortedLibrary(useLibraryStore.getState(), { appSettings: null });
    const localOut = localPaths(list, filterCriteria, BASE_SEARCH, ratings);
    expect(shortcutOut.length).toBe(localOut.size);
    shortcutOut.forEach((img) => expect(localOut.has(img.path)).toBe(true));

    // 指纹过期（条件已变）→ 捷径失效，回本地
    const staleOut = computeSortedLibrary(
      { ...useLibraryStore.getState(), indexMatchedPaths: new Set([list[0].path]), indexMatchedKey: 'stale' },
      { appSettings: null },
    );
    expect(staleOut.length).toBe(localOut.size);

    store.setLibrary({ imageList: [], imageRatings: {}, indexMatchedPaths: null, indexMatchedKey: null });
  });
});

// ---- Part B: LibraryGrid 10 万张虚拟化 + 掉帧断言 ----

class MockResizeObserver {
  static lastEntry = { width: 1200, height: 800 };
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    const { width, height } = MockResizeObserver.lastEntry;
    const entry = {
      contentRect: { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0 },
    } as ResizeObserverEntry;
    this.cb([entry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

function makeGridProps(imageList: ImageFile[]) {
  return {
    imageList,
    libraryViewMode: LibraryViewMode.Flat,
    libraryDisplayMode: LibraryDisplayMode.Grid,
    thumbnailSize: 'medium',
    thumbnailSizeOptions: [{ id: 'medium', size: 240 }],
    thumbnailAspectRatio: ThumbnailAspectRatio.Cover,
    currentFolderPath: null,
    activePath: null,
    multiSelectedPaths: [] as string[],
    imageRatings: {},
    onRequestThumbnails: vi.fn(),
    onThumbnailSizeChange: vi.fn(),
    onContextMenu: vi.fn(),
    onImageClick: vi.fn(),
    onImageDoubleClick: vi.fn(),
    onClearSelection: vi.fn(),
    onEmptyAreaContextMenu: vi.fn(),
    groupBadgeInfo: null,
  };
}

describe('W9-I3 LibraryGrid 10 万张虚拟化掉帧断言', () => {
  const MOUNT_BUDGET_MS = 3000; // jsdom 粗粒度预算（真实环境以 60fps 帧预算衡量）
  const SCROLL_TICK_BUDGET_MS = 300; // jsdom 预热后单次滚动重渲染预算
  const RENDER_BOUND = 200; // 虚拟化：DOM 节点数与总量无关

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver as unknown as typeof ResizeObserver);
  });

  it('100,000 张挂载：渲染节点有界 + 挂载预算内', async () => {
    const bigList = buildImageList(100_000);

    const t0 = performance.now();
    const { container } = render(<LibraryGrid {...makeGridProps(bigList)} />);
    const mountMs = performance.now() - t0;

    const thumbs = container.querySelectorAll('[data-bench-id="thumbnail"]');
    expect(bigList).toHaveLength(100_000);
    expect(thumbs.length).toBeGreaterThan(0);
    expect(thumbs.length).toBeLessThan(RENDER_BOUND);
    expect(mountMs).toBeLessThan(MOUNT_BUDGET_MS);
  });

  it('滚动交互：窗口迁移 + 渲染节点恒有界 + 逐次滚动预算内', async () => {
    const batches: string[][] = [];
    const props = makeGridProps(buildImageList(100_000));
    props.onRequestThumbnails = vi.fn((paths: string[]) => batches.push(paths));

    const { container } = render(<LibraryGrid {...props} />);
    const scroller = container.querySelector('.custom-scrollbar') as HTMLElement;
    expect(scroller).not.toBeNull();

    const tick = (top: number) => {
      const t0 = performance.now();
      act(() => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      return performance.now() - t0;
    };

    tick(0); // 预热（JIT/模块初始化，不参与预算断言）
    await waitFor(() => expect(batches.length).toBeGreaterThan(0));
    const firstWindow = new Set(batches[0]);
    expect(firstWindow.size).toBeGreaterThan(0);
    expect(batches[0].length).toBeLessThan(RENDER_BOUND);

    // 连续 5 次滚动：每次都在帧预算内，DOM 节点恒有界
    for (let i = 1; i <= 5; i++) {
      const tickMs = tick(i * 8000);
      expect(tickMs).toBeLessThan(SCROLL_TICK_BUDGET_MS);
      const thumbs = container.querySelectorAll('[data-bench-id="thumbnail"]');
      expect(thumbs.length).toBeGreaterThan(0);
      expect(thumbs.length).toBeLessThan(RENDER_BOUND);
    }

    // 窗口确实迁移（缩略图请求集合随滚动变化，而非全量渲染）
    tick(48000);
    await waitFor(() => expect(batches.length).toBeGreaterThan(1));
    const lastBatch = batches[batches.length - 1];
    expect(lastBatch.some((p) => !firstWindow.has(p))).toBe(true);
  });
});
