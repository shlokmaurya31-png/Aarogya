"use client";

/**
 * Phase E1 — full Notification Center page. Lists the caller's own
 * notifications with an All / Unread filter, per-row mark-read, and
 * mark-all-read. Ownership-scoped server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Inbox } from "lucide-react";
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

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function NotificationsView() {
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/hospital/notifications?filter=${filter}&limit=100`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setItems(data.items ?? []);
        setUnread(data.unreadCount ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = useCallback(async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    await fetch(`/api/hospital/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnread(0);
    await fetch(`/api/hospital/notifications/read-all`, { method: "POST" }).catch(() => {});
    if (filter === "unread") load();
  }, [filter, load]);

  const onOpen = useCallback(
    async (n: NotificationDto) => {
      if (!n.readAt) await markRead(n.id);
      if (n.linkHref) router.push(n.linkHref);
    },
    [markRead, router]
  );

  const visible = filter === "unread" ? items.filter((n) => !n.readAt) : items;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Notifications</h1>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            {unread > 0 ? `${unread} unread` : "You're all caught up."}
          </p>
        </div>
        {unread > 0 && (
          <button
            onClick={markAllRead}
            className="focus-ring flex items-center gap-1.5 rounded-control border border-hairline px-2.5 py-1.5 text-[12.5px] font-medium text-brand hover:bg-fill-hover"
          >
            <CheckCheck size={15} /> Mark all read
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-1.5">
        {(["all", "unread"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "focus-ring rounded-control px-3 py-1.5 text-[12.5px] font-medium capitalize",
              filter === f ? "bg-brand text-white" : "border border-hairline text-text-secondary hover:bg-fill-hover"
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-hairline bg-card">
        {loading ? (
          <div className="px-4 py-12 text-center text-[13px] text-text-secondary">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <Inbox size={28} className="text-text-tertiary" />
            <p className="text-[13px] text-text-secondary">
              {filter === "unread" ? "No unread notifications." : "No notifications yet."}
            </p>
          </div>
        ) : (
          visible.map((n) => (
            <button
              key={n.id}
              onClick={() => onOpen(n)}
              className={cn(
                "flex w-full items-start gap-3 border-b border-hairline px-4 py-3 text-left last:border-b-0 hover:bg-fill-hover",
                !n.readAt && "bg-brand-subtle/40"
              )}
            >
              <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", PRIORITY_DOT[n.priority] ?? "bg-brand")} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className={cn("truncate text-[13.5px]", n.readAt ? "text-text-secondary" : "font-semibold text-text-primary")}>
                    {n.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">{formatWhen(n.createdAt)}</span>
                </span>
                {n.body && <span className="mt-0.5 block text-[12.5px] text-text-secondary">{n.body}</span>}
                <span className="mt-1 flex items-center gap-2">
                  <span className="rounded-full bg-fill-hover px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                    {n.category}
                  </span>
                  {n.priority !== "ROUTINE" && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        n.priority === "CRITICAL" ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning"
                      )}
                    >
                      {n.priority}
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
