'use client';

/*
 * QuickSight — Employee Performance, section 0 "Team".
 *
 * The dashboard's team panel (dashboard.html render(): "Team Name" +
 * "Team Members") in CRM styling. Data is summary.team from
 * aggregate.js buildSummary — the team name ('All Teams' when the selected
 * SPOCs span several) and the de-duplicated, sorted member list.
 *
 * Each member is a Button (keyboard-focusable, aria-pressed) rather than a
 * StatusChip / Badge span. Clicking a member opens MemberDetailDialog;
 * clicking the active member again closes it, as on the dashboard.
 *
 * No member count is shown on purpose: the Team Members KPI counts the roster
 * as uploaded (duplicates included), so a count of these chips would disagree
 * with the tile above.
 */

import { Button } from '@/components/ui/button';
import { SectionCard } from './sections/shared';
import type { TeamMemberChip, TeamPanel as TeamPanelData } from './types';

export function TeamPanel({
  team,
  activeKey,
  onSelect,
}: {
  team: TeamPanelData;
  /** CRM name of the member whose dialog is open, or null. */
  activeKey: string | null;
  /** Called with the clicked member, or null when the active member is clicked again. */
  onSelect: (member: TeamMemberChip | null) => void;
}) {
  return (
    <SectionCard title="0. Team">
      <div className="space-y-0.5">
        <div className="text-xs font-medium text-muted-foreground">Team Name</div>
        <div
          className="text-base font-semibold text-ink-900"
          title={team.teams.length > 1 ? team.teams.join(', ') : undefined}
        >
          {team.name || '—'}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs font-medium text-muted-foreground">Team Members</div>
          {team.members.length > 0 && (
            <div className="text-xs text-muted-foreground">Click A Member To See Their Productivity And Revenue</div>
          )}
        </div>
        {team.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Team Members For The Selected Filters</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {team.members.map((m) => {
              const active = m.key === activeKey;
              return (
                <Button
                  key={m.key}
                  type="button"
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  aria-pressed={active}
                  title={m.label !== m.key ? `CRM Name: ${m.key}` : undefined}
                  onClick={() => onSelect(active ? null : m)}
                >
                  {m.label}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
