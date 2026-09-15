'use strict';
/*
 * The legacy Job Transaction fields, in the one tabbed View every status uses.
 *
 * ─── WHY (2026-09-11) ──────────────────────────────────────────────────────
 *
 * cdeac01 retired JobTransactionView (the status-9 replica) so Unconfirmed jobs
 * open in ViewBody like every other status. The replica showed fields ViewBody
 * lacked; ops asked for all of them, for every status, where they belong:
 *
 *   Summary · Job Meta     Booking Date Time, Open Job Reason,
 *                          Total No. of Products, Job Completion TAT
 *   Summary · own card     Custom Properties (Branch Details, Property /
 *                          Building Name, Product Code, then custom_properties)
 *   Schedule · Timeline    Original Appointment
 *   Schedule · Scheduling History header   "Rescheduled N times"
 *
 * No backend change: every value is already on GET /admin/jobs/:id (getById →
 * getByIdCore's `j.*` + enquiry_reason_name + custom_properties), and the count
 * comes from the job-tracking rows the Schedule tab already fetches. The last
 * test pins that cross-repo half, so a projection change cannot silently blank
 * a row.
 *
 * ─── WHAT CAN GO WRONG SILENTLY, AND IS THEREFORE RUN ──────────────────────
 *
 * The replica got these wrong with nothing on screen to say so:
 *   Material Required — read the Helper way (`? 'YES' : 'NO'`) on a key no
 *     table stores, so it printed "NO" for every job. Not carried over at all.
 *   Total No. of Products — summed quantity over every service line, soft-
 *     deleted ones included. Legacy's is the number of ACTIVE lines.
 *   Job Completion TAT — printed a bare " hrs" for an empty exp_tat.
 *   Custom Properties — read custom_properties only, so the three props the
 *     CRM Book / Confirm form stores elsewhere never showed.
 * Those expressions are lifted out of the TSX and executed, not pattern-matched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/components/job/JobModal.tsx'), 'utf8');

function card(title) {
  const start = SRC.indexOf(`<DlCard title="${title}"`);
  assert.ok(start > -1, `the ${title} card must be found`);
  return SRC.slice(start, SRC.indexOf('}/>', start));
}
/* The value expression of one DlCard row, as source text: `['Label', <expr>],` */
function rowExpr(cardSrc, label) {
  const m = cardSrc.match(new RegExp(`\\['${label.replace(/[.]/g, '\\.')}', (.+)\\],\\n`));
  assert.ok(m, `the ${label} row must be found`);
  return m[1];
}
/* A row's expression evaluated against a fake job — the real text, run. */
const evalRow = (expr, job) => new Function('job', `return (${expr});`)(job);

