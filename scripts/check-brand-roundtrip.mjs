/**
 * Prove every generated token still equals the brand hex it came from.
 *
 * WHY THIS EXISTS
 *
 * brand.css stores HSL triplets, the identity document states hex, and a
 * conversion sits between them. That conversion is lossy if the precision is
 * wrong: rounding to whole degrees — which is Tailwind's own house style and
 * the obvious thing to do — silently turns brand red #C42430 into #C2242E and
 * gold #C99A2E into #C8992D. Nothing errors. The app just quietly renders a
 * colour that is not the brand's.
 *
 * So this converts every token back and asserts equality with palette.ts. It is
 * the only thing standing between "we use tokens" and "our tokens are correct".
 *
 *   npm run brand:roundtrip
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function hslToHex(h, s, l) {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`.toUpperCase();
}

const paletteSrc = readFileSync(join(root, 'src/brand/palette.ts'), 'utf8');
const tokensSrc = readFileSync(join(root, 'src/brand/tokens.ts'), 'utf8');
const css = readFileSync(join(root, 'src/app/brand.css'), 'utf8');

/* palette key -> hex, straight off the source of truth. */
const palette = {};
for (const m of paletteSrc.matchAll(/^\s{2}(\w+):\s*'(#[0-9A-Fa-f]{6})'/gm)) {
  palette[m[1]] = m[2].toUpperCase();
}

/*
 * Only the :root block, and only the `light` map that produced it.
 *
 * Both halves of that pairing matter. tokens.ts defines the same token names
 * twice — once per mode — so a scan of the whole file pairs every light token
 * with the DARK map's value and reports 37 phantom mismatches. Slice to the
 * light map, compare against :root, and the check means what it says.
 */
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('.dark'));
const lightMap = tokensSrc.slice(
  tokensSrc.indexOf('const light'),
  tokensSrc.indexOf('const dark'),
);

let checked = 0;
const failures = [];

for (const m of lightMap.matchAll(/^\s{2}'?([\w-]+)'?:\s*p\.(\w+),/gm)) {
  const [, token, paletteKey] = m;
  const expected = palette[paletteKey];
  if (!expected) continue;
  const hit = new RegExp(`--${token}: ([\\d.]+) ([\\d.]+)% ([\\d.]+)%`).exec(rootBlock);
  if (!hit) continue;
  const got = hslToHex(Number(hit[1]), Number(hit[2]), Number(hit[3]));
  checked += 1;
  if (got !== expected) {
    failures.push(`  --${token}: ${got} but palette.${paletteKey} is ${expected}`);
  }
}

if (!checked) {
  console.error('brand:roundtrip checked nothing — the token or palette format changed');
  process.exit(1);
}

if (failures.length) {
  console.error(`${failures.length} of ${checked} tokens do not match their brand hex:`);
  console.error(failures.join('\n'));
  console.error('\nThe hex -> HSL precision in scripts/gen-brand-css.mjs is too low.');
  process.exit(1);
}

console.log(`brand:roundtrip — ${checked} tokens match their palette hex exactly`);
