'use strict';
/*
 * My Orders -> Pending to Start — the tabs model (2026-09-16).
 *
 * The view became what Pending for Scheduling became the same day: a tab strip
 * (All · Slots missed · Reschedule request · Cancel request · Today · Future)
 * with counts, over ONE server-paged table, under the SAME filter bar and URL
 * contract. What could silently go wrong, and is pinned here:
 *
 *   - the strip drifts from the `ptsState` API contract (a value the server
 *     does not know is dropped by its validator, and the tab quietly lists All);
 *   - the counts ask carries ptsState or paging, collapsing five numbers to one;
 *   - a failed counts call blocks triage, or leaves the last filter set's
 *     numbers beside tabs that now list something else;
 *   - the tab or filters stop surviving a reload / a shared link;
 *   - `psOfferState`, shared with the scheduling tab through the ps* params,
 *     leaks into a status-1 query;
 *   - a second, lookalike filter bar grows back instead of the shared one;
 *   - the Request column shows where request rows cannot be, or hides where
 *     they are;
 *   - the console icon renders without a handler, or not first;
 *   - an action that moves a job between tabs refreshes the rows but not the
 *     counts.
 *
 * Source-scanned, like pending-to-start-sections.test.js: every rule lives in a
 * .tsx that test:build does not compile, and each regression is a plain edit
 * that type-checks. The retirement of the old sections is pinned there; the
 * request predicate is behaviour-tested in tests/job-app-request.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Same stripper as the sibling suites: blank block comments (keeping lines),
// then drop line comments, so prose that NAMES a call cannot satisfy a check.
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

const VIEW = 'src/components/job/PendingToStartView.tsx';
const TABS = 'src/components/job/PendingStartTabs.tsx';
const PS_TABS = 'src/components/job/PendingSchedulingTabs.tsx';
const PS_FILTERS = 'src/components/job/PendingSchedulingFilters.tsx';

const view = strip(read(VIEW));
const tabs = strip(read(TABS));
const psTabs = strip(read(PS_TABS));
const psFilters = strip(read(PS_FILTERS));

/* The table component, from its declaration to the end of the file. */
const tableOf = (src) => src.slice(src.indexOf('function PendingStartTable('));
/* The row's action cell. */
function actionCellOf(src) {
  const at = src.indexOf('stick-col stick-right text-right whitespace-nowrap');
  return at > -1 ? src.slice(at, src.indexOf('</td>', at)) : '';
}

// ─── 1. The strip ────────────────────────────────────────────────────────

test('the strip lists the six states in the agreed order, labels and API values', () => {
  const entries = [...tabs.matchAll(/\{ value: '([^']*)',\s*label: '([^']*)',\s*key: '([^']*)',\s*title: '([^']*)' \}/g)];
  assert.equal(entries.length, 6, `expected six tab entries, found ${entries.length}`);
  assert.deepEqual(entries.map((m) => m[2]),
    ['All', 'Slots missed', 'Reschedule request', 'Cancel request', 'Today', 'Future'],
    'the labels and their order are the owner\'s call — do not reorder or rename');
  assert.deepEqual(entries.map((m) => m[1]), ['', 'missed', 'reschedule', 'cancel', 'today', 'future'],
    'each value IS a ptsState the backend accepts; All sends none');
  assert.deepEqual(entries.map((m) => m[3]), ['all', 'missed', 'reschedule', 'cancel', 'today', 'future'],
    'each key IS a field of the counts response');
  assert.match(tabs, /export type PtsState = '' \| 'missed' \| 'reschedule' \| 'cancel' \| 'today' \| 'future';/);
  assert.match(tabs,
    /type Counts = \{ all: number; cancel: number; reschedule: number; missed: number; today: number; future: number \};/,
    'the counts shape is the contract: { all, cancel, reschedule, missed, today, future }');

  // The two request tabs say where the ask came from (the retired section's subtitle).
  for (const kind of ['reschedule', 'cancel']) {
    const e = entries.find((m) => m[1] === kind);
    assert.match(e[4], /asked from the app/, `the ${kind} tab's title must say the technician asked from the app`);
  }
});

