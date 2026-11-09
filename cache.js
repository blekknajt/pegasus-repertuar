// Trwały kesz (IndexedDB) na oceny silnika i odpowiedzi bazy partii:
// raz odwiedzona pozycja działa po przeładowaniu strony i bez sieci.
// Wpisy ponad limit wypadają od najdawniej używanych (LRU).
import { kvGet, kvSet } from "./repertoire.js";

export function persistentCache(name, cap) {
  const map = new Map();
  let loaded = null;
  let timer = null;
  const load = () =>
    (loaded ||= kvGet("cache:" + name)
      .then((rows) => {
        if (Array.isArray(rows)) for (const [k, v] of rows) if (!map.has(k)) map.set(k, v);
      })
      .catch(() => {}));
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      while (map.size > cap) map.delete(map.keys().next().value);
      kvSet("cache:" + name, [...map]).catch(() => {});
    }, 1000);
  };
  return {
    async get(key) {
      await load();
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v); // odśwież kolejność — ostatnio użyte wypada ostatnie
      return v;
    },
    async set(key, value) {
      await load();
      map.delete(key);
      map.set(key, value);
      save();
    },
  };
}
