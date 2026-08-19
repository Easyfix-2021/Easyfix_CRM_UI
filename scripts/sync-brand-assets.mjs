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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

if (!existsSync(KIT)) {
  console.error(`Brand kit not found at ${KIT}`);
  console.error('Set EASYFIX_BRAND_KIT to its path, or clone/generate the kit first.');
  console.error('Vendored assets are committed, so this is only needed to RE-sync.');
  process.exit(check ? 0 : 1); // --check must not fail CI, where the kit is absent
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
  console.log(`brand:sync — ${jobs.length} assets checked, ${changed} updated`);
}
