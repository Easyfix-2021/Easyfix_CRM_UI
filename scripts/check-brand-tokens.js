#!/usr/bin/env node
/**
 * EasyFix CRM brand-system guard.
 *
 * The EasyFix brand rule: "Only tokens in code. No hex codes anywhere else."
 * Colour literals may live ONLY in `src/brand/palette.ts` (the rebrand seam);
 * every other file must consume the semantic tokens that `npm run brand:gen`
 * emits into `src/app/brand.css`, either as a CSS custom property or through
 * the Tailwind theme mapping (`bg-primary`, `text-muted-foreground`, …).
 *
 * A raw Tailwind palette class — `bg-slate-100`, `text-red-600`, `border-gray-200`
 * — is exactly as much of a hard-coded colour as `#f1f5f9` is. It just doesn't
 * look like one, which is why ~750 of them accumulated before this guard
 * existed and why they are the single largest thing standing between the CRM
 * and a one-file rebrand. Tailwind's `slate-*` grey is a BLUE grey; the brand's
 * ink ramp is warm. Every raw class is a colour the rebrand seam cannot reach.
 *
 * WHAT IS SCANNED
 *   src/**\/*.ts, src/**\/*.tsx  — every component, page, hook and lib module
 *   src/app/globals.css          — hand-written CSS, including `@apply` lines
 *
 * WHAT IS NOT SCANNED, ON PURPOSE
 *   public/brand/*.svg — only `src/` is walked. The festival ornaments and
 *     other brand SVGs there carry their own artwork colours and inline
 *     animation by design; they are ASSETS, not code, and a token cannot be
 *     expressed inside a standalone SVG served straight from /public. Do NOT
 *     "fix" this by widening the walk — the violations it would report are not
 *     violations.
 *   src/app/brand.css — GENERATED output (HSL triplets). Verified separately,
 *     against palette.ts, by `npm run brand:roundtrip`.
 *
 * THE ALLOWLIST (three files, each for one specific reason)
 *   src/brand/palette.ts            — the single source of colour literals, by
 *                                     design. This is the rebrand seam; the
 *                                     hex codes are the point.
 *   src/app/brand.css               — generated output, HSL triplets derived
 *                                     from palette.ts. Listed explicitly so the
 *                                     exemption is documented even though the
 *                                     walk (which only adds globals.css) never
 *                                     reaches it.
 *   src/components/brand/Logo.tsx   — the one place a logo asset path may
 *                                     appear. Everywhere else imports <Logo>,
 *                                     so swapping the mark stays a one-file
 *                                     change and no page can pin a stale file.
 *   src/components/quicksight/charts.tsx
 *                                   — QS_COLORS, the QuickSight chart palette.
 *                                     Categorical chart series need hues that
 *                                     stay distinguishable when ADJACENT, which
 *                                     is a different problem from semantic UI
 *                                     colour: brand red, ink and gold alone
 *                                     cannot separate six series on one axis.
 *                                     The palette is already governed by its own
 *                                     documented convention and an eslint rule
 *                                     (QS_COLORS[1..4] deliberately equal the
 *                                     semantic hexes so a chart and a status
 *                                     chip agree). Converting these to tokens
 *                                     would break legibility AND contradict
 *                                     that rule, so this file is exempt from the
 *                                     colour-literal check only.
 *
 * Named CSS colours (`red`, `gold`, …) are intentionally NOT matched: several
 * semantic token names are CSS colour words, so matching them would
 * false-positive on legitimate token references. `transparent` / `currentColor`
 * carry no hue and are always fine.
 *
 * Pure node — no dependencies.
 *
 *   node scripts/check-brand-tokens.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const GLOBALS_CSS = path.join(SRC, 'app', 'globals.css');
const EXTS = new Set(['.ts', '.tsx']);

// See "THE ALLOWLIST" above for the reasoning behind each entry.
const COLOUR_SOURCE_OF_TRUTH = new Set([
  path.join(SRC, 'brand', 'palette.ts'), // the rebrand seam — literals by design
  path.join(SRC, 'app', 'brand.css'), // generated HSL triplets from palette.ts
]);
// The single component allowed to name a logo asset path.
const LOGO_COMPONENT = path.join(SRC, 'components', 'brand', 'Logo.tsx');

/*
 * Exempt from the COLOUR-LITERAL rules only — every other rule still applies.
 * See "THE ALLOWLIST" above for why the chart palette is not a token failure.
 */
const CHART_PALETTE = new Set([
  path.join(SRC, 'components', 'quicksight', 'charts.tsx'),
]);

