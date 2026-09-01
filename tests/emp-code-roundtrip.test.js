const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  EMP_CODE_RE, formatEmpCode, parseEmpCodeCount,
} = require('../.test-build/emp-code');

/*
 * The Add User loop, end to end, against the backend's OWN module.
 *
 * tests/emp-code.test.js pins this repo's format to the literal 'E'. That
 * catches a CRM-side edit, and nothing else: both repos could be pinned to
 * different literals and both suites would pass. What is actually load-bearing
 * is the LOOP, and no test anywhere covered it —
 *
 *   backend  nextEmpCode()     reads MAX(user_code) and allocates the next one
 *   backend  suggestNextEmpCode() returns { count, code } to GET /admin/users/next-emp-code
 *   CRM      setEmpCount(String(count))          seeds the input with the count
 *   CRM      formatEmpCode(empCount)             re-assembles it on save
 *   backend  EMP_CODE_RE.test(...)               validates what arrives
 *
 * — so the value posted must equal the code the backend suggested, and must
 * satisfy the regex the backend validates with. Padding, prefix or parse
 * drifting on either side breaks a link a single-repo test cannot see.
 *
 * TWO MODES, deliberately, exactly as scripts/sync-brand-assets.mjs --check
 * already does with the Brand Kit. With EasyFix_Backend checked out beside this
 * repo it runs against the REAL module, so the loop is proven rather than
 * described. Without it — CI, a fresh clone, anyone who only has this repo — it
 * falls back to a pinned fixture of the endpoint's contract. The fallback is
 * weaker on purpose: it cannot notice the backend moving. It is not weaker in a
 * way that lets a CRM-side break through, which is what this repo's CI can
 * actually act on.
 */
let backend = null;
try {
  backend = require(path.join(__dirname, '..', '..', 'EasyFix_Backend', 'lib', 'emp-code'));
} catch { /* fixture mode — see below */ }

/*
 * The endpoint, stubbed at the seam that matters: what the DB currently holds.
 * LIVE mode drives the backend's real nextEmpCode() through a fake connection —
 * the same shape its own suite uses — so the padding and the MAX+1 are the
 * shipped ones, not a restatement of them.
 */
function nextEmpCodeEndpoint(maxSeqInDb) {
  if (backend) {
    const conn = { query: async () => [[{ max_seq: maxSeqInDb }]] };
    return backend.nextEmpCode(conn).then((code) => ({ count: backend.parseEmpCode(code), code }));
  }
  const n = (maxSeqInDb || 0) + 1;
  return Promise.resolve({ count: n, code: 'E' + String(n).padStart(6, '0') });
}

test(`the Add User loop closes${backend ? ' (LIVE against EasyFix_Backend)' : ' (FIXTURE — backend not on disk)'}`, async () => {
  /*
   * null is the cold-start case the backend documents: MAX() over an empty set
   * is SQL NULL, so the first code issued is E000001. It is the state a fresh QA
   * database is in, which makes it the one most likely to be hit by hand.
   */
  for (const maxSeq of [null, 0, 1, 122, 200243, 999998]) {
    const res = await nextEmpCodeEndpoint(maxSeq);

    // What the dialog does on open, then on save. Not paraphrased — this is the
    // exact pair of calls in settings/manage-users/page.tsx.
    const seeded = String(res.count);
    const posted = formatEmpCode(seeded);

    assert.equal(posted, res.code,
      `max_seq=${maxSeq}: the CRM posts ${posted}, the backend suggested ${res.code}`);
    assert.ok(EMP_CODE_RE.test(posted), `${posted} must satisfy this repo's regex`);
    if (backend) {
      assert.ok(backend.EMP_CODE_RE.test(posted),
        `${posted} must satisfy the BACKEND regex — this is the 400 the operator would see`);
    }
  }
});

test('an existing code survives an edit that does not touch it', async () => {
  /*
   * The silent-corruption path. Opening a user hydrates the input by stripping
   * the code down to its bare count, and saving re-assembles it. An operator who
   * opens a user to change their ROLE still posts user_code, so if those two
   * disagree by even a leading zero, an unrelated edit rewrites the employee
   * code of a person nobody was editing.
   */
  for (const stored of ['E000001', 'E000123', 'E200244', 'E999999']) {
    assert.equal(formatEmpCode(parseEmpCodeCount(stored)), stored);
    if (backend) assert.equal(backend.parseEmpCode(stored), Number(parseEmpCodeCount(stored)));
  }
});

/*
 * SEQUENCE 0 — resolved 2026-09-01, and worth keeping a test on precisely
 * because it was the one place the two repos disagreed.
 *
 * The backend accepts 0 and mints E000000 so that format∘parse is total across
 * its regex. This repo used to refuse it, on the reasoning that an operator
 * should not be able to type 0 into a mandatory field. That guard never stopped
 * E000000 existing — only the backend mints codes — it just made a user who had
 * one impossible to edit at all, since user_code rides along on every save.
 *
 * Now both accept it, so the useful property holds: every code the validator
 * accepts, the dialog can hydrate and post back unchanged.
 */
test('sequence 0 round-trips on both sides — the last divergence, closed', () => {
  assert.equal(formatEmpCode('0'), 'E000000');
  assert.equal(parseEmpCodeCount('E000000'), '0');
  assert.equal(formatEmpCode(parseEmpCodeCount('E000000')), 'E000000',
    'a seeded E000000 survives an edit instead of stranding the record');
  if (backend) {
    assert.equal(backend.formatEmpCode(0), 'E000000', 'the backend agrees');
    assert.ok(backend.EMP_CODE_RE.test('E000000'), 'and validates it');
  }
});

/*
 * Emptiness is the thing still refused, and it must stay refused: it is what
 * makes the dialog raise "Employee Code is required" instead of posting ''.
 */
test('an empty count is still refused — the required-field check depends on it', () => {
  for (const empty of ['', '   ', null, undefined, 'abc']) {
    assert.equal(formatEmpCode(empty), '', `${JSON.stringify(empty)} must not become a code`);
  }
});
