/*
 * RefreshBar — a subtle 2px bar shown at the top of a table while a SILENT
 * background refresh (a post-action refetch) is in flight. Gives ops a quiet
 * "data is updating" cue without the flicker of a full skeleton. Renders
 * nothing when idle, so it costs no layout height at rest.
 */
export function RefreshBar({ active }: { active?: boolean }) {
  if (!active) return null;
  return <div className="h-0.5 w-full animate-pulse bg-sky-500/70" aria-hidden="true" />;
}
