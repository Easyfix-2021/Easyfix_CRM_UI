'use client';

/*
 * UrgentAlerts — SL instant-popup for the approver (spec §7 / §8).
 *
 * Mounted once in the authed layout. Polls GET /admin/leave/alerts every 30s
 * while the tab is visible, every 2 min while hidden (+ on window focus, which also fires the very
 * first check after a background stretch). A fresh alert is queued as a
 * modal — one at a time, like NoticeFlash's deck — and, if the tab happens
 * to be hidden at the moment it arrives, ALSO fires a desktop Notification
 * so the approver isn't relying on spotting the modal the instant they tab
 * back in. Notification permission is asked only from inside the modal
 * (Later / Review), never unprompted on load.
 *
 * "Never double-pop": once a key is queued it's added to `shownKeys` and
 * never queued again for this session, even if a later poll returns it
 * again before the ack write lands.
 *
 * No poll helper existed in lib/hooks for a visibility-gated interval, so
 * this builds one from the plain useFetch(key, { refetchInterval }) already
 * there — 30s while visible, 2 min while hidden (so the desktop Notification
 * can fire from a background tab); the interval switches as visibility flips.
 */

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api } from '@/lib/api';
import { LEAVE_DURATION_LABEL, type LeaveAlert, type LeaveAlertsResponse } from './leave-types';

const POLL_MS = 30_000;
// A hidden tab still polls, slower — otherwise the desktop Notification below
// (the whole point of a background tab) could only ever fire on refocus.
// Browsers throttle hidden-tab timers to ~1/min anyway, so 2 min costs little.
const HIDDEN_POLL_MS = 120_000;

function askNotificationPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') void Notification.requestPermission();
}

export function UrgentAlerts() {
  const router = useRouter();

  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const fetched = useFetch<LeaveAlertsResponse>('/admin/leave/alerts', {
    refetchInterval: visible ? POLL_MS : HIDDEN_POLL_MS,
  });
  const refetchRef = React.useRef(fetched.refetch);
  refetchRef.current = fetched.refetch;
  React.useEffect(() => {
    const onFocus = () => refetchRef.current();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const [queue, setQueue] = React.useState<LeaveAlert[]>([]);
  const shownKeys = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const items = fetched.data?.items;
    if (!items || items.length === 0) return;
    const fresh = items.filter((a) => !shownKeys.current.has(a.key));
    if (fresh.length === 0) return;
    fresh.forEach((a) => shownKeys.current.add(a.key));

    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      fresh.forEach((a) => {
        new Notification(`Sick Leave Request · ${a.userName}`, {
          body: `Today (${LEAVE_DURATION_LABEL[a.duration] ?? a.duration})`,
        });
      });
    }
    setQueue((prev) => [...prev, ...fresh]);
  }, [fetched.data]);

  const current = queue[0] ?? null;

  async function ack(key: string) {
    try { await api.post(`/admin/leave/alerts/${key}/ack`); } catch { /* best-effort — a re-poll would just re-show it */ }
  }

  function dismissCurrent() {
    setQueue((prev) => prev.slice(1));
  }

  async function handleLater() {
    if (!current) return;
    askNotificationPermission();
    const key = current.key;
    dismissCurrent();
    await ack(key);
  }

  async function handleReview() {
    if (!current) return;
    askNotificationPermission();
    const { key, requestId } = current;
    dismissCurrent();
    await ack(key);
    router.push(`/employee-hub/approvals?request=${requestId}`);
  }

  // Esc / backdrop click behaves exactly like "Later" — ack for this session
  // and move to the next queued alert, never a discard-changes prompt (this
  // modal has no form input to lose).
  const guardedOpenChange = useFormDirtyGuard(() => { void handleLater(); }, { isDirty: false });

  if (!current) return null;

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent hideClose className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-warning" /> Sick Leave Request
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1 text-sm">
          <div className="font-medium">{current.userName}</div>
          <div className="text-muted-foreground">Today ({LEAVE_DURATION_LABEL[current.duration] ?? current.duration})</div>
          {current.reason && <div className="text-muted-foreground italic">“{current.reason}”</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void handleLater()}>Later</Button>
          <Button onClick={() => void handleReview()}>Review Request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
