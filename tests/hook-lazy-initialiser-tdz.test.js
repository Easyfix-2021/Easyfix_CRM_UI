'use strict';
/*
 * A lazy state initialiser may not reference a hook result declared below it.
 *
 * ─── THE OUTAGE THIS ENCODES (2026-09-09) ──────────────────────────────────
 *
 * /quicksight/performance rendered nothing but Next's
 * "Application error: a client-side exception has occurred". Cause:
 *
 *     const [period, setPeriod] = useState(
 *       () => reportPeriodFromParams((k) => searchParams.get(k)),   // line 143
 *     );
 *     ...
 *     const searchParams = useSearchParams();                        // line 156
 *
 * React invokes a useState lazy initialiser SYNCHRONOUSLY during the first
 * render, at which point the `const` twelve lines below is still in its
 * temporal dead zone. Every first mount threw
 * `ReferenceError: Cannot access 'searchParams' before initialization`.
 * Both the Client and City report bodies had it, so the Client tab — the
 * default landing tab of the 5-tab Performance Report — was dead, and so were
 * the two standalone routes.
 *
 * ─── WHY A TEST, WHEN THE PROJECT ALREADY HAS FOUR GATES ───────────────────
 *
 * Because all four were structurally blind to it, and stayed green:
 *
 *   typecheck  ts(2448) "used before its declaration" fires only on a DIRECT
 *              reference. Inside a closure TypeScript cannot know when the
 *              closure runs, so it says nothing.
 *   lint       eslint's no-use-before-define permits references from nested
 *              functions by default, for exactly the same reason.
 *   build      `next build` CSR-bails any client component calling
 *              useSearchParams, so the component is NEVER rendered at build
 *              time. A build cannot fail on a render that does not happen.
 *   tests      the suite is source/contract assertions; nothing mounts a
 *              component.
 *
 * The defect is therefore invisible to every automated check the repo has and
 * visible instantly to anyone who opens the page — the worst quadrant. It sat
 * in main from 2026-09-07 and reached users on 2026-09-09 only because an
 * unrelated commit unblocked deploys.
 *
 * This test is deliberately a cheap ORDERING check rather than a render:
 * adding a React renderer to a node:test suite is a large change, and ordering
 * is the whole of the defect. It runs on every .tsx in the app.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Lazy-initialiser hooks: their first argument runs during render. */
const LAZY_HOOKS = ['useState', 'useReducer'];

function tsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Find `const <name> = use<Something>(` declarations — component-scoped hook
 * results, which is the class that can sit in a TDZ during render.
 */
function hookDeclarations(lines) {
  const decls = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(use[A-Z][\w$]*)\s*\(/);
    if (m) decls.set(m[1], { line: i, hook: m[2] });
  });
  return decls;
}

/**
 * Line ranges of lazy-initialiser calls: from `useState(` / `useReducer(` to
 * the line whose bracket depth returns to zero. Only calls whose first
 * argument is an arrow function count — a plain literal cannot reference
 * anything.
 */
function lazyInitialiserRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i += 1) {
    const hook = LAZY_HOOKS.find((h) => new RegExp(`\\b${h}\\s*(?:<[^>]*>)?\\s*\\(`).test(lines[i]));
    if (!hook) continue;
    // The arrow may be on this line or the next (prettier wraps long calls).
    const head = (lines[i] + '\n' + (lines[i + 1] || ''));
    if (!/=>/.test(head)) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length && j < i + 40; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '(') { depth += 1; started = true; }
        else if (ch === ')') depth -= 1;
      }
      if (started && depth <= 0) { ranges.push([i, j, hook]); break; }
    }
  }
  return ranges;
}

