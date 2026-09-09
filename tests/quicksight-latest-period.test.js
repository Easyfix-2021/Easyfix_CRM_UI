'use strict';

/*
 * Two QuickSight reports summed the WRONG period, in opposite directions, and
 * each one's own XLSX download showed the right one.
 *
 * WHAT HAPPENED (found 2026-09-09)
 *
 * Each report's headline rollup — which bucket counts as "latest", and the
 * totals over the full filtered set — was written inline in the
 * `format === 'xlsx'` branch of its route handler. Only the export could reach
 * it. Every on-screen page therefore had to re-derive the same numbers from the
 * JSON branch, and had to GUESS which end of the 3-period array was current:
 *
 *   Technician Performance  service returns oldest -> newest; the screen read [0]
 *   Client Performance      service returns most-recent FIRST; the screen read
 *                           [length - 1]
 *
 * Both guessed wrong. Both landed on the OLDEST bucket while captioning it
 * "Latest Period" / "Current Period". Same filters, one click apart, two
 * irreconcilable answers — and no way for either team to check, because the
 * correct rollup lived in a branch neither could call.
 *
 * WHY THE ORDERINGS DIFFER AND WHY THAT IS FINE
 *
 * Neither ordering is wrong. `computeLastThreeWeeks` builds oldest -> newest
 * because the table renders three columns left-to-right; client-performance
 * `.reverse()`s because its "current" bucket leads. The defect is not the
 * disagreement, it is that each SCREEN had to infer the convention instead of
 * being told it.
 *
 * So this file pins BOTH sides of BOTH reports: the service's ordering and the
 * index its screen reads. Change one without the other and it fails here rather
 * than silently reporting a three-week-old number.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM,
 * and the backend lives in a sibling repo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', 'src');
const readUi = (...p) => fs.readFileSync(path.join(UI, ...p), 'utf8');

/*
 * WHERE THE BACKEND IS, and why this is not a sibling path (2026-09-09).
 *
 * Written as `../../EasyFix_Backend` with a hard assert that it exists, this
 * file passed locally and FAILED THE DEPLOY on QA and Production — five of six
 * tests red — because CI does not lay the repos out as siblings. It shallow-
 * clones the backend into RUNNER_TEMP, deliberately outside the workspace (see
 * .github/workflows/deploy.yml: inside it, `eslint .` would lint the backend
 * with this repo's config), and points EASYFIX_BACKEND_DIR at it.
 *
 * tests/message-literals.test.js already resolved this exact problem and this
 * is its resolver, deliberately identical. The lesson is not the path: it is
 * that a cross-repo guard has a deployment-shaped failure mode that a green
 * local run cannot show, and that the convention for it already existed one
 * directory away.
 *
 *   EASYFIX_BACKEND_DIR   CI, and any layout that sets it.
 *   ../EasyFix_Backend    a developer machine, where the repos are siblings.
 *
 * Absent and unset: the backend halves SKIP rather than fail. Skipping is a
 * local convenience only — if EASYFIX_BACKEND_DIR is set but the tree is not
 * there, that is a broken fetch step and it fails loudly.
 */
function resolveBackend() {
  const roots = [
    process.env.EASYFIX_BACKEND_DIR,
    path.join(__dirname, '..', '..', 'EasyFix_Backend'),
  ];
  for (const r of roots) {
    if (r && fs.existsSync(path.join(r, 'services', 'quicksight', '_shared.js'))) return r;
  }
  return null;
}

const BE = resolveBackend();
const beAvailable = BE != null;
const readBe = (...p) => fs.readFileSync(path.join(BE, ...p), 'utf8');
/* node:test skips on a truthy `skip`, so this reads as a reason when it fires. */
const skipNoBackend = beAvailable
  ? false
  : 'backend checkout not found (set EASYFIX_BACKEND_DIR or clone it beside this repo)';

