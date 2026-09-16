/*
 * Bucket Status ↔ Job Status coupling.
 *
 * THE TWO BUGS (reported 2026-08-18):
 *   1. Job Status offered every status regardless of the chosen bucket, so an
 *      operator could assemble "Closed" + "Booked" — which the backend ANDs
 *      into a guaranteed-empty result with nothing on screen explaining the
 *      emptiness.
 *   2. Clearing Bucket Status left Job Status set, so a narrowing chosen FROM
 *      a bucket's list outlived the bucket, hiding under a filter that now
 *      read "--All--".
 *
 * The derivation is tested here rather than in the page because a page
 * component drags React and the Next runtime into any test that imports it —
 * which is exactly why this rule had no coverage while it lived there.
 *
 * Runner: `node --test` (via `npm test`, which compiles src/lib first).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('../.test-build/job-buckets.js');

const values = (opts) => opts.map((o) => o.value);

test('no bucket → every status, exactly as before', () => {
  assert.deepEqual(values(B.jobStatusOptionsFor('')), values(B.JOB_STATUS_OPTIONS));
  assert.equal(B.jobStatusOptionsFor('').length, 11);
});

test('a bucket narrows the list to its own statuses', () => {
  assert.deepEqual(values(B.jobStatusOptionsFor('closed')), ['3']);       // 5 has no dropdown entry
  assert.deepEqual(values(B.jobStatusOptionsFor('cancelled')), ['6', '7']);
  assert.deepEqual(
    values(B.jobStatusOptionsFor('open')),
    ['0', '1', '2', '9', '10', '15', '20', '21'],
  );
});

test('the contradictory combination is now unconstructable', () => {
  /*
   * The reported bug, stated as the invariant it broke: a status from one
   * bucket must never be offered while a different bucket is selected. That
   * pair ANDs to zero rows on the backend and reads as "the filter is broken".
   */
  for (const [bucket, ids] of Object.entries(B.BUCKET_STATUS_MAP)) {
    for (const opt of B.jobStatusOptionsFor(bucket)) {
      assert.ok(ids.includes(Number(opt.value)),
        `"${opt.label}" is offered under "${bucket}" but is not in that bucket`);
    }
  }
});

test('an unknown bucket falls back to every status, never to none', () => {
  // Fail OPEN: a stale URL param must not present an empty dropdown.
  assert.equal(B.jobStatusOptionsFor('nonsense').length, B.JOB_STATUS_OPTIONS.length);
});

test('the buckets partition without overlap — one status, one bucket', () => {
  /*
   * If a status appeared in two buckets the derived list would be ambiguous
   * and the AND could still produce an empty set. Pins the map's shape, not
   * just the function reading it.
   */
  const seen = new Map();
  for (const [bucket, ids] of Object.entries(B.BUCKET_STATUS_MAP)) {
    for (const id of ids) {
      assert.equal(seen.has(id), false, `status ${id} is in both ${seen.get(id)} and ${bucket}`);
      seen.set(id, bucket);
    }
  }
});

test('every dropdown status belongs to some bucket', () => {
  /*
   * The complement of the test above: a status the dropdown offers but no
   * bucket claims would VANISH the moment any bucket is picked, with no way
   * to reach it. Adding a status to JOB_STATUS_OPTIONS without adding it to
   * BUCKET_STATUS_MAP fails here.
   */
  const all = new Set(Object.values(B.BUCKET_STATUS_MAP).flat());
  for (const o of B.JOB_STATUS_OPTIONS) {
    assert.ok(all.has(Number(o.value)),
      `"${o.label}" (${o.value}) is in the dropdown but in no bucket — it disappears whenever a bucket is set`);
  }
});

/*
 * Job Stage filter — legacy parity (reported 2026-08-18).
 *
 * The legacy CRM's "Job Status" control is a MULTI-SELECT of workflow stages
 * whose values are strings, resolved by UtilityFunctions.resolveJobStatus()
 * into job_status ids plus a technician-presence flag. The new CRM shipped a
 * single-select of raw numeric codes, so the two lists filtered different axes
 * under the same label and could never agree.
 *
 * These assertions are transcribed from UtilityFunctions.java:1880-1915 and are
 * the contract with the legacy system — if one fails, the new filter has
 * drifted from the CRM operators compare it against.
 */

