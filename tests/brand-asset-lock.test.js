'use strict';

/*
 * brand:sync --check, in the mode that actually runs in CI.
 *
 * ─── THE FALSE PASS THIS PINS ──────────────────────────────────────────────
 *
 * The vendored brand assets are verified two different ways, and the two check
 * DIFFERENT SETS:
 *
 *   kit present (a developer's laptop)  loops `jobs`        — the CONTRACT
 *   kit absent  (CI, the Docker build)  loops lock.assets   — the RECORD
 *
 * Only the second one runs where the build is produced. A record can only ever
 * answer "is what I wrote down still true"; it structurally cannot see a file
 * that was never written down. So the state left by adding a variant to
 * LOGO_SVGS and not re-running `brand:sync` — asset absent, lock entry absent —
 * passed, printing "18 assets match". The count came from the same wrong set,
 * so the false pass advertised itself exactly as confidently as a real one,
 * while the file Logo.tsx renders 404'd in the production image.
 *
 * ─── WHY IT RUNS IN A THROWAWAY TREE ───────────────────────────────────────
 *
 * The script resolves its own root from `import.meta.url`, so it cannot be
 * pointed at a fixture directory. A copy of it in a temp tree IS the real
 * script — same bytes, copied at test time — and it means this test never
 * mutates public/ or the committed lockfile. `node --test` runs test FILES in
 * parallel; a test that perturbs the real tree to watch a gate react would race
 * anything else reading it, and would leave the repo dirty if it threw.
 *
 * The fixture kit is bootstrapped FROM THE SCRIPT'S OWN missing-asset report,
 * so the eight-plus-eleven filenames are never restated here. Restating them
 * would give this test its own copy of the contract, which is the one thing it
 * must not have.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(__dirname, '..', 'scripts', 'sync-brand-assets.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-lock-'));
const SCRIPT = path.join(tmp, 'scripts', 'sync-brand-assets.mjs');
const LOCK = path.join(tmp, 'brand-assets.lock.json');
const KIT = path.join(tmp, 'kit');
const NO_KIT = path.join(tmp, 'no-such-kit');

fs.mkdirSync(path.dirname(SCRIPT), { recursive: true });
fs.copyFileSync(REAL, SCRIPT);
fs.mkdirSync(KIT, { recursive: true });

/** Run the copied script; never throws, always reports code + combined output. */
function run(args, kit) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, EASYFIX_BRAND_KIT: kit },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// ── bootstrap: let the script itself name every file it requires ────────────
const report = run([], KIT);
assert.equal(report.code, 1, 'an empty kit must fail, listing what it wanted');
const wanted = report.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(KIT));
assert.ok(wanted.length >= 8, `expected the script to name its assets, got:\n${report.out}`);
for (const [i, f] of wanted.entries()) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `fixture asset ${i}\n`); // distinct bytes, so a swap would show
}

const synced = run([], KIT);
assert.equal(synced.code, 0, `sync should now succeed:\n${synced.out}`);

const pristine = fs.readFileSync(LOCK, 'utf8');
const lockOf = () => JSON.parse(fs.readFileSync(LOCK, 'utf8'));
/*
 * One line, because a full sync already does everything: it re-copies any file
 * a test deleted or edited, and rewrites the lock WHOLESALE from the vendored
 * copies — which also drops an orphan key a test added.
 */
const restore = () => run([], KIT);

test('positive control — an untouched vendored set passes with no kit', () => {
  restore();
  const r = run(['--check'], NO_KIT);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kit absent/, 'and it must say it could not re-compare bytes');
});

test('an asset declared in the script but never synced FAILS, and is named', () => {
  restore();
  const rel = Object.keys(lockOf().assets)[0];

  // Exactly the state left by adding a variant to LOGO_SVGS and not re-syncing:
  // the file is not vendored, and nothing recorded that it should have been.
  fs.rmSync(path.join(tmp, rel));
  const lock = lockOf();
  delete lock.assets[rel];
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);

  const r = run(['--check'], NO_KIT);
  assert.notEqual(r.code, 0, `a missing declared asset must fail, got:\n${r.out}`);
  assert.ok(r.out.includes(rel), `and must name it (${rel}):\n${r.out}`);
});

test('a hand-edited vendored asset FAILS', () => {
  restore();
  const rel = Object.keys(lockOf().assets)[0];
  fs.appendFileSync(path.join(tmp, rel), 'hand edit\n');

  const r = run(['--check'], NO_KIT);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /sha256/, 'and must name the content mismatch');
});

test('a lock entry nothing declares FAILS — an orphan nobody tracks', () => {
  restore();
  const lock = lockOf();
  lock.assets['public/brand/retired-variant.svg'] = 'f'.repeat(64);
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);

  const r = run(['--check'], NO_KIT);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('retired-variant.svg'), r.out);
});

test('no lock and no kit is a failure, not a pass', () => {
  restore();
  fs.rmSync(LOCK);
  const r = run(['--check'], NO_KIT);
  assert.notEqual(r.code, 0, 'nothing to check against must never exit 0');
  fs.writeFileSync(LOCK, pristine);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