test('an unknown ?ptsTab= resolves to All, never to a state the server does not know', () => {
  assert.match(tabs, /export function toPtsState\(raw: string \| null\): PtsState \{/);
  assert.match(tabs, /const hit = TABS\.find\(\(t\) => t\.value !== '' && t\.value === raw\);/,
    'only the five real states may be read from the URL');
  assert.match(tabs, /return hit \? hit\.value : '';/, 'anything else is All');
});

test('counts come from /admin/jobs/pending-start/counts through useFetch, keyed by the filters', () => {
  assert.match(tabs, /return `\/admin\/jobs\/pending-start\/counts\$\{s \? `\?\$\{s\}` : ''\}`;/);
  assert.match(tabs, /const \{ data, error, refetch \} = useFetch<Counts>\(key\);/);
  assert.doesNotMatch(tabs, /\bapi\.(get|post)\b/, 'no hand-rolled fetch — useFetch dedupes and caches');
  assert.match(tabs, /\}, \[params\]\);/, 'the key is rebuilt only when the filters change, not on a tab click');
});

test('a failed counts call leaves the tabs working and numberless — never showing stale numbers', () => {
  assert.match(tabs, /const counts = error \? null : data;/,
    'useFetch keeps the previous key\'s data through a failure — those numbers belong to another filter set');
  assert.match(tabs, /const n = counts\?\.\[t\.key\];/);
  assert.match(tabs, /\{n != null && \(/, 'the number renders only when there is one');
  // Switching never depends on the counts.
  assert.match(tabs, /onClick=\{\(\) => onChange\(t\.value\)\}/);
  const button = tabs.slice(tabs.indexOf('<button'), tabs.indexOf('</button>'));
  assert.doesNotMatch(button, /disabled=/, 'a tab must stay clickable with no count');
});

test('reloadKey recounts, exactly as on the scheduling strip', () => {
  const effect = /const firstRef = useRef\(true\);\s*useEffect\(\(\) => \{\s*if \(firstRef\.current\) \{ firstRef\.current = false; return; \}\s*refetch\(\);\s*\}, \[reloadKey\]\);/;
  assert.match(tabs, effect, 'the strip must refetch on a bumped reloadKey');
  assert.match(psTabs, effect, 'control: and that is the scheduling strip\'s own effect');
});

test('the strip looks like the scheduling strip, and carries its way out on the right', () => {
  for (const cls of [
    'flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5',
    'rounded-md px-3 py-1.5 text-sm transition-colors',
    'bg-background font-medium text-foreground shadow-sm',
    'text-muted-foreground hover:bg-background/60 hover:text-foreground',
  ]) {
    assert.ok(psTabs.includes(cls), `control: the scheduling strip must carry "${cls}"`);
    assert.ok(tabs.includes(cls), `the pending-start strip drifted from the scheduling strip: "${cls}"`);
  }
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab"\s+aria-selected=\{active\}/);

  // Clamped → the explanation; otherwise Show All Orders, only when wired.
  assert.match(tabs,
    /\{clamped \? \(\s*<span className="px-2 text-xs text-muted-foreground">Limited By Your Job Stage Access<\/span>\s*\) : onShowAll \? \(\s*<button type="button" onClick=\{onShowAll\} className="px-2 text-xs hover:underline">\s*Show All Orders\s*<\/button>\s*\) : null\}/);
  assert.match(tabs, /onShowAll\?: \(\) => void;/);
});

// ─── 2. The view wires the strip ─────────────────────────────────────────

test('the view hands the strip its state, counts params, recount signal and the new props', () => {
  const mount = view.match(/<PendingStartTabs[\s\S]*?\/>/);
  assert.ok(mount, 'positive control: the strip mount must be found');
  for (const prop of [
    /value=\{ptsTab\}/, /onChange=\{setPtsTab\}/, /params=\{countParams\}/,
    /reloadKey=\{reloadKey\}/, /clamped=\{scopeClamped\}/, /onShowAll=\{onShowAll\}/,
  ]) {
    assert.match(mount[0], prop, `the strip mount lost ${prop}`);
  }
});

test('the counts ask carries the filters, owner and search — never ptsState, sort or paging', () => {
  const memo = view.match(/const countParams = useMemo\(\s*\(\) => \(([^)]*)\),\s*\[([^\]]*)\],\s*\);/);
  assert.ok(memo, 'positive control: countParams must be found');
  assert.equal(memo[1].replace(/\s+/g, ' ').trim(), '{ ...filterParams, ownerId, q: debouncedSearch || undefined }');
  assert.doesNotMatch(memo[1], /ptsState|ptsTab|limit|offset|sortBy|sortDir/,
    'a count cannot depend on the tab or the page — and the tab would collapse five numbers to one');
});

