'use strict';
/*
 * Validate Flows → AI Calling: the Recording player must appear when the
 * recording lands AFTER the session is 'done'.
 *
 * ─── WHY (2026-09-11) ──────────────────────────────────────────────────────
 *
 * The call poll stops at 'done'/'failed', and the player rendered only if THAT
 * poll said recordingAvailable: true. But Plivo reports the recording to
 * /api/public/plivo/ai-recording asynchronously, after the session has mapped
 * and gone 'done' — so the flag was usually still false on the last poll, and
 * nothing ever asked again. The fix keeps polling (same interval, useFetch's
 * refetchInterval) after 'done' until recordingAvailable flips or ~90 s pass.
 *
 * The decision "poll or not" is the pure recordingPollKey(), lifted out of the
 * TSX and executed. The hook wiring around it is pinned by source, since this
 * repo has no component renderer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/app/(authed)/admin-actions/validate-flows/page.tsx'), 'utf8');
const MODAL = SRC.slice(SRC.indexOf('function AiCallingModal('), SRC.indexOf('function RecordingPlayer('));

function loadRecordingPollKey() {
  const start = SRC.indexOf('function recordingPollKey(');
  assert.ok(start > -1, 'recordingPollKey must exist in the Validate Flows page');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  const { outputText } = ts.transpileModule(`${body}\nmodule.exports = recordingPollKey;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', outputText)(mod.exports, mod, require);
  assert.equal(typeof mod.exports, 'function', 'the extracted text must evaluate to the helper');
  return mod.exports;
}

test('polls after done only while the recording is missing and the wait is not over', () => {
  const key = loadRecordingPollKey();
  const s = (status, recordingAvailable) => ({ sessionId: 'abc', status, recordingAvailable });
  assert.equal(key(s('done', false), false), '/admin/validate/ai-calling/abc', 'done, no recording yet → keep asking');
  assert.equal(key(s('done', undefined), false), '/admin/validate/ai-calling/abc', 'flag absent reads as not yet');
  assert.equal(key(s('done', true), false), null, 'recording landed → stop');
  assert.equal(key(s('done', false), true), null, 'wait over → stop');
  for (const status of ['calling', 'streaming', 'mapping', 'failed']) {
    assert.equal(key(s(status, false), false), null, `${status}: the call poll's job, or no player at all`);
  }
  assert.equal(key(null, false), null);
});

test('the follow-up rides useFetch at the call poll interval, bounded at ~90 s', () => {
  assert.match(SRC, /const AI_RECORDING_WAIT_MS = 90_000;/);
  assert.match(MODAL, /const recordingKey = recordingPollKey\(session, recordingWaitOver\);/);
  assert.match(MODAL, /useFetch<AiSession>\(recordingKey, \{ refetchInterval: AI_POLL_MS \}\)/, 'same interval as the call poll');
  assert.match(MODAL, /useEffect\(\(\) => \{\s*if \(!recordingKey\) return;\s*const t = setTimeout\(\(\) => setRecordingWaitOver\(true\), AI_RECORDING_WAIT_MS\);\s*return \(\) => clearTimeout\(t\);\s*\}, \[recordingKey\]\);/,
    'the wait starts when polling starts and is cleared when the recording lands');
  // The landed flag reaches the one field the player gates on — for THIS session only.
  assert.match(MODAL, /prev && prev\.sessionId === s\.sessionId\s*\? \{ \.\.\.prev, recordingAvailable: true,/);
  assert.match(MODAL, /\{isDone && session\.recordingAvailable && \(/);
  // Each new call (and a close) gets a fresh wait.
  assert.equal(MODAL.split('setRecordingWaitOver(false);').length - 1, 2, 'reset() and startCall() both clear it');
});

test('cross-repo: the polled endpoint derives recordingAvailable from the stored recording', () => {
  const root = (() => {
    for (const r of [process.env.EASYFIX_BACKEND_DIR, path.join(__dirname, '..', '..', 'EasyFix_Backend')]) {
      if (r && fs.existsSync(path.join(r, 'routes/admin/validate.js'))) return r;
    }
    throw new Error('EasyFix_Backend checkout not found — set EASYFIX_BACKEND_DIR; this half must not degrade to a pass.');
  })();
  const routes = fs.readFileSync(path.join(root, 'routes/admin/validate.js'), 'utf8');
  const get = routes.slice(routes.indexOf("router.get('/ai-calling/:sessionId',"), routes.indexOf("router.get('/ai-calling/:sessionId/recording'"));
  assert.ok(get.length > 0, 'the session poll route must be found');
  assert.match(get, /recordingAvailable: !!s\.recording_url,/, 'a re-read reflects the late recording');
});
