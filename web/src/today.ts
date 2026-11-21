/**
 * The log date of an instant (default now) in the user's zone with the configured cutoff, compared on
 * the local clock as the server does (lib/dates.ts logDate): subtracting the cutoff as elapsed time
 * is an hour off on the days clocks change.
 */
export function logToday(tz: string, cutoff: string, now = new Date()): string {
  const [h, m] = cutoff.split(':').map(Number);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  if (minutes >= (h ?? 4) * 60 + (m ?? 0)) return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
