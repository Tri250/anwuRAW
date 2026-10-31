import { create } from 'zustand';
import { ImageFile } from '../components/ui/AppProperties';
import { loadUserData, saveUserData } from '../utils/libraryUserData';
import { PhotoStack, detectBurstStacks, findStackForPath } from '../utils/stacking';

interface StacksState {
  stacks: PhotoStack[];
  /** Stacks render expanded in the grid; new stacks start collapsed. */
  expandedStackIds: Set<string>;

  createStack: (paths: string[]) => PhotoStack | null;
  unstack: (stackId: string) => void;
  addPathsToStack: (stackId: string, paths: string[]) => void;
  removeFromStack: (path: string) => void;
  autoStackBursts: (images: ImageFile[]) => number;
  toggleExpanded: (stackId: string) => void;
  setExpanded: (stackId: string, expanded: boolean) => void;
  removePathsFromStacks: (paths: string[]) => void;
}

const STACKS_KEY = 'stacks.v1';
const EXPANDED_KEY = 'stacks.expanded.v1';

const isStackArray = (value: unknown): value is PhotoStack[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as PhotoStack).id === 'string' &&
      Array.isArray((item as PhotoStack).paths) &&
      (item as PhotoStack).paths.every((p) => typeof p === 'string'),
  );

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const toStringSet = (value: unknown): Set<string> =>
  new Set(isStringArray(value) ? value : []);

const persist = (state: StacksState) => {
  saveUserData(STACKS_KEY, state.stacks);
  saveUserData(EXPANDED_KEY, Array.from(state.expandedStackIds));
};

const pruneStacks = (stacks: PhotoStack[]): PhotoStack[] =>
  stacks
    .map((stack) => ({ ...stack, paths: Array.from(new Set(stack.paths)) }))
    .filter((stack) => stack.paths.length >= 2);

export const useStacksStore = create<StacksState>((set, get) => ({
  stacks: pruneStacks(loadUserData<PhotoStack[]>(STACKS_KEY, [], isStackArray)),
  expandedStackIds: toStringSet(loadUserData<unknown>(EXPANDED_KEY, [])),

  createStack: (paths) => {
    const unique = Array.from(new Set(paths));
    if (unique.length < 2) return null;

    const { stacks } = get();
    const claimed = new Set(stacks.flatMap((stack) => stack.paths));
    const freePaths = unique.filter((path) => !claimed.has(path));
    if (freePaths.length < 2) return null;

    const stack: PhotoStack = { id: crypto.randomUUID(), paths: freePaths };
    set((state) => ({ stacks: [...state.stacks, stack] }));
    persist(get());
    return stack;
  },

  unstack: (stackId) => {
    set((state) => {
      const expandedStackIds = new Set(state.expandedStackIds);
      expandedStackIds.delete(stackId);
      return { stacks: state.stacks.filter((stack) => stack.id !== stackId), expandedStackIds };
    });
    persist(get());
  },

  addPathsToStack: (stackId, paths) => {
    set((state) => ({
      stacks: state.stacks.map((stack) =>
        stack.id === stackId
          ? { ...stack, paths: Array.from(new Set([...stack.paths, ...paths])) }
          : stack,
      ),
    }));
    set((state) => ({ stacks: pruneStacks(state.stacks) }));
    persist(get());
  },

  removeFromStack: (path) => {
    set((state) => {
      const stacks = state.stacks.map((stack) =>
        stack.paths.includes(path) ? { ...stack, paths: stack.paths.filter((p) => p !== path) } : stack,
      );
      return { stacks: pruneStacks(stacks) };
    });
    persist(get());
  },

  removePathsFromStacks: (paths) => {
    const toRemove = new Set(paths);
    set((state) => {
      const stacks = state.stacks.map((stack) => ({
        ...stack,
        paths: stack.paths.filter((p) => !toRemove.has(p)),
      }));
      return { stacks: pruneStacks(stacks) };
    });
    persist(get());
  },

  autoStackBursts: (images) => {
    const { stacks } = get();
    const detected = detectBurstStacks(images, stacks);
    if (detected.length === 0) return 0;
    set((state) => ({ stacks: [...state.stacks, ...detected] }));
    persist(get());
    return detected.length;
  },

  toggleExpanded: (stackId) => {
    set((state) => {
      const expandedStackIds = new Set(state.expandedStackIds);
      if (expandedStackIds.has(stackId)) expandedStackIds.delete(stackId);
      else expandedStackIds.add(stackId);
      return { expandedStackIds };
    });
    persist(get());
  },

  setExpanded: (stackId, expanded) => {
    set((state) => {
      const expandedStackIds = new Set(state.expandedStackIds);
      if (expanded) expandedStackIds.add(stackId);
      else expandedStackIds.delete(stackId);
      return { expandedStackIds };
    });
    persist(get());
  },
}));

export const getStackContext = () => {
  const { stacks, expandedStackIds } = useStacksStore.getState();
  return { stacks, expandedStackIds };
};

export { findStackForPath };
