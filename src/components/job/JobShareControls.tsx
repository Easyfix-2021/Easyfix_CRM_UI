'use client';

/*
 * Job delegation surfaces for the CRM — the SHARED chip and the ops release.
 *
 * ─── WHY AN OPERATOR NEEDS BOTH ───────────────────────────────────────────
 *
 * A delegated job keeps `fk_easyfixter_id` pointed at the ORIGINAL technician,
 * so every column in the jobs list keeps naming him while somebody else does
 * the work and he himself is refused every mutating route (409 `job_shared`).
 * The chip is the only thing on the screen that explains that, which is why a
 * bare "Shared" is not enough: it has to name the delegate and the state.
 *
 * Once the delegate has STARTED, the sharer's own cancel window is closed.
 * `POST /api/admin/jobs/:id/share/release` is then the ONLY way out — so the
 * release control is not an admin curiosity, it is the escape hatch for a
 * stuck order, and it lives in the job modal's footer where ops already looks
 * for lifecycle buttons.
 *
 * ─── GRAMMAR ──────────────────────────────────────────────────────────────
 *
 * The chip is `<StatusChip>` — the same component every job-status pill in the
 * estate renders through — at `size="sm"`, the sub-status size the "Draft" and
 * "Link Sent" pills already use. No second chip vocabulary; the tone/label
 * decision itself lives in `@/lib/job-share` so it is unit-tested rather than
 * source-scanned.
 *
 * The release button follows ResendPinButton: the permission key and the route
 * are each declared ONCE here and imported by call sites, so a rename cannot
 * hide the control on one page only.
 */

import { useState } from 'react';
import { Unlock } from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { shareChip, isShareLive, shareDelegateLabel, type JobShare } from '@/lib/job-share';
import { StatusChip } from '@/components/ui/StatusChip';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

/*
 * The action key the backend seeds into `menu_action` and grants via
 * `role_menu_action`; resolved into `me.permissions.actionPermissions` by
 * /api/auth/me. Declared once, imported by every call site.
 */
export const SHARE_RELEASE_ACTION = 'isJobShareRelease';

/* Single source for the route, same reasoning as the action key above. */
const SHARE_RELEASE_PATH = (jobId: number) => `/admin/jobs/${jobId}/share/release`;

/*
 * ShareChip — renders nothing at all when there is no LIVE share, so a call
 * site is a bare `<ShareChip share={j.share} />` with no surrounding guard.
 */
export function ShareChip({ share, className }: { share: JobShare | null | undefined; className?: string }) {
  const chip = shareChip(share);
  if (!chip) return null;
  return (
    <StatusChip tone={chip.tone} size="sm" title={chip.title} className={className}>
      {chip.label}
    </StatusChip>
  );
}

export type ReleaseShareButtonProps = {
  jobId: number;
  share: JobShare | null | undefined;
  /* The caller's permission flag — `canJob[SHARE_RELEASE_ACTION]`. Passed
   * rather than read here so this component stays free of the auth context.
   * Falsy → renders nothing. */
  allowed: boolean;
  /* Refresh the job after a successful release — the lock has just lifted and
   * the chip must disappear. */
  onReleased?: () => void;
};

export function ReleaseShareButton({ jobId, share, allowed, onReleased }: ReleaseShareButtonProps) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  /* Self-gate on both the permission AND a live share: releasing a share that
   * already ended is a no-op the operator would still have to think about. */
  if (!allowed || !isShareLive(share)) return null;

  const live = share as JobShare;
  const who = shareDelegateLabel(live);
  const owner = (live.sharedByName || '').trim() || 'the assigned technician';

  async function onClick() {
    if (busy) return;
    /* Confirm FIRST — this yanks a job out from under a technician who may be
     * standing in the customer's hallway. The copy names both people and says
     * what happens to the work already done. */
    const ok = await confirm({
      title: 'Release This Share?',
      description:
        `Order #${jobId} is currently being worked by ${who} on behalf of ${owner}. `
        + `Releasing ends the delegation immediately: ${who} loses access and the job goes `
        + `back to ${owner}. Any work ${who} has not saved is lost. This cannot be undone — `
        + 'the technician would have to share the job again.',
      confirmLabel: 'Release Share',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      icon: <Unlock className="h-4 w-4" />,
      iconAccent: 'rose',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(SHARE_RELEASE_PATH(jobId), {});
      showToast({ variant: 'success', message: `Share released. Order #${jobId} is back with ${owner}.` });
      onReleased?.();
    } catch (e) {
      /* A 409 here is INFORMATION ("already released", "no live share") that
       * ops can act on, so surface the server's own sentence rather than
       * flattening every failure into a generic message. */
      showToast({
        variant: 'error',
        message: formatApiError(e, { fallback: 'Could not release the share.' }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="destructive" disabled={busy} onClick={onClick} title={`Force-end the delegation to ${who}`}>
      Release Share
    </Button>
  );
}
