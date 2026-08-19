'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { StatusChip } from '@/components/ui/StatusChip';
import { OptionChipList } from '@/components/ui/OptionChipList';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatEasyfixerName } from '@/lib/utils';

/*
 * DeepSkillMappedEasyfixersModal — read-only paginated list of every
 * easyfixer mapped to ANY option under a given deep skill.
 *
 * BE contract:
 *   GET /admin/deep-skills/:id/mapped-easyfixers?limit=&offset=
 *     → { items: MappedEasyfixer[]; total; limit; offset }
 *
 * A single easyfixer can map to multiple options under the same deep
 * skill; the BE collapses those into one row per tech with the option
 * labels concatenated into `mapped_options` (and `option_count` for
 * the "+N more" overflow hint).
 */
type MappedEasyfixer = {
  efr_id: number;
  efr_name: string | null;
  efr_no: string | null;
  efr_email: string | null;
  city_name: string | null;
  option_count: number;
  mapped_options: string | null;
  efr_status: number | string | null;
  is_technician_verified: number | string | null;
  last_mapped_at: string | null;
};

type Resp = {
  items: MappedEasyfixer[];
  total: number;
  limit: number;
  offset: number;
};

/*
 * Mapping-status chip — the BE only returns rows where is_repairing = 1,
 * so the mapping itself is always Active. The status we expose here
 * reflects the easyfixer's overall verification + active state so ops
 * can spot a tech who's "mapped but currently inactive".
 */
function easyfixerStatusChip(row: MappedEasyfixer): React.ReactNode {
  const verified = Number(row.is_technician_verified || 0);
  const active = Number(row.efr_status || 0);
  if (verified && active) return <StatusChip tone="emerald">Active</StatusChip>;
  if (verified && !active) return <StatusChip tone="slate">Inactive</StatusChip>;
  return <StatusChip tone="amber">Unverified</StatusChip>;
}

/*
 * Option-list rendering was previously a `MappedOptionsCell` local
 * helper. Promoted to a shared `OptionChipList` component
 * (src/components/ui/OptionChipList.tsx) so the easyfixers list
 * page's Service Category / Service Type cells + future similar
 * cells can reuse the same chip overflow pattern instead of
 * re-implementing it. See OptionChipList.tsx for the full API.
 *
 * The BE returns the mapped options as a comma-separated GROUP_CONCAT
 * string (`mapped_options`); we split → trim → filter once below
 * before handing to OptionChipList.
 */

export function DeepSkillMappedEasyfixersModal({
  open,
  onClose,
  deepSkillId,
  deepSkillName,
}: {
  open: boolean;
  onClose: () => void;
  deepSkillId: number | null;
  deepSkillName: string | null;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

  // Read-only modal — no form input; guard short-circuits straight to
  // onClose. Keeps the project's no-restricted-syntax ESLint rule happy.
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  // BE Joi cap is 500 (see routes/admin/deep-skills.js mappedEasyfixersQuery).
  const limit = pageSizeToLimit(pageSize, 500);

  const listKey = useMemo(() => {
    if (!open || !deepSkillId) return null;
    const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    return `/admin/deep-skills/${deepSkillId}/mapped-easyfixers?${p.toString()}`;
  }, [open, deepSkillId, page, pageSize, limit]);

  const { data, loading, error } = useFetch<Resp>(listKey);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Defensive: if the parent ever opens us with a null id, render nothing.
  // The actionable path is to close the modal; the guard above hands that
  // back to the parent without re-firing dirty-state checks.
  if (deepSkillId == null) return null;

  const headerTitle = deepSkillName
    ? `Mapped Easyfixers — ${deepSkillName}`
    : 'Mapped Easyfixers';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-5xl w-[min(96vw,1100px)] h-[80vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{headerTitle}</DialogTitle>
          <div className="text-[12px] text-ink-300/85 mt-0.5">
            {loading
              ? 'Loading…'
              : `${total} Easyfixer${total === 1 ? '' : 's'} Mapped`}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-4 py-3">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="whitespace-nowrap">Id</th>
                <th className="whitespace-nowrap">Name</th>
                <th className="whitespace-nowrap">Mobile</th>
                <th className="whitespace-nowrap">City</th>
                <th className="whitespace-nowrap">Mapped Options</th>
                <th className="whitespace-nowrap text-center">Mapping Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-urgent-strong">
                    {error}
                  </td>
                </tr>
              )}
              {!loading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No Easyfixers Mapped To This Deep Skill Yet.
                  </td>
                </tr>
              )}
              {!loading && !error && items.map((row) => (
                <tr key={row.efr_id}>
                  <td className="text-xs text-muted-foreground tabular-nums">{row.efr_id}</td>
                  <td className="font-medium">{formatEasyfixerName(row.efr_name)}</td>
                  <td className="text-xs whitespace-nowrap">{row.efr_no ?? '—'}</td>
                  <td className="text-xs">{row.city_name ?? '—'}</td>
                  <td>
                    <OptionChipList
                      items={row.mapped_options ? row.mapped_options.split(',').map((s) => s.trim()).filter(Boolean) : []}
                      count={Number(row.option_count || 0)}
                      tone="teal"
                    />
                  </td>
                  <td className="text-center">{easyfixerStatusChip(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-2 border-t bg-background">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default DeepSkillMappedEasyfixersModal;