test('the new props are optional and the existing ones keep their shape', () => {
  const props = view.match(/export type PendingToStartViewProps = \{([\s\S]*?)\n\};/);
  assert.ok(props, 'positive control: the props type must be found');
  for (const p of [
    /\bme: Me \| null \| undefined;/,
    /\bisAdmin: boolean;/,
    /\bcanJob: Record<string, boolean>;/,
    /\bopenView: \(jobId: number\) => void;/,
    /\bopenReassign: \(jobId: number\) => void;/,
    /\bonShowLocation: \(row: \{ job_id: number; easyfixer_name: string \| null \}\) => void;/,
    /\bonShowAll\?: \(\) => void;/,
    /\bscopeClamped\?: boolean;/,
    /\bonOpenConsole\?: \(jobId: number\) => void;/,
  ]) {
    assert.match(props[1], p, `PendingToStartViewProps lost or changed ${p}`);
  }
  assert.match(view, /scopeClamped = false,/, 'an unwired host is not clamped');
});

// ─── 3. One table, the server's partition ────────────────────────────────

test('the table asks the server for the selected state: status=1, ptsState omitted on All', () => {
  const table = tableOf(view);
  assert.match(table,
    /const scope = \{\s*status: 1,\s*ptsState: ptsState \|\| undefined,\s*\.\.\.filterParams,\s*q: q \|\| undefined,\s*ownerId,\s*\};/,
    'status pin, state, filters, search and owner — nothing else decides which rows exist');
  assert.match(table,
    /const key = buildJobsKey\(\{\s*\.\.\.scope,\s*sortBy: 'requested_date_time',\s*sortDir: 'asc',\s*limit,\s*offset,\s*\}\);/,
    'the rows are that scope, sorted soonest-appointment first, one server page at a time');
  assert.doesNotMatch(view, /appRequest:/, 'the tabs replaced the appRequest filter — sending both would AND them');
});

test('changing tab, filter or search lands on page 1 in the same render', () => {
  const table = tableOf(view);
  assert.match(table, /const scopeKey = buildJobsKey\(scope\);/);
  assert.match(table, /const \[paging, setPaging\] = useState\(\{ scopeKey, page: 0 \}\);/);
  assert.match(table, /const page = paging\.scopeKey === scopeKey \? paging\.page : 0;/,
    'a page chosen under another scope must read as the first page');
  assert.match(table, /const offset = page \* limit;/);
});

