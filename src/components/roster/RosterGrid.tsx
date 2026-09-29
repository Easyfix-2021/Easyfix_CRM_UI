'use client';

/*
 * Manage Roster tab — the grid itself.
 *
 * SIMPLIFICATION (ponytail, first cut): the spec asks for a sticky
 * "Member (name) + Emp Code + Shift" first column. Rather than freezing
 * THREE separate columns (which needs manual per-column `left` offsets —
 * see the multi-column note in globals.css above `.stick-left`), all three
 * are rendered inside ONE frozen cell (checkbox + name + emp code + shift
 * input stacked together). One `.stick-col`/`.stick-left` pair, no offset
 * math. Upgrade path: split into real per-column freezing if operators ask
 * for the shift input to line up in its own column.
 *
 * Dirty edits live in a `Map<"userId|date", RosterCellInput>` overlay on
 * top of the server's `members[].days[date]` — every render effect
 * (chip look, footer On Duty count, per-row warning) is derived from that
 * merged view, never from the server payload alone, so the UI reflects
 * unsaved edits immediately.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Wand2, Copy, RotateCcw, Download, Flag, AlertTriangle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { ShiftSelect, DEFAULT_SHIFT } from './ShiftSelect';
import { cn } from '@/lib/utils';
import {
  addMonthsYmd, dayOfMonth, daysBetweenInclusive, formatRangeLabel, formatYmdLabel,
  fullWeeksIn, istTodayYmd, monthKey, nextAnchor, rangeFor, startOfMonth, weekdayShort,
  type RosterView,
} from './roster-dates';
import type { DayType, RosterCellInput, RosterMember, RosterResponse } from './types';
import { FillPatternDialog } from './FillPatternDialog';

/* Footer "On Duty" turns red when fewer than this many people beyond the
 * bare team size are on — named so the threshold isn't a magic number
 * buried in a JSX className. */
const ON_DUTY_WARN_SLACK = 2;

function cellKey(userId: number, date: string): string {
  return `${userId}|${date}`;
}

type EffectiveCell = { type: DayType; source: 'ROSTER' | 'WEEKLY'; dirty: boolean };

function effectiveCell(member: RosterMember, date: string, dirty: Map<string, RosterCellInput>): EffectiveCell {
  const d = dirty.get(cellKey(member.userId, date));
  if (d) return { type: d.dayType, source: 'ROSTER', dirty: true };
  const c = member.days[date];
  return { type: c?.type ?? 'WO', source: c?.source ?? 'WEEKLY', dirty: false };
}

function cellDimmed(member: RosterMember, date: string, win: { today: string; editFrom: string; editTo: string }): boolean {
  return !member.editable || date < win.today || date < win.editFrom || date > win.editTo;
}

/** PR -> success tokens, WO -> neutral tokens — reused for the chip AND the legend. */
function chipClasses(type: DayType, style: 'solid' | 'dashed'): string {
  if (style === 'solid') {
    return type === 'PR' ? 'bg-success-tint text-success-strong border-transparent' : 'bg-neutral-tint text-neutral-strong border-transparent';
  }
  return type === 'PR'
    ? 'bg-card text-success-strong border-success border-dashed'
    : 'bg-card text-neutral-strong border-neutral border-dashed';
}

function DayChip({ type, style, dimmed }: { type: DayType; style: 'solid' | 'dashed'; dimmed?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[2.25rem] items-center justify-center rounded-full border px-2 py-0.5 text-xs font-semibold',
        chipClasses(type, style),
        dimmed && 'opacity-40',
      )}
    >
      {type}
    </span>
  );
}

