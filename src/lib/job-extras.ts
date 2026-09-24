/*
 * Pure logic behind the V3 Phase 4 CRM "job extras" work — Tools to Carry,
 * Products at Site, and the customer Signature (spec 4.4/4.5/4.1, CRM
 * section). Lifted out of the components for the same reason lib/ops-desk.ts
 * is: no React/DOM needed to test the rules, and a mutation on the rule is
 * caught here instead of only in a browser.
 *
 * Signature rendering NEVER uses dangerouslySetInnerHTML — the stored
 * `svg_path` is technician-submitted MEDIUMTEXT and is treated strictly as
 * DATA. `sanitizeSvgPathData` / `sanitizeSvgViewBox` are the gate a payload
 * must pass before either value is interpolated into a real <svg>/<path>
 * JSX attribute (see JobSignatureCard.tsx).
 */

/*
 * A `d` attribute for an SVG <path> is a string of command letters, digits,
 * signs, decimal points, commas and whitespace — see the SVG 1.1 path grammar
 * (moveto/lineto/curveto/arcto + numbers). Reject anything containing a
 * character outside that set rather than trying to parse-and-repair it: the
 * signature pad (react-native-svg) only ever emits well-formed path data, so
 * a payload that doesn't match the allow-list is corrupt or hostile either
 * way, and the safe answer for both is "render nothing".
 */
const SVG_PATH_DATA_ALLOWED = /^[0-9\s,.\-eEMLHVCSQTAZmlhvcsqtaz]*$/;

export function sanitizeSvgPathData(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Cap length — a legitimate signature stroke path is at most a few KB of
  // path data; the mobile route already caps the upload at 200 KB, but this
  // is the last gate before the string reaches a DOM attribute.
  if (trimmed.length > 200_000) return '';
  return SVG_PATH_DATA_ALLOWED.test(trimmed) ? trimmed : '';
}

/*
 * viewBox width/height must be finite, positive numbers, or the <svg> either
 * fails to render or (worse) renders at a runaway size. Capped at 5000 — the
 * signature pad is a phone screen, never a poster.
 */
const MAX_SIGNATURE_DIMENSION = 5000;

export function sanitizeSvgViewBox(
  width: unknown,
  height: unknown,
): { width: number; height: number } | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return {
    width: Math.min(w, MAX_SIGNATURE_DIMENSION),
    height: Math.min(h, MAX_SIGNATURE_DIMENSION),
  };
}

/*
 * Tools to Carry — PUT /admin/jobs/:id/tools replaces the WHOLE set, so the
 * editor only needs to know whether the operator's current pick differs from
 * what the server last returned (to enable/disable Save) — order and
 * duplicates don't matter, only membership.
 */
export function toolSelectionChanged(serverIds: number[], selectedIds: number[]): boolean {
  const a = new Set(serverIds.map(Number));
  const b = new Set(selectedIds.map(Number));
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

/*
 * The job's CURRENT tool ids from GET/PUT /admin/jobs/:id/tools, whose body is
 * `{ items: [{ id, name }] }`. Reading a field that is not there does not
 * fail — it yields an empty current set, and the editor's Save then REPLACES
 * the job's tools with only what the operator just picked. So this is pinned
 * to the real shape and tolerant only of absence, never of a guessed field.
 */
export function toolIdsFromResponse(
  data: { items?: ReadonlyArray<{ id: number | string }> } | null | undefined,
): number[] {
  return (data?.items ?? []).map((t) => Number(t.id)).filter((n) => Number.isInteger(n) && n > 0);
}
