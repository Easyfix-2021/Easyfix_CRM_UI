/*
 * QuickSight — Employee Performance: who the selected window can name, and
 * what every empty state on the tab should say when the answer is "nobody".
 *
 * THE OWNER'S RULES (final; the backend enforces them, this file only explains
 * them on screen):
 *
 *   - a person appears for a month ONLY if that month's uploaded emp detail
 *     lists them. Nobody is ever invented from the CRM's job SPOCs;
 *   - a month with no emp detail therefore shows NO names at all — its jobs,
 *     revenue and CRM rows are reported under Unattributed and counted there by
 *     the job and revenue KPIs (see COUNTING_TILES below), they are simply on
 *     nobody;
 *   - a window spanning several months lists only the people on EVERY one of
 *     those months' sheets; anyone missing from one of them is hidden entirely
 *     and their rows join Unattributed too;
 *   - people who have left stay visible in the past months whose emp detail
 *     listed them. The sheet is the single source of truth.
 *
 * The consequence on screen is a report whose job and revenue totals are
 * complete and which names nobody — the per-person sections (revenue against
 * target, productivity) empty, the job tables carrying Unattributed rows
 * instead of people. Unexplained that reads as a broken page, so the body's
 * notes, the Team panel and every section's empty
 * text ask this module for their wording instead of hard-coding "No Data For
 * The Selected Filters" — and, because two of these rules can be true of one
 * window at once, for WHICH of them to blame (visibilityStory below).
 *
 * meta.visibility is the backend's own summary of the decision. It is read
 * DEFENSIVELY: a build from before these rules sends meta without it, and the
 * same answer is derivable from the per-month rosterUploaded flags, so the tab
 * degrades to sensible copy instead of crashing.
 */

import { fmtMonthList, fmtMonthLong, fmtMonthLongList, num } from './format';
import type { LiveMeta } from './types';

export type RosterGap = {
  /** Months of the window with no emp detail uploaded, ascending ('YYYY-MM'). */
  missingMonths: string[];
  /**
   * The window months that DO have one, with how many names each of those
   * sheets lists (meta.months[].rosterSize). These are the people a blackout
   * hides even though they were uploaded: with one month of the window missing
   * its sheet NOBODY is listed, not even them. Naming them and counting them is
   * the difference between "this report is broken" and "one sheet is missing".
   */
  uploaded: Array<{ month: string; rosterSize: number }>;
  /** The window spans more than one month, so only people on every sheet are listed. */
  intersection: boolean;
  /** People dropped by that intersection rule (0 unless intersection). */
  hidden: number;
  /** Names on screen for this selection. */
  names: number;
  /** No name is listed anywhere on the tab, and a roster gap is why. */
  blank: boolean;
};

/**
 * meta (+ the number of names the selection actually lists) → the one shape the
 * tab's copy needs. `null` meta (still loading, or an error) reads as "nothing
 * to explain": every field is empty and `blank` false, so no note and no
 * re-worded empty state appears while the page is loading.
 *
 * `namesShown` is summary.team.members.length — what the reader can SEE. Every
 * claim this module makes ("no employee names for September 2026") is gated on
 * it, so the tab never announces an emptiness that is not on screen: against a
 * backend build that still invents names the notes simply stay away, and
 * meta.months[].employees is used only when the caller has no team list to
 * count (the /options response, before any summary has arrived).
 */
export function rosterGap(meta: LiveMeta | null | undefined, namesShown?: number): RosterGap {
  const months = meta?.months ?? [];
  const v = meta?.visibility;
  const missingMonths = v?.missingMonths ?? months.filter((m) => !m.rosterUploaded).map((m) => m.month);
  // Deliberately the COMPLEMENT of missingMonths rather than a second filter on
  // rosterUploaded, so the two lists can never contradict each other on screen.
  // rosterSize is absent on a build from before these rules (as meta.visibility
  // is): 0 then, and every phrase below simply drops the count.
  const missingSet = new Set(missingMonths);
  const uploaded = months
    .filter((m) => !missingSet.has(m.month))
    .map((m) => ({ month: m.month, rosterSize: m.rosterSize ?? 0 }));
  // Without meta.visibility the mode follows the window's own length, which is
  // exactly how the backend decides it.
  const intersection = v ? v.mode === 'intersection' : months.length > 1;
  const hidden = v?.hidden ?? 0;
  // months[].employees is the count visible for that month, so the largest is
  // the most the window could name; 0 everywhere means it can name nobody.
  const names = namesShown ?? months.reduce((max, m) => Math.max(max, m.employees), 0);
  return {
    missingMonths,
    uploaded,
    intersection,
    hidden,
    names,
    blank: names === 0 && (missingMonths.length > 0 || hidden > 0),
  };
}