test('a failed first load says so instead of reading as an empty tab', () => {
  const table = tableOf(view);
  assert.match(table, /\{error && !data\s*\? `Could not load orders: \$\{error\}`/);
  assert.match(table, /: narrowed\s*\? 'No orders match these filters\.'/);
  assert.match(table, /: `\$\{EMPTY_COPY\[ptsState\]\}\$\{!isAdmin \? ' owned by you' : ''\}\.`/);
  assert.match(view, /const EMPTY_COPY: Record<PtsState, string> = \{/,
    'keyed by PtsState, so a new tab cannot type-check without its empty copy');
});

test('the Request column shows on All and the two request tabs only, and paints the old section\'s cell', () => {
  const table = tableOf(view);
  const set = view.match(/const REQUEST_COLUMN_TABS: ReadonlySet<PtsState> = new Set<PtsState>\(\[([^\]]*)\]\);/);
  assert.ok(set, 'positive control: REQUEST_COLUMN_TABS must be found');
  assert.deepEqual([...set[1].matchAll(/'([^']*)'/g)].map((m) => m[1]), ['', 'reschedule', 'cancel']);
  assert.match(table, /const showRequest = REQUEST_COLUMN_TABS\.has\(ptsState\);/);
  assert.match(table, /\{showRequest && <th>Request<\/th>\}/);
  assert.match(table,
    /\{showRequest && \(\s*<td className="min-w-\[13rem\] max-w-\[20rem\] align-top">\s*\{req \? \(\s*<div className="space-y-0\.5">\s*<StatusChip tone=\{req\.tone\} size="sm">\{req\.label\}<\/StatusChip>\s*<div className="text-xs break-words">\{req\.reason \?\? 'No reason given'\}<\/div>\s*<div className="text-xs text-muted-foreground whitespace-nowrap">\s*Raised \{formatDate\(req\.raisedAt\)\}\s*<\/div>\s*<\/div>\s*\) : \(\s*'—'\s*\)\}\s*<\/td>\s*\)\}/,
    'chip (the lib\'s tones), reason or "No reason given", "Raised <date>" — and a dash on a row with no ask');
  // Header and body cell in the same position: right after Job ID.
  assert.ok(table.indexOf('{showRequest && <th>Request</th>}') < table.indexOf('<th className="w-16">Age</th>'));
});

// ─── 4. Filters, search and the URL ──────────────────────────────────────

test('the filter bar IS PendingSchedulingFilters with hideOfferState — the old bar is gone', () => {
  assert.match(view,
    /import \{\s*PendingSchedulingFilters,\s*psFiltersFromParams,\s*writePsFilterParams,\s*psFilterKey,\s*psAnyFilterSet,\s*psQueryParams,\s*type PsFilters,\s*\} from '@\/components\/job\/PendingSchedulingFilters';/);
  const mount = view.match(/<PendingSchedulingFilters[\s\S]*?\/>/);
  assert.ok(mount, 'the shared bar must be mounted');
  assert.match(mount[0], /\bhideOfferState\b/, 'Scheduling Status means nothing on status-1 jobs');
  assert.match(mount[0], /onChange=\{\(next\) => setFilters\(withoutOfferState\(next\)\)\}/);

  for (const gone of [/SearchMultiSelect/, /projectManagerId/, /Project Manager/, /useLookup/, /\bsetDraft\b/, /\bapplied\b/]) {
    assert.doesNotMatch(view, gone, `${gone} — the view's own PM/ZM/Client/City bar must not grow back`);
  }
});

test('filters persist through the shared ps* helpers, and psOfferState never reaches this query', () => {
  assert.match(view, /useState<PsFilters>\(\(\) => withoutOfferState\(psFiltersFromParams\(searchParams\)\)\)/,
    'hydrated on first render, with the scheduling tab\'s offer state dropped');
  assert.match(view, /function withoutOfferState\(f: PsFilters\): PsFilters \{\s*return f\.offerState \? \{ \.\.\.f, offerState: '' \} : f;\s*\}/);
  assert.match(view, /const filterKey = psFilterKey\(filters\);/);
  assert.match(view, /const p = psQueryParams\(filters\);\s*delete p\.offerState;\s*return p;/,
    'and dropped again where the params are built');
  assert.match(view, /writePsFilterParams\(p, filters\);/);
});

test('the selected tab is mirrored into the URL as ptsTab, hydrated on first render', () => {
  assert.match(view, /export const PTS_TAB_PARAM = 'ptsTab';/);
  assert.match(view, /useState<PtsState>\(\(\) => toPtsState\(searchParams\.get\(PTS_TAB_PARAM\)\)\)/);
  const effect = view.match(/useEffect\(\(\) => \{\s*const p = new URLSearchParams\(searchParams\);([\s\S]*?)\}, \[([^\]]*)\]\);/);
  assert.ok(effect, 'positive control: the URL effect must be found');
  assert.match(effect[1], /if \(ptsTab\) p\.set\(PTS_TAB_PARAM, ptsTab\); else p\.delete\(PTS_TAB_PARAM\);/,
    'All is the absence of the param, not ptsTab=');
  assert.match(effect[1], /if \(next !== searchParams\.toString\(\)\) \{\s*router\.replace\(/,
    'a no-op must not replace (and must not push history)');
  assert.equal(effect[2].replace(/\s+/g, ''), 'ptsTab,filterKey',
    'searchParams stays OUT of the deps, or a replace re-runs the effect that made it');
  assert.doesNotMatch(effect[1], /'q'/, 'the page owns ?q= — a second writer would clobber it');
});

test('search leads the filters\' row, with Clear Filters on it, and everything wraps', () => {
  const row = view.indexOf('<div className="flex flex-wrap items-end gap-3">');
  assert.ok(row > -1, 'the search + filters row must be one flex-wrap container');
  const searchAt = view.indexOf('<Search ', row);
  const inputAt = view.indexOf('value={search}', row);
  const barAt = view.indexOf('<PendingSchedulingFilters', row);
  assert.ok(searchAt > row && inputAt > searchAt && barAt > inputAt, 'the search box comes first on that line');
  assert.match(view, /<div className="relative w-full xl:w-64 xl:shrink-0">/,
    'full width when narrow, a fixed slot on the shared line when wide');
  assert.match(view, /<div className="min-w-0 flex-1">\s*<PendingSchedulingFilters/);
  // Clear Filters rides on the bar's own controls row — the bar's, not a copy.
  assert.match(psFilters, /<div className="flex flex-wrap items-end gap-3">[\s\S]*?Clear Filters/,
    'control: the shared bar keeps Clear Filters on its controls\' row');
  assert.doesNotMatch(view, /Clear Filters|>\s*Clear\s*</, 'the view must not add a second Clear');
  // Search behaviour unchanged: debounced, instant, server-side.
  assert.match(view, /const debouncedSearch = useDebouncedValue\(search\.trim\(\), 300\);/);
});

// ─── 5. Row: the console icon, and the reload after actions ──────────────

test('the job console icon is first in the action cell, and only when the host wired it', () => {
  const cell = actionCellOf(view);
  assert.ok(cell, 'positive control: the action cell must be found');
  assert.match(cell,
    /\{onOpenConsole && \(\s*<button\s+type="button"\s+onClick=\{\(\) => onOpenConsole\(j\.job_id\)\}\s+className="inline-flex items-center gap-1 text-primary text-xs hover:underline"\s+title="Open job console"\s+aria-label="Open job console"\s*>\s*<PanelsTopLeft className="h-3\.5 w-3\.5" \/>\s*<\/button>\s*\)\}/);
  const order = ['onOpenConsole(j.job_id)', 'onShowLocation(j)', 'onView(j.job_id)', 'onReassign(j.job_id)', '<ResendPinButton', '<TechRequestActions']
    .map((s) => [s, cell.indexOf(s)]);
  for (const [s, i] of order) assert.ok(i > -1, `${s} must still be in the action cell`);
  for (let k = 1; k < order.length; k += 1) {
    assert.ok(order[k - 1][1] < order[k][1], `${order[k - 1][0]} must come before ${order[k][0]} — existing icons keep their order`);
  }
  assert.match(view, /import \{[^}]*\bPanelsTopLeft\b[^}]*\} from 'lucide-react';/);
});

test('a closed console, reassign or view — and every Approve / Reject — refreshes the rows AND recounts', () => {
  const guard = view.match(/prevAction\.current === 'reassign'[\s\S]{0,300}?\) &&/);
  assert.ok(guard, 'positive control: the refetch set must be found');
  assert.ok(guard[0].includes("prevAction.current === 'console'"),
    "'console' (the accepted-job console, ?action=console) must be in the refetch set — it can approve or reject a request, or reschedule");
  assert.match(view, /const bumpReload = \(\) => \{\s*invalidateFetch\(\(k\) => k\.startsWith\('\/admin\/jobs'\)\);\s*setReloadKey\(\(k\) => k \+ 1\);\s*\};/,
    'the eviction prefix covers /admin/jobs/pending-start/counts too');
  assert.match(view, /<PendingStartTabs[\s\S]*?reloadKey=\{reloadKey\}/, 'the strip recounts');
  assert.match(view, /<PendingStartTable[\s\S]*?reloadKey=\{reloadKey\}/, 'the table refetches');
  assert.match(view, /<PendingStartTable[\s\S]*?onRequestActioned=\{bumpReload\}/, 'Approve / Reject use the same signal');
});