test('every legacy stage resolves to the job_status ids legacy uses', () => {
  const expected = {
    unconfirmed: [9],
    start:       [1],
    close:       [2, 20],
    audit:       [10],
    approval:    [15],
    fulfillment: [21],
    completed:   [3, 5],
    enquiry:     [7],
    cancel:      [6],
  };
  for (const [stage, ids] of Object.entries(expected)) {
    const got = B.resolveStageFilter([stage]);
    assert.deepEqual(got.statuses.slice().sort((a, b) => a - b), ids, `stage ${stage}`);
    assert.equal(got.assigned, undefined, `stage ${stage} must not filter on technician`);
  }
});

test('audit is status 10 and completed is 3+5 — the two are NOT interchangeable', () => {
  /*
   * The new CRM's own "Audit & Complete" TAB uses [3,5] and files 10 under
   * "Pending for Feedback", so these two buckets are crossed between the
   * systems. Legacy is the reference the operator compares against, and this
   * is the single assertion most likely to be "corrected" into a bug.
   */
  assert.deepEqual(B.resolveStageFilter(['audit']).statuses, [10]);
  assert.deepEqual(B.resolveStageFilter(['completed']).statuses.slice().sort((a, b) => a - b), [3, 5]);
});

test('scheduling and acknowledge share status 0 and differ only by technician', () => {
  const scheduling = B.resolveStageFilter(['scheduling']);
  assert.deepEqual(scheduling.statuses, [0]);
  assert.equal(scheduling.assigned, false, 'scheduling = efr IS NULL');

  const acknowledge = B.resolveStageFilter(['acknowledge']);
  assert.deepEqual(acknowledge.statuses, [0]);
  assert.equal(acknowledge.assigned, true, 'acknowledge = efr IS NOT NULL');
});

test('selecting BOTH scheduling and acknowledge drops the technician flag', () => {
  // Legacy sets efrFlag = "" when both are picked. Keeping either value would
  // filter for attached AND unattached at once and match nothing.
  const both = B.resolveStageFilter(['scheduling', 'acknowledge']);
  assert.deepEqual(both.statuses, [0]);
  assert.equal(both.assigned, undefined);
});

test('no selection resolves to null so the tab/bucket keeps control', () => {
  assert.equal(B.resolveStageFilter([]), null);
  assert.equal(B.resolveStageFilter(undefined), null);
});

test('ids are deduped and combined across stages', () => {
  const combo = B.resolveStageFilter(['unconfirmed', 'close', 'completed']);
  assert.deepEqual(combo.statuses.slice().sort((a, b) => a - b), [2, 3, 5, 9, 20]);
});

test('the stage list matches legacy: 11 stages, ordered by label', () => {
  assert.equal(B.JOB_STAGE_OPTIONS.length, 11);
  const labels = B.JOB_STAGE_OPTIONS.map((o) => o.label);
  assert.deepEqual(labels, labels.slice().sort(), 'legacy sorts by display name');
});

test('stage options are scoped to the chosen bucket', () => {
  // Closed = [3,5] → only "Completed" lives entirely inside it.
  assert.deepEqual(values(B.jobStageOptionsFor('closed')), ['completed']);
  // Cancelled = [6,7] → Cancelled + Enquiry.
  assert.deepEqual(values(B.jobStageOptionsFor('cancelled')).sort(), ['cancel', 'enquiry']);
  // No bucket → everything.
  assert.equal(B.jobStageOptionsFor('').length, 11);
});

/*
 * buildStatusParams — the single status-precedence rule.
 *
 * Manage Jobs derived these parameters in three separate places and two had
 * drifted by 2026-08-18. The Export builder was the damaging one: it ignored
 * stage selections and the server-side search, so the sheet contained rows the
 * operator had filtered off screen — wrong in the direction nobody checks,
 * because a file that opens and has MORE rows looks fine.
 */

test('stages outrank Bucket Status — legacy replaces the group, never intersects it', () => {
  const p = B.buildStatusParams({ stages: ['start'], bucketStatus: 'open' });
  assert.equal(p.statuses, '1');
  assert.equal(p.status, undefined, 'never send both status and statuses');
});

