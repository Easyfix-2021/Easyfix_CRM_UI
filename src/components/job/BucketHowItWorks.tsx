'use client';

import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/*
 * "How It Works?" for the two scheduling buckets on My Orders — the same
 * collapsible card Manage Auto Allocations and the TAT Calculator carry, so a
 * new team member finds the explanation where every other page keeps it.
 *
 * WRITTEN FOR OPS, NOT DEVELOPERS: short lines, the words on the buttons, and
 * only what someone working the queue needs. Every rule here is checked against
 * the code (2026-09-17) — if a flow changes, change this text with it.
 *   - offers / reassign-as-offer / past-appointment gates: backend
 *     routes/admin/jobs.js (/offer, /assign) and job.service assign()
 *   - reschedule notifications: notification-orchestrator RescheduleTech
 *     (customer SMS) + the client webhook; no technician push
 *   - tab order, status and timing: lib/pending-start-status.ts
 */

type Bucket = 'pending-scheduling' | 'pending-start';

export function BucketHowItWorks({ bucket }: { bucket: Bucket }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Info className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">How It Works?</span>
          <span className="block text-xs text-muted-foreground">
            {bucket === 'pending-scheduling'
              ? 'What this bucket holds, how to offer a job, and when to reschedule first.'
              : 'What this bucket holds, what the status and clock mean, and how to reschedule or reassign.'}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <CardContent className="space-y-4 border-t pt-4 text-sm leading-relaxed">
          {bucket === 'pending-scheduling' ? <PendingSchedulingGuide /> : <PendingStartGuide />}
        </CardContent>
      )}
    </Card>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="font-semibold">{title}</h3>
      <ul className="ml-5 list-disc space-y-1">{children}</ul>
    </section>
  );
}

function PendingSchedulingGuide() {
  return (
    <>
      <Block title="What is in this bucket">
        <li>Booked jobs that <b>no technician has yet</b>.</li>
        <li><b>Unallocated</b> — not offered to anyone yet.</li>
        <li><b>Offered-waiting</b> — offered, waiting for a technician to accept.</li>
        <li><b>No takers</b> — every offer was declined or expired.</li>
      </Block>
      <Block title="How to get a technician">
        <li>Open the job with the action icon (<b>Schedule &amp; Assign</b>).</li>
        <li>Tick one or more technicians from the Top 10 (or search anyone) and click <b>Offer</b>.</li>
        <li>Every ticked technician gets the offer on the app. The <b>first to accept</b> gets the job, and it moves to <b>Pending to Start</b>.</li>
      </Block>
      <Block title="Fix these first">
        <li><b>No service on the job?</b> Add at least one (<b>Edit Services</b>) — technicians are matched on services.</li>
        <li><b>Appointment time already passed?</b> You can’t offer. <b>Reschedule</b> first: new date and time, reason and remarks (the Uplifted view also asks who it is due to).</li>
      </Block>
      <Block title="When you reschedule">
        <li>Waiting offers <b>expire</b> — those technicians lose the offer, and the job shows under <b>No takers</b> until you offer it again.</li>
        <li>Click <b>Proceed to re-offer</b> and offer the job again <b>before you close</b> the window.</li>
        <li>The <b>customer gets an SMS</b> with the new time and the <b>client’s system is updated</b>.</li>
      </Block>
      <Block title="Two views">
        <li><b>Current</b> is the classic screen, <b>Uplifted</b> is the new console. Offering and rescheduling work the same in both; Uplifted also asks who a reschedule is due to.</li>
      </Block>
    </>
  );
}

function PendingStartGuide() {
  return (
    <>
      <Block title="What is in this bucket">
        <li>Jobs a technician has <b>accepted</b> but <b>not started</b> (not checked in yet).</li>
        <li>Each job sits in <b>one tab only</b>, in this order: <b>Cancel request</b> → <b>Reschedule request</b> (the technician asked on the app) → <b>Slots missed</b> (appointment day has passed) → <b>Today</b> → <b>Future</b>.</li>
      </Block>
      <Block title="Status and clock">
        <li>The <b>status</b> says what is waiting: Cancel requested, Reschedule requested, Slot missed, Due today, Upcoming.</li>
        <li>The <b>clock</b> says how close the visit is: <b>On-track</b> (more than 2 hours left), <b>Close loop</b> (2 hours or less — call the technician to confirm), <b>Running late</b> (the time has passed).</li>
      </Block>
      <Block title="Technician requests">
        <li><b>Approve</b> or <b>Reject</b> from the row’s icons or the console (Uplifted view).</li>
        <li>Approving a <b>cancel</b> opens the Cancel Job form; saving it cancels the job. Approving a <b>reschedule</b> opens the reschedule form with the asked time.</li>
      </Block>
      <Block title="Reschedule">
        <li>Moves the date and time. <b>The technician stays</b> on the job. In the Uplifted view it also asks who the reschedule is due to.</li>
        <li>The <b>customer gets an SMS</b> and the <b>client’s system is updated</b>. The <b>technician is not notified</b> — call them.</li>
      </Block>
      <Block title="Reassign (Change technician)">
        <li>Open the job with the reassign icon (or the console icon, then <b>Change</b> / <b>Reassign technician</b>), pick one technician and click <b>Reassign</b>.</li>
        <li>The current technician <b>loses the job straight away</b>. The new one gets an <b>offer</b> — the job moves to <b>Pending for Scheduling → Offered-waiting</b> until they accept.</li>
        <li><b>Appointment time already passed?</b> You’ll be asked to <b>reschedule first</b>, then <b>Proceed to reassign</b>. The system will not reassign a job for a time that has gone.</li>
      </Block>
      <Block title="Two views">
        <li>The reassign icon opens <b>Current</b> (classic): job details, Reschedule and Reassign.</li>
        <li>The console icon opens <b>Uplifted</b>: Reassign, a Reschedule that also asks who it is due to, technician requests (Approve / Reject), live location and <b>Change</b>.</li>
      </Block>
    </>
  );
}
