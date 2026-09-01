'use client';

/*
 * Re-Key Encrypted Fields — Admin Actions dialog (contract ADDENDUM 2).
 *
 * WHAT IT DOES
 * Re-wraps every field-group DEK onto a NEW operational key, in bulk, without
 * an SSH session. Value ciphertexts are untouched — only the wrapped DEK
 * changes — so the operation stays small, fast, and survivable if interrupted.
 *
 * WHY THE MASTER KEY IS NOT ON THE DEFAULT PATH
 * A routine rotation does not need the recovery key: the CURRENT operational
 * key still unwraps each DEK, and we re-wrap with the new one. The recovery
 * private key is required ONLY when the current key is lost or already
 * replaced. Every time a recovery key is typed anywhere is an exposure, so the
 * default mode does not render that input at all — it is not disabled, not
 * collapsed, not optional-looking. It is absent.
 *
 * WHY DRY RUN GATES RUN
 * Run is a bulk decrypt/re-wrap of every account number in the company. The
 * operator must see its SIZE before firing it, so Run stays disabled until a
 * dry run has been seen for the exact (group, mode, new key) the Run would use.
 * Changing any of those three invalidates the dry run — a count measured
 * against a different target fingerprint is not a count of this run.
 *
 * WHY THE KEYS ARE NOT WIPED AFTER A DRY RUN
 * They are wiped on Run, on close and on unmount. Wiping after a dry run would
 * force the operator to retype the key for the Run that immediately follows —
 * one extra typing of a secret, which is the exact exposure this screen is
 * shaped to avoid. The dry run also never sends the recovery private key: only
 * the NEW key is needed to compute the target fingerprint, so the master key
 * crosses the wire on Run and nowhere else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, ScanSearch, ShieldAlert, Clock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { api } from '@/lib/api';

/* The one action key the BE route requires. Named literally in the Access
 * Denied card below so an operator can quote it to whoever grants it. */
const ACTION_KEY = 'isFieldRekeyRun';

/*
 * Field groups. A list, not a hardcoded branch — the owner was explicit that
 * this grows, so adding "Documents" or "Contact" later is one entry here plus
 * the matching group on the BE. Nothing else in this file knows about `bank`.
 */
const GROUPS: { value: string; label: string }[] = [
  { value: 'bank', label: 'Bank Details' },
];

type Mode = 'rotate' | 'recover' | 'reseal';

/*
 * The three modes, in the order an operator should consider them. `rotate` is
 * first AND default: it is the routine path and the only one that needs no
 * recovery key.
 */
const MODES: { value: Mode; label: string; blurb: string }[] = [
  {
    value: 'rotate',
    label: 'Rotate Operational Key',
    blurb:
      'Routine rotation. The current operational key still works, so each DEK is unwrapped with it '
      + 'and re-wrapped to the new one. No recovery key is needed, and none is asked for.',
  },
  {
    value: 'recover',
    label: 'Recover',
    blurb:
      'Break-glass. Use only when the current operational key is lost or has already been replaced — '
      + 'the recovery private key unseals each DEK instead. Audited as a recovery run.',
  },
  {
    value: 'reseal',
    label: 'Re-Seal Recovery Key',
    blurb:
      'The recovery key leaked and you still hold it. Each DEK is unsealed with the OLD recovery '
      + 'private key and re-sealed to the recovery public key currently on record. The operational '
      + 'wrap is left untouched, so no new operational key is involved.',
  },
];

type DryRunResult = { total: number; wouldChange: number; alreadyDone: number };
type RunResult = { changed: number; skipped: number; failed: number };

/* Which secret each mode actually consumes. Nothing renders a field a mode
 * does not use — see the header note on why absence beats disabled. */
const NEEDS_NEW_KEY: Record<Mode, boolean> = { rotate: true, recover: true, reseal: false };
const NEEDS_MASTER_KEY: Record<Mode, boolean> = { rotate: false, recover: true, reseal: false };
const NEEDS_OLD_RECOVERY_KEY: Record<Mode, boolean> = { rotate: false, recover: false, reseal: true };