const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('a CI run that was POINTED at the backend must actually find it', () => {
  /*
   * The narrow case where absence is a real failure rather than a local
   * convenience: the variable is set, so something meant to provide the tree,
   * and it is not there. That is a broken fetch step, not a developer without
   * a second checkout.
   */
  if (!process.env.EASYFIX_BACKEND_DIR) return;
  assert.ok(
    beAvailable,
    `EASYFIX_BACKEND_DIR is set to ${process.env.EASYFIX_BACKEND_DIR} but no backend tree is there — `
    + 'the fetch step did not do what it claims.',
  );
});

// ── Technician Performance: service is oldest -> newest ──────────────

test('computeLastThreeWeeks builds oldest -> newest, so the LAST bucket is current', { skip: skipNoBackend }, () => {
  const shared = strip(readBe('services', 'quicksight', '_shared.js'));
  /*
   * Asserted on the LOOP, not on the comment beside it. A docblock claiming an
   * ordering is exactly what misled the technician-performance screen — that
   * file's own header said "the latest period is the FIRST entry" while the
   * service disagreed. The loop counts DOWN from 2 and subtracts i weeks from
   * the most recent end, so the first push is the oldest.
   */
  assert.match(
    shared,
    /for \(let i = 2; i >= 0; i--\) \{[\s\S]{0,220}?weeks\.push\(/,
    'computeLastThreeWeeks must still push oldest-first',
  );
  assert.match(
    shared,
    /const end = addDays\(lastFullWeekEnd, -7 \* i\);/,
    'and derive each end by walking BACK i weeks, which is what makes i=2 the oldest',
  );
});

test('the technician screen reads the LAST bucket, matching its own XLSX', () => {
  const charts = strip(readUi('app', '(authed)', 'quicksight', 'technician-performance', 'TechnicianPerformanceCharts.tsx'));
  assert.match(
    charts,
    /const dw = t\.technicianPerformanceDataDateWise;\s*const p = dw\[dw\.length - 1\];/,
    'the KPI/chart rollup must read the newest bucket',
  );
  assert.ok(
    !/technicianPerformanceDataDateWise\[0\]/.test(charts),
    'reading [0] is the OLDEST period — the bug this file exists for',
  );

  /*
   * The reference implementation moved: the rollup used to live in the route's
   * xlsx branch and now lives in the service, shipped on both branches. So the
   * agreement is asserted against the SERVICE. Guarded rather than skipped, so
   * the UI assertions above still run in a checkout without the backend —
   * those catch a regression in THIS repo and must never need a second one.
   */
  if (!beAvailable) return;
  const svc = strip(readBe('services', 'quicksight', 'quicksight-technician-performance.service.js'));
  assert.match(
    svc,
    /const idx = dw\.length - 1;/,
    'the service rollup must still take the newest bucket, which is what the screen renders',
  );
});

// ── Client Performance: service is most-recent FIRST ─────────────────

test('client-performance reverses to most-recent-first, so bucket 0 is current', { skip: skipNoBackend }, () => {
  const svc = strip(readBe('services', 'quicksight', 'quicksight-client-performance.service.js'));
  assert.match(svc, /\.reverse\(\)/, 'the service must still reverse its buckets');
  assert.match(
    svc,
    /const overallEnd = periods\[0\]\.endDate;/,
    'and periods[0] must still be the most-recent end — the service\'s own proof of its ordering',
  );
  assert.match(
    svc,
    /const overallStart = periods\[periods\.length - 1\]\.startDate;/,
    'with the oldest start at the far end',
  );
});

test('the client screen reads bucket 0, matching its service', () => {
  const body = strip(readUi('app', '(authed)', 'quicksight', 'client-performance', 'ClientPerformanceBody.tsx'));
  assert.match(
    body,
    /const currentIdx = rollup\?\.currentPeriodIndex \?\? 0;/,
    'the current period comes from the server, with 0 — this report\'s correct answer — as the fallback',
  );
  assert.ok(
    !/currentIdx = useMemo\([\s\S]{0,160}?periods\.length \?\? 0\) - 1/.test(body),
    'reading length - 1 is the OLDEST period here — the mirror-image bug',
  );
  // The caption and the numbers must name the same bucket.
  assert.match(
    body,
    /Current Period: \{periodHeaders\[currentIdx\] \?\? '—'\}/,
    'the caption must be driven by the same index the KPIs sum, or it can disagree with them',
  );
});

// ── The rollup now ships on the JSON branch (2026-09-09) ─────────────

test('neither screen infers the ordering any more — the server states it', () => {
  /*
   * The structural half of the fix. Correcting the two indices stopped today's
   * wrong numbers; this stops the NEXT screen from having to guess. Both pages
   * read a server-supplied index and keep their (correct) literal only as a
   * fallback for a backend that predates it.
   */
  const tech = strip(readUi('app', '(authed)', 'quicksight', 'technician-performance', 'TechnicianPerformanceBody.tsx'));
  assert.match(tech, /rollup\?: \{ latestPeriodIndex: number; latestPeriodLabel: string \}/,
    'the technician payload type must carry the rollup');
  assert.match(tech, /rollup\?\.latestPeriodLabel \|\| periodHeaders\[periodHeaders\.length - 1\]/,
    'the chart caption must prefer the server label, and fall back to the LAST header, not the first');

  const client = strip(readUi('app', '(authed)', 'quicksight', 'client-performance', 'ClientPerformanceBody.tsx'));
  assert.match(client, /const currentIdx = rollup\?\.currentPeriodIndex \?\? 0;/,
    'the client page must read the server index');
  assert.match(client, /Array\.isArray\(data\) \? data : \(data\?\.rows \?\? \[\]\)/,
    'and tolerate BOTH payload shapes, so the repos can deploy in either order');
});

test('the export branches read the same rollup the JSON branch ships', { skip: skipNoBackend }, () => {
  /*
   * The point of moving it. If an export recomputes its own totals the two can
   * disagree again — which is exactly the state this whole file documents.
   */
  const techRoute = strip(readBe('routes', 'admin', 'quicksight', 'technician-performance.js'));
  assert.match(techRoute, /= payload\.rollup;/, 'the technician export must read the service rollup');
  assert.ok(
    !/for \(const tx of list\)/.test(techRoute),
    'and must not keep its own summing loop',
  );

  const clientRoute = strip(readBe('routes', 'admin', 'quicksight', 'client-performance.js'));
  assert.match(clientRoute, /service\.rollupCurrentPeriod\(rows\)/, 'the client export must call the service rollup');
  assert.match(clientRoute, /rollup: service\.rollupCurrentPeriod\(rows\)/, 'and the JSON branch must ship it');
});

test('each service rollup reads the end its OWN ordering makes current', { skip: skipNoBackend }, () => {
  const techSvc = strip(readBe('services', 'quicksight', 'quicksight-technician-performance.service.js'));
  assert.match(techSvc, /const idx = dw\.length - 1;/, 'oldest -> newest: current is LAST');

  const clientSvc = strip(readBe('services', 'quicksight', 'quicksight-client-performance.service.js'));
  assert.match(clientSvc, /const current = r\.periods && r\.periods\[0\];/, 'most-recent-first: current is FIRST');
  assert.match(clientSvc, /currentPeriodIndex: 0/, 'and it must SAY so rather than leave it inferred');
});

// ── The property that makes both correct at once ─────────────────────

test('the two reports order their buckets DIFFERENTLY — that is the trap', { skip: skipNoBackend }, () => {
  /*
   * Recorded as an assertion rather than a comment, because the natural
   * "cleanup" here is to make one screen match the other. Doing that fixes
   * nothing and breaks the one that was right: the orderings genuinely differ,
   * and the index each screen uses is only correct relative to its own service.
   */
  const shared = strip(readBe('services', 'quicksight', '_shared.js'));
  const clientSvc = strip(readBe('services', 'quicksight', 'quicksight-client-performance.service.js'));

  const sharedIsOldestFirst = /for \(let i = 2; i >= 0; i--\)/.test(shared);
  const clientIsNewestFirst = /\.reverse\(\)/.test(clientSvc);
  assert.ok(sharedIsOldestFirst, 'positive control: the shared helper must be oldest-first');
  assert.ok(clientIsNewestFirst, 'positive control: client-performance must be newest-first');
  assert.notEqual(
    sharedIsOldestFirst, !clientIsNewestFirst,
    'if these two ever adopt the same ordering, both screens must be revisited together',
  );
});
