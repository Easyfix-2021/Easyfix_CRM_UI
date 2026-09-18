'use client';

/*
 * QuickSight — Employee Performance, section 0 "Team".
 *
 * The dashboard's team panel (dashboard.html render(): "Team Name" +
 * "Team Members") in CRM styling. Data is summary.team from
 * aggregate.js buildSummary — the team name ('All Teams' when the selected
 * SPOCs span several) and the de-duplicated, sorted member list.
 *
 * Layout (owner's pick, "compact avatars + search"):
 *
 *   Team                                           All Teams · 39 Members
 *   [Search Member…]           Click A Member To See Their Productivity …
 *   (AK) Abhishek Kumar  (AJ) Ankit Kumar Jha  (AR) Aryan …
 *                                                     Show All (39) ▾
 *
 * - Header: SectionCard's heading markup plus the team name and member count
 *   on the right. SectionCard has no right-hand header slot, so the Card is
 *   composed here with SectionCard's exact classes.
 * - The count is the number of chips (summary.team.members is already
 *   de-duplicated). It can be LOWER than the Team Members KPI tile, which
 *   counts the roster as uploaded, duplicates included — the count says so on
 *   hover. While searching it reads "N Of Total".
 * - Search filters by display name or CRM name, case-insensitive, as you type.
 * - Each member is a Button (keyboard-focusable, aria-pressed): an initials
 *   avatar in a stable per-name hue plus the name. Clicking a member opens
 *   MemberDetailDialog; clicking the active member again closes it, as on the
 *   dashboard.
 * - The list collapses to COLLAPSED_ROWS rows by MEASURING the row breaks (not
 *   a fixed chip count), so it is two rows at every width. Chips past the cut
 *   stay laid out but `invisible`, which also takes them out of the tab order
 *   and the accessibility tree. A search always shows every match.
 * - With no members the panel says WHY. A name only exists for a month whose
 *   emp detail is uploaded (visibility.ts), so an empty team is usually a
 *   missing sheet rather than a narrow filter: the caller passes the wording
 *   (visibility.ts teamEmptyState) and the panel prints it.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, Search, SearchX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { cn } from '@/lib/utils';
import type { TeamMemberChip, TeamPanel as TeamPanelData } from './types';

const COLLAPSED_ROWS = 2;

/*
 * Avatar hues: the QuickSight chart palette minus its "bad" red, which would
 * read as a status here and clash with the primary-red active chip.
 *
 * Each hue is mixed with theme tokens, so one style works in light AND dark:
 * the disc is 18% hue over --background (the outline chip's own fill) and the
 * initials are 45% hue over --foreground — dark ink on a pastel disc in light
 * mode, light ink on a deep disc in dark mode. Measured against both themes'
 * token values the weakest pair (lime, light) is 5.1:1 and the best 8.4:1.
 * The disc is opaque, so a hovered chip leaves that contrast unchanged.
 */
const AVATAR_STYLES: ReadonlyArray<CSSProperties> = QS_COLORS
  .filter((hue) => hue !== QS_SEMANTIC.bad)
  .map((hue) => ({
    backgroundColor: `color-mix(in srgb, ${hue} 18%, hsl(var(--background)))`,
    color: `color-mix(in srgb, ${hue} 45%, hsl(var(--foreground)))`,
  }));

/** The same name always gets the same hue, whatever the list or its order. */
function avatarStyle(name: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return AVATAR_STYLES[h % AVATAR_STYLES.length];
}

/*
 * Two-letter monogram, the clients page's rule: first + last initial for a
 * multi-word name ("Ankit Kumar Jha" → AJ), the first two characters of a
 * single word ("Aryan" → AR). Punctuation is ignored so "Kumar." or a stray
 * "-" never becomes an initial.
 */
function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, '')))
    .filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : [words[0][0], words[words.length - 1][0]];
  return letters.join('').toUpperCase();
}

