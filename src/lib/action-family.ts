/*
 * Action FAMILIES in the Manage Roles permission tree.
 *
 * QuickSight is the only one today: `ef-QuickSight` is the door, and each
 * `isQuickSight…View` is a room behind it. The server checks BOTH —
 * middleware/require-quicksight.js refuses without the family key, then refuses
 * again without the report key — so the sixteen report permissions do nothing
 * on their own.
 *
 * Rendered flat, those twenty Home actions read as twenty unrelated toggles,
 * and an operator can tick a report while leaving the door shut. That grant is
 * accepted, saved, and silently useless. The tree makes the dependency visible;
 * `applyToggle`'s implied-parent rule makes it true.
 *
 * This lives in lib, not in the page, for the reason tests/job-buckets.test.js
 * already states: importing a page component drags React and the Next runtime
 * into the test, which is why rules that live in pages end up with no coverage.
 * These four functions are the whole of the risky part and none of them render.
 */

export const QUICKSIGHT_FAMILY_KEY = 'ef-QuickSight';

/*
 * Matched by SHAPE, not by a list of sixteen. A report seeded tomorrow joins
 * the tree without anyone remembering to come back here — which is the same
 * failure that left ten of them ungrantable in the first place.
 */
export function isQuickSightReportKey(key: string): boolean {
  return /^isQuickSight\w+View$/.test(key);
}

export type FamilyAction = { id: number; action_name: string; name: string };

export type FamilySplit<T extends FamilyAction> = {
  familyParent: T | undefined;
  reports: T[];
  plain: T[];
  familyIds: number[];
};

/* Split one menu's actions into the family and everything else. */
export function splitActionFamily<T extends FamilyAction>(actions: T[]): FamilySplit<T> {
  const familyParent = actions.find((a) => a.action_name === QUICKSIGHT_FAMILY_KEY);
  const reports = actions.filter((a) => isQuickSightReportKey(a.action_name));
  const reportIds = new Set(reports.map((r) => r.id));
  const plain = actions.filter((a) => a.id !== familyParent?.id && !reportIds.has(a.id));
  const familyIds = [...(familyParent ? [familyParent.id] : []), ...reports.map((r) => r.id)];
  return { familyParent, reports, plain, familyIds };
}

/*
 * What the family header checkbox shows.
 *
 * TWO states, not three. "Some" is a DISPLAY state (indeterminate) meaning the
 * children disagree; it is never something a click produces, because there is
 * no answer to "which some?".
 */
export function familyCheckState(familyIds: number[], selected: Set<number>): {
  allOn: boolean; anyOn: boolean; indeterminate: boolean;
} {
  const allOn = familyIds.length > 0 && familyIds.every((id) => selected.has(id));
  const anyOn = familyIds.some((id) => selected.has(id));
  return { allOn, anyOn, indeterminate: !allOn && anyOn };
}

/*
 * Toggle one action, opening the door when a room is granted.
 *
 * DELIBERATELY ONE-WAY. Un-ticking the last report does NOT revoke the family
 * key: holding it with no reports is a real, reachable state — it is what a
 * reporting manager needs for Employee Productivity, which is gated on the
 * relation rather than on a per-report grant. Revoking it here would take that
 * away as a side effect of an unrelated click.
 */
export function applyToggle(
  selected: Set<number>, actionId: number, impliesActionId?: number,
): Set<number> {
  const next = new Set(selected);
  if (next.has(actionId)) {
    next.delete(actionId);
  } else {
    next.add(actionId);
    if (impliesActionId != null) next.add(impliesActionId);
  }
  return next;
}

/* All-or-nothing over the door and every room. */
export function applyFamilyToggle(selected: Set<number>, ids: number[]): Set<number> {
  if (ids.length === 0) return selected;
  const next = new Set(selected);
  const allOn = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allOn) next.delete(id); else next.add(id);
  }
  return next;
}
