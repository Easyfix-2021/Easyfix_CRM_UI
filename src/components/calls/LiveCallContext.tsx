'use client';

/*
 * LiveCallContext — single active click-to-call, app-wide.
 *
 * Holds (at most) ONE in-progress call so the fixed-position
 * <LiveCallPanel> (mounted once at the authed root) knows which call to
 * poll and render. Any CallButton / CallableMobile instance can open the
 * panel by calling `useLiveCall().startCall(info)` after a successful
 * POST /admin/calls/click-to-call whose response advertises
 * `supportsLiveStatus` (the Plivo path). `endCall()` clears it again — the
 * panel auto-dismisses on a terminal status and the operator can close it
 * manually too.
 *
 * Single-active-call by design: a second startCall replaces the first.
 * Operators place one bridged call at a time, and a single panel keeps the
 * UI uncluttered. (If concurrent calls ever become a thing, widen `active`
 * to an array — the consumer API is intentionally minimal so that's a
 * contained change.)
 *
 * Kaleyra path is unaffected: Kaleyra responses set supportsLiveStatus
 * false, so startCall is never invoked and this context stays dormant
 * (active === null), preserving today's toast-only behaviour exactly.
 */

import * as React from 'react';

export type LiveCall = {
  id: number;
  fromMasked: string | null;
  toMasked: string | null;
  name?: string | null;
};

type LiveCallContextValue = {
  active: LiveCall | null;
  startCall: (info: LiveCall) => void;
  endCall: () => void;
};

const LiveCallContext = React.createContext<LiveCallContextValue | null>(null);

export function LiveCallProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<LiveCall | null>(null);

  const startCall = React.useCallback((info: LiveCall) => {
    setActive(info);
  }, []);

  const endCall = React.useCallback(() => {
    setActive(null);
  }, []);

  const value = React.useMemo(
    () => ({ active, startCall, endCall }),
    [active, startCall, endCall],
  );

  return <LiveCallContext.Provider value={value}>{children}</LiveCallContext.Provider>;
}

/*
 * useLiveCall — access the active call + controls.
 *
 * Returns a no-op fallback when used outside a LiveCallProvider so a
 * CallButton rendered in an unexpected (non-authed) subtree degrades to
 * today's toast-only behaviour instead of throwing. Inside the authed
 * layout the real provider is always present.
 */
export function useLiveCall(): LiveCallContextValue {
  const ctx = React.useContext(LiveCallContext);
  if (!ctx) {
    return {
      active: null,
      startCall: () => {},
      endCall: () => {},
    };
  }
  return ctx;
}