export function TeamPanel({
  team,
  activeKey,
  onSelect,
  empty,
}: {
  team: TeamPanelData;
  /** CRM name of the member whose dialog is open, or null. */
  activeKey: string | null;
  /** Called with the clicked member, or null when the active member is clicked again. */
  onSelect: (member: TeamMemberChip | null) => void;
  /** What to print when the team has no members — visibility.ts teamEmptyState(). */
  empty: { title: string; hint?: string };
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  // Index of the first chip on a row past COLLAPSED_ROWS; null when every chip fits.
  const [cut, setCut] = useState<number | null>(null);

  const total = team.members.length;
  const needle = query.trim().toLowerCase();
  const searching = needle !== '';

  const shown = useMemo(
    () => (needle
      ? team.members.filter((m) => m.label.toLowerCase().includes(needle) || m.key.toLowerCase().includes(needle))
      : team.members),
    [team.members, needle],
  );

  /* ── row measurement ────────────────────────────────────────────────────── */

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    // The list is `relative`, so each chip's offsetTop is in list space. Clipped
    // and invisible chips keep their layout, so collapsed or expanded this reads
    // the same row breaks.
    const chips = Array.from(list.children) as HTMLElement[];
    let rows = 0;
    let rowTop = -Infinity;
    let next: number | null = null;
    for (let i = 0; i < chips.length; i++) {
      const top = chips[i].offsetTop;
      if (top <= rowTop + 1) continue;
      rows += 1;
      rowTop = top;
      if (rows > COLLAPSED_ROWS) {
        next = i;
        break;
      }
    }
    setCut(next);
  }, []);

  // Before paint, so a collapsed list never flashes the wrong chips.
  useLayoutEffect(() => { measure(); }, [measure, shown]);

  // A width change, or the Mulish webfont swapping in, moves the row breaks.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(list);
    for (const chip of Array.from(list.children)) ro.observe(chip);
    return () => ro.disconnect();
  }, [measure, shown]);

  const canCollapse = !searching && cut !== null;
  const collapsed = canCollapse && !expanded;

  // The Clear Search button unmounts with the empty state; hand focus back to the input.
  const clearSearch = () => {
    setQuery('');
    searchRef.current?.focus();
  };

  /* ── render ─────────────────────────────────────────────────────────────── */

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h2 className="text-base font-semibold text-ink-900">Team</h2>
          <p className="text-sm text-muted-foreground">
            <span
              className="font-medium text-foreground"
              title={team.teams.length > 1 ? team.teams.join(', ') : undefined}
            >
              {team.name || '—'}
            </span>
            {' · '}
            <span
              className="tabular-nums"
              title="Distinct members listed below. The Team Members tile counts the roster as uploaded, so it can be higher."
            >
              {searching ? `${shown.length} Of ${total}` : total}{total === 1 ? ' Member' : ' Members'}
            </span>
          </p>
        </div>

        {total === 0 ? (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{empty.title}</p>
            {empty.hint && <p className="text-xs text-muted-foreground">{empty.hint}</p>}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="relative w-full sm:w-64">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) setQuery(''); }}
                  placeholder="Search Member…"
                  aria-label="Search Team Members"
                  className="h-8 pl-8"
                />
              </div>
              <p className="text-xs text-muted-foreground">Click A Member To See Their Productivity And Revenue</p>
            </div>

            <p className="sr-only" aria-live="polite">
              {searching ? `${shown.length} Of ${total} Members Match` : ''}
            </p>

            {shown.length === 0 ? (
              <div className="flex flex-col items-center gap-1 rounded-md border border-dashed px-3 py-6 text-center">
                <SearchX aria-hidden className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No Members Match “{query.trim()}”</p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 focus-visible:underline"
                  onClick={clearSearch}
                >
                  Clear Search
                </Button>
              </div>
            ) : (
              /*
               * p-0.5 / -m-0.5 leave room for the chips' 2px focus ring inside
               * the collapsed clip. Clip height = two h-8 rows + one gap-2 + that
               * padding: 2rem + 0.5rem + 2rem + 0.25rem.
               */
              <ul
                id={listId}
                ref={listRef}
                className={cn('relative -m-0.5 flex flex-wrap gap-2 p-0.5', collapsed && 'max-h-[4.75rem] overflow-hidden')}
              >
                {shown.map((m, i) => {
                  const active = m.key === activeKey;
                  return (
                    <li key={m.key} className={cn('flex min-w-0', collapsed && cut !== null && i >= cut && 'invisible')}>
                      {/* `border` on both variants keeps a chip's width when it turns
                          active, so selecting a member never re-wraps the rows. */}
                      <Button
                        type="button"
                        size="sm"
                        variant={active ? 'default' : 'outline'}
                        aria-pressed={active}
                        title={m.label !== m.key ? `${m.label}\nCRM Name: ${m.key}` : m.label}
                        onClick={() => onSelect(active ? null : m)}
                        className={cn(
                          'h-8 min-w-0 gap-2 rounded-full border pl-1 pr-3 focus-visible:ring-2 focus-visible:ring-primary/40',
                          active ? 'border-primary' : 'hover:border-ink-300',
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold leading-none tracking-tight',
                            active && 'bg-primary-foreground text-primary',
                          )}
                          style={active ? undefined : avatarStyle(m.key)}
                        >
                          {initialsOf(m.label)}
                        </span>
                        <span className="max-w-[16rem] truncate">{m.label}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            {canCollapse && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setExpanded((x) => !x)}
                  className="gap-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {expanded ? 'Show Less' : `Show All (${total})`}
                  {expanded ? <ChevronUp aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
