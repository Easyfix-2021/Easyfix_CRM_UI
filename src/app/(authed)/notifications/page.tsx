'use client';

/*
 * Notifications Inbox — in-app feed of system + job-lifecycle messages.
 *
 * Backend (verified contract from services/notification-inbox.service.js):
 *   GET   /admin/notifications/inbox          → { items: [...], unread: N }
 *   GET   /admin/notifications/inbox/count    → { unread: N }
 *   PATCH /admin/notifications/inbox/:id/read → { read: true }
 *   PATCH /admin/notifications/inbox/read-all → { allRead: true }
 *
 * Row columns from `dashboard_notification_log`:
 *   id, user_id, job_id, n_title, n_desc, n_to, status ('read'|'unread'), createdAt
 *
 * Note: notifications-inbox.js is sub-mounted INSIDE
 * routes/admin/notifications.js (line 4: router.use(require('./notifications-inbox')))
 * — so the base URL is /admin/notifications, not /admin/notifications-inbox.
 */

import { useEffect, useState } from 'react';
import { Bell, CheckCheck, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

type InboxRow = {
  id: number;
  user_id: number;
  job_id: number | null;
  n_title: string | null;
  n_desc: string | null;
  n_to: string | null;
  status: 'read' | 'unread';
  createdAt: string;
};

type InboxResponse = {
  items: InboxRow[];
  unread: number;
};

export default function NotificationsInboxPage() {
  const [items, setItems] = useState<InboxRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await api.get<InboxResponse>(`/admin/notifications/inbox`);
      setItems(Array.isArray(data?.items) ? data.items : []);
      setUnread(Number(data?.unread ?? 0));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load inbox');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function markRead(id: number) {
    try {
      await api.patch(`/admin/notifications/inbox/${id}/read`, {});
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, status: 'read' } : it));
      setUnread((n) => Math.max(0, n - 1));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to mark read');
    }
  }

  async function markAllRead() {
    try {
      await api.patch('/admin/notifications/inbox/read-all', {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to mark all read');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="size-6" /> Notifications
            {unread > 0 && (
              <span className="text-xs font-medium rounded bg-red-100 text-red-700 px-2 py-0.5">
                {unread} unread
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            System + job-lifecycle messages addressed to you.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={markAllRead} disabled={unread === 0}>
            <CheckCheck className="size-4 mr-1" /> Mark all read
          </Button>
        </div>
      </div>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      {loading && (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">Loading…</CardContent></Card>
      )}

      {!loading && items.length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          No messages in your inbox.
        </CardContent></Card>
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-2">
          {items.map((it) => {
            const isRead = it.status === 'read';
            return (
              <Card key={it.id} className={isRead ? 'opacity-60' : ''}>
                <CardContent className="p-3 flex items-start gap-3">
                  <div className={`mt-1 size-2 rounded-full shrink-0 ${isRead ? 'bg-muted' : 'bg-primary'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="font-medium truncate">{it.n_title ?? '(no subject)'}</div>
                      <div className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(it.createdAt)}</div>
                    </div>
                    {it.n_desc && <div className="text-sm text-muted-foreground whitespace-pre-wrap">{it.n_desc}</div>}
                    {it.job_id && (
                      <a href={`/jobs?view=${it.job_id}`} className="text-xs text-blue-700 hover:underline mt-1 inline-block">
                        View job #{it.job_id} →
                      </a>
                    )}
                  </div>
                  {!isRead && (
                    <Button size="sm" variant="ghost" onClick={() => markRead(it.id)}>
                      Mark read
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
