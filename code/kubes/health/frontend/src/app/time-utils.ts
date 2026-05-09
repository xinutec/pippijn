/**
 * Parse a timestamp from the API as local time, ignoring any UTC suffix.
 *
 * Fitbit records times in the user's local timezone. MariaDB stores them
 * as DATETIME (no timezone). The API may return them with a "Z" suffix
 * which is misleading — they are NOT UTC. This function extracts the
 * time components directly from the string without Date parsing.
 */
export function parseLocalTime(ts: string): { hours: number; minutes: number } {
  const match = ts.match(/(\d{2}):(\d{2})/);
  if (!match) throw new Error(`Cannot parse time from: ${ts}`);
  return { hours: parseInt(match[1], 10), minutes: parseInt(match[2], 10) };
}

export function formatLocalTime(ts: string): string {
  const { hours, minutes } = parseLocalTime(ts);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

/**
 * Parse a timestamp into epoch milliseconds, treating it as local time.
 * Used for calculating durations and relative positions on charts.
 */
export function localEpoch(ts: string): number {
  // Replace Z suffix and parse without timezone conversion
  const clean = ts.replace(/Z$/, "").replace("T", " ");
  const match = clean.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) throw new Error(`Cannot parse timestamp: ${ts}`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}
