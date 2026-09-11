'use client';

/*
 * UnlockOtpDialog — Admin Actions → Unlock OTP / PIN.
 *
 * Every OTP and the job-closing PIN allow 5 attempts per 30 minutes, then lock
 * until the window ends. The lock lifts by itself; this lifts it NOW — for a
 * user locked out by someone else's wrong guesses, or a technician at a
 * finished job who cannot wait half an hour.
 *
 *   Person — an email or mobile: every login OTP lock for them (CRM, client,
 *            technician app, admin actions, change mobile/email) and, for a
 *            technician's mobile, the bank / profile-update OTP. One Unlock
 *            clears all of them.
 *   Job    — a job id: its closing-PIN lock.
 *
 * Backend: /admin/otp-locks (EasyFix_Backend routes/admin/otp-locks.js), gated
 * by the RBAC action isOtpUnlock — the same key gates the card that opens this.
 * Reads go through useFetch (key = null until "Look Up"); unlocks are api.post
 * in the click handler, then refetch(). Nothing here ever shows a code.
 */

import { useState } from 'react';
import { LockOpen, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api, ApiError } from '@/lib/api';

type LockState = { locked: boolean; attemptsRemaining: number | null; retryAfterMinutes: number | null };
type LoginLock = LockState & { otpDetailsId: number; otpType: string };
type PersonLocks = {
  identifier: string;
  capActive: boolean;
  login: LoginLock[];
  technician: { efrId: number; name: string; profileOtp: LockState } | null;
};
type JobLocks = { jobId: number; hasPin: boolean; pin: LockState };

const FLOW_LABEL: Record<string, string> = {
  crm_login: 'CRM Login',
  Client_login: 'Client Login',
  'Mobile App Otp': 'Technician App Login',
  admin_action_delete: 'Admin Delete OTP',
  admin_action_restore: 'Admin Restore OTP',
  'Change Number': 'Change Mobile',
  'Change Email': 'Change Email',
};

function statusText(s: LockState): string {
  if (s.locked) return `Locked · Lifts In ${s.retryAfterMinutes ?? '?'} Min`;
  if (s.attemptsRemaining != null && s.attemptsRemaining < 5) return `${s.attemptsRemaining} Attempts Left`;
  return 'Not Locked';
}
const touched = (s: LockState) => s.locked || (s.attemptsRemaining != null && s.attemptsRemaining < 5);

function StatusCell({ s }: { s: LockState }) {
  return (
    <span className={s.locked ? 'font-medium text-urgent-strong' : 'text-muted-foreground'}>{statusText(s)}</span>
  );
}

