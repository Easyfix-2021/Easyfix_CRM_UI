'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * My Orders — the ops Check-In action, and the Audit entry point.
 *
 * WHAT WENT WRONG (2026-09-08)
 *
 * 1. Pending to Start's PlayCircle "Check-In" opened ?action=checkin, which
 *    JobModal folds into the read-only view workspace — and NOTHING inside that
 *    workspace performed a check-in. The button had been removed on 2026-07-28
 *    ("check-in is done by the technician from the app"), a decision the owner
 *    has since overridden. Meanwhile the one-click check-in that did work went
 *    through PATCH /admin/jobs/:id/status, which writes job_status and none of
 *    the check-in columns — checkin_date_time, the TAT anchor, stayed null.
 *
 * 2. Closing that modal never refreshed the three appointment buckets, because
 *    PendingToStartView's refetch set listed reassign / assign / view and not
 *    the one action that actually moves a row OUT of Pending to Start.
 *
 * 3. Audit & Complete (statuses 3 / 5) fell through to the generic table and
 *    offered a lone Eye — no way into the audit actions, which live on the
 *    JobModal workspace's Billing & Charges tab.
 *
 * Registering a JobModal action costs FIVE hand-synced edits across four files
 * (the JobAction union, KNOWN_ACTIONS, JOBMODAL_ACTIONS, JobModalMode +
 * effectiveMode fold + guardedClose's read-only skip, and the page's `modal`
 * memo). Every one of them is silent when missed — the action degrades to an
 * empty modal rather than erroring — so each is pinned below.
 *
 * Source-level, because tests/ here is node:test over pure logic with no DOM.
 */

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/*
 * Comments are stripped before every structural scan. A guard in this repo has
 * already failed because its own explanatory docblock mentioned the identifier
 * it asserted the ABSENCE of — the prose read as the thing.
 */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const modalSrc = read('components', 'job', 'JobModal.tsx');
const pendingSrc = read('components', 'job', 'PendingToStartView.tsx');
const urlSrc = read('lib', 'job-action-url.ts');
const hostSrc = read('components', 'job', 'JobModalHost.tsx');
const pageSrc = read('app', '(authed)', 'my-orders', 'page.tsx');
const jobsSrc = read('app', '(authed)', 'jobs', 'page.tsx');
const dialogSrc = read('components', 'job', 'CheckInWithReasonDialog.tsx');

const modal = strip(modalSrc);
const pending = strip(pendingSrc);
const url = strip(urlSrc);
const host = strip(hostSrc);
const page = strip(pageSrc);
const jobsPage = strip(jobsSrc);
const dialog = strip(dialogSrc);

// ── A. The ops Check-In action ──────────────────────────────────────

/*
 * The gate on the button. Written as ONE regex over the whole conjunction
 * rather than three independent substring checks: the failure being guarded
 * against is a button that renders on the wrong status or without a permission,
 * and three separate matches would pass on a file where the three fragments
 * exist in unrelated places.
 */
