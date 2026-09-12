'use client';
/*
 * Transactions tab — readable cards (not a dense table) over the same data as
 * EasyfixerTransactionsModal (GET .../transactions). Cards colour by
 * credit (added) / debit (deducted) and expand to show the transaction id +
 * job/customer detail.
 *
 * NOTE: the wire type exposes only transaction_type (1=debit, 2=credit); there
 * is no source flag to split "job account" from "finance payout", so the
 * approved design's purple payout stream is folded into the debit stream until
 * the endpoint returns a source. The full dense table stays available via the
 * "Full table" action (parent opens EasyfixerTransactionsModal).
 */
import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { formatDate } from '@/lib/utils';
import { SectionCard, Tile, KV, inr } from './ui';
import type { EfTransaction } from './types';

type Resp = { items: EfTransaction[]; total: number; limit: number; offset: number };
type Filter = 'all' | 'credit' | 'debit';

export function TransactionsTab({
  efrId,
  onOpenFullTable,
}: {
  efrId: number;
  onOpenFullTable: () => void;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<number | null>(null);

  const limit = pageSize === 'all' ? 500 : Number(pageSize);
  const offset = pageSize === 'all' ? 0 : page * limit;
  const { data, loading } = useFetch<Resp>(`/admin/easyfixers/${efrId}/transactions?limit=${limit}&offset=${offset}`);

  const items = data?.items ?? [];
  const rows = items.filter((t) => filter === 'all' || (filter === 'credit' ? t.transaction_type === 2 : t.transaction_type === 1));

  const added = items.filter((t) => t.transaction_type === 2).reduce((a, t) => a + Number(t.amount ?? 0), 0);
  const deducted = items.filter((t) => t.transaction_type === 1).reduce((a, t) => a + Number(t.amount ?? 0), 0);
  const latestBalance = items.length ? Number(items[0].balance ?? 0) : 0;

  return (
    <SectionCard
      title="Transactions"
      icon={<span>💳</span>}
      right={<Button size="sm" variant="outline" onClick={onOpenFullTable}>Full table</Button>}
    >
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile label="Added (this page)" value={`+ ${inr(added)}`} sub="credits" />
        <Tile label="Deducted (this page)" value={`− ${inr(deducted)}`} sub="debits" />
        <Tile label="Latest balance" value={inr(latestBalance)} sub="most recent row" />
      </div>

      <div className="mb-3 inline-flex rounded-lg border bg-muted p-1 text-xs font-semibold">
        {(['all', 'credit', 'debit'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1 ${filter === f ? 'bg-card text-foreground shadow' : 'text-muted-foreground'}`}
          >
            {f === 'all' ? 'All' : f === 'credit' ? 'Added' : 'Deducted'}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transactions.</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((t) => {
            const credit = t.transaction_type === 2;
            const open = openId === t.transaction_id;
            return (
              <div key={t.transaction_id} className={`overflow-hidden rounded-xl border border-l-4 bg-card ${credit ? 'border-l-success' : 'border-l-destructive'}`}>
                <button type="button" onClick={() => setOpenId(open ? null : t.transaction_id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg font-semibold ${credit ? 'bg-success-tint text-success-strong' : 'bg-urgent-tint text-urgent-strong'}`}>
                    {credit ? '↓' : '↑'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink-900">{t.description || (credit ? 'Credit' : 'Debit')}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.customer_name ? `${t.customer_name} · ` : ''}{formatDate(t.transaction_date)}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-right">
                    <span className={`font-mono text-sm font-semibold ${credit ? 'text-success' : 'text-destructive'}`}>
                      {credit ? '+' : '−'} {inr(Number(t.amount ?? 0))}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">Bal {inr(Number(t.balance ?? 0))}</span>
                  </span>
                </button>
                {open && (
                  <div className="border-t bg-muted/40 px-4 py-2">
                    <KV k="Transaction ID" v={t.transaction_id} mono />
                    <KV k="Type" v={credit ? 'Credit' : 'Debit'} />
                    <KV k="Customer" v={t.customer_name} />
                    <KV k="Address" v={t.customer_address} />
                    <KV k="Location" v={t.location} />
                    <KV k="Appointment" v={formatDate(t.appointment_date_time)} />
                    <KV k="Completed" v={formatDate(t.completion_date_time)} />
                    <KV k="Recorded by" v={t.transaction_by} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="mt-3 border-t pt-3">
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={(ps) => { setPageSize(ps); setPage(0); }}
          />
        </div>
      )}
    </SectionCard>
  );
}