export function RosterGrid() {
  const confirm = useConfirm();

  const [teamOf, setTeamOf] = useState('');
  const [view, setView] = useState<RosterView>('week');
  const [anchor, setAnchor] = useState(() => istTodayYmd());
  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState<Map<string, RosterCellInput>>(new Map());
  const [rowShift, setRowShift] = useState<Record<number, string>>({});
  const [fillOpen, setFillOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<'copy' | 'reset' | null>(null);

  const qs = new URLSearchParams({ from, to });
  if (teamOf) qs.set('teamOf', teamOf);
  const key = `/admin/roster?${qs.toString()}`;
  const { data, loading, error, refetch } = useFetch<RosterResponse>(key);

  const members = data?.members ?? [];
  const managers = data?.managers ?? [];
  const dates = data?.dates ?? [];
  const holidays = data?.holidays ?? [];
  const win = data?.window;

  const holidaysByDate = useMemo(() => new Map(holidays.map((h) => [h.date, h.name])), [holidays]);
  const editableMembers = useMemo(() => members.filter((m) => m.editable), [members]);
  const managerOptions: SearchOption[] = useMemo(
    () => managers.map((m) => ({ value: m.userId, label: m.name })),
    [managers],
  );

  const headcountLive = useMemo(() => {
    const map = new Map<string, { onDuty: number; total: number }>();
    for (const date of dates) {
      let onDuty = 0;
      for (const m of members) if (effectiveCell(m, date, dirty).type === 'PR') onDuty++;
      map.set(date, { onDuty, total: members.length });
    }
    return map;
  }, [dates, members, dirty]);

  const fullWeeks = useMemo(() => fullWeeksIn(dates), [dates]);
  const rowWarnings = useMemo(() => {
    const set = new Set<number>();
    for (const m of members) {
      for (const week of fullWeeks) {
        const hasWO = week.some((date) => effectiveCell(m, date, dirty).type === 'WO');
        if (!hasWO) { set.add(m.userId); break; }
      }
    }
    return set;
  }, [members, fullWeeks, dirty]);

  // Browser-level exit guard — a hard nav (tab close, refresh) can't be
  // intercepted by useConfirm, so arm the native prompt while dirty.
  useEffect(() => {
    if (dirty.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function clearDirtyFor(userIds: number[]) {
    setDirty((prev) => {
      const next = new Map(prev);
      for (const k of Array.from(next.keys())) {
        if (userIds.includes(Number(k.split('|')[0]))) next.delete(k);
      }
      return next;
    });
  }

  function refreshAll() {
    invalidateFetch((k) => k.startsWith('/admin/roster'));
    refetch();
  }

  function toggleCell(member: RosterMember, date: string) {
    if (!win || cellDimmed(member, date, win)) return;
    const current = effectiveCell(member, date, dirty);
    const nextType: DayType = current.type === 'PR' ? 'WO' : 'PR';
    const shiftStart = nextType === 'PR' ? (rowShift[member.userId] ?? member.defaultShift ?? DEFAULT_SHIFT) : null;
    setDirty((prev) => {
      const next = new Map(prev);
      next.set(cellKey(member.userId, date), { userId: member.userId, date, dayType: nextType, shiftStart });
      return next;
    });
  }

  function onRowShiftChange(userId: number, value: string) {
    setRowShift((s) => ({ ...s, [userId]: value }));
    // Per spec: the row's shift input applies to that row's ALREADY-dirty
    // (planned-change) cells. A cell toggled after this point picks up the
    // new value naturally via toggleCell's `rowShift[...] ?? defaultShift`.
    setDirty((prev) => {
      const next = new Map(prev);
      for (const [k, cell] of prev) {
        if (cell.userId === userId && cell.dayType === 'PR') next.set(k, { ...cell, shiftStart: value || null });
      }
      return next;
    });
  }

  function toggleSelect(userId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }
  const allEditableSelected = editableMembers.length > 0 && editableMembers.every((m) => selected.has(m.userId));
  function toggleSelectAll() {
    setSelected((prev) => {
      if (allEditableSelected) return new Set();
      return new Set(editableMembers.map((m) => m.userId));
    });
  }

  /** Selected editable members, or every editable member in view if none picked. */
  function scopeUserIds(): number[] {
    const chosen = members.filter((m) => selected.has(m.userId) && m.editable).map((m) => m.userId);
    return chosen.length ? chosen : editableMembers.map((m) => m.userId);
  }

  function onTeamChange(next: string) {
    if (dirty.size === 0) { setTeamOf(next); return; }
    void (async () => {
      const ok = await confirm({
        title: 'Switch Team?',
        description: `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'} for the current team will be discarded.`,
        confirmLabel: 'Switch & Discard',
        variant: 'destructive',
      });
      if (ok) { setDirty(new Map()); setTeamOf(next); }
    })();
  }

  async function save() {
    if (dirty.size === 0) return;
    setSaving(true);
    const toastId = showToast({ variant: 'loading', message: 'Saving Roster…' });
    try {
      await api.put('/admin/roster/cells', { cells: Array.from(dirty.values()) });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Roster Saved' });
      setDirty(new Map());
      refreshAll();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Save Failed' });
    } finally {
      setSaving(false);
    }
  }

  async function discard() {
    if (dirty.size === 0) return;
    const ok = await confirm({
      title: 'Discard Unsaved Changes?',
      description: `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'} will be lost.`,
      confirmLabel: 'Discard',
      variant: 'destructive',
    });
    if (ok) setDirty(new Map());
  }

  async function copyPreviousMonth() {
    const scope = scopeUserIds();
    if (!scope.length) { showToast({ variant: 'error', message: 'No Editable Members In View' }); return; }
    const toMonth = monthKey(anchor);
    const fromMonth = monthKey(addMonthsYmd(startOfMonth(anchor), -1));
    const ok = await confirm({
      title: 'Copy Previous Month?',
      description: `Repeats each of the ${scope.length} selected member's weekday pattern from ${fromMonth} across ${toMonth}, within the editable window. Hand-edited days in ${toMonth} are kept; members with nothing planned in ${fromMonth} are skipped.`,
      confirmLabel: 'Copy',
    });
    if (!ok) return;
    setBusyAction('copy');
    const toastId = showToast({ variant: 'loading', message: 'Copying Previous Month…' });
    try {
      await api.post('/admin/roster/copy-month', { userIds: scope, fromMonth, toMonth });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Previous Month Copied' });
      clearDirtyFor(scope);
      refreshAll();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Copy Failed' });
    } finally {
      setBusyAction(null);
    }
  }

  async function resetToWeekly() {
    const scope = scopeUserIds();
    if (!scope.length) { showToast({ variant: 'error', message: 'No Editable Members In View' }); return; }
    // Clamp the visible range to the edit window — the default view includes
    // today and past days, which the backend rejects (past is locked).
    if (!win) return;
    const resetFrom = from > win.editFrom ? from : win.editFrom;
    const resetTo = to < win.editTo ? to : win.editTo;
    if (resetFrom > resetTo) { showToast({ variant: 'error', message: 'Nothing Editable In This Range' }); return; }
    const ok = await confirm({
      title: 'Reset To Weekly Days?',
      description: `Removes planned overrides for ${scope.length} member(s) between ${formatYmdLabel(resetFrom)} and ${formatYmdLabel(resetTo)}; those days fall back to each member's weekly working days.`,
      confirmLabel: 'Reset',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusyAction('reset');
    const toastId = showToast({ variant: 'loading', message: 'Resetting To Weekly Days…' });
    try {
      await api.post('/admin/roster/reset', { userIds: scope, from: resetFrom, to: resetTo });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Reset To Weekly Days' });
      clearDirtyFor(scope);
      refreshAll();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reset Failed' });
    } finally {
      setBusyAction(null);
    }
  }

  async function exportExcel() {
    const month = monthKey(anchor);
    const exportQs = new URLSearchParams({ month });
    if (teamOf) exportQs.set('teamOf', teamOf);
    try {
      await downloadXlsx({ url: `/admin/roster/export?${exportQs.toString()}`, filename: `team-roster-${month}.xlsx` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Export Failed' });
    }
  }

  const actionsBusy = saving || busyAction !== null;
  const colSpan = dates.length + 2;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Team:</span>
            <SearchSelect
              value={teamOf}
              onChange={onTeamChange}
              options={managerOptions}
              placeholder="My Team"
              className="w-48"
            />
          </div>
          <div className="flex items-center rounded-md border overflow-hidden">
            <button
              type="button"
              onClick={() => setView('week')}
              className={cn('px-3 py-1.5 text-xs font-medium', view === 'week' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}
            >
              Week
            </button>
            <button
              type="button"
              onClick={() => setView('month')}
              className={cn('px-3 py-1.5 text-xs font-medium', view === 'month' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}
            >
              Month
            </button>
          </div>
          <div className="flex items-center gap-1">
            <IconButton icon={ChevronLeft} label="Previous" onClick={() => setAnchor((a) => nextAnchor(view, a, -1))} />
            <span className="min-w-[170px] text-center text-sm font-medium">{from && to ? formatRangeLabel(from, to) : '—'}</span>
            <IconButton icon={ChevronRight} label="Next" onClick={() => setAnchor((a) => nextAnchor(view, a, 1))} />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={actionsBusy} onClick={() => setFillOpen(true)}>
              <Wand2 className="size-4 mr-1" /> Fill From Pattern
            </Button>
            <Button variant="outline" size="sm" disabled={actionsBusy} onClick={copyPreviousMonth}>
              <Copy className="size-4 mr-1" /> Copy Previous Month
            </Button>
            <Button variant="outline" size="sm" disabled={actionsBusy} onClick={resetToWeekly}>
              <RotateCcw className="size-4 mr-1" /> Reset To Weekly Days
            </Button>
            <Button variant="outline" size="sm" onClick={exportExcel}>
              <Download className="size-4 mr-1" /> Export Excel
            </Button>
          </div>
          {win && (
            <div className="w-full text-xs text-muted-foreground">
              Editable: {formatYmdLabel(win.editFrom)} → {formatYmdLabel(win.editTo)}
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 text-sm text-urgent">{error}</CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="data-table head-sticky w-full">
              <thead>
                <tr>
                  <th className="stick-col-head stick-left !text-left" style={{ minWidth: 200 }}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allEditableSelected}
                        onChange={toggleSelectAll}
                        aria-label="Select All Editable Members"
                      />
                      <span>Member / Emp Code / Shift</span>
                    </div>
                  </th>
                  {dates.map((date) => {
                    const holidayName = holidaysByDate.get(date);
                    return (
                      <th
                        key={date}
                        className={cn('!text-center', holidayName && 'bg-urgent-tint')}
                        style={{ minWidth: 60 }}
                        title={holidayName ? `Holiday: ${holidayName}` : undefined}
                      >
                        <div className="flex flex-col items-center gap-0.5 leading-tight">
                          {holidayName && <Flag className="size-3 text-urgent-strong" aria-label="Holiday" />}
                          <span className="text-xs uppercase text-muted-foreground">{weekdayShort(date)}</span>
                          <span className="text-sm font-semibold">{dayOfMonth(date)}</span>
                        </div>
                      </th>
                    );
                  })}
                  <th className="!text-center" style={{ minWidth: 48 }}>Warn</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={colSpan} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!loading && members.length === 0 && (
                  <tr><td colSpan={colSpan} className="!text-center text-muted-foreground py-6">No Members In View</td></tr>
                )}
                {!loading && members.map((member) => (
                  <tr key={member.userId}>
                    <td className="stick-col stick-left !text-left align-top">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={!member.editable}
                          checked={selected.has(member.userId)}
                          onChange={() => toggleSelect(member.userId)}
                          aria-label={`Select ${member.name}`}
                        />
                        <div>
                          <div className="font-medium">{member.name}</div>
                          <div className="text-xs text-muted-foreground">{member.empCode} · {member.roleName}</div>
                          <ShiftSelect
                            value={rowShift[member.userId] ?? member.defaultShift ?? DEFAULT_SHIFT}
                            onChange={(v) => onRowShiftChange(member.userId, v)}
                            disabled={!member.editable}
                            title="Shift Start"
                            className="mt-1 h-7 w-28 px-1 text-xs"
                          />
                        </div>
                      </div>
                    </td>
                    {dates.map((date) => {
                      const dimmed = !win || cellDimmed(member, date, win);
                      const eff = effectiveCell(member, date, dirty);
                      const style: 'solid' | 'dashed' = eff.dirty || eff.source === 'ROSTER' ? 'solid' : 'dashed';
                      const holidayName = holidaysByDate.get(date);
                      return (
                        <td key={date} className={cn('!text-center', holidayName && 'bg-urgent-tint/30')}>
                          {dimmed ? (
                            <div className="flex justify-center py-1 cursor-not-allowed" title="Past / Locked">
                              <DayChip type={eff.type} style={style} dimmed />
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleCell(member, date)}
                              className="flex w-full justify-center py-1 hover:opacity-80"
                              title={`${eff.type} — Click To Toggle`}
                            >
                              <DayChip type={eff.type} style={style} />
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="!text-center">
                      {rowWarnings.has(member.userId) && (
                        <span title="Has A Full Monday–Sunday Week With No Week Off">
                          <AlertTriangle className="inline size-4 text-warning-strong" aria-label="No Week Off This Week" />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {!loading && members.length > 0 && (
                <tfoot>
                  <tr className="bg-muted/40 font-medium">
                    <td className="stick-col stick-left !text-left">On Duty</td>
                    {dates.map((date) => {
                      const hc = headcountLive.get(date);
                      const warn = !!hc && hc.onDuty < hc.total - ON_DUTY_WARN_SLACK;
                      return (
                        <td key={date} className={cn('!text-center tabular-nums', warn && 'text-urgent')}>
                          {hc ? `${hc.onDuty}/${hc.total}` : '—'}
                        </td>
                      );
                    })}
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><DayChip type="PR" style="solid" /> Planned PR/WO (Solid)</span>
            <span className="flex items-center gap-1.5"><DayChip type="PR" style="dashed" /> From Weekly Days (Dashed)</span>
            <span className="flex items-center gap-1.5"><DayChip type="WO" style="solid" dimmed /> Past / Locked</span>
            <span className="flex items-center gap-1.5"><Flag className="size-3 text-urgent-strong" /> Holiday</span>
          </div>

          <div className="flex items-center justify-end gap-3 border-t px-3 py-2">
            {dirty.size > 0 && (
              <span className="text-xs font-medium text-warning-strong">
                {dirty.size} Unsaved Change{dirty.size === 1 ? '' : 's'}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={discard} disabled={dirty.size === 0 || saving}>Discard</Button>
            <Button size="sm" onClick={save} disabled={dirty.size === 0 || saving}>Save Changes</Button>
          </div>
        </CardContent>
      </Card>

      <FillPatternDialog
        open={fillOpen}
        onOpenChange={setFillOpen}
        members={editableMembers}
        defaultFrom={win?.editFrom ?? from}
        defaultTo={win?.editTo ?? to}
        onApplied={(userIds) => { clearDirtyFor(userIds); refreshAll(); }}
      />
    </div>
  );
}
