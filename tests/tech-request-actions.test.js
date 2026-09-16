'use strict';
/*
 * Technician Requests — the Approve / Reject row actions, and the Cancel Job
 * button ops asked for inside the Reassign modal (owner, 2026-09-15).
 *
 * WHAT THE OWNER ASKED FOR, verbatim in four clauses:
 *   · "Reassign and View Job Action buttons will always be there."
 *   · "Location and Reset Pin actions will not be there in this section."
 *   · cancellation → Approve fires the cancel API, Reject "will just clear the flag".
 *   · reschedule   → Approve fires the reschedule API, Reject clears the flag.
 *   · "there should be a 'Cancel' (Red) button in Reassign Technician modal."
 *
 * AND, after the first cut shipped (owner, same day):
 *   · "Button says cancel job here in this modal but its just Cancel in other
 *      modals. Please use the shared component only to maintain consistency."
 *   · "Show the ask inside JobModal."
 *
 * Source-scanned, like pending-to-start-sections.test.js and
 * resend-pin-action.test.js: every rule below lives in a .tsx that test:build
 * does not compile, and every regression is a plain deletion that type-checks.
 * The parts that ARE compilable (the appRequestOf predicate these rows come
 * from) are behaviour-tested in tests/job-app-request.test.js; the two new
 * status-change call sites are pinned by tests/job-status-actions.test.js,
 * whose coverage assertion fails if either one is added without being described.
 *
 * Comments are stripped before every scan and a control proves the stripper
 * bites: this feature is explained at length in prose that NAMES the calls it
 * makes, so a check reading raw source would pass on the documentation alone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ACTIONS_PATH = 'src/components/job/TechRequestActions.tsx';
const VIEW_PATH = 'src/components/job/PendingToStartView.tsx';
const ASSIGN_PATH = 'src/components/job/AssignTechnicianModal.tsx';
const PAGE_PATH = 'src/app/(authed)/my-orders/page.tsx';
const CANCEL_PATH = 'src/components/job/CancelJob.tsx';
const MODAL_PATH = 'src/components/job/JobModal.tsx';

const ACTIONS_RAW = read(ACTIONS_PATH);
const ACTIONS = strip(ACTIONS_RAW);
const VIEW = strip(read(VIEW_PATH));
const ASSIGN = strip(read(ASSIGN_PATH));
const PAGE = strip(read(PAGE_PATH));
const CANCEL = strip(read(CANCEL_PATH));
const MODAL = strip(read(MODAL_PATH));

test('the stripper bites — prose that NAMES a call cannot satisfy a check for it', () => {
  // The file header explains the reject endpoint in words. If the stripper ever
  // stops working, every "the code does X" assertion below degrades into "the
  // comments mention X", which is the failure mode this control exists for.
  assert.match(ACTIONS_RAW, /app-request\/reject clears the one flag/,
    'positive control: the header must still describe the endpoint in prose');
  assert.doesNotMatch(ACTIONS, /clears the one flag/,
    'the comment stripper is broken — every scan below is now reading documentation');
});

// ─── Which icons survive on a request row ───────────────────────────────

test('Location and Resend PIN are OFF a row carrying a request', () => {
  // Both are day-to-day chasing tools for a job that is proceeding; a request
  // row is a decision. Each must be fenced behind !req, and the fence has to be
  // on the control itself, not on some enclosing branch.
  //
  // Fenced on the ROW's ask since the tabs replaced the sections (2026-09-16):
  // the owner's rule was about the Technician Requests section, whose rows now
  // live on the two request tabs AND on All. Fencing on the tab instead would
  // put Location / Resend PIN back on every request row shown under All.
  assert.match(VIEW, /\{!req && j\.fk_easyfixter_id != null && \(/,
    'the live-location button must be fenced off request rows');
  assert.match(VIEW, /\{!req && \(\s*<ResendPinButton/,
    'ResendPinButton must be fenced off request rows');
});

test('View Job and Reassign are NOT fenced — they are on every row', () => {
  // The owner said both "will always be there". Read the action cell and assert
  // neither control acquired a request (or retired section) condition.
  const cellAt = VIEW.indexOf('stick-col stick-right text-right whitespace-nowrap');
  assert.ok(cellAt > -1, 'positive control: the action cell must be locatable');
  const cell = VIEW.slice(cellAt, VIEW.indexOf('</td>', cellAt));

  const viewAt = cell.indexOf('onClick={() => onView(j.job_id)}');
  const reassignAt = cell.indexOf('onClick={() => onReassign(j.job_id)}');
  assert.ok(viewAt > -1, 'View Job must still render on this row');
  assert.ok(reassignAt > -1, 'Reassign must still render on this row');

  // The nearest preceding guard on each: Reassign keeps its permission gate
  // (canJob.isJobReassign) and View keeps none — but neither may be section-gated.
  for (const [name, at] of [['View Job', viewAt], ['Reassign', reassignAt]]) {
    const preceding = cell.slice(Math.max(0, at - 220), at);
    assert.doesNotMatch(preceding, /appRequests|!?req &&|showRequest|ptsState/,
      `${name} must not be fenced on a request or a tab — the owner said it is always there`);
  }
  // Differential control: the same window DOES see a fence when one is added.
  const fenced = cell.replace(/<button(\s+type="button"\s+onClick=\{\(\) => onView\(j\.job_id\)\})/,
    '{!req && <button$1');
  assert.notEqual(fenced, cell, 'control: the View mutation must land');
  const fencedAt = fenced.indexOf('onClick={() => onView(j.job_id)}');
  assert.match(fenced.slice(Math.max(0, fencedAt - 220), fencedAt), /!?req &&/,
    'control: a fenced View must be visible to the scan above');
  assert.match(cell, /\{canJob\.isJobReassign && \(/, 'Reassign keeps its own permission gate');
});

test('the Approve / Reject pair renders from the SAME ask the Request column painted', () => {
  // Re-deriving it would let the buttons act on the reschedule flag while the
  // chip says "Cancellation Requested" (cancel outranks reschedule when a job
  // carries both).
  assert.match(VIEW, /const req = appRequestOf\(j\);/);
  assert.match(VIEW, /\{req && \(\s*<TechRequestActions[\s\S]*?request=\{req\}/);
  /*
   * ONCE since 2026-09-16 — the filtering and counting moved into SQL, so the
   * only remaining call is the per-row one that draws the chip. A second call
   * here would be a second reading of the flags that can disagree with the
   * first, which is what this count has always been guarding against.
   */
  assert.equal((VIEW.match(/appRequestOf\(/g) || []).length, 1,
    'appRequestOf is called exactly once — per row, to render; the filter is the server\'s now');
});

