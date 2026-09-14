'use strict';
/*
 * Pending to Start — ALL FOUR sections (Technician Requests / Over Due /
 * Action Today / Future) collapse and re-order the way My Orders ->
 * Unconfirmed's sections do, and the row carries no Check In, only a View that
 * opens the job.
 *
 * Technician Requests joined the set on 2026-09-14 (owner: "should also be
 * collapsable, reorderable, etc as other sections"). It had been pinned above
 * the buckets and returned null when empty; both are gone, because a section
 * that renders nothing cannot be dragged. What replaces those two guarantees
 * is asserted below: it is a member of the set, it DEFAULTS first, and the
 * order key was bumped so a pre-change saved order cannot append it last.
 *
 * Source-scanned, like job-app-request.test.js and resend-pin-action.test.js:
 * every rule here lives in a .tsx component that test:build does not compile,
 * and each regression below is a plain deletion that type-checks. The drag
 * ARITHMETIC is behaviour-tested separately (tests/section-reorder.test.js).
 *
 * "Same mechanism as Unconfirmed" is pinned by SHARING it: both pages render
 * through ReorderableSections / SectionFrame, so the interaction cannot drift
 * between them. It was briefly duplicated — the component was lifted out of
 * UnconfirmedSections.tsx for this view on 2026-09-11 and Unconfirmed kept its
 * inline copy — and the check that pinned the two copies string-for-string is
 * replaced below by the one that matters now: Unconfirmed must still render
 * through the shared component and must not re-grow a copy of its own.
 * Unconfirmed's OWN contract (its keys, its fetch, its footer) is covered in
 * tests/unconfirmed-sections.test.js.
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
const SHARED = 'src/components/ui/reorderable-sections.tsx';
const UNCONFIRMED = 'src/components/job/UnconfirmedSections.tsx';
const PAGE = 'src/app/(authed)/my-orders/page.tsx';

const view = strip(read(VIEW));
const shared = strip(read(SHARED));
const unconfirmed = strip(read(UNCONFIRMED));

/* The reorderable region of the view: everything inside <ReorderableSections>. */
function reorderable(src) {
  const open = src.indexOf('<ReorderableSections ');
  const close = src.indexOf('</ReorderableSections>');
  return open > 0 && close > open ? { open, text: src.slice(open, close) } : null;
}

// ─── 1. All four sections are the reorderable set ────────────────────────

