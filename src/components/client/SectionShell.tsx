/*
 * The header band every Client Profile section renders: title, the BRAND-LEVEL
 * tag from the design comp, and an optional one-line note.
 *
 * It lives in its own module rather than beside the page because a Next.js
 * App Router page file may only export the default component plus a fixed set
 * of route fields — exporting a component from page.tsx fails the build with
 * "not a valid Page export field".
 *
 * WHY THE TAG IS ON EVERY SECTION. Nothing on a client is configured per
 * project today (see the context-strip note on the profile page), so every
 * section genuinely IS brand-level. When per-project settings land, the tag
 * becomes a real discriminator and only the sections that are project-scoped
 * lose it — which is why it is a prop-free constant now rather than something
 * each caller passes and can get wrong.
 */

export function SectionShell({
  title, note, children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-semibold">{title}</h3>
          <span className="text-xs uppercase tracking-wide rounded bg-muted text-muted-foreground px-1.5 py-0.5">
            Brand-Level
          </span>
        </div>
        {note && <p className="text-sm text-muted-foreground mt-0.5">{note}</p>}
      </div>
      {children}
    </div>
  );
}