// ─── Approve: the existing endpoints, never a third cancel path ─────────

test('approving a CANCELLATION goes through the ONE shared cancel control', () => {
  // No dialog, no PATCH, no toast of its own — all of that is useCancelJob's.
  assert.match(ACTIONS, /const cancel = useCancelJob\(\{/);
  assert.match(ACTIONS, /defaultDueTo: 'Technician'/,
    'seeded to Technician because that is who asked — still a radio ops can change');
  assert.match(ACTIONS, /const onApprove = \(\) => \(isCancel \? cancel\.open\(\) : setRescheduleOpen\(true\)\);/);
  assert.match(ACTIONS, /\{cancel\.dialog\}/);
  assert.doesNotMatch(ACTIONS, /<CancelWithReasonDialog|ST\.CANCELLED/,
    'a bespoke cancel here is the fourth copy the shared control exists to prevent');
  assert.match(strip(read('src/components/job/CancelWithReasonDialog.tsx')),
    /defaultDueTo = 'Customer'/,
    'every OTHER cancel surface must keep defaulting to Customer');
});

test('the shared control owns the label, and it is the one the other modals use', () => {
  // The drift the owner caught: three surfaces said "Cancel", the fourth
  // "Cancel Job". One constant now, and no surface may spell its own.
  assert.match(CANCEL, /export const CANCEL_JOB_LABEL = 'Cancel';/);
  assert.match(CANCEL, /\{CANCEL_JOB_LABEL\}/, 'the button must render the constant, not a literal');
  for (const [name, src] of [['Reassign', ASSIGN], ['JobModal', MODAL],
    ['Schedule & Assign', strip(read('src/components/job/ScheduleAssignModal.tsx'))]]) {
    assert.doesNotMatch(src, />\s*Cancel Job\s*</, `${name}: the footer label belongs to the shared control`);
    assert.match(src, /\bcancel\.button\b/, `${name}: must render the shared button`);
  }
});

test('approving a RESCHEDULE pre-fills the technician\'s slot and reason', () => {
  assert.match(ACTIONS, /<RescheduleDialog/);
  assert.match(ACTIONS, /initialDateTime=\{toPickerValue\(request\.requestedFor\)\}/);
  assert.match(ACTIONS, /initialRemarks=\{`Technician requested reschedule/);
  // The dialog owns the PATCH /:id/reschedule itself — re-implementing it here
  // would skip its reason + remarks validation.
  assert.doesNotMatch(ACTIONS, /\/reschedule`/,
    'the reschedule write belongs to RescheduleDialog, not to this component');
});

test('the requested slot is string-sliced, never parsed as a date', () => {
  // reschedule_date_time_app is an IST wall-clock VARCHAR. new Date() re-reads
  // it in the browser's zone and can shift the day across the +05:30 boundary —
  // the trap project_easyfix_ist_date_rendering exists for.
  assert.match(ACTIONS, /String\(raw\)\.slice\(0, 16\)\.replace\(' ', 'T'\)/);
  assert.doesNotMatch(ACTIONS, /new Date\(/,
    'never construct a Date from an IST wall-clock literal');
});

// ─── Reject: one flag, one endpoint, one confirmation ───────────────────

test('reject PATCHes the app-request endpoint with the ask\'s own kind', () => {
  assert.match(ACTIONS, /const REJECT_PATH = \(jobId: number\) => `\/admin\/jobs\/\$\{jobId\}\/app-request\/reject`;/);
  assert.match(ACTIONS, /api\.patch\(REJECT_PATH\(jobId\), \{ kind: request\.kind \}\)/,
    'the kind must come from the ask being shown, never be hard-coded');
});

test('reject asks first, through the shared confirm — never a native dialog', () => {
  assert.match(ACTIONS, /const ok = await confirm\(\{/);
  assert.match(ACTIONS, /if \(!ok\) return;/);
  assert.doesNotMatch(ACTIONS, /window\.confirm|(^|[^.\w])confirm\s*\(\s*['"`]/);
  assert.doesNotMatch(ACTIONS, /(^|[^.\w])alert\s*\(/);
});

test('reject surfaces the server\'s own sentence — a 409 is information', () => {
  // The guarded UPDATE answers 409 APP_REQUEST_NOT_PENDING when another
  // operator got there first. Flattening that to "failed" sends ops to a
  // developer for a message the API already wrote.
  assert.match(ACTIONS, /formatApiError\(e, \{ fallback: 'Could not reject the request\.' \}\)/);
  // And the row is repainted either way: on success it left the queue, on 409
  // it was never ours to paint.
  const catchAt = ACTIONS.indexOf('} catch (e) {');
  assert.ok(catchAt > -1);
  assert.match(ACTIONS.slice(catchAt), /onActioned\(\);/);
});

test('every decision triggers the VIEW-wide reload, not the table\'s own refetch', () => {
  // An approved cancellation leaves the queue entirely and a rejected ask moves
  // the job from a request tab to a date tab, so the tab COUNTS move with it; a
  // table-only refetch would leave the strip's numbers stale. (Was "page-wide,
  // not the section's" before the tabs replaced the sections, 2026-09-16.)
  assert.match(VIEW, /onRequestActioned=\{bumpReload\}/);
  assert.match(VIEW, /onActioned=\{onRequestActioned\}/);
  assert.match(VIEW, /const bumpReload = \(\) => \{[\s\S]*?invalidateFetch\(\(k\) => k\.startsWith\('\/admin\/jobs'\)\);/);
  // …and the reload signal reaches the strip as well as the table.
  assert.match(VIEW, /<PendingStartTabs[\s\S]*?reloadKey=\{reloadKey\}[\s\S]*?\/>/);
  assert.match(VIEW, /<PendingStartTable[\s\S]*?reloadKey=\{reloadKey\}[\s\S]*?\/>/);
});

// ─── Permission ─────────────────────────────────────────────────────────

test('the action key is declared once and actually requested by the page', () => {
  assert.match(ACTIONS, /export const APP_REQUEST_ACTION = 'isJobAppRequestResolve';/);
  // Declared in the component and imported by the page, like RESEND_PIN_ACTION:
  // a second string literal is how a rename hides the buttons on one page only.
  assert.match(PAGE, /import \{ APP_REQUEST_ACTION \} from '@\/components\/job\/TechRequestActions';/);
  assert.match(PAGE, /^\s*APP_REQUEST_ACTION,$/m, 'the key must be in actionFlags, or canJob[…] is always false');
  assert.equal((PAGE.match(/isJobAppRequestResolve/g) || []).length, 0,
    'the page must use the exported constant, never a second copy of the literal');
});

test('the pair is hidden outright without the permission', () => {
  assert.match(ACTIONS, /if \(!allowed\) return null;/);
  assert.match(VIEW, /allowed=\{!!canJob\[APP_REQUEST_ACTION\]\}/);
});

test('the backend seeds that exact key', () => {
  /*
   * A key the FE gates on but nobody seeds is a permanently invisible button.
   *
   * Located the way every other cross-repo test here does: EASYFIX_BACKEND_DIR
   * first (CI shallow-clones the backend into RUNNER_TEMP and points this at
   * it), then the developer-machine sibling. A hardcoded '../EasyFix_Backend'
   * resolves against THIS repo's root, which is wrong in CI and wrong in any
   * git worktree — and it made this test the only red one when the QA merge ran
   * from a worktree, for a reason that had nothing to do with the code.
   *
   * BOTH directories are searched: migrations/ is the pending set and
   * migrations/executed/ is where the file moves once it has been run
   * everywhere. The seed is equally real in either, and pinning one would turn
   * a routine bookkeeping move into a failing build.
   */
  const root = process.env.EASYFIX_BACKEND_DIR
    || path.resolve(__dirname, '../../EasyFix_Backend');
  const NAME = '2026-09-15-seed-job-app-request-action.sql';
  const found = ['migrations', path.join('migrations', 'executed')]
    .map((d) => path.join(root, d, NAME))
    .find((f) => fs.existsSync(f));
  // FAIL, NEVER SKIP: an unseeded key is a button nobody can ever click, and a
  // check that quietly stops looking is how it would ship that way.
  assert.ok(found,
    `EasyFix_Backend checkout not found — set EASYFIX_BACKEND_DIR or clone it beside this `
    + `repo. Looked for ${NAME} under ${root}/migrations{,/executed}. This is the cross-repo `
    + 'half of the permission contract and must not degrade to a pass.');
  const mig = fs.readFileSync(found, 'utf8');
  assert.match(mig, /'isJobAppRequestResolve'/);
  assert.match(mig, /INSERT INTO menu_action/);
  assert.match(mig, /'Approve \/ Reject Technician Requests'/);
});

// ─── Cancel Job inside the Reassign modal ───────────────────────────────

test('Reassign carries a red cancel in its footer', () => {
  assert.match(ASSIGN, /\{canCancel && cancel\.button\}/);
  // The red lives in the shared control now — assert it there, or "red" is
  // a claim about markup this file can no longer see.
  assert.match(CANCEL, /<Button\s*variant="destructive"/,
    'the owner asked for a RED cancel — variant="destructive" is that red');
});

test('Cancel Job sits before Close in the right cluster, per the footer convention', () => {
  // Add Remarks left; Cancel · lifecycle · Close right (owner, 2026-07-29).
  const footAt = ASSIGN.indexOf('<DialogFooter className="px-6 sm:justify-between">');
  assert.ok(footAt > -1, 'positive control: the footer must be locatable');
  const foot = ASSIGN.slice(footAt, ASSIGN.indexOf('</DialogFooter>', footAt));
  assert.ok(foot.indexOf('Add Remarks') < foot.indexOf('cancel.button'), 'Add Remarks stays left');
  assert.ok(foot.indexOf('cancel.button') < foot.indexOf('>Close<'), 'Cancel comes before Close');
});

test('Cancel Job is fenced on a status this modal was meant to be open at', () => {
  // The modal opens from a shareable ?action=reassign URL for ANY jobId, and
  // setStatus would cancel a COMPLETED job without complaint unless its
  // completion is posted. Waiting for the probe means the button cannot paint
  // on an unknown status either.
  assert.match(ASSIGN,
    /const canCancel = hasAction\(me, 'isJobCancel'\)\s*&& probe\?\.job_status != null && !wrongStatusForMode;/);
});

test('the shared cancel evicts after the PATCH, then hands control back', () => {
  const patchAt = CANCEL.indexOf('await api.patch(');
  const evictAt = CANCEL.indexOf('invalidateFetch(');
  const doneAt = CANCEL.indexOf('await onCancelled();');
  assert.ok(patchAt > -1, 'positive control: the PATCH must be locatable');
  assert.ok(evictAt > patchAt, 'evict only once the cancel has committed');
  assert.ok(doneAt > evictAt, 'the caller runs last, on a cache that is already clean');
  // Awaited, so a caller that refetches before closing keeps that order.
  assert.match(CANCEL, /onCancelled: \(\) => void \| Promise<void>;/);
});

test('Reassign refreshes the caller BEFORE closing', () => {
  const hookAt = ASSIGN.indexOf('useCancelJob({');
  assert.ok(hookAt > -1, 'positive control: the hook call must be locatable');
  const call = ASSIGN.slice(hookAt, ASSIGN.indexOf('});', hookAt));
  assert.match(call, /onCancelled: \(\) => \{ onChanged\?\.\(\); onClose\(\); \}/,
    'refresh the list before closing, or the cancelled row flashes back');
});

test('both AssignTechnicianModal mounts pass onChanged', () => {
  // Otherwise the cancel commits and the row sits there until a manual refresh.
  // Enumerated, not spot-checked: a third mount added later must fail here.
  const files = ['src/app/(authed)/my-orders/page.tsx', 'src/app/(authed)/jobs/page.tsx'];
  const mounts = files.flatMap((f) => [...strip(read(f)).matchAll(/<AssignTechnicianModal[\s\S]*?\n\s*\/>/g)]
    .map((m) => ({ f, body: m[0] })));
  assert.equal(mounts.length, 2, `expected exactly two mounts, found ${mounts.length}`);
  for (const { f, body } of mounts) {
    assert.match(body, /onChanged=\{/, `${f}: its Reassign modal can now cancel a job — wire onChanged`);
  }
});

// ─── The ask inside JobModal ────────────────────────────────────────────

test('JobModal renders the technician\'s ask, above its customer twin', () => {
  assert.match(MODAL, /<JobTechnicianRequest job=\{job\} onJobChanged=\{onRefresh\} \/>/);
  assert.ok(MODAL.indexOf('<JobTechnicianRequest') < MODAL.indexOf('<JobCustomerRequests'),
    "the technician's ask is the one that stops work today — it goes first");
});

test('the banner costs NO new fetch — the detail payload already carries the ask', () => {
  // GET /admin/jobs/:id resolves it server-side as `appRequest` (backend
  // getByIdCore → buildAppRequest) for the technician app's own banner. The CRM
  // was ignoring a key it was already being sent; a second endpoint would be
  // a round trip for data in hand.
  assert.match(MODAL, /const req = appRequestFromDetail\(job\?\.appRequest\);/);
  const at = MODAL.indexOf('function JobTechnicianRequest');
  assert.ok(at > -1, 'positive control: the component must be locatable');
  const fn = MODAL.slice(at, MODAL.indexOf('\n}\n', at));
  assert.doesNotMatch(fn, /useFetch|api\.get/, 'the banner must not fetch anything of its own');
});

test('the banner and the queue chip cannot disagree — one vocabulary table', () => {
  const LIB = strip(read('src/lib/job-app-request.ts'));
  // Both builders spread the same KIND entry rather than typing the strings.
  assert.match(LIB, /const KIND: Readonly<Record<AppRequestKind, \{ label: string; tone: AppRequest\['tone'\] \}>> = \{/);
  assert.equal((LIB.match(/\.\.\.KIND(\.cancel|\.reschedule|\[kind\])/g) || []).length, 3,
    'every AppRequest built in this module must take its label/tone from KIND');
  assert.equal((LIB.match(/'Cancellation Requested'/g) || []).length, 1,
    'the label is spelt once — a second copy is the drift this table prevents');
});

test('the detail mapper is NOT status-gated, unlike the list predicate', () => {
  /*
   * Deliberate asymmetry, and it mirrors the server. The queue pins
   * job_status = 1 because that is what empties it. The detail object keeps
   * describing an open ask after ops moves the job, because the technician's
   * app hides its own Cancel/Reschedule buttons while it is non-null — so the
   * banner answers "what can the technician see right now".
   */
  const R = require('../.test-build/job-app-request');
  const onClosedJob = R.appRequestFromDetail({ type: 'cancel', reason: 'Customer away', requestedAt: '2026-09-14 10:00' });
  assert.equal(onClosedJob.kind, 'cancel');
  assert.equal(onClosedJob.label, 'Cancellation Requested');
  // Positive control on the other half: the LIST predicate does gate on status.
  assert.equal(R.appRequestOf({ job_status: 6, is_cancelled_by_app: 1 }), null);
  assert.ok(R.appRequestOf({ job_status: 1, is_cancelled_by_app: 1 }));
});

test('the mapper refuses an absent or unknown ask rather than half-labelling it', () => {
  const R = require('../.test-build/job-app-request');
  for (const input of [null, undefined, {}, { type: null }, { type: '' }, { type: 'refund' }]) {
    assert.equal(R.appRequestFromDetail(input), null, `${JSON.stringify(input)} must yield no banner`);
  }
  // A CANCELLATION proposes no new time: a stray value must not render a
  // "Requested:" line the ask never made.
  const stray = R.appRequestFromDetail({ type: 'cancel', requestedDateTime: '2026-09-20 10:00' });
  assert.equal(stray.requestedFor, null);
  assert.equal(R.appRequestFromDetail({ type: 'reschedule', requestedDateTime: '2026-09-20 10:00' }).requestedFor,
    '2026-09-20 10:00', 'a reschedule DOES carry it — or the control above proves nothing');
});

test('the banner reuses the row\'s decision flow, only the trigger differs', () => {
  assert.match(MODAL, /<TechRequestActions[\s\S]*?variant="button"/);
  assert.match(ACTIONS, /variant\?: 'icon' \| 'button';/);
  assert.match(ACTIONS, /const triggers = variant === 'button' \? \(/);
  // One flow: everything after the triggers is shared, so the two surfaces
  // cannot decide differently.
  assert.equal((ACTIONS.match(/const onApprove =/g) || []).length, 1);
  assert.equal((ACTIONS.match(/async function onReject\(\)/g) || []).length, 1);
  // Same permission on both surfaces.
  assert.match(MODAL, /actionFlags\(me, \[APP_REQUEST_ACTION\]\)/);
  assert.match(MODAL, /can\[APP_REQUEST_ACTION\] && \(/);
});

// ─── Vocabulary ─────────────────────────────────────────────────────────

test('every user-facing label is Title Case', () => {
  const labels = [
    'Cancel', 'Approve', 'Reject', 'Reject Request', 'Request Rejected', 'Job Cancelled',
    'Reject Cancellation Request?', 'Reject Reschedule Request?',
    'Technician Requested',
  ];
  for (const label of labels) {
    assert.ok(ACTIONS.includes(label) || CANCEL.includes(label) || MODAL.includes(label),
      `missing label: ${label}`);
    for (const word of label.replace('?', '').split(' ')) {
      assert.match(word, /^[A-Z]/, `"${label}" must be Title Case (check:brand / label-casing rule)`);
    }
  }
});

test('both buttons carry a title AND an aria-label', () => {
  // The neighbouring Reassign icon shipped without an aria-label; an
  // icon-only DESTRUCTIVE control must not repeat that.
  // Whole elements, not `<button…>`: a non-greedy match to the first `>` stops
  // inside `onClick={() =>` and sees no attributes at all.
  // The ICON variant only — <button> lowercase. The banner variant renders
  // <Button> with visible text, which is its own accessible name.
  const buttons = [...ACTIONS.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 2, `expected Approve + Reject, found ${buttons.length}`);
  for (const b of buttons) {
    assert.match(b, /title=\{/, 'each icon button needs a hover title');
    assert.match(b, /aria-label=\{/, 'each icon button needs an accessible name');
  }
});
