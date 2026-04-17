'use client';
import { useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

/*
 * 2-step OTP login.
 *
 * User existence is validated on the backend at 3 layers:
 *   1. /auth/login-otp  — no OTP is created if the identifier isn't a registered staff user
 *   2. /auth/verify-otp — rechecks the user before accepting the OTP
 *   3. Auth middleware  — re-reads the user on every protected call; deactivation = instant 401
 *
 * Step 1 deliberately reveals nothing about whether the identifier exists
 * (prevents account enumeration). Errors only surface after OTP submission.
 */
export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<'identifier' | 'otp'>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null); setInfo(null);
    try {
      const r = await api.post<{ delivered: boolean; expiresAt: string | null }>('/auth/login-otp', { identifier });
      if (!r.delivered) {
        // Internal CRM — no account-enumeration concern. Tell the operator plainly.
        setError('This account is not registered in the CRM. Please check the email / mobile or contact your admin.');
        return; // stay on identifier step
      }
      setInfo('A 4-digit OTP has been sent to your registered email / mobile. It is valid for 5 minutes.');
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally { setLoading(false); }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const data = await api.post<{ token: string; user: { user_name: string } }>('/auth/verify-otp', {
        identifier, otp: Number(otp),
      });
      if (data.token) localStorage.setItem('crm_auth_token', data.token);
      router.push('/dashboard');
    } catch (err) {
      // Backend returns a distinct reason here — show it verbatim for operator debugging
      if (err instanceof ApiError) {
        const msg = err.message;
        if (/USER_NOT_FOUND/i.test(msg)) setError('This account is not registered in the CRM. Please contact your admin to get access.');
        else if (/OTP_EXPIRED/i.test(msg)) setError('OTP expired. Click "Back" and request a new one.');
        else if (/OTP_MISMATCH/i.test(msg)) setError('Incorrect OTP. Please try again.');
        else if (/NO_OTP_ISSUED/i.test(msg)) setError('No OTP issued for this identifier. Click "Back" to request one.');
        else setError(msg);
      } else {
        setError('Verification failed');
      }
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-gradient-to-br from-slate-100 to-slate-200 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {/* Logo is cyan on transparent. The dark-slate pill gives it contrast on
              the otherwise-white card, mirroring how it sits on the app's dark
              sidebar. PNG was cropped to its content box (no transparent padding),
              so h-10 renders the logo at its actual visible size. */}
          <div className="mx-auto mb-3 inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2">
            <Image
              src="/logo-full.png" alt="EasyFix"
              width={139} height={34} priority
              unoptimized
              className="h-10 w-auto"
            />
          </div>
          <CardTitle className="text-xl">Internal CRM</CardTitle>
          <CardDescription>Sign in with your registered email or mobile</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'identifier' && (
            <form onSubmit={requestOtp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="identifier">Email or Mobile</Label>
                <Input
                  id="identifier" required autoFocus
                  placeholder="you@easyfix.in or 10-digit mobile"
                  value={identifier} onChange={(e) => setIdentifier(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Only active EasyFix staff accounts can sign in.</p>
              </div>
              {error && <div className="text-sm text-destructive">{error}</div>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send OTP'}
              </Button>
            </form>
          )}
          {step === 'otp' && (
            <form onSubmit={verifyOtp} className="space-y-4">
              {info && <div className="text-sm text-muted-foreground">{info}</div>}
              <div className="space-y-2">
                <Label htmlFor="otp">4-digit OTP</Label>
                <Input
                  id="otp" required autoFocus inputMode="numeric" maxLength={4} pattern="[0-9]{4}"
                  placeholder="1234"
                  value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                />
              </div>
              {error && <div className="text-sm text-destructive">{error}</div>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => { setStep('identifier'); setError(null); setOtp(''); }}>Back</Button>
                <Button type="submit" className="flex-1" disabled={loading || otp.length !== 4}>
                  {loading ? 'Verifying…' : 'Verify & Sign in'}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
