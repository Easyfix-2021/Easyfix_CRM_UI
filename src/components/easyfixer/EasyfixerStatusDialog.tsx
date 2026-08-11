'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Loader2, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { EasyfixerLifecycleChip } from '@/components/easyfixer/EasyfixerLifecycleChip';
import { LifecycleTransitionGuideDialog } from '@/components/easyfixer/LifecycleTransitionGuideDialog';
import { api, ApiError } from '@/lib/api';
import {
  lifecycleLabel,
  lifecycleTargets,
  normalizeLifecycleHistory,
  normalizeLifecycleSnapshot,
  statusRequiresUntil,
  statusUsesUntil,
  validateLifecycleTransition,
  type EasyfixerLifecycleHistory,
  type EasyfixerLifecycleSnapshot,
  type EasyfixerLifecycleStatus,
} from '@/lib/easyfixer-lifecycle';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

const HISTORY_PAGE_SIZE = 10;
const EMPTY_HISTORY: EasyfixerLifecycleHistory = {
  items: [],
  total: 0,
  limit: HISTORY_PAGE_SIZE,
  offset: 0,
};

function istDate(daysFromToday = 0): string {
  const date = new Date(Date.now() + daysFromToday * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

/** Lifecycle `until` is a calendar DATE in IST, never a time-of-day. */
function formatLifecycleDate(value: string | null): string {
  if (!value) return '—';
  const dateOnly = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return value;
  const date = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function apiMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * A snapshot reflects a real, persisted CRM change (rather than a derived /
 * not-yet-set initial state) when it carries a technician-visible reason, or a
 * concrete source that isn't the system-derived placeholder. Derived snapshots
 * (source DERIVED / SYSTEM / absent, and no reason) render a single "Not yet
 * set from CRM" line instead of fake Last Updated / Source / Reason rows.
 */
function snapshotHasRealChange(snapshot: EasyfixerLifecycleSnapshot): boolean {
  if (snapshot.reason) return true;
  const source = (snapshot.source ?? '').trim().toUpperCase();
  return source !== '' && source !== 'DERIVED' && source !== 'SYSTEM';
}

/**
 * Canonical lifecycle editor and audit history. Data is fetched only while the
 * dialog is open; the list pages never issue per-row lifecycle requests.
 */
export function EasyfixerStatusDialog({
  open,
  easyfixerId,
  easyfixerName,
  canChange = true,
  canSchedule = false,
  onClose,
  onChanged,
}: {
  open: boolean;
  easyfixerId: number | null;
  easyfixerName?: string | null;
  canChange?: boolean;
  /** Admin-only permission inherited from the legacy timed-inactive flow. */
  canSchedule?: boolean;
  onClose: () => void;
  onChanged: (snapshot: EasyfixerLifecycleSnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<EasyfixerLifecycleSnapshot | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [history, setHistory] = useState<EasyfixerLifecycleHistory>(EMPTY_HISTORY);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState('');
  const [targetStatus, setTargetStatus] = useState<EasyfixerLifecycleStatus | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const confirmAction = useConfirm();
  const statusSeqRef = useRef(0);
  const historySeqRef = useRef(0);
  const savingRef = useRef(false);
  const openedAtRef = useRef(0);
  const statusInflightRef = useRef<{ id: number; promise: Promise<unknown> } | null>(null);

  const loadStatus = useCallback(async (id: number): Promise<EasyfixerLifecycleSnapshot | null> => {
    const seq = ++statusSeqRef.current;
    setStatusLoading(true);
    setStatusError(null);

    let request = statusInflightRef.current?.id === id
      ? statusInflightRef.current.promise
      : null;
    if (!request) {
      request = api.get<unknown>(`/admin/easyfixers/${id}/lifecycle-status`);
      statusInflightRef.current = { id, promise: request };
    }

    try {
      const raw = await request;
      if (seq !== statusSeqRef.current) return null;
      const next = normalizeLifecycleSnapshot(raw);
      if (!next) {
        setSnapshot(null);
        setStatusError('The server returned an invalid lifecycle status.');
        return null;
      }
      setSnapshot(next);
      return next;
    } catch (error) {
      if (seq === statusSeqRef.current) {
        setSnapshot(null);
        setStatusError(apiMessage(error, 'Failed to load lifecycle status.'));
      }
      return null;
    } finally {
      if (statusInflightRef.current?.promise === request) statusInflightRef.current = null;
      if (seq === statusSeqRef.current) setStatusLoading(false);
    }
  }, []);

  // Load the FULL history (no pagination UI): the list is scrollable and
  // client-side searchable, so we page through the endpoint here and accumulate
  // every transition. A technician's lifecycle history is small, so the loop
  // settles in one or two requests.
  const loadHistory = useCallback(async (id: number) => {
    const seq = ++historySeqRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const items: EasyfixerLifecycleHistory['items'] = [];
      let offset = 0;
      let total = 0;
      for (;;) {
        const raw = await api.get<unknown>(`/admin/easyfixers/${id}/lifecycle-history`, {
          limit: HISTORY_PAGE_SIZE,
          offset,
        });
        if (seq !== historySeqRef.current) return;
        const page = normalizeLifecycleHistory(raw, HISTORY_PAGE_SIZE);
        items.push(...page.items);
        total = page.total;
        offset += page.items.length;
        if (page.items.length === 0 || items.length >= total) break;
      }
      setHistory({ items, total, limit: items.length, offset: 0 });
    } catch (error) {
      if (seq === historySeqRef.current) {
        setHistoryError(apiMessage(error, 'Failed to load lifecycle history.'));
      }
    } finally {
      if (seq === historySeqRef.current) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || easyfixerId == null) return;
    openedAtRef.current = Date.now();
    setSnapshot(null);
    setHistory(EMPTY_HISTORY);
    setTargetStatus(null);
    setReasonCode('');
    setReason('');
    setUntil('');
    setSubmitError(null);
    setHistorySearch('');
    void loadStatus(easyfixerId);
    void loadHistory(easyfixerId);

    return () => {
      statusSeqRef.current += 1;
      historySeqRef.current += 1;
    };
  }, [easyfixerId, loadHistory, loadStatus, open]);

  function handleOpenChange(next: boolean) {
    if (!next && Date.now() - openedAtRef.current < 400) return;
    if (!next && !savingRef.current) onClose();
  }

  async function submit() {
    if (!snapshot || !targetStatus || easyfixerId == null || savingRef.current) return;
    const validationError = validateLifecycleTransition({
      currentStatus: snapshot.status,
      targetStatus,
      reason,
      until: canSchedule && statusUsesUntil(targetStatus) ? until : '',
      today: istDate(),
    });
    if (validationError) {
      setSubmitError(validationError);
      return;
    }

    // Blacklisting is reversible from the CRM (Ops can later move the technician
    // to Inactive / Dormant), but it's still a heavy action — require an explicit
    // confirmation before the audited PUT. Native confirm() is banned in this
    // app; use the shared confirm dialog.
    if (targetStatus === 'BLACKLISTED') {
      const ok = await confirmAction({
        title: 'Blacklist Technician?',
        icon: <Ban className="h-5 w-5" />,
        iconAccent: 'rose',
        variant: 'destructive',
        confirmLabel: 'Blacklist',
        description: (
          <div className="space-y-2">
            <p>
              <b>{easyfixerName ?? 'This technician'}</b> will be moved to{' '}
              <b>Blacklisted</b>.
            </p>
            <p>The reason you entered is recorded in the lifecycle audit log.</p>
          </div>
        ),
      });
      if (!ok) return;
    }

    savingRef.current = true;
    setSaving(true);
    setSubmitError(null);
    try {
      const raw = await api.put<unknown>(`/admin/easyfixers/${easyfixerId}/lifecycle-status`, {
        status: targetStatus,
        ...(reasonCode.trim() ? { reasonCode: reasonCode.trim() } : {}),
        reason: reason.trim(),
        ...(canSchedule && statusUsesUntil(targetStatus) && until ? { until } : {}),
        ...(snapshot.version != null ? { expectedVersion: snapshot.version } : {}),
      });
      const next = normalizeLifecycleSnapshot(raw) ?? await loadStatus(easyfixerId);
      if (!next) {
        setSubmitError('Status changed, but the refreshed lifecycle could not be loaded. Please reopen the dialog.');
        return;
      }
      showToast({ variant: 'success', message: `Lifecycle changed to ${lifecycleLabel(next.status)}.` });
      onChanged(next);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setTargetStatus(null);
        setUntil('');
        setSubmitError('Another operator changed this lifecycle. The latest status and history are shown; choose the transition again.');
        await Promise.all([loadStatus(easyfixerId), loadHistory(easyfixerId)]);
      } else {
        setSubmitError(apiMessage(error, 'Failed to update lifecycle status.'));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Timed suspension was Admin-only in the legacy CRM. Keep that boundary in
  // the UI as well as the backend: ordinary editors may PAUSE without a date,
  // but cannot choose SUSPENDED or schedule an automatic lift.
  const targets = snapshot
    ? lifecycleTargets(snapshot).filter((status) => canSchedule || status !== 'SUSPENDED')
    : [];
  // Client-side search over the FULL history: matches the from/to status of each
  // transition (label + raw code), so e.g. "blacklisted" surfaces every card
  // where the technician moved TO or FROM Blacklisted.
  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history.items;
    return history.items.filter((item) => {
      const haystack = [
        item.toStatus,
        lifecycleLabel(item.toStatus),
        item.fromStatus ?? '',
        item.fromStatus ? lifecycleLabel(item.fromStatus) : '',
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [history.items, historySearch]);

  return (
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/*
        * Fixed-max-height flex column: sticky header + scrollable body + always-
        * visible footer. Before this the whole DialogContent scrolled, which
        * clipped the footer Close button off-screen. `noPadding` strips the
        * default p-6 so the header/footer bands run edge-to-edge and the body
        * owns its own padding + scroll.
        */}
      <DialogContent noPadding className="sm:max-w-4xl max-h-[92vh] flex flex-col gap-0 overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Technician Lifecycle{easyfixerName ? ` — ${easyfixerName}` : ''}
          </DialogTitle>
          <DialogDescription>
            Review the canonical state and audit history before applying a version-checked transition.
          </DialogDescription>
        </DialogHeader>

        {/* Scrollable body — the only region that scrolls; footer stays put. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <section className="space-y-4">
            <div>
              {/* Heading sits ABOVE/outside the card — same type as "Lifecycle History". */}
              <div className="mb-2 flex items-center gap-1.5">
                <h3 className="text-sm font-semibold">Status</h3>
                {/* Read-only viewers have no New-Status picker to hang the guide
                    off, so surface it here. When canChange is true the picker
                    carries the guide instead (avoids a duplicate icon). */}
                {!canChange && snapshot && (
                  <LifecycleTransitionGuideDialog currentStatus={snapshot.status} />
                )}
              </div>
              <div className="rounded-lg border bg-slate-50 p-3">
                {statusLoading && !snapshot ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading current status…
                  </div>
                ) : snapshot ? (
                  <div className="space-y-2">
                    <EasyfixerLifecycleChip value={snapshot.status} size="md" />
                    {snapshotHasRealChange(snapshot) ? (
                      // Labeled, stacked rows. Version is intentionally omitted.
                      <dl className="space-y-1 text-xs">
                        <div className="flex gap-1.5">
                          <dt className="text-muted-foreground">Last Updated:</dt>
                          <dd className="text-slate-700">{formatDateTime(snapshot.changedAt)}</dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt className="text-muted-foreground">Source:</dt>
                          <dd className="text-slate-700">{snapshot.source ?? '—'}</dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt className="text-muted-foreground">Reason:</dt>
                          <dd className="text-slate-700">{snapshot.reason ?? '—'}</dd>
                        </div>
                        {snapshot.until && (
                          <div className="flex gap-1.5">
                            <dt className="text-muted-foreground">Until:</dt>
                            <dd className="text-slate-700">{formatLifecycleDate(snapshot.until)}</dd>
                          </div>
                        )}
                      </dl>
                    ) : (
                      // Derived / not-yet-set in CRM — no real audit entry to show.
                      <p className="text-xs text-muted-foreground">Not yet set from CRM.</p>
                    )}
                  </div>
                ) : statusError ? (
                  <div className="space-y-2">
                    <p className="text-sm text-red-600">{statusError}</p>
                    <Button size="sm" variant="outline" onClick={() => easyfixerId != null && void loadStatus(easyfixerId)}>
                      Retry
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>

            {canChange && snapshot && (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <Label className="block text-sm font-medium">New Status *</Label>
                    {/* Info affordance: opens the full transition-flow guide with
                        this technician's current status highlighted and their
                        actual available targets (the dropdown set) called out. */}
                    <LifecycleTransitionGuideDialog
                      currentStatus={snapshot.status}
                      availableTransitions={targets}
                    />
                  </div>
                  {targets.length ? (
                    // Shared searchable combobox (same "Type to filter…" control as
                    // the Manage Easyfixers Status filter). Options are the allowed
                    // targets, Title-Cased via the label map; `required` keeps the
                    // choice non-clearable so submit-gating stays identical.
                    <SearchSelect
                      placeholder="Choose Status…"
                      value={targetStatus ?? ''}
                      required
                      disabled={saving}
                      onChange={(value) => {
                        setTargetStatus((value || null) as EasyfixerLifecycleStatus | null);
                        setUntil('');
                        setSubmitError(null);
                      }}
                      options={targets.map((status) => ({ value: status, label: lifecycleLabel(status) }))}
                    />
                  ) : (
                    <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                      No status changes are currently available.
                    </p>
                  )}
                </div>

                {targets.length > 0 && (
                  <>
                    <div>
                      <Label htmlFor="lifecycle-reason-code" className="mb-1 block text-sm font-medium">Reason Code</Label>
                      <Input
                        id="lifecycle-reason-code"
                        value={reasonCode}
                        onChange={(event) => setReasonCode(event.target.value)}
                        maxLength={80}
                        placeholder="e.g. OPS_REVIEW"
                        disabled={saving}
                      />
                    </div>
                    <div>
                      <Label htmlFor="lifecycle-reason" className="mb-1 block text-sm font-medium">Technician-Visible Reason *</Label>
                      <textarea
                        id="lifecycle-reason"
                        value={reason}
                        onChange={(event) => {
                          setReason(event.target.value);
                          setSubmitError(null);
                        }}
                        maxLength={500}
                        placeholder="Explain the change clearly for the technician"
                        disabled={saving}
                        className="min-h-[84px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        This reason is stored in the audit log and may be shown in the technician app.
                      </p>
                    </div>
                    {canSchedule && statusUsesUntil(targetStatus) && (
                      <div>
                        <Label htmlFor="lifecycle-until" className="mb-1 block text-sm font-medium">
                          Until{statusRequiresUntil(targetStatus) ? ' *' : ''}
                        </Label>
                        <Input
                          id="lifecycle-until"
                          type="date"
                          min={istDate(1)}
                          value={until}
                          onChange={(event) => {
                            setUntil(event.target.value);
                            setSubmitError(null);
                          }}
                          disabled={saving}
                        />
                      </div>
                    )}
                  </>
                )}

                {submitError && <p className="text-sm text-red-600">{submitError}</p>}
                {targets.length > 0 && (
                  <Button
                    onClick={() => void submit()}
                    disabled={saving || !targetStatus || !reason.trim() || (statusRequiresUntil(targetStatus) && !until)}
                  >
                    {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                    {saving ? 'Saving…' : 'Change Lifecycle'}
                  </Button>
                )}
              </div>
            )}
          </section>

          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Lifecycle History</h3>
              {history.total > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {historySearch.trim() ? `${filteredHistory.length} of ${history.total}` : history.total}
                </span>
              )}
            </div>
            {history.total > 0 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={historySearch}
                  onChange={(event) => setHistorySearch(event.target.value)}
                  placeholder="Search Status (e.g. Blacklisted)"
                  className="pl-8"
                />
              </div>
            )}
            <div className="max-h-[430px] space-y-2 overflow-y-auto overscroll-contain pr-1">
              {historyLoading && history.items.length === 0 ? (
                <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading history…
                </div>
              ) : historyError ? (
                <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-700">{historyError}</p>
                  <Button size="sm" variant="outline" onClick={() => easyfixerId != null && void loadHistory(easyfixerId)}>
                    Retry
                  </Button>
                </div>
              ) : history.items.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No lifecycle changes recorded.</p>
              ) : filteredHistory.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No transitions match your search.</p>
              ) : filteredHistory.map((item) => (
                <article key={item.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.fromStatus ? <EasyfixerLifecycleChip value={item.fromStatus} /> : <span className="text-xs text-muted-foreground">Initial</span>}
                    <span className="text-xs text-muted-foreground">→</span>
                    <EasyfixerLifecycleChip value={item.toStatus} />
                  </div>
                  <p className="mt-1.5 text-xs text-slate-700">{item.reason ?? 'No reason recorded.'}</p>
                  {item.until && (
                    <p className="mt-1 text-[11px] text-slate-700">
                      Scheduled until {formatLifecycleDate(item.until)}
                    </p>
                  )}
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {formatDateTime(item.createdAt)} · {item.actorName ?? (item.actorUserId != null ? `User #${item.actorUserId}` : 'System')}
                    {item.source ? ` · ${item.source}` : ''}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EasyfixerStatusDialog;
