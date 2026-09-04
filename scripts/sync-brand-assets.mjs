/**
 * Re-vendor the brand assets this app actually uses, from the EasyFix Brand Kit.
 *
 *   npm run brand:sync           copy from the kit into public/
 *   npm run brand:sync -- --check verify the vendored copies match the kit
 *
 * WHY THE ASSETS ARE VENDORED AT ALL
 *
 * The kit lives OUTSIDE this repo (~/Documents/GitHub/EasyFix-Brand-Kit) and is
 * not a git repo, so it can be neither a submodule nor an npm git dependency.
 * The Dockerfile builds with `COPY . .` from the repo root, so anything outside
 * this directory is not in the build context: a symlink or a relative path
 * resolves fine on a laptop and produces a 404 in the production image.
 *
 * WHY ONLY EIGHT FILES
 *
 * The kit ships 40 SVGs per surface. `Logo.tsx` references eight of them. The
 * first pass copied all 40, which is 32 files that no longer track the kit, that
 * nobody can tell are unused, and that a future reader has to assume are load-
 * bearing. The list below IS the contract — if Logo.tsx gains a variant, add it
 * here and re-run, rather than copying the directory again.
 *
 * `--check` exists so CI can catch a vendored asset that was hand-edited or
 * left behind when the kit was regenerated.
 *
 * ⚠ AND IT USED TO PASS WHEN IT COULD NOT CHECK ANYTHING.
 *
 * The kit is absent in CI — that is the whole reason these files are vendored
 * — and `--check` exited 0 on a missing kit so it would not fail the build.
 * Which made it a no-op exactly where it was meant to run: the one environment
 * that could not verify was the only one that ever did.
 *
 * So `brand:sync` now writes brand-assets.lock.json, a sha256 per vendored
 * file plus the kit commit it came from, and `--check` falls back to that when
 * the kit is missing. With the kit it still compares real bytes; without it,
 * it compares against the recorded hashes. A hand-edited asset now fails in
 * CI, which is where hand-edited assets are actually discovered.
 *
 * What the lockfile cannot catch is the kit moving on without a re-sync — no
 * local file changes, so no hash changes. It records the kit commit so the
 * staleness is at least legible; catching it needs the kit present, i.e. a
 * developer running `npm run brand:sync -- --check` before pushing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = process.env.EASYFIX_BRAND_KIT
  || join(homedir(), 'Documents/GitHub/EasyFix-Brand-Kit');

/*
 * The eight lockup variants Logo.tsx can render: four shapes x {onlight,ondark},
 * except `mark`, which is a single silhouette and so takes the solid red / white
 * files rather than a two-ink pair.
 */
const LOGO_SVGS = [
  'logo-tagline-onlight.svg',
  'logo-tagline-ondark.svg',
  'logo-horizontal-onlight.svg',
  'logo-horizontal-ondark.svg',
  'wordmark-onlight.svg',
  'wordmark-ondark.svg',
  // Square TILES, 1024x1024, for icon-shaped slots. They replaced the bare
  // `mark-*` silhouette the kit dropped on 2026-08-18: the white tile reads on
  // a dark ground, the red tile on a light one.
  'icon-rounded.svg',
  'icon-rounded-red.svg',
];


/* The favicon/OG set, which replaced a 1054x276 wordmark served as a tab icon. */
const WEB_ASSETS = [
  'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png',
  'favicon-64.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'icon-maskable-192.png', 'icon-maskable-512.png', 'og-image.png',
];

const jobs = [
  ...LOGO_SVGS.map((f) => ({ from: join(KIT, 'apps/crm/svg', f), to: join(root, 'public/brand', f) })),
  ...WEB_ASSETS.map((f) => ({ from: join(KIT, 'apps/crm/web', f), to: join(root, 'public', f) })),
];

const check = process.argv.includes('--check');
const LOCK = join(root, 'brand-assets.lock.json');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const relOf = (p) => p.replace(root + '/', '');