/** "That Month’s" / "Those Months’" — the emp detail sheet(s) still to upload. */
function sheetOwner(gap: RosterGap): string {
  return gap.missingMonths.length === 1 ? 'That Month’s Emp Detail Sheet' : 'Those Months’ Emp Detail Sheets';
}

/** 'that month' / 'those months' — the sheets still to upload, in running text. */
export function missingMonthsPhrase(gap: RosterGap): string {
  return gap.missingMonths.length === 1 ? 'that month' : 'those months';
}

/*
 * WHICH RULE IS ACTUALLY BITING — one window, one explanation.
 *
 * Both rules can be true of the same window: give a two-month window a sheet
 * for only one of its months and it has a missing sheet AND, because the
 * intersection needs EVERY month, it hides every name on the sheet it does
 * have. The backend's `hidden` then counts the whole uploaded roster, so
 * printing both notes reads as two competing accusations — and the second of
 * them ("these 24 people are on some of the months but not all") describes a
 * rule that never got the chance to run.
 *
 * A missing sheet therefore wins. It is the cause the reader can act on, and
 * uploading it is what brings the names back; the intersection is only ever
 * blamed for a window every month of which HAS a sheet.
 */
export type VisibilityStory = 'none' | 'missing-sheet' | 'intersection';

export function visibilityStory(gap: RosterGap): VisibilityStory {
  if (gap.blank && gap.missingMonths.length > 0) return 'missing-sheet';
  if (gap.intersection && gap.hidden > 0) return 'intersection';
  return 'none';
}

/**
 * 'the 24 names on September 2026’s emp detail' — the people this window has a
 * sheet for and still cannot list, because another of its months has none.
 *
 * null when no month of the window has a sheet at all: there is then nobody to
 * contrast with, and the note is simply "upload it". Several sheets support no
 * honest single count — the same person is usually on all of them — so those
 * name the months and leave the arithmetic alone.
 */
export function uploadedRosterPhrase(gap: RosterGap): string | null {
  if (gap.uploaded.length === 0) return null;
  const months = fmtMonthLongList(gap.uploaded.map((m) => m.month));
  const size = gap.uploaded.length === 1 ? gap.uploaded[0].rosterSize : 0;
  if (size > 0) return `the ${num(size)} ${size === 1 ? 'name' : 'names'} on ${months}’s emp detail`;
  return `the names on ${months}’s emp detail`;
}

/**
 * 'September 2026 lists 24 names and October 2026 lists 20' — the sizes behind
 * an intersection that came out empty. Two full sheets with nobody in common is
 * a surprising enough claim that the reader deserves the counts.
 *
 * null when a count would be noise rather than evidence: no sheet in the
 * window, a sheet whose size this backend build does not report, or more months
 * than the sentence can carry.
 */
