import { ImageFile } from '../components/ui/AppProperties';
import { GroupBadgeInfo, GroupId } from './imageGrouping';

export interface PhotoStack {
  id: string;
  /** Ordered member paths. The first path is the stack cover shown when collapsed. */
  paths: string[];
}

export interface StackBadgeInfo extends GroupBadgeInfo {
  stackId: string;
  isExpanded: boolean;
  topPath: string;
}

/** Badge keys are namespaced so they cannot collide with backend RAW+JPG group ids. */
export const STACK_BADGE_PREFIX = 'stack:';

export const stackBadgeKey = (stackId: string): GroupId => `${STACK_BADGE_PREFIX}${stackId}`;

export interface StackingContext {
  stacks: PhotoStack[];
  expandedStackIds: Set<string>;
}

/**
 * Collapses stacked photos out of the display list. A collapsed stack shows
 * only its cover (the first member present in the list); an expanded stack
 * keeps all members so they can be culled or rearranged.
 */
export function applyStacking(images: ImageFile[], context: StackingContext): ImageFile[] {
  if (context.stacks.length === 0) return images;

  const indexByPath = new Map(images.map((img, index) => [img.path, index]));
  const hiddenPaths = new Set<string>();

  for (const stack of context.stacks) {
    const members = stack.paths.filter((path) => indexByPath.has(path));
    if (members.length < 2) continue;
    if (context.expandedStackIds.has(stack.id)) continue;

    const cover = members.find((path) => images[indexByPath.get(path)!].group_id === null) ?? members[0];
    for (const path of members) {
      if (path !== cover) hiddenPaths.add(path);
    }
  }

  if (hiddenPaths.size === 0) return images;
  return images.filter((img) => !hiddenPaths.has(img.path));
}

export function buildStackBadges(images: ImageFile[], context: StackingContext): Map<GroupId, StackBadgeInfo> {
  const badges = new Map<GroupId, StackBadgeInfo>();
  if (context.stacks.length === 0) return badges;

  const present = new Set(images.map((img) => img.path));
  const variantLabel = (path: string) => {
    const clean = path.split('?')[0];
    const dot = clean.lastIndexOf('.');
    return dot === -1 ? 'FILE' : clean.substring(dot + 1).toUpperCase();
  };

  for (const stack of context.stacks) {
    const members = stack.paths.filter((path) => present.has(path));
    if (members.length < 2) continue;
    badges.set(stackBadgeKey(stack.id), {
      count: members.length,
      label: Array.from(new Set(members.map(variantLabel))).sort().join('+'),
      stackId: stack.id,
      isExpanded: context.expandedStackIds.has(stack.id),
      topPath: members[0],
    });
  }

  return badges;
}

export function findStackForPath(stacks: PhotoStack[], path: string): PhotoStack | undefined {
  return stacks.find((stack) => stack.paths.includes(path));
}

/**
 * Expands selection/operation paths: operating on any member of a collapsed
 * stack applies to the whole stack, mirroring RAW+JPG group behaviour.
 */
export function expandStackedPaths(
  images: ImageFile[],
  paths: string[],
  context: StackingContext,
): string[] {
  if (context.stacks.length === 0 || paths.length === 0) return Array.from(new Set(paths));

  const present = new Set(images.map((img) => img.path));
  const expanded = new Set(paths);

  for (const path of paths) {
    const stack = findStackForPath(context.stacks, path);
    if (!stack || context.expandedStackIds.has(stack.id)) continue;
    for (const member of stack.paths) {
      if (present.has(member)) expanded.add(member);
    }
  }

  return Array.from(expanded);
}

/**
 * Detects bracket/burst sequences from file names. Photos shot in bursts or
 * brackets typically share a stem plus a numeric or marker suffix
 * (`DSC_1234-1`, `IMG_0042 (2)`, `P1010001_HDR`, `A7R_0091-0` …). Groups with
 * at least two members in the same directory become suggested stacks.
 */
export function detectBurstStacks(images: ImageFile[], existingStacks: PhotoStack[]): PhotoStack[] {
  const basename = (path: string) => path.split('?vc=')[0].split(/[\\/]/).pop() || path;
  const directoryOf = (path: string) => {
    const physical = path.split('?vc=')[0];
    const separator = physical.includes('/') ? '/' : '\\';
    const lastSep = physical.lastIndexOf(separator);
    return lastSep > -1 ? physical.substring(0, lastSep) : '';
  };

  // "IMG_1234-1.jpg" -> ("IMG_1234", "-1"); "P1010001_HDR.dng" -> ("P1010001", "_HDR")
  const stemMarker = /^(.*?)(?:[-_ ]\d{1,3}|[-_ ]\(\d+\)|[-_ ]HDR|[-_ ]BRACKET\d*|[-_ ]EXP\d*)$/i;
  const buckets = new Map<string, { path: string; sequence: number }[]>();

  for (const image of images) {
    if (image.is_virtual_copy) continue;
    const dir = directoryOf(image.path);
    const name = basename(image.path);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.substring(0, dot) : name;
    const match = stem.match(stemMarker);
    if (!match) continue;
    const base = `${dir}\u0000${match[1]}`;
    const suffix = match[0].slice(match[1].length);
    const seq = parseInt(suffix.replace(/\D/g, ''), 10);
    const entry = { path: image.path, sequence: isNaN(seq) ? 0 : seq };
    const bucket = buckets.get(base);
    if (bucket) bucket.push(entry);
    else buckets.set(base, [entry]);
  }

  const stackedPaths = new Set(existingStacks.flatMap((stack) => stack.paths));
  const detected: PhotoStack[] = [];

  for (const members of buckets.values()) {
    const paths = members
      .filter((m) => !stackedPaths.has(m.path))
      .sort((a, b) => a.sequence - b.sequence)
      .map((m) => m.path);
    if (paths.length >= 2) {
      detected.push({ id: crypto.randomUUID(), paths });
    }
  }

  return detected;
}
