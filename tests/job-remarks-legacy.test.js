'use strict';
/*
 * The job's remarks table is the LEGACY CRM's (2026-09-11 per ops).
 *
 * EasyFix_CRM jobCommentList.vm:4-9 rendered six columns, in this order:
 *   Remarks For | Accountable | Reason | Remarks | Remark By | Date/Time
 * The new CRM showed four (Date/Time | Remarks | Remarks By | Reason) and put
 * `c.user_name ?? 'Unknown'` in the author cell — "Unknown" on every
 * escalation, because escalations never set commented_by (the author's name
 * lives in job_escalated_by). The backend now resolves that into `remark_by`,
 * plus `remarks_for` and `accountable` (services/job-comment.service.js
 * shapeRow); this pins the CRM half.
 *
 * Source-shape where the contract is markup, EXECUTED where it is a value: the
 * date formatter and the Remarks For fallback map are transpiled out of
 * JobModal.tsx and run, the same transpile call jobmodal-unified-view.test.js
 * uses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/components/job/JobModal.tsx'), 'utf8');
// Comments out, so prose about the old behaviour cannot satisfy or trip a check.
const strip = (t) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fnSource(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start > -1, `${name} must exist in JobModal.tsx`);
  return SRC.slice(start, SRC.indexOf('\nfunction ', start + 1));
}
const TAB = strip(fnSource('JobCommentsTab'));
const THEAD = TAB.slice(TAB.indexOf('<thead>'), TAB.indexOf('</thead>'));
const TBODY = TAB.slice(TAB.indexOf('<tbody>'), TAB.indexOf('</tbody>'));

/* Run module-scope TS from JobModal.tsx, with the real parseIstDateTime. */
function load(names, exportsExpr) {
  const lib = fs.readFileSync(path.join(ROOT, 'src/lib/format.ts'), 'utf8');
  const fmt = { exports: {} };
  new Function('exports', 'module', 'require', ts.transpileModule(lib, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText)(fmt.exports, fmt, require);
  // One-line const, multi-line object const, or function — each ends at column 0.
  const parts = names.map((n) => {
    const m = SRC.match(new RegExp(`\\n(const ${n}\\b[^\\n]*;|const ${n}\\b[^\\n]*\\{\\n[\\s\\S]*?\\n\\};|function ${n}\\([\\s\\S]*?\\n\\})\\n`));
    assert.ok(m, `${n} must be found at module scope in JobModal.tsx`);
    return m[1];
  });
  const { outputText } = ts.transpileModule(`${parts.join('\n')}\nmodule.exports = ${exportsExpr};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', 'parseIstDateTime', outputText)(mod.exports, mod, require, fmt.exports.parseIstDateTime);
  return mod.exports;
}

const WANTED = ['Remarks For', 'Accountable', 'Reason', 'Remarks', 'Remark By', 'Date/Time'];

test('the header is the legacy six columns, in the legacy order', () => {
  const labels = [...THEAD.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(labels, WANTED, 'jobCommentList.vm:4-9 — labels and order, verbatim');
});

test('each cell reads the backend field of the column above it', () => {
  // Split the row into its six <td>s (a cell never nests another <td>).
  const cells = TBODY.split(/<td\b/).slice(1).map((c) => c.slice(0, c.indexOf('</td>')));
  assert.equal(cells.length, WANTED.length, `one cell per column, found ${cells.length}`);
  const fields = [
    /\{c\.remarks_for \?\? LEGACY_REMARKS_FOR\[c\.comment_on\] \?\? ''\}/,
    /\{c\.accountable \?\? ''\}/,
    /c\.enum_desc/,
    /\{c\.comments\}/,
    /\{c\.remark_by \|\| c\.user_name \|\| ''\}/,
    /\{formatRemarkDate\(c\.created_on\)\}/,
  ];
  cells.forEach((cell, i) => assert.match(cell, fields[i], `${WANTED[i]}: wrong source, or the cells moved against the header`));
});

test('no "Unknown" is left in the remarks table — an author-less row is an em dash', () => {
  // Positive control: the table itself was found, so silence below means something.
  assert.ok(TBODY.includes('remark_by'), 'the remarks tbody must be located');
  assert.doesNotMatch(TAB, /\bUnknown\b/, 'the legacy cell is blank-ish, never the word Unknown');
  assert.doesNotMatch(TBODY, /user_name \?\?/, 'user_name alone is not the author — remark_by is');
});

test('long remarks wrap instead of widening the table, which scrolls rather than clips', () => {
  assert.match(TBODY, /<div className="[^"]*whitespace-pre-wrap[^"]*\[overflow-wrap:anywhere\][^"]*">\{c\.comments\}<\/div>/);
  const wrapper = TAB.slice(TAB.lastIndexOf('<div className="', TAB.indexOf('<table className="data-table')), TAB.indexOf('<table className="data-table'));
  assert.match(wrapper, /overflow-x-auto/, 'six columns can outgrow a narrow modal; hidden would clip Date/Time');
  assert.match(TAB, /<table className="data-table w-full text-xs">/, 'same density as before');
});

test('Date/Time is legacy dd MMM yyyy HH:mm, the IST wall clock unshifted', () => {
  const { formatRemarkDate } = load(['REMARK_MONTHS', 'formatRemarkDate'], '{ formatRemarkDate }');
  const saved = process.env.TZ;
  try {
    // A browser WEST of IST is where a naive parse would shift the clock.
    for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(formatRemarkDate('2026-09-11 13:29:00'), '11 Sep 2026 13:29', `DB string, TZ=${tz}`);
      assert.equal(formatRemarkDate('2026-01-05 00:07:59'), '05 Jan 2026 00:07', `midnight is 00, not 24 or 12 AM (TZ=${tz})`);
      // A pending row's created_on is new Date().toISOString() — an instant.
      assert.equal(formatRemarkDate('2026-09-11T07:59:00.000Z'), '11 Sep 2026 13:29', `ISO instant, TZ=${tz}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.equal(formatRemarkDate(null), '', 'legacy renders a null date blank');
  assert.equal(formatRemarkDate('not a date'), '');
});

test('Remarks For falls back to the legacy labels, for an older backend and a pending row', () => {
  const { LEGACY_REMARKS_FOR } = load(['LEGACY_REMARKS_FOR'], '{ LEGACY_REMARKS_FOR }');
  // jobCommentList.vm:15-28, verbatim; 0/5/7/10 were blank there.
  assert.deepEqual({ ...LEGACY_REMARKS_FOR }, {
    1: 'Scheduling', 2: 'CheckIn', 3: 'CheckOut', 4: 'Feedback', 6: 'Canceling',
    8: 'TX Reschedule', 9: 'TX cancelled', 15: 'Approval', 16: 'Unconfirmed', 17: 'Inquiry',
    18: 'TX Rejected', 19: 'Escalated', 20: 'Re-Opened Job', 21: 'ReScheduled',
  });
  // The inline form's own optimistic row carries the contract's fields.
  const post = TAB.slice(TAB.indexOf('async function postComment('), TAB.indexOf('setLocalPending((prev) => [optimistic'));
  assert.match(post, /remarks_for: LEGACY_REMARKS_FOR\[stage\] \?\? null,/);
  assert.match(post, /accountable: null,/);
  assert.match(post, /remark_by: currentUserName,/);
  // The fields stay OPTIONAL — an older backend omits them and the cells fall back.
  assert.match(SRC, /type RemarkRow = JobComment & \{\s*remarks_for\?: string \| null;\s*accountable\?: string \| null;\s*remark_by\?: string \| null;/);
});

test('the Schedule & Assign remarks thread names the escalation author too (JobRemarksView)', () => {
  const view = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'components', 'job', 'JobRemarksView.tsx'), 'utf8');
  assert.match(view, /\{c\.remark_by \|\| c\.user_name \|\|/, 'resolved author first — an escalation has no user_name');
  assert.doesNotMatch(view, />Customer</, 'an unknown author is not "Customer" — that names the wrong party');
});
