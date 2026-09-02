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
          {/* (b) PAIRED FOREGROUND on the tinted icon chip. `bg-info-tint`
              inverts — 93.73% lightness under :root, 18.24% under .dark — but
              `text-info` is one of the 16 STABLE tokens and sits at 45.69% in
              both, so in dark the glyph was mid-blue on near-black-blue and the
              icon disappeared into its own chip. There is no stable pale-blue
              twin to swap the SURFACE for (option (a) has nothing to offer for
              -tint tokens), so the foreground moves with it instead:
              `--info-strong` is 31.76% in light and 93.73% in dark, i.e. it
              travels opposite the tint, giving dark-on-pale in light and
              pale-on-dark in dark. That is the same `bg-info-tint
              text-info-strong` pairing already used by the access-roles chips
              and the manage-users blue tag. Light theme shifts slightly: the
              glyph goes from 45.69% to 31.76% lightness — same hue, a little
              deeper against the unchanged 93.73% tint. */}
          {icon && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-info-tint text-info-strong">
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