function loadTotalProducts() {
  const start = SRC.indexOf('function totalProducts(');
  assert.ok(start > -1, 'totalProducts must exist in JobModal.tsx');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  const { outputText } = ts.transpileModule(`${body}\nmodule.exports = totalProducts;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  assert.equal(typeof mod.exports, 'function', 'the extracted text must evaluate to the helper');
  return mod.exports;
}

test('Job Meta: Booking Date Time, Open Job Reason, Products, TAT — each from its payload key', () => {
  const meta = card('Job Meta');
  assert.equal(rowExpr(meta, 'Booking Date Time'),
    'formatDate((job.ticket_created_date_time ?? job.created_date_time) as string)',
    'the ticket instant, through the IST formatter the file already uses');
  assert.ok(meta.indexOf("['Booking Date Time'") < meta.indexOf("['Age'"), 'directly above Age, which it anchors');
  assert.equal(rowExpr(meta, 'Open Job Reason'), 'job.enquiry_reason_name',
    'the action_taken_reason decode getByIdCore already projects — not a second FE lookup');
  assert.equal(rowExpr(meta, 'Total No. of Products'), 'totalProducts(job.services)');

  const tat = rowExpr(meta, 'Job Completion TAT');
  assert.equal(evalRow(tat, { exp_tat: '48' }), '48 hrs');
  // exp_tat is varchar: QA holds 3,615 '' rows beside the NULLs. Both are unset.
  for (const unset of [null, undefined, '']) {
    assert.equal(evalRow(tat, { exp_tat: unset }), null, `${JSON.stringify(unset)} must render the em dash`);
  }
});

test('Total No. of Products counts ACTIVE service lines, not their quantity', () => {
  const totalProducts = loadTotalProducts();
  const svc = (job_service_status, quantity) => ({ job_service_status, quantity });
  // Legacy: noOfProducts = getJobServiceList(jobId, 1).size() — lines, not units.
  assert.equal(totalProducts([svc(1, 2), svc(1, 1)]), 2, 'two lines, whatever their quantity');
  assert.equal(totalProducts([svc(1, 0)]), 1, 'a line with quantity 0 is still a line');
  // Soft-deleted lines ride along on getById for the restore toggle; not products.
  assert.equal(totalProducts([svc(1, 2), svc(0, 5)]), 1, 'a status-0 line must not count');
  // A TINYINT(1) column arrives as a boolean through db.js typeCast.
  assert.equal(totalProducts([svc(true, 4), svc(false, 9)]), 1);
  assert.equal(totalProducts([]), 0);
  assert.equal(totalProducts(undefined), 0, 'a payload without services is 0, not a crash');
});

test('no Material Required row — nothing stores material_req, so it could only ever be an em dash', () => {
  const tech = card('Technician');
  assert.ok(tech.includes("['Helper Req'"), 'the Technician rows must be the ones read');
  assert.doesNotMatch(tech, /\['Material Required'/);
});

test('Custom Properties: the canonical trio, then the decoded custom_properties, em dash when none', () => {
  const cp = card('Custom Properties');
  const { outputText } = ts.transpileModule(`module.exports = (job) => (${cp.slice(cp.indexOf('rows={') + 6)});`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  const rows = mod.exports;
  assert.equal(typeof rows, 'function', 'the rows expression must be extracted and run');

  // The Book / Confirm form stores these three OUTSIDE custom_property (a column,
  // and remarks-folded values getByIdCore decodes back). QA: 969 of the latest
  // 50k jobs carry a real Branch Details with an empty custom_property.
  assert.deepEqual(rows({ branch_details: 'Indiranagar', custom_properties: [] }), [['Branch Details', 'Indiranagar']]);
  assert.deepEqual(rows({
    branch_details: 'B1', building_name: 'Tower A', product_code: 'SKU-9',
    custom_properties: [{ label: 'GSTIN', value: 'X' }, { name: 'store_code', value: 'S1' }],
  }), [
    ['Branch Details', 'B1'], ['Property / Building Name', 'Tower A'], ['Product Code', 'SKU-9'],
    ['GSTIN', 'X'], ['store_code', 'S1'],
  ], 'the Confirm form order: trio first, then label (name as fallback) → value');
  // Legacy Java's String.valueOf(null) sentinel sits in 1,191 of QA's 6,780 set
  // branch_details — unset, the rule parseCustomPropertyString applies.
  for (const unset of ['(NULL)', 'null', '  ', '', null, undefined]) {
    assert.deepEqual(rows({ branch_details: unset, custom_properties: null }), [], `${JSON.stringify(unset)} is not a branch`);
  }
  // An empty rows array must not leave a blank card body.
  const dl = SRC.slice(SRC.indexOf('function DlCard('), SRC.indexOf('function renderDlValue('));
  assert.match(dl, /rows\.length === 0 \? <p className="text-sm text-muted-foreground">—<\/p>/,
    'DlCard renders the em dash for a card with no rows');
});

test('Schedule: Original Appointment in Timeline, the reschedule count on Scheduling History', () => {
  const timeline = card('Timeline');
  assert.equal(rowExpr(timeline, 'Original Appointment'),
    'formatDate(job.original_appointment_date_time as string)');
  assert.ok(timeline.indexOf("['Original Appointment'") < timeline.indexOf("['Requested'"),
    'the first promise, then the live one');

  const start = SRC.indexOf('function JobSchedulingHistory(');
  const hist = SRC.slice(start, SRC.indexOf('\nfunction ', start + 10));
  assert.ok(start > -1 && hist.length > 0, 'JobSchedulingHistory must be found');
  assert.match(hist, /useFetch<ScheduleRow\[\]>\(`\/admin\/reports\/job-tracking\?jobId=\$\{jobId\}`\)/,
    'the count rides the fetch the table already makes — no second request');
  assert.match(hist, /const rescheduled = rows\.filter\(\(h\) => h\.reschedule_reason\)\.length;/);
  // Same predicate as the table's reason chip, so count and rows cannot disagree.
  assert.match(hist, /\{h\.reschedule_reason\s*\n\s*\? <span/, 'the chip keys off the same field');
  assert.match(hist, /Rescheduled \{rescheduled\} \{rescheduled === 1 \? 'time' : 'times'\}/);
  assert.match(hist, /\{!loading && \(\s*\n\s*<span/, 'no "0 times" flash before the rows arrive');
});

test('cross-repo: every value above is on the detail payload the modal reads', () => {
  const root = (() => {
    for (const r of [process.env.EASYFIX_BACKEND_DIR, path.join(__dirname, '..', '..', 'EasyFix_Backend')]) {
      if (r && fs.existsSync(path.join(r, 'services/job.service.js'))) return r;
    }
    throw new Error('EasyFix_Backend checkout not found — set EASYFIX_BACKEND_DIR; this half must not degrade to a pass.');
  })();
  const svc = fs.readFileSync(path.join(root, 'services/job.service.js'), 'utf8');
  const core = svc.slice(svc.indexOf('async function getByIdCore('), svc.indexOf('async function getById('));
  assert.ok(core.length > 0, 'getByIdCore must be found');
  // j.* carries ticket_created_date_time, created_date_time, exp_tat,
  // original_appointment_date_time, custom_property and branch_details.
  assert.match(core, /`SELECT j\.\*,/, 'getByIdCore must still select j.*');
  assert.match(core, /FROM action_taken_reason atr WHERE atr\.id = j\.enquiry_reason_id LIMIT 1\) AS enquiry_reason_name/,
    'Open Job Reason is decoded against action_taken_reason');
  assert.match(core, /job\.custom_properties = parseCustomPropertyString\(job\.custom_property\);/);
  // Product Code + Property / Building Name are not tbl_job columns; only this decode puts them on the payload.
  assert.match(core, /const decodedProps = decomposeRemarks\(job\.remarks\);/);
  assert.match(core, /job\.product_code = decodedProps\.product_code/);
  assert.match(core, /job\.building_name = decodedProps\.building_name/);

  const routes = fs.readFileSync(path.join(root, 'routes/admin/jobs.js'), 'utf8');
  assert.match(routes, /const j = await job\.getById\(req\.params\.id\);[\s\S]{0,400}req\.scopedJob = j;/,
    'scopedJob hands getById through');
  assert.match(routes, /router\.get\('\/:id', validate\(idParam, 'params'\), scopedJob, async \(req, res\) => \{\s*\n[^\n]*\n\s*modernOk\(res, req\.scopedJob\);/,
    'GET /admin/jobs/:id returns that row unprojected');

  const reports = fs.readFileSync(path.join(root, 'routes/admin/reports.js'), 'utf8');
  const tracking = reports.slice(reports.indexOf("router.get('/job-tracking'"), reports.indexOf('});', reports.indexOf("router.get('/job-tracking'")));
  assert.match(tracking, /sh\.reschedule_reason\s+FROM scheduling_history sh[\s\S]*WHERE sh\.job_id = \?/,
    'job-tracking returns every scheduling_history row with its reason');
  assert.doesNotMatch(tracking, /LIMIT/, 'unpaged — the count must see every row');
});