const CHECKIN_BUTTON =
  /\{canCheckIn\(s\) && can\.isJobStatusChange && transitionAllowed\(me\?\.allowedStages, s, ST\.IN_PROGRESS\) && \(\s*<Button[^>]*onClick=\{\(\) => setCheckinOpen\(true\)\}>Check In<\/Button>/;

test('the job workspace carries a Check In action for a SCHEDULED job', () => {
  assert.match(
    modal,
    /const canCheckIn\s*=\s*\(s: number\) => s === ST\.SCHEDULED;/,
    'check-in must be predicated on job_status 1 (SCHEDULED), like every other lifecycle predicate here',
  );
  assert.match(
    modal,
    CHECKIN_BUTTON,
    'ActionBar must render a Check In button gated on the status predicate AND isJobStatusChange AND the 1 → 2 stage transition',
  );
});

test('Check In posts to the check-in endpoint, never the status PATCH', () => {
  /*
   * This is the whole point of the change. PATCH /admin/jobs/:id/status writes
   * job_status alone; the check-in columns (checkin_date_time — the TAT anchor)
   * are written only by the dedicated endpoint. A "fix" that reused doStatus()
   * would look identical in the UI and leave the anchor null.
   */
  assert.match(
    dialog,
    /api\.post\(`\/admin\/jobs\/\$\{jobId\}\/checkin`, \{ reason: trimmed \}\)/,
    'it must POST /admin/jobs/:id/checkin with the reason',
  );
  assert.ok(
    !/\/status`/.test(dialog),
    'it must not fall back to the status PATCH, which writes no check-in columns',
  );
});

test('the reason is mandatory and capped at the wire limit', () => {
  assert.match(dialog, /maxLength=\{500\}/, 'the textarea must cap at the backend max');
  assert.match(
    dialog,
    /disabled=\{loading \|\| !trimmed\}/,
    'submit must be disabled until a non-blank reason is typed',
  );
  assert.match(
    dialog,
    /if \(!trimmed\) \{ setErr\('A reason is required\.'\); return; \}/,
    'and the handler must refuse a blank reason even if the disabled state is bypassed',
  );
});

test('the check-in dialog uses the shared dirty guard, not an inline onOpenChange', () => {
  assert.match(dialog, /useFormDirtyGuard\(onClose, \{/, 'house rule: Esc / X / overlay close routes through useFormDirtyGuard');
  assert.match(dialog, /<Dialog open=\{open\} onOpenChange=\{guardedOpenChange\}>/);
  assert.ok(
    !/onOpenChange=\{\(o\) =>/.test(dialog),
    'no inline onOpenChange arrow — that is the pattern the guard replaces',
  );
});

test('the retired "ops never check in" comment no longer contradicts the code', () => {
  /*
   * Scanned against the RAW source on purpose — the claim being retired IS a
   * comment, so the stripped copy cannot see it.
   *
   * Matched on the tail of the sentence ("not by ops on the web") rather than
   * on "Start button removed": the replacement comment quotes the old decision
   * by name while recording that it was overridden, so a check keyed on the
   * name would fail against the very edit that fixed it.
   */
  assert.ok(
    !modalSrc.includes('not by ops on the web'),
    'JobModal must not still assert that ops cannot check in on the web',
  );
  assert.ok(
    !modalSrc.includes('canStart removed'),
    'the canStart tombstone must be replaced by the live canCheckIn predicate',
  );
});

// ── B. Pending to Start refetches when the check-in workspace closes ──

test("'checkin' is in the set of actions whose close refetches the buckets", () => {
  const guard = pending.match(/prevAction\.current === 'reassign'[\s\S]{0,260}?\) &&/);
  assert.ok(guard, 'the prevAction comparison must be found');
  for (const action of ['reassign', 'assign', 'checkin', 'view']) {
    assert.ok(
      guard[0].includes(`prevAction.current === '${action}'`),
      `'${action}' must be in the refetch set — its close can move a row out of this bucket`,
    );
  }
});

test('the PlayCircle row action still opens the check-in workspace', () => {
  assert.match(
    pending,
    /onClick=\{\(\) => onCheckin\(j\.job_id\)\}/,
    'the Check-In icon must survive — it is the only entry to the ops check-in',
  );
  assert.match(pending, /canJob\.isJobStatusChange && \(/, 'and stay permission-gated');
  assert.match(page, /function openCheckin\(id: number\)\s*\{ openJobAction\('checkin',\s*id\); \}/);
});

// ── C. The four+one registration points for the `audit` action ───────

test('point 1 — job-action-url registers audit in BOTH the union and the set', () => {
  const union = url.match(/export type JobAction = [^;]+;/);
  assert.ok(union, 'the JobAction union must be found');
  assert.match(union[0], /'audit'/, "the union must carry 'audit'");

  const known = url.match(/const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>\(\[[^\]]*\]\);/);
  assert.ok(known, 'KNOWN_ACTIONS must be found');
  assert.match(known[0], /'audit'/, "KNOWN_ACTIONS must carry 'audit' — the union alone does not parse the URL");
});

test('point 2 — the JOBMODAL_ACTIONS allow-list carries audit, and every consumer reads it', () => {
  /*
   * Moved out of JobModalHost on 2026-09-09 (see section F): the host, /jobs and
   * /my-orders each spelled this rule themselves, and only the host spelled it
   * as an allow-list. There is now one list, in the module that owns JobAction.
   */
  const set = url.match(/export const JOBMODAL_ACTIONS = \[[^\]]*\] as const satisfies readonly JobAction\[\];/);
  assert.ok(set, 'JOBMODAL_ACTIONS must live in job-action-url');
  assert.match(set[0], /'audit'/);
  assert.match(set[0], /'checkin'/, 'and must not have lost checkin while audit was added');
  assert.match(host, /const supported = isJobModalAction\(action\);/, 'the host must consume the shared list');
});

const MEMO = /const modal = useMemo<\{ open: boolean; mode: JobModalMode; id\?: number \}>\(\(\) => \{[\s\S]*?\}, \[urlAction, urlJobId\]\);/;

test('point 3 — both page memos narrow through the allow-list, with no cast', () => {
  /*
   * These memos used to name the actions they REFUSED and cast the survivors.
   * `audit` reached JobModal because nobody had excluded it — the same reason
   * `schedule` reached it (section F). Narrowing inverts that: an action reaches
   * JobModal because it is on the list, not because nobody thought to bar it.
   */
  for (const [name, src] of [['my-orders', page], ['jobs', jobsPage]]) {
    const memo = src.match(MEMO);
    assert.ok(memo, `the ${name} \`modal\` memo must be found`);
    assert.match(
      memo[0],
      /if \(!isJobModalAction\(urlAction\)\) return \{ open: false, mode: 'create' \};/,
      `${name} must gate on the shared allow-list`,
    );
    assert.match(
      memo[0],
      /return \{ open: true, mode: urlAction, id: urlJobId \};/,
      `${name} must pass the NARROWED action through — an \`as JobModalMode\` here is the bug`,
    );
    assert.ok(
      !/as JobModalMode/.test(memo[0]),
      `${name} must not cast: the cast is what let an unregistered action reach JobModal`,
    );
  }
});

test('point 4 — JobModal folds audit into the view workspace and titles it', () => {
  /*
   * JobModalMode is an ALIAS of JobModalAction now, so "does it carry audit"
   * is asked of the one list both sides derive from. Two hand-synced unions is
   * precisely what let ?action=schedule name a mode with no branch.
   */
  assert.match(
    modal,
    /export type JobModalMode = JobModalAction;/,
    'JobModalMode must stay an alias — a re-forked union reopens the drift',
  );
  assert.match(
    url.match(/export const JOBMODAL_ACTIONS = \[[^\]]*\] as const/)[0],
    /'audit'/,
    "the shared list must carry 'audit', or the page memo cannot narrow to it",
  );

  assert.match(
    modal,
    /const effectiveMode = \(mode === 'checkin' \|\| mode === 'audit'\) \? 'view'/,
    'audit must fold to view exactly as checkin does — that is what renders the workspace',
  );
  assert.match(
    modal,
    /mode === 'audit'\s*\? `Audit · Job #\$\{jobId\}`/,
    'and the title must name the entry point',
  );
});