test('no lazy state initialiser reads a hook result declared below it', () => {
  const offenders = [];
  let filesScanned = 0;
  let initialisersScanned = 0;

  for (const file of tsxFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!LAZY_HOOKS.some((h) => src.includes(`${h}(`) || src.includes(`${h}<`))) continue;
    filesScanned += 1;

    const lines = src.split('\n');
    const decls = hookDeclarations(lines);
    if (!decls.size) continue;

    for (const [start, end, hook] of lazyInitialiserRanges(lines)) {
      initialisersScanned += 1;
      const body = lines.slice(start, end + 1).join('\n');
      for (const [name, decl] of decls) {
        if (decl.line <= end) continue;                       // declared above/inside: fine
        if (!new RegExp(`\\b${name}\\b`).test(body)) continue; // not referenced
        offenders.push(
          `${path.relative(ROOT, file)}: ${hook} initialiser at line ${start + 1} reads `
          + `\`${name}\`, but \`const ${name} = ${decl.hook}()\` is at line ${decl.line + 1}. `
          + 'The initialiser runs synchronously during the first render, so this throws '
          + `ReferenceError: Cannot access '${name}' before initialization. Move the `
          + 'declaration above the initialiser.',
        );
      }
    }
  }

  /*
   * Guard the guard. A scanner whose file walk or bracket matching silently
   * broke would report zero offenders and look identical to a clean repo —
   * the failure mode where a green check means nothing was examined.
   */
  assert.ok(filesScanned > 20, `only ${filesScanned} files scanned — the walk is broken`);
  assert.ok(initialisersScanned > 10,
    `only ${initialisersScanned} lazy initialisers found — the matcher is broken, so a clean `
    + 'result would be vacuous');

  assert.deepEqual(offenders, [], `\n${offenders.join('\n\n')}\n`);
});

test('the two reports that carried the outage declare searchParams first', () => {
  /*
   * The specific regression, pinned by file. The general test above would also
   * catch it, but this one names the two components and fails with the outage
   * in the message — so a future reader who reintroduces it learns what broke
   * rather than only which rule fired.
   */
  for (const rel of [
    'src/app/(authed)/quicksight/client-performance/ClientPerformanceBody.tsx',
    'src/app/(authed)/quicksight/city-performance/CityPerformanceBody.tsx',
  ]) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    const decl = lines.findIndex((l) => /const searchParams = useSearchParams\(\)/.test(l));
    const use = lines.findIndex((l) => /searchParams\.(get|getAll)\(/.test(l));
    assert.ok(decl >= 0, `${rel}: expected a useSearchParams() declaration`);
    assert.ok(use >= 0, `${rel}: expected a searchParams read`);
    assert.ok(decl < use,
      `${rel}: searchParams is declared at line ${decl + 1} but read at line ${use + 1}. `
      + 'This is the 2026-09-09 outage: the read happens inside a useState lazy initialiser, '
      + 'which React runs during the first render while the const is still in its temporal '
      + 'dead zone — the whole page renders "Application error" instead.');
  }
});

/* ─── the blast radius, not just the fault ─────────────────────────────── */

test('the authed route group keeps an error boundary', () => {
  /*
   * The TDZ bug took down the WHOLE page — sidebar, navbar, every other tab —
   * because there was no error.tsx anywhere under src/app, so one component's
   * throw reached Next's root fallback and replaced the entire document.
   *
   * The boundary at (authed)/error.tsx is what makes the next render fault a
   * broken panel instead of a broken CRM: it replaces only what the layout
   * renders into <main>, leaving navigation usable. Deleting it, or dropping
   * its 'use client' directive (an error boundary MUST be a client component —
   * without the directive Next fails the build, but a future refactor that
   * moves the file could lose it quietly), restores the outage's blast radius
   * without breaking anything a reviewer would notice.
   */
  const p = path.join(ROOT, 'src/app/(authed)/error.tsx');
  assert.ok(fs.existsSync(p),
    'src/app/(authed)/error.tsx is missing — without it a single component throwing '
    + 'blanks every authenticated screen, which is exactly what happened on 2026-09-09');

  const src = fs.readFileSync(p, 'utf8');
  assert.match(src.split('\n').slice(0, 3).join('\n'), /^'use client'/,
    "an error boundary must be a client component — 'use client' must be the first statement");
  assert.match(src, /export default function/, 'Next requires a default export');
  assert.match(src, /\breset\b/, 'the boundary must offer reset() — otherwise the panel is a dead end');
  assert.match(src, /digest/,
    'the boundary must surface error.digest: production bundles are minified, so the digest is '
    + 'the only handle tying what a user saw to what the logs recorded');
});