// ─── Controls ────────────────────────────────────────────────────────────

test('positive control — the stripper removes prose and keeps code', () => {
  const sample = [
    "/* ptsState: ptsState || undefined, described in prose */",
    'const kept = 1;',
    "// prevAction.current === 'schedule'",
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('ptsState'), 'block comments must go');
  assert.ok(!stripped.includes('schedule'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'code must survive');
  assert.equal(stripped.split('\n').length, sample.split('\n').length, 'blanking keeps the line count');
  for (const [name, file, code] of [[VIEW, read(VIEW), view], [TABS, read(TABS), tabs]]) {
    assert.ok(code.replace(/\s+/g, '').length < file.replace(/\s+/g, '').length,
      `${name} must contain comments the scans excluded`);
  }
});

test('differential control — the guards go red when their subject is removed', () => {
  const cases = [
    ['ptsState in the list scope',
      view, view.replace('ptsState: ptsState || undefined,', ''),
      /status: 1,\s*ptsState: ptsState \|\| undefined,/],
    ['the offer-state pin on hydrate',
      view, view.replace('withoutOfferState(psFiltersFromParams(searchParams))', 'psFiltersFromParams(searchParams)'),
      /useState<PsFilters>\(\(\) => withoutOfferState\(psFiltersFromParams\(searchParams\)\)\)/],
    ['console in the refetch set',
      view, view.replace(/\s*\|\| prevAction\.current === 'console'\)/, ')'),
      /prevAction\.current === 'console'/],
    ['showRequest on the Request header',
      view, view.replace('{showRequest && <th>Request</th>}', '<th>Request</th>'),
      /\{showRequest && <th>Request<\/th>\}/],
  ];
  for (const [what, original, mutated, pattern] of cases) {
    // The mutation must have LANDED, or the check below runs on pristine source.
    assert.notEqual(mutated, original, `the mutation for ${what} did not change the source`);
    assert.match(original, pattern, `control: ${what} matches the real source`);
    assert.doesNotMatch(mutated, pattern, `${what}: the guard still passes with its subject removed`);
  }

  // Order: moving the console icon after Reassign must flip the order scan.
  const cell = actionCellOf(view);
  const icon = cell.match(/\{onOpenConsole && \([\s\S]*?<\/button>\s*\)\}/);
  assert.ok(icon, 'control: the console icon block must be found');
  const moved = cell.replace(icon[0], '').replace('{canJob.isJobReassign && (', `${icon[0]}\n{canJob.isJobReassign && (`);
  assert.notEqual(moved, cell, 'the order mutation must land');
  assert.ok(moved.indexOf('onOpenConsole(j.job_id)') > moved.indexOf('onView(j.job_id)'),
    'the order scan would see the icon out of place');
});
