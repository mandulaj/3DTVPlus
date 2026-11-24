// Data from the SAC route portal and Skitourenguru is theirs: no open licence, fetched live from
// their servers. It stays off until the person using the viewer switches it on in Settings.
const KEY = 'terrain-viewer.unofficial';
let session = false; // used when browser storage is unavailable

export const unofficial = {
  get enabled(): boolean {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return session;
    }
  },
  set enabled(on: boolean) {
    session = on;
    try {
      if (on) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {
      /* this session only */
    }
  },
};
