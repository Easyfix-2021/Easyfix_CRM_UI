'use client';

/**
 * Per-row chase actions: Nudge · Call · Mark Chased.
 *
 * WHY THE BROWSER NEVER HOLDS A PHONE NUMBER
 *
 * /api/admin/* responses are mobile-masked on the way out, so the CRM only
 * ever sees "9876••••••". Every action here therefore posts an efrId and lets
 * the server resolve the number. A wa.me deep link would need the real digits
 * in the page — that is a strictly worse trade than one confirm dialog, and it
 * would also be the wrong mechanism outside WhatsApp's 24-hour window, where a
 * business-initiated message must be an approved template.
 *
 * WHY A COOLDOWN SKIP IS REPORTED, NOT HIDDEN
 *
 * The server silently drops anyone chased on the same channel inside the
 * cooldown window and logs each skip. The toast says so, because an operator
 * who clicks Nudge on twelve rows and sees "12 nudged" when four were skipped
 * has been told something false about work they are accountable for.
 */

import * as React from 'react';
import { Bell, Phone, CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { formatApiError } from '@/lib/api-errors';
import type { DetectorKey } from '@/lib/lms-action';

export type ChaseTarget = {
  efrIds: number[];
  courseId?: number | null;
  detectorKey?: DetectorKey;
};

/** One line of feedback that reflects what actually happened, not what was asked for. */
function describeNudge(d: { targeted: number; delivered: number; cooldownSkipped: number }) {
  const bits = [`${d.delivered} nudged`];
  if (d.cooldownSkipped) bits.push(`${d.cooldownSkipped} skipped (chased recently)`);
  const silent = d.targeted - d.delivered - d.cooldownSkipped;
  if (silent > 0) bits.push(`${silent} had no device`);
  return bits.join(' · ');
}

export function ChaseButtons({
  target,
  disabled = false,
  compact = false,
  onDone,
}: {
  target: ChaseTarget;
  disabled?: boolean;
  compact?: boolean;
  onDone?: () => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);
  const count = target.efrIds.length;

  async function post(path: string, label: string, extra: Record<string, unknown> = {}) {
    setBusy(label);
    const t = showToast({ variant: 'loading', message: `${label}…` });
    try {
      const res = await api.post<{ data?: Record<string, number> } | Record<string, number>>(path, {
        efrIds: target.efrIds,
        courseId: target.courseId ?? null,
        detectorKey: target.detectorKey,
        ...extra,
      });
      const d = ((res as { data?: Record<string, number> }).data ?? res) as Record<string, number>;
      dismissToast(t);
      if (label === 'Nudging') {
        const summary = describeNudge({
          targeted: Number(d.targeted || 0),
          delivered: Number(d.delivered || 0),
          cooldownSkipped: Number(d.cooldownSkipped || 0),
        });
        showToast({ variant: Number(d.delivered) > 0 ? 'success' : 'warning', message: summary });
      } else {
        showToast({ variant: 'success', message: `${d.recorded ?? count} recorded` });
      }
      onDone?.();
    } catch (e) {
      dismissToast(t);
      showToast({ variant: 'error', message: formatApiError(e, { fallback: `${label} failed` }) });
    } finally {
      setBusy(null);
    }
  }

  async function nudge() {
    if (count > 1) {
      const ok = await confirm({
        title: 'Send an in-app nudge?',
        description: `${count} technicians will get a push notification. Anyone already chased in the last 20 hours is skipped automatically.`,
        confirmLabel: 'Send Nudge',
        iconAccent: 'sky',
      });
      if (!ok) return;
    }
    await post('/admin/lms/chase/nudge', 'Nudging');
  }

  async function markChased() {
    const ok = await confirm({
      title: 'Mark as chased?',
      description: `Records that ${count === 1 ? 'this technician was' : `${count} technicians were`} contacted outside the app, so the chase history stays complete.`,
      confirmLabel: 'Mark Chased',
      iconAccent: 'emerald',
    });
    if (!ok) return;
    await post('/admin/lms/chase/mark-chased', 'Recording');
  }

  const size = compact ? 'sm' : 'default';

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size={size}
        variant="outline"
        disabled={disabled || !count || busy !== null}
        onClick={nudge}
        title="Send the in-app push"
      >
        <Bell className="h-3.5 w-3.5" />
        {!compact && <span className="ml-1.5">Nudge</span>}
      </Button>
      {/*
       * Call is single-target only: click-to-call dials one person, and a
       * bulk "call" button would imply something the telephony stack cannot do.
       */}
      {count === 1 && (
        <Button
          size={size}
          variant="outline"
          disabled={disabled || busy !== null}
          onClick={() => post('/admin/lms/chase/mark-chased', 'Recording', { note: 'called from CRM' })}
          title="Record that you called this technician"
        >
          <Phone className="h-3.5 w-3.5" />
          {!compact && <span className="ml-1.5">Call</span>}
        </Button>
      )}
      <Button
        size={size}
        variant="outline"
        disabled={disabled || !count || busy !== null}
        onClick={markChased}
        title="Record an off-platform contact"
      >
        <CheckCheck className="h-3.5 w-3.5" />
        {!compact && <span className="ml-1.5">Mark Chased</span>}
      </Button>
    </div>
  );
}

export default ChaseButtons;