/*
 * OPAQUE `bg-white` is a surface that cannot follow the theme — it stays white
 * while everything around it goes dark. 122 of them survived the first sweep
 * because the raw-palette rule matches a hue plus a NUMERIC shade
 * (`bg-slate-500`), and `bg-white` has neither. "Zero violations" meant zero of
 * what the guard thought to look for.
 *
 * `bg-white/N` is NOT flagged and must never be: white at alpha over a coloured
 * or dark ground is correct in both themes — the frost pattern the technician
 * app has dedicated tokens for.
 *
 * The three files below are the opaque form of that same case: a white knob or
 * fill riding ON a coloured track. Measured in dark mode, `bg-card` resolves to
 * 23.3% L against a 39.0% off-track and a 45.5% primary ground — the thumb
 * would be darker than the track it slides on, and the progress fill darker
 * than the bar it fills. White is correct there and the exemption is theirs
 * alone; every other file must use a token.
 */
const WHITE_ON_COLOUR = new Set([
  path.join(SRC, 'components', 'ui', 'switch.tsx'),                       // thumb on primary/ink-300 track
  path.join(SRC, 'app', '(authed)', 'settings', 'auto-allocation', 'page.tsx'), // inline copy of that thumb
  path.join(SRC, 'components', 'easyfixer', 'VerificationSection.tsx'),   // progress fill on a primary ground
]);

/*
 * Opaque only. Two exemptions, both structural rather than stylistic:
 *   - the negative lookahead spares `bg-white/70` and friends outright;
 *   - a line that ALSO carries an alpha form is a frost element intensifying on
 *     interaction (`bg-white/90 hover:bg-white`). Flagging the opaque half would
 *     push someone to convert it alone, flipping the control white -> ink-700
 *     mid-hover while its paired text colour stayed put.
 */
const OPAQUE_WHITE = /\bbg-white\b(?!\/)/;
const FROST_PAIR = /bg-white\//;

// ─── the rules ────────────────────────────────────────────────────────────

/** #fff · #fff8 · #C42430 · #C42430ff */
/*
 * Long-form hex is unambiguous. Shorthand is NOT, and the naive
 * `#[0-9a-fA-F]{3,4}` form produced real false positives: this CRM is full of
 * reference numbers like `Job #8377` and `#4021`, and every one of them read as
 * a 4-digit hex colour. Eleven bogus violations across RateCardsTab and
 * payout-requests came from exactly that.
 *
 * So shorthand is accepted only when it actually looks like a colour: it
 * contains a hex LETTER (#fff, #abc) or repeats a single character (#000,
 * #333). `#8377` satisfies neither and is correctly ignored. Four-digit RGBA
 * shorthand is dropped entirely — it is vanishingly rare in this codebase and
 * indistinguishable from a four-digit ticket number.
 */
const HEX_LONG = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const HEX_SHORT = /#([0-9a-fA-F]{3})\b/;

function hasHexColour(line) {
  if (HEX_LONG.test(line)) return true;
  const m = HEX_SHORT.exec(line);
  if (!m) return false;
  const v = m[1];
  const hasLetter = /[a-fA-F]/.test(v);
  const allSame = v[0] === v[1] && v[1] === v[2];
  return hasLetter || allSame;
}
/**
 * rgb() · rgba() · hsl() · hsla() — a colour built at the call site.
 *
 * `hsl(var(--card))` / `hsl(var(--ink-900) / 0.08)` is EXEMPT and must stay so:
 * that is not a literal, it is how a token is consumed at the CSS layer.
 * brand.css stores HSL triplets precisely so Tailwind's
 * `hsl(var(--token) / <alpha-value>)` convention works, and globals.css is
 * built on it. Flagging those would push the sweep to "fix" the one pattern
 * the whole token system depends on.
 */
