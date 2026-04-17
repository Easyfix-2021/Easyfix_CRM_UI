'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { formatDate, statusColorClass, statusLabel } from '@/lib/utils';

type Job = Record<string, unknown> & { job_id: number; job_status: number; services?: unknown[]; images?: unknown[] };

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() { setJob(await api.get<Job>(`/admin/jobs/${id}`)); }
  useEffect(() => { refresh().catch(() => setErr('not found')); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function assign(efrId: number) {
    try { await api.patch(`/admin/jobs/${id}/assign`, { easyfixerId: efrId }); await refresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'assign failed'); }
  }
  async function setStatus(status: number, reasonId?: number, comment?: string) {
    try { await api.patch(`/admin/jobs/${id}/status`, { status, reasonId, comment }); await refresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'status failed'); }
  }

  if (err) return <div className="text-destructive">{err}</div>;
  if (!job) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Job #{job.job_id}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(job.job_status)}`}>
              {statusLabel(job.job_status)}
            </span>
            <span className="text-xs text-muted-foreground">{String(job.job_type ?? '')}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <AssignDialog onSubmit={assign} />
          <ChangeOwnerDialog jobId={Number(id)} onDone={refresh} />
          <Button variant="outline" onClick={() => setStatus(2)}>Start</Button>
          <Button variant="outline" onClick={() => setStatus(3)}>Complete</Button>
          <Button variant="destructive" onClick={() => setStatus(6, 1, 'Cancelled from CRM')}>Cancel</Button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <CardHeader><CardTitle>Customer</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <Row k="Name" v={job.customer_name} />
            <Row k="Mobile" v={job.customer_mob_no} />
            <Row k="Email" v={job.customer_email} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Address</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <Row k="Address" v={job.address} />
            <Row k="Building" v={job.building} />
            <Row k="City" v={job.city_name} />
            <Row k="PIN" v={job.pin_code} />
            <Row k="GPS" v={job.gps_location} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Client</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <Row k="Client" v={job.client_name} />
            <Row k="Ref ID" v={job.client_ref_id} />
            <Row k="SPOC" v={job.client_spoc_name} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Schedule</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <Row k="Requested" v={formatDate(job.requested_date_time as string)} />
            <Row k="Scheduled" v={formatDate(job.scheduled_date_time as string)} />
            <Row k="Check-in" v={formatDate(job.checkin_date_time as string)} />
            <Row k="Check-out" v={formatDate(job.checkout_date_time as string)} />
            <Row k="Technician" v={job.easyfixer_name} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Services ({Array.isArray(job.services) ? job.services.length : 0})</CardTitle></CardHeader>
        <CardContent>
          <table className="data-table">
            <thead><tr><th>#</th><th>Service type</th><th>Category</th><th>Qty</th><th>Status</th></tr></thead>
            <tbody>
              {(Array.isArray(job.services) ? job.services : []).map((s, i) => {
                const sr = s as Record<string, unknown>;
                return (
                  <tr key={i}>
                    <td className="text-xs text-muted-foreground">{String(sr.job_service_id ?? '')}</td>
                    <td>{String(sr.service_type_name ?? '—')}</td>
                    <td>{String(sr.service_catg_name ?? '—')}</td>
                    <td>{String(sr.quantity ?? '')}</td>
                    <td>{sr.job_service_status ? 'Active' : 'Inactive'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="flex justify-between gap-4 border-b last:border-0 py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium text-right">{v == null || v === '' ? '—' : String(v)}</span>
    </div>
  );
}

function AssignDialog({ onSubmit }: { onSubmit: (efrId: number) => void }) {
  const [open, setOpen] = useState(false);
  const [efrId, setEfrId] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>Assign</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Assign Technician</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Label>Easyfixer ID</Label>
          <Input type="number" value={efrId} onChange={(e) => setEfrId(e.target.value)} placeholder="Pick ID from the Easyfixers page" />
          <p className="text-xs text-muted-foreground">Tip: to auto-pick the best-matched technician by distance, workload, rating and completion, use the Auto-assignment page.</p>
          <Button onClick={() => { onSubmit(Number(efrId)); setOpen(false); }} disabled={!efrId}>Assign</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChangeOwnerDialog({ jobId, onDone }: { jobId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    try {
      await api.patch(`/admin/jobs/${jobId}/owner`, { newOwnerId: Number(newOwnerId), reason });
      setOpen(false); onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'failed'); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline">Change Owner</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Change Job Owner</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>New Owner (staff ID)</Label><Input type="number" value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)} placeholder="Pick ID from the Users page" /></div>
          <div><Label>Reason (at least 3 characters)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the owner changing?" /></div>
          {error && <div className="text-sm text-destructive">{error}</div>}
          <Button onClick={submit} disabled={!newOwnerId || reason.length < 3}>Update</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
