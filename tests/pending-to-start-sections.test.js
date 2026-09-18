'use strict';
/*
 * Pending to Start's SECTIONS are retired, and the reorderable interaction they
 * borrowed stays ONE shared copy that Unconfirmed still renders through. Plus
 * the row carries no Check In, only a View that opens the job.
 *
 * REWRITTEN 2026-09-16. This file used to pin the four reorderable sections —
 * Technician Requests / Over Due / Action Today / Future — as members of the
 * shared <ReorderableSections> set, with their own localStorage keys and a
 * Technician-Requests-first default. The owner replaced them with Pending for
 * Scheduling's model: one tab strip (All · Slots missed · Reschedule request ·
 * Cancel request · Today · Future) over ONE server-paged table. What each old
 * guarantee became is asserted below; the tabs model's own contract (the
 * strip, counts, URL, filters, Request column, console icon) is pinned in
 * tests/pending-to-start-tabs.test.js.
 *
 * Why this file is not simply deleted: two of its checks were never about
 * Pending to Start. The shared component still carries Unconfirmed's drag,
 * keyboard, collapse and a11y string for string, and Unconfirmed must still
 * render through it rather than re-grow a copy — tests/unconfirmed-sections.test.js
 * points here for exactly that. They stay, unchanged.
 *
 * Source-scanned, like job-app-request.test.js and resend-pin-action.test.js:
 * every rule here lives in a .tsx component that test:build does not compile,
 * and each regression below is a plain edit that type-checks. The drag
 * ARITHMETIC is behaviour-tested separately (tests/section-reorder.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/*
 * Comments are stripped before every scan (the same stripper as
 * job-app-request.test.js): this view explains its removed controls in prose,
 * and a scan of the raw source would read the explanation as the code.
 */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const VIEW = 'src/components/job/PendingToStartView.tsx';
const TABS = 'src/components/job/PendingStartTabs.tsx';
const SHARED = 'src/components/ui/reorderable-sections.tsx';
const UNCONFIRMED = 'src/components/job/UnconfirmedSections.tsx';
const PAGE = 'src/app/(authed)/my-orders/page.tsx';

const view = strip(read(VIEW));
const tabs = strip(read(TABS));
const shared = strip(read(SHARED));
const unconfirmed = strip(read(UNCONFIRMED));

// ─── 1. The sections are gone; one strip over one table replaced them ───

/* Every piece of the retired section model, as it was spelled in this view. */
const SECTION_MACHINERY = [
  /reorderable-sections/, /<ReorderableSections\b/, /<SectionFrame\b/, /SectionControls/,
  /const SECTIONS = /, /\bORDER_KEY\b/, /\bCOLLAPSED_KEY\b/, /explicitCollapsed/, /\bcountOnly\b/,
];

test('the view renders ONE tab strip over ONE table — no reorderable sections', () => {
  /*
   * The whole of the old requirement "all four sections are the reorderable
   * set" inverted: a second, half-migrated copy of the section machinery left
   * beside the tabs is how the page would end up with two ways to reach the same
   * rows and two sets of counts disagreeing about them.
   */
  for (const gone of SECTION_MACHINERY) {
    assert.doesNotMatch(view, gone, `${gone} is back in ${VIEW} — the sections were replaced by tabs`);
  }

  assert.equal((view.match(/<PendingStartTabs\b/g) || []).length, 1, 'exactly one tab strip');
  assert.equal((view.match(/<PendingStartTable\b/g) || []).length, 1,
    'exactly one table — a second mount is a section by another name');
  assert.ok(view.indexOf('<PendingStartTabs') < view.indexOf('<PendingStartTable'),
    'the strip sits above the table it selects');
  assert.match(view, /import \{ PendingStartTabs, toPtsState, type PtsState \} from '@\/components\/job\/PendingStartTabs';/);
});

