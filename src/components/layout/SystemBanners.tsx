'use client';

/**
 * Environment and maintenance banners.
 *
 * WHY THE ENVIRONMENT BANNER EXISTS
 *
 * QA and Production are visually identical. On 2026-08-18 a QA build was
 * promoted onto Production and deployed before anyone noticed, and the reason
 * it went unnoticed is that nothing on screen ever says which environment you
 * are looking at. A coloured strip naming the environment is the cheapest
 * possible guard against acting on the wrong one — it cannot prevent a bad
 * deploy, but it removes the "I thought this was QA" class of mistake for
 * everyone reading the CRM all day.
 *
 * Both banners are driven from easyfix_properties via GET /admin/branding, so
 * ops can raise a maintenance notice without a deploy, and the environment
 * label is set per host rather than compiled in.
 *
 * Deliberately NOT dismissible. A banner you can close is a banner that is
 * closed exactly when it matters.
 */

import { useFetchOnce } from '@/lib/hooks';

type BrandingSettings = {
  envBannerEnabled?: boolean;
  envBannerText?: string;
  maintenanceBannerEnabled?: boolean;
  maintenanceBannerText?: string;
};

type BrandingResponse = { settings?: BrandingSettings };

export function SystemBanners() {
  /*
   * Fetched once per session. A failure resolves to no banner rather than an
   * error state: a broken settings call must never block the CRM, and the
   * banner is advisory. `useFetchOnce` already dedupes across mounts.
   */
  const res = useFetchOnce<BrandingResponse>('/admin/branding');
  const s = res.data?.settings;

  const showEnv = !!s?.envBannerEnabled && !!s?.envBannerText?.trim();
  const showMaint = !!s?.maintenanceBannerEnabled && !!s?.maintenanceBannerText?.trim();

  if (!showEnv && !showMaint) return null;

  return (
    <div className="shrink-0">
      {showEnv && (
        <div
          role="status"
          className="bg-warning-tint text-warning-strong px-4 py-1 text-center text-xs font-medium"
        >
          {s?.envBannerText}
        </div>
      )}
      {showMaint && (
        <div
          role="status"
          className="bg-info-tint text-info-strong px-4 py-1 text-center text-xs font-medium"
        >
          {s?.maintenanceBannerText}
        </div>
      )}
    </div>
  );
}

export default SystemBanners;
