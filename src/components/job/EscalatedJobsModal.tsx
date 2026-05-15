'use client';

/*
 * EscalatedJobsModal — opens from the navbar's "Escalated Jobs" button.
 *
 * Replaces the earlier "navigate to /jobs?focus=escalated" behavior with
 * a dedicated modal that mirrors the legacy CRM's escalation surface.
 * Data source: GET /admin/jobs/escalated (Status filter open/closed/
 * pending). Column shape matches the legacy `escalateSearchResult.vm`:
 *   Date & Time Escalated | Job ID | Client | City | Job Stage |
 *   Current Status | No of Escalations | Escalated From | Reason For Escalation
 *
 * Click a row to drill into the underlying job (opens the standard
 * JobModal in view mode).
 */

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Search, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { Input } from '@/components/ui/input';
import { SearchSelect } from '@/components/ui/search-select';
import { api, ApiError } from '@/lib/api';
import { statusLabel, statusColorClass } from '@/lib/utils';
import { useSort, SortHeader } from '@/lib/use-sort';

/*
 * formatDateOnly / formatTimeOnly — split a single ISO/MySQL DATETIME
 * into the "date" part (e.g. "29 Apr 2026") and the "time" part
 * (e.g. "10:07 am"). The legacy escalation modal stacked these on
 * two lines per cell, which lets long lists stay readable without
 * the time pushing each cell wide.
 */
function formatDateOnly(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    const date = new Date(d);
    if (isNaN(+date)) return String(d);
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return String(d); }
}
function formatTimeOnly(d: string | null | undefined): string {
  if (!d) return '';
  try {
    const date = new Date(d);
    if (isNaN(+date)) return '';
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return ''; }
}

/*
 * escalationDurationLabel — humanises the time between when a job was
 * escalated and when it was resolved (or now, if still open).
 * Mirrors the legacy `calculateDateDiffinHrsMins` output style:
 *   - "332 days 10 hours" for long-running open escalations
 *   - "5 hours 23 mins"   for short ones
 *   - "—" if escalation_time is missing
 */
