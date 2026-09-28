'use strict';
/*
 * Confirm & Schedule -> Book Call: close the modal, then refresh what the
 * operator is looking at (2026-09-16, ops).
 *
 * THE BUG THIS PINS. Booking left the modal open on a read-only view of a job
 * that had just left the list behind it, and My Orders -> Unconfirmed did not
 * move: the booked row, the five section counts and the tab total all stayed as
 * they were until the operator hit the browser's reload button. The page's own
 * reload only refreshes the "N matching orders" header — the rows and counts
 * live in UnconfirmedSections' five per-section fetches, which never unmount,
 * so nothing in the page's cache-clear reaches them.
 *
 * Every rule below is a plain deletion that still type-checks and still builds,
 * which is exactly why it is scanned here. Source-scanned like
 * unconfirmed-sections.test.js: these live in .tsx that test:build does not
 * compile.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Comments are stripped before every scan — this repo explains itself in prose
// beside the code, and a raw scan would read the explanation as the code.
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const MODAL = 'src/components/job/JobModal.tsx';
const SECTIONS = 'src/components/job/UnconfirmedSections.tsx';
const MY_ORDERS = 'src/app/(authed)/my-orders/page.tsx';

const modal = strip(read(MODAL));
const sections = strip(read(SECTIONS));
const myOrders = strip(read(MY_ORDERS));

// ─── 1. A successful Book Call closes the modal ──────────────────────────

test('confirm-mode Book Call hands the modal off to close, and says so', () => {
  assert.match(modal, /const closesAfterBook = isConfirm && submitVariant === 'book';/,
    'Book Call in confirm mode is what closes the modal; without this the modal falls back to switching into view mode');
  assert.match(modal, /const closeAfter = isOutcomeOnly \|\| submitVariant === 'draft' \|\| closesAfterBook;/,
    'the closeAfter flag must carry the book case — the outcome/draft cases alone leave Book Call open');
  assert.match(modal, /message: `Job #\$\{initial\.job_id\} booked successfully`/,
    'the toast is the only confirmation left once the modal closes');
});

test('the close-after branch clears the dirty flags guardedClose would have cleared', () => {
  const branch = modal.slice(modal.indexOf('if (opts?.closeAfter) {'));
  const body = branch.slice(0, branch.indexOf('}'));
  assert.match(body, /hasUnsavedQtyRef\.current = false;/);
  assert.match(body, /hasUnsavedFormRef\.current = false;/,
    'this close bypasses guardedClose and the modal stays mounted — a flag left set raises a false "Discard Unsaved Changes?" on the NEXT open');
  assert.match(body, /onSaved\?\.\(\);[\s\S]*onClose\(\);/,
    'the parent is told to refresh BEFORE the modal closes');
});

test('submitting stays true once a save has handed off to close', () => {
  assert.match(modal, /let handedOffToClose = false;/);
  assert.match(modal, /\} finally \{ if \(!handedOffToClose\) setSubmitting\(false\); \}/,
    'the close is a URL navigation that commits a round trip later; re-enabling the buttons in that gap lets a second click re-submit the same form (and re-run the multi-category fan-out)');
  const handoff = modal.indexOf('handedOffToClose = closeAfter;');
  const call = modal.indexOf('onSaved(saved, { closeAfter, variant: submitVariant });');
  assert.ok(call > 0 && handoff > call,
    'the flag is set AFTER onSaved returns, so a throw inside it still releases the buttons');
});

test('no footer button can submit on top of a save already in flight', () => {
  const footer = modal.slice(modal.indexOf('<CancelButton onCancel={onCancel} label="Close" />'));
  const unreachable = footer.slice(footer.indexOf("setOutcomeDialog({ mode: 'unreachable' })"));
  assert.match(unreachable.slice(0, 200), /disabled=\{submitting\}/,
    'Unreachable must lock while another variant is saving');
  const enquiry = footer.slice(footer.indexOf("setOutcomeDialog({ mode: 'enquiry' })"));
  assert.match(enquiry.slice(0, 200), /disabled=\{submitting\}/,
    'Enquiry must lock while another variant is saving');
  assert.match(footer, /disabled=\{!confirmBookReady \|\| submitting\}/,
    "Book Call's `loading` only covers a book — `submitting` is what stops it landing on top of a draft or an outcome");
});

// ─── 2. …and the page behind it refreshes ────────────────────────────────

/*
 * THE SAME REQUIREMENT, ON THE SCREEN THAT NOW CARRIES IT.
 *
 * My Orders -> Unconfirmed used to render five reorderable sections; ops
 * retired that view on 2026-09-24 and the tab is the Booking Queue alone. The
 * rule it was protecting did not retire with it: a save made in the modal must
 * reach the rows BEHIND the modal, or an order the operator just booked sits
 * in the tile it has already left.
 *
 * The mechanism is unchanged and still the subtle part — invalidateFetch alone
 * does NOT refresh a mounted useFetch (the key is a pure function of the query,
 * so after a save it is byte-identical and the effect never re-runs), and this
 * view does not unmount while the tab is open. Hence the page-driven signal.
 */
