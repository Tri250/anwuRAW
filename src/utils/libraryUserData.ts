/**
 * Frontend-scoped library user data persistence.
 *
 * The backend persists settings through a strongly-typed Rust struct
 * (`AppSettings`) and albums through a closed serde enum (`AlbumItem`), so
 * new shapes such as photo stacks or smart-album rules cannot round-trip
 * through `save_settings` / `save_albums` without backend changes. Library
 * features owned by the frontend (stacks, smart albums, onboarding state)
 * therefore persist in the WebView's localStorage under a versioned,
 * namespaced key with defensive parsing.
 */

const PREFIX = 'rapidraw.library.';

export function loadUserData<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function saveUserData<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.warn('Failed to persist library user data:', key, err);
  }
}

export function removeUserData(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // Ignore storage failures (private mode, quota).
  }
}
