/** Day-boundary helpers (spec §12): meals before the cutoff count toward the previous day. */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
}

export function localParts(instant: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(
    fmt(tz)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour!;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    minutes: Number(hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday!),
  };
}

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Local log date for an instant, given the user's zone and a HH:MM day cutoff. Compared on the local
 * clock: subtracting the cutoff as elapsed time is an hour off on the days clocks change.
 */
export function logDate(occurrenceIso: string, tz: string, cutoff = '04:00'): string {
  const lp = localParts(new Date(occurrenceIso), tz);
  return lp.minutes < parseHHMM(cutoff) ? addDays(lp.date, -1) : lp.date;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Default meal type from local time of day. */
export function mealTypeForTime(minutes: number): 'breakfast' | 'lunch' | 'dinner' | 'snack' {
  if (minutes >= 4 * 60 && minutes < 10 * 60 + 30) return 'breakfast';
  if (minutes >= 11 * 60 && minutes < 14 * 60 + 30) return 'lunch';
  if (minutes >= 17 * 60 && minutes < 21 * 60 + 30) return 'dinner';
  return 'snack';
}

/** The instant a local wall-clock time on a date happens in `tz` (for times clear of a clock change, like noon). */
export function zonedTime(date: string, hhmm: string, tz: string): string {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const lp = localParts(new Date(guess), tz);
  return new Date(guess - (Date.parse(`${lp.date}T${lp.time}:00Z`) - guess)).toISOString();
}
