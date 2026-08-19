/**
 * Festival ornaments — the lookup table, and nothing else.
 *
 * WHAT THIS IS
 *
 * Four overlays in `public/brand/festivals/`, each authored against the
 * tagline lockup's own viewBox (`0 0 1000 315.361`) so an ornament composites
 * 1:1 over <Logo variant="tagline"> with no per-festival sizing. The
 * decoration lives at the edges of that box; the centre stays the logo and the
 * house mark is never overdrawn.
 *
 * THERE IS NO DATE LOGIC HERE, ON PURPOSE
 *
 * The active window is decided SERVER-SIDE by `easyfix_theme_variant`
 * (starts_on / ends_on) and delivered via the API. This module only turns the
 * id the server already chose into an asset path. Do NOT add a second date
 * calculation on the client: two schedules drift the moment one of them has to
 * handle a moved festival date (Diwali and Holi move every year), a timezone
 * boundary, or a day of mourning declared at short notice — and the client's
 * copy is the one nobody remembers to update. If the ornament shows on the
 * wrong day, the row is wrong, not this file.
 *
 * `mourning` is a real entry with a real (empty) asset rather than a null.
 * That keeps "no ornament today" and "ornament we could not resolve" as two
 * different states instead of one ambiguous one.
 *
 * Colour lives in the SVGs, not here — see each file's header for the palette
 * constraint. `npm run check:brand` does not walk `public/`, by design.
 */

export type Festival = {
  id: string;
  label: string;
  src: string;
  animated: boolean;
};

export const FESTIVALS: Festival[] = [
  { id: 'diwali', label: 'Diwali', src: '/brand/festivals/diwali.svg', animated: true },
  {
    id: 'independence',
    label: 'Independence Day',
    src: '/brand/festivals/independence.svg',
    animated: true,
  },
  { id: 'holi', label: 'Holi', src: '/brand/festivals/holi.svg', animated: true },
  { id: 'mourning', label: 'Mourning', src: '/brand/festivals/mourning.svg', animated: false },
];

/**
 * Resolve a festival id to its ornament. FAIL-SOFT BY DESIGN.
 *
 * The id arrives from a database row an admin can edit, so an unknown value is
 * an ordinary Tuesday, not an exception: a typo'd variant name must degrade to
 * the plain logo, never take down the sidebar or the login page. Null and
 * undefined (no active variant) resolve the same way.
 */
export function festivalById(id: string | null | undefined): Festival | null {
  if (!id) return null;
  return FESTIVALS.find((f) => f.id === id) ?? null;
}
