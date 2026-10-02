// Збереження завантажених користувачем карт (IndexedDB) і стану поїздки (localStorage).

const DB_NAME = 'nav-offline';
const STORE = 'maps';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const saveMap = (data) => tx('readwrite', (s) => s.put(data, 'current'));
export const loadSavedMap = () => tx('readonly', (s) => s.get('current'));
export const clearSavedMap = () => tx('readwrite', (s) => s.delete('current'));

const TRIP_KEY = 'nav-offline-trip';

export function saveTrip(state) {
  try {
    if (state) localStorage.setItem(TRIP_KEY, JSON.stringify(state));
    else localStorage.removeItem(TRIP_KEY);
  } catch { /* приватний режим тощо */ }
}

export function loadTrip() {
  try {
    return JSON.parse(localStorage.getItem(TRIP_KEY) || 'null');
  } catch {
    return null;
  }
}
