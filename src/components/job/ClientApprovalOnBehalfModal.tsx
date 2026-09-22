'use client';

/*
 * ClientApprovalOnBehalfModal — lets ops approve a material quote on the
 * client's behalf (job_status 15, "Approval Pending") when the client
 * confirmed by phone/WhatsApp rather than through their own portal. Owner-
 * approved design, 2026-09-22; the backend (POST
 * /admin/jobs/:id/client-approval-on-behalf) is being built in parallel
 * against the contract documented below and on api.ts's
 * approveJobOnClientBehalf.
 *
 * Mirrors MaterialReviewModal's shape (same compact Job Details block, same
 * useFetch/useConfirm/showToast/useFormDirtyGuard conventions) but this
 * modal only ever READS the quotation lines — there is nothing left for ops
 * to edit at 15, the technician's approved_charge amounts are already set
 * from the status-16 review. What ops supply here is proof that the client
 * said yes: a comment (10..1000 chars) plus 1..5 audio/image/pdf files,
 * stored server-side as job documents under category 'ClientApprovalProof'.
 *
 * Contract:
 *   POST /admin/jobs/:id/client-approval-on-behalf, multipart/form-data:
 *     comment (required, 10..1000 chars), files (1..5, each <=10MB; audio
 *     mp3/m4a/wav/aac/ogg, image jpeg/png/webp/heic, pdf).
 *   Response { job_status: 1, schedule: { rescheduled, requested_date_time,
 *   needs_scheduling } }.
 *   409 "This job is not waiting for client approval" when job_status != 15.
 *
 * Rows shown: /admin/quotations?jobId= lines with state === 'approval_pending'
 * (the client-approval-pending v2 state — see background in the task brief),
 * grouped by quotation_no via the SAME lib/quotation-groups.ts helper
 * MaterialReviewModal and JobQuotationsTab use, so all three surfaces group
 * identically.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Paperclip, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { api, ApiError, type ClientApprovalOnBehalfResult } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatDate, formatEasyfixerName, statusLabel, statusTone } from '@/lib/utils';
import { displaySlot } from '@/lib/job-slots';
import {
  APPROVAL_COMMENT_MAX, APPROVAL_COMMENT_MIN,
  validateApprovalComment, validateApprovalFiles, approvalSuccessToast,
} from '@/lib/client-approval';
import type { QuotationRow } from './JobModal';
import { groupByQuotationNo } from '@/lib/quotation-groups';

type JobDetails = Record<string, unknown> & {
  job_id: number; job_status: number;
  fk_easyfixter_id?: number | null;
  client_name?: string | null; customer_name?: string | null; city_name?: string | null;
  service_category?: string | null; job_type?: string | null;
  easyfixer_name?: string | null; requested_date_time?: string | null;
};

function lineAmount(r: QuotationRow): number {
  if (r.approved_charge != null) return Number(r.approved_charge) || 0;
  return (Number(r.unit) || 0) * (Number(r.unit_price) || 0);
}

// Human-readable file size — "128 KB" / "3.4 MB". Good enough for a picker
// list; no need for a shared formatter over one call site.
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ClientApprovalOnBehalfModal({
  open, jobId, onClose, onApproved,
}: {
  open: boolean;
  jobId: number | null;
  onClose: () => void;
  /* Called after a successful approval so the caller's list refetches. */
  onApproved?: () => void;
}) {
  const { me } = useMe();
  const can = actionFlags(me, ['isJobMaterialReview']);
  const enabled = open && jobId != null && can.isJobMaterialReview;

  const { data: job } = useFetch<JobDetails>(enabled ? `/admin/jobs/${jobId}` : null);
  const { data: quoteData } = useFetch<QuotationRow[]>(
    enabled ? `/admin/quotations?jobId=${jobId}` : null,
  );
  const rows: QuotationRow[] = Array.isArray(quoteData) ? quoteData : [];
  // Awaiting-client lines only — the v2 state a line sits in from the moment
  // MaterialReviewModal's Send lands until the client (or, here, ops on
  // their behalf) decides. See lib/job-comment... no: see the task brief's
  // "Background" section — state 'approval_pending' is the wire contract.
  const approvalRows = useMemo(
    () => rows.filter((r) => String(r.type) === 'material' && r.state === 'approval_pending'),
    [rows],
  );
  const groups = useMemo(() => groupByQuotationNo(approvalRows), [approvalRows]);
  const total = approvalRows.reduce((sum, r) => sum + lineAmount(r), 0);

  const confirm = useConfirm();
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setComment('');
    setFiles([]);
  }, [open, jobId]);

  const isDirty = comment.trim() !== '' || files.length > 0;
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy, isDirty });

  if (!jobId) return null;

  const commentError = validateApprovalComment(comment);
  const filesError = validateApprovalFiles(files);
  const canSubmit = !commentError && !filesError;

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (jobId == null) return; // guarded by the `if (!jobId) return null;` render above; narrows for TS here too
    if (!canSubmit) {
      showToast({ variant: 'error', message: commentError || filesError || 'Fix The Errors Above.' });
      return;
    }
    const ok = await confirm({
      title: 'Approve On Client’s Behalf?',
      description: 'This records that the client approved the material quote by phone/WhatsApp, and moves the job forward as approved.',
      confirmLabel: 'Approve For Client',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result: ClientApprovalOnBehalfResult = await api.approveJobOnClientBehalf(
        jobId, comment.trim(), files,
      );
      const dt = result.schedule.requested_date_time;
      const formattedDateTime = dt ? `${formatDate(dt)} (${displaySlot(dt, null)})` : '';
      const toast = approvalSuccessToast(result.schedule, formattedDateTime);
      showToast({ variant: toast.variant, message: toast.message });
      // Any surface listing this job (Manage Jobs, My Orders, dashboard
      // counts) reads a status/schedule that just changed.
      invalidateFetch((k) => k.startsWith('/admin/jobs') || k.startsWith('/admin/quotations'));
      onApproved?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed To Submit Approval';
      showToast({ variant: 'error', message: msg });
      // 409 = the job left "Approval Pending" (client already acted, or a
      // fresh review reopened it) since this modal's data loaded. The
      // server's own message says so; close and let the list refresh rather
      // than leave the operator resubmitting against a stale job.
      if (e instanceof ApiError && e.status === 409) {
        invalidateFetch((k) => k.startsWith('/admin/jobs') || k.startsWith('/admin/quotations'));
        onApproved?.();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <CheckCircle2 className="h-4 w-4" />
            Approve On Client&rsquo;s Behalf — Job #{jobId}
            {job && (
              <StatusChip tone={statusTone(Number(job.job_status))} size="sm">
                {statusLabel(Number(job.job_status), { assigned: job.fk_easyfixter_id != null })}
              </StatusChip>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Compact Job Details — same fields, same GET /admin/jobs/:id
              payload as MaterialReviewModal's header block. */}
          {job && (
            <div className="rounded-lg border bg-muted/20 p-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              <div><div className="text-xs text-muted-foreground">Client</div><div className="font-medium truncate">{job.client_name || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Customer</div><div className="font-medium truncate">{job.customer_name || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">City</div><div className="font-medium truncate">{job.city_name || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Service / Category</div><div className="font-medium truncate">{job.service_category || job.job_type || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Technician</div><div className="font-medium truncate">{job.easyfixer_name ? formatEasyfixerName(job.easyfixer_name) : '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Appointment</div><div className="font-medium truncate">{job.requested_date_time ? formatDate(job.requested_date_time) : '—'}</div></div>
            </div>
          )}

          {/* Read-only — nothing left to edit at 15; the approved amounts
              were set during the status-16 Material Review. */}
          {approvalRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No Lines Awaiting Client Approval.</div>
          ) : (
            <div className="rounded-lg border bg-card overflow-hidden">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="!text-left">Item</th>
                    <th className="!text-right">Qty</th>
                    <th className="!text-right">Approved Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.flatMap((g) => [
                    <tr key={`grp-${g.quotationNo ?? 'draft'}`} className="bg-muted/30">
                      <td colSpan={3} className="!text-left text-xs font-medium text-muted-foreground px-2 py-1.5">
                        {g.quotationNo != null ? `Quotation ${g.quotationNo}` : 'Ungrouped'}
                      </td>
                    </tr>,
                    ...g.rows.map((r) => (
                      <tr key={Number(r.id)}>
                        <td className="!text-left">{String(r.name ?? '—')}</td>
                        <td className="!text-right font-mono text-xs">{String(r.unit ?? '')}</td>
                        <td className="!text-right font-mono text-xs">{lineAmount(r).toFixed(2)}</td>
                      </tr>
                    )),
                  ])}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <td className="!text-left" colSpan={2}>Total</td>
                    <td className="!text-right font-mono text-xs">{total.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="client-approval-comment">
              Comment<span className="text-urgent-strong">*</span>
            </Label>
            <textarea
              id="client-approval-comment"
              required
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="How did the client approve — call/WhatsApp, who spoke to them, when…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40 resize-y"
              maxLength={APPROVAL_COMMENT_MAX}
              aria-invalid={!!commentError}
            />
            <div className="flex items-center justify-between text-xs">
              <span className={commentError ? 'text-urgent-strong' : 'text-muted-foreground'}>
                {commentError || `Minimum ${APPROVAL_COMMENT_MIN} Characters.`}
              </span>
              <span className="text-muted-foreground">{comment.trim().length}/{APPROVAL_COMMENT_MAX}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Proof Files<span className="text-urgent-strong">*</span></Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*,image/*,application/pdf"
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                <Paperclip className="h-3.5 w-3.5 mr-1" />
                Choose Files
              </Button>
            </div>
            {files.length > 0 && (
              <ul className="space-y-1">
                {files.map((f, idx) => (
                  <li key={`${f.name}-${f.lastModified}-${idx}`} className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1 text-xs">
                    <span className="truncate">{f.name}</span>
                    <span className="text-muted-foreground whitespace-nowrap">{fileSize(f.size)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => removeFile(idx)}
                      disabled={busy}
                      className="text-urgent-strong hover:opacity-70"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className={filesError ? 'text-xs text-urgent-strong' : 'text-xs text-muted-foreground'}>
              {filesError || `${files.length}/5 Files — Audio, Image, Or PDF, Up To 10 MB Each.`}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !canSubmit}>
            {busy ? '…' : 'Approve for Client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