function modeLabel(mode: Mode): string {
  return MODES.find((m) => m.value === mode)?.label ?? mode;
}

function count(n: number | undefined | null): string {
  return Number(n ?? 0).toLocaleString('en-IN');
}

export function FieldRekeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useMe();
  const can = actionFlags(me, [ACTION_KEY]);
  const confirm = useConfirm();

  const [group, setGroup] = useState<string>(GROUPS[0].value);
  const [mode, setMode] = useState<Mode>('rotate');
  const [newKey, setNewKey] = useState('');
  const [masterKey, setMasterKey] = useState('');
  const [oldRecoveryKey, setOldRecoveryKey] = useState('');
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null);
  const [dryRun, setDryRun] = useState<{ signature: string; result: DryRunResult } | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  /*
   * The dry run is only valid for what it measured. `newKey` is in the
   * signature because the "already done" count is decided by comparing each
   * envelope's fingerprint against the TARGET key's — a different key is a
   * different target and therefore a different count. The recovery private key
   * is deliberately NOT in the signature: it changes nothing about the counts,
   * and keeping it out means it can be typed after the dry run, immediately
   * before Run, rather than sitting in the form for the whole flow.
   */
  const signature = `${group}|${mode}|${NEEDS_NEW_KEY[mode] ? newKey : ''}`;
  const dryRunIsCurrent = dryRun !== null && dryRun.signature === signature;

  /* Every secret out of component state, in one place. Called on Run, on close
   * and on unmount. */
  const wipeKeys = useCallback(() => {
    setNewKey('');
    setMasterKey('');
    setOldRecoveryKey('');
  }, []);

  /* Latest wipe without making it an effect dependency — the unmount cleanup
   * must run exactly once, on unmount, not on every re-render. */
  const wipeRef = useRef(wipeKeys);
  wipeRef.current = wipeKeys;
  useEffect(() => () => { wipeRef.current(); }, []);

  const missingKey =
    (NEEDS_NEW_KEY[mode] && !newKey.trim())
    || (NEEDS_MASTER_KEY[mode] && !masterKey.trim())
    || (NEEDS_OLD_RECOVERY_KEY[mode] && !oldRecoveryKey.trim());

  /* Dry run needs only what it measures against — never the recovery key. */
  const dryRunMissingKey = NEEDS_NEW_KEY[mode] && !newKey.trim();

  function reset() {
    wipeKeys();
    setDryRun(null);
    setRunResult(null);
  }

  function close() {
    reset();
    onClose();
  }

  const guardedOpenChange = useFormDirtyGuard(close, {
    isDirty: () => !!(newKey || masterKey || oldRecoveryKey || dryRun || runResult),
    when: () => busy === null,
    title: 'Discard This Re-Key Form?',
    description: 'Any key you have pasted will be cleared.',
  });

  async function doDryRun() {
    if (dryRunMissingKey) {
      showToast({ variant: 'error', message: 'Paste The New Operational Key First' });
      return;
    }
    setBusy('dry');
    setRunResult(null);
    try {
      const r = await api.post<DryRunResult>('/admin/field-rekey/dry-run', {
        group,
        mode,
        ...(NEEDS_NEW_KEY[mode] ? { newKey } : {}),
      });
      setDryRun({ signature, result: r });
      showToast({ variant: 'success', message: `Dry Run Complete — ${count(r.wouldChange)} Row(s) Would Change` });
    } catch (e) {
      setDryRun(null);
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Dry Run Failed' });
    } finally {
      setBusy(null);
    }
  }

  async function doRun() {
    if (!dryRunIsCurrent || !dryRun) {
      showToast({ variant: 'error', message: 'Run A Dry Run For These Settings First' });
      return;
    }
    if (missingKey) {
      showToast({ variant: 'error', message: 'Fill Every Key This Mode Requires' });
      return;
    }
    const rows = dryRun.result.wouldChange;
    const ok = await confirm({
      title: 'Re-Key Encrypted Fields?',
      variant: 'destructive',
      confirmLabel: 'Run Re-Key',
      icon: <ShieldAlert className="h-5 w-5" />,
      iconAccent: 'rose',
      description: (
        <span>
          <strong>{modeLabel(mode)}</strong> on <strong>{GROUPS.find((g) => g.value === group)?.label}</strong> will
          re-wrap <strong>{count(rows)}</strong> row(s).
          {mode !== 'reseal' && (
            <>
              {' '}Until <code>EASYFIX_FIELD_ENC_KEY</code> is updated in the environment and the service is
              restarted, the app cannot read those rows.
            </>
          )}
          {' '}This run is recorded in the sensitive-access audit log.
        </span>
      ),
    });
    if (!ok) return;

    setBusy('run');
    try {
      const r = await api.post<RunResult>('/admin/field-rekey/run', {
        group,
        mode,
        ...(NEEDS_NEW_KEY[mode] ? { newKey } : {}),
        ...(NEEDS_MASTER_KEY[mode] ? { masterKey } : {}),
        ...(NEEDS_OLD_RECOVERY_KEY[mode] ? { oldRecoveryKey } : {}),
      });
      setRunResult(r);
      setDryRun(null);
      showToast({ variant: 'success', message: `Re-Key Complete — ${count(r.changed)} Row(s) Re-Wrapped` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Re-Key Failed' });
    } finally {
      /* The keys have been used. They leave state here whether the run
       * succeeded or threw — a failed attempt is not a reason to keep a
       * recovery key sitting in a mounted component. */
      wipeKeys();
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Re-Key Encrypted Fields</DialogTitle>
        </DialogHeader>
        {!can[ACTION_KEY] ? (
          <div className="p-4">
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                You don&apos;t have permission to re-key encrypted fields. Ask an admin to grant
                <code className="mx-1">{ACTION_KEY}</code>
                in Manage Roles.
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <Label htmlFor="rekey-group">Field Group *</Label>
              <Select
                id="rekey-group"
                value={group}
                options={GROUPS}
                onChange={(e) => { setGroup(e.target.value); setDryRun(null); setRunResult(null); }}
              />
              <p className="text-xs text-muted-foreground">
                Only the encrypted fields in this group are re-wrapped.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Mode *</Label>
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className={
                    'flex gap-3 rounded-md border p-3 cursor-pointer transition-colors '
                    + (mode === m.value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50')
                  }
                >
                  <input
                    type="radio"
                    name="rekey-mode"
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    checked={mode === m.value}
                    onChange={() => {
                      setMode(m.value);
                      setDryRun(null);
                      setRunResult(null);
                      /* Switching modes drops the secrets the previous mode
                       * collected — a key typed for Recover must not ride along
                       * into a Rotate run the operator thinks needs no key. */
                      wipeKeys();
                    }}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">
                      {m.label}
                      {m.value === 'rotate' && (
                        <span className="ml-2 text-xs text-muted-foreground">(Default)</span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{m.blurb}</span>
                  </span>
                </label>
              ))}
            </div>

            {/* KEY INPUTS — only what the selected mode consumes is rendered. */}
            {NEEDS_NEW_KEY[mode] && (
              <div className="space-y-1">
                <Label htmlFor="rekey-new-key">New Operational Key *</Label>
                <Input
                  id="rekey-new-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="32 Raw Bytes, Base64-Encoded"
                />
                <p className="text-xs text-muted-foreground">
                  This is the value that goes into <code>EASYFIX_FIELD_ENC_KEY</code> after the run.
                </p>
              </div>
            )}

            {NEEDS_MASTER_KEY[mode] && (
              <div className="space-y-1">
                <Label htmlFor="rekey-master-key">Recovery Private Key *</Label>
                <Input
                  id="rekey-master-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={masterKey}
                  onChange={(e) => setMasterKey(e.target.value)}
                  placeholder="Paste The PKCS#8 PEM Block"
                />
                <p className="text-xs text-muted-foreground">
                  Sent only when you press Run, never on a dry run. It is never logged, never stored and
                  never echoed back — the audit records only that recovery mode was used.
                </p>
              </div>
            )}

            {NEEDS_OLD_RECOVERY_KEY[mode] && (
              <div className="space-y-1">
                <Label htmlFor="rekey-old-recovery-key">Old Recovery Private Key *</Label>
                <Input
                  id="rekey-old-recovery-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={oldRecoveryKey}
                  onChange={(e) => setOldRecoveryKey(e.target.value)}
                  placeholder="Paste The PKCS#8 PEM Block Of The Leaked Key"
                />
                <p className="text-xs text-muted-foreground">
                  Each DEK is re-sealed to the recovery public key currently on record — generate the new
                  keypair first in Recovery Key, then re-seal with the old private key here.
                </p>
              </div>
            )}

            {/* DRY RUN RESULT */}
            {dryRunIsCurrent && dryRun && (
              <div className="rounded border bg-info-tint border-info/30 p-3 text-sm space-y-1">
                <div>
                  <strong>{count(dryRun.result.wouldChange)}</strong> of{' '}
                  <strong>{count(dryRun.result.total)}</strong> row(s) would change.
                </div>
                <div className="text-xs">
                  {count(dryRun.result.alreadyDone)} row(s) are already on the target key and will be
                  skipped. Nothing was written.
                </div>
              </div>
            )}

            {/* MAINTENANCE WINDOW — stated before Run, with the size of it. */}
            {dryRunIsCurrent && dryRun && mode !== 'reseal' && (
              <div className="rounded border bg-warning-tint border-warning/30 p-3 text-sm space-y-1">
                <div className="flex items-center gap-2 font-medium">
                  <Clock className="h-4 w-4 shrink-0" /> Next Step After Run
                </div>
                <div className="text-xs">
                  Once these {count(dryRun.result.wouldChange)} row(s) are re-wrapped, the app still holds
                  the OLD key and cannot read them. Update <code>EASYFIX_FIELD_ENC_KEY</code> in the
                  environment and restart the service to close that window. This is how one key in env
                  works, not a fault of the run — plan the restart for the same sitting.
                </div>
              </div>
            )}

            {/* RUN RESULT */}
            {runResult && (
              <div className="rounded border bg-success-tint border-success/30 p-3 text-sm space-y-1">
                <div>
                  <strong>{count(runResult.changed)}</strong> row(s) re-wrapped.
                </div>
                <div className="text-xs">
                  {count(runResult.skipped)} already on the target key
                  {runResult.failed ? ` · ${count(runResult.failed)} failed` : ''}. Re-running is a no-op
                  for rows already done, so a partial run is safe to repeat.
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={close} disabled={busy !== null}>Close</Button>
              <Button onClick={doDryRun} disabled={busy !== null || dryRunMissingKey}>
                <ScanSearch className="h-4 w-4 mr-1.5" />
                {busy === 'dry' ? 'Running Dry Run…' : 'Dry Run'}
              </Button>
              <Button
                variant="destructive"
                onClick={doRun}
                disabled={busy !== null || !dryRunIsCurrent || missingKey}
                title={dryRunIsCurrent ? undefined : 'Run A Dry Run For These Settings First'}
              >
                <KeyRound className="h-4 w-4 mr-1.5" />
                {busy === 'run' ? 'Re-Keying…' : 'Run Re-Key'}
              </Button>
            </div>
            {!dryRunIsCurrent && (
              <p className="text-xs text-muted-foreground text-right">
                Run stays disabled until a dry run has been seen for these exact settings.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
