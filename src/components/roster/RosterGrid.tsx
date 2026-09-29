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
 * (chip look, footer On Duty count) is derived from that merged view,
 * never from the server payload alone, so the UI reflects unsaved edits
 * immediately.
 *
 * v2 (roster-v2-contract.md): a client-side search box (Emp Code + name)
 * filters the visible member rows; the On Duty footer and "select all"
 * count only that filtered set. Copy Previous Month is gone (endpoint
 * removed), and Export is a dropdown (RosterExportMenu) that
 * picks a from/to range instead of a single month.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Wand2, RotateCcw, Bell, CalendarDays, Search, FileSpreadsheet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { ShiftSelect, DEFAULT_SHIFT } from './ShiftSelect';
import { cn } from '@/lib/utils';
import {
  formatRangeLabel, formatYmdLabel, istTodayYmd, nextAnchor, rangeFor, weekdayShort,
  type RosterView,
} from './roster-dates';
import type { DayType, RosterCellInput, RosterMember, RosterResponse } from './types';
import { FillPatternDialog } from './FillPatternDialog';
import { RosterBulkDialog } from './RosterBulkDialog';
import { RosterCalendarDialog } from './RosterCalendarDialog';
import { RosterExportMenu } from './RosterExportMenu';

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

/** Case-insensitive substring match on Emp Code + name — the toolbar's search box. */
function matchesSearch(member: RosterMember, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (member.empCode ?? '').toLowerCase().includes(needle) || member.name.toLowerCase().includes(needle);
}

