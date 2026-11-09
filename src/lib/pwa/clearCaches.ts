/**
 * Flagship 4 (3) — on logout and on session expiry, nothing the app cached may
 * outlive the session. Deletes every Cache Storage entry the main app owns and
 * tells its service worker to do the same. The ward tablet's own cache
 * ("aarogya-ward-*": that app's code only, see public/ward-sw.js) and its
 * encrypted IndexedDB store are left to the ward app.
 */
export const WARD_CACHE_PREFIX = "aarogya-ward";

/** The sign-in pages: reaching one (after logout, or redirected there when the session expired) clears the caches. */
export function isSignInPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/patient-login" || pathname.endsWith("/login");
}

export async function clearAppCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "aarogya:clear-caches" });
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(WARD_CACHE_PREFIX)).map((k) => caches.delete(k)));
  } catch {
    // Cache Storage unavailable (private window, blocked storage): nothing to clear.
  }
}
