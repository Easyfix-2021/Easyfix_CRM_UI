'use client';

/*
 * HRMS → Approvals — Profile Update Requests.
 *
 * CRM users cannot edit their own mobile number, date of birth or bank details
 * outright; they raise a request from /profile and an HR approves it here.
 *
 * ── ONE ROW IS ONE USER, NOT ONE FIELD ───────────────────────────────────────
 * A user has AT MOST ONE pending request and it ACCUMULATES: submitting DOB and
 * later submitting only a mobile number leaves a single request carrying both.
 * So `changes` is a JSON object of only the keys awaiting approval, and
 * `old_values` mirrors those same keys as they stood when each first entered the
 * request. There is deliberately no "Field / Current / Requested" triple of flat
 * columns — one row routinely carries a DOB, a mobile and four bank fields, and
 * three columns cannot say that without lying about how many requests exist.
 *
 * The whole before/after is therefore rendered INLINE in the Changes cell rather
 * than behind an expander. An approver is being asked to write someone's bank
 * account number into the payroll path; making them click to see what they are
 * approving is exactly the wrong economy. The row is as tall as the truth is.
 *
 * ── APPROVE AND REJECT ARE ALL-OR-NOTHING ────────────────────────────────────
 * POST :id/process applies EVERY key in `changes` inside one transaction. There
 * is no per-field approval, so both confirm dialogs name every field going
 * through — an HR approving "the DOB change" must know the mobile change rides
 * along with it.
 *
 * ── TWO KEYS, TWO DIFFERENT PAGES ────────────────────────────────────────────
 *   isProfileApprovalView    — read the queue. Without it: Access Denied, and
 *                              the list request is never fired (null key).
 *   isProfileApprovalProcess — act on it. Without it the Actions column is not
 *                              rendered at all and a banner says why. A column
 *                              of dead buttons reads as a broken page; a missing
 *                              column plus a sentence reads as a decision.
 *
 * ── BANK VALUES ARE MASKED, AND REVEALING ONE IS AUDITED ─────────────────────
 * `changes` / `old_values` carry the bank account number and holder name
 * ENCRYPTED, and the list route ships them masked. The plaintext exists behind
 * POST :id/reveal, gated on isProfileApprovalProcess — approving is what needs
 * it, so a view-only approver gets no eye at all, not a disabled one.
 *
 * The reveal is a POST that writes an audit row, so it gets a real pending
 * state and re-masks itself; and the fact that it is recorded is stated up top,
 * before anyone clicks. The audit log protects the company either way — saying
 * it exists is what protects the colleague whose account number is being read.
 */

import * as React from 'react';
import {
  ShieldCheck, Check, X, Search, AlertTriangle, ArrowRight, Lock, Eye, History,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { SearchSelect } from '@/components/ui/search-select';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatDate } from '@/lib/utils';
import { parseIstDateTime, pluralize, titleCaseLabel } from '@/lib/format';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { RevealButton, RevealNotice, maskedText, useReveal } from '@/components/profile/ProfileFields';

const ENDPOINT = '/admin/profile-update-requests';

/*
 * The limit the route's Joi validator accepts, passed EXPLICITLY to
 * pageSizeToLimit so "All" maps to this endpoint's real ceiling instead of the
 * helper's 1000 default. 1000 is the house maximum for admin list endpoints
 * (`Joi.number().integer().min(1).max(1000)`); if the route lands on a lower
 * cap, change this one constant — "All" 400s otherwise.
 */
const LIST_LIMIT_MAX = 1000;

type BankFields = {
  account_number?: string | null;
  ifsc?: string | null;
  account_name?: string | null;
  bank_name?: string | null;
};

/* Only the keys awaiting approval are present. `bank` is nested and moves as a
 * unit, which is why it is one key here and four rows on screen. */
type ProfileChanges = {
  mobile_no?: string | null;
  date_of_birth?: string | null;
  bank?: BankFields | null;
} & Record<string, unknown>;

type UpdateRequest = {
  request_id: number;
  user_id: number;
  user_name: string | null;
  user_code?: string | null;
  /* TEXT columns. Typed to accept the raw JSON string too — see asChanges(). */
  changes: ProfileChanges | string | null;
  old_values: ProfileChanges | string | null;
  status: string;
  requested_on: string;
  /* Set only when the user merged into an already-open request. */
  updated_on: string | null;
  processed_on: string | null;
  processed_by: number | null;
  processed_by_name?: string | null;
  remarks: string | null;
};

