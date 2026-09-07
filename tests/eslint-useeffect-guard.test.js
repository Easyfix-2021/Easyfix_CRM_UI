'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

/*
 * The house rule "never call api.<verb> inside useEffect — use src/lib/hooks"
 * is enforced by a no-restricted-syntax selector in eslint.config.mjs.
 *
 * WHAT WENT WRONG (found 2026-09-07)
 *
 * The selector was `CallExpression[callee.name="useEffect"]`. `callee.name`
 * exists only when the callee is an Identifier, so `React.useEffect(...)` — a
 * MemberExpression callee — could never match it. 117 call sites in src/ use
 * that spelling, so the project's headline rule was unenforced across a large
 * part of the codebase while `eslint --max-warnings=0` reported clean.
 *
 * WHY A TEST AND NOT JUST A WIDER SELECTOR
 *
 * A selector that cannot match and a codebase with nothing to report produce
 * the SAME output: silence. Nothing in a green lint run distinguishes them, so
 * the gap was invisible for as long as it existed and would be invisible again
 * the next time someone edits the selector. The only way to tell the two apart
 * is to feed the rule something it MUST reject and check that it does.
 *
 * So these tests do not assert the codebase is clean — `npm run lint` already
 * does that, and that assertion is exactly the one that stayed green while the
 * rule was broken. They assert the rule FIRES, on every spelling, and stays
 * quiet on an effect that loads nothing.
 */

const ROOT = path.join(__dirname, '..');

// Real ESLint, real config. Anything less would test a paraphrase of the rule.
async function lint(source) {
  const { ESLint } = require(path.join(ROOT, 'node_modules', 'eslint'));
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(source, {
    // Must sit under src/ so the config's file patterns apply. The file is
    // never written to disk — lintText takes the text directly.
    filePath: path.join(ROOT, 'src', 'app', '(authed)', '__guard_probe__.tsx'),
  });
  return (result.messages || [])
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
}

const wrap = (body) => `import * as React from 'react';
import { useEffect, useLayoutEffect } from 'react';
import { api } from '@/lib/api';
export default function Probe() {
  ${body}
  return null;
}
`;

test('the guard fires on the bare useEffect spelling', async () => {
  const hits = await lint(wrap("useEffect(() => { void api.get('/x'); }, []);"));
  assert.equal(hits.length, 1, 'expected exactly one no-restricted-syntax report');
  assert.match(hits[0], /Don't call `api\.<verb>` inside `useEffect`/);
});

test('the guard fires on the React.useEffect spelling — the gap this closes', async () => {
  /*
   * The regression test proper. Before 2026-09-07 this returned zero reports
   * and `eslint --max-warnings=0` exited 0 on the identical violation.
   */
  const hits = await lint(wrap("React.useEffect(() => { void api.get('/x'); }, []);"));
  assert.equal(hits.length, 1, 'React.useEffect must be caught, not only the bare identifier');
  assert.match(hits[0], /Don't call `api\.<verb>` inside `useEffect`/);
});

test('useLayoutEffect is covered too, in both spellings', async () => {
  /*
   * Included because the rule's whole premise — Strict Mode mounts effects
   * twice in dev — applies to useLayoutEffect identically. A data load written
   * there doubles exactly as one written in useEffect, so exempting it would
   * leave a second, quieter version of the same gap.
   */
  for (const call of ['useLayoutEffect', 'React.useLayoutEffect']) {
    const hits = await lint(wrap(`${call}(() => { void api.get('/x'); }, []);`));
    assert.equal(hits.length, 1, `${call} must be caught`);
  }
});

test('the fetch() sibling guard covers both spellings as well', async () => {
  for (const call of ['useEffect', 'React.useEffect']) {
    const hits = await lint(`import * as React from 'react';
import { useEffect } from 'react';
export default function Probe() {
  ${call}(() => { void fetch('/x'); }, []);
  return null;
}
`);
    assert.equal(hits.length, 1, `fetch() inside ${call} must be caught`);
    assert.match(hits[0], /Don't call `fetch\(\)` directly inside `useEffect`/);
  }
});

test('negative control — an effect that loads nothing is left alone', async () => {
  /*
   * Without this, a selector broadened to match EVERY effect would pass every
   * assertion above. "Fires on the violation" is only half the contract; the
   * other half is "stays silent otherwise", and a guard that reports
   * everything gets disabled wholesale within a week.
   */
  for (const call of ['useEffect', 'React.useEffect', 'React.useLayoutEffect']) {
    const hits = await lint(wrap(`${call}(() => { document.title = 'x'; }, []);`));
    assert.deepEqual(hits, [], `${call} with no data call must not be reported`);
  }
});

test('the selector covers member-expression callees structurally', async () => {
  /*
   * Belt and braces on the config itself, so a future edit that drops the
   * member-expression arm fails here with a pointed message rather than only
   * as a mysterious absence in the behavioural tests above.
   */
  const fs = require('fs');
  const config = fs.readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8');
  const codeOnly = config
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    codeOnly,
    /callee\.property\.name=\/\^\(useEffect\|useLayoutEffect\)\$\//,
    'the member-expression arm (React.useEffect) must remain in the selector',
  );
  assert.match(
    codeOnly,
    /callee\.name=\/\^\(useEffect\|useLayoutEffect\)\$\//,
    'the identifier arm (bare useEffect) must remain in the selector',
  );
});
