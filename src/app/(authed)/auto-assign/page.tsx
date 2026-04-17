'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatEasyfixerName } from '@/lib/utils';

type Candidate = {
  efr_id: number; efr_name: string; efr_no: string; distance_km: number;
  active_jobs: number; avg_rating: number; completion_ratio: number;
  score: number; breakdown: { distance: number; workload: number; rating: number; completion: number };
};
type CandidatesResp = {
  l1Count: number; rejectedCount: number;
  config: { weights: { distance: number; workload: number; rating: number; completion: number } };
  candidates: Candidate[];
};

export default function AutoAssignPage() {
  const [jobId, setJobId] = useState('');
  const [data, setData] = useState<CandidatesResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState<string | null>(null);

  async function preview() {
    setError(null); setData(null); setAssignResult(null);
    setLoading(true);
    try { setData(await api.get<CandidatesResp>(`/admin/auto-assign/${Number(jobId)}/candidates`, { limit: 10 })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'failed'); }
    finally { setLoading(false); }
  }
  async function commit() {
    setAssigning(true); setAssignResult(null);
    try {
      const r = await api.post<{ chosen: Candidate; job: { job_id: number; fk_easyfixter_id: number } }>(`/admin/auto-assign/${Number(jobId)}`);
      setAssignResult(`Assigned to ${formatEasyfixerName(r.chosen.efr_name)} (Easyfixer ID ${r.chosen.efr_id}) — match score ${r.chosen.score}`);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'assign failed'); }
    finally { setAssigning(false); }
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Auto-assignment</h1>
        <p className="text-sm text-muted-foreground">3-layer pipeline: SQL eligibility → availability → weighted scoring</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Preview candidates for a job</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => { e.preventDefault(); preview(); }} className="flex gap-3 items-end">
            <div className="flex-1">
              <Label>Job ID</Label>
              <Input type="number" value={jobId} onChange={(e) => setJobId(e.target.value)} required />
            </div>
            <Button type="submit" disabled={!jobId || loading}>{loading ? 'Loading…' : 'Preview'}</Button>
            {data && data.candidates.length > 0 && (
              <Button type="button" onClick={commit} disabled={assigning}>
                {assigning ? 'Assigning…' : 'Assign Top Candidate'}
              </Button>
            )}
          </form>
          {error && <div className="mt-3 text-sm text-destructive">{error}</div>}
          {assignResult && <div className="mt-3 text-sm text-emerald-700">{assignResult}</div>}
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>Candidates</CardTitle>
            <p className="text-xs text-muted-foreground">
              L1 eligible: {data.l1Count} · L2 rejected: {data.rejectedCount} · weights: dist {data.config.weights.distance} / load {data.config.weights.workload} / rating {data.config.weights.rating} / compl {data.config.weights.completion}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rank</th><th>Easyfixer ID</th><th>Name</th><th>Mobile</th>
                  <th>Distance</th><th>Active Jobs</th><th>Rating</th><th>Completion</th><th>Score</th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c, i) => (
                  <tr key={c.efr_id} className={i === 0 ? 'bg-emerald-50' : ''}>
                    <td className="font-semibold">{i + 1}</td>
                    <td>{c.efr_id}</td>
                    <td>{formatEasyfixerName(c.efr_name)}</td>
                    <td>{c.efr_no}</td>
                    <td>{c.distance_km.toFixed(1)} km</td>
                    <td>{c.active_jobs}</td>
                    <td>{c.avg_rating}</td>
                    <td>{(c.completion_ratio * 100).toFixed(0)}%</td>
                    <td className="font-semibold">{c.score}</td>
                  </tr>
                ))}
                {data.candidates.length === 0 && <tr><td colSpan={9} className="text-center text-muted-foreground py-6">No eligible candidate — all rejected at L2 filters</td></tr>}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