test('a modal save refreshes the Booking Queue behind it', () => {
  const view = strip(read('src/components/job/BookingQueueView.tsx'));
  assert.match(view, /reloadSignal\?: number;/,
    'the page-driven signal is the only way a mutation made OUTSIDE the view reaches it');
  // Bound call-to-dep-array, the house idiom: an effect that merely NAMES the
  // signal, or one that omits it from the deps, leaves the page's bump inert.
  assert.match(view, /counts\.refetch\(\);[\s\S]{0,120}?rows\.refetch\(\);[\s\S]{0,160}?\}, \[reloadKey, reloadSignal\]\);/,
    'both the tiles and the rows must refetch — a stale tile over fresh rows is the same bug wearing a different hat');

  assert.match(myOrders, /reloadSignal=\{sectionsReload\}/,
    'the page must actually hand the signal down');
  // Scanned INSIDE the JobModal onSaved handler: a bump wired to any other
  // handler leaves Book Call — the case that started this — unrefreshed.
  const saved = myOrders.slice(myOrders.indexOf('<JobModal'));
  const onSaved = saved.slice(saved.indexOf('onSaved={(job) => {'), saved.indexOf('initialTab='));
  assert.match(onSaved, /setSectionsReload\(\(n\) => n \+ 1\);/,
    'the queue is refreshed from the same handler that refreshes the header');
  assert.match(onSaved, /invalidateFetch\(\(k\) => k\.startsWith\('\/admin\/jobs'\)\);/,
    'a status-9 row can be confirmed from other tabs, where the queue is not mounted to hear the signal');
});

test('the reconciliation warning waits for the counts it is comparing', () => {
  assert.match(sections, /const anyBusy = pageBusy === true \|\| Object\.values\(busy\)\.some\(Boolean\);/);
  assert.match(sections, /\{reconciliation\.status === 'mismatch' && !anyBusy && \(/,
    'the header total and the five section counts land at different moments; comparing across that window cries wolf on every booking');
  assert.match(sections, /const \{ data, loading, refreshing, refetch \} = useFetch<Resp>\(key\);/,
    'refreshing is the post-mutation case — the old total is still on screen while the new one is in flight');
  // Bound to its dep array too: dropping `refreshing` from the deps is a
  // one-token edit that eslint's exhaustive-deps cannot see (the rule is
  // disabled on the line below it), and it would silently restore the flash —
  // a post-mutation refetch flips `refreshing`, never `loading`.
  assert.match(sections, /onBusy\(loading \|\| refreshing\);[\s\S]{0,120}?\}, \[loading, refreshing\]\);/,
    'every section must report busy for the SWR refetch, not just the first load');
  /*
   * The PAGE half of this check went with the sections view (ops retired it on
   * 2026-09-24). The Booking Queue has no sum to reconcile: its tiles and its
   * rows come from one endpoint each, over the same predicate, so there is no
   * second opinion to disagree with. The assertions above still stand because
   * UnconfirmedSections itself is unchanged.
   */
});

// ─── 3. Controls ─────────────────────────────────────────────────────────

test('positive control — the stripper removes prose and keeps code', () => {
  const sample = strip('/* closeAfter: isOutcomeOnly */\nconst x = 1; // closeAfter\n');
  assert.doesNotMatch(sample, /isOutcomeOnly/, 'block comments must be blanked');
  assert.match(sample, /const x = 1;/, 'code must survive');
});

test('differential control — the pre-fix call shape is gone from the source', () => {
  assert.doesNotMatch(modal, /closeAfter: isOutcomeOnly \|\| submitVariant === 'draft',/,
    'that exact call is what left Book Call open on a view of a job that had just left the list');
  assert.doesNotMatch(modal, /\} finally \{ setSubmitting\(false\); \}/,
    'the unguarded reset is what re-enabled the buttons during the close');
});