test('stages carry the technician flag into the request', () => {
  assert.equal(B.buildStatusParams({ stages: ['scheduling'] }).assigned, 'false');
  assert.equal(B.buildStatusParams({ stages: ['acknowledge'] }).assigned, 'true');
  // Both → the axis is not filtered, so the key must be ABSENT, not "undefined".
  const both = B.buildStatusParams({ stages: ['scheduling', 'acknowledge'] });
  assert.equal('assigned' in both, false);
});

test('Bucket Status beats the tab but says nothing about technicians', () => {
  const p = B.buildStatusParams({
    bucketStatus: 'closed',
    tab: { status: 0, assigned: false },
  });
  assert.equal(p.statuses, '3,5');
  assert.equal('assigned' in p, false, 'a categorical pick must not inherit the tab split');
});

test('with no operator filter the tab pins come through intact', () => {
  const p = B.buildStatusParams({ tab: { status: 0, assigned: false } });
  assert.deepEqual(p, { status: 0, assigned: 'false' });
  const multi = B.buildStatusParams({ tab: { statuses: [2, 20] } });
  assert.deepEqual(multi, { statuses: '2,20' });
});

test('Pending for Scheduling disarms BOTH overrides — its pins are unconditional', () => {
  /*
   * The inversion already fixed once on /my-orders: picking a status there
   * listed jobs from outside the bucket entirely. A stale stage selection
   * carried in from another tab must not resurrect it.
   */
  const p = B.buildStatusParams({
    psActive: true,
    stages: ['completed'],
    bucketStatus: 'closed',
    tab: { status: 0, assigned: false },
  });
  assert.deepEqual(p, { status: 0, assigned: 'false' });
});

test('the All tab (no pins, no filters) sends nothing', () => {
  assert.deepEqual(B.buildStatusParams({ tab: {} }), {});
  assert.deepEqual(B.buildStatusParams({}), {});
});

test('REGRESSION: the export builder must not ignore a stage selection', () => {
  /*
   * The live bug. Export re-derived status from bucketStatus/tab only, so with
   * "Audit & complete" ticked on the All tab it emitted no status filter at
   * all and returned every job — a superset of the screen.
   */
  const onScreen = B.buildStatusParams({ stages: ['audit'], tab: {} });
  assert.equal(onScreen.statuses, '10');
});


/* ─────────────────────────────────────────────────────────────────────
 * ONE FILTER PANEL (2026-09-16) — a tab must be expressible as a filter
 * SELECTION, and a user's Job Stage Access must narrow the options offered.
 *
 * Manage Jobs used to carry a second status mechanism (the tab's unconditional
 * pins) and hid the dropdowns while it was active, so a bucket-scoped user saw
 * a different panel. The tab now pre-selects the dropdowns, which is only safe
 * if the translation reproduces the tab EXACTLY — a selection that widened a
 * bucket is the /my-orders inversion that comment in jobs/page.tsx records.
 * ───────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

/*
 * The REAL tab definitions, parsed from lib/job-tabs.ts. That file imports the
 * `@/` alias so it is not in .test-build, and typing its pins out here would be
 * a fixture free to agree with itself while disagreeing with the app.
 */
function realTabDefs() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/lib/job-tabs.ts'), 'utf8');
  const defs = [...src.matchAll(/\{\s*value:\s*'([\w-]+)'[^}]*\}/g)].map((m) => {
    const whole = m[0];
    const status = /\bstatus:\s*(\d+)/.exec(whole);
    const statuses = /\bstatuses:\s*\[([\d,\s]+)\]/.exec(whole);
    const assigned = /\bassigned:\s*(true|false)/.exec(whole);
    const def = { value: m[1] };
    if (statuses) def.statuses = statuses[1].split(',').map((x) => Number(x.trim()));
    else if (status) def.status = Number(status[1]);
    if (assigned) def.assigned = assigned[1] === 'true';
    return def;
  });
  // POSITIVE CONTROL on the parser, not only on its output: a regex that
  // matched nothing would make every assertion below vacuous.
  assert.ok(defs.length >= 12, `parsed ${defs.length} tab defs — the matcher is broken, not job-tabs`);
  const ps = defs.find((d) => d.value === 'pending-scheduling');
  assert.deepEqual(ps, { value: 'pending-scheduling', status: 0, assigned: false },
    'the parser must recover the pins, not just the names');
  return defs;
}

