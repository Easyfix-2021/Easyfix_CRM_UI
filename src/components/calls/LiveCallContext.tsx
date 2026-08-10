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
  /*
   * conferenceId — the Plivo Multi-Party Call this leg belongs to, when the
   * backend minted one for it.
   *
   * WHY IT IS OPTIONAL, AND WHY IT MUST STAY OPTIONAL
   *
   * Plivo cannot promote a live <Dial> into a conference: <Dial> and MPC are
   * different objects with no conversion API. So the design is that EVERY ops
   * call is placed as an MPC carrying one participant — invisible to ops, but
   * it means "add someone" is one API call away at any moment. Minting that
   * room is the CALL path's job (it has to, in order to name the room the
   * operator's answer XML joins), which is why this arrives on the
   * click-to-call response rather than being created by the browser.
   *
   * The FE must NOT call POST /admin/conferences itself to fill this in. Two
   * reasons, either one sufficient:
   *   - it would burn a second concurrency slot for every call, and
   *   - a browser-created room would never materialise at Plivo, because the
   *     operator's leg was answered with the plain <Dial> XML and is not in it.
   *     Adding a participant to it would fail at the provider.
   *
   * So: absent ⇒ no conference surface, and the panel behaves exactly as it
   * always has. Present ⇒ the panel grows a participant list and Add To Call.
   * That is the whole integration, and it is deliberately one field.
   */
  conferenceId?: number | null;
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
