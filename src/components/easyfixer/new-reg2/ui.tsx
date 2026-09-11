/*
 * new-reg2 shared presentational primitives.
 *
 * Small, dependency-light building blocks used across the revamped
 * Easyfixer List → Profile experience (feature/new-registration-2). They
 * exist only to keep the tab-body components lean; nothing here holds
 * business logic or fetches data. All colours resolve to brand tokens so
 * the pages theme correctly in light + dark, matching the rest of the CRM.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/** Rupee formatter — the repo has no shared INR helper, so keep one here. */
export function inr(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (v == null || Number.isNaN(v)) return '—';
  return '₹' + Math.round(v).toLocaleString('en-IN');
}

/** Section card with a header (title + optional right-slot) and a body. */
export function SectionCard({
  title,
  icon,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-xl border bg-card shadow-sm', className)}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          {icon}
          {title}
        </h2>
        {right != null && <div className="flex items-center gap-2 text-xs text-muted-foreground">{right}</div>}
      </div>
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Compact stat tile (label / value / optional sub-line). */
export function Tile({
  label,
  value,
  sub,
  small,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card p-3.5 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-bold tabular-nums text-ink-900', small ? 'text-base' : 'text-xl')}>{value}</div>
      {sub != null && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Key/value row with a bottom rule; renders an italic placeholder when empty. */
export function KV({
  k,
  v,
  mono,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  mono?: boolean;
}) {
  const empty = v == null || v === '' || v === '—';
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{k}</span>
      {empty ? (
        <span className="italic text-ink-300">Not filled</span>
      ) : (
        <span className={cn('text-right font-medium text-ink-900', mono && 'font-mono tabular-nums')}>{v}</span>
      )}
    </div>
  );
}

/** Thin progress meter that colours by band (low/warn/good). */
export function Meter({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const tone = p >= 80 ? 'bg-success' : p >= 40 ? 'bg-warning' : 'bg-destructive';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${p}%` }} />
    </div>
  );
}

/** Labelled meter row (label + percentage + bar) for strength breakdowns. */
export function MeterRow({ label, pct }: { label: React.ReactNode; pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="my-2">
      <div className="mb-1 flex items-center justify-between text-[13px]">
        <span className="text-ink-700">{label}</span>
        <span className="font-mono tabular-nums text-muted-foreground">{p}%</span>
      </div>
      <Meter pct={p} />
    </div>
  );
}

/** Circular strength ring (conic gradient) used in the profile header. */
export function StrengthRing({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="text-center">
      <div
        className="mx-auto grid h-20 w-20 place-items-center rounded-full"
        style={{ background: `conic-gradient(hsl(var(--primary)) ${p}%, hsl(var(--muted)) 0)` }}
      >
        <span className="grid h-[60px] w-[60px] place-items-center rounded-full bg-card font-mono text-base font-semibold text-ink-900">
          {p}%
        </span>
      </div>
      <div className="mt-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Profile strength</div>
    </div>
  );
}

/** "Available once activated" locked-body placeholder. */
export function LockedBody({ note }: { note?: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-ink-300">
      <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px]">🔒</span>
      {note ?? 'Available once the Easyfixer is activated.'}
    </div>
  );
}

/**
 * Endpoint-pending placeholder. Rendered wherever the approved design calls
 * for data that has no backing admin endpoint yet, so the tab stays honest
 * instead of fabricating values. Each usage is logged in the delivery notes.
 */
export function EndpointPending({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground">
      <div className="font-medium text-ink-700">Endpoint pending</div>
      <p className="mt-1">{what}</p>
    </div>
  );
}

/** Simple horizontal-bar list (name · bar · count) for category breakdowns. */
export function BarList({ rows }: { rows: Array<[string, number]> }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No data.</p>;
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return (
    <div>
      {rows.map(([name, count]) => (
        <div key={name} className="flex items-center gap-3 py-1.5">
          <span className="w-40 shrink-0 text-[13px] font-medium text-ink-700">{name}</span>
          <span className="h-4 flex-1 overflow-hidden rounded bg-muted">
            <span className="block h-full rounded bg-primary" style={{ width: `${Math.round((count / max) * 100)}%` }} />
          </span>
          <span className="w-10 text-right font-mono text-[13px] text-muted-foreground">{count}</span>
        </div>
      ))}
    </div>
  );
}

/** Append-only timeline (dot + rule) used for lifecycle / audit history. */
export function Timeline({
  items,
}: {
  items: Array<{ key: string | number; title: React.ReactNode; meta: React.ReactNode; tone?: 'default' | 'success' | 'danger' }>;
}) {
  if (!items.length) return <p className="text-sm text-muted-foreground">No history yet.</p>;
  return (
    <div className="pl-2">
      {items.map((it, i) => {
        const dot = it.tone === 'danger' ? 'bg-destructive' : it.tone === 'success' ? 'bg-success' : 'bg-primary';
        const last = i === items.length - 1;
        return (
          <div key={it.key} className={cn('relative pl-4', !last && 'border-l-2 border-border pb-4')}>
            <span className={cn('absolute -left-[7px] top-1 h-3 w-3 rounded-full ring-2 ring-card', dot)} />
            <div className="text-[13px] font-semibold text-ink-900">{it.title}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{it.meta}</div>
          </div>
        );
      })}
    </div>
  );
}
