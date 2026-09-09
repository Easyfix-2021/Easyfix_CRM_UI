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
const BE = path.join(__dirname, '..', '..', 'EasyFix_Backend');

const readUi = (...p) => fs.readFileSync(path.join(UI, ...p), 'utf8');

/*
 * The backend is a sibling checkout, not a dependency. If it is absent (a CI
 * job that clones this repo alone), the backend halves cannot run — but they
 * must SKIP LOUDLY rather than silently pass, which is the failure mode that
 * lets a cross-repo guard rot into decoration.
 */
const beAvailable = fs.existsSync(BE);
const readBe = (...p) => fs.readFileSync(path.join(BE, ...p), 'utf8');

const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the backend checkout is present, or these guards are not running', () => {
  assert.ok(
    beAvailable,
    `EasyFix_Backend not found at ${BE} — the ordering half of this file cannot run. `
    + 'Clone it beside this repo; a skipped cross-repo guard is indistinguishable from a passing one.',
  );
});

// ── Technician Performance: service is oldest -> newest ──────────────

test('computeLastThreeWeeks builds oldest -> newest, so the LAST bucket is current', () => {
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

  // The export branch is the reference implementation; it must not drift either.
  const route = strip(readBe('routes', 'admin', 'quicksight', 'technician-performance.js'));
  assert.match(
    route,
    /const latest = dw\[dw\.length - 1\];/,
    'the XLSX rollup must still agree with the screen',
  );
});

// ── Client Performance: service is most-recent FIRST ─────────────────

test('client-performance reverses to most-recent-first, so bucket 0 is current', () => {
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
  assert.match(body, /const currentIdx = 0;/, 'the current period is bucket 0 for THIS report');
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

// ── The property that makes both correct at once ─────────────────────

test('the two reports order their buckets DIFFERENTLY — that is the trap', () => {
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
