import * as React from 'react';

/*
 * Generic card shell for the public pages — mirrors <Section>'s
 * bg-card/rounded/border look but adds a small tinted leading icon and a
 * free-form (non-grid) body. Shared by job-completion and shared-job.
 */
export function InfoCard({
  icon, title, action, children, bodyClassName,
}: {
  icon?: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <div className="bg-card rounded-lg border p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {icon && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-info-tint text-info">
              {icon}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink-700 truncate">{title}</h2>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={bodyClassName ?? 'space-y-3'}>{children}</div>
    </div>
  );
}
