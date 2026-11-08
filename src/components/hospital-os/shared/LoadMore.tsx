"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Flagship 2d — "load more" for a paged list: loads the next page when it
 * scrolls into view, and is a real button for keyboards, screen readers and
 * browsers without IntersectionObserver.
 */
export function LoadMore({ onLoad, label }: { onLoad: () => Promise<void>; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const trigger = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try { await onLoad(); } finally { busy.current = false; setLoading(false); }
  }, [onLoad]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void trigger(); }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [trigger]);
  return (
    <button ref={ref} type="button" onClick={() => void trigger()} disabled={loading} aria-label={label} className="mt-1 rounded-md border border-hairline px-2.5 py-1 text-[11px] text-text-secondary hover:border-cyan/40 disabled:opacity-50">
      {loading ? "Loading…" : "Show more"}
    </button>
  );
}