export function rosterSizesPhrase(gap: RosterGap): string | null {
  const sized = gap.uploaded.filter((m) => m.rosterSize > 0);
  if (sized.length === 0 || sized.length !== gap.uploaded.length || sized.length > 3) return null;
  const parts = sized.map((m) => `${fmtMonthLong(m.month)} lists ${num(m.rosterSize)} ${m.rosterSize === 1 ? 'name' : 'names'}`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/*
 * THE ONE THING ALWAYS TRUE OF A HIDDEN PERSON: their work is still in the
 * report. resolvePeople moves the rows of everyone the window cannot name into
 * the Unattributed bucket, and the totals count that bucket, so these four
 * tiles are complete however few names are listed.
 *
 * The other three tiles are not, and this line deliberately does not claim they
 * are. Target Achieved divides that complete revenue by the uploaded target of
 * the LISTED people only; Team Members counts the listed people's own uploaded
 * teams; Completion Rate is complete but adds nothing to a sentence already
 * naming the two counts it divides. Naming the four that hold is both shorter
 * and true, and it survives the reader checking it against the tiles.
 */
export const COUNTING_TILES = 'Total Revenue, Jobs Completed, Jobs Open and Total Jobs';

/**
 * `locator` points at those tiles from where the sentence is printed: ' below'
 * from the notes above them, ' above' from the Team panel, ' at the top of the
 * report' from a section far down. '' when the reader is looking straight at
 * them.
 */
export function unattributedTilesNote(locator = ''): string {
  return 'Hiding a name never drops the work: those jobs, their revenue and their CRM rows are all counted under '
    + `Unattributed, and the ${COUNTING_TILES} tiles${locator} count that bucket too.`;
}

/**
 * The text an empty per-employee table, chart or list should carry: the roster
 * explanation when no name can appear at all, the section's own wording
 * otherwise (the table may simply have no rows for these filters).
 *
 * Title Case, as everything else the tab prints.
 */
export function rosterEmptyText(gap: RosterGap, fallback: string): string {
  if (!gap.blank) return fallback;
  if (gap.missingMonths.length > 0) {
    // A window with a sheet for some of its months and none for the others is
    // empty for ALL of them, so the heading cannot blame the missing month
    // alone — it still names it as the thing to upload.
    if (gap.uploaded.length > 0) {
      return `No Employee Names For The Selected Dates — Upload ${fmtMonthList(gap.missingMonths)}’s Emp Detail To See Names`;
    }
    return `No Employee Names For ${fmtMonthList(gap.missingMonths)} — Upload ${sheetOwner(gap)} To See Names`;
  }
  return 'No One Is On Every Selected Month’s Emp Detail — Pick A Single Month To See Names';
}

/**
 * The Team panel's empty state: the same reason as the note at the top of the
 * report, in the same words (title Title Case, hint sentence case, as the rest
 * of the tab), with room for the second line the panel has and a table cell
 * does not.
 */
export function teamEmptyState(gap: RosterGap): { title: string; hint?: string } {
  if (!gap.blank) return { title: 'No Team Members For The Selected Filters' };
  const tiles = unattributedTilesNote(' above');
  if (gap.missingMonths.length > 0) {
    const kept = uploadedRosterPhrase(gap);
    return {
      // With a sheet for one of the window's months the panel is empty for the
      // WHOLE window, not just the missing month: the title has to say that, or
      // it reads as a complaint about a month the reader can see is not alone.
      // Same title as the note at the top of the report, deliberately.
      title: kept ? 'No Employee Names For The Selected Dates' : `No Employee Names For ${fmtMonthLongList(gap.missingMonths)}`,
      hint: `Upload the emp detail sheet for ${kept ? fmtMonthLongList(gap.missingMonths) : missingMonthsPhrase(gap)} to see names.`
        + (kept ? ` Until then not even ${kept} can be listed: a window names only the people on every one of its`
          + ' months’ sheets.' : '')
        + ` ${tiles}`,
    };
  }
  const sizes = rosterSizesPhrase(gap);
  return {
    title: 'No One Is On Every Selected Month’s Emp Detail',
    hint: `${sizes ? `${sizes}. ` : ''}${num(gap.hidden)} ${gap.hidden === 1 ? 'person is' : 'people are'} on some of`
      + ` the selected months but not all, so nobody is listed. Pick a single month to see that month’s team. ${tiles}`,
  };
}

/**
 * The note for a window at least one of whose months has no emp detail
 * (sentence case, as the other notes). When the window also HAS a sheet for one
 * of its months, the second sentence is the part that is easy to get wrong:
 * those uploaded people are hidden too, and by this rule, not by the
 * intersection (see visibilityStory above).
 */
export function missingRosterNote(gap: RosterGap): string {
  const head = `No employee names for ${fmtMonthLongList(gap.missingMonths)} — upload the emp detail sheet for `
    + `${missingMonthsPhrase(gap)} to see names.`;
  const kept = uploadedRosterPhrase(gap);
  if (!kept) return head;
  return `${head} A window names only the people on every one of its months’ sheets, so while `
    + `${missingMonthsPhrase(gap)} ${gap.missingMonths.length === 1 ? 'is' : 'are'} missing not even ${kept} `
    + 'can be listed.';
}

/** The note for people hidden by the intersection rule (sentence case). */
export function hiddenPeopleNote(gap: RosterGap): string {
  const one = gap.hidden === 1;
  // The sheet sizes only earn their place when the intersection leaves NOBODY:
  // they are the evidence for an otherwise unbelievable claim.
  const sizes = gap.blank ? rosterSizesPhrase(gap) : null;
  return 'The selected dates span more than one month, so only people on every one of those months’ emp detail are '
    + `listed. ${sizes ? `${sizes}. ` : ''}${num(gap.hidden)} ${one ? 'person is' : 'people are'} on some of them but `
    + `not all and ${one ? 'is' : 'are'} hidden everywhere on this tab.`;
}

/**
 * Why this window can name nobody, in one sentence-case line for running text
 * under a section. null when the window can name someone, i.e. when there is
 * nothing to excuse.
 */
export function rosterReason(gap: RosterGap): string | null {
  if (!gap.blank) return null;
  switch (visibilityStory(gap)) {
    case 'missing-sheet': return missingRosterNote(gap);
    case 'intersection': return hiddenPeopleNote(gap);
    default: return null;
  }
}
