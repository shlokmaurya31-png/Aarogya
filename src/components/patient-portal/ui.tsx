"use client";

import { useEffect, useState } from "react";

/**
 * Phase D11 — small shared primitives for the patient experience. Deliberately
 * minimal and reused across every page so the portal reads as one system, using
 * the existing Aarogya design tokens (surface/card/hairline/cyan).
 */

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-hairline bg-card p-4 ${className}`}>{children}</div>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-[15px] font-semibold text-text-primary">{children}</h2>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-text-secondary">{children}</p>;
}

/** Honest unavailable state (brief §35) — never rendered as "no data" / "₹0". */
export function Unavailable({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-[13px] text-amber">
      {label} is temporarily unavailable. Please try again shortly.
    </div>
  );
}

/**
 * Fetches a patient API endpoint and renders one of loading / error / data.
 * The error branch shows "temporarily unavailable" — never a fabricated empty
 * state, upholding brief §35 at the presentation layer too.
 */
type FetchState<T> = { status: "loading" } | { status: "error" } | { status: "ok"; data: T };

export function usePatientData<T>(url: string) {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    // setState happens only inside async callbacks (never synchronously in the
    // effect body), matching the repo's accepted fetch-in-effect pattern.
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => alive && setState({ status: "ok", data }))
      .catch(() => alive && setState({ status: "error" }));
    return () => { alive = false; };
  }, [url, reloadKey]);
  return { state, reload: () => setReloadKey((k) => k + 1) };
}

export function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "warn" | "info" }) {
  const tones: Record<string, string> = {
    neutral: "border-hairline text-text-secondary",
    good: "border-success/30 text-success bg-success/5",
    warn: "border-amber/30 text-amber bg-amber/5",
    info: "border-cyan/30 text-cyan bg-cyan/5",
  };
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${tones[tone]}`}>{label}</span>;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function rupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
