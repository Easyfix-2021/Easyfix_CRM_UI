'use strict';
/*
 * Reopen Issue (2026-09-11): "there should be an option to reopen issue ticket
 * by user". Both detail surfaces offer it — the Report An Issue widget and the
 * manager's Issue Queue — on a CLOSED ticket, to its reporter or a manager,
 * which is the backend's read rule (services/issue.service.js reopenIssue; the
 * route carries no requireAction). The reason is required: an empty one is
 * refused with a toast before any request.
 *
 * Source-shape, because the suite mounts nothing. Each file's reopenIssue body
 * is sliced out and asserted on; the slice is positive-controlled (it must
 * contain the api.patch) so a renamed function fails here instead of every
 * ordering assertion passing against an empty string.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  widget: 'src/components/issue/IssueReporter.tsx',
  queue: 'src/app/(authed)/admin-actions/issues/page.tsx',
};
const SRC = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(ROOT, rel), 'utf8')]),
);

function reopenBody(src) {
  const start = src.indexOf('async function reopenIssue()');
  assert.ok(start >= 0, 'reopenIssue() must exist');
  const end = src.indexOf('\n  }\n', start);
  const body = src.slice(start, end);
  assert.ok(end > start && body.includes('api.patch('), 'slice must reach the api.patch — scanner broken, not clean');
  return body;
}

for (const [name, src] of Object.entries(SRC)) {
  test(`${name}: Reopen Issue shows only on a closed ticket, to its reporter or a manager`, () => {
    // <x>.status === 'closed' && (<x>.reported_by === <caller id> || canManage), then the button.
    assert.match(src,
      /(\w+)\.status === 'closed' && \(\1\.reported_by === (?:me\?\.user\.user_id|meId) \|\| canManage\) (?:\?|&&) \(\s*<Button[^>]*variant="outline"[^>]*onClick=\{reopenIssue\}[^>]*>[\s\S]{0,80}?Reopen Issue\s*<\/Button>/,
      'the button must sit behind status closed AND (reporter OR canManage)');
    assert.equal(src.split('onClick={reopenIssue}').length - 1, 1, 'no second, unguarded Reopen button');
  });

  test(`${name}: reopen asks for a reason, refuses an empty one, then PATCHes /reopen with reopen_note`, () => {
    const body = reopenBody(src);
    const reset = body.indexOf("reopenNoteRef.current = '';");
    const ask = body.indexOf('await confirm({');
    const guard = body.search(/if \(!reopenNote\) \{\s*showToast\(\{ variant: 'error', message: 'Tell Us What Is Still Wrong\.' \}\);\s*return;\s*\}/);
    const call = body.search(/api\.patch\(`[^`]*\/reopen`, \{ reopen_note: reopenNote \}\)/);
    assert.ok(reset >= 0 && ask > reset, 'the ref is reset FIRST, before the dialog');
    assert.match(body, /if \(!ok\) return;/, 'cancel sends nothing');
    assert.match(body, /const reopenNote = reopenNoteRef\.current\.trim\(\);/);
    assert.ok(guard > ask, 'an empty reason is refused with the toast');
    assert.ok(call > guard, 'and the PATCH comes only after that guard');
    assert.equal(body.split('api.patch(').length - 1, 1, 'exactly one request');
    assert.match(body, /title: 'Reopen This Issue\?'/);
    assert.match(body, /confirmLabel: 'Reopen Issue'/);
    assert.match(body, />What Is Still Wrong\?<\/label>/);
    assert.match(body, /<textarea[^>]*onChange=\{\(e\) => \{ reopenNoteRef\.current = e\.target\.value; \}\}[^>]*required/,
      'the textarea writes the ref and is marked required');
  });

  test(`${name}: success toasts and refreshes the way close does`, () => {
    const body = reopenBody(src);
    const after = body.slice(body.search(/api\.patch\(`[^`]*\/reopen`/));
    assert.match(after, /showToast\(\{ variant: 'success', message: 'Issue Reopened\.' \}\);/);
    assert.match(after, name === 'widget' ? /detail\.refetch\(\);\s*refreshLists\(\);/ : /refetch\(\);\s*onChanged\(\);/,
      'a mounted useFetch needs its own refetch; invalidateFetch alone does not reach it');
  });

  test(`${name}: no native dialogs — useConfirm + showToast only`, () => {
    assert.match(src, /const confirm = useConfirm\(\);/, 'positive control: confirm() is the useConfirm one');
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\b|(^|[^.\w])confirm\s*\(\s*['"`]/, 'native confirm()');
    assert.doesNotMatch(src, /(^|[^.\w])(alert|prompt)\s*\(/, 'native alert() / prompt()');
  });
}

test('queue: the dialog is handed the caller id and canManage, not a new fetch', () => {
  assert.match(SRC.queue, /<IssueDetailDialog[^>]*meId=\{me\?\.user\.user_id\}\s*canManage=\{canManage\}/);
  assert.doesNotMatch(SRC.queue, /It cannot be re-opened/, 'the close dialog must not promise a dead end any more');
});
