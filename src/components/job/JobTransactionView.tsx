'use client';

import * as React from 'react';
import { Phone, Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { formatDate, statusColorClass, statusLabel } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { CallableMobile } from '@/components/calls/CallButton';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { JobAddressEditDialog } from './JobModal';

/*
 * JobTransactionView — read-only, single-page replica of the legacy
 * "Job Transaction" screen, shown when ops opens an Unconfirmed
 * (job_status === 9) order in View mode.
 *
 * Why a dedicated view (vs. the existing tabbed read-only Summary):
 *   The tabbed view exposed Materials and Comments tabs that allowed
 *   edits. Legacy CRM's Unconfirmed flow is strictly read-only — ops
 *   uses "Add Remarks" or "Confirm & Schedule" to act on the order,
 *   never inline edits. Collapsing every section into one scrollable
 *   page matches the legacy layout pixel-for-pixel so muscle memory
 *   carries across.
 *
 * Data: fetched from `GET /admin/jobs/:id/transaction` which wraps the
 * existing `getById` + enrichment queries (feedback, comments,
 * quotations, scheduling history, decoded enum reasons, images bucketed
 * by stage). Each section renders independently — if a particular
 * enrichment returned `null`/`[]`, that section shows "—" or an empty
 * table row instead of crashing the page.
 */

type ImageRow = { image_id: number; job_id: number; job_stage: number; image_category: string | null; image: string; created_date: string };
type CommentRow = { id: number; comments: string; comment_on: number; stage_label?: string; user_name?: string | null; created_on?: string; enum_desc?: string | null };
type QuotationRow = { id: number; attachment: string | null; type: string | null; date: string | null; status: string | null; client_charge: number | null };
type HistoryRow = { table_id: number; scheduled_date_time: string | null; easyfixer_id: number | null; easyfixer_name: string | null; reschedule_reason: string | null };
type ServiceRow = Record<string, unknown> & {
  job_service_id?: number;
  service_type_name?: string | null;
  service_catg_name?: string | null;
  quantity?: number;
  total_charge?: number;
  easyfix_charge?: number;
  material_charge?: number;
  service_charge_description?: string;
};

type TransactionResp = {
  job: Record<string, unknown> & {
    job_id: number; job_status: number;
    customer_name: string | null; customer_mob_no: string | null;
    job_customer_name?: string | null;
    client_name: string | null;
    address: string | null; city_name: string | null; pin_code: string | null;
    owner_name: string | null; easyfixer_name: string | null;
    created_date_time: string; ticket_created_date_time: string | null;
    requested_date_time: string | null; scheduled_date_time: string | null;
    checkin_date_time: string | null; checkout_date_time: string | null;
    job_desc: string | null; remarks: string | null; remarks_date_time: string | null;
    time_slot: string | null;
    job_type: string | null;
    helper_req: number | boolean | null;
    fk_easyfixter_id: number | null;
    exp_tat: number | null;
    collected_by: string | null;
    revisit_time_slot: string | null;
    services: ServiceRow[];
    images: ImageRow[];
  };
  feedback: { easyfixer_rating?: number | null; easyfix_rating?: number | null; happy_with_service?: string | null } | null;
  rescheduledCount: number;
  quotations: QuotationRow[];
  comments: CommentRow[];
  images_by_stage: Record<string, ImageRow[]>;
  open_job_reason: string | null;
  revisit_reason: string | null;
  scheduling_history: HistoryRow[];
};

// maskMobile lives in '@/lib/format' — see import block above. Local copy
// removed; the shared helper is idempotent so it composes safely with the
// /admin/* BE masking middleware.

function fmt(v: unknown): string {
  if (v == null || v === '') return '—';
  return String(v);
}

/*
 * Section heading bar — light grey background + bottom border, matches
 * the legacy "Customer Details / Job Total / Quotation / ..." dividers.
 */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700">
      {children}
    </div>
  );
}

/*
 * Definition-list row — two-column layout (label / value) used inside
 * the left-column Job Info card and similar key-value sections.
 */
function DLRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[170px_1fr] items-baseline py-1.5 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-slate-800">{children}</div>
    </div>
  );
}

