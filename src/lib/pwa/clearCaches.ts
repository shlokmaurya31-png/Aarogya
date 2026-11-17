/**
 * Flagship 4 (3) — on logout and on session expiry, nothing the app cached may
 * outlive the session. Deletes every Cache Storage entry the main app owns and
 * tells its service worker to do the same. The ward tablet's own cache
 * ("aarogya-ward-*": that app's code only, see public/ward-sw.js) and its
 * encrypted IndexedDB store are left to the ward app.
 *
 * Flagship 5c — and nothing the app or a library kept in the browser's
 * storage: sessionStorage is emptied, localStorage keeps only the device's
 * theme and language, and every IndexedDB database but the ward store is
 * deleted (docs/PRIVACY_STORAGE_AUDIT.md).
 */
export const WARD_CACHE_PREFIX = "aarogya-ward";
/** The ward tablet's sealed store (src/lib/ward/store.ts): its outbox may hold records not yet synced, so only the ward app deletes it. */
export const WARD_DB = "aarogya-ward";
/** Device preferences that outlive a session: no person's data. */
export const KEPT_LOCAL_KEYS: readonly string[] = ["aarogya-theme", "aarogya-language"];

/** The sign-in pages: reaching one (after logout, or redirected there when the session expired) clears the caches. */
export function isSignInPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/patient-login" || pathname.endsWith("/login");
}

/** Which localStorage keys a logout removes (everything but the device preferences). */
export function localKeysToClear(keys: readonly string[]): string[] {
  return keys.filter((k) => !KEPT_LOCAL_KEYS.includes(k));
}

export async function clearAppData(): Promise<void> {
  try {
    sessionStorage.clear();
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => k !== null);
    for (const k of localKeysToClear(keys)) localStorage.removeItem(k);
  } catch {
    // Storage blocked (private window, site data blocked): nothing to clear.
  }
  try {
    if (typeof indexedDB !== "undefined" && "databases" in indexedDB) {
      for (const { name } of await indexedDB.databases()) {
        if (name && name !== WARD_DB) await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
      }
    }
  } catch {
    // IndexedDB unavailable: nothing to clear.
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "aarogya:clear-caches" });
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(WARD_CACHE_PREFIX)).map((k) => caches.delete(k)));
  } catch {
    // Cache Storage unavailable (private window, blocked storage): nothing to clear.
  }
}
