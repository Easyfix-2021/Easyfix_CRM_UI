import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';

/*
 * Layout for the (public) route group.
 *
 * Pages under `app/(public)/*` are intentionally OUTSIDE the `(authed)` group
 * so they don't inherit the sidebar / navbar / auth-gate of the staff CRM.
 * Customer-facing surfaces today: the Magic-Link Job Completion form at
 * `/job-completion/[token]` and the Easyfixer Profile Update form at
 * `/profile-update/[token]`.
 *
 * `<ConfirmDialogProvider>` wraps children (2026-06-11) so the public form's
 * `useFormDirtyGuard` calls work the same way they do under `(authed)`.
 * Without the provider, `useConfirm()` throws "must be used inside
 * <ConfirmDialogProvider>" the first time any Dialog's close path runs
 * through `useFormDirtyGuard` — which is the project-canonical close handler
 * (the `no-restricted-syntax` ESLint rule forbids inline `onOpenChange`).
 *
 * Visual: a soft ink-tinted background with a centred column. Adaptive width —
 * narrow-ish on mobile (single-task focus) but opens up to a wide container
 * on desktop (md+) so the form can lay its shorter sections out side-by-side
 * via responsive grids inside each Section rather than running one tall
 * single column down a phone-width gutter on a 1440px screen.
 *
 * The per-section multi-column layout lives in the page itself; here we only
 * own the outer container width + gutters. The cap is `max-w-7xl` so a wide
 * desktop fills the page (no big empty side gutters) while the per-Section
 * grids — never the bare inputs — soak up the extra width. Responsive
 * padding (`px-4 → md:px-8 → lg:px-12`) keeps mobile comfortable and stops
 * content kissing the screen edge on large displays.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConfirmDialogProvider>
      <div className="min-h-screen bg-ink-50 text-ink-900 px-4 py-6 md:px-8 md:py-8 lg:px-12">
        <div className="mx-auto max-w-7xl">{children}</div>
      </div>
    </ConfirmDialogProvider>
  );
}
