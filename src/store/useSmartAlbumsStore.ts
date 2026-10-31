import { create } from 'zustand';
import { loadUserData, saveUserData } from '../utils/libraryUserData';
import { SmartAlbum } from '../utils/smartAlbums';

interface SmartAlbumsState {
  albums: SmartAlbum[];
  createAlbum: (name: string, rules: SmartAlbum['rules'], match: SmartAlbum['match']) => SmartAlbum;
  updateAlbum: (id: string, updates: Partial<Pick<SmartAlbum, 'name' | 'rules' | 'match'>>) => void;
  removeAlbum: (id: string) => void;
}

const ALBUMS_KEY = 'smartAlbums.v1';

const isSmartAlbumArray = (value: unknown): value is SmartAlbum[] =>
  Array.isArray(value) &&
  value.every((item) => {
    const album = item as SmartAlbum;
    return (
      typeof item === 'object' &&
      item !== null &&
      album.type === 'smart' &&
      typeof album.id === 'string' &&
      typeof album.name === 'string' &&
      (album.match === 'all' || album.match === 'any') &&
      Array.isArray(album.rules)
    );
  });

export const useSmartAlbumsStore = create<SmartAlbumsState>((set, get) => ({
  albums: loadUserData<SmartAlbum[]>(ALBUMS_KEY, [], isSmartAlbumArray),

  createAlbum: (name, rules, match) => {
    const album: SmartAlbum = { type: 'smart', id: crypto.randomUUID(), name, rules, match };
    set((state) => ({ albums: [...state.albums, album] }));
    saveUserData(ALBUMS_KEY, get().albums);
    return album;
  },

  updateAlbum: (id, updates) => {
    set((state) => ({
      albums: state.albums.map((album) => (album.id === id ? { ...album, ...updates } : album)),
    }));
    saveUserData(ALBUMS_KEY, get().albums);
  },

  removeAlbum: (id) => {
    set((state) => ({ albums: state.albums.filter((album) => album.id !== id) }));
    saveUserData(ALBUMS_KEY, get().albums);
  },
}));
