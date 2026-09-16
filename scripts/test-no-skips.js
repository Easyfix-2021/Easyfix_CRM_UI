#!/usr/bin/env node
/**
 * `npm test`, with a skipped test treated as a FAILURE.
 *
 * TWIN: EasyFix_Backend/scripts/test-no-skips.js. The two copies are the same
 * script and are kept in step BY HAND — change one, change the other. EasyFix
 * does not get a shared npm package for this: it is 120 dependency-free lines
 * using only node:child_process, and the repos already mirror each other the
 * crude way (each workflow git-clones the sibling into "$RUNNER_TEMP" for the
 * cross-repo tests). Only the comment text, the failure message, MIN_TESTS and
 * the backend's close-pool `--require` (it owns a DB pool; this repo's tests own
 * no handles) differ between the copies — the logic is identical, and should
 * stay identical.
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
 * runner's process, so its final flush raced `--test-force-exit`'s timed
 * process.exit(). That flag is gone now (see below), but the objection stands
 * on its own: clever, and someone decodes it at 3am.
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
 * The wrapper supplies --test; pass only the files.
 */
/*
 * ─── THE FLOOR, AND THE RUNS THAT MADE IT NECESSARY ────────────────────────
 *
 * 2026-09-16: QA deploy 27c5e57 failed this wrapper with "could not find the
 * summary lines" on a tree IDENTICAL to 9306afb, which had passed. The Actions
 * log stopped mid-TAP at `ok 663`, no `# tests`, runner exit 0.
 *
 * The cause was the `--test-force-exit` this wrapper used to pass — the same
 * flag EasyFix_Backend removed on 2026-09-04 (3d1275d); this copy was ported on
 * 09-02 and never caught up. Reproduced locally on Node 20.20.2, the exact CI
 * version, piped stdout, CI=1, 15 runs each:
 *
 *   with    --test-force-exit   `# tests` 604..693, never 709, exit 0 every time
 *   without --test-force-exit   `# tests` 709, 15/15, byte-stable output
 *
 * And locally the loss took the WORSE shape: the summary arrived, internally
 * consistent — `tests 604 · pass 604 · fail 0 · skipped 0` — with the tail tests
 * of ~13 files simply absent. That run passes every other check in this file.
 * On the runner the truncation happened to land on the summary instead, which
 * is the only reason anyone saw it.
 *
 * Unlike the backend, nothing here needed the flag: no test in this repo owns a
 * pool or timer, and all 15 unforced runs exited on their own in the same time.
 *
 * So the wrapper is told what the total should be. MIN_TESTS is a RATCHET: adding
 * tests never touches it, because the total only rises. Lower it by hand, in the
 * same commit, when tests are deliberately deleted — a suite that shrinks should
 * say so out loud.
 */
const MIN_TESTS = 709;

const { spawn } = require('node:child_process');

const child = spawn(
  process.execPath,
  // `--test-force-exit` USED TO BE HERE and is deliberately gone. It exited the
  // runner once the tests it knew about had finished, so the last results never
  // landed: either a missing summary, or a short run reporting `fail 0, skipped 0`
  // that nobody would question. Putting it back reintroduces exactly that, and
  // MIN_TESTS below is the only thing that would notice.
  ['--test', ...process.argv.slice(2)],
  // stdout piped so it can be parsed, stderr inherited. Output is written
  // through as it arrives rather than buffered, so an 18-second 240-test run
  // still scrolls live in the Actions log.
  { stdio: ['inherit', 'pipe', 'inherit'] },
);

const skippedTests = [];
const todoTests = [];
let skippedCount = null;
let todoCount = null;
let testCount = null;
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
  // tap: `# tests 709`  ·  spec: `ℹ tests 709`. Same column-0 anchor as the
  // others, so a nested subtest summary cannot overwrite the real total.
  const n = /^(?:#|ℹ) tests (\d+)\s*$/.exec(line);
  if (n) testCount = Number(n[1]);
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
  if (skippedCount === null || todoCount === null || testCount === null) {
    console.error('\ncould not find the "tests"/"skipped"/"todo" summary lines in the test output.'
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
  if (testCount < MIN_TESTS) {
    problems.push([`only ${testCount} test(s) ran; this suite has at least ${MIN_TESTS}.`,
      'Nothing failed and nothing was skipped, which is exactly what a TRUNCATED run looks',
      'like: the counters only count what the runner saw finish.',
      '',
      'DO NOT JUST RE-RUN. --test-force-exit used to make this intermittent; that flag is',
      `gone (2026-09-16) and 15 consecutive runs gave ${MIN_TESTS} every time, so a short`,
      'count here is REPRODUCIBLE and means something real.',
      '',
      'Three causes, in the order worth checking —',
      '  · tests were deliberately deleted. Then lower MIN_TESTS in this file, in the same',
      '    commit that removes them, so the suite never quietly shrinks again.',
      '  · a test file no longer exits on its own, so the runner never collected its',
      '    results. Find it with: for f in tests/*.test.js; do node --test "$f"; done',
      '    and watch for one that does not return.',
      '  · something re-introduced --test-force-exit, or another flag that exits early.',
      '',
      'Note this wrapper is meant for the whole suite; a deliberate subset run will trip it.',
    ].join('\n'));
  }
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
