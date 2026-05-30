'use client';

import * as React from 'react';
import { CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

/*
 * CustomerSubmissionPanel — read-only banner shown above Section 1 of the
 * Confirm & Schedule modal when the customer self-submitted the magic-link
 * form. Backend writes:
 *   tbl_job.customer_submitted_at      DATETIME
 *   tbl_job.customer_submitted_payload JSON   (snapshot of the submitted form)
 * (see EasyFix_Backend/services/job-magic-link.service.js::acceptSubmission)
 *
 * Ops sees a compact green "Customer Submitted on …" header with an Expand
 * toggle that reveals the raw key/value list of what the customer sent.
 * The actual tbl_job / tbl_address / tbl_job_services rows have ALREADY been
 * rewritten by the BE (COALESCE-style merge), so the modal's normal prefill
 * paths surface the customer's values — this panel only exists so ops can
 * inspect what was originally submitted (audit + sanity-check) before
 * accepting the order.
 */

/*
 * Payload shape mirrors the BE validator at
 * `EasyFix_Backend/validators/job-magic-link.validator.js` and the
 * `SubmitPayload` type in `src/lib/magic-link-types.ts`: the customer
 * submits a FLAT object — `address` is the address-line string and
 * `building`, `landmark`, `city_id`, `pin_code`, `gps_location`,
 * `address_instruction` are sibling top-level keys (NOT nested under
 * `address`). Earlier versions of this panel assumed a nested shape;
 * the audit rows for those sub-fields rendered blank as a result.
 */
type Payload = {
  customer_name?: string | null;
  customer_email?: string | null;
  requested_date_time?: string | null;
  time_slot?: string | null;
  additional_name?: string | null;
  additional_number?: string | null;
  job_desc?: string | null;
  address?: string | null;
  building?: string | null;
  landmark?: string | null;
  city_id?: number | string | null;
  pin_code?: string | null;
  gps_location?: string | null;
  address_instruction?: string | null;
  services?: Array<{ client_service_id?: number | string; quantity?: number }> | null;
  [k: string]: unknown;
};

function formatSubmittedAt(v: string | Date | null | undefined): string {
  if (!v) return '';
  try {
    const d = new Date(String(v));
    if (isNaN(+d)) return String(v);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(v);
  }
}

/** Render a single key/value row; skips null/undefined/empty. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 text-sm">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-foreground break-words">{value}</div>
    </div>
  );
}

export function CustomerSubmissionPanel({
  submittedAt,
  payload,
}: {
  submittedAt: string | Date | null | undefined;
  payload: Payload | string | null | undefined;
}) {
  const [expanded, setExpanded] = React.useState(false);
  if (!submittedAt) return null;

  // Payload may arrive as a JSON string (legacy DB driver passthrough) or
  // as a pre-parsed object (mysql2 JSON typecast). Handle both defensively.
  let p: Payload | null = null;
  if (payload && typeof payload === 'string') {
    try { p = JSON.parse(payload) as Payload; } catch { p = null; }
  } else if (payload && typeof payload === 'object') {
    p = payload as Payload;
  }

  const services = Array.isArray(p?.services) ? p!.services : [];
  const serviceList = services
    .map((s) => {
      const id = s?.client_service_id != null ? String(s.client_service_id) : '';
      const qty = s?.quantity ? ` × ${s.quantity}` : '';
      return id ? `#${id}${qty}` : '';
    })
    .filter(Boolean)
    .join(', ');

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          Customer Submitted on {formatSubmittedAt(submittedAt)}
        </div>
        {p && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5 mr-1" /> : <ChevronDown className="h-3.5 w-3.5 mr-1" />}
            {expanded ? 'Hide Details' : 'View Submitted Details'}
          </Button>
        )}
      </div>
      {expanded && p && (
        <div className="mt-3 space-y-1.5 rounded-md bg-white px-3 py-3 border border-emerald-100">
          <Row label="Customer Name" value={p.customer_name} />
          <Row label="Customer Email" value={p.customer_email} />
          <Row label="Requested Date/Time" value={p.requested_date_time} />
          <Row label="Time Slot" value={p.time_slot} />
          <Row label="Alternate Name" value={p.additional_name} />
          <Row label="Alternate Mobile" value={p.additional_number} />
          <Row label="Job Description" value={p.job_desc} />
          <Row label="Address Line" value={p.address} />
          <Row label="Building" value={p.building} />
          <Row label="Landmark" value={p.landmark} />
          <Row label="City ID" value={p.city_id != null && p.city_id !== '' ? String(p.city_id) : ''} />
          <Row label="PIN Code" value={p.pin_code} />
          <Row label="GPS Location" value={p.gps_location} />
          <Row label="Address Instruction" value={p.address_instruction} />
          <Row label="Services" value={serviceList} />
        </div>
      )}
    </div>
  );
}

export default CustomerSubmissionPanel;
