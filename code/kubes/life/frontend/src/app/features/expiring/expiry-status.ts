/** Expiry bucketing — pure date logic, unit-tested. The view groups items by
 *  this and colours them. */

export type ExpiryStatus = 'expired' | 'soon' | 'later';

/** Items within this many days (inclusive) count as "use soon". */
export const SOON_DAYS = 7;

/** Whole days from `today` until `expiry` (an ISO date string, no time).
 *  Negative = already past. null if there's no/invalid expiry. */
export function daysUntil(expiry: string | null, today: Date = new Date()): number | null {
  if (!expiry) return null;
  const due = new Date(`${expiry}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((due.getTime() - start.getTime()) / 86_400_000);
}

export function statusOf(days: number): ExpiryStatus {
  if (days < 0) return 'expired';
  if (days <= SOON_DAYS) return 'soon';
  return 'later';
}

/** Human label for a day-count: "expired", "today", "tomorrow", "in N days". */
export function expiryLabel(days: number): string {
  if (days < 0) return days === -1 ? 'expired yesterday' : `expired ${-days} days ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