/*
 * Bordered card — every section uses one. `dense` removes inner
 * padding for tables that bring their own.
 */
function Card({ children, dense = false }: { children: React.ReactNode; dense?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className={dense ? '' : 'p-4'}>{children}</div>
    </div>
  );
}

export function JobTransactionView({ jobId }: { jobId: number }) {
  const [data, setData] = React.useState<TransactionResp | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Local refetch counter — bumped by the Edit Address dialog on Save so
  // the page reflects the new address without forcing the operator to
  // close + reopen the modal.
  const [bump, setBump] = React.useState(0);
  const refreshFn = React.useCallback(() => setBump((b) => b + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.get<TransactionResp>(`/admin/jobs/${jobId}/transaction`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, bump]);

  if (loading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Loading job transaction…</div>;
  }
  if (error || !data) {
    return <div className="p-8 text-center text-sm text-destructive">{error || 'Job not found.'}</div>;
  }

  const j = data.job;
  const customProperties = Array.isArray((j as Record<string, unknown>).custom_properties)
    ? ((j as Record<string, unknown>).custom_properties as Array<{ name?: string; label?: string; value?: unknown }>)
    : [];

  // Total no. of products = sum of service quantities (legacy semantic).
  const totalProducts = (j.services || []).reduce((s, r) => s + Number(r.quantity || 0), 0);

  // Job-Total derivation from services rows. Service/material charges
  // are per-row; total_charge is what legacy persists. Sum across rows
  // for the page-level grand total.
  const jobTotal = (j.services || []).reduce((s, r) => s + Number(r.total_charge || 0), 0);

  return (
    <div className="space-y-4 text-sm text-slate-800">
      {/* ─── Job Info ─────────────────────────────────────────────── */}
      <div className="text-base font-semibold text-slate-700">Job Info</div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* LEFT — Job + Customer */}
        <Card>
          <DLRow label="Job Id">{j.job_id}</DLRow>
          <DLRow label="Booking Date Time">{j.ticket_created_date_time ? formatDate(j.ticket_created_date_time) : formatDate(j.created_date_time)}</DLRow>
          <DLRow label="Order Status">
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(Number(j.job_status))}`}>
              {statusLabel(Number(j.job_status), { assigned: j.fk_easyfixter_id != null })}
            </span>
          </DLRow>
          <DLRow label="Project Owner">{fmt(j.owner_name)}</DLRow>
          <DLRow label="Technician">{fmt(j.easyfixer_name)}</DLRow>
          <DLRow label="Profiled As">{fmt((j as Record<string, unknown>).profiled_as) /* derived field — usually "Master" */}</DLRow>

          <div className="mt-3 pt-3 border-t border-slate-200">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Customer Details</div>
            <DLRow label="Name:">{fmt(j.job_customer_name || j.customer_name)}</DLRow>
            <DLRow label="Contact No.:">
              {/* CallableMobile routes through the Kaleyra click-to-call
                  flow (confirmation + audit row) instead of the OS
                  dialer. The BE resolves the customer's real digits from
                  jobId server-side; the masked `mobile` prop is purely
                  presentational. */}
              <CallableMobile jobId={Number(j.job_id)} mobile={j.customer_mob_no} />
            </DLRow>
            <DLRow label="Collected By:">{fmt(j.collected_by)}</DLRow>
          </div>
        </Card>

        {/* RIGHT — Service / Problem + Custom Properties */}
        <Card>
          <DLRow label="Service Type">{fmt(j.services?.[0]?.service_type_name)}</DLRow>
          <DLRow label="Service Category">{fmt(j.services?.[0]?.service_catg_name)}</DLRow>
          <DLRow label="Problem Description">{fmt(j.job_desc)}</DLRow>
          <DLRow label="Total No. of Products">{totalProducts}</DLRow>
          <DLRow label="Job Completion TAT">{j.exp_tat != null ? `${j.exp_tat} hrs` : 'hrs'}</DLRow>

          {/* Custom Property table — pulled from the job/client custom
              properties join when available. Empty array yields a
              header-only table (matches legacy). */}
          <div className="mt-3 rounded-md border border-slate-200 overflow-hidden">
            <SectionHeading>Custom Property</SectionHeading>
            <table className="w-full text-sm">
              <thead className="bg-slate-50/60">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">Property Name</th>
                  <th className="px-3 py-2">Property Value</th>
                </tr>
              </thead>
              <tbody>
                {customProperties.length === 0 ? (
                  <tr><td colSpan={2} className="px-3 py-3 text-center text-muted-foreground">No custom properties</td></tr>
                ) : customProperties.map((p, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-2">{fmt(p.label || p.name)}</td>
                    <td className="px-3 py-2">{fmt(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ─── Open / Tools / Helper / Filter / Appointment | Job Total ─── */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <DLRow label="Open Job Reason:">{fmt(data.open_job_reason)}</DLRow>
          <DLRow label="Tools Required:">{fmt((j as Record<string, unknown>).tools_required) /* legacy free-text; column may not exist */}</DLRow>
          <DLRow label="Helper Required:">{j.helper_req ? 'YES' : 'NO'}</DLRow>
          <DLRow label="Filter Type:">{fmt((j as Record<string, unknown>).filter_type) /* legacy text column; absent in some DBs */}</DLRow>
          <DLRow label="Appointment status with date time:">
            {j.requested_date_time ? formatDate(j.requested_date_time) : '—'}
            {j.time_slot ? <span className="ml-2 text-xs text-muted-foreground">({j.time_slot})</span> : null}
          </DLRow>
        </Card>

        <Card dense>
          <SectionHeading>Job Total</SectionHeading>
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Services</th>
                <th className="px-3 py-2">Service Charge</th>
                <th className="px-3 py-2">Material Charge</th>
                <th className="px-3 py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {(j.services || []).length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-3 text-center text-muted-foreground">No services</td></tr>
              ) : (j.services || []).map((s, i) => (
                <tr key={s.job_service_id ?? i} className="border-t border-slate-100">
                  <td className="px-3 py-2">{fmt(s.service_type_name)}</td>
                  <td className="px-3 py-2 tabular-nums">{Number(s.easyfix_charge || 0).toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2 tabular-nums">{Number(s.material_charge || 0).toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmt(s.service_charge_description)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 bg-slate-50/40">
                <td className="px-3 py-2 font-semibold">Total:</td>
                <td colSpan={3} className="px-3 py-2 tabular-nums font-semibold">{jobTotal.toLocaleString('en-IN')}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>

      {/* ─── Quotation | Customer Details ──────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card dense>
          <SectionHeading>Quotation</SectionHeading>
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Attachment</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.quotations.length === 0 ? (
                <tr>
                  <td className="px-3 py-2 text-muted-foreground">—</td>
                  <td className="px-3 py-2 text-muted-foreground">—</td>
                  <td className="px-3 py-2 text-muted-foreground">—</td>
                </tr>
              ) : data.quotations.map((q) => (
                <tr key={q.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{fmt(q.attachment)}</td>
                  <td className="px-3 py-2 text-xs">{q.date ? formatDate(q.date) : '—'}</td>
                  <td className="px-3 py-2">{fmt(q.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-slate-700">Customer Details</div>
            {/* Edit Address — gated by isJobEdit. Available on the
                Unconfirmed view too (status=9) so admins can fix the
                address before promoting to BOOKED. */}
            <EditAddressInTransaction jobRow={j} onSaved={refreshFn} />
          </div>
          <DLRow label="Name:">{fmt(j.customer_name)}</DLRow>
          <DLRow label="Number:">
            <CallableMobile jobId={Number(j.job_id)} mobile={j.customer_mob_no} />
          </DLRow>
          <DLRow label="Address:">{fmt(j.address)}</DLRow>
          <DLRow label="Location:">{fmt(j.city_name)}</DLRow>
          <DLRow label="PIN:">{fmt(j.pin_code)}</DLRow>
          <DLRow label="Rescheduled">{data.rescheduledCount} times</DLRow>
          <DLRow label="City Manager">{fmt((j as Record<string, unknown>).city_manager_name) /* column not always present */}</DLRow>
          <DLRow label="Rating">{data.feedback?.easyfix_rating ?? 0}</DLRow>
        </Card>
      </div>

      {/* ─── Technician Rating + Comments ─────────────────────────── */}
      <Card>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <div className="text-sm font-semibold text-slate-700 mb-2">Technician Rating:</div>
            <span className="inline-flex items-center gap-1 bg-sky-100 text-sky-800 rounded px-3 py-1 text-base font-semibold">
              ★ {data.feedback?.easyfixer_rating ?? 0}
            </span>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-700 mb-2">Comments:</div>
            <div className="text-sm text-slate-700 whitespace-pre-wrap min-h-[2.5em]">
              {fmt(data.feedback?.happy_with_service)}
            </div>
          </div>
        </div>
      </Card>

      {/* ─── App Status ───────────────────────────────────────────── */}
      <Card dense>
        <SectionHeading>App Status</SectionHeading>
        <table className="w-full text-sm">
          <thead className="bg-slate-50/60">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2">Confirmation</th>
              <th className="px-3 py-2">Allocation</th>
              <th className="px-3 py-2">ETA</th>
              <th className="px-3 py-2">OTA</th>
              <th className="px-3 py-2">App Stage</th>
              <th className="px-3 py-2">1st visit closing TAT</th>
              <th className="px-3 py-2">Job closing TAT</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-100">
              <td className="px-3 py-2">{fmt((j as Record<string, unknown>).app_confirmation_time as string) }</td>
              <td className="px-3 py-2 text-xs">{j.scheduled_date_time ? formatDate(j.scheduled_date_time) : '—'}</td>
              <td className="px-3 py-2">{fmt((j as Record<string, unknown>).eta_requested_time as string)}</td>
              <td className="px-3 py-2">{fmt((j as Record<string, unknown>).app_checkout_date_time as string)}</td>
              <td className="px-3 py-2">{statusLabel(Number(j.job_status), { assigned: j.fk_easyfixter_id != null })}</td>
              <td className="px-3 py-2">{tat(j.checkin_date_time, j.checkout_date_time)}</td>
              <td className="px-3 py-2">{tat(j.created_date_time, j.checkout_date_time)}</td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* ─── App Details Data ─────────────────────────────────────── */}
      <Card dense>
        <SectionHeading>App Details Data</SectionHeading>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1200px]">
            <thead className="bg-slate-50/60">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Start Job Pictures</th>
                <th className="px-3 py-2">Site Inspection</th>
                <th className="px-3 py-2">Job close starts</th>
                <th className="px-3 py-2">2nd visit</th>
                <th className="px-3 py-2">Drop down reason</th>
                <th className="px-3 py-2">Remarks</th>
                <th className="px-3 py-2">Date time for revisit</th>
                <th className="px-3 py-2">CO Amount</th>
                <th className="px-3 py-2">Job Sheet & Material Used pic</th>
                <th className="px-3 py-2">CX sign</th>
                <th className="px-3 py-2">Feedback</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-100 align-top">
                <td className="px-3 py-2"><ImageCount count={data.images_by_stage.start_job?.length} /></td>
                <td className="px-3 py-2">{data.images_by_stage.site_inspection?.length ? <ImageCount count={data.images_by_stage.site_inspection.length} /> : <span className="text-muted-foreground">None<br />Available</span>}</td>
                <td className="px-3 py-2">{j.checkout_date_time ? formatDate(j.checkout_date_time) : '—'}</td>
                <td className="px-3 py-2 font-semibold text-rose-600">{(j as Record<string, unknown>).revisit_date ? 'YES' : 'NO'}</td>
                <td className="px-3 py-2">{fmt(data.revisit_reason)}</td>
                <td className="px-3 py-2 max-w-[200px]"><span className="text-xs">{fmt(j.remarks)}</span></td>
                <td className="px-3 py-2 text-xs">
                  {(j as Record<string, unknown>).revisit_date ? formatDate(String((j as Record<string, unknown>).revisit_date)) : '—'}
                  {j.revisit_time_slot ? <div className="text-muted-foreground">{j.revisit_time_slot}</div> : null}
                </td>
                <td className="px-3 py-2 tabular-nums">{Number((j as Record<string, unknown>).collected_cash || 0)}/-</td>
                <td className="px-3 py-2">
                  <ImageCount count={(data.images_by_stage.job_sheet?.length || 0) + (data.images_by_stage.material_used?.length || 0)} />
                </td>
                <td className="px-3 py-2"><ImageCount count={data.images_by_stage.signature?.length} /></td>
                <td className="px-3 py-2 text-xs">{fmt(data.feedback?.happy_with_service)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {/* ─── Remarks History ──────────────────────────────────────── */}
      <Card dense>
        <SectionHeading>Remarks History</SectionHeading>
        <table className="w-full text-sm">
          <thead className="bg-slate-50/60">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2">Remarks For</th>
              <th className="px-3 py-2">Accountable</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Remarks</th>
              <th className="px-3 py-2">Remark By</th>
              <th className="px-3 py-2">Date/Time</th>
            </tr>
          </thead>
          <tbody>
            {data.comments.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground text-xs">No remarks yet</td>
              </tr>
            ) : data.comments.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 text-xs">{fmt(c.stage_label)}</td>
                <td className="px-3 py-2 text-xs">—</td>
                <td className="px-3 py-2 text-xs">{fmt(c.enum_desc)}</td>
                <td className="px-3 py-2 text-xs max-w-[260px] whitespace-pre-wrap">{fmt(c.comments)}</td>
                <td className="px-3 py-2 text-xs">{fmt(c.user_name)}</td>
                <td className="px-3 py-2 text-xs">{c.created_on ? formatDate(c.created_on) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* ─── Scheduling History (extra — surfaces tech reschedules) ── */}
      {data.scheduling_history.length > 0 && (
        <Card dense>
          <SectionHeading>Scheduling History</SectionHeading>
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Scheduled For</th>
                <th className="px-3 py-2">Easyfixer</th>
                <th className="px-3 py-2">Reschedule Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.scheduling_history.map((h) => (
                <tr key={h.table_id} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs">{h.scheduled_date_time ? formatDate(h.scheduled_date_time) : '—'}</td>
                  <td className="px-3 py-2 text-xs">{fmt(h.easyfixer_name)}</td>
                  <td className="px-3 py-2 text-xs">{fmt(h.reschedule_reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/*
 * Image-count pill used by the App-Details-Data row. The actual image
 * preview lives behind a click — kept compact here so all 11 columns
 * fit on one row at typical viewport widths.
 */
function ImageCount({ count }: { count: number | undefined }) {
  if (!count) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center rounded bg-sky-100 text-sky-800 px-2 py-0.5 text-xs">
      📷 {count}
    </span>
  );
}

/*
 * EditAddressInTransaction — gated Edit Address affordance for the
 * Unconfirmed (status=9) job transaction view. Same shape as the
 * JobModal Summary tab — Pencil icon button that opens the shared
 * JobAddressEditDialog. Gated by `isJobEdit` (seed migration
 * 2026-05-26-add-job-edit-action.sql adds the action key).
 */
function EditAddressInTransaction({ jobRow, onSaved }: {
  jobRow: Record<string, unknown>; onSaved: () => void;
}) {
  const { me } = useMe();
  const can = actionFlags(me, ['isJobEdit']);
  const [open, setOpen] = React.useState(false);
  if (!can.isJobEdit) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="!h-7 !px-2 text-xs">
        <Pencil className="size-3 mr-1" /> Edit Address
      </Button>
      {open && (
        // Cast through `unknown` — JobAddressEditDialog only reads a
        // handful of address-shape fields off the job object, so the
        // partial type used here is sufficient.
        <JobAddressEditDialog
          job={jobRow as unknown as Parameters<typeof JobAddressEditDialog>[0]['job']}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onSaved(); }}
        />
      )}
    </>
  );
}

/*
 * TAT diff helper — legacy shows "N days N hours" between two
 * timestamps. Both args may be missing; render "—" in that case.
 */
function tat(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—';
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—';
  const ms = b - a;
  const hrs = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hrs / 24);
  return `${days} days ${hrs % 24} hours`;
}
