/**
 * Semantic tokens — what components actually mean, mapped onto brand primitives.
 *
 * NO COLOUR LITERALS LIVE HERE. Every value is a `palette.*` reference. This
 * file answers "what is a border?", `palette.ts` answers "what is ink-100?",
 * and the two questions stay separable — which is what makes a rebrand a
 * one-file edit.
 *
 * `npm run brand:gen` turns this into `src/app/brand.css` as space-separated
 * HSL triplets, because Tailwind's `hsl(var(--token))` pipeline needs that form
 * for the `/10` and `/40` alpha modifiers the app already relies on in ~500
 * places. Authoring stays hex; consumption stays HSL; the generator bridges.
 *
 * The 22 pre-existing token names are preserved EXACTLY. That is deliberate:
 * every `bg-card`, `text-muted-foreground` and `border-border` in the codebase
 * keeps working untouched, and only the values behind them move. The additions
 * below (ramps + meaning families) exist so the ~750 raw `slate-*`/`sky-*`
 * utilities have somewhere on-brand to land.
 */

import { palette as p } from './palette';

export type TokenMap = Record<string, string>;

/*
 * LIGHT — the identity doc says "light designed first" (rule 7).
 */
const light: TokenMap = {
  background: p.ink50,
  foreground: p.ink900,

  card: p.white,
  'card-foreground': p.ink900,

  popover: p.white,
  'popover-foreground': p.ink900,

  // Brand red is the action colour and is INVARIANT across modes — it is the
  // one thing a technician and an ops user must recognise identically.
  primary: p.red500,
  'primary-foreground': p.white,
  'primary-pressed': p.red600,

  secondary: p.ink100,
  'secondary-foreground': p.ink900,

  muted: p.ink100,
  'muted-foreground': p.ink500,

  // Was a warm orange with no identity counterpart. red-50 is the softest
  // on-brand wash, which is what `accent` was actually being used for.
  accent: p.red50,
  'accent-foreground': p.red700,

  // `destructive` is the FILL half of the old `urgent` token: every solid red
  // block that carries white text lives here, in both modes, at red-600. See
  // the `urgent` note in the dark map for why the two roles had to split.
  // `destructive-strong` is its hover/pressed step — red-700 in BOTH modes, so
  // a destructive button darkens on hover on a white page and on a dark one.
  // It does not swap the way the `-strong` members of the meaning families do,
  // because `destructive` itself does not swap either.
  destructive: p.red600,
  'destructive-foreground': p.white,
  'destructive-strong': p.red700,

  border: p.ink100,
  input: p.ink100,
  ring: p.red500,

  // The CRM's surface differentiator per the brand kit, and the identity doc's
  // stated use for ink-900: "headings, dark surfaces".
  sidebar: p.ink900,
  'sidebar-foreground': p.ink300,
  'sidebar-accent': p.ink700,

  // ── Ramps — the landing ground for the raw-utility sweep ─────────────────
  'ink-900': p.ink900,
  'ink-700': p.ink700,
  'ink-500': p.ink500,
  'ink-300': p.ink300,
  'ink-100': p.ink100,
  'ink-50': p.ink50,

  'brand-50': p.red50,
  'brand-100': p.red100,
  'brand-500': p.red500,
  'brand-600': p.red600,
  'brand-700': p.red700,

  // ── Meaning families — solid / tint / on-tint text ───────────────────────
  success: p.success,
  'success-tint': p.successTint,
  'success-strong': p.successText,

  warning: p.warning,
  'warning-tint': p.warningTint,
  'warning-strong': p.warningText,

  // Urgent reuses the red ramp by brand rule — there is no second error palette.
  urgent: p.red600,
  'urgent-tint': p.red100,
  'urgent-strong': p.red700,

  info: p.blue500,
  'info-tint': p.blue100,
  'info-strong': p.blue700,
  'info-deep': p.blue900,

  // Gold is grade and rewards ONLY (rule 3). Never on red, never a large fill.
  gold: p.gold,
  'gold-tint': p.goldTint,
  'gold-strong': p.goldText,

  neutral: p.ink500,
  'neutral-tint': p.ink100,
  'neutral-strong': p.ink700,
};

/*
 * DARK — surfaces invert down the ink ramp; brand red does not move.
 *
 * Tints flip to their deep counterparts so text-on-tint keeps its contrast:
 * a success chip is successText-on-successTint in light, and successTint-on-
 * successText in dark. The pair swaps rather than being re-picked, so the two
 * modes cannot drift apart.
 */
