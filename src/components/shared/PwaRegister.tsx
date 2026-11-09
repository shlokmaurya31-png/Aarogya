"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { clearAppCaches, isSignInPath } from "@/lib/pwa/clearCaches";

export function PwaRegister() {
  const pathname = usePathname();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      // Turbopack's dev server reuses stable chunk URLs with different
      // content across restarts. A cache-first service worker left over
      // from an earlier session serves stale JS from those URLs and
      // silently breaks client interactivity, so keep dev clean.
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => reg.unregister());
      });
      if ("caches" in window) {
        caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
      }
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  // Flagship 4 (3): a sign-in page is where logout and an expired session
  // land, so nothing cached outlives the session.
  useEffect(() => {
    if (pathname && isSignInPath(pathname)) void clearAppCaches();
  }, [pathname]);

  return null;
}