test('all four sections, Technician Requests included, render inside the shared ReorderableSections', () => {
  assert.match(view,
    /import \{\s*ReorderableSections,\s*SectionFrame,\s*type SectionControls,?\s*\} from '@\/components\/ui\/reorderable-sections';/,
    'the view must use the shared component, not a second copy of the interaction');

  const region = reorderable(view);
  assert.ok(region, 'the sections must be wrapped in <ReorderableSections>…</ReorderableSections>');
  assert.match(region.text,
    /<ReorderableSections sections=\{SECTIONS\} orderKey=\{ORDER_KEY\} collapsedKey=\{COLLAPSED_KEY\}>/);

  /*
   * The array IS the default arrangement (reconcile() keeps its order when
   * nothing is stored), so 'appRequests' first is the whole of requirement
   * "default position stays FIRST" for a fresh browser.
   */
  const keys = view.match(/const SECTIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(keys, 'SECTIONS must be found');
  assert.deepEqual([...keys[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1]),
    ['appRequests', 'overDue', 'actionToday', 'future'],
    'exactly the four sections, requests first — the array order IS the default arrangement');

  // Each key renders its own section, all of them through {...shared}.
  assert.match(region.text,
    /if \(s\.key === 'appRequests'\) \{\s*return <PendingSection appRequests title="Technician Requests"[^>]*\{\.\.\.shared\} \/>;/,
    'Technician Requests must render for its own key, with the shared props (controls included)');
  for (const [key, title] of [['overDue', 'Over Due'], ['actionToday', 'Action Today']]) {
    assert.match(region.text,
      new RegExp(`if \\(s\\.key === '${key}'\\) \\{\\s*return <PendingSection title="${title}"[^>]*\\{\\.\\.\\.shared\\} />;`),
      `${title} must render for its own key, with the shared props (controls included)`);
  }
  assert.match(region.text, /return <PendingSection title="Future"[^>]*\{\.\.\.shared\} \/>;/);
  assert.match(region.text, /const shared = \{[^}]*\bcontrols,\s*\};/,
    'every section must receive its SectionControls');

  // …and NOTHING renders a PendingSection outside the set any more: one
  // rendered above it would be un-draggable and would silently win the top.
  assert.equal((view.match(/<PendingSection\b/g) || []).length, 4,
    'exactly four <PendingSection> mounts, all inside <ReorderableSections>');
  assert.ok(view.indexOf('title="Technician Requests"') > region.open,
    'Technician Requests must live INSIDE the reorderable region, not pinned above it');
});

test('Technician Requests keeps its identity: subtitle, no date window, its own row grammar', () => {
  const region = reorderable(view);
  assert.match(region.text, /subtitle="Cancellation or reschedule raised from the app"/,
    'the subtitle is what tells an operator what the section is');
  assert.match(region.text, /dateRange=\{NO_DATE_RANGE\}/,
    'a request is orthogonal to the appointment date — it sends no window');
  // Requests-only chrome survives the move into the shared frame.
  assert.match(view, /\{appRequests && <th>Request<\/th>\}/);
  /*
   * The attention strip. The section header is the SHARED one now, so the tint
   * that used to be on the old plain-Card header lives in the body — scoped to
   * THAT div, not to "somewhere in the file": the reschedule chip three
   * hundred lines down also carries both tokens, and a loose scan here reads
   * green off the chip while the strip is gone.
   */
  assert.match(view, /\{appRequests && \(\s*<div className="[^"]*\bbg-warning-tint text-warning-strong">/,
    'the requests body must open with the tint/strong attention strip');
  assert.match(view, /<AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" \/>/);
});

test('each section renders in SectionFrame under Unconfirmed\'s collapse rule, with its own pagination', () => {
  assert.match(view, /return \(\s*<SectionFrame\b/,
    'a section must render through the shared frame');
  assert.doesNotMatch(view, /<Card className=\{appRequests/,
    'the requests section must not keep a plain-Card escape hatch beside the frame');
  assert.match(view, /controls: SectionControls;/,
    'controls is REQUIRED — an optional one is how a section slips back out of the set');
  // Unconfirmed's rule, with ONE deliberate difference: while the count is
  // unknown the buckets open (they almost always have rows) but Technician
  // Requests starts shut — most days it is empty, and a skeleton at the top of
  // the page that then collapses drags the buckets up under the operator.
  assert.match(view, /collapsed=\{controls\.explicitCollapsed \?\? \(data \? total === 0 : appRequests\)\}/,
    'auto rule: shut at 0, an explicit click wins, and only Requests starts shut while unknown');
  assert.match(unconfirmed, /explicitCollapsed \?\? \(data \? total === 0 : false\)/,
    'and that must be the rule Unconfirmed uses');
  assert.match(view, /count=\{data \? total : null\}/, 'the count chip reads the bucket\'s own total');
  assert.match(view, /controls=\{controls\}/);

  // An explicitly shut bucket fetches its count, not its rows — as Unconfirmed
  // does. The requests section is EXEMPT and must stay exempt: its total is
  // matched.length over a client-side filter, so a limit=1 fetch would report
  // 0-or-1 requests. The `appRequests ?` arm ahead of `countOnly ?` is that
  // exemption; if it ever goes, the count chip starts lying while collapsed.
  assert.match(view, /const countOnly = controls\.explicitCollapsed === true;/);
  assert.match(view, /limit: appRequests \? JOBS_MAX_LIMIT : countOnly \? 1 : limit,/);
  assert.match(view, /offset: appRequests \|\| countOnly \? 0 : offset,/);

  // Pagination stays per-bucket, and inside the frame's body.
  const section = view.slice(view.indexOf('function PendingSection('));
  assert.match(section, /const \[page, setPage\] = useState\(0\);/, 'page state belongs to each bucket');
  const body = section.match(/const body = \(\s*<>([\s\S]*?)<\/>\s*\);/);
  assert.ok(body, 'the bucket body must be found');
  assert.match(body[1], /<TablePagination\s+page=\{page\}/, 'each bucket keeps its own footer');
  assert.match(section, /<\/SectionFrame>/);
  assert.match(section, /\{body\}\s*<\/SectionFrame>/, 'the frame wraps that body');
});

test('an empty Technician Requests section still renders its header', () => {
  /*
   * It used to `return null` at total === 0. That is the one thing that made
   * it un-reorderable — you cannot grip a section that is not on the page — so
   * the guard must not come back in ANY shape, not just the exact old line.
   * The section instead takes the buckets' auto-collapse (asserted above), so
   * an empty day costs a shut header rather than a whole card.
   */
  const section = view.slice(view.indexOf('function PendingSection('));
  const earlyReturns = [...section.matchAll(/if \([^)]*appRequests[^)]*\)\s*return null;/g)];
  assert.equal(earlyReturns.length, 0,
    `an appRequests early return is back: ${earlyReturns.map((m) => m[0]).join(' | ')}`);

  // Positive control: that matcher does fire on the line this test replaced.
  assert.match('  if (appRequests && total === 0) return null;',
    /if \([^)]*appRequests[^)]*\)\s*return null;/,
    'control: the scan must be able to see the guard it forbids');
});

// ─── 2. Same interaction as Unconfirmed ──────────────────────────────────

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

// ─── 3. Persistence: Pending to Start's own keys ─────────────────────────

const storageKeys = (src) => [...src.matchAll(/'(easyfix\.crm\.[\w.]+)'/g)].map((m) => m[1]);

test('order and collapse persist under Pending to Start\'s own localStorage keys, never Unconfirmed\'s', () => {
  const mine = storageKeys(view);
  const theirs = storageKeys(unconfirmed);
  assert.equal(mine.length, 2, `expected ORDER_KEY and COLLAPSED_KEY in the view, found ${mine.length}`);
  assert.ok(theirs.length >= 2, `expected Unconfirmed's keys to be found, found ${theirs.length}`);
  assert.match(view, /const ORDER_KEY = 'easyfix\.crm\.pendingStart\.[\w.]+';/);
  assert.match(view, /const COLLAPSED_KEY = 'easyfix\.crm\.pendingStart\.[\w.]+';/);

  /*
   * THE MIGRATION. reconcile() (asserted below, on the shared component)
   * APPENDS a key it has never seen, so an order saved before Technician
   * Requests joined the set — ['overDue','actionToday','future'] under
   * sectionOrder.v1 — would put the new section LAST, the opposite of its
   * default. The order key is therefore at v2: those saved arrangements are
   * retired once and everyone starts from SECTIONS again. Reverting the key to
   * v1 silently demotes the section for every operator who ever dragged one.
   */
  assert.match(view, /const ORDER_KEY = 'easyfix\.crm\.pendingStart\.sectionOrder\.v2';/,
    'the order key must be at v2 or a pre-2026-09-14 saved order appends Technician Requests last');
  assert.match(shared, /for \(const s of sections\) if \(!seen\.has\(s\.key\)\) out\.push\(s\);/,
    'control: reconcile() really does APPEND unknown-to-storage sections — that is why v2 exists');
  assert.notEqual(mine[0], mine[1], 'order and collapse are stored separately');
  for (const k of mine) {
    assert.ok(!theirs.includes(k),
      `${k} is Unconfirmed's key — one page's arrangement would overwrite the other's`);
  }

  // The shared component stores under the CALLER's keys, and guards every access.
  assert.doesNotMatch(shared, /'easyfix\.crm\./, 'the shared component must not hard-code a page\'s key');
  assert.match(shared, /window\.localStorage\.setItem\(orderKey, /);
  assert.match(shared, /window\.localStorage\.setItem\(collapsedKey, /);
  const accesses = [...shared.matchAll(/localStorage\./g)].map((m) => m.index);
  assert.ok(accesses.length >= 4, `expected the four localStorage reads/writes, found ${accesses.length}`);
  for (const i of accesses) {
    assert.ok(shared.slice(Math.max(0, i - 80), i).includes('try {'),
      'every localStorage access must sit in a try — it throws in private windows');
  }
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
  assert.doesNotMatch(view, /PlayCircle/, 'the PlayCircle row icon must not come back');
  const hit = wordingOf(view).match(CHECK_IN_WORDING);
  assert.equal(hit, null, `Check In wording is back in ${VIEW}: "${hit && hit[0]}"`);
});

test('a View action still opens the job workspace', () => {
  const buttons = view.match(
    /<button\s+type="button"\s+onClick=\{\(\) => onView\(j\.job_id\)\}\s+className="[^"]*"\s+title="View Job"\s+aria-label="View Job"\s*>\s*<Eye className="h-3\.5 w-3\.5" \/>\s*<\/button>/g,
  ) || [];
  assert.equal(buttons.length, 1, 'exactly one Eye "View Job" button, calling onView(j.job_id)');
  assert.match(view, /import \{[^}]*\bEye\b[^}]*\} from 'lucide-react';/);

  // onView is the page's openView on every section — one `shared` object now
  // that Technician Requests is a member too, so one assertion covers all four.
  assert.match(view, /onView: openView,/, 'every section gets openView');
  // …and the page's openView is the ?action=view workspace.
  const page = strip(read(PAGE));
  assert.match(page, /<PendingToStartView[\s\S]{0,200}?openView=\{openView\}/);
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
