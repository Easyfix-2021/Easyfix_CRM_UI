#!/usr/bin/env node
/**
 * `npm test`, with a skipped test treated as a FAILURE.
 *
 * TWIN: EasyFix_Backend/scripts/test-no-skips.js. The two copies are the same
 * script and are kept in step BY HAND — change one, change the other. EasyFix
 * does not get a shared npm package for this: it is 120 dependency-free lines
 * using only node:child_process, and the repos already mirror each other the
 * crude way (each workflow git-clones the sibling into "$RUNNER_TEMP" for the
 * cross-repo tests). Only the comment text and the failure message differ
 * between the copies — the logic is identical, and should stay identical.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `node --test` EXITS 0 WHEN TESTS ARE SKIPPED. Measured here, not recalled —
 * a two-test probe (1 pass, 1 `t.skip`) exits 0 under every built-in reporter
 * (tap, spec, dot, junit, lcov) on both node versions on this machine, and
 * there is no `--fail-on-skip` flag. So a skip is invisible to any exit-code
 * gate. A skipped test is a guard that is not running.
 *
 * This repo has two tests that can skip, both cross-repo, both reading files
 * out of EasyFix_Backend:
 *
 *   tests/message-literals.test.js  → scripts/audit-message-literals.mjs
 *   tests/wire-contract.test.js     → shared/wire-contract.json
 *
 * Both are already repaired: the workflows clone the backend into
 * "$RUNNER_TEMP" and set EASYFIX_BACKEND_DIR, and both tests `assert.fail()`
 * under `process.env.CI` before they reach `t.skip`, so skipped==0 in CI is
 * true by construction today (measured: `npm test` → 240 pass, 0 skipped).
 * THIS wrapper is the ratchet, not the repair. It catches the NEXT `t.skip`
 * somebody adds — most likely one added without the `if (process.env.CI)`
 * guard, at which point CI goes green on a guard that never ran. It also makes
 * a local run match CI, which it does not today: on a developer machine with
 * no sibling checkout both tests skip and `npm test` still exits 0.
 *
 * ─── WHY A WRAPPER AND NOT SOMETHING CLEVERER ──────────────────────────────
 *
 * Every other gate in this repo is `node scripts/<name>.js` — gen-brand-css,
 * check-brand-roundtrip, check-brand-tokens, sync-brand-assets, env-verify —
 * and `npm test` already chains the first three ahead of the runner. This is
 * the house style, not a new idea.
 *
 * Rejected: piping to grep. npm runs scripts under `sh`, which on the Ubuntu
 * runner is dash, and dash has no `set -o pipefail` — the pipe would mask the
 * runner's own exit code, so a genuinely FAILING suite would go green.
 *
 * Rejected: a custom reporter setting process.exitCode. It runs inside the
 * runner's process, and `--test-force-exit` calls process.exit() on a timer, so
 * whether the reporter's final flush lands first is a race. Clever, and someone
 * decodes it at 3am.
 *
 * ─── THE PARSE, AND WHY IT MATCHES TWO FORMATS ─────────────────────────────
 *
 * Node picks its default reporter BY VERSION, and this is the trap. Same probe
 * suite, same non-TTY pipe, both measured on this machine:
 *
 *   Node v22.16.0  →  tap:   `ok 2 - skips # SKIP reason`     /  `# skipped 1`
 *   Node v24.3.0   →  spec:  `﹣ skips (0.066417ms) # reason`  /  `ℹ skipped 1`
 *
 * The workflows pin `node-version: 20` and this machine has 22 and 24, so local
 * and CI are on different majors and Node 20 could not be measured here. Rather
 * than assume one format — or pin `--test-reporter` and change what every CI log
 * looks like — both sigils are matched. That is strictly less work than being
 * wrong on the runner.
 *
 * A missing summary line is a FAILURE, not a pass: a checker that cannot see
 * anything must not report clean.
 *
 * Usage (from package.json):  node scripts/test-no-skips.js tests/*.test.js
 * The wrapper supplies --test and --test-force-exit; pass only the files.
 */
const { spawn } = require('node:child_process');

const child = spawn(
  process.execPath,
  ['--test', '--test-force-exit', ...process.argv.slice(2)],
  // stdout piped so it can be parsed, stderr inherited. Output is written
  // through as it arrives rather than buffered, so an 18-second 240-test run
  // still scrolls live in the Actions log.
  { stdio: ['inherit', 'pipe', 'inherit'] },
);