test('a tab pre-selects a filter selection that reproduces it EXACTLY, or none at all', () => {
  const defs = realTabDefs();
  let expressed = 0;
  for (const def of defs) {
    const sel = B.tabSelectionFor(def);
    if (sel.stages.length === 0) continue;          // not a status pick — its own pins stand
    expressed += 1;
    const resolved = B.resolveStageFilter(sel.stages);
    const want = (def.statuses ?? [def.status]).slice().sort((a, b) => a - b);
    assert.deepEqual(resolved.statuses.slice().sort((a, b) => a - b), want,
      `${def.value}: the pre-selection must not widen or narrow the tab`);
    assert.equal(resolved.assigned, def.assigned,
      `${def.value}: the technician axis must survive the translation`);
    assert.ok(B.BUCKET_STATUS_MAP[sel.bucketStatus].every((c) => true));
    assert.ok(want.every((c) => B.BUCKET_STATUS_MAP[sel.bucketStatus].includes(c)),
      `${def.value}: the bucket must contain every status the tab pins`);
  }
  assert.ok(expressed >= 5, `only ${expressed} tabs were expressible — expected the bucket tabs at least`);
  console.log(`tab→selection: ${expressed} of ${defs.length} tabs expressed exactly, the rest keep their own pins`);
});

test('the tabs a status selection cannot state pre-select NOTHING', () => {
  // completed pins status 5 while the Completed stage spans 3 AND 5; running-late
  // is statuses 0+1 AND requested-before-now. Pre-selecting either would widen
  // the view — the failure this whole mechanism exists to avoid.
  for (const def of [{ value: 'completed', status: 5 }, { value: 'running-late', statuses: [0, 1] }, { value: 'all' }]) {
    assert.deepEqual(B.tabSelectionFor(def), { bucketStatus: '', stages: [] }, def.value);
  }
  assert.deepEqual(B.tabSelectionFor(undefined), { bucketStatus: '', stages: [] });
});

test('Job Stage Access narrows the options offered, and no grant means every option', () => {
  const all = B.jobStageOptionsFor('');
  assert.ok(all.length >= 10, `expected the full stage list, got ${all.length}`);
  assert.deepEqual(B.jobStageOptionsFor('', { mode: 'all', stages: [] }), all,
    'mode "all" must be indistinguishable from no grant at all');
  assert.deepEqual(B.jobStageOptionsFor('', undefined), all);

  const granted = B.jobStageOptionsFor('', { mode: 'list', stages: ['pending-scheduling'] }).map((o) => o.value);
  assert.ok(granted.length > 0 && granted.length < all.length,
    `a grant must narrow but not empty the list, got ${JSON.stringify(granted)}`);
  assert.ok(granted.includes('scheduling'), 'the granted stage itself must be offered');
  assert.ok(!granted.includes('completed'), 'a stage outside the grant must not be offered');
  /*
   * KNOWN LOOSENESS, matched to the shipped rule: the comparison is made in
   * status CODES, and 'scheduling' / 'acknowledge' both live at status 0 — they
   * differ only on the technician axis, which a grant does not express. So a
   * pending-scheduling grant also offers "Pending app acknowledgement".
   * filterTabsForStages has exactly the same looseness; diverging here would
   * make the dropdown and the tab list disagree about one grant.
   */
  assert.ok(granted.includes('acknowledge'), 'documented: status 0 is shared by two stages');
});

test('a bucket with no reachable status is not offered', () => {
  const all = B.bucketOptionsFor().map((b) => b.value);
  assert.deepEqual(all, ['open', 'closed', 'cancelled']);
  assert.deepEqual(B.bucketOptionsFor({ mode: 'list', stages: ['pending-scheduling'] }).map((b) => b.value), ['open'],
    'status 0 lives only in the open bucket');
  assert.deepEqual(B.bucketOptionsFor({ mode: 'all', stages: [] }).map((b) => b.value), all);
});

test('the status-code option list narrows the same way', () => {
  const all = B.jobStatusOptionsFor('');
  const granted = B.jobStatusOptionsFor('', { mode: 'list', stages: ['pending-scheduling'] });
  assert.ok(granted.length > 0 && granted.length < all.length);
  assert.ok(granted.every((o) => Number(o.value) === 0), `expected only status 0, got ${JSON.stringify(granted)}`);
});
