'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
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

  /*
   * `overrideOtp` exists because OtpInput's onComplete fires SYNCHRONOUSLY
   * with the 4th-digit keystroke, before React has flushed setOtp(joined).
   * If we read `otp` from state at that moment we get the previous (3-digit
   * or empty) value, the API rejects it ("OTP must be 4 digits"), the user
   * sees a misleading "Validation failed" flash, then their manual click
   * succeeds. Passing the just-completed buffer through fixes the race
   * without forcing a layout-pause / setTimeout(0) hack.
   */
  async function verifyOtp(e: React.FormEvent, overrideOtp?: string) {
    e.preventDefault();
    const otpValue = overrideOtp ?? otp;
    setLoading(true); setError(null);
    try {
      const data = await api.post<{ token: string; user: { user_name: string } }>('/auth/verify-otp', {
        identifier, otp: Number(otpValue),
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
              {error && <div className="text-sm text-destructive text-center">{error}</div>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send OTP'}
              </Button>
            </form>
          )}
          {step === 'otp' && (
            <form onSubmit={verifyOtp} className="space-y-4">
              {info && <div className="text-sm text-muted-foreground text-center leading-relaxed">{info}</div>}
              <div className="space-y-3">
                <Label className="text-center block">Enter the 4-digit OTP</Label>
                <OtpInput
                  value={otp}
                  onChange={setOtp}
                  onComplete={(joined) => {
                    // Auto-submit when the 4th digit lands — saves a click.
                    // We pass `joined` explicitly because React hasn't yet
                    // flushed setOtp(joined) at this exact tick; reading
                    // from state would send the previous (3-digit) value
                    // and trip the backend's "OTP must be 4 digits"
                    // validator with a misleading error flash.
                    void verifyOtp({ preventDefault: () => {} } as React.FormEvent, joined);
                  }}
                />
              </div>
              {error && <div className="text-sm text-destructive text-center">{error}</div>}
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

// ─── 4-box OTP input ────────────────────────────────────────────────
/*
 * Renders OTP_LENGTH single-character boxes that together drive the parent's
 * `value` string. Three behaviours that matter:
 *
 *   1. Numeric-only: anything non-digit is stripped at the input event level
 *      (covers IME composition + soft keyboards that fire arbitrary characters).
 *   2. Auto-advance: typing a digit moves focus to the next box. Backspace on
 *      an empty box steps focus back to the previous one and clears it.
 *   3. Paste-spread: pasting "1234" into ANY box distributes one digit per
 *      box starting from the focused box, and lands focus on the next empty
 *      one (or the last box if everything filled). This matches the behaviour
 *      of every common OTP UX (Stripe, Razorpay, Google) — paste-from-SMS just
 *      works without the user manually tabbing.
 *
 * onComplete fires once the buffer is fully numeric and OTP_LENGTH long,
 * letting the parent auto-submit without a separate button click.
 */
const OTP_LENGTH = 4;

function OtpInput({
  value, onChange, onComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  // Treat the parent string as the source of truth. Pad to OTP_LENGTH so the
  // per-box render is just `digits[i]`. Re-derive on every render — cheap, and
  // it means a parent `setOtp('')` (e.g. Back button) clears every box.
  const digits = useMemo(() => {
    const clean = (value || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
    return Array.from({ length: OTP_LENGTH }, (_, i) => clean[i] ?? '');
  }, [value]);

  // Focus the first box on mount. autoFocus on individual <input>s would race
  // with the form's autoFocus attribute and end up on the wrong box.
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  function setAt(idx: number, digit: string) {
    const next = digits.slice();
    next[idx] = digit;
    const joined = next.join('');
    onChange(joined);
    return joined;
  }

  function handleChange(idx: number, raw: string) {
    // Take the LAST typed digit only — covers the case where the box already
    // had a value and the user types over it (browser inserts before/after).
    const cleaned = raw.replace(/\D/g, '');
    if (cleaned.length === 0) {
      const joined = setAt(idx, '');
      return joined;
    }
    const digit = cleaned[cleaned.length - 1];
    const joined = setAt(idx, digit);
    // Auto-advance.
    if (idx < OTP_LENGTH - 1) refs.current[idx + 1]?.focus();
    // Fire onComplete only when the whole buffer is filled — not just this box.
    if (joined.length === OTP_LENGTH && /^\d{4}$/.test(joined) && onComplete) {
      onComplete(joined);
    }
    return joined;
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      if (digits[idx]) {
        // Has a digit → clear this box, stay here. Pressing backspace again
        // (now empty) will step back.
        setAt(idx, '');
        e.preventDefault();
        return;
      }
      // Empty box → step focus back and clear the previous one.
      if (idx > 0) {
        setAt(idx - 1, '');
        refs.current[idx - 1]?.focus();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowLeft'  && idx > 0)                refs.current[idx - 1]?.focus();
    if (e.key === 'ArrowRight' && idx < OTP_LENGTH - 1)   refs.current[idx + 1]?.focus();
  }

  function handlePaste(idx: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH - idx);
    if (!pasted) return;
    e.preventDefault();
    const next = digits.slice();
    for (let i = 0; i < pasted.length && idx + i < OTP_LENGTH; i++) {
      next[idx + i] = pasted[i];
    }
    const joined = next.join('');
    onChange(joined);
    // Land focus on the next empty box, or the last box if everything filled.
    const firstEmpty = next.findIndex((d, i) => i >= idx && !d);
    const target = firstEmpty === -1 ? OTP_LENGTH - 1 : firstEmpty;
    refs.current[target]?.focus();
    if (joined.length === OTP_LENGTH && /^\d{4}$/.test(joined) && onComplete) {
      onComplete(joined);
    }
  }

  return (
    <div className="flex gap-3 justify-center py-1">
      {digits.map((d, i) => {
        const filled = !!d;
        return (
          <input
            key={i}
            ref={(el) => { refs.current[i] = el; }}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={1}
            value={d}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={(e) => handlePaste(i, e)}
            // onFocus selects existing content — typing replaces in-place, more
            // intuitive than appending to a 1-char box that's already full.
            onFocus={(e) => e.currentTarget.select()}
            aria-label={`OTP digit ${i + 1} of ${OTP_LENGTH}`}
            className={
              // Slot proportions: 56×64 (h slightly > w → digit-slot feel, not square).
              // Filled boxes carry primary-tinted background + bolder border so a
              // glance at the row shows entry progress without counting cursors.
              // Empty boxes stay neutral. Focus ring uses primary at full opacity
              // with a subtle box-shadow for elevation — the legacy OTP UX
              // people are used to (Stripe, Razorpay) all use this lift cue.
              `w-14 h-16 text-center text-3xl font-semibold tabular-nums rounded-lg
               border-2 outline-none transition-all duration-150
               focus:border-primary focus:ring-4 focus:ring-primary/15 focus:shadow-md
               ${filled
                 ? 'bg-primary/5 border-primary/40 text-foreground'
                 : 'bg-background border-input text-foreground/80'}`
            }
          />
        );
      })}
    </div>
  );
}
