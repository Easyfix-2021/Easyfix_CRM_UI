'use strict';
/*
 * Schedule & Assign can edit a job's services, and every edit that feeds the
 * technician ranking re-ranks the Top-10 — made in S&A itself, or in the View
 * modal just before S&A is (re)opened.
 *
 * ─── THE REQUEST (2026-09-11) ──────────────────────────────────────────────
 *
 * The View modal's Services tab can add / re-quantity / remove services on a
 * Pending-for-Scheduling job; Schedule & Assign could not. And the Top-10 must
 * follow a services, address or date change from either modal.
 *
 * ─── WHAT IS PINNED, AND WHY THESE ─────────────────────────────────────────
 *
 *   (i)   The Edit Services control appears only where a host opts in, only for
 *         isJobEdit, and in S&A only on an offerable (non-read-only) open.
 *   (ii)  The editor IS JobModal's ServicesTabBody, fed from a real
 *         /admin/jobs/:id read — the /candidates job header lacks every field
 *         it needs (job_service_id, fk_client_id, …), so a cast would render.
 *   (iii) Every services write ends in onMutated, and S&A's onMutated re-ranks:
 *         evict the candidates cache AND re-run the mounted Top-10 hook —
 *         invalidateFetch alone never re-runs a mounted useFetch.
 *   (iv)  JobModal's refresh() evicts the candidates cache. S&A ranks on open,
 *         but useFetch serves a reopen within 30s the ranking it cached last
 *         time, so a View-modal edit in that window re-showed the old ranking.
 *   (vi)  Scheduling History (Schedule tab) refetches on refresh()'s key.
 *
 * ((v), JobForm's remarks remount, lives with its siblings in
 * cancel-refreshes-comments.test.js.)
 *
 * The suite mounts nothing, so the two functions that DO the re-ranking —
 * reRank() and refresh() — are lifted out of the TSX and RUN against stubs.
 * Everything else is structural, parsed where "inside which function" matters.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SA = read('src/components/job/ScheduleAssignModal.tsx');
const JM = read('src/components/job/JobModal.tsx');
const PANEL = read('src/components/job/JobContextPanel.tsx');
/* Comments out, so prose that NAMES a call can never satisfy a check for it. */
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SA_CODE = strip(SA);
const JM_CODE = strip(JM);
const PANEL_CODE = strip(PANEL);

/*
 * Lift a component-local function (2-space indent, closed by `\n  }\n`) out of
 * its TSX and return a factory taking the closure variables it reads. Same
 * transpile call as tests/festivals.test.js / confirm-view-history.test.js.
 */
function lift(src, header, params) {
  const start = src.indexOf(header);
  assert.ok(start > -1, `${header.trim()} must exist`);
  const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  const name = header.match(/function (\w+)/)[1];
  const { outputText } = ts.transpileModule(
    `module.exports = function make(${params.join(', ')}) {\n${body}\nreturn ${name};\n};`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  );
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  assert.equal(typeof mod.exports, 'function', `${name}: the lifted text must evaluate`);
  return mod.exports;
}
const evictsWith = (preds) => (key) => preds.some((p) => p(key));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx$/.test(e.name) ? [p] : [];
  });
}

// ── (i) the control, and who gets it ─────────────────────────────────────