test('the ONE table keeps what each section had: its own server page, total and footer', () => {
  const table = view.slice(view.indexOf('function PendingStartTable('));
  assert.ok(table.length < view.length, 'positive control: the table component must be found');
  assert.match(table, /const \{ data, loading, refreshing, error, refetch \} = useFetch<Resp>\(key\);/);
  assert.match(table, /const total = data\?\.total \?\? 0;/, 'the footer reads the server\'s total');
  assert.match(table, /<TablePagination\s+page=\{page\}\s+pageSize=\{pageSize\}\s+total=\{total\}/,
    'the table keeps its own footer');
  assert.match(table, /limit,\s+offset,\s+\}\);/, 'and pages on the server, never over a truncated array');
  assert.match(table, /<RefreshBar active=\{refreshing\} \/>/, 'a background reload stays silent, as it was per section');
});

test('an empty tab is still a tab — nothing disappears at zero', () => {
  /*
   * The old guarantee was "an empty Technician Requests section still renders
   * its header", because a section that vanished could not be dragged. The
   * equivalent now: every tab renders whatever its count, so an empty request
   * tab stays one click away and still states its 0. A `.filter()` on the
   * counts, or an early return on a zero, is how "Cancel request" would silently
   * drop out of the strip on a quiet day.
   */
  assert.match(tabs, /\{TABS\.map\(\(t\) => \{/, 'the strip must render straight from TABS');
  assert.doesNotMatch(tabs, /TABS\.filter\(/, 'no tab may be filtered out');
  assert.doesNotMatch(tabs, /if \([^)]*(counts|\bn\b)[^)]*\)\s*return null;/, 'no tab may return null on its count');

  // Positive control: that matcher does fire on the shape it forbids.
  assert.match('  if (n === 0) return null;', /if \([^)]*(counts|\bn\b)[^)]*\)\s*return null;/,
    'control: the scan must be able to see the guard it forbids');
});

// ─── 2. Same interaction as Unconfirmed (shared component, unchanged) ────

/*
 * The strings that DEFINE the interaction: drag start/end on the header, the
 * pointer-half drop rule, the keyboard step, the no-op indicator suppression,
 * the FLIP timing, reduced motion, the a11y labels, the markup classes.
 */
const PARITY = [
  /<header\s+draggable\s+onDragStart=\{onDragStart\}\s+onDragEnd=\{onDragEnd\}/,
  /onDragOverCard\(e\.clientY > r\.top \+ r\.height \/ 2\)/,
  /const dir = e\.key === 'ArrowUp' \? -1 : e\.key === 'ArrowDown' \? 1 : 0;/,
  /move\(key, dir < 0 \? idx - 1 : idx \+ 2\)/,
  /const next = reorder\(order, from, to\);/,
  /if \(at === from \|\| at === from \+ 1\) return null;/,
  /const REORDER_MS = 220;/,
  /cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/,
  /\(prefers-reduced-motion: reduce\)/,
  /aria-label=\{`Reorder \$\{[\w.]+\}: press the up or down arrow key to move this section`\}/,
  /title="Drag, or focus and use the arrow keys, to reorder"/,
  /aria-expanded=\{!collapsed\}/,
  /title=\{collapsed \? 'Expand' : 'Collapse'\}/,
  /<GripVertical className="w-4 h-4" \/>/,
  /<ChevronRight className="w-4 h-4 text-ink-500" aria-hidden \/>/,
  /<ChevronDown className="w-4 h-4 text-ink-500" aria-hidden \/>/,
  /rounded-lg border border-ink-100 overflow-hidden bg-surface transition-opacity/,
  /flex items-center gap-2 px-3 py-2 bg-surface-alt select-none/,
  /<StatusChip tone="info" size="sm">/,
  /import \{ reorder \} from '@\/lib\/reorder';/,
];