function escalationDurationLabel(
  escalatedAt: string | null,
  resolvedAt: string | null
): string {
  if (!escalatedAt) return '—';
  const start = new Date(escalatedAt);
  if (isNaN(+start)) return '—';
  const end = resolvedAt ? new Date(resolvedAt) : new Date();
  const diffMs = Math.max(0, +end - +start);
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ${mins} min${mins === 1 ? '' : 's'}`;
  return `${mins} min${mins === 1 ? '' : 's'}`;
}
import { JobModal, type JobModalMode } from './JobModal';

/*
 * InlineActionPicker — small dropdown rendered in each table cell.
 * Drives the Team Action / Completed Action / Closed Action columns
 * inside the EscalatedJobsModal. Uses a native <select> for density
 * (a SearchSelect popover would push the table layout around too
 * much when 13 rows × 3 columns of dropdowns share the viewport).
 *
 * `value === null` means "no action set yet" — the placeholder option
 * is auto-selected. Picking the placeholder clears the column to
 * NULL via the parent's onChange handler.
 */
function InlineActionPicker({
  value,
  options,
  onChange,
}: {
  value: number | null;
  options: Array<{ value: number; label: string }>;
  onChange: (v: number) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      className="border rounded h-7 px-1.5 text-[11px] bg-background min-w-[120px] focus:outline-none"
    >
      <option value="">— Not set —</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

type Row = {
  table_id: number;
  job_id: number;
  job_status: number | null;
  fk_easyfixter_id: number | null;
  escalated_time: string | null;
  resolved_time: string | null;
  escalation_closed_time: string | null;
  escalated_by: number | null;
  escalated_by_name: string | null;
  escalated_comments: string | null;
  no_of_escalations: number | null;
  escalated_from: string | null;
  client_name: string | null;
  city_name: string | null;
  job_stage_history: string | null;
  job_reference_id: string | null;
  client_ref_id: string | null;
  sub_job_id: number | null;
  requested_date_time: string | null;
  /* Workflow controls — editable inline. Values stored as ints per
   * legacy enums:
   *   inprogress_action 1..5  : Team Action
   *   completed_action  11|12 : Completed Action
   *   closed_action     15|16 : Closed Action (Resolved / Re-Open)
   */
  inprogress_action: number | null;
  completed_action: number | null;
  closed_action: number | null;
};

/*
 * Action enum values (verified against legacy
 * escalateSearchResult.vm:64-90):
 *   Team Action      → tbl_easyfixer_rating_by_customer.inprogress_action
 *   Completed Action → completed_action
 *   Closed Action    → closed_action
 */
const TEAM_ACTIONS = [
  { value: 1, label: 'Easy Fixer is Scheduled' },
  { value: 2, label: 'Convinced Customer For New Date' },
  { value: 3, label: 'Pending from client' },
  { value: 4, label: 'Fake Reschedule & OTA expected' },
  { value: 5, label: 'Customer Reschedule' },
];
const COMPLETED_ACTIONS = [
  { value: 11, label: 'Work Completed' },
  { value: 12, label: 'Grievance Resolved & on-the-same-page' },
];
const CLOSED_ACTIONS = [
  { value: 15, label: 'Resolved' },
  { value: 16, label: 'Re-Open' },
];

type Resp = { items: Row[]; total: number; limit: number; offset: number };

const STATUS_OPTIONS = [
  { value: 'open',    label: 'Open' },
  { value: 'closed',  label: 'Closed' },
  { value: 'pending', label: 'Pending' },
];

export function EscalatedJobsModal({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState('open');
  // `q` is a UI-only filter — matches caselessly across every visible
  // column on the currently loaded page (200 rows). The status
  // dropdown still drives a server-side refetch so the loaded page
  // contains what the operator wants to search through.
  const [q, setQ] = useState('');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected row → opens the standard JobModal in view mode so the
  // operator can drill into the underlying job.
  const [jobView, setJobView] = useState<{ open: boolean; jobId?: number }>({ open: false });

  /*
   * updateAction — PATCH a single workflow column for one escalation
   * row. Optimistically patches the local data so the operator sees
   * the new value instantly; on backend failure we re-fetch to
   * resync. Each cell handler passes ONLY the field it owns so
   * concurrent edits on different columns don't clobber each other.
   */
  async function updateAction(
    tableId: number,
    patch: { inprogress_action?: number; completed_action?: number; closed_action?: number },
  ) {
    setData((prev) => prev && {
      ...prev,
      items: prev.items.map((it) =>
        it.table_id === tableId ? { ...it, ...patch } : it
      ),
    });
    try {
      await api.patch(`/admin/jobs/escalated/${tableId}`, patch);
    } catch (e) {
      // Re-fetch on failure so the UI doesn't lie about persistence.
      setError(e instanceof ApiError ? e.message : 'Update failed');
      // Trigger a refresh by bumping debouncedQ in a no-op way.
      // (Simpler than re-running the fetch directly inside this handler.)
      setQ((s) => s);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    api.get<Resp>('/admin/jobs/escalated', { status, limit: 200 })
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load escalations');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, status]);

  /*
   * Client-side filter — runs over every visible field for the
   * currently-loaded page. Includes derived strings (status label,
   * date/time formatted views, escalation duration) so the operator
   * can search by what they see on the row, not just the underlying
   * column value.
   */
  const filteredItems = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.items;
    return data.items.filter((r) => {
      const haystacks: Array<string | number | null | undefined> = [
        r.job_id, r.client_name, r.city_name, r.job_stage_history,
        statusLabel(Number(r.job_status), { assigned: r.fk_easyfixter_id != null }),
        r.no_of_escalations, r.escalated_from, r.escalated_comments,
        r.escalated_by_name,
        formatDateOnly(r.escalated_time), formatTimeOnly(r.escalated_time),
        formatDateOnly(r.requested_date_time), formatTimeOnly(r.requested_date_time),
        escalationDurationLabel(r.escalated_time, r.resolved_time),
        (r.no_of_escalations ?? 0) > 1 ? 'reopened' : '',
      ];
      return haystacks.some((h) => h != null && String(h).toLowerCase().includes(needle));
    });
  }, [data, q]);

  const { sorted, sortKey, sortDir, toggle } = useSort<Row>(filteredItems);

  const [downloading, setDownloading] = useState(false);

  /*
   * Download — fetches the styled XLSX from the backend so the file
   * inherits the same brand band / header band / row banding as the
   * Call History export. Same fetch+blob+anchor pattern as
   * CallInfoModal.downloadXlsx — we can't use the JSON-parsing
   * `api.get` helper for a binary stream.
   *
   * Filter note: the download contains every row in the current
   * STATUS filter (e.g. all 12,859 Open escalations), not just the
   * 200 loaded into the modal and not the in-modal search subset.
   * The search box is a presentational filter; exports reflect the
   * dataset the operator asked the backend for. This matches the
   * Call History export contract.
   */
  async function downloadXlsx() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const qs = new URLSearchParams({ status });
      const url = `${base}/admin/jobs/escalated/export.xlsx?${qs.toString()}`;
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          if (j?.error) msg = String(j.error);
        } catch { /* not JSON, ignore */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = objectUrl;
      a.download = `escalated-jobs_${status}_${today}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
    } catch (e) {
      setError(e instanceof Error ? `Download failed: ${e.message}` : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        hideClose
        className="max-w-6xl w-[min(96vw,1280px)] h-[85vh] overflow-hidden p-0 flex flex-col"
      >
        <DialogHeader className="!mx-0 !mt-0 px-6 pt-6 pb-3 border-b">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-rose-600" />
              Escalated Jobs
              {data && (
                <span className="text-sm font-normal text-muted-foreground">
                  · {data.total.toLocaleString('en-IN')} total
                </span>
              )}
            </DialogTitle>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        {/* Filter row — search left, status filter + download right.
            Search runs client-side over every column on the currently
            loaded page; the status dropdown drives the server-side
            refetch. Download streams a styled XLSX of the full
            status-filtered dataset (not just the loaded page or the
            in-modal search subset) from the backend. */}
        <div className="px-6 py-3 border-b bg-card/40 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="pl-7"
            />
          </div>
          <div className="w-44">
            <SearchSelect
              value={status}
              onChange={(v) => setStatus(v || 'open')}
              options={STATUS_OPTIONS}
              placeholder="Status"
              required
            />
          </div>
          <DownloadButton
            onClick={() => { void downloadXlsx(); }}
            disabled={loading || !data || data.items.length === 0}
            downloading={downloading}
            title={
              !data || data.items.length === 0
                ? 'No escalations to export'
                : 'Download the current status filter as a styled Excel sheet'
            }
          />
        </div>

        {/* Table body — overflow-auto on BOTH axes (legacy modal had
            many columns and operators on smaller laptops need to
            scroll horizontally). `table-auto` + `whitespace-nowrap`
            on most cells keeps each cell on one logical row so the
            horizontal scroll is meaningful. */}
        <div className="flex-1 overflow-auto px-6 py-3">
          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 text-rose-800 px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {/* Body-level loading state. Replaces the in-toolbar "Loading…"
              chip — that location was visually awkward (sat between two
              unrelated controls) and operators told us they missed it.
              Shown only when there's no existing table to layer over
              (initial open + status change with no prior data). On a
              refresh of an already-loaded view we let the visible table
              stay so the modal doesn't flash empty during the network
              round-trip. */}
          {!error && loading && (!data || sorted.length === 0) && (
            <div className="text-sm text-muted-foreground text-center py-8">
              Loading escalations…
            </div>
          )}
          {!error && !loading && data && sorted.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              {data.items.length === 0
                ? `No ${status} escalations match the current filter.`
                : 'No rows match your search.'}
            </div>
          )}
          {!error && data && sorted.length > 0 && (
            <table className="data-table w-max min-w-full">
              {/* Sticky headers: each <th> pins to the top of the
                  scrollable container so columns stay visible while
                  rows scroll. `bg-card` matches the modal background
                  so the row beneath doesn't bleed through. z-10 sits
                  above the cells; if we later add sticky-left columns
                  they'd need z-20. SortHeader makes the column
                  clickable + shows the active-state arrow. */}
              <thead>
                <tr>
                  <SortHeader col="escalated_time"     sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Date &amp; Time Escalated</SortHeader>
                  <SortHeader col="job_id"             sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-center whitespace-nowrap sticky top-0 z-10 bg-card">Job ID</SortHeader>
                  <SortHeader col="client_name"        sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Client</SortHeader>
                  <SortHeader col="city_name"          sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">City</SortHeader>
                  <SortHeader col="job_stage_history"  sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Job Stage</SortHeader>
                  <SortHeader col="job_status"         sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-center whitespace-nowrap sticky top-0 z-10 bg-card">Current Status</SortHeader>
                  <SortHeader col="no_of_escalations"  sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-center whitespace-nowrap sticky top-0 z-10 bg-card">No of Escalations</SortHeader>
                  <SortHeader col="escalated_from"     sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Escalated From</SortHeader>
                  <SortHeader col="escalated_comments" sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Reason For Escalation</SortHeader>
                  <SortHeader col="escalated_by_name"  sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Escalated By</SortHeader>
                  <SortHeader col="inprogress_action"  sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Team Action</SortHeader>
                  <SortHeader col="completed_action"   sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Completed Action</SortHeader>
                  <SortHeader col="closed_action"      sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Closed Action</SortHeader>
                  {/* Escalated Hours sorts on the underlying
                      escalated_time so newer escalations cluster
                      together; the visible label is a derived
                      duration string which wouldn't sort numerically
                      ("9 hours" < "10 hours" alphabetically). */}
                  <SortHeader col="escalated_time"     sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Escalated Hours</SortHeader>
                  <SortHeader col="requested_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-left  whitespace-nowrap sticky top-0 z-10 bg-card">Original Appointment Date</SortHeader>
                  <SortHeader col="no_of_escalations"  sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="!text-center whitespace-nowrap sticky top-0 z-10 bg-card">Reopened</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.table_id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setJobView({ open: true, jobId: r.job_id })}
                    title="Click to view job details"
                  >
                    {/* Date on line 1, time on line 2 — matches the
                        legacy 2-line cell layout. formatDateOnly /
                        formatTimeOnly split a single ISO string into
                        date + time parts using the browser locale. */}
                    <td className="!text-left whitespace-nowrap text-xs">
                      <div>{formatDateOnly(r.escalated_time)}</div>
                      <div className="text-[10px] text-muted-foreground">{formatTimeOnly(r.escalated_time)}</div>
                    </td>
                    <td className="!text-center font-mono text-xs whitespace-nowrap">
                      {r.job_id}
                    </td>
                    <td className="!text-left text-xs">{r.client_name || '—'}</td>
                    <td className="!text-left text-xs">{r.city_name || '—'}</td>
                    {/* Job Stage history — aggregated CSV. line-clamp-2
                        with full text in title attribute for hover. */}
                    <td className="!text-left text-xs max-w-[280px]">
                      <span className="line-clamp-2" title={r.job_stage_history || ''}>
                        {r.job_stage_history || '—'}
                      </span>
                    </td>
                    <td className="!text-center">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColorClass(Number(r.job_status))}`}>
                        {statusLabel(Number(r.job_status), { assigned: r.fk_easyfixter_id != null })}
                      </span>
                    </td>
                    <td className="!text-center font-mono text-xs">
                      {r.no_of_escalations ?? 0}
                    </td>
                    {/* Escalated From = the team/department the
                        escalation originated in (e.g. "Logistics",
                        "Customer Service"). Stored verbatim in
                        tbl_easyfixer_rating_by_customer.escalated_from.
                        This is DIFFERENT from "Escalated By" which is
                        the user who flagged it — see next column. */}
                    <td className="!text-left text-xs">{r.escalated_from || '—'}</td>
                    <td className="!text-left text-xs max-w-[280px]">
                      <span className="line-clamp-2" title={r.escalated_comments || ''}>
                        {r.escalated_comments || '—'}
                      </span>
                    </td>
                    {/* Escalated By = the user who created the
                        escalation. Joined from tbl_user via
                        escalated_by FK on the backend. */}
                    <td className="!text-left text-xs whitespace-nowrap">{r.escalated_by_name || '—'}</td>
                    {/* Workflow controls — inline editable. Each one
                        sends a PATCH /admin/jobs/escalated/:tableId on
                        change; the backend stamps closed_time when
                        Resolved is picked and clears it on Re-Open.
                        Click handlers stopPropagation so the dropdown
                        doesn't open the underlying view-job modal. */}
                    <td
                      className="!text-left text-xs whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <InlineActionPicker
                        value={r.inprogress_action}
                        options={TEAM_ACTIONS}
                        onChange={(v) => updateAction(r.table_id, { inprogress_action: v })}
                      />
                    </td>
                    <td
                      className="!text-left text-xs whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <InlineActionPicker
                        value={r.completed_action}
                        options={COMPLETED_ACTIONS}
                        onChange={(v) => updateAction(r.table_id, { completed_action: v })}
                      />
                    </td>
                    <td
                      className="!text-left text-xs whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <InlineActionPicker
                        value={r.closed_action}
                        options={CLOSED_ACTIONS}
                        onChange={(v) => updateAction(r.table_id, { closed_action: v })}
                      />
                    </td>
                    {/* Escalated Hours = humanised duration between
                        escalated_time and (resolved_time || now).
                        Matches the legacy `escalationTat` display. */}
                    <td className="!text-left text-xs whitespace-nowrap">
                      {escalationDurationLabel(r.escalated_time, r.resolved_time)}
                    </td>
                    {/* Original Appointment Date = requested_date_time
                        from tbl_job, formatted on two lines (date + time). */}
                    <td className="!text-left text-xs whitespace-nowrap">
                      {r.requested_date_time ? (
                        <>
                          <div>{formatDateOnly(r.requested_date_time)}</div>
                          <div className="text-[10px] text-muted-foreground">{formatTimeOnly(r.requested_date_time)}</div>
                        </>
                      ) : '—'}
                    </td>
                    {/* Reopened — derives from no_of_escalations > 1.
                        Legacy showed a checkmark for re-escalated rows. */}
                    <td className="!text-center text-xs">
                      {(r.no_of_escalations ?? 0) > 1 ? <span className="text-amber-600">✓</span> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer note — matches the size of the standard DialogFooter. */}
        <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {data
              ? q.trim()
                ? `Showing ${sorted.length.toLocaleString('en-IN')} of ${data.items.length.toLocaleString('en-IN')} loaded (${data.total.toLocaleString('en-IN')} total)`
                : `Showing ${data.items.length.toLocaleString('en-IN')} of ${data.total.toLocaleString('en-IN')}`
              : ' '}
          </span>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>

        {/* Nested job-view modal — opens when the operator clicks a row.
            Closing it returns to the escalation list. */}
        <JobModal
          open={jobView.open}
          mode={'view' as JobModalMode}
          jobId={jobView.jobId}
          onClose={() => setJobView({ open: false })}
        />
      </DialogContent>
    </Dialog>
  );
}