test('(i) the panel renders Edit Services only through the opt-in prop AND isJobEdit', () => {
  assert.match(PANEL_CODE, /const canEditServices = !!onEditServices && hasAction\(me, 'isJobEdit'\);/,
    'the prop alone must not be enough — hasAction fails closed while /me loads');
  const hits = [...PANEL_CODE.matchAll(/Edit Services/g)];
  assert.equal(hits.length, 1, `expected one Edit Services control, found ${hits.length}`);
  const lead = PANEL_CODE.slice(Math.max(0, hits[0].index - 300), hits[0].index);
  assert.match(lead, /\{canEditServices && \(\s*<Button\b[^>]*onClick=\{onEditServices\}/,
    'the button must sit behind canEditServices and call the host');
  // Removing a job's LAST service must not take the button away with the list.
  assert.match(PANEL_CODE, /\{\(\(job\.services && job\.services\.length > 0\) \|\| canEditServices\) && \(/,
    'the Services block must still render, empty, while editable');
});

test('(i) only Schedule & Assign opts in, and only on an offerable open', () => {
  const mounts = walk(SRC_DIR).flatMap((file) => [...strip(fs.readFileSync(file, 'utf8'))
    .matchAll(/<JobContextPanel\b[\s\S]*?\n\s*\/>/g)]
    .map((m) => ({ file: path.relative(SRC_DIR, file), body: m[0] })));
  // Silence is the passing signal for the non-S&A hosts, so prove the scan saw them.
  assert.ok(mounts.length >= 2, `expected S&A + Assign/Reassign mounts, found ${mounts.length}`);
  const sa = mounts.filter((m) => m.file.endsWith('ScheduleAssignModal.tsx'));
  assert.equal(sa.length, 1, 'S&A must mount the panel once');
  for (const m of mounts.filter((x) => x !== sa[0])) {
    assert.doesNotMatch(m.body, /\bonEditServices=/, `${m.file}: a read-only host must not sprout Edit Services`);
  }
  // Same gate as Edit Address: withheld on a read-only open. The dialog must
  // read the job as it is NOW, so the probe's cached detail is dropped first.
  const prop = sa[0].body.match(/onEditServices=\{jobId != null && offerable \? \(\) => \{([\s\S]*?)\} : undefined\}/);
  assert.ok(prop, 'onEditServices must be gated on `jobId != null && offerable`');
  const evictAt = prop[1].indexOf('invalidateFetch((k) => k === `/admin/jobs/${jobId}`);');
  assert.ok(evictAt > -1 && evictAt < prop[1].indexOf('setServicesOpen(true);'),
    'evict the /admin/jobs/:id key BEFORE opening, or the editor reads the S&A-open snapshot');
});

// ── (ii) the editor is JobModal's, on a real job read ────────────────────

test('(ii) the dialog feeds JobModal\'s ServicesTabBody from its own /admin/jobs/:id useFetch', () => {
  assert.match(JM_CODE, /\nexport function ServicesTabBody\(/, 'JobModal must export the editor');
  assert.match(SA_CODE, /import \{[^}]*\bServicesTabBody\b[^}]*\} from '\.\/JobModal';/, 'S&A imports it');
  assert.doesNotMatch(SA_CODE, /function ServicesTabBody\(/, 'a copy would drift from the View modal\'s gates');
  // No module cycle: S&A → JobModal is fine only while JobModal never imports S&A.
  assert.doesNotMatch(JM_CODE, /from '(\.\/|@\/components\/job\/)ScheduleAssignModal'/);

  const start = SA_CODE.indexOf('\nfunction EditServicesDialog(');
  assert.ok(start > -1, 'EditServicesDialog must exist');
  const dlg = SA_CODE.slice(start);
  assert.match(dlg, /const detail = useFetch<[\s\S]*?>\(`\/admin\/jobs\/\$\{jobId\}`\);/,
    'the job must come from GET /admin/jobs/:id through @/lib/hooks');
  assert.match(dlg, /const job = detail\.data && Number\(detail\.data\.job_id\) === jobId \? detail\.data : null;/,
    'identity-guarded, like the probe');
  assert.match(dlg, /<ServicesTabBody\s+job=\{job\}/, 'and that is what the editor gets');
  assert.doesNotMatch(dlg, /\bas unknown as\b|\bas Job\b/, 'never the /candidates header cast to Job');

  // "Enabled only while open": mounted only while open, closed on a job switch.
  assert.match(SA_CODE, /\{servicesOpen && jobId != null && \(\s*<EditServicesDialog\b/);
  const reset = SA_CODE.slice(SA_CODE.indexOf('seededFromRef.current = null;'), SA_CODE.indexOf('}, [open, jobId]);'));
  assert.match(reset, /setServicesOpen\(false\);/, 'the open/job reset must close the editor too');
});

// ── (iii) every write re-ranks ────────────────────────────────────────────

test('(iii) every write ServicesTabBody makes ends in onMutated() — the host\'s only signal', () => {
  const sf = ts.createSourceFile('JobModal.tsx', JM, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name && n.name.text === 'ServicesTabBody');
  assert.ok(body, 'ServicesTabBody must be found');
  const namedFn = (n) => {
    let f = n.parent;
    while (f && !(ts.isFunctionDeclaration(f) && f.name)) f = f.parent;
    return f;
  };
  const writers = new Map();
  (function visit(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'api'
      && ['post', 'put', 'patch', 'delete'].includes(n.expression.name.text)) {
      const fn = namedFn(n);
      // A write inline in JSX would resolve to ServicesTabBody itself.
      assert.ok(fn && fn !== body, `a write outside a named handler: ${n.getText(sf).slice(0, 70)}`);
      writers.set(fn.name.text, fn);
    }
    ts.forEachChild(n, visit);
  })(body);
  // Positive control on the locator: the four writes the brief names.
  for (const name of ['submitInlineAdd', 'saveQty', 'removeService', 'restoreService']) {
    assert.ok(writers.has(name), `the scan must find ${name} (found: ${[...writers.keys()].join(', ')})`);
  }
  for (const [name, fn] of writers) {
    const text = strip(fn.getText(sf));
    const callAt = text.indexOf('onMutated?.();');
    assert.ok(callAt > text.indexOf('await api.'), `${name}: must call onMutated() after its write lands`);
  }
});

test('(iii) reRank drops THIS job\'s candidates, re-runs the mounted Top-10, and tells the host', () => {
  const make = lift(SA, '  function reRank() {', ['jobId', 'invalidateFetch', 'top', 'onChanged', 'searchKey', 'searchRes']);
  const preds = [];
  let refetches = 0;
  let changed = 0;
  let searches = 0;
  const search = { refetch: () => { searches += 1; } };
  make(42, (p) => preds.push(p), { refetch: () => { refetches += 1; } }, () => { changed += 1; }, null, search)();
  assert.equal(searches, 0, 'no search typed → nothing to re-run');
  make(42, () => {}, { refetch() {} }, undefined, '/admin/jobs/42/candidates/search?term=ra', search)();
  assert.equal(searches, 1, 'a typed search is a second mounted ranking — it must re-run too');
  const evicts = evictsWith(preds);
  assert.ok(evicts('/admin/jobs/42/candidates?limit=10'), 'the Top-10 key');
  assert.ok(evicts('/admin/jobs/42/candidates/search?term=ra&jobDate=2026-09-12%2010%3A00%3A00'), 'and the search key');
  assert.ok(!evicts('/admin/jobs/421/candidates?limit=10'), 'another job\'s ranking stays cached');
  assert.ok(!evicts('/admin/jobs/42/offers'), 'offers are not a ranking');
  assert.equal(refetches, 1, 'eviction cannot re-run a mounted hook — top.refetch() must');
  assert.equal(changed, 1, 'the list behind the modal renders some of these fields');
  make(42, () => {}, { refetch() {} }, undefined, null, search)(); // onChanged is optional on the host
});

test('(iii) + item 3: every edit made IN Schedule & Assign re-ranks', () => {
  // Services: the dialog re-reads its own table, then hands off to reRank.
  const dlg = SA_CODE.slice(SA_CODE.indexOf('\nfunction EditServicesDialog('));
  assert.match(dlg, /onMutated=\{\(\) => \{ detail\.refetch\(\); onMutated\(\); \}\}/,
    'the dialog\'s table must show the write, and the host must hear of it');
  assert.match(SA_CODE, /<EditServicesDialog\b[\s\S]*?onMutated=\{reRank\}/, 'the host re-ranks on it');
  // Address + description — the pre-existing two, now through the same helper.
  assert.match(SA_CODE, /onAddressSaved=\{jobId != null && offerable \? reRank : undefined\}/);
  const d = SA_CODE.slice(SA_CODE.indexOf('onSaveDetails={'), SA_CODE.indexOf('} : undefined}', SA_CODE.indexOf('onSaveDetails={')));
  assert.ok(d.indexOf('reRank();') > d.indexOf('await api.patch('), 'description: re-rank once the PATCH lands');
  // Reschedule keeps its own onDone (it also veils the list, refreshes offers).
  const r = SA_CODE.slice(SA_CODE.indexOf('<RescheduleDialog'), SA_CODE.indexOf('/>', SA_CODE.indexOf('<RescheduleDialog')));
  assert.match(r, /onDone=\{\(\) => \{[\s\S]*top\.refetch\(\);/, 'a reschedule must re-run the Top-10');
});

// ── (iv) the View modal's writes reach S&A's cache ───────────────────────

test('(iv) refresh() evicts THIS job\'s candidates and scheduling history, and bumps the key once', async () => {
  const make = lift(JM, '  async function refresh() {',
    ['resolvedJobId', 'invalidateFetch', 'setCommentsRefreshKey', 'setJob', 'api', 'fetchQuery']);
  const preds = [];
  let bumps = 0;
  let job = null;
  const api = { get: async (key) => ({ key }) };
  await make(42, (p) => preds.push(p), () => { bumps += 1; }, (j) => { job = j; }, api, undefined)();
  const evicts = evictsWith(preds);
  for (const k of ['/admin/jobs/42/candidates?limit=10', '/admin/jobs/42/candidates/search?term=ab',
    '/admin/reports/job-tracking?jobId=42', '/admin/jobs/42/comments']) {
    assert.ok(evicts(k), `refresh() must evict ${k}`);
  }
  for (const k of ['/admin/jobs/421/candidates?limit=10', '/admin/jobs/4/candidates?limit=10',
    '/admin/reports/job-tracking?jobId=421', '/admin/jobs/42/offers']) {
    assert.ok(!evicts(k), `refresh() must not evict ${k}`);
  }
  assert.equal(bumps, 1, 'the mounted readers refetch on this key');
  assert.deepEqual(job, { key: '/admin/jobs/42' }, 'positive control: the lifted refresh() really ran to the end');
});

test('(iv) every View-modal write that feeds the ranking goes through refresh()', () => {
  assert.match(JM_CODE, /<ViewBody\b[\s\S]*?onRefresh=\{refresh\}/, 'ViewBody\'s onRefresh IS refresh()');
  assert.match(JM_CODE, /<ServicesTabBody job=\{job\} onMutated=\{onRefresh\}/, 'services');
  assert.match(JM_CODE, /<JobAddressCard job=\{job\} onSaved=\{onRefresh\}/, 'address');
  assert.match(JM_CODE, /<JobCustomerRequests\b[^>]*onJobChanged=\{onRefresh\}/, 'a customer\'s requested reschedule');
  // The footer Reschedule: ActionBar's dialog → onChanged → refresh().
  assert.match(JM_CODE, /<ApptRescheduleDialog\s+open=\{rescheduleOpen\}[\s\S]*?onDone=\{\(\) => \{ setRescheduleOpen\(false\); onChanged\(\); \}\}/);
  assert.match(JM_CODE, /<ActionBar\b[\s\S]*?onChanged=\{\(\) => \{ refresh\(\); onSaved\?\.\(\); \}\}/);
});

// ── (vi) Scheduling History follows a reschedule ─────────────────────────

test('(vi) Scheduling History re-reads on the key refresh() bumps', () => {
  const start = JM_CODE.indexOf('\nfunction JobSchedulingHistory(');
  assert.ok(start > -1, 'JobSchedulingHistory must exist');
  const fn = JM_CODE.slice(start, JM_CODE.indexOf('\n}\n', start));
  assert.match(fn, /useFetch<ScheduleRow\[\]>\(`\/admin\/reports\/job-tracking\?jobId=\$\{jobId\}`\)/,
    'positive control: this is the scheduling_history reader');
  assert.match(fn, /\}, \[refreshKey\]\);/, 'must re-run when refreshKey changes');
  assert.match(fn, /\brefetch\(\);/, 'via refetch() — eviction does not reach a mounted useFetch');
  assert.match(JM_CODE, /<JobSchedulingHistory\b[^>]*\brefreshKey=\{commentsRefreshKey\}/,
    'its mount must pass the key refresh() bumps');
});

test('every open ranks afresh, and a re-rank also re-runs an active technician search', () => {
  // Status: Schedule & Assign's Top-10 is cached 30 s by useFetch. An edit made
  // anywhere else inside that window would re-show the old ranking, so the
  // candidates cache is evicted on open — BEFORE the Top-10 hook is declared,
  // because React runs a component's effects in declaration order.
  const evictAt = SA_CODE.search(/useEffect\(\(\) => \{\s*if \(open && jobId\) invalidateFetch\(\(k\) => k\.startsWith\(`\/admin\/jobs\/\$\{jobId\}\/candidates`\)\);\s*\}, \[open, jobId\]\);/);
  const topAt = SA_CODE.indexOf('const top = useFetch<CandidatesResponse>(');
  assert.ok(evictAt > -1, 'the open-time eviction effect must exist');
  assert.ok(topAt > -1, 'the Top-10 hook must be found');
  assert.ok(evictAt < topAt, 'and be declared before the Top-10 hook, or its fetch can win the race');
  const reRank = SA_CODE.slice(SA_CODE.indexOf('function reRank()'), SA_CODE.indexOf('\n  }', SA_CODE.indexOf('function reRank()')));
  assert.match(reRank, /if \(searchKey\) searchRes\.refetch\(\);/, 'a mounted search is a second ranking eviction cannot re-run');
});