test('the shared component carries Unconfirmed\'s drag, keyboard, collapse and a11y, string for string', () => {
  for (const p of PARITY) assert.match(shared, p, `the shared component lost: ${p}`);
  assert.match(shared, /export function ReorderableSections</);
  assert.match(shared, /export function SectionFrame\(/);
});

/*
 * The pieces that make up ONE copy of the interaction. Every one of them is in
 * the shared component (asserted below, which is also the positive control:
 * each pattern is shown able to match a real copy before it is used to prove
 * one is absent). None may reappear in Unconfirmed — that is what "there is one
 * copy" means, and a re-grown copy is exactly how the two pages drift apart.
 */
const ONE_COPY_ONLY = [
  /const REORDER_MS = 220;/,
  /useLayoutEffect/,
  /from '@\/lib\/reorder'/,
  /requestAnimationFrame/,
  /getBoundingClientRect/,
  /prefers-reduced-motion/,
  /localStorage/,
  /\bdraggable\b/,
  /<GripVertical /,
  /ChevronRight/,
  /aria-expanded=/,
  /<StatusChip/,
];

test('Unconfirmed renders through the same shared component, and keeps no second copy of it', () => {
  assert.match(unconfirmed,
    /import \{\s*ReorderableSections,\s*SectionFrame,\s*type SectionControls,?\s*\} from '@\/components\/ui\/reorderable-sections';/,
    'Unconfirmed must import the shared component — a lookalike is what this file exists to prevent');
  assert.match(unconfirmed, /<ReorderableSections\b/, 'and render its sections inside it');
  assert.match(unconfirmed, /<SectionFrame\b/, 'and each section through the shared frame');

  for (const p of ONE_COPY_ONLY) {
    assert.match(shared, p, `control: ${p} must exist in the shared component for this scan to mean anything`);
    assert.doesNotMatch(unconfirmed, p,
      `${p} is back in ${UNCONFIRMED} — the interaction has re-grown a second copy; delete it and use the shared component`);
  }
});

// ─── 3. Persistence: the URL, not a per-browser arrangement ──────────────

const storageKeys = (src) => [...src.matchAll(/'(easyfix\.crm\.[\w.]+)'/g)].map((m) => m[1]);

test('Pending to Start stores no per-browser arrangement — its view state lives in the URL', () => {
  /*
   * The order/collapse keys (easyfix.crm.pendingStart.sectionOrder.v2 /
   * sectionCollapsed.v1) described an arrangement that no longer exists. What
   * an operator chooses here now — the tab and the filters — is shareable state,
   * so it goes in the URL (asserted in tests/pending-to-start-tabs.test.js),
   * not in one browser's storage where a pasted link cannot carry it.
   */
  assert.deepEqual(storageKeys(view), [], 'the view must not keep a localStorage key');
  assert.doesNotMatch(view, /localStorage/, 'nor touch localStorage at all');
  assert.doesNotMatch(tabs, /localStorage/, 'nor may the strip');

  // Unconfirmed's own keys are untouched by the retirement (its contract is
  // tests/unconfirmed-sections.test.js; this only proves the scan can see keys).
  assert.ok(storageKeys(unconfirmed).length >= 2,
    `control: expected Unconfirmed's keys to be found, found ${storageKeys(unconfirmed).length}`);
});

// ─── 4. No Check In; View opens the job ──────────────────────────────────

/*
 * `'checkin'` is the ACTION ID an old ?action=checkin link parses to, and it
 * must stay in the refetch set (tests/my-orders-checkin-audit.test.js). It is
 * not wording anyone sees, so it is the one spelling removed before the scan.
 */
const CHECK_IN_WORDING = /check[\s-]?in\b/i;
const wordingOf = (src) => src.replace(/'checkin'/g, '');

test('the Pending to Start view has no Check In control, icon or wording', () => {
  for (const [name, src] of [[VIEW, view], [TABS, tabs]]) {
    assert.doesNotMatch(src, /PlayCircle/, `the PlayCircle row icon must not come back (${name})`);
    const hit = wordingOf(src).match(CHECK_IN_WORDING);
    assert.equal(hit, null, `Check In wording is back in ${name}: "${hit && hit[0]}"`);
  }
});

test('a View action still opens the job workspace', () => {
  const buttons = view.match(
    /<button\s+type="button"\s+onClick=\{\(\) => onView\(j\.job_id\)\}\s+className="[^"]*"\s+title="View Job"\s+aria-label="View Job"\s*>\s*<Eye className="h-3\.5 w-3\.5" \/>\s*<\/button>/g,
  ) || [];
  assert.equal(buttons.length, 1, 'exactly one Eye "View Job" button, calling onView(j.job_id)');
  assert.match(view, /import \{[^}]*\bEye\b[^}]*\} from 'lucide-react';/);

  // onView is the page's openView on the one table, whatever the tab.
  assert.match(view, /<PendingStartTable[\s\S]*?onView=\{openView\}[\s\S]*?\/>/, 'the table gets openView');
  // …and the page's openView is the ?action=view workspace.
  const page = strip(read(PAGE));
  assert.match(page, /<PendingToStartView[\s\S]{0,400}?openView=\{openView\}/);
  assert.match(page, /function openView\([^)]*\)\s*\{[^}]*openJobAction\('view',\s*id\);\s*\}/);
});

