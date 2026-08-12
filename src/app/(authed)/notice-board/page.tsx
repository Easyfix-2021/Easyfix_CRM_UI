'use client';

/*
 * Notice Board — All Notices (Screen A from the spec).
 *
 * Table columns (matching the spec wireframe):
 *   Title · Category · Audience · Status · Published · Reach · Read% · Actions
 *
 * Filters: search (title/body), category, status.
 * Actions:
 *   - Edit          → /notice-board/<id>            (only draft/scheduled — published locks)
 *   - Publish/Send  → POST /admin/notices/:id/publish (draft only)
 *   - Archive       → POST /admin/notices/:id/archive
 *
 * Gating: the WHOLE page requires `isNoticeManage`. Without it the
 * sidebar entry doesn't appear, and the direct-URL guard below
 * redirects to /dashboard. Read-only consumption lives on the
 * dashboard NoticeStrip — this page is for authors.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Megaphone, Plus, Search, Edit2, Send, Archive as ArchiveIcon, AlertTriangle, Trash2 } from 'lucide-react';
import { SearchSelect } from '@/components/ui/search-select';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useFetch, useFetchOnce, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { api } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { NoticeCategoryTag } from '@/components/notice/NoticeChip';
import { ComposeWizard } from '@/components/notice/ComposeWizard';
import { parseSurfaces, type Notice, type NoticeCategory, type NoticeStatus } from '@/lib/notice-types';

type ListResp = { items: Notice[]; total: number };
type CatResp  = { items: NoticeCategory[] };

const STATUS_PILL: Record<string, string> = {
  draft:     'bg-slate-100 text-slate-700 border-slate-300',
  scheduled: 'bg-amber-100 text-amber-800 border-amber-300',
  published: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  archived:  'bg-zinc-100 text-zinc-600 border-zinc-300',
  expired:   'bg-rose-100 text-rose-700 border-rose-300',
};

function formatPublishedAt(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function surfaceBadges(csv: string) {
  const surfaces = parseSurfaces(csv);
  if (surfaces.length === 0) return <span className="text-muted-foreground">—</span>;
  const labels: Record<string, string> = { crm: 'CRM', client: 'Client', technician: 'Tech' };
  return (
    <div className="flex flex-wrap gap-1">
      {surfaces.map((s) => (
        <span key={s} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-slate-100 text-slate-700 border border-slate-300">
          {labels[s]}
        </span>
      ))}
    </div>
  );
}

export default function NoticeBoardListPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const canManage = hasAction(me, 'isNoticeManage');

  React.useEffect(() => {
    if (!meLoading && !canManage) router.replace('/dashboard');
  }, [meLoading, canManage, router]);

  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<NoticeStatus | ''>('');
  const [categoryFilter, setCategoryFilter] = React.useState<number | ''>('');
  const dq = useDebouncedValue(search, 300);

  const qs = new URLSearchParams();
  if (dq.trim())        qs.set('q', dq.trim());
  if (statusFilter)     qs.set('status', statusFilter);
  if (categoryFilter)   qs.set('category_id', String(categoryFilter));
  qs.set('limit', '50');

  const listFetch = useFetch<ListResp>(`/admin/notices?${qs.toString()}`, { enabled: canManage });
  const catsFetch = useFetchOnce<CatResp>('/admin/notice-categories');

  const confirm = useConfirm();

  // Modal-driven compose/edit (2026-05-22). State carries 'new' for a
  // fresh notice or a numeric notice_id for edit. Closing resets to
  // null. We keep the /notice-board/new and /[id] page routes as
  // direct-link fallbacks (they auto-open the same dialog), but
  // in-app navigation goes through this state path so the list page
  // doesn't unmount under the operator.
  const [composeMode, setComposeMode] = React.useState<'new' | number | null>(null);

  async function handlePublish(n: Notice) {
    const ok = await confirm({
      title: 'Publish This Notice?',
      description: `"${n.title}" will be visible to ${parseSurfaces(n.target_surfaces).map((s) => ({ crm: 'CRM staff', client: 'clients', technician: 'technicians' }[s])).join(', ')}.`,
      confirmLabel: 'Publish & Send',
      variant: 'default',
    });
    if (!ok) return;
    const id = showToast({ variant: 'loading', message: 'Publishing notice…' });
    try {
      await api.post(`/admin/notices/${n.notice_id}/publish`, {});
      dismissToast(id);
      showToast({ variant: 'success', message: 'Notice published' });
      invalidateFetch((k) => k.startsWith('/admin/notices'));
    } catch (e) {
      dismissToast(id);
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Publish failed' });
    }
  }

  async function handleArchive(n: Notice) {
    const ok = await confirm({
      title: 'Archive This Notice?',
      description: `"${n.title}" will be hidden from all surfaces. Read history is preserved.`,
      confirmLabel: 'Archive',
      variant: 'destructive',
    });
    if (!ok) return;
    const id = showToast({ variant: 'loading', message: 'Archiving…' });
    try {
      await api.post(`/admin/notices/${n.notice_id}/archive`, {});
      dismissToast(id);
      showToast({ variant: 'success', message: 'Notice archived' });
      invalidateFetch((k) => k.startsWith('/admin/notices'));
    } catch (e) {
      dismissToast(id);
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Archive failed' });
    }
  }

  /*
   * Permanent delete — for a notice that should never have existed (typo,
   * duplicate, test broadcast). Archive remains the right action for one that
   * legitimately ran. The copy spells out that this is unrecoverable AND that
   * read history goes with it, because those are the two things that make it
   * different from archiving.
   */
  async function handleDelete(n: Notice) {
    const ok = await confirm({
      title: 'Delete This Notice?',
      description: `"${n.title}" will be permanently removed, along with its read history. This cannot be undone — use Archive instead if you only want to hide it.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    const id = showToast({ variant: 'loading', message: 'Deleting…' });
    try {
      await api.delete(`/admin/notices/${n.notice_id}`);
      dismissToast(id);
      showToast({ variant: 'success', message: 'Notice deleted' });
      invalidateFetch((k) => k.startsWith('/admin/notices'));
    } catch (e) {
      dismissToast(id);
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Delete failed' });
    }
  }

  if (meLoading || !canManage) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  const items = listFetch.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Megaphone className="size-6" /> Notice Board
          </h1>
          <p className="text-sm text-muted-foreground">
            Broadcast messages to CRM staff, clients, and technicians. Pinned + newest first.
          </p>
        </div>
        {/* New Notice button is gated by isNoticeManage. Without the
            permission, hide the button entirely (rather than show it
            and toast-reject on click) — operators who only consume
            notices shouldn't see the author affordance. */}
        {canManage && (
          <Button onClick={() => setComposeMode('new')}>
            <Plus className="size-4 mr-1" /> New Notice
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title or body…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {/* Both filters use the shared SearchSelect so they type-to-filter
              like every other pick-list in the CRM. Categories in particular
              grow over time, and a bare <select> stops being usable. */}
          <SearchSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as NoticeStatus | '')}
            options={[
              { value: '', label: 'All Statuses' },
              { value: 'draft', label: 'Draft' },
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'published', label: 'Published' },
              { value: 'archived', label: 'Archived' },
            ]}
            placeholder="All Statuses"
            className="w-44"
          />
          <SearchSelect
            value={categoryFilter}
            onChange={(v) => setCategoryFilter(v ? Number(v) : '')}
            options={[
              { value: '', label: 'All Categories' },
              ...(catsFetch.data?.items ?? []).map((c) => ({
                value: c.category_id,
                label: c.name,
              })),
            ]}
            placeholder="All Categories"
            className="w-48"
          />
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Title</th>
                <th className="!text-left">Category</th>
                <th className="!text-left">Audience</th>
                <th className="!text-center">Status</th>
                <th className="!text-left">Published</th>
                <th className="!text-right">Reach</th>
                <th className="!text-right">Read %</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 8 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!listFetch.loading && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted-foreground py-8">
                    No notices match the current filters.{' '}
                    <button
                      type="button"
                      onClick={() => setComposeMode('new')}
                      className="text-sky-700 hover:underline"
                    >
                      Create your first notice →
                    </button>
                  </td>
                </tr>
              )}
              {!listFetch.loading && items.map((n) => {
                const lockedForEdit = n.status === 'published' || n.status === 'archived';
                return (
                  <tr key={n.notice_id}>
                    <td className="font-medium max-w-[280px]">
                      <div className="flex items-center gap-1.5">
                        {n.is_pinned ? <span title="Pinned" className="text-amber-500">📌</span> : null}
                        <span className="truncate">{n.title}</span>
                      </div>
                    </td>
                    <td><NoticeCategoryTag name={n.category_name} color={n.category_color} /></td>
                    <td>{surfaceBadges(n.target_surfaces)}</td>
                    <td className="!text-center">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${STATUS_PILL[n.effective_status] || STATUS_PILL.draft}`}>
                        {n.effective_status[0].toUpperCase() + n.effective_status.slice(1)}
                      </span>
                    </td>
                    <td>{formatPublishedAt(n.publish_at)}</td>
                    <td className="!text-right tabular-nums">{(n.reach_estimate ?? 0).toLocaleString('en-IN')}</td>
                    <td className="!text-right tabular-nums">{n.read_pct ?? 0}%</td>
                    <td className="!text-right">
                      <div className="inline-flex items-center gap-1">
                        {/* Only rendered when the notice is actually editable.
                            A published/archived notice can never be edited, so
                            a permanently-disabled pencil just invited clicks
                            that did nothing — same conditional-render rule the
                            Publish and Archive actions below already follow. */}
                        {/* Shared IconButton — the CRM's row-action primitive
                            (naked icon, snug padding). The ghost <Button> used
                            here before rendered a much larger padded box than
                            every other table's actions. */}
                        {!lockedForEdit && (
                          <IconButton
                            icon={Edit2}
                            intent="default"
                            label="Edit"
                            onClick={() => setComposeMode(n.notice_id)}
                          />
                        )}
                        {n.status === 'draft' && (
                          <IconButton
                            icon={Send}
                            intent="primary"
                            label="Publish"
                            onClick={() => handlePublish(n)}
                          />
                        )}
                        {n.status !== 'archived' && (
                          <IconButton
                            icon={ArchiveIcon}
                            intent="default"
                            label="Archive"
                            onClick={() => handleArchive(n)}
                          />
                        )}
                        {/* Delete is available on EVERY status, unlike Archive.
                            Archive retires a notice that legitimately ran;
                            Delete removes one that should never have existed —
                            and a typo is just as likely to have been published
                            or archived as left in draft. */}
                        <IconButton
                          icon={Trash2}
                          intent="danger"
                          label="Delete permanently"
                          onClick={() => handleDelete(n)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Compose modal — single instance, mode + id driven by state.
          Rendering it unconditionally (with open derived from
          composeMode !== null) lets the modal animate in/out cleanly
          and means the form-reset effect fires on the open transition. */}
      <ComposeWizard
        open={composeMode !== null}
        onClose={() => setComposeMode(null)}
        mode={composeMode === 'new' ? 'create' : 'edit'}
        noticeId={typeof composeMode === 'number' ? composeMode : undefined}
      />
    </div>
  );
}
