'use client';
import { useEffect, useState } from 'react';
import { formatClockHours } from '@/lib/decisionClock';

/**
 * Decision-clock badge: due time, time remaining, and the legal basis.
 * `clock` comes from decisionClock() in lib/decisionClock.js. `decidedAt`
 * (ISO) marks when the sandbox decided, so the badge can show the decision
 * landed inside the deadline. `tone` is 'light' (EHR) or 'dark' (UM feed).
 */
export default function ClockBadge({ clock, decidedAt, tone = 'light' }) {
  const [now, setNow] = useState(() => Date.now());
  const open = clock?.applies && !decidedAt;
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  if (!clock) return null;
  const dark = tone === 'dark';
  const box = dark
    ? 'bg-slate-900 border-slate-600 text-slate-200'
    : 'bg-white border-gray-300 text-gray-800';

  if (!clock.applies) {
    return (
      <div className={`mt-2 text-xs rounded border px-2 py-1 ${box}`}>
        <strong>Decision clock:</strong> none. {clock.note}
      </div>
    );
  }

  const due = new Date(clock.dueAt);
  const remainingMs = due.getTime() - (decidedAt ? new Date(decidedAt).getTime() : now);
  const hrs = Math.floor(Math.abs(remainingMs) / 3600000);
  const mins = Math.floor((Math.abs(remainingMs) % 3600000) / 60000);
  const status = decidedAt
    ? remainingMs >= 0
      ? `decided with ${hrs}h ${mins}m to spare`
      : `decided ${hrs}h ${mins}m late`
    : remainingMs >= 0
      ? `${hrs}h ${mins}m remaining`
      : `overdue by ${hrs}h ${mins}m`;

  return (
    <div className={`mt-2 text-xs rounded border px-2 py-1 ${box}`}>
      <div>
        <strong>Decision clock:</strong> {formatClockHours(clock.hours)} ({clock.kind}) · due{' '}
        {due.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} · {status}
      </div>
      <div className={dark ? 'text-slate-400' : 'text-gray-500'}>
        Basis: {clock.basis}
        {clock.proposed && ' (proposed, not yet in effect)'}
      </div>
      {clock.note && <div className={dark ? 'text-slate-400' : 'text-gray-500'}>{clock.note}</div>}
      {clock.emergencySupply && (
        <div className={dark ? 'text-amber-300' : 'text-amber-800'}>{clock.emergencySupply}</div>
      )}
    </div>
  );
}