export function RosterGrid() {
  const confirm = useConfirm();

  const [search, setSearch] = useState('');
  const [teamOf, setTeamOf] = useState('');
  const [view, setView] = useState<RosterView>('week');
  const [anchor, setAnchor] = useState(() => istTodayYmd());
  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState<Map<string, RosterCellInput>>(new Map());
  const [rowShift, setRowShift] = useState<Record<number, string>>({});
  const [fillOpen, setFillOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<'reset' | null>(null);

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
  // The full (unfiltered) editable roster — feeds Fill From Pattern and the
  // "no one selected" fallback scope for Reset. Search never shrinks these.
  const editableMembers = useMemo(() => members.filter((m) => m.editable), [members]);
  const teamOptions: SearchOption[] = useMemo(
    () => [{ value: '', label: 'All Employees' }, ...managers.map((m) => ({ value: m.userId, label: m.name }))],
    [managers],
  );

  // The search-filtered view — what's actually rendered as rows, and the set
  // the On Duty footer / "select all" count (contract: visible members only).
  const filteredMembers = useMemo(() => members.filter((m) => matchesSearch(m, search)), [members, search]);
  const visibleEditableMembers = useMemo(() => filteredMembers.filter((m) => m.editable), [filteredMembers]);

  const headcountLive = useMemo(() => {
    const map = new Map<string, { onDuty: number; total: number }>();
    for (const date of dates) {
      let onDuty = 0;
      for (const m of filteredMembers) if (effectiveCell(m, date, dirty).type === 'PR') onDuty++;
      map.set(date, { onDuty, total: filteredMembers.length });
    }
    return map;
  }, [dates, filteredMembers, dirty]);

  const [calendarFor, setCalendarFor] = useState<{ userId: number; name: string } | null>(null);
  const [notifyingId, setNotifyingId] = useState<number | null>(null);

  // Browser-level exit guard — a hard nav (tab close, refresh) can't be
  // intercepted by useConfirm, so arm the native prompt while dirty.
  useEffect(() => {
    if (dirty.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  /* Sends the employee their roster for the range in view to their CRM inbox
     (the backend clips a past start to today). Unsaved changes are NOT sent —
     it says so, rather than notifying a plan that isn't stored yet. */
  async function notifyMember(member: RosterMember) {
    const unsaved = Array.from(dirty.values()).some((c) => c.userId === member.userId);
    const ok = await confirm({
      title: 'Notify Employee?',
      description: `Send ${member.name} their roster for ${formatYmdLabel(from)} – ${formatYmdLabel(to)} in their CRM notifications.`
        + (unsaved ? ' They have unsaved changes — save first, or those will not be included.' : ''),
      confirmLabel: 'Notify',
    });
    if (!ok) return;
    setNotifyingId(member.userId);
    try {
      await api.post('/admin/roster/notify', { userIds: [member.userId], from, to });
      showToast({ variant: 'success', message: `Roster Sent To ${member.name}` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Notify Failed' });
    } finally {
      setNotifyingId(null);
    }
  }

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
  // "Select all" only ever touches what's currently VISIBLE (search-filtered)
  // — an operator searching "priya" and hitting select-all should not
  // silently pick up 60 people scrolled out of view.
  const allEditableSelected = visibleEditableMembers.length > 0 && visibleEditableMembers.every((m) => selected.has(m.userId));
  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allEditableSelected) {
        for (const m of visibleEditableMembers) next.delete(m.userId);
      } else {
        for (const m of visibleEditableMembers) next.add(m.userId);
      }
      return next;
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

  const actionsBusy = saving || busyAction !== null;
  const colSpan = dates.length + 2;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-col gap-3 p-3">
          {/* Row 1: search + Team filter (left) · Week / Month (right). */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] max-w-xs flex-1">
              <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search By Emp Code Or Name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Team:</span>
              <SearchSelect
                value={teamOf}
                onChange={onTeamChange}
                options={teamOptions}
                placeholder="All Employees"
                className="w-48"
              />
            </div>
            <div className="ml-auto flex items-center overflow-hidden rounded-md border">
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
          </div>

          {/* Row 2: range navigator (left) · actions (right). */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <IconButton icon={ChevronLeft} label="Previous" onClick={() => setAnchor((a) => nextAnchor(view, a, -1))} />
              <span className="min-w-[170px] text-center text-sm font-medium">{from && to ? formatRangeLabel(from, to) : '—'}</span>
              <IconButton icon={ChevronRight} label="Next" onClick={() => setAnchor((a) => nextAnchor(view, a, 1))} />
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={actionsBusy || !win} onClick={() => setBulkOpen(true)}>
                <FileSpreadsheet className="size-4 mr-1" /> Bulk Update
              </Button>
              <Button variant="outline" size="sm" disabled={actionsBusy} onClick={() => setFillOpen(true)}>
                <Wand2 className="size-4 mr-1" /> Fill From Pattern
              </Button>
              <Button variant="outline" size="sm" disabled={actionsBusy} onClick={resetToWeekly}>
                <RotateCcw className="size-4 mr-1" /> Reset To Weekly Days
              </Button>
              <RosterExportMenu teamOf={teamOf} />
            </div>
          </div>
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
                      <span>Employee</span>
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
                        {/* Same three lines in EVERY column — DD/MM, (Day), holiday
                            slot — so a holiday never shifts its column's text. The
                            slot is an invisible placeholder on ordinary days. */}
                        <div className="flex flex-col items-center gap-0.5 leading-tight">
                          <span className="text-sm font-semibold">{date.slice(8, 10)}/{date.slice(5, 7)}</span>
                          <span className="text-xs text-muted-foreground">({weekdayShort(date)})</span>
                          <span
                            className={cn(
                              'rounded-full px-1.5 text-xs font-medium',
                              holidayName ? 'bg-urgent-tint text-urgent-strong' : 'invisible',
                            )}
                            aria-hidden={!holidayName}
                          >
                            Holiday
                          </span>
                        </div>
                      </th>
                    );
                  })}
                  <th className="!text-center" style={{ minWidth: 80 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={colSpan} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!loading && filteredMembers.length === 0 && (
                  <tr><td colSpan={colSpan} className="!text-center text-muted-foreground py-6">No Members In View</td></tr>
                )}
                {!loading && filteredMembers.map((member) => (
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
                          {/* <EmpCode> · <Full Name> · <Role> — empCode is null for
                              most users; absent parts are skipped, never "()" or a
                              dangling " · ". */}
                          <div className="text-sm leading-snug">
                            {member.empCode && <span className="text-muted-foreground">{member.empCode} · </span>}
                            <span className="font-medium">{member.name}</span>
                            {member.roleName && <span className="text-muted-foreground"> · {member.roleName}</span>}
                          </div>
                          <ShiftSelect
                            value={rowShift[member.userId] ?? member.defaultShift ?? DEFAULT_SHIFT}
                            onChange={(v) => onRowShiftChange(member.userId, v)}
                            disabled={!member.editable}
                            title="Shift Start"
                            className="mt-1 w-36"
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
                      {/* Actions: Notify (roster → the employee's CRM inbox) and
                          Calendar (month view). */}
                      <div className="inline-flex items-center justify-center gap-2">
                        <IconButton
                          icon={Bell}
                          label={`Notify ${member.name} Of Their Roster (${formatYmdLabel(from)} – ${formatYmdLabel(to)})`}
                          intent="primary"
                          disabled={!member.editable}
                          busy={notifyingId === member.userId}
                          onClick={() => void notifyMember(member)}
                        />
                        <IconButton
                          icon={CalendarDays}
                          label={`Calendar View · ${member.name}`}
                          onClick={() => setCalendarFor({ userId: member.userId, name: member.name })}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              {!loading && filteredMembers.length > 0 && (
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
            <span className="flex items-center gap-1.5"><span className="rounded-full bg-urgent-tint text-urgent-strong px-1.5 text-xs font-medium">Holiday</span> Public Holiday (Hover For Name)</span>
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
        initialUserIds={[]}
        minDate={win?.editFrom ?? from}
        maxDate={win?.editTo ?? to}
      />
      <RosterBulkDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        members={editableMembers}
        initialUserIds={bulkOpen ? scopeUserIds() : []}
        editFrom={win?.editFrom ?? ''}
        editTo={win?.editTo ?? ''}
        onSaved={() => { clearDirtyFor(editableMembers.map((m) => m.userId)); refreshAll(); }}
      />
      <RosterCalendarDialog member={calendarFor} teamOf={teamOf} anchor={anchor} onClose={() => setCalendarFor(null)} />
    </div>
  );
}
