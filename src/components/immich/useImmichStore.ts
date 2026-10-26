import { create } from 'zustand';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  getImmichApiKey,
  getImmichSyncStatus,
  ImmichAlbum,
  ImmichSyncStatus,
  ImmichTimelineMonth,
  listImmichAlbums,
  listImmichTimeline,
} from './immichApi';

interface ImmichState {
  isConfigured: boolean;
  albums: ImmichAlbum[];
  isLoading: boolean;
  error: string | null;
  timeline: ImmichTimelineMonth[];
  syncStatus: ImmichSyncStatus;
  setSyncStatus(syncStatus: ImmichSyncStatus): void;
  loadTimeline(): Promise<void>;
  refresh(): Promise<void>;
  loadAlbums(): Promise<void>;
}

let albumsRequestId = 0;

export const useImmichStore = create<ImmichState>((set, get) => ({
  isConfigured: false,
  albums: [],
  isLoading: false,
  error: null,
  timeline: [],
  syncStatus: { offline: false, pending: 0 },
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  loadTimeline: async () => {
    try {
      set({ timeline: await listImmichTimeline() });
    } catch (err) {
      console.error('Failed to load the Immich timeline:', err);
    }
  },

  refresh: async () => {
    try {
      const serverUrl = useSettingsStore.getState().appSettings?.immich?.serverUrl?.trim() ?? '';
      const apiKey = serverUrl ? (await getImmichApiKey()).apiKey : '';
      const isConfigured = !!serverUrl && !!apiKey.trim();
      set({ isConfigured, ...(isConfigured ? {} : { albums: [], error: null }) });
      if (isConfigured) {
        set({ syncStatus: await getImmichSyncStatus() });
        await get().loadAlbums();
      }
    } catch (err) {
      console.error('Failed to read Immich settings:', err);
    }
  },

  loadAlbums: async () => {
    const requestId = ++albumsRequestId;
    set({ isLoading: true, error: null });
    try {
      const albums = await listImmichAlbums();
      if (requestId !== albumsRequestId) return;
      set({ albums });
    } catch (err) {
      if (requestId !== albumsRequestId) return;
      set({ error: String(err) });
    } finally {
      if (requestId === albumsRequestId) {
        set({ isLoading: false });
      }
    }
  },
}));
