'use client';
import { useEffect, useState } from 'react';
import { Briefcase, Clock, CheckCircle2, XCircle, UserCircle2, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { statusColorClass, statusLabel } from '@/lib/utils';

type JobRow = {
  job_id: number; job_status: number; job_type: string; customer_name: string;
  client_name: string; city_name: string; easyfixer_name: string | null;
  created_date_time: string; requested_date_time: string;
};

type ListResp = { items: JobRow[]; total: number };

function StatCard({ icon: Icon, label, value, tint, loading }: {
  icon: React.ComponentType<{ className?: string }>; label: string;
  value: number | string; tint: string; loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={`h-12 w-12 rounded-lg grid place-items-center ${tint}`}>
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          {loading ? (
            <div className="h-7 w-16 rounded bg-muted animate-pulse mb-1" aria-label={`${label} loading`} />
          ) : (
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          )}
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState({ booked: 0, scheduled: 0, inProgress: 0, completed: 0, cancelled: 0, total: 0 });
  const [recent, setRecent] = useState<JobRow[]>([]);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);

  useEffect(() => {
    // One request for all status bucket counts (server computes via GROUP BY),
    // plus one for recent jobs — fires in parallel. Previously this page made
    // SEVEN requests on mount (six individual count calls plus recent), which
    // each used two DB connections server-side. The pool saturation warning
    // observed in prod logs was directly caused by that burst.
    (async () => {
      try {
        const r = await api.get<{ total: number; byStatus: Record<string, number> }>('/admin/jobs/counts');
        const b = r.byStatus || {};
        setStats({
          booked:     b['0'] ?? 0,
          scheduled:  b['1'] ?? 0,
          inProgress: b['2'] ?? 0,
          // completed_alt (5) is counted with completed (3) on the dashboard
          // since they're both terminal "done" states.
          completed:  (b['3'] ?? 0) + (b['5'] ?? 0),
          cancelled:  b['6'] ?? 0,
          total:      r.total,
        });
      } finally { setLoadingStats(false); }
    })();
    (async () => {
      try {
        const r = await api.get<ListResp>('/admin/jobs', { limit: 8 });
        setRecent(r.items);
      } finally { setLoadingRecent(false); }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Operations snapshot across all jobs</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard icon={Briefcase}   label="Total Jobs"  value={stats.total.toLocaleString()}     tint="bg-slate-100 text-slate-700"   loading={loadingStats} />
        <StatCard icon={AlertCircle} label="Booked"      value={stats.booked.toLocaleString()}    tint="bg-gray-100 text-gray-700"     loading={loadingStats} />
        <StatCard icon={Clock}       label="Scheduled"   value={stats.scheduled.toLocaleString()} tint="bg-blue-100 text-blue-700"     loading={loadingStats} />
        <StatCard icon={UserCircle2} label="In Progress" value={stats.inProgress.toLocaleString()} tint="bg-amber-100 text-amber-700"  loading={loadingStats} />
        <StatCard icon={CheckCircle2} label="Completed"  value={stats.completed.toLocaleString()} tint="bg-emerald-100 text-emerald-700" loading={loadingStats} />
        <StatCard icon={XCircle}     label="Cancelled"   value={stats.cancelled.toLocaleString()} tint="bg-red-100 text-red-700"       loading={loadingStats} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between p-5 pb-3">
            <div>
              <h2 className="text-base font-semibold">Recent Jobs</h2>
              <p className="text-xs text-muted-foreground">Latest 8 jobs across the platform</p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Job #</th><th>Client</th><th>Customer</th><th>City</th>
                <th>Tech</th><th>Status</th><th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loadingRecent && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 7 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loadingRecent && recent.length === 0 && (
                <tr><td colSpan={7} className="text-center text-muted-foreground py-8">No jobs yet</td></tr>
              )}
              {!loadingRecent && recent.map((j) => (
                <tr key={j.job_id}>
                  <td className="font-medium">#{j.job_id}</td>
                  <td>{j.client_name ?? '—'}</td>
                  <td>{j.customer_name ?? '—'}</td>
                  <td>{j.city_name ?? '—'}</td>
                  <td>{j.easyfixer_name ?? <span className="text-muted-foreground">unassigned</span>}</td>
                  <td>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(j.job_status)}`}>
                      {statusLabel(j.job_status)}
                    </span>
                  </td>
                  <td className="text-muted-foreground text-xs">{new Date(j.created_date_time).toLocaleDateString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