const dark: TokenMap = {
  background: p.ink900,
  foreground: p.ink50,

  card: p.ink700,
  'card-foreground': p.ink50,

  popover: p.ink700,
  'popover-foreground': p.ink50,

  primary: p.red500,
  'primary-foreground': p.white,
  'primary-pressed': p.red600,

  /*
   * ink-500, NOT ink-700 — the four "one step off the card" tokens.
   *
   * secondary / muted / border / input are all ink-100 in light: one step off
   * the card AND one step off the page background, which is what makes a muted
   * plate read as a plate and a 1px rule read as a rule. Dark originally put
   * all four on ink-700, the card's own value, so against a card they measured
   * 1.00:1 — every muted plate, every card header band and every table row
   * separator in the CRM simply did not render in dark mode.
   *
   * ink-500 is the mirror of that light relationship: light muted is DARKER
   * than both surfaces, dark muted is LIGHTER than both. Measured off rendered
   * pixels: plate/card 1.86:1, plate/page 2.85:1, row rule/card 1.86:1.
   *
   * NOT ink-900, the other candidate: ink-900 is the page background, so a
   * `bg-muted` element sitting on the page measures 1.00:1 — and the active tab
   * indicator, which is `bg-background` on a `bg-muted` list, disappears in all
   * 18 tab strips, as does the `hover:bg-muted` on 269 outline/ghost buttons.
   *
   * KNOWN RESIDUAL: `text-muted-foreground` (ink-300) sitting ON a full-strength
   * ink-500 band measures 2.33:1 — `.data-table th` and ~52 other class strings.
   * No value on the six-step ink ramp fixes this: a band dark enough for ink-300
   * text is a band invisible on the card or on the page. Closing it needs either
   * a new palette step between ink-700 and ink-500 (rule 10 — an owner decision,
   * not one to take here) or a dark-only text colour on those bands. Left at
   * ink-500 because an illegible label is a smaller defect than 400+ elements
   * that render at 1.00:1, and muted-foreground cannot move: at ink-100 it
   * measures 1.15:1 against `foreground` and stops reading as muted at all.
   */
  secondary: p.ink500,
  'secondary-foreground': p.ink50,

  muted: p.ink500,
  'muted-foreground': p.ink300,

  accent: p.red700,
  'accent-foreground': p.red100,

  // Invariant with light — see the light map. `destructive` is the fill role,
  // and a fill that carries white text cannot move down the ramp in dark
  // without dropping white text below 4.5:1.
  destructive: p.red600,
  'destructive-foreground': p.white,
  'destructive-strong': p.red700,

  border: p.ink500,
  input: p.ink500,
  ring: p.red500,

  /*
   * ink-900, the SAME value as the dark page background — not a darker
   * invented shade.
   *
   * A one-step-darker sidebar reads better, but it needs a colour the identity
   * document does not contain, and rule 10 is "no colour that is not on this
   * page". The separation is carried by the sidebar's border instead, which is
   * exactly how light mode already does it. Inventing an ink-950 here would
   * have been the first crack in the rule this whole pipeline exists to keep.
   */
  sidebar: p.ink900,
  'sidebar-foreground': p.ink300,
  'sidebar-accent': p.ink700,

  'ink-900': p.ink50,
  'ink-700': p.ink100,
  'ink-500': p.ink300,
  'ink-300': p.ink500,
  'ink-100': p.ink700,
  'ink-50': p.ink900,

  'brand-50': p.red700,
  'brand-100': p.red600,
  'brand-500': p.red500,
  'brand-600': p.red600,
  'brand-700': p.red100,

  success: p.success,
  'success-tint': p.successText,
  'success-strong': p.successTint,

  warning: p.warning,
  'warning-tint': p.warningText,
  'warning-strong': p.warningTint,

  /*
   * red-100 — and it can be, because `urgent` is now INK ONLY.
   *
   * This token used to serve two roles that pull opposite ways: a solid fill
   * carrying white text, and bare ink on a surface. No single value satisfies
   * both. red-600 measured 1.54:1 as ink on the dark card — the reject action
   * was the one control an operator could not see, while the approve tick
   * beside it managed 3.27:1 — and the earlier red-500 step reached only
   * 1.96:1, still under the 3:1 non-text floor. red-100 fixes the ink outright
   * (8.85:1 on a card) and used to be unavailable only because `bg-urgent
   * text-white` then measured 1.28:1.
   *
   * So the roles were split rather than compromised. All 25 solid `bg-urgent`
   * fills — buttons, badges, status dots, the notice rail, the cancelled-strike
   * rule — plus the 13 `bg-urgent/N` washes and the 2 gradient stops
   * (`from-urgent` / `via-urgent` on the notice heroes, which carry white
   * icons and which a `bg-urgent` grep does not see) now sit on `destructive`
   * (red-600 + white, invariant across modes), and every paired
   * `hover:bg-urgent-strong` became `hover:bg-destructive-strong` (red-700), so
   * a destructive control still DARKENS on hover in both themes rather than
   * going pale — in dark it previously went red-500 -> red-100 and put white
   * text on pale pink at 1.28:1, i.e. the hover state erased the button.
   *
   * `bg-urgent` is now zero occurrences and must stay that way: a solid
   * red-100 block is pale pink and signals nothing. The same goes for any
   * other FILL utility — `from-`, `via-`, `to-`, `fill-`. Ink, borders and
   * rings are the roles this token is for.
   *
   * KNOWN RESIDUAL: a `bg-destructive` status dot on a dark card measures
   * 1.54:1, down from red-500's 1.96:1 — both under the 3:1 non-text floor.
   * That is not specific to red: `bg-info` measures 2.22:1 on the same card
   * and `bg-warning` 2.52:1 on a light one. Full-strength meaning colours as
   * small solid indicators are a palette-wide gap, and closing it needs a
   * lighter step on each meaning ramp — rule 10, an owner decision.
   *
   * What still consumes `urgent` is ink and edges — `text-urgent`,
   * `border-urgent`, `ring-urgent/N` — all of which get better at red-100 on a
   * dark ground. Light is untouched: `urgent` and `destructive` are both
   * red-600 there, so the whole fill migration is a no-op in light mode.
   *
   * `urgent-strong` is also red-100 here, so `text-urgent` and
   * `text-urgent-strong` collapse to the same ink in dark. That is correct in
   * both their contexts (bare on a card; on the red-700 `urgent-tint` plate)
   * and not worth a fourth red step to separate.
   */
  urgent: p.red100,
  'urgent-tint': p.red700,
  'urgent-strong': p.red100,

  info: p.blue500,
  'info-tint': p.blue900,
  'info-strong': p.blue100,
  'info-deep': p.blue100,

  gold: p.gold,
  'gold-tint': p.goldText,
  'gold-strong': p.goldTint,

  neutral: p.ink300,
  'neutral-tint': p.ink700,
  'neutral-strong': p.ink100,
};

/* Card and button radius 12 per the identity doc's shape section. */
export const radius = '0.75rem';

export const tokens = { light, dark };