if (!existsSync(KIT)) {
  /*
   * No kit — the CI case. Verify against the committed hashes instead of
   * exiting 0 and calling that a pass.
   */
  if (!check) {
    console.error(`Brand kit not found at ${KIT}`);
    console.error('Set EASYFIX_BRAND_KIT to its path, or clone/generate the kit first.');
    console.error('Vendored assets are committed, so this is only needed to RE-sync.');
    process.exit(1);
  }
  if (!existsSync(LOCK)) {
    console.error(`No kit at ${KIT} and no ${relOf(LOCK)} to check against.`);
    console.error('Run `npm run brand:sync` on a machine that has the kit.');
    process.exit(1);
  }
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  const bad = [];

  /*
   * ⚠ ITERATE `jobs`, NOT THE LOCK'S KEYS.
   *
   * The lock is a RECORD of what was synced; `jobs` is the CONTRACT — the files
   * Logo.tsx and the manifest actually reference. Looping the record can only
   * ever prove "what I wrote down is still true", and it structurally cannot
   * see an asset that was never written down.
   *
   * Measured 2026-09-04, against the previous `Object.entries(lock.assets)`
   * loop: deleting a vendored SVG *and* its lock entry — the exact state left
   * by adding a variant to LOGO_SVGS and not re-running `brand:sync` — exited
   * 0 and printed "18 assets match". The count came from the same wrong set, so
   * the false pass read as thoroughly as a real one, and the file Logo.tsx
   * renders would have 404'd in the production image.
   *
   * With no kit there is nothing else that could answer, so an asset the lock
   * does not mention is UNKNOWN — and unknown means fail, never skip.
   */
  for (const { to } of jobs) {
    const rel = relOf(to);
    const want = lock.assets[rel];
    if (!want) { bad.push(`${rel} — declared in this script but absent from the lock; never synced`); continue; }
    if (!existsSync(to)) { bad.push(`${rel} — missing`); continue; }
    const got = sha(readFileSync(to));
    if (got !== want) bad.push(`${rel} — sha256 ${got.slice(0, 12)}, expected ${want.slice(0, 12)}`);
  }

  /*
   * And the other direction. A lock entry no job declares is a vendored file
   * that no longer tracks the kit and that nobody can tell is unused — the
   * 32-orphan problem the eight-file list at the top exists to prevent.
   */
  const declared = new Set(jobs.map(({ to }) => relOf(to)));
  for (const rel of Object.keys(lock.assets)) {
    if (!declared.has(rel)) bad.push(`${rel} — in the lock but no longer declared here; re-run \`npm run brand:sync\``);
  }

  if (bad.length) {
    console.error(`${bad.length} vendored asset(s) do not match ${relOf(LOCK)}:`);
    for (const b of bad) console.error(`  ${b}`);
    console.error('Either a brand asset was edited in place, or the vendored set and the');
    console.error('lock have diverged. Re-sync from the kit rather than editing either.');
    process.exit(1);
  }
  console.log(`brand:sync --check — all ${jobs.length} declared assets match `
    + `${relOf(LOCK)} (kit ${lock.kitCommit || 'unknown'}); kit absent, bytes not re-compared`);
  process.exit(0);
}

mkdirSync(join(root, 'public/brand'), { recursive: true });

let changed = 0;
const missing = [];
const drifted = [];

for (const { from, to } of jobs) {
  if (!existsSync(from)) { missing.push(from); continue; }
  const src = readFileSync(from);
  const cur = existsSync(to) ? readFileSync(to) : null;
  if (cur && src.equals(cur)) continue;
  if (check) { drifted.push(to.replace(root + '/', '')); continue; }
  writeFileSync(to, src);
  changed += 1;
}

if (missing.length) {
  console.error(`${missing.length} asset(s) missing from the kit:`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

if (check) {
  if (drifted.length) {
    console.error(`${drifted.length} vendored asset(s) differ from the kit — run \`npm run brand:sync\`:`);
    for (const d of drifted) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(`brand:sync --check — all ${jobs.length} vendored assets match the kit`);
} else {
  /*
   * The lockfile is written from the VENDORED copies, not the kit's, so it
   * records what this repo will actually serve. Identical by construction here,
   * and the distinction matters the day a copy fails silently.
   */
  const assets = {};
  for (const { to } of jobs) if (existsSync(to)) assets[relOf(to)] = sha(readFileSync(to));
  let kitCommit = null;
  try {
    kitCommit = execFileSync('git', ['-C', KIT, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8' }).trim();
  } catch { /* the kit need not be a git checkout */ }
  writeFileSync(LOCK, JSON.stringify({
    note: 'Generated by scripts/sync-brand-assets.mjs. Do not hand-edit; run `npm run brand:sync`.',
    kitCommit, assets,
  }, null, 2) + '\n');
  console.log(`brand:sync — ${jobs.length} assets checked, ${changed} updated, `
    + `${relOf(LOCK)} written (kit ${kitCommit || 'unknown'})`);
}
