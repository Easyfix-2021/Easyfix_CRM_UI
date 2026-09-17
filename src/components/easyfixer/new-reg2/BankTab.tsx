'use client';
/*
 * Bank tab — bank fields, finance verification, notes and edit.
 *
 * The finance-verify contract is account-level (PUT .../verification/banking
 * {verification_status:1|2}), not per-item, so a single Valid/Invalid action
 * bar is rendered (per-item accept/reject would need a new endpoint). API-
 * verified badges come from is_verified_by_app; "verified by" from the review
 * metadata; notes reuse the Banking comments thread; editing reuses
 * EasyfixerBankDialog (opened by the parent).
 */
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { CommentsPanel, type CommentEntry } from '@/components/easyfixer/CommentsPanel';
import { formatDate } from '@/lib/utils';
import { SectionCard, KV, EndpointPending } from './ui';
import type { VerificationPayload } from './types';

export function BankTab({
  efrId,
  v,
  canEditBank,
  onEditBank,
  onReload,
}: {
  efrId: number;
  v: VerificationPayload;
  canEditBank: boolean;
  onEditBank: () => void;
  onReload: () => Promise<void> | void;
}) {
  const b = v.registrationVerification.banking;
  const verified = b.verification_status === 1;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function mark(status: 1 | 2) {
    if (status === 2 && note.trim().length === 0) {
      showToast({ variant: 'error', message: 'A reason is required to mark banking invalid.' });
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/easyfixers/${efrId}/verification/banking`, {
        verification_status: status,
        verification_comment: status === 2 ? note : undefined,
      });
      showToast({ variant: 'success', message: status === 1 ? 'Banking marked valid.' : 'Banking marked invalid.' });
      setNote('');
      await onReload();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Action failed' });
    } finally {
      setBusy(false);
    }
  }

  const addNote = async (text: string) => {
    await api.post(`/admin/easyfixers/${efrId}/verification/comments`, { text, section: 'Banking Details Section' });
    await onReload();
  };

  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${verified ? 'border-success/40 bg-success-tint' : 'border-destructive/40 bg-urgent-tint'}`}>
        <div className="flex-1 text-sm text-ink-900">
          <strong className="block font-semibold">{verified ? '✓ Account verified by Finance' : 'Account not yet verified'}</strong>
          {verified
            ? 'Payouts enabled.'
            : 'Finance must validate the account before payouts release. Account no., IFSC and holder name are auto-checked by 3rd-party APIs when the app verifies them.'}
        </div>
        {canEditBank && <Button size="sm" variant="outline" onClick={onEditBank}>Update bank details</Button>}
      </div>

      <SectionCard title="Bank details" icon={<span>🏦</span>} right={b.is_verified_by_app ? <span className="rounded-full bg-success-tint px-2 py-0.5 text-success-strong">✓ App/API verified</span> : <span>source: technician app</span>}>
        <KV k="Banking name" v={b.bank_name} />
        <KV k="Account number" v={b.account_number} mono />
        <KV k="IFSC code" v={b.ifsc_code} mono />
        <KV k="Account holder name" v={b.account_holder_name} />
        <KV k="Preferred mode of transfer" v={b.mode_of_payment} />
        <KV k="Cancelled cheque" v={b.cancelled_cheque_img ? 'Uploaded' : null} />
        <KV k="Reviewed by" v={b.updated_by_name ? `${b.updated_by_name} · ${formatDate(b.update_date)}` : null} />

        {!verified && (
          <div className="mt-4 border-t pt-3">
            <label className="mb-1 block text-xs font-semibold text-muted-foreground">Mark verification</label>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (required to mark invalid)"
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => mark(2)}>Invalid banking details</Button>
              <Button size="sm" disabled={busy} onClick={() => mark(1)} className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white">Valid banking details</Button>
            </div>
          </div>
        )}
        {b.verification_comment && b.verification_status === 2 && (
          <div className="mt-2 rounded bg-muted p-2 text-xs text-ink-700">Invalid reason: {b.verification_comment}</div>
        )}
      </SectionCard>

      <SectionCard title="Finance notes" icon={<span>💬</span>}>
        <CommentsPanel entries={b.comments as CommentEntry[]} onAdd={addNote} addLabel="Add a finance note" />
      </SectionCard>

      <SectionCard title="Bank change history" icon={<span>🗂️</span>} right={<span>append-only audit</span>}>
        <EndpointPending what="Bank-change audit trail needs GET /admin/easyfixers/:id/bank/history (who changed which fields, when, with penny-drop/name-match results). Not available today." />
      </SectionCard>
    </div>
  );
}
