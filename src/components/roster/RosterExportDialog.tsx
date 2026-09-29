'use client';

/*
 * Team Roster → Export. v2 contract: GET /admin/roster/export?from=&to=&teamOf=
 * (was ?month=), span ≤ 93 days, same teamOf semantics as the grid.
 *
 * "Duration" offers two one-click presets anchored on today (IST) plus a
 * Custom range. Both presets are well inside the 93-day cap (a calendar
 * month is never more than 31 days, three of them never more than ~92), so
 * the inline validation only has real teeth for Custom.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DownloadButton } from '@/components/ui/download-button';
import { showToast } from '@/components/ui/toast';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { addDaysYmd, addMonthsYmd, daysBetweenInclusive, istTodayYmd } from './roster-dates';

const EXPORT_SPAN_CAP_DAYS = 93;

type Duration = '1m' | '3m' | 'custom';

export function RosterExportDialog({
  open,
  onClose,
  teamOf,
}: {
  open: boolean;
  onClose: () => void;
  /** Current Team filter from the grid toolbar — carried into the export. */
  teamOf: string;
}) {
  const today = istTodayYmd();
  const [duration, setDuration] = useState<Duration>('1m');
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(addDaysYmd(today, EXPORT_SPAN_CAP_DAYS - 1));
  const [exporting, setExporting] = useState(false);

  // Reset to defaults every time the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setDuration('1m');
    setCustomFrom(today);
    setCustomTo(addDaysYmd(today, EXPORT_SPAN_CAP_DAYS - 1));
    // `today` is stable for the component's lifetime (computed once above) —
    // re-running this on every render would fight the operator's typing.
  }, [open]);

  const from = duration === 'custom' ? customFrom : today;
  const to = duration === '1m' ? addDaysYmd(addMonthsYmd(today, 1), -1)
    : duration === '3m' ? addDaysYmd(addMonthsYmd(today, 3), -1)
    : customTo;

  const rangeError =
    !from || !to ? 'Pick A From And To Date.'
    : to < from ? 'To Must Be On Or After From.'
    : daysBetweenInclusive(from, to) > EXPORT_SPAN_CAP_DAYS ? `Range Can't Exceed ${EXPORT_SPAN_CAP_DAYS} Days.`
    : null;

  async function doExport() {
    if (rangeError) return;
    setExporting(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (teamOf) qs.set('teamOf', teamOf);
      await downloadXlsx({ url: `/admin/roster/export?${qs.toString()}`, filename: `team-roster-${from}-to-${to}.xlsx` });
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Export Failed' });
    } finally {
      setExporting(false);
    }
  }

  // Nothing here is worth confirming on close (a picked Duration isn't
  // "unsaved input"), but the repo lint requires every <Dialog> close path —
  // Esc / X / overlay-click — to route through this hook.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => false });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export Roster</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-1 block">Duration</Label>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="export-duration" checked={duration === '1m'} onChange={() => setDuration('1m')} />
                1 Month (From Today)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="export-duration" checked={duration === '3m'} onChange={() => setDuration('3m')} />
                3 Months (From Today)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="export-duration" checked={duration === 'custom'} onChange={() => setDuration('custom')} />
                Custom
              </label>
            </div>
          </div>

          {duration === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-1 block">From</Label>
                <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block">To</Label>
                <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </div>
          )}

          {rangeError && <p className="text-xs text-urgent">{rangeError}</p>}
        </div>

        <DialogFooter>
          <DownloadButton
            onClick={() => void doExport()}
            disabled={!!rangeError}
            downloading={exporting}
            label="Export"
            loadingLabel="Exporting…"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
