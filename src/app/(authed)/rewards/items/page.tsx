'use client';

/*
 * Reward Items — the rewards shop catalogue.
 *
 * Technicians earn points for good work and spend them here on real objects
 * that get packed and shipped. That makes this page master data with physical
 * consequences: every row is a promise that an item exists, costs what it says,
 * and can actually be sent.
 *
 * Two facts on a row are load-bearing rather than decorative:
 *
 *   POINTS are a separate currency from the rupee amounts everywhere else in
 *   the CRM (job charges, advances, rate cards). Rendering them as a bare
 *   right-aligned number would make "1,200" mean two different things on two
 *   adjacent screens, so points get a gold chip and an explicit "Pts" suffix.
 *   A misread here is an operator pricing a jacket at rupee intuition.
 *
 *   STOCK 0 is a hard block, not a hint. The claim transaction decrements
 *   conditionally (`WHERE stock > 0`) and a zero-stock claim is REFUSED by the
 *   backend — so a technician sees the item in the shop, spends the intent, and
 *   bounces. The row shouts "Out Of Stock" in red rather than showing a quiet
 *   0 that reads as just another small number.
 *
 * Retire is a SOFT delete: DELETE sets status 0, it never removes the row. A
 * claim raised last month still points at this item and must keep resolving to
 * the thing that was actually shipped, so the confirm copy says "Retire", and
 * a retired row offers Reactivate (PATCH { status: true }) instead.
 *
 * Backend: /admin/rewards/items (routes/admin/rewards.js). Writes are
 * roleByName(['Admin']) server-side; the UI gates them on isRewardsManage so a
 * read-only operator never sees a control that would 403.
 */

import * as React from 'react';
import { Gift, Plus, Search, Pencil, Trash2, RotateCcw, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  TablePagination, pageSizeToLimit, type TablePageSize,
} from '@/components/ui/table-pagination';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { api, ApiError } from '@/lib/api';
import { RewardsPausedNotice, RewardsEarnRates } from '@/components/rewards/RewardsPausedNotice';

/* ── Types ──────────────────────────────────────────────────────────────── */

type RewardItem = {
  id: number;
  name: string;
  description: string | null;
  image_key: string | null;
  points_cost: number;
  /* Raw CSV as stored ("S,M,L,XL"). The edit form round-trips THIS, not the
   * split array, so a save that touches nothing else writes back what was
   * already there. */
  sizes: string | null;
  /* Same value pre-split by the backend — used for the row chips. */
  sizeOptions: string[];
  stock: number;
  status: number;            // 1 = Active, 0 = Retired
  claim_count: number;
  created_at: string | null;
  updated_at: string | null;
};

type ItemListResp = { rows: RewardItem[]; total: number; limit: number; offset: number };

/* Mirrors the Joi bounds in routes/admin/rewards.js. Client-side checks here
 * only save a round trip — the backend stays the real authority. */
const NAME_MIN = 2;
const NAME_MAX = 150;
const DESC_MAX = 1000;
const SIZES_MAX = 200;
const POINTS_MIN = 1;
const POINTS_MAX = 1_000_000;
const STOCK_MIN = 0;
const STOCK_MAX = 100_000;

/*
 * 'All' is withheld. It renders one un-navigable page whose range hint claims
 * "Showing 1–N of N" regardless of what the server actually returned, and this
 * endpoint's Joi `limit` caps at 1000. A shop catalogue is dozens of rows, so
 * 50/page never stands between an operator and the item they want, and the
 * pagination footer can never lie about what is on screen.
 */
const ITEM_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

/*
 * Joi rejections arrive as ApiError with a generic top-level message
 * ("Validation failed") and the per-field reasons buried in `details`. Showing
 * only `.message` tells the operator something broke but not which field, so
 * flatten `details` onto the toast when it carries anything readable.
 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.details;
    if (Array.isArray(d) && d.length > 0) {
      const parts = d
        .map((x) => (typeof x === 'string' ? x : (x as { message?: string })?.message))
        .filter((x): x is string => Boolean(x));
      if (parts.length > 0) return `${e.message}: ${parts.join('; ')}`;
    }
    return e.message || fallback;
  }
  return e instanceof Error ? e.message : fallback;
}

/*
 * Split a size CSV the way the backend's parseSizes does — trim, drop blanks —
 * so the live preview under the input shows exactly the chips that will land on
 * the row after a save. "S, M,, L " and "S,M,L" are the same three sizes.
 */
