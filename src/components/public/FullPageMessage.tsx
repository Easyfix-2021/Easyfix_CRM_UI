'use client';

import * as React from 'react';

/*
 * Full-page status card for the public pages — loading / invalid / expired /
 * error / submitted states. Optional helpline + retry. Shared by
 * job-completion and shared-job.
 */
export function FullPageMessage({
  title, message, helpline, retry,
}: { title: string; message: string; helpline?: boolean; retry?: boolean }) {
  return (
    <div className="bg-card rounded-lg border p-8 text-center space-y-4">
      <h1 className="text-xl font-semibold text-ink-900">{title}</h1>
      <p className="text-sm text-ink-700 leading-relaxed">{message}</p>
      {helpline && (
        <p className="text-sm text-ink-500">
          Need help? Call <a href="tel:+918068931789" className="text-primary hover:underline">+91-8068931789</a>.
        </p>
      )}
      {retry && (
        <button type="button" onClick={() => window.location.reload()}
          className="bg-primary hover:bg-brand-600 text-white font-medium px-4 py-2 rounded-md text-sm">
          Try Again
        </button>
      )}
    </div>
  );
}