/*
 * The contract fixes the query params but not the envelope, and this page is
 * built alongside the route rather than after it. Both house shapes are read so
 * a naming difference costs a comment rather than an empty table; collapse this
 * to whichever the route actually returns once it lands.
 */
type ListResp = { rows?: UpdateRequest[]; items?: UpdateRequest[]; total?: number };

/* `changes` / `old_values` are TEXT. Whether the service JSON.parses them before
 * responding is not in the contract, so both shapes are accepted here. */
function asChanges(v: ProfileChanges | string | null | undefined): ProfileChanges {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as ProfileChanges) : {};
    } catch {
      return {};
    }
  }
  return v;
}

const FIELD_ORDER = ['mobile_no', 'date_of_birth', 'bank'] as const;
const FIELD_LABEL: Record<string, string> = {
  mobile_no: 'Mobile Number',
  date_of_birth: 'Date Of Birth',
  bank: 'Bank Details',
};

/* Reading order for a bank block: who the account belongs to, then the numbers.
 * Matches the order the self-service form asks for them in. */
const BANK_FIELD_ORDER = ['account_name', 'account_number', 'ifsc', 'bank_name'] as const;
const BANK_FIELD_LABEL: Record<string, string> = {
  account_name: 'Account Holder Name',
  account_number: 'Account Number',
  ifsc: 'IFSC Code',
  bank_name: 'Bank Name',
};

function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? titleCaseLabel(key);
}

/*
 * The keys actually being changed, in a fixed reading order.
 *
 * Unknown keys are appended rather than filtered out: if the backend starts
 * carrying a fourth field, an approver must SEE it, because pressing Approve
 * writes it either way. Failing visible beats failing silent on a screen whose
 * whole job is informed consent.
 */
