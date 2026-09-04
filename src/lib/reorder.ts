/*
 * reorder — move one item of a list to a new place, addressed by the GAP it
 * should land in rather than by the item it was dropped on.
 *
 * WHY THIS IS ITS OWN FUNCTION. It is four lines, and it was wrong twice in the
 * same handler. The drag-to-reorder in UnconfirmedSections did this:
 *
 *     const next = order.filter(s => s.key !== from);      // remove first
 *     const at   = next.findIndex(s => s.key === targetKey);
 *     next.splice(at, 0, moved);                           // insert BEFORE it
 *
 * which fails in two compounding ways:
 *
 *   1. It always inserts BEFORE the element under the pointer, so dragging a
 *      section DOWN onto another puts it above that one — one place short of
 *      where the operator aimed. Dragging UP happens to be right, so the error
 *      is asymmetric and reads as "sometimes it drops in the wrong position"
 *      rather than as a consistent bug.
 *   2. It searches for the target in the list the source has ALREADY been
 *      removed from, so every index past the source has shifted down by one
 *      and nothing compensates.
 *
 * The fix is to name the destination as an insertion index — the gap between
 * two items, `0` meaning "above everything" and `list.length` meaning "below
 * everything" — and to make the one adjustment that removing the source
 * requires. Gaps are also what a drop INDICATOR draws, so the UI and the maths
 * describe the same thing.
 *
 * `insertAt` is an index into the list AS IT STANDS, before the move.
 */
export function reorder<T>(list: readonly T[], from: number, insertAt: number): T[] {
  const next = list.slice();
  if (from < 0 || from >= list.length) return next;
  /*
   * Removing the source shifts everything after it down one, so a destination
   * PAST the source is one too high. Clamped afterwards so a caller that
   * computes a gap off the end of the list (the keyboard handler does, on the
   * last row) is a no-op instead of an exception.
   */
  const to = Math.max(0, Math.min(list.length - 1, insertAt > from ? insertAt - 1 : insertAt));
  if (to === from) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
