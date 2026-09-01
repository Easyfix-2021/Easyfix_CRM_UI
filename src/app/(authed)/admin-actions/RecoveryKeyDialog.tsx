'use client';

/*
 * Recovery Key — Admin Actions dialog (contract ADDENDUM 3).
 *
 * GENERATED IN THE BROWSER, ON PURPOSE
 * The keypair is minted by WebCrypto in this tab. Only the PUBLIC half is
 * POSTed. The private key is born here and never reaches the backend, its
 * logs, its memory or its error reporter — a server-side generator would put
 * the one thing this design protects into the exact place it is protected
 * from, and would then have to be trusted never to keep a copy.
 *
 * WHERE THE PRIVATE KEY LIVES, AND FOR HOW LONG
 *   - `privateKey` state in this component, from generate() until the operator
 *     ticks the confirmation box and closes. Cleared there, and on unmount.
 *   - The clipboard, if they press Copy. Theirs to manage after that.
 *   - A Blob + object URL for the duration of one Download click; the URL is
 *     revoked in the same tick.
 * It is never logged, never sent, never written to storage, and there is no
 * second render of it after the dialog closes — hence the required checkbox:
 * the dialog cannot be dismissed until the operator says they have it.
 *
 * WHAT ROTATION DOES AND DOES NOT DO — the counter-intuitive part
 * Generating a new keypair does NOT retroactively protect rows already
 * written; their DEKs are sealed to the OLD public key. The UI says this in
 * full sentences rather than a tooltip, because an operator who reads "rotate"
 * as "the old key is now harmless" stops worrying at exactly the wrong moment.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Fingerprint, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

/* The one action key the BE route requires. Named literally in the Access
 * Denied card below so an operator can quote it to whoever grants it. */
const ACTION_KEY = 'isRecoveryKeyManage';
const ENDPOINT = '/admin/field-rekey/recovery-key';

type ActiveKey = { fingerprint: string; created_on: string } | null;

/* DER → PEM. `String.fromCharCode(...)` is safe at these sizes (a 4096-bit
 * PKCS#8 blob is ~2.4 KB, well under the argument limit). */
function toPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
}

