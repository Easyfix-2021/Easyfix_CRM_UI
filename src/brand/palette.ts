/**
 * EasyFix brand palette — the ONLY module in the CRM allowed to hold colour
 * literals.
 *
 * Every value is a canonical primitive from the EasyFix Brand Identity
 * (docs/EasyFix-Brand-Identity.html):
 *   "Red is action. Ink is text. Blue is money and grade. Gold is earned."
 *
 * Components never read these directly — they consume SEMANTIC tokens, which
 * reach them as CSS custom properties generated from `tokens.ts` into
 * `src/app/brand.css` by `npm run brand:gen`. `npm run check:brand` enforces
 * that no other file contains a colour literal or a raw Tailwind palette class.
 *
 * THIS FILE IS THE REBRAND SEAM. Changing the identity means editing these
 * values and re-running the generator — not touching components.
 *
 * Keys match Easyfix_Technician_Mobile_Application/src/theme/palette.ts exactly,
 * so the two surfaces stay diffable line-for-line. Do NOT add colours that are
 * not on the brand page (rule 10), and do NOT invent a second error palette —
 * urgent/error reuse red-600 / red-100 / red-700.
 */

export const palette = {
  // ── Red — action ─────────────────────────────────────────────────────────
  red50: '#FBF0F1', // soft wash
  red100: '#F6DEE0', // status/action tint (also urgent/error tint)
  red500: '#C42430', // header, primary action, active tab, logo
  red600: '#A71F29', // pressed action · urgent · error
  red700: '#831820', // red text on red tint

  // ── Ink — text & neutral surfaces ────────────────────────────────────────
  ink900: '#171B1F', // headings, dark surfaces (the CRM's sidebar ground)
  ink700: '#363B41', // body text, elevated dark surfaces
  ink500: '#5C636B', // supporting text, labels
  ink300: '#9AA1A9', // placeholder, disabled
  ink100: '#E4E7EA', // borders, dividers
  ink50: '#F4F6F7', // light page background
  white: '#FFFFFF', // cards, inverse text

  // ── Blue — money & grade / information ───────────────────────────────────
  blue100: '#E4EFFA', // information tint
  blue500: '#2A6FBF', // links, information icons
  blue700: '#1B4C87', // blue text on blue tint
  blue900: '#10294D', // wallet and grade blocks

  // ── Meaning ──────────────────────────────────────────────────────────────
  success: '#1B9E5A',
  successTint: '#E2F5EA',
  successText: '#0E5C34',
  warning: '#E0930F',
  warningTint: '#FCF0D9',
  warningText: '#6B4405',

  // ── Gold — earned grade & rewards ONLY (never on red, never a large fill) ─
  gold: '#C99A2E',
  goldTint: '#FBF1D8',
  goldText: '#6B4A05',
} as const;

/**
 * The national tricolour — the ONE documented exception to rule 10.
 *
 * Saffron and India green are not brand tokens and never will be. They are
 * admitted solely for the Independence Day and Republic Day logo treatment,
 * and only as 2px rules plus a small roof flag — never a field, never a
 * background, never anywhere else in the product. A national flag cannot be
 * rendered in brand colours, so the alternative is not observing the day at
 * all.
 *
 * Deliberately kept OUT of `palette` so it can never be picked up by a
 * semantic token, and out of the generated CSS so no component can reach it.
 */
export const tricolour = {
  saffron: '#FF9933',
  green: '#138808',
} as const;

/**
 * The certificate document's ink — the second documented exception, and the
 * same shape as the tricolour above: colours this CRM does not own, admitted
 * only so a preview can mirror something rendered elsewhere.
 *
 * THESE ARE NOT CRM TOKENS AND MUST NEVER BECOME ONE. They are a verbatim copy
 * of the `STYLE` table in EasyFix_Backend `utils/pdf-certificate.js`, which is
 * the sole authority on what a certificate looks like: it rasterises the PNG
 * and JPG and writes the PDF. HRMS → Certificates draws a live preview of that
 * document, and a preview whose colours are "close" is a preview that lies —
 * so the values are copied rather than approximated, and they belong here
 * because this is the only module allowed to hold a colour literal.
 *
 * Kept OUT of `palette` for the tricolour's reason: nothing in the token
 * generator may pick these up, and no component may reach them except the
 * certificate preview. A rebrand that changes them has to change the backend
 * in the same commit or the preview and the download drift apart.
 *
 * ⚠ KEY NAMES HERE MUST NOT COLLIDE WITH A KEY IN `palette`.
 * `scripts/check-brand-roundtrip.mjs` reads this file with a line regex —
 * every two-space-indented `key: '#RRGGBB'` in the WHOLE file, whichever
 * export it belongs to — and folds them into one flat map, last one winning.
 * A `gold` key here therefore shadows `palette.gold` and the roundtrip check
 * fails claiming the generated `--gold` token is wrong. Measured: it did.
 * The backend's GOLD is deliberately absent below for that reason and because
 * the preview never needs it — the rules on the certificate are part of the
 * artwork, not something this page draws.
 */
export const certificateInk = {
  navy: '#12305B', // the title run
  ink: '#1A1A1A', // recipient name, date value, signatory name
  muted: '#5A5A5A', // headings, eyebrows, labels, the certificate-id line
} as const;

export type PaletteColor = keyof typeof palette;
