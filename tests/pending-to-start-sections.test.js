'use strict';
/*
 * Pending to Start — the three appointment buckets (Over Due / Action Today /
 * Future) collapse and re-order the way My Orders -> Unconfirmed's sections
 * do, and the row carries no Check In, only a View that opens the job.
 *
 * Source-scanned, like job-app-request.test.js and resend-pin-action.test.js:
 * every rule here lives in a .tsx component that test:build does not compile,
 * and each regression below is a plain deletion that type-checks. The drag
 * ARITHMETIC is behaviour-tested separately (tests/section-reorder.test.js).
 *
 * "Same mechanism as Unconfirmed" is pinned two ways: Pending to Start must
 * render through the shared ReorderableSections / SectionFrame, and — until
 * UnconfirmedSections.tsx is migrated onto that component — the interaction
 * strings that define the behaviour must read identically in both copies, so
 * neither can drift alone.
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

// ─── 1. The buckets are the reorderable sections ─────────────────────────

test('the three buckets render inside the shared ReorderableSections, Technician Requests outside it', () => {
  assert.match(view,
    /import \{\s*ReorderableSections,\s*SectionFrame,\s*type SectionControls,?\s*\} from '@\/components\/ui\/reorderable-sections';/,
    'the view must use the shared component, not a second copy of the interaction');

  const region = reorderable(view);
  assert.ok(region, 'the buckets must be wrapped in <ReorderableSections>…</ReorderableSections>');
  assert.match(region.text,
    /<ReorderableSections sections=\{BUCKET_SECTIONS\} orderKey=\{ORDER_KEY\} collapsedKey=\{COLLAPSED_KEY\}>/);

  const keys = view.match(/const BUCKET_SECTIONS = \[([^\]]*)\] as const;/);
  assert.ok(keys, 'BUCKET_SECTIONS must be found');
  assert.deepEqual([...keys[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1]),
    ['overDue', 'actionToday', 'future'],
    'exactly the three buckets, in their default order — a missing key never renders its bucket');

  for (const [key, title] of [['overDue', 'Over Due'], ['actionToday', 'Action Today']]) {
    assert.match(region.text,
      new RegExp(`if \\(s\\.key === '${key}'\\) \\{\\s*return <PendingSection title="${title}"[^>]*\\{\\.\\.\\.shared\\} />;`),
      `${title} must render for its own key, with the shared props (controls included)`);
  }
  assert.match(region.text, /return <PendingSection title="Future"[^>]*\{\.\.\.shared\} \/>;/);
  assert.match(region.text, /const shared = \{[^}]*\bcontrols,\s*\};/,
    'every bucket must receive its SectionControls');

  const requests = view.indexOf('title="Technician Requests"');
  assert.ok(requests > 0 && requests < region.open,
    'Technician Requests stays pinned ABOVE the buckets, outside the reorderable set');
  assert.ok(!region.text.includes('title="Technician Requests"'));
});

test('each bucket renders in SectionFrame under Unconfirmed\'s collapse rule, with its own pagination', () => {
  assert.match(view, /if \(controls\) \{\s*return \(\s*<SectionFrame\b/,
    'a bucket must render through the shared frame');
  assert.match(view, /collapsed=\{controls\.explicitCollapsed \?\? \(data \? total === 0 : false\)\}/,
    'auto rule: open while the count is unknown, shut at 0, an explicit click wins');
  assert.match(unconfirmed, /explicitCollapsed \?\? \(data \? total === 0 : false\)/,
    'and that must be the rule Unconfirmed uses');
  assert.match(view, /count=\{data \? total : null\}/, 'the count chip reads the bucket\'s own total');
  assert.match(view, /controls=\{controls\}/);

  // An explicitly shut bucket fetches its count, not its rows — as Unconfirmed does.
  assert.match(view, /const countOnly = controls\?\.explicitCollapsed === true;/);
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

  // Once Unconfirmed renders through the shared component, parity holds by
  // construction; until then its inline copy must still read the same.
  if (/from '@\/components\/ui\/reorderable-sections'/.test(unconfirmed)) return;
  for (const p of PARITY) {
    assert.match(unconfirmed, p,
      `Unconfirmed and the shared component have drifted on ${p} — change both, or migrate Unconfirmed`);
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

  // onView is the page's openView on every section…
  assert.match(view, /onView: openView,/, 'the buckets get openView');
  assert.match(view, /onView=\{openView\}/, 'Technician Requests gets openView');
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