// ─── Controls ────────────────────────────────────────────────────────────

test('positive control — the stripper removes prose and keeps code', () => {
  const sample = [
    '/* <PlayCircle /> and "Check-In", described in prose */',
    'const kept = 1;',
    '// title="Check In"',
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('PlayCircle'), 'block comments must go');
  assert.ok(!stripped.includes('Check In'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'code must survive');
  assert.ok(view.length < read(VIEW).length, 'the view has comments the scans excluded');
  /*
   * The view's header describes the retired sections by name ("Technician
   * Requests / Over Due / …") and quotes <ReorderableSections> in prose — the
   * exact tokens section 1 forbids. The scans only mean something because that
   * prose is stripped first.
   */
  assert.match(read(VIEW), /reorderable/i, 'control: the raw view still explains the retirement in prose');
});

test('differential control — the removed Check In row icon would be caught', () => {
  /*
   * The exact block e71304d deleted from this view. Re-inserted into a copy of
   * the current source, both guards above must go red; silence from them only
   * means something if they can see this.
   */
  const removed = [
    '{canJob.isJobStatusChange && (',
    '  <button',
    '    type="button"',
    '    onClick={() => onCheckin(j.job_id)}',
    '    className="inline-flex items-center gap-1 text-warning-strong text-xs hover:underline"',
    '    title="Check-In — open the job workspace to review and check in"',
    '  >',
    '    <PlayCircle className="h-3.5 w-3.5" />',
    '  </button>',
    ')}',
  ].join('\n');
  const anchor = '{canJob.isJobReassign && (';
  assert.ok(view.includes(anchor), 'the insertion anchor must exist');
  const mutated = view.replace(anchor, `${removed}\n${anchor}`);
  assert.notEqual(mutated, view, 'the mutation must land');
  assert.match(mutated, /PlayCircle/);
  assert.match(wordingOf(mutated), CHECK_IN_WORDING);

  for (const label of ['Check In', 'Check-In', 'Checkin · Job #1', 'check in']) {
    assert.match(label, CHECK_IN_WORDING, label);
  }
  // …while the retained action id and the legitimate neighbours stay clear.
  assert.doesNotMatch(wordingOf("prevAction.current === 'checkin'"), CHECK_IN_WORDING);
  assert.doesNotMatch('checkin_date_time checks in', CHECK_IN_WORDING);
});

test('differential control — a section mount slipped back in would be caught', () => {
  /*
   * The pre-2026-09-16 render, re-inserted into a copy of the current source:
   * the section-1 scan must see it, or its silence on the real file proves
   * nothing.
   */
  const mutated = view.replace('<PendingStartTable',
    '<ReorderableSections sections={SECTIONS} orderKey={ORDER_KEY} collapsedKey={COLLAPSED_KEY}>{() => null}</ReorderableSections>\n<PendingStartTable');
  assert.notEqual(mutated, view, 'the mutation must land');
  const caught = SECTION_MACHINERY.filter((p) => p.test(mutated));
  assert.ok(caught.length >= 3, `the scan must see the re-grown sections, saw only: ${caught.join(' ')}`);
  assert.equal(SECTION_MACHINERY.filter((p) => p.test(view)).length, 0, 'and nothing on the real file');
});