function splitSizes(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function RewardItemsPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isRewardsManage']);
  const canManage = can.isRewardsManage;

  const [search, setSearch] = React.useState('');
  const dq = useDebouncedValue(search, 300);
  const [includeRetired, setIncludeRetired] = React.useState(false);

  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const limit = pageSizeToLimit(pageSize, 1000);

  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  if (includeRetired) qs.set('includeRetired', 'true');
  qs.set('limit', String(limit));
  qs.set('offset', String(page * limit));

  const listFetch = useFetch<ItemListResp>(`/admin/rewards/items?${qs.toString()}`);

  /*
   * Any filter change re-queries from row 0. Without this, narrowing the search
   * while sitting on page 3 asks for an offset the smaller result set doesn't
   * have, and the table goes empty with no visible cause.
   */
  React.useEffect(() => { setPage(0); }, [dq, includeRetired]);

  /* `'new'` opens a blank add form; a RewardItem opens it pre-filled. */
  const [formItem, setFormItem] = React.useState<RewardItem | 'new' | null>(null);

  /*
   * Every mutation path ends here. invalidateFetch only EVICTS the module
   * cache — it has no subscriber mechanism, so a mounted useFetch keeps showing
   * its last render until something re-requests. The explicit refetch() is that
   * something; dropping it is the bug this codebase has shipped repeatedly (the
   * stale row survives until a full page reload).
   */
  function refreshItems() {
    invalidateFetch((k) => k.startsWith('/admin/rewards/items'));
    listFetch.refetch();
  }

  async function handleRetire(it: RewardItem) {
    const ok = await confirm({
      title: 'Retire This Reward Item?',
      description: `"${it.name}" will disappear from the technicians' shop and can no longer be `
        + `claimed. This is a soft retire, not a delete — the ${it.claim_count} existing `
        + `claim${it.claim_count === 1 ? '' : 's'} against it stay intact and keep resolving to `
        + `this item, and you can reactivate it at any time.`,
      confirmLabel: 'Retire',
      variant: 'destructive',
    });
    if (!ok) return;
    const t = showToast({ variant: 'loading', message: 'Retiring reward item…' });
    try {
      await api.delete(`/admin/rewards/items/${it.id}`);
      dismissToast(t);
      showToast({ variant: 'success', message: 'Reward Item Retired' });
      refreshItems();
    } catch (e) {
      dismissToast(t);
      showToast({ variant: 'error', message: errText(e, 'Retire failed') });
    }
  }

  async function handleReactivate(it: RewardItem) {
    const t = showToast({ variant: 'loading', message: 'Reactivating reward item…' });
    try {
      // PATCH takes `status` as a BOOLEAN here (the list read model exposes it
      // as 1/0) — passing 1 would fail the endpoint's Joi boolean().
      await api.patch(`/admin/rewards/items/${it.id}`, { status: true });
      dismissToast(t);
      showToast({ variant: 'success', message: 'Reward Item Reactivated' });
      refreshItems();
    } catch (e) {
      dismissToast(t);
      showToast({ variant: 'error', message: errText(e, 'Reactivate failed') });
    }
  }

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <RewardsPausedNotice />
      <RewardsEarnRates />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Gift className="size-6" /> Reward Items
          </h1>
          <p className="text-sm text-muted-foreground">
            The rewards shop catalogue — what technicians can spend their earned points on.
          </p>
        </div>
        {/* Hidden rather than disabled for read-only operators: a permanently
            dead "Add" button just invites clicks that do nothing. */}
        {canManage && (
          <Button onClick={() => setFormItem('new')}>
            <Plus className="size-4 mr-1" /> Add Reward Item
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by item name or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
            <input
              type="checkbox"
              checked={includeRetired}
              onChange={(e) => setIncludeRetired(e.target.checked)}
            />
            Include Retired
          </label>
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <colgroup>
              <col style={{ width: '32%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '8%'  }} />
              <col style={{ width: '9%'  }} />
              <col style={{ width: '7%'  }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left">Name</th>
                <th className="!text-right">Points</th>
                <th className="!text-left">Sizes</th>
                <th className="!text-right">Stock</th>
                <th className="!text-right">Claims</th>
                <th className="!text-center">Status</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 7 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-20 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!listFetch.loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="!text-center text-muted-foreground py-8">
                    No reward items match the current filters.
                  </td>
                </tr>
              )}
              {!listFetch.loading && rows.map((it) => (
                <tr key={it.id}>
                  <td className="!text-left max-w-[360px]">
                    <div className="font-medium truncate" title={it.name}>{it.name}</div>
                    {it.description && (
                      <div className="text-xs text-muted-foreground truncate" title={it.description}>
                        {it.description}
                      </div>
                    )}
                  </td>
                  {/*
                    Gold chip + explicit "Pts". Points are a DIFFERENT currency
                    from the rupee figures on job charges / advances / rate
                    cards; a bare right-aligned number here would read as money
                    to anyone arriving from those screens.
                  */}
                  <td className="!text-right">
                    <StatusChip
                      tone="amber"
                      className="tabular-nums"
                      title={`${it.points_cost.toLocaleString('en-IN')} points`}
                    >
                      {it.points_cost.toLocaleString('en-IN')} Pts
                    </StatusChip>
                  </td>
                  <td className="!text-left">
                    {it.sizeOptions.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {it.sizeOptions.map((s) => (
                          <StatusChip key={s} tone="slate" size="sm">{s}</StatusChip>
                        ))}
                      </div>
                    )}
                  </td>
                  {/*
                    0 is a BLOCK, not a small number: the claim transaction
                    decrements under `WHERE stock > 0`, so the backend refuses
                    the claim outright. Say so on the row rather than leaving an
                    operator to infer it from a quiet zero.
                  */}
                  <td className="!text-right tabular-nums">
                    {it.stock === 0 ? (
                      <StatusChip tone="red" title="Technicians cannot claim this item until stock is added">
                        Out Of Stock
                      </StatusChip>
                    ) : it.stock.toLocaleString('en-IN')}
                  </td>
                  <td className="!text-right tabular-nums">{it.claim_count}</td>
                  <td className="!text-center">
                    <StatusChip tone={it.status === 1 ? 'emerald' : 'slate'}>
                      {it.status === 1 ? 'Active' : 'Retired'}
                    </StatusChip>
                  </td>
                  <td className="!text-right">
                    <div className="inline-flex items-center justify-end gap-1">
                      {canManage && (
                        <IconButton
                          icon={Pencil}
                          intent="primary"
                          label="Edit Reward Item"
                          onClick={() => setFormItem(it)}
                        />
                      )}
                      {/* Retire and Reactivate are mutually exclusive — the row
                          shows whichever transition is actually available
                          rather than a greyed-out pair. */}
                      {canManage && it.status === 1 && (
                        <IconButton
                          icon={Trash2}
                          intent="danger"
                          label="Retire Reward Item"
                          onClick={() => handleRetire(it)}
                        />
                      )}
                      {canManage && it.status !== 1 && (
                        <IconButton
                          icon={RotateCcw}
                          intent="success"
                          label="Reactivate Reward Item"
                          onClick={() => handleReactivate(it)}
                        />
                      )}
                      {!canManage && (
                        <span className="text-xs text-muted-foreground">View Only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-t px-3 py-2">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              pageSizeOptions={ITEM_PAGE_SIZES}
            />
          </div>
        </CardContent>
      </Card>

      {/* Rendered unconditionally with `open` derived from state so its
          open-transition seed effect actually fires. */}
      <ItemModal
        item={formItem}
        onClose={() => setFormItem(null)}
        onSaved={() => { setFormItem(null); refreshItems(); }}
      />
    </div>
  );
}

/* ── Add / Edit modal ───────────────────────────────────────────────────── */

/*
 * Numbers are held as STRINGS, not numbers.
 *
 * `points` and `stock` are typed into text inputs, and "" is a state a number
 * can't represent — coercing early turns a half-cleared field into 0, which for
 * stock is a silent "Out Of Stock" and for points an invalid 0-cost item. The
 * strings are parsed once, at submit, where the failure has somewhere to go.
 */
type FormState = {
  name: string;
  description: string;
  points: string;
  sizes: string;
  stock: string;
};

function seedForm(item: RewardItem | null): FormState {
  return {
    name: item?.name ?? '',
    description: item?.description ?? '',
    points: item ? String(item.points_cost) : '',
    // Round-trips the raw CSV rather than sizeOptions.join(',') so an untouched
    // field saves back exactly what was stored.
    sizes: item?.sizes ?? '',
    stock: item ? String(item.stock) : '0',
  };
}

function ItemModal({ item, onClose, onSaved }: {
  item: RewardItem | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = item !== null;
  const editing = item !== null && item !== 'new' ? item : null;

  const [form, setForm] = React.useState<FormState>(() => seedForm(null));
  /* The seeded snapshot, kept so "dirty" means "differs from what was loaded"
   * rather than "the operator touched a key". */
  const [initial, setInitial] = React.useState<FormState>(() => seedForm(null));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Seeds on OPEN only, keyed on the item id — a re-render must never reset
   * fields out from under whatever is being typed. */
  React.useEffect(() => {
    if (!open) return;
    const seeded = seedForm(editing);
    setForm(seeded);
    setInitial(seeded);
    setError(null);
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const isDirty = (Object.keys(form) as Array<keyof FormState>)
    .some((k) => form[k] !== initial[k]);

  // Skip the discard prompt while a save is in flight — the modal is closing on
  // its own at that point and the prompt would fire over a completed action.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty,
    when: () => !submitting,
  });

  const sizePreview = splitSizes(form.sizes);

  async function handleSubmit() {
    const name = form.name.trim();
    const description = form.description.trim();
    const sizes = form.sizes.trim();

    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      setError(`Item name must be between ${NAME_MIN} and ${NAME_MAX} characters.`);
      return;
    }
    if (description.length > DESC_MAX) {
      setError(`Description must be ${DESC_MAX} characters or fewer.`);
      return;
    }
    if (sizes.length > SIZES_MAX) {
      setError(`Sizes must be ${SIZES_MAX} characters or fewer.`);
      return;
    }
    // Number(' ') is 0 and Number('') is 0 — both would sail past a bare
    // Number.isFinite check, so the emptiness is rejected before parsing.
    const points = Number(form.points.trim());
    if (form.points.trim() === '' || !Number.isInteger(points)
      || points < POINTS_MIN || points > POINTS_MAX) {
      setError(`Points cost must be a whole number between ${POINTS_MIN} and ${POINTS_MAX.toLocaleString('en-IN')}.`);
      return;
    }
    const stock = Number(form.stock.trim());
    if (form.stock.trim() === '' || !Number.isInteger(stock)
      || stock < STOCK_MIN || stock > STOCK_MAX) {
      setError(`Stock must be a whole number between ${STOCK_MIN} and ${STOCK_MAX.toLocaleString('en-IN')}.`);
      return;
    }

    setError(null);
    setSubmitting(true);
    const t = showToast({
      variant: 'loading',
      message: editing ? 'Saving reward item…' : 'Creating reward item…',
    });
    try {
      const payload = { name, description, points_cost: points, sizes, stock };
      if (editing) {
        await api.patch(`/admin/rewards/items/${editing.id}`, payload);
      } else {
        await api.post<{ id: number }>('/admin/rewards/items', payload);
      }
      dismissToast(t);
      showToast({
        variant: 'success',
        message: editing ? 'Reward Item Saved' : 'Reward Item Created',
      });
      invalidateFetch((k) => k.startsWith('/admin/rewards/items'));
      onSaved();
    } catch (e) {
      dismissToast(t);
      const msg = errText(e, 'Save failed');
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {editing ? `Edit Reward Item — ${editing.name}` : 'Add Reward Item'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 max-h-[75vh] overflow-y-auto pr-1">
          <div>
            <Label className="block mb-1" required>Item Name</Label>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={NAME_MAX}
              placeholder='e.g. "EasyFix Branded Jacket"'
            />
          </div>

          <div>
            <Label className="block mb-1">Description</Label>
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              maxLength={DESC_MAX}
              rows={3}
              placeholder="What the technician receives — material, colour, anything worth knowing before spending points (optional)"
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40 disabled:opacity-60"
            />
            <div className="mt-1 text-xs text-muted-foreground text-right tabular-nums">
              {form.description.length} / {DESC_MAX}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="block mb-1" required>Points Cost</Label>
              <Input
                value={form.points}
                onChange={(e) => set('points', e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                className="tabular-nums"
                placeholder="e.g. 1200"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                What a technician spends to claim this. Points, not rupees.
              </p>
            </div>

            <div>
              <Label className="block mb-1" required>Stock</Label>
              <Input
                value={form.stock}
                onChange={(e) => set('stock', e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                className="tabular-nums"
                placeholder="e.g. 25"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Units on hand. At 0 the item stays visible but every claim is refused.
              </p>
            </div>
          </div>

          <div>
            <Label className="block mb-1">Sizes</Label>
            <Input
              value={form.sizes}
              onChange={(e) => set('sizes', e.target.value)}
              maxLength={SIZES_MAX}
              placeholder="e.g. S,M,L,XL"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Comma-separated — <code>S,M,L,XL</code> for apparel, <code>7,8,9,10</code> for
              footwear. Leave blank for an item that has no size (a bag, a water bottle); the
              technician is then never asked to pick one.
            </p>
            {/* Live echo of what will actually be stored — the backend trims and
                drops blanks, so "S, M,, L" and "S,M,L" are the same three
                sizes and the operator can see that before saving. */}
            {sizePreview.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground mr-1">Will be saved as:</span>
                {sizePreview.map((s) => (
                  <StatusChip key={s} tone="slate" size="sm">{s}</StatusChip>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-urgent flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          {/*
            Pinned to the bottom of THIS scroller, not DialogContent's. The
            actions live inside the same `max-h-[75vh] overflow-y-auto` band as
            the fields, so DialogFooter's sticky footer never applied to them —
            the buttons simply scrolled off with the content. No negative
            margins here, so a plain `bottom-0` pins flush (measured: `-bottom-6`
            would hang the row 24px BELOW the scrollport and clip it).
          */}
          <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t bg-background pt-3 pb-1">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save Changes' : 'Add Reward Item'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
