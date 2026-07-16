export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-text-tertiary">{eyebrow}</p>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-text-primary">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-[13px] text-text-secondary">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
