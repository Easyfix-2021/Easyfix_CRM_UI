'use client';

/*
 * Job Tracking — single-job scheduling history.
 *
 * Operates on /api/admin/reports/job-tracking?jobId=… (Phase 11 — backend
 * DONE). Returns the scheduling_history rows for a job, joined with
 * tbl_easyfixer for the technician name, ordered chronologically.
 *
 * Mirrors the legacy CRM job-tracking screen: enter a job id, see every
 * assignment + reschedule with reason. Used by ops + PM to reconstruct
 * the timeline when investigating disputes or cancellations.
 */

import { useState } from 'react';
import { MapPin, Search, AlertTriangle, Clock, User2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

type HistoryRow = {
  id: number;
  easyfixer_id: number | null;
  efr_name: string | null;
  schedule_time: string | null;
  reason_id: number | null;
  reschedule_reason: string | null;
};

export default function JobTrackingPage() {
  const [jobId, setJobId] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function search() {
    const id = jobId.trim();
    if (!/^\d+$/.test(id)) { setError('Job ID must be numeric'); return; }
    setLoading(true); setError(null);
    try {
      const data = await api.get<HistoryRow[]>(`/admin/reports/job-tracking?jobId=${id}`);
      setHistory(data);
      setSearched(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load tracking history');
      setHistory([]);
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MapPin className="size-6" /> Job Tracking
        </h1>
        <p className="text-sm text-muted-foreground">
          Reconstruct a job&apos;s scheduling timeline — every technician assignment + reschedule reason.
        </p>
      </div>

      <Card>
        <CardContent className="p-3 flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs font-medium block mb-1">Job ID</label>
            <Input
              value={jobId}
              onChange={(e) => setJobId(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 482431"
              className="font-mono"
              onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            />
          </div>
          <Button onClick={search} disabled={loading || !jobId.trim()}>
            <Search className="size-4 mr-1" /> {loading ? 'Searching…' : 'Track'}
          </Button>
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      {searched && !loading && history.length === 0 && !error && (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          No scheduling history for job <span className="font-mono">{jobId}</span>. Either the job has never been assigned, or the ID doesn&apos;t exist.
        </CardContent></Card>
      )}

      {history.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-center">#</th>
                  <th className="!text-left">Technician</th>
                  <th className="!text-left">Scheduled For</th>
                  <th className="!text-center">Reason ID</th>
                  <th className="!text-left">Reschedule Reason</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.id}>
                    <td className="!text-center font-mono text-xs text-muted-foreground">{i + 1}</td>
                    <td className="!text-left">
                      <span className="inline-flex items-center gap-1.5">
                        <User2 className="size-3.5 text-muted-foreground" />
                        {h.efr_name ?? <span className="text-muted-foreground">— unassigned —</span>}
                        {h.easyfixer_id != null && (
                          <span className="text-[10px] text-muted-foreground font-mono">#{h.easyfixer_id}</span>
                        )}
                      </span>
                    </td>
                    <td className="!text-left">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <Clock className="size-3.5 text-muted-foreground" />
                        {h.schedule_time ? formatDate(h.schedule_time) : <span className="text-muted-foreground">—</span>}
                      </span>
                    </td>
                    <td className="!text-center font-mono text-xs">
                      {h.reason_id ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-left text-xs">
                      {h.reschedule_reason
                        ? <span className="bg-amber-50 text-amber-900 rounded px-1.5 py-0.5">{h.reschedule_reason}</span>
                        : <span className="text-muted-foreground italic">initial assignment</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