function changedKeys(c: ProfileChanges): string[] {
  const known = FIELD_ORDER.filter((k) => c[k] != null);
  const extra = Object.keys(c).filter(
    (k) => !(FIELD_ORDER as readonly string[]).includes(k) && c[k] != null,
  );
  return [...known, ...extra];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * 'YYYY-MM-DD' → '08 Mar 1994'. A bare DATE must not go through formatDate():
 * that would append a meaningless "12:00 am" to a birthday. Formatted from the
 * string's own parts, so no Date is constructed and no timezone can shift it.
 */
function formatDob(v: unknown): string | null {
  const ymd = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return `${ymd.slice(8, 10)} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
}

/*
 * Values are shown as the user will read them back, not as the column stores
 * them. Everything except a DOB is already display-ready.
 *
 * Routed through maskedText() so that ANY value still shaped like ciphertext
 * (`v1:<iv>:<tag>:<ct>`) renders as absent rather than being painted on screen
 * as though it were a value. That is a server bug if it happens, but the one
 * thing this page must not do is display a stored secret it was handed by
 * mistake — and the guard costs nothing on the fields that are stored in clear.
 */
function displayValue(key: string, v: unknown): string | null {
  if (v == null || v === '') return null;
  if (key === 'date_of_birth') return maskedText(formatDob(v) ?? String(v));
  return maskedText(String(v));
}

/* The two bank sub-fields that are encrypted at rest. The IFSC code and the
 * bank name are stored in clear and need no reveal. */
const SECRET_BANK_FIELDS = new Set<string>(['account_number', 'account_name']);

/* What POST :id/reveal hands back — the request's bank values, both sides. */
type RevealedRequestBank = { before: BankFields; after: BankFields };

/* "Mobile Number, Date Of Birth and Bank Details" — used in confirm copy, where
 * the whole point is that the approver reads every field going through. */
function listLabels(keys: string[]): string {
  const labels = keys.map(fieldLabel);
  if (labels.length <= 1) return labels[0] ?? 'nothing';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

const STATUS_META: Record<string, { label: string; tone: StatusChipTone }> = {
  pending:  { label: 'Pending',  tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'urgent' },
};

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

/*
 * A request was revised when the user merged into it after first raising it.
 * Compared as INSTANTS, not as strings: `updated_on` is normally NULL until a
 * merge happens, but a service that stamps it on creation too would make a
 * string test claim every request had been revised.
 */
function wasRevised(r: UpdateRequest): boolean {
  if (!r.updated_on) return false;
  const updated = parseIstDateTime(r.updated_on).getTime();
  const requested = parseIstDateTime(r.requested_on).getTime();
  if (!Number.isFinite(updated) || !Number.isFinite(requested)) return false;
  return updated > requested;
}

function raisedByLabel(r: UpdateRequest): string {
  return r.user_name?.trim() || `User #${r.user_id}`;
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

/*
 * One before → after line. `before` is deliberately rendered as "Not Set"
 * rather than blank when the user is filling a field for the first time (a
 * bank block that has never existed, the DOB nobody ever entered) — an empty
 * left-hand side reads as data that failed to load.
 */
function BeforeAfter({ label, before, after }: {
  label: string;
  before: string | null;
  after: string | null;
}) {
  const unchanged = before != null && before === after;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className={unchanged ? 'break-all' : 'break-all text-muted-foreground line-through'}>
        {before ?? <span className="italic text-muted-foreground">Not Set</span>}
      </span>
      {unchanged ? (
        <span className="text-muted-foreground">· No Change</span>
      ) : (
        <>
          <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="break-all font-medium">{after ?? <Dash />}</span>
        </>
      )}
    </div>
  );
}

/*
 * The bank block — its own component ONLY because it owns a reveal, and a hook
 * cannot be called inside the rows' .map(). Per-row state is the right scope
 * anyway: revealing one request must not unmask the rest of the queue.
 *
 * One eye covers the whole block (four masked values across before and after),
 * because one POST returns them all and writes ONE audit row. An eye per value
 * would bill four looks for one reading.
 */
function BankBlock({ requestId, canReveal, oldBank, newBank }: {
  requestId: number;
  canReveal: boolean;
  oldBank: BankFields;
  newBank: BankFields;
}) {
  const reveal = useReveal<RevealedRequestBank>(async () => {
    /* The response envelope is not fixed by the contract; the row-mirroring and
     * the flat shape are both accepted. Collapse once the route lands. */
    const r = await api.post<{
      changes?: { bank?: BankFields }; old_values?: { bank?: BankFields };
      bank?: BankFields; old_bank?: BankFields;
    }>(`${ENDPOINT}/${requestId}/reveal`);
    return {
      after: r?.changes?.bank ?? r?.bank ?? {},
      before: r?.old_values?.bank ?? r?.old_bank ?? {},
    };
  });

  /* Every bank sub-field the request carries, in reading order, plus anything
     unexpected the backend added. */
  const bankKeys = [
    ...BANK_FIELD_ORDER.filter((k) => newBank[k] != null),
    ...Object.keys(newBank).filter(
      (k) => !(BANK_FIELD_ORDER as readonly string[]).includes(k) && newBank[k as keyof BankFields] != null,
    ),
  ];

  /* Masked by default; the revealed plaintext is substituted only for the two
   * encrypted sub-fields, and only while the reveal is showing. */
  const side = (bk: string, from: BankFields, plain?: BankFields) =>
    displayValue(
      bk,
      (reveal.shown && SECRET_BANK_FIELDS.has(bk) ? plain?.[bk as keyof BankFields] : undefined)
        ?? from[bk as keyof BankFields],
    );

  return (
    <div className="rounded bg-muted px-2 py-1.5 space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{FIELD_LABEL.bank}</span>
        {/* No eye at all without the process key — not a disabled one. */}
        {canReveal && (
          <RevealButton
            shown={reveal.shown}
            busy={reveal.busy}
            onToggle={reveal.toggle}
            what={`Bank Details For Request #${requestId}`}
          />
        )}
      </div>
      {bankKeys.length === 0
        ? <span className="text-xs text-muted-foreground">No Bank Fields Supplied</span>
        : bankKeys.map((bk) => (
          <BeforeAfter
            key={bk}
            label={BANK_FIELD_LABEL[bk] ?? titleCaseLabel(bk)}
            before={side(bk, oldBank, reveal.value?.before)}
            after={side(bk, newBank, reveal.value?.after)}
          />
        ))}
    </div>
  );
}

/*
 * The Changes cell: a count, then every field's before → after.
 *
 * `bank` is one KEY but four VALUES, so it renders as its own labelled block
 * with one line per sub-field. Sub-fields the user re-submitted unchanged are
 * marked "No Change" instead of being hidden — the request applies all four
 * together, and an approver should see exactly what will be written.
 */
function ChangeSummary({ requestId, canReveal, changes, oldValues }: {
  requestId: number;
  canReveal: boolean;
  changes: ProfileChanges;
  oldValues: ProfileChanges;
}) {
  const keys = changedKeys(changes);
  if (keys.length === 0) {
    return <span className="text-xs text-muted-foreground">No Fields In This Request</span>;
  }

  return (
    <div className="space-y-1.5">
      <StatusChip tone="info" size="sm">{pluralize(keys.length, 'Change')}</StatusChip>
      <div className="space-y-1">
        {keys.map((k) => (
          k === 'bank' ? (
            <BankBlock
              key={k}
              requestId={requestId}
              canReveal={canReveal}
              oldBank={(oldValues.bank ?? {}) as BankFields}
              newBank={(changes.bank ?? {}) as BankFields}
            />
          ) : (
            <BeforeAfter
              key={k}
              label={fieldLabel(k)}
              before={displayValue(k, oldValues[k])}
              after={displayValue(k, changes[k])}
            />
          )
        ))}
      </div>
    </div>
  );
}

export default function ProfileUpdateApprovalsPage() {
  const { me } = useMe();
  /* Action keys, never a role name — HR here is a permission, not a role_id. */
  const can = actionFlags(me, ['isProfileApprovalView', 'isProfileApprovalProcess']);
  const canView = can.isProfileApprovalView;
  const canProcess = can.isProfileApprovalProcess;

  /* Pending is the worklist; the other two are history. Defaulting to the
     worklist means the page opens on the thing it exists for. */
  const [status, setStatus] = React.useState<string>('pending');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [rejecting, setRejecting] = React.useState<UpdateRequest | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const confirm = useConfirm();
  const dq = useDebouncedValue(search, 300);

  const limit = pageSizeToLimit(pageSize, LIST_LIMIT_MAX);
  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  if (status) qs.set('status', status);
  /* The route takes `page`, and every `page` param in this codebase is
     1-INDEXED (`Joi.number().integer().min(1).default(1)`). TablePagination is
     0-indexed, so the +1 belongs here at the API boundary. */
  qs.set('page', String(page + 1));
  qs.set('limit', String(limit));

  /* Deferred on a null key: a user without the view permission never fires a
     request the route would 403 anyway. */
  const listFetch = useFetch<ListResp>(canView ? `${ENDPOINT}?${qs.toString()}` : null);

  /* Any filter change re-queries from page 1. Narrowing the status filter while
     on page 4 otherwise asks for a page the smaller result set does not have,
     and the table renders empty with no visible cause. */
  React.useEffect(() => { setPage(0); }, [dq, status]);

  /*
   * Post-write refresh. BOTH halves are required: invalidateFetch evicts the
   * module cache but has no subscriber mechanism, so this MOUNTED list would
   * keep rendering the processed row until a reload without the refetch.
   */
  function refresh() {
    invalidateFetch((k) => k.startsWith(ENDPOINT));
    listFetch.refetch();
  }

  async function handleApprove(r: UpdateRequest) {
    const changes = asChanges(r.changes);
    const keys = changedKeys(changes);
    const ok = await confirm({
      title: `Approve ${pluralize(keys.length, 'Change')}?`,
      description:
        `${raisedByLabel(r)} asked to change ${listLabels(keys)}. `
        + 'Approving writes every field in this request at once — there is no per-field '
        + 'approval, so nothing here can be let through on its own. If only part of it '
        + 'should go ahead, reject the request and ask for a fresh one carrying just that.',
      confirmLabel: 'Approve Request',
    });
    if (!ok) return;

    setBusyId(r.request_id);
    const toastId = showToast({ variant: 'loading', message: 'Approving Request…' });
    try {
      await api.post(`${ENDPOINT}/${r.request_id}/process`, { action: 'approve' });
      dismissToast(toastId);
      showToast({
        variant: 'success',
        message: `Request #${r.request_id} Approved · ${pluralize(keys.length, 'Change')} Applied`,
      });
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Approve failed' });
    } finally {
      setBusyId(null);
      /* Refresh on the failure path too: the commonest failure IS the 409 for
         "no longer pending", and the row on screen is then stale by definition. */
      refresh();
    }
  }

  const rows = listFetch.data?.rows ?? listFetch.data?.items ?? [];
  const total = listFetch.data?.total ?? rows.length;

  /* Column widths, and the Actions column, follow the process permission. */
  const colWidths = canProcess
    ? ['6%', '18%', '38%', '14%', '16%', '8%']
    : ['6%', '20%', '40%', '15%', '19%'];
  const colCount = colWidths.length;

  if (!canView) {
    return (
      <div className="space-y-4">
        <PageHeading />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-warning-tint text-warning-strong">
              <Lock className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don’t have permission to view profile update requests. Ask an admin to
                grant you Profile Approval View
                (<code className="mx-0.5">isProfileApprovalView</code>) in Settings → Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeading />

      {/* Read-only is a STATE, not a failure. Said once, at the top, so the
          missing Actions column reads as this sentence rather than as a page
          that half-loaded. */}
      {!canProcess && (
        <Card>
          <CardContent className="flex items-start gap-2 p-3 text-sm">
            <Eye className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">View Only.</span>{' '}
              You can read every request here but not act on one. Approving and rejecting needs
              Profile Approval Process (<code className="mx-0.5">isProfileApprovalProcess</code>),
              granted in Settings → Manage Roles.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Said once, before anyone clicks an eye. */}
      {canProcess && (
        <Card>
          <CardContent className="p-3">
            <RevealNotice>
              Bank account numbers and holder names are stored encrypted and shown masked.
              Showing one in full is recorded against your name.
            </RevealNotice>
          </CardContent>
        </Card>
      )}

      {/* ── Filters ────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by employee name or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              aria-label="Search Profile Update Requests"
            />
          </div>
          <SearchSelect
            value={status}
            onChange={(v) => setStatus(v)}
            options={STATUS_FILTER_OPTIONS}
            placeholder="All Statuses"
            className="w-52"
          />
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-3 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* ── Queue ──────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {colWidths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="!text-center">Request</th>
                <th className="!text-left">Raised By</th>
                <th className="!text-left">Requested Changes</th>
                <th className="!text-left whitespace-nowrap">Raised On</th>
                <th className="!text-left">Status</th>
                {canProcess && <th className="!text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && (
                <tr>
                  <td colSpan={colCount} className="!text-center py-6 text-muted-foreground">Loading…</td>
                </tr>
              )}
              {!listFetch.loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="!text-center py-6 text-muted-foreground">
                    No profile update requests match the current filters.
                  </td>
                </tr>
              )}
              {!listFetch.loading && rows.map((r) => {
                const changes = asChanges(r.changes);
                const oldValues = asChanges(r.old_values);
                const meta = STATUS_META[String(r.status).toLowerCase()]
                  ?? { label: titleCaseLabel(r.status), tone: 'neutral' as StatusChipTone };
                const isPending = String(r.status).toLowerCase() === 'pending';
                const revised = wasRevised(r);
                const busy = busyId === r.request_id;
                return (
                  <tr key={r.request_id}>
                    <td className="!text-center font-mono text-xs">#{r.request_id}</td>
                    <td className="!text-left">
                      <div className="truncate font-medium" title={raisedByLabel(r)}>
                        {raisedByLabel(r)}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {r.user_code || `ID ${r.user_id}`}
                      </div>
                    </td>
                    <td className="!text-left">
                      <ChangeSummary
                        requestId={r.request_id}
                        canReveal={canProcess}
                        changes={changes}
                        oldValues={oldValues}
                      />
                    </td>
                    <td className="!text-left text-xs">
                      <div className="whitespace-nowrap">{formatDate(r.requested_on)}</div>
                      {/* A pending request the user merged into after raising it.
                          Flagged because an HR who read it yesterday is looking at
                          different content today. */}
                      {revised && (
                        <div className="mt-0.5">
                          <StatusChip
                            tone="warning"
                            size="sm"
                            title={`The user added to or changed this request on ${formatDate(r.updated_on)}.`}
                          >
                            <History className="mr-1 inline size-3" aria-hidden="true" />
                            Revised
                          </StatusChip>
                          <div className="mt-0.5 whitespace-nowrap text-muted-foreground">
                            {formatDate(r.updated_on)}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="!text-left">
                      <StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip>
                      {!isPending && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {formatDate(r.processed_on)}
                          {r.processed_by_name ? ` · ${r.processed_by_name}` : ''}
                        </div>
                      )}
                      {/* The remark IS the record for a rejection — kept on the
                          row rather than behind a detail view nobody opens. */}
                      {r.remarks && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground" title={r.remarks}>
                          “{r.remarks}”
                        </div>
                      )}
                    </td>
                    {canProcess && (
                      <td className="!text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1">
                          {/* Hidden, not disabled, on a settled request: the route
                              answers 409 for anything not pending and there is no
                              future in which the button becomes usable again. */}
                          {isPending ? (
                            <>
                              <IconButton
                                icon={Check}
                                label="Approve Request"
                                intent="success"
                                busy={busy}
                                onClick={() => handleApprove(r)}
                              />
                              <IconButton
                                icon={X}
                                label="Reject Request"
                                intent="danger"
                                disabled={busy}
                                onClick={() => setRejecting(r)}
                              />
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">closed</span>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
      />

      {/* Re-checks the permission as well as its trigger — a dialog that can
          write is worth gating at the dialog. */}
      {rejecting && canProcess && (
        <RejectRequestDialog
          request={rejecting}
          onClose={() => setRejecting(null)}
          onSaved={() => { setRejecting(null); refresh(); }}
        />
      )}
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <ShieldCheck className="size-6" /> Profile Update Requests
      </h1>
      <p className="text-sm text-muted-foreground">
        Changes CRM users have asked to make to their own mobile number, date of birth or bank
        details. Each request is approved or rejected as a whole.
      </p>
    </div>
  );
}

/*
 * Reject — a dialog rather than a bare confirm, because the remark is the only
 * explanation the user gets when their request disappears, so it is REQUIRED
 * and written as if they will read it. The confirm on top of it is the second
 * gate: rejecting discards every field in the request, not just the one the HR
 * objected to.
 */
function RejectRequestDialog({ request, onClose, onSaved }: {
  request: UpdateRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const [remarks, setRemarks] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const changes = asChanges(request.changes);
  const keys = changedKeys(changes);
  const canSubmit = remarks.trim() !== '' && !submitting;

  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: remarks.trim() !== '',
    when: () => !submitting,
  });

  async function handleSubmit() {
    if (!canSubmit) return;
    const ok = await confirm({
      title: `Reject ${pluralize(keys.length, 'Change')}?`,
      description:
        `This rejects the whole request from ${raisedByLabel(request)} — ${listLabels(keys)} `
        + 'are turned down together, because a request is approved or rejected as a unit. '
        + 'Their current details stay exactly as they are, and they will have to raise a new '
        + 'request for anything they still want changed.',
      confirmLabel: 'Reject Request',
      variant: 'destructive',
    });
    if (!ok) return;

    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Rejecting Request…' });
    try {
      await api.post(`${ENDPOINT}/${request.request_id}/process`, {
        action: 'reject',
        remarks: remarks.trim(),
      });
      dismissToast(toastId);
      showToast({ variant: 'success', message: `Request #${request.request_id} Rejected` });
      onSaved();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reject failed' });
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject Request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm">
            <div className="font-medium">{raisedByLabel(request)}</div>
            <div className="text-muted-foreground">
              Request #{request.request_id} · {request.user_code || `ID ${request.user_id}`}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-tint p-2 text-xs text-warning-strong">
            <AlertTriangle className="mt-px size-4 shrink-0" />
            <span>
              Rejecting turns down <strong>{listLabels(keys)}</strong> together — a request
              cannot be part-approved.
            </span>
          </div>

          <div>
            <Label className="mb-1 block" htmlFor="profile-request-remarks" required>Remarks</Label>
            <textarea
              id="profile-request-remarks"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Why this request cannot be approved — the employee sees this"
              className="min-h-[80px] w-full rounded border bg-background px-2 py-1 text-sm"
              maxLength={255}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Required. This is the only explanation the employee gets, so write it for them.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button variant="destructive" onClick={handleSubmit} disabled={!canSubmit}>
              <X className="mr-1 size-4" />
              {submitting ? 'Rejecting…' : 'Reject Request'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
