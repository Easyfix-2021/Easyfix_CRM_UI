'use client';

/*
 * Custom Reports — Transfer Owner.
 *
 * Its own file because BOTH the report page and the list page's row menu
 * open it; it used to be a private function inside [id]/page.tsx. Gated on
 * the Admin key (isQuickSightDynamicReportAdmin) at the call site — the BE
 * enforces the same, so a hand-rolled PUT gets 403 regardless.
 */

import * as React from 'react';
import { Loader2, UserCog } from 'lucide-react';

import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useLookup } from '@/lib/use-lookup';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { SearchSelect } from '@/components/ui/search-select';

const API_BASE = '/admin/quicksight/dynamic-reports';

export function TransferOwnerDialog({
  reportId, currentOwnerId, onClose, onTransferred,
}: {
  reportId: number;
  currentOwnerId: number;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const lookup = useLookup();
  const [userId, setUserId] = React.useState<number | ''>('');
  const [submitting, setSubmitting] = React.useState(false);
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => userId !== '', when: () => !submitting });

  async function submit() {
    if (!userId || submitting) return;
    setSubmitting(true);
    try {
      await api.put(`${API_BASE}/${reportId}/owner`, { userId });
      showToast({ variant: 'success', message: 'Owner transferred.' });
      onTransferred();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not transfer ownership' }) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UserCog className="size-4" /> Transfer Owner</DialogTitle>
        </DialogHeader>
        <SearchSelect
          value={userId}
          onChange={(v) => setUserId(v ? Number(v) : '')}
          options={lookup.toOpts.adminUsers.filter((o) => o.value !== currentOwnerId)}
          placeholder="Select New Owner"
        />
        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={submit} disabled={!userId || submitting}>
            {submitting ? <><Loader2 className="mr-1 size-4 animate-spin" /> Transferring…</> : 'Transfer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
