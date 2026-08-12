import { AlertTriangle, Cake, Info, Megaphone, PartyPopper, Pin } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { detectCelebration, type CelebrationKind } from './NoticeCelebration';

/*
 * Notice card themes.
 *
 * The notice modal used to hard-code one look. A maintenance warning, a
 * birthday and a leave-policy update are three different kinds of message, and
 * dressing all three in the same celebratory gradient makes the urgent one read
 * as decoration. So the card's skin is data, chosen per notice.
 *
 * WHAT PICKS THE THEME (in priority order):
 *   1. Celebration keywords in the TITLE — birthdays/anniversaries are obvious
 *      from the headline and ops should not have to tag them.
 *   2. The notice's CATEGORY NAME — the field ops already fills in on every
 *      notice. This is the backbone: no schema change, no new decision at
 *      compose time, and re-categorising a notice re-skins it.
 *   3. Fallback: 'aurora', the house style.
 *
 * A dedicated `theme` column was considered and rejected: it asks an operator
 * to make a design decision on every notice, which in practice means it is
 * ignored or set wrong. Category already carries the intent.
 *
 * The motion itself lives in globals.css (`nb-aurora`, `nb-sweep`, …) so all
 * themes share one sheet and one prefers-reduced-motion switch.
 */

export type NoticeThemeKey = 'aurora' | 'spotlight' | 'celebration' | 'quiet';

export type NoticeTheme = {
  key: NoticeThemeKey;
  /** Hero band classes. `null` = the light 'quiet' card, which has no hero. */
  heroClass: string | null;
  /** Medallion glyph + its tint. */
  icon: LucideIcon;
  iconClass: string;
  /** Primary (OK) button tint. */
  buttonClass: string;
  /** Left accent rail — only used by the light 'quiet' card. */
  railClass: string;
  /** Confetti variant to play, when the headline earns one. */
  celebration: CelebrationKind;
};

const AURORA: Omit<NoticeTheme, 'celebration'> = {
  key: 'aurora',
  heroClass: 'nb-aurora bg-slate-950',
  icon: Megaphone,
  iconClass: 'text-white',
  buttonClass: 'bg-sky-600 hover:bg-sky-700 text-white',
  railClass: 'bg-sky-500',
};

const SPOTLIGHT: Omit<NoticeTheme, 'celebration'> = {
  key: 'spotlight',
  heroClass: 'nb-sweep bg-gradient-to-br from-rose-600 to-orange-600',
  icon: AlertTriangle,
  iconClass: 'text-white',
  buttonClass: 'bg-rose-600 hover:bg-rose-700 text-white',
  railClass: 'bg-rose-500',
};

const CELEBRATION: Omit<NoticeTheme, 'celebration'> = {
  key: 'celebration',
  heroClass: 'bg-gradient-to-br from-fuchsia-500 via-pink-600 to-violet-700',
  icon: PartyPopper,
  iconClass: 'text-amber-200',
  buttonClass: 'bg-fuchsia-600 hover:bg-fuchsia-700 text-white',
  railClass: 'bg-fuchsia-500',
};

const QUIET: Omit<NoticeTheme, 'celebration'> = {
  key: 'quiet',
  heroClass: null,
  icon: Info,
  iconClass: 'text-slate-500',
  buttonClass: 'bg-slate-900 hover:bg-slate-800 text-white',
  railClass: 'bg-sky-500',
};

/*
 * Category-name → theme. Matched case-insensitively on a SUBSTRING, so an
 * ops-renamed category ("Urgent Alert", "System Alerts") still lands correctly
 * without a code change. Order matters: first hit wins.
 */
const CATEGORY_RULES: Array<{ re: RegExp; theme: Omit<NoticeTheme, 'celebration'> }> = [
  { re: /(alert|urgent|critical|maintenance|outage|downtime|incident)/i, theme: SPOTLIGHT },
  { re: /(celebrat|festival|birthday|award|recognition)/i, theme: CELEBRATION },
  { re: /(policy|update|hr\b|process|compliance|reminder)/i, theme: QUIET },
  { re: /(general|announcement|news)/i, theme: AURORA },
];

export function themeForNotice(notice: { title?: string | null; category_name?: string | null } | null | undefined): NoticeTheme {
  const title = notice?.title ?? '';
  const category = notice?.category_name ?? '';

  // 1. A celebratory headline always wins — it also selects the confetti kind
  //    and swaps the medallion to a cake for birthdays.
  const celebration = detectCelebration(title);
  if (celebration) {
    return {
      ...CELEBRATION,
      icon: celebration === 'birthday' ? Cake : PartyPopper,
      celebration,
    };
  }

  // 2. Category.
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(category)) return { ...rule.theme, celebration: null };
  }

  // 3. House style.
  return { ...AURORA, celebration: null };
}

/*
 * Pinned notices swap the medallion to a pin and get the shimmer headline —
 * applied on top of whatever theme was selected, so a pinned alert stays red.
 */
export function pinnedIcon(): LucideIcon {
  return Pin;
}
