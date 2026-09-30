"use client";

/**
 * Phase E1 — Notification Center bell (Hospital OS header).
 *
 * Replaces the previous static Bell placeholder. Polls the caller's own
 * unread count, and on open shows the most recent notifications with a
 * mark-read / mark-all-read / view-all affordance. Everything is
 * ownership-scoped server-side; this component never sees another staff
 * member's data.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface NotificationDto {
  id: string;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string | null;
  linkHref: string | null;
  readAt: string | null;
  createdAt: string;
}

const PRIORITY_DOT: Record<string, string> = {
  CRITICAL: "bg-danger",
  URGENT: "bg-warning",
  ROUTINE: "bg-brand",
};

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (withList: boolean) => {
    try {
      if (withList) setLoading(true);
      const res = await fetch(`/api/hospital/notifications?limit=10`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setUnread(data.unreadCount ?? 0);
      if (withList) setItems(data.items ?? []);
    } catch {
      /* silent — the badge simply won't update this cycle */
    } finally {
      if (withList) setLoading(false);
    }
  }, []);

  // Poll the unread count every 30s (badge only — cheap).
  useEffect(() => {
    refresh(false);
    const t = setInterval(() => refresh(false), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // When the panel opens, load the full recent list.
  useEffect(() => {
    if (open) refresh(true);
  }, [open, refresh]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const markRead = useCallback(async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    await fetch(`/api/hospital/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnread(0);
    await fetch(`/api/hospital/notifications/read-all`, { method: "POST" }).catch(() => {});
  }, []);

  const onItemClick = useCallback(
    async (n: NotificationDto) => {
      if (!n.readAt) await markRead(n.id);
      setOpen(false);
      if (n.linkHref) router.push(n.linkHref);
    },
    [markRead, router]
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring relative flex size-9 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-[16px] text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-[340px] overflow-hidden rounded-lg border border-hairline bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">Notifications</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="focus-ring flex items-center gap-1 rounded-control px-1.5 py-0.5 text-[11px] font-medium text-brand hover:bg-fill-hover"
              >
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[380px] overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-secondary">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-text-secondary">You&apos;re all caught up.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  className={cn(
                    "flex w-full items-start gap-2.5 border-b border-hairline px-3 py-2.5 text-left last:border-b-0 hover:bg-fill-hover",
                    !n.readAt && "bg-brand-subtle/40"
                  )}
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", PRIORITY_DOT[n.priority] ?? "bg-brand")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn("truncate text-[12.5px]", n.readAt ? "text-text-secondary" : "font-semibold text-text-primary")}>
                        {n.title}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-text-tertiary">{timeAgo(n.createdAt)}</span>
                    </span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-[11.5px] text-text-secondary">{n.body}</span>}
                  </span>
                  {!n.readAt && <Check size={13} className="mt-1 shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100" />}
                </button>
              ))
            )}
          </div>

          <Link
            href="/hospital-os/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-hairline px-3 py-2 text-center text-[12px] font-medium text-brand hover:bg-fill-hover"
          >
            View all
          </Link>
        </div>
      )}
    </div>
  );
}