test('point 5 — audit skips the discard prompt, like every other read-only fold', () => {
  /*
   * The fifth point, and the one the brief did not name. guardedClose short-
   * circuits for pure-read modes; a mode that folds to view but is missing here
   * fires a phantom "Discard Unsaved Changes?" on close, from child components
   * that commit an initial value on mount.
   */
  assert.match(
    modal,
    /if \(mode === 'view' \|\| mode === 'checkin' \|\| mode === 'audit'\) \{/,
    'every mode folding to view must be listed in guardedClose',
  );
});

// ── D. The Audit entry point on the Audit & Complete rows ────────────

test('the audit entry point opens the workspace on Billing & Charges', () => {
  assert.match(
    page,
    /function openAudit\(id: number\)\s*\{ openJobAction\('audit',\s*id, \{ tab: 'billing' \}\); \}/,
    "openAudit must deep-link the billing tab through the existing { tab } sub-state",
  );
  // The nav helper is what turns { tab } into the ?viewTab= key the modal reads.
  assert.match(
    strip(urlSrc),
    /extras: opts\?\.tab \? \{ viewTab: opts\.tab \} : undefined/,
    'the { tab } sub-state must still be written as viewTab',
  );
});

test('the audit row action is gated on the status AND on canManageJobCharges', () => {
  // Anchored on the closing </button> — a lazy window would stop at the first
  // `)}` inside the JSX (the onClick arrow) and never reach the icon.
  const button = page.match(/\{\(j\.job_status === 3 \|\| j\.job_status === 5\) && canAudit && \([\s\S]{0,900}?<\/button>/);
  assert.ok(button, 'the audit row action must be gated on statuses 3 / 5 and canAudit');
  assert.match(button[0], /onClick=\{\(\) => openAudit\(j\.job_id\)\}/);
  assert.match(button[0], /<ClipboardCheck /, 'it must be its own icon, distinguishable from the Eye');

  /*
   * canManageJobCharges is a STANDALONE boolean on /auth/me, not an actionFlags
   * key. Reading it through actionFlags would silently return undefined and
   * fail closed forever, which looks exactly like "the owner has no access".
   */
  assert.match(
    page,
    /const canAudit = me\?\.canManageJobCharges === true;/,
    'canAudit must read the standalone flag directly, fail-closed',
  );
  assert.ok(
    !/actionFlags\([^)]*canManageJobCharges/.test(page),
    'canManageJobCharges must never be requested through actionFlags',
  );
});

test('the Billing & Charges tab is still gated by the same flag it is entered on', () => {
  /*
   * The entry point hides itself when the tab would be absent. That contract
   * breaks silently if the tab's own gate ever moves to a different flag — the
   * icon would then appear for people with no billing tab, opening a duplicate
   * of the Eye beside it.
   */
  assert.match(modal, /const canManageJobCharges = me\?\.canManageJobCharges === true;/);
  assert.match(modal, /\{canManageJobCharges && <TabsTrigger value="billing">/);
  assert.match(
    modal,
    /\.\.\.\(canManageJobCharges \? \['billing'\] : \[\]\)/,
    'and a ?viewTab=billing deep link must still fall back to Summary without the flag',
  );
});

// ── F. The two defects this registration cost surfaced (2026-09-09) ──

/*
 * Both are the same shape as the audit work above, found while doing it, and
 * both are invisible to every gate this repo runs.
 *
 * F1. `schedule` was added to JobAction and to nobody's exclusion list, so
 *     ?action=schedule&jobId=N fell through both page memos and was cast into a
 *     JobModalMode with no body branch and no footer branch: a titled, empty
 *     Dialog. On /my-orders that opened UNDER the real ScheduleAssignModal on
 *     every Schedule & Assign click; on /jobs, which mounts no such modal, the
 *     empty dialog was the whole result of a shared link. `as JobModalMode` is
 *     what hid it from tsc.
 *
 * F2. The row-level "Check in" buttons on both pages still called
 *     quickStatusChange(id, 2) — PATCH /admin/jobs/:id/status, which writes
 *     job_status and none of the check-in columns. So the SAME job reached
 *     IN_PROGRESS with checkin_date_time set or null depending on which button
 *     ops pressed, and TAT reporting could not tell the two apart.
 */

test('F1 — schedule is not in the allow-list, so it can never open JobModal', () => {
  const set = url.match(/export const JOBMODAL_ACTIONS = \[[^\]]*\] as const/)[0];
  for (const other of ['schedule', 'assign', 'reassign']) {
    assert.ok(
      !set.includes(`'${other}'`),
      `'${other}' has its own dialog and must stay off the JobModal allow-list`,
    );
  }
  // Positive control: it is still a real, parseable action — the fix routes it
  // away from JobModal, it does not delete it.
  assert.match(url.match(/export type JobAction = [^;]+;/)[0], /'schedule'/);
  assert.match(
    url.match(/const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>\(\[[^\]]*\]\);/)[0],
    /'schedule'/,
    'schedule must still parse out of the URL, or ScheduleAssignModal stops opening',
  );
});

test('F1 — the page that owns ?action=schedule still derives its real modal from it', () => {
  /*
   * The failure mode of over-correcting: excluding schedule from JobModal while
   * also breaking the modal it actually belongs to would swap an empty dialog
   * for no dialog, which is harder to notice.
   */
  assert.match(
    page,
    /const scheduleModal = useMemo<\{ open: boolean; jobId: number \| null \}>\(\(\) => \{[\s\S]*?urlAction === 'schedule'[\s\S]*?\}, \[urlAction, urlJobId\]\);/,
    'my-orders must still derive ScheduleAssignModal from ?action=schedule',
  );
  assert.match(page, /<ScheduleAssignModal\n\s*open=\{scheduleModal\.open\}/);
});

test('F2 — neither row Check-In goes through the status PATCH any more', () => {
  for (const [name, src] of [['my-orders', page], ['jobs', jobsPage]]) {
    assert.ok(
      !/quickStatusChange\(j\.job_id, 2, 'Check in'\)/.test(src),
      `${name}: the row check-in must not PATCH /status — it writes no checkin_date_time`,
    );
    assert.match(
      src,
      /onClick=\{\(\) => setCheckinJobId\(j\.job_id\)\}/,
      `${name}: the row check-in must open the shared reason dialog`,
    );
    assert.match(
      src,
      /<CheckInWithReasonDialog\n\s*open=\{checkinJobId != null\}/,
      `${name}: and must actually mount it`,
    );
  }
});

test('F2 — check-out is untouched: it has no columns of its own to write', () => {
  /*
   * quickStatusChange is SHARED with the status-3 "Check out & complete" action.
   * Routing check-in away from it must not take that caller with it, and a
   * regex sweep for the helper would have.
   */
  for (const [name, src] of [['my-orders', page], ['jobs', jobsPage]]) {
    assert.match(
      src,
      /quickStatusChange\(j\.job_id, 3, 'Check out & complete'\)/,
      `${name}: check-out must still use the shared quick-status helper`,
    );
  }
  assert.match(
    read('lib', 'job-tabs.ts'),
    /opts\.api\.patch\(`\/admin\/jobs\/\$\{jobId\}\/status`, \{ status: toStatus \}\)/,
    'makeQuickStatusChange itself must be unchanged',
  );
});

test('F2 — the dialog is ONE component with three mount points, not three copies', () => {
  /*
   * The reason this is an extraction and not a copy. Three inlined dialogs would
   * fix the reported defect and reintroduce it the next time the endpoint, the
   * 500-char cap or the 409 copy changes in only two of them.
   */
  assert.match(dialog, /export function CheckInWithReasonDialog\(/, 'it must be its own module');
  assert.ok(
    !/function CheckInWithReasonDialog\(/.test(modal),
    'JobModal must import it, not keep a private copy',
  );
  const posts = (str) => (str.match(/\/checkin`/g) || []).length;
  assert.equal(posts(dialog), 1, 'exactly one call site for the endpoint');
  for (const [name, src] of [['JobModal', modal], ['my-orders', page], ['jobs', jobsPage]]) {
    assert.equal(posts(src), 0, `${name} must not POST the check-in endpoint itself`);
    assert.match(
      src,
      /import \{ CheckInWithReasonDialog \}/,
      `${name} must import the shared dialog`,
    );
  }
});

// ── E. Controls ─────────────────────────────────────────────────────

test('positive control — the comment stripper actually removes prose', () => {
  /*
   * Every scan above runs against a stripped copy, and a stripper that silently
   * stopped working would start matching the explanations instead of the code.
   * Proven on a synthetic sample so the control cannot be satisfied by whatever
   * these files happen to contain today.
   */
  const sample = [
    "/* mode === 'audit' and canCheckIn(s), described in prose */",
    'const kept = 1;',
    "// setCheckinOpen(true)",
  ].join('\n');
  const stripped = strip(sample);
  assert.ok(!stripped.includes('audit'), 'block comments must go');
  assert.ok(!stripped.includes('setCheckinOpen'), 'line comments must go');
  assert.ok(stripped.includes('const kept = 1;'), 'and the code must survive');

  for (const [name, raw, code] of [
    ['JobModal', modalSrc, modal],
    ['PendingToStartView', pendingSrc, pending],
    ['my-orders/page', pageSrc, page],
  ]) {
    assert.ok(code.length < raw.length, `${name} must contain comments the scans excluded`);
  }
});

test('differential control — each guard fails on a source with its subject deleted', () => {
  /*
   * The assertions above are only worth their runtime if they would go RED when
   * the thing they describe is removed. Proving a regex matches today does not
   * prove it discriminates: a pattern loose enough to match some neighbouring
   * code stays green through the exact regression it was written for. So each
   * subject is deleted from a copy of the real source and the same pattern is
   * re-run — every one must now miss.
   */
  const cases = [
    [
      'the Check In button',
      modal.replace(CHECKIN_BUTTON, ''),
      CHECKIN_BUTTON,
      modal,
    ],
    [
      'the audit fold in effectiveMode',
      modal.replace(/\(mode === 'checkin' \|\| mode === 'audit'\)/, "mode === 'checkin'"),
      /const effectiveMode = \(mode === 'checkin' \|\| mode === 'audit'\) \? 'view'/,
      modal,
    ],
    [
      "'audit' in KNOWN_ACTIONS",
      url.replace(/'checkin', 'audit',/, "'checkin',"),
      /const KNOWN_ACTIONS: ReadonlySet<JobAction> = new Set<JobAction>\(\[[^\]]*'audit'[^\]]*\]\);/,
      url,
    ],
    [
      "'audit' in JOBMODAL_ACTIONS",
      url.replace(/(export const JOBMODAL_ACTIONS = \[[\s\S]*?)'audit', /, '$1'),
      /export const JOBMODAL_ACTIONS = \[[^\]]*'audit'[^\]]*\] as const/,
      url,
    ],
    [
      'the allow-list gate in the my-orders memo',
      page.replace(/if \(!isJobModalAction\(urlAction\)\) return \{ open: false, mode: 'create' \};/, ''),
      /if \(!isJobModalAction\(urlAction\)\) return \{ open: false, mode: 'create' \};/,
      page,
    ],
    [
      'the audit row action',
      page.replace(/\(j\.job_status === 3 \|\| j\.job_status === 5\) && canAudit/, 'false'),
      /\(j\.job_status === 3 \|\| j\.job_status === 5\) && canAudit/,
      page,
    ],
  ];

  for (const [what, mutated, pattern, original] of cases) {
    /*
     * The mutation must have LANDED. A `.replace()` whose pattern no longer
     * matches returns the input unchanged, and every assertion below would then
     * be run against pristine source — a differential that silently tests
     * nothing, which is the failure mode it exists to prevent elsewhere.
     */
    assert.notEqual(mutated, original, `the mutation for ${what} did not change the source`);
    assert.ok(
      pattern.test(original),
      `${what} must match the real source before the differential means anything`,
    );
    assert.ok(
      !pattern.test(mutated),
      `deleting ${what} must break its guard — the pattern is too loose to discriminate`,
    );
  }

  /*
   * The refetch set is checked by membership rather than by one regex, so its
   * differential is a membership test on a mutated copy.
   */
  const withoutCheckin = pending.replace("|| prevAction.current === 'checkin'", '');
  const guard = withoutCheckin.match(/prevAction\.current === 'reassign'[\s\S]{0,260}?\) &&/);
  assert.ok(guard, 'the mutated guard must still parse');
  assert.ok(
    !guard[0].includes("prevAction.current === 'checkin'"),
    "dropping 'checkin' from the refetch set must be visible to the membership check",
  );
});
