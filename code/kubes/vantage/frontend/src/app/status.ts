// Pure presentation helpers shared across the views — verdict/freshness → CSS
// modifier class, and human age formatting. Kept free of Angular so they're
// trivially unit-testable (status.spec.ts).

import { Freshness, Verdict } from './models';

/** CSS modifier class for a verdict (matches the .dot/.pill grammar in styles). */
export function verdictClass(v: Verdict): string {
  return v;
}

/** How a collector's freshness renders: a fresh collector shows its worst
 *  verdict; an overdue/silent one overrides to warn/fail — a dead producer must
 *  not look green. Returns the CSS modifier class to apply to the tile. */
export function tileClass(worst: Verdict, freshness: Freshness): string {
  if (freshness === 'silent') return 'fail';
  if (freshness === 'overdue') return 'warn';
  return worst;
}

/** Short label for a freshness state, or null when fresh (nothing to say). */
export function freshnessLabel(f: Freshness): string | null {
  switch (f) {
    case 'overdue':
      return 'overdue';
    case 'silent':
      return 'no data';
    default:
      return null;
  }
}

/** Compact human age from a whole-second count: "just now", "3m", "2h", "4d". */
export function formatAge(seconds: number): string {
  if (seconds < 45) return 'just now';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Format a numeric reading with its unit: symbol units attach (`43%`), word
 *  units get a space (`0 violations`, `68 days`), no unit is just the number. */
export function fmtValue(value: number, unit: string | null | undefined): string {
  if (!unit) return `${value}`;
  const attached = unit === '%' || unit === '°' || unit === '°C';
  return attached ? `${value}${unit}` : `${value} ${unit}`;
}
