import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Server-rendered presentational primitives for the marketing content pages.
 * No client hooks or motion — semantic HTML, theme-aware tokens, good for SEO and
 * accessibility, and reduced-motion-safe by construction. Reuses the existing
 * design tokens (ink/surface/hairline/cyan/emerald/text-*).
 */

/** Page hero: breadcrumb + eyebrow + gradient title + lead paragraph. */
export function PageHeader({
  breadcrumb,
  eyebrow,
  title,
  intro,
}: {
  breadcrumb: { label: string; href: string }[];
  eyebrow: string;
  title: string;
  intro: string;
}) {
  return (
    <header className="border-b border-hairline">
      <div className="mx-auto max-w-[1100px] px-6 py-14 sm:px-10 sm:py-20">
        <nav aria-label="Breadcrumb" className="mb-6">
          <ol className="flex flex-wrap items-center gap-1.5 text-[12px] text-text-tertiary">
            {breadcrumb.map((c, i) => (
              <li key={c.href} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden>/</span>}
                <Link href={c.href} className="rounded transition-colors hover:text-text-primary">
                  {c.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <p className="text-[12px] font-medium uppercase tracking-[0.2em] text-cyan">{eyebrow}</p>
        <h1 className="mt-4 max-w-3xl text-balance bg-gradient-to-b from-text-primary to-text-primary/60 bg-clip-text text-[clamp(2rem,5vw,3.4rem)] font-semibold leading-[1.05] tracking-tight text-transparent">
          {title}
        </h1>
        <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-text-secondary">{intro}</p>
      </div>
    </header>
  );
}

/** A titled content section with an optional short lead. */
export function Section({ id, title, lead, children }: { id?: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="border-b border-hairline">
      <div className="mx-auto max-w-[1100px] px-6 py-12 sm:px-10 sm:py-16">
        <h2 className="text-[clamp(1.3rem,2.6vw,1.9rem)] font-semibold tracking-tight text-text-primary">{title}</h2>
        {lead && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-text-secondary">{lead}</p>}
        <div className="mt-7">{children}</div>
      </div>
    </section>
  );
}

/** Body prose block with comfortable measure. */
export function Prose({ children }: { children: ReactNode }) {
  return <div className="max-w-2xl space-y-4 text-[15px] leading-relaxed text-text-secondary [&_strong]:font-medium [&_strong]:text-text-primary">{children}</div>;
}

export function CardGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={`grid gap-4 ${cols === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"}`}>{children}</div>;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-5">
      <h3 className="text-[14px] font-semibold text-text-primary">{title}</h3>
      <div className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

export type StatusTone = "implemented" | "sandbox" | "blocked" | "planned" | "aligned";

const TONE_CLASS: Record<StatusTone, string> = {
  implemented: "border-emerald/30 bg-emerald/10 text-emerald",
  sandbox: "border-cyan/30 bg-cyan/10 text-cyan",
  aligned: "border-cyan/30 bg-cyan/10 text-cyan",
  blocked: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  planned: "border-hairline bg-surface text-text-tertiary",
};

/** A precise capability status pill (Implemented / Sandbox-ready / Externally blocked / Planned). */
export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${TONE_CLASS[tone]}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** A responsive capability matrix: what Aarogya supports, and at what maturity. */
export function StatusMatrix({ rows }: { rows: { capability: string; detail: string; tone: StatusTone; label: string }[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-hairline">
      <table className="w-full min-w-[560px] border-collapse text-left text-[13.5px]">
        <thead>
          <tr className="border-b border-hairline text-[11px] uppercase tracking-[0.12em] text-text-tertiary">
            <th scope="col" className="px-4 py-3 font-medium">Capability</th>
            <th scope="col" className="px-4 py-3 font-medium">What Aarogya does</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.capability} className="border-b border-hairline last:border-0 align-top">
              <th scope="row" className="px-4 py-3 font-medium text-text-primary">{r.capability}</th>
              <td className="px-4 py-3 text-text-secondary">{r.detail}</td>
              <td className="px-4 py-3"><StatusBadge tone={r.tone} label={r.label} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An honesty callout — used to state exactly what is NOT claimed. */
export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-5">
      <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-text-tertiary">{title}</p>
      <div className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

export function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="max-w-2xl space-y-2.5 text-[14px] leading-relaxed text-text-secondary">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-cyan" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** External reference link with the correct rel + a visual affordance. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded text-cyan underline-offset-2 hover:underline"
    >
      {children}
      <span aria-hidden>&#8599;</span>
    </a>
  );
}

/** Closing call-to-action shared across content pages. */
export function PageCta({ title, body, actions }: { title: string; body: string; actions: { label: string; href: string; primary?: boolean }[] }) {
  return (
    <section>
      <div className="mx-auto max-w-[1100px] px-6 py-16 text-center sm:px-10 sm:py-24">
        <h2 className="mx-auto max-w-2xl text-balance text-[clamp(1.6rem,4vw,2.6rem)] font-semibold leading-[1.08] tracking-tight text-text-primary">{title}</h2>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-text-secondary">{body}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className={
                a.primary
                  ? "rounded-full bg-brand-strong px-5 py-2.5 text-[13.5px] font-medium text-on-brand transition hover:opacity-90"
                  : "rounded-full border border-hairline bg-surface px-5 py-2.5 text-[13.5px] font-medium text-text-primary transition hover:border-cyan/40 hover:text-cyan"
              }
            >
              {a.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
