/*
 * Layout for the (public) route group.
 *
 * Pages under `app/(public)/*` are intentionally OUTSIDE the `(authed)` group
 * so they don't inherit the sidebar / navbar / auth-gate of the staff CRM.
 * The single customer-facing surface today is the Magic-Link Job Completion
 * form at `/job-completion/[token]`; future public surfaces (e.g. a public
 * status-check page) can drop in here without touching the authed layout.
 *
 * Visual: a soft slate background with a centred, narrow column. Matches
 * the /login page aesthetic conceptually (light bg, centred card) but with
 * a wider max-width because the form has more sections than a 4-digit OTP.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 px-4 py-6">
      <div className="mx-auto max-w-2xl">{children}</div>
    </div>
  );
}
