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

function StatCard({ icon: Icon, label, value, tint }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tint: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={`h-12 w-12 rounded-lg grid place-items-center ${tint}`}>
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState({ booked: 0, scheduled: 0, inProgress: 0, completed: 0, cancelled: 0, total: 0 });
  const [recent, setRecent] = useState<JobRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const counts = await Promise.all([
          api.get<ListResp>('/admin/jobs', { status: 0, limit: 1 }).then((r) => r.total).catch(() => 0),
          api.get<ListResp>('/admin/jobs', { status: 1, limit: 1 }).then((r) => r.total).catch(() => 0),
          api.get<ListResp>('/admin/jobs', { status: 2, limit: 1 }).then((r) => r.total).catch(() => 0),
          api.get<ListResp>('/admin/jobs', { status: 3, limit: 1 }).then((r) => r.total).catch(() => 0),
          api.get<ListResp>('/admin/jobs', { status: 6, limit: 1 }).then((r) => r.total).catch(() => 0),
          api.get<ListResp>('/admin/jobs', { limit: 1 }).then((r) => r.total).catch(() => 0),
        ]);
        setStats({
          booked: counts[0], scheduled: counts[1], inProgress: counts[2],
          completed: counts[3], cancelled: counts[4], total: counts[5],
        });
      } catch { /* ignore */ }
      try {
        const recent = await api.get<ListResp>('/admin/jobs', { limit: 8 });
        setRecent(recent.items);
      } catch { /* ignore */ }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Operations snapshot across all jobs</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard icon={Briefcase}   label="Total Jobs"  value={stats.total.toLocaleString()}     tint="bg-slate-100 text-slate-700" />
        <StatCard icon={AlertCircle} label="Booked"      value={stats.booked.toLocaleString()}    tint="bg-gray-100 text-gray-700" />
        <StatCard icon={Clock}       label="Scheduled"   value={stats.scheduled.toLocaleString()} tint="bg-blue-100 text-blue-700" />
        <StatCard icon={UserCircle2} label="In Progress" value={stats.inProgress.toLocaleString()} tint="bg-amber-100 text-amber-700" />
        <StatCard icon={CheckCircle2} label="Completed"  value={stats.completed.toLocaleString()} tint="bg-emerald-100 text-emerald-700" />
        <StatCard icon={XCircle}     label="Cancelled"   value={stats.cancelled.toLocaleString()} tint="bg-red-100 text-red-700" />
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
              {recent.length === 0 && (
                <tr><td colSpan={7} className="text-center text-muted-foreground py-8">No jobs yet</td></tr>
              )}
              {recent.map((j) => (
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