const skippedTests = [];
const todoTests = [];
let skippedCount = null;
let todoCount = null;
let partial = '';

// The whole stream is scanned line by line rather than a trailing buffer: the
// skip lines are printed as each test finishes, far above the summary, so a
// tail-only parse would report the count and none of the names.
function scan(line) {
  // tap: `ok 4 - name # SKIP reason`   ·   spec: `﹣ name (0.06ms) # reason`
  // The raw line is kept verbatim rather than picking the name out of it — the
  // line already carries the skip REASON, which is the actionable half.
  if (/^ok \d+ - .* # SKIP\b/.test(line) || /^\s*﹣ /.test(line)) skippedTests.push(line.trim());
  // `test.todo()` is the same defect wearing a different word: a guard that is
  // not running. tap: `ok 2 - name # TODO`  ·  spec: `✔ name (0.05ms) # TODO`.
  if (/\s# TODO\b/.test(line)) todoTests.push(line.trim());
  // tap: `# skipped 2`   ·   spec: `ℹ skipped 2`. Anchored at column 0 so a
  // nested TAP subtest summary (indented) cannot overwrite the real total.
  const m = /^(?:#|ℹ) skipped (\d+)\s*$/.exec(line);
  if (m) skippedCount = Number(m[1]);
  const t = /^(?:#|ℹ) todo (\d+)\s*$/.exec(line);
  if (t) todoCount = Number(t[1]);
}

child.stdout.on('data', (buf) => {
  process.stdout.write(buf);
  const lines = (partial + buf).split('\n');
  partial = lines.pop();
  for (const line of lines) scan(line);
});

child.on('close', (code, signal) => {
  if (partial) scan(partial);
  // 'close' fires only after the stdio streams have closed, so every data
  // event has already been scanned by this point.
  if (signal) {
    console.error(`\ntest runner was killed by ${signal}`);
    process.exit(1);
  }
  // A real test failure is reported by the runner and passed straight through —
  // this wrapper never masks it, and never adds noise on top of it.
  if (code !== 0) process.exit(code);
  if (skippedCount === null || todoCount === null) {
    console.error('\ncould not find the "skipped"/"todo" summary lines in the test output.'
      + '\nThe runner exited 0, but this wrapper cannot confirm zero skips, so it fails'
      + '\nrather than reporting a clean it did not verify. Has the reporter format changed?');
    process.exit(1);
  }

  /*
   * THE COUNTER IS NOT ENOUGH — measured 2026-09-02, and the reason these are
   * not simply `skippedCount > 0`.
   *
   *   describe.skip('name', () => { test('never runs', ...) })
   *     ﹣ name (0.24ms) # SKIP
   *     ℹ tests 0 · ℹ suites 1 · ℹ skipped 0        <- the counter says ZERO
   *
   * Node does not count a skipped SUITE's inner tests at all, so an entirely
   * disabled file reported `skipped 0` and this wrapper exited 0 — the exact
   * defect it exists to prevent, living inside it. The `# SKIP` line was already
   * collected and was then discarded by an early `if (count === 0) return`.
   *
   *   test.todo('a guard nobody wrote yet')
   *     ✔ a guard nobody wrote yet (0.05ms) # TODO
   *     ℹ skipped 0 · ℹ todo 1                      <- passes a skip-only gate
   *
   * A todo is a guard that is not running under a friendlier name, so it fails
   * here too. Reported separately, because the fix differs: a skip usually means
   * an unmet precondition, a todo means unwritten work.
   */
  const problems = [];
  if (skippedCount > 0 || skippedTests.length > 0) {
    problems.push([`${Math.max(skippedCount, skippedTests.length)} test(s) or suite(s) SKIPPED.`,
      'A skipped test is a guard that is not running, so this is a failure. Either make',
      'it able to run here, or delete it — for the cross-repo parity tests that means the',
      'workflow must clone EasyFix_Backend into "$RUNNER_TEMP" and set EASYFIX_BACKEND_DIR.',
      ...skippedTests.map((l) => `  ${l}`)].join('\n'));
  }
  if (todoCount > 0 || todoTests.length > 0) {
    problems.push([`${Math.max(todoCount, todoTests.length)} test(s) marked TODO.`,
      'A todo test never runs and never fails, so it protects nothing. Write it or drop it.',
      ...todoTests.map((l) => `  ${l}`)].join('\n'));
  }
  if (problems.length === 0) return;
  console.error(`\n${problems.join('\n\n')}\n`);
  process.exit(1);
});