export function RecoveryKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useMe();
  const can = actionFlags(me, [ACTION_KEY]);
  const confirm = useConfirm();

  /* Deferred until the permission is known, so a user without it never fires a
   * request the route would 403 anyway. */
  const active = useFetch<ActiveKey>(can[ACTION_KEY] ? ENDPOINT : null);

  const [busy, setBusy] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const wipe = useCallback(() => {
    setPrivateKey('');
    setAcknowledged(false);
  }, []);

  /* Cleanup runs once, on unmount — the ref keeps `wipe` out of the deps so a
   * re-render can never re-fire it and blank a key still on screen. */
  const wipeRef = useRef(wipe);
  wipeRef.current = wipe;
  useEffect(() => () => { wipeRef.current(); }, []);

  /* The private key is shown exactly once, so closing while it is on screen
   * and unacknowledged destroys it. That close is BLOCKED rather than
   * confirmed — a discard prompt would still be a way to lose it by reflex. */
  const locked = !!privateKey && !acknowledged;

  /* Named handler, not an inline arrow: the eslint dialog rule allows an
   * identifier, and this needs to refuse the close outright rather than route
   * it through the shared dirty guard. */
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) return;
    if (locked) {
      showToast({
        variant: 'warning',
        message: 'Save The Private Key And Tick The Confirmation Before Closing',
      });
      return;
    }
    wipe();
    onClose();
  }, [locked, wipe, onClose]);

  async function generate() {
    if (typeof window === 'undefined' || !window.crypto?.subtle) {
      showToast({ variant: 'error', message: 'WebCrypto Is Unavailable — Open This Page Over HTTPS' });
      return;
    }
    const ok = await confirm({
      title: 'Generate A New Recovery Key?',
      confirmLabel: 'Generate Key',
      icon: <ShieldAlert className="h-5 w-5" />,
      iconAccent: 'amber',
      description: (
        <span>
          Rows written from now on are sealed to the new key. Rows already stored stay sealed to the
          current one and are <strong>not</strong> protected by this rotation — if the current key leaked
          and you still hold it, run Re-Seal Recovery Key afterwards. The private key is shown once and
          cannot be recovered.
        </span>
      ),
    });
    if (!ok) return;

    setBusy(true);
    try {
      const pair = await window.crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: 4096,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt'],
      );
      const [pkcs8, spki] = await Promise.all([
        window.crypto.subtle.exportKey('pkcs8', pair.privateKey),
        window.crypto.subtle.exportKey('spki', pair.publicKey),
      ]);
      const publicKeyPem = toPem(spki, 'PUBLIC KEY');
      /* PUBLIC HALF ONLY. Do not add the private PEM to this body, to a header,
       * to a query string, or to any error report. */
      await api.post(ENDPOINT, { publicKeyPem });
      setPrivateKey(toPem(pkcs8, 'PRIVATE KEY'));
      setAcknowledged(false);
      invalidateFetch((k) => k.startsWith(ENDPOINT));
      active.refetch();
      showToast({ variant: 'success', message: 'Recovery Key Generated' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Key Generation Failed' });
    } finally {
      setBusy(false);
    }
  }

  async function copyPrivateKey() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(privateKey);
      showToast({ variant: 'success', message: 'Private Key Copied' });
    } catch {
      showToast({ variant: 'error', message: 'Copy Failed — Select The Text And Copy Manually' });
    }
  }

  function downloadPrivateKey() {
    const blob = new Blob([privateKey], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `easyfix-recovery-private-key-${new Date().toISOString().slice(0, 10)}.pem`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Recovery Key</DialogTitle>
        </DialogHeader>
        {!can[ACTION_KEY] ? (
          <div className="p-4">
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                You don&apos;t have permission to manage the recovery key. Ask an admin to grant
                <code className="mx-1">{ACTION_KEY}</code>
                in Manage Roles.
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {/* ACTIVE KEY */}
            <div className="rounded border border-border p-3 text-sm space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <Fingerprint className="h-4 w-4 shrink-0" /> Active Recovery Key
              </div>
              {active.loading && <div className="text-xs text-muted-foreground">Loading…</div>}
              {!active.loading && active.error && (
                <div className="text-xs text-urgent-strong">{active.error}</div>
              )}
              {!active.loading && !active.error && !active.data && (
                <div className="text-xs text-muted-foreground">
                  No recovery key is on record yet. The environment bootstrap key is in use until one is
                  generated here.
                </div>
              )}
              {!active.loading && active.data && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div>
                    Fingerprint <code className="break-all">{active.data.fingerprint}</code>
                  </div>
                  <div>Created {formatDate(active.data.created_on)}</div>
                </div>
              )}
            </div>

            {/* THE CONSEQUENCE — stated before the button, in plain sentences. */}
            <div className="rounded border bg-warning-tint border-warning/30 p-3 text-sm space-y-2">
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4 shrink-0" /> What Generating A New Key Does, And Does Not Do
              </div>
              <ul className="text-xs space-y-1 list-disc pl-4">
                <li>Rows written <strong>from now on</strong> are sealed to the new key.</li>
                <li>
                  Rows <strong>already stored</strong> are still sealed to the OLD key. This rotation does
                  not protect them.
                </li>
                <li>
                  If the old key <strong>leaked</strong> and you still hold it — run Re-Seal Recovery Key in
                  Re-Key Encrypted Fields. That re-seals the stored rows to the new key and makes the leaked
                  one worthless.
                </li>
                <li>
                  If the old key was <strong>lost</strong> — those rows cannot be re-sealed, because that
                  needs the key you no longer have. <strong>The data is not lost:</strong> the operational
                  key still reads it perfectly. What is gone is the emergency path for those rows, and it
                  comes back as they are rewritten.
                </li>
              </ul>
            </div>

            {/* THE PRIVATE KEY — shown exactly once. */}
            {privateKey && (
              <div className="rounded border bg-urgent-tint border-urgent/30 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-urgent-strong">
                  <ShieldAlert className="h-4 w-4 shrink-0" /> Save This Private Key Now — It Will Never Be
                  Shown Again
                </div>
                <p className="text-xs text-urgent-strong">
                  It was generated in this browser and was never sent to the server. Nobody can re-issue it
                  for you. Store it where your break-glass procedure says it belongs.
                </p>
                <textarea
                  readOnly
                  value={privateKey}
                  rows={6}
                  spellCheck={false}
                  aria-label="Recovery Private Key"
                  className="w-full rounded-md border border-input bg-card p-2 text-xs font-mono resize-none"
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={copyPrivateKey}>
                    <Copy className="h-4 w-4 mr-1.5" /> Copy Private Key
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadPrivateKey}>
                    <Download className="h-4 w-4 mr-1.5" /> Download .pem
                  </Button>
                </div>
                <label className="flex items-start gap-2 text-xs text-urgent-strong cursor-pointer">
                  <Checkbox
                    checked={acknowledged}
                    onChange={setAcknowledged}
                    label="I Have Saved The Private Key"
                  />
                  <span>
                    I have saved this private key somewhere safe. I understand it will never be shown again.
                  </span>
                </label>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={busy}
                title={locked ? 'Tick The Confirmation First' : undefined}
              >
                Close
              </Button>
              {!privateKey && (
                <Button onClick={generate} disabled={busy}>
                  <Fingerprint className="h-4 w-4 mr-1.5" />
                  {busy ? 'Generating…' : 'Generate Recovery Key'}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