export function UnlockOtpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'person' | 'job'>('person');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const personKey = open && mode === 'person' && query ? `/admin/otp-locks?identifier=${encodeURIComponent(query)}` : null;
  const jobKey = open && mode === 'job' && query ? `/admin/otp-locks/job/${encodeURIComponent(query)}` : null;
  const person = useFetch<PersonLocks>(personKey);
  const job = useFetch<JobLocks>(jobKey);

  const switchMode = (m: 'person' | 'job') => { setMode(m); setInput(''); setQuery(null); };
  const close = () => { switchMode('person'); onClose(); };
  // Nothing here is ever unsaved — an unlock applies the moment it is clicked.
  const guardedOpenChange = useFormDirtyGuard(close, { isDirty: false });
  const lookUp = () => {
    const v = input.trim();
    if (!v) return;
    if (mode === 'job' && !/^\d+$/.test(v)) {
      showToast({ variant: 'error', message: 'Enter A Numeric Job ID' });
      return;
    }
    setQuery(v);
  };

  async function unlockPerson() {
    if (!person.data) return;
    setBusy(true);
    try {
      await api.post('/admin/otp-locks/unlock', { identifier: person.data.identifier });
      showToast({ variant: 'success', message: 'Unlocked — They Can Sign In Now' });
      person.refetch();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed To Unlock' });
    } finally { setBusy(false); }
  }

  async function unlockJob() {
    if (!job.data) return;
    setBusy(true);
    try {
      await api.post(`/admin/otp-locks/job/${job.data.jobId}/unlock`, {});
      showToast({ variant: 'success', message: 'Closing PIN Unlocked' });
      job.refetch();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed To Unlock' });
    } finally { setBusy(false); }
  }

  const p = person.data;
  const personTouched = !!p && (p.login.some(touched) || (!!p.technician && touched(p.technician.profileOtp)));

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockOpen className="h-4 w-4" /> Unlock OTP / PIN
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          After 5 wrong codes in 30 minutes an OTP or a job&apos;s closing PIN locks until the 30 minutes
          are up. Unlock lifts it now. No code is ever shown here.
        </p>

        <div className="flex gap-2" role="tablist" aria-label="Unlock For">
          <Button type="button" size="sm" variant={mode === 'person' ? 'default' : 'outline'} onClick={() => switchMode('person')}>
            Person (Email Or Mobile)
          </Button>
          <Button type="button" size="sm" variant={mode === 'job' ? 'default' : 'outline'} onClick={() => switchMode('job')}>
            Job Closing PIN
          </Button>
        </div>

        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); lookUp(); }}>
          <div className="flex-1 space-y-1">
            <Label htmlFor="unlock-otp-input">{mode === 'person' ? 'Email Or Mobile' : 'Job ID'}</Label>
            <Input
              id="unlock-otp-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={mode === 'person' ? 'name@easyfix.in or 9876543210' : 'e.g. 1234567'}
              inputMode={mode === 'job' ? 'numeric' : undefined}
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="outline" disabled={!input.trim()}>
            <Search className="h-4 w-4 mr-1" /> Look Up
          </Button>
        </form>

        {mode === 'person' && query && (
          <div className="space-y-3">
            {person.loading && <p className="text-sm text-muted-foreground">Looking Up…</p>}
            {person.error && <p className="text-sm text-urgent-strong">{person.error}</p>}
            {p && !p.capActive && (
              <p className="text-sm text-muted-foreground">The OTP limit is not active on this server yet, so nothing can be locked.</p>
            )}
            {p && p.capActive && p.login.length === 0 && !p.technician && (
              <p className="text-sm text-muted-foreground">No OTP records for {p.identifier}.</p>
            )}
            {p && (p.login.length > 0 || p.technician) && (
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr><th className="text-left p-2 font-medium">Flow</th><th className="text-left p-2 font-medium">Status</th></tr>
                </thead>
                <tbody>
                  {p.login.map((r) => (
                    <tr key={r.otpDetailsId} className="border-t">
                      <td className="p-2">{FLOW_LABEL[r.otpType] || r.otpType}</td>
                      <td className="p-2"><StatusCell s={r} /></td>
                    </tr>
                  ))}
                  {p.technician && (
                    <tr className="border-t">
                      <td className="p-2">Bank / Profile Update OTP · {p.technician.name}</td>
                      <td className="p-2"><StatusCell s={p.technician.profileOtp} /></td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            {p && (
              <div className="flex justify-end">
                <Button type="button" onClick={unlockPerson} disabled={busy || !personTouched}>
                  <LockOpen className="h-4 w-4 mr-1" /> {busy ? 'Unlocking…' : 'Unlock'}
                </Button>
              </div>
            )}
          </div>
        )}

        {mode === 'job' && query && (
          <div className="space-y-3">
            {job.loading && <p className="text-sm text-muted-foreground">Looking Up…</p>}
            {job.error && <p className="text-sm text-urgent-strong">{job.error}</p>}
            {job.data && (
              <>
                <div className="flex items-center justify-between rounded border p-3 text-sm">
                  <span>Job #{job.data.jobId} · Closing PIN</span>
                  {job.data.hasPin ? <StatusCell s={job.data.pin} /> : <span className="text-muted-foreground">This Job Has No Closing PIN</span>}
                </div>
                <div className="flex justify-end">
                  <Button type="button" onClick={unlockJob} disabled={busy || !touched(job.data.pin)}>
                    <LockOpen className="h-4 w-4 mr-1" /> {busy ? 'Unlocking…' : 'Unlock'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
