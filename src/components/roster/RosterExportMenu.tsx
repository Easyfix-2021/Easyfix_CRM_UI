'use client';

/*
 * Team Roster → Export, as a dropdown off the green Export button (owner,
 * 2026-09-29: "export button on click dropdown instead of popup modal").
 * GET /admin/roster/export?from=&to=&teamOf= — span ≤ 186 days (~6 months), same teamOf
 * semantics as the grid.
 *
 * The two presets download on click. Custom is an inline From/To form inside
 * the same menu; its wrapper stops keydown propagation because Radix menus
 * run typeahead on character keys — typing "1" into a date field would
 * otherwise jump focus to "1 Month (From Today)".
 */

import { useState } from 'react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { DownloadButton } from '@/components/ui/download-button';
import { showToast } from '@/components/ui/toast';
import { downloadXlsx } from '@/lib/download-xlsx';
import { addDaysYmd, addMonthsYmd, daysBetweenInclusive, istTodayYmd } from './roster-dates';

const EXPORT_SPAN_CAP_DAYS = 186; // must match EXPORT_MAX_DAYS in routes/admin/roster.js

export function RosterExportMenu({ teamOf }: { teamOf: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  function onOpenChange(next: boolean) {
    if (next) {
      // Fresh defaults each open: today → today + 3 months.
      const today = istTodayYmd();
      setCustomFrom(today);
      setCustomTo(addDaysYmd(addMonthsYmd(today, 3), -1));
    }
    setOpen(next);
  }

  const rangeError =
    !customFrom || !customTo ? 'Pick A From And To Date.'
    : customTo < customFrom ? 'To Must Be On Or After From.'
    : daysBetweenInclusive(customFrom, customTo) > EXPORT_SPAN_CAP_DAYS
      ? `Pick Up To ${EXPORT_SPAN_CAP_DAYS} Days (About 6 Months) — This Range Is ${daysBetweenInclusive(customFrom, customTo)} Days.`
    : null;

  async function doExport(from: string, to: string) {
    setOpen(false);
    setExporting(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (teamOf) qs.set('teamOf', teamOf);
      await downloadXlsx({ url: `/admin/roster/export?${qs.toString()}`, filename: `team-roster-${from}-to-${to}.xlsx` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Export Failed' });
    } finally {
      setExporting(false);
    }
  }

  function preset(months: number) {
    const today = istTodayYmd();
    void doExport(today, addDaysYmd(addMonthsYmd(today, months), -1));
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <DownloadButton label="Export" loadingLabel="Exporting…" downloading={exporting} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={() => preset(1)}>1 Month (From Today)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => preset(3)}>3 Months (From Today)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Custom</DropdownMenuLabel>
        <div className="space-y-2 px-2 pb-2" onKeyDown={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">
              From
              <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1 h-8 px-1.5 text-xs" />
            </label>
            <label className="text-xs text-muted-foreground">
              To
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="mt-1 h-8 px-1.5 text-xs" />
            </label>
          </div>
          {rangeError && <p className="text-xs text-urgent">{rangeError}</p>}
          <DownloadButton
            label="Export"
            disabled={!!rangeError}
            onClick={() => void doExport(customFrom, customTo)}
            className="md:w-full"
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