const COLOUR_FUNC = /\b(?:rgba?|hsla?)\s*\((?!\s*var\()/;
/**
 * Raw Tailwind palette utilities — the big one. `bg-slate-100`,
 * `hover:text-red-600`, `dark:border-gray-200`, `from-sky-50`… Any of the
 * colour-carrying utility prefixes paired with a stock Tailwind hue and shade.
 * Semantic classes (`bg-primary`, `text-muted-foreground`, `border-border`)
 * carry no hue/shade pair and so never match.
 */
const RAW_PALETTE =
  /\b(bg|text|border|ring|from|via|to|fill|stroke|divide|outline|placeholder|decoration|shadow|accent|caret)-(slate|gray|zinc|neutral|stone|sky|blue|indigo|violet|purple|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal|cyan)-(50|100|200|300|400|500|600|700|800|900|950)\b/;
/** Weights above 600 — the brand type scale stops at semibold. */
const WEIGHT_CLASS = /\bfont-(?:bold|extrabold|black)\b/;
const WEIGHT_STYLE = /\bfontWeight\s*:\s*["']?(?:700|800|900|bold)["']?/;
/** Arbitrary type sizes below the 12px legibility floor. */
const TEXT_SIZE = /text-\[(\d+)px\]/g;
const TYPE_FLOOR_PX = 12;
/** A logo asset wired up outside the shared <Logo> component. */
const LOGO_IMAGE = /<Image[^>]*src=["']\/logo/;

const KINDS = {
  HEX: 'colour literal (hex)',
  FUNC: 'colour literal (rgb/hsl)',
  PALETTE: 'raw Tailwind palette utility',
  WEIGHT: 'font weight above 600',
  FLOOR: 'type below the 12px floor',
  LOGO: 'logo <Image> outside Logo.tsx',
};

/**
 * Remove comments so documentation examples don't trip the regexes.
 *
 * ORDER MATTERS, and only one order is correct for JS/TS: line comments FIRST.
 * A line comment may legitimately contain `/*` (e.g. `// see the /* … *\/ block
 * above`). Strip block comments first and that stray opener swallows everything
 * up to the next `*\/` — potentially hundreds of lines of real code, whose
 * violations then silently vanish from the report. A guard that under-reports
 * is worse than no guard.
 *
 * The `(^|[^:])` guard keeps `https://…` intact.
 *
 * CSS has no `//` comment form, so for .css input only block comments are
 * stripped — running the JS line-comment pass over CSS would eat the tail of
 * any line holding a protocol-relative or `url(…)` reference.
 */
function stripComments(src, { css = false } = {}) {
  if (css) return src.replace(/\/\*[\s\S]*?\*\//g, '');
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Scan one file's source. `file` is the ABSOLUTE path, used only for the
 * allowlist decisions; pass anything for ad-hoc/test input.
 * Returns [{ line, kind, text }].
 */
function scanSource(src, { file = '', css = false } = {}) {
  // CHART_PALETTE is exempt from the two COLOUR-LITERAL rules only; the raw-
  // palette, weight and type-floor rules below still apply to it.
  const isColourSource = COLOUR_SOURCE_OF_TRUTH.has(file) || CHART_PALETTE.has(file);
  const isLogoComponent = file === LOGO_COMPONENT;
  const isWhiteOnColour = WHITE_ON_COLOUR.has(file);
  const findings = [];

  stripComments(src, { css }).split(/\r?\n/).forEach((line, i) => {
    const add = (kind) => findings.push({ line: i + 1, kind, text: line.trim().slice(0, 100) });

    if (!isColourSource) {
      if (hasHexColour(line)) add(KINDS.HEX);
      else if (COLOUR_FUNC.test(line)) add(KINDS.FUNC);
    }

    if (RAW_PALETTE.test(line)) add(KINDS.PALETTE);

    if (!isWhiteOnColour && OPAQUE_WHITE.test(line) && !FROST_PAIR.test(line)) add(KINDS.PALETTE);
    if (WEIGHT_CLASS.test(line) || WEIGHT_STYLE.test(line)) add(KINDS.WEIGHT);

    TEXT_SIZE.lastIndex = 0;
    for (let m = TEXT_SIZE.exec(line); m; m = TEXT_SIZE.exec(line)) {
      if (Number(m[1]) < TYPE_FLOOR_PX) add(KINDS.FLOOR);
    }

    if (!isLogoComponent && LOGO_IMAGE.test(line)) add(KINDS.LOGO);
  });

  return findings;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

function main() {
  const files = [];
  walk(SRC, files);
  if (fs.existsSync(GLOBALS_CSS)) files.push(GLOBALS_CSS);

  const findings = [];
  for (const file of files) {
    const css = path.extname(file) === '.css';
    const relative = path.relative(ROOT, file);
    for (const f of scanSource(fs.readFileSync(file, 'utf8'), { file, css })) {
      findings.push({ file: relative, ...f });
    }
  }

  if (findings.length === 0) {
    console.log('✓ brand system OK — tokens only, type floor held, weights ≤600, one logo owner');
    process.exit(0);
  }

  const byKind = new Map();
  const byFile = new Map();
  for (const f of findings) {
    byKind.set(f.kind, (byKind.get(f.kind) || 0) + 1);
    byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  }

  console.log(`✗ ${findings.length} brand violation(s), in ${byFile.size} file(s).\n`);
  console.log('By rule:');
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${kind}`);
  }
  console.log('\nBy file:');
  for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${file}`);
  }
  console.log(
    '\nReplace colour literals and raw Tailwind palette classes with the semantic'
    + '\ntokens in src/brand/tokens.ts (generated into src/app/brand.css). Colour'
    + '\nliterals belong in src/brand/palette.ts and nowhere else.',
  );
  process.exit(1);
}

// CLI when run directly; a plain module when required by tests.
if (require.main === module) main();

module.exports = {
  // `hasHexColour` replaces the old flat HEX regex: shorthand needs a
  // predicate, not a pattern, to tell #fff from ticket number #8377.
  hasHexColour,
  HEX_LONG,
  HEX_SHORT,
  COLOUR_FUNC,
  RAW_PALETTE,
  WEIGHT_CLASS,
  WEIGHT_STYLE,
  TEXT_SIZE,
  LOGO_IMAGE,
  TYPE_FLOOR_PX,
  KINDS,
  COLOUR_SOURCE_OF_TRUTH,
  LOGO_COMPONENT,
  stripComments,
  scanSource,
};
