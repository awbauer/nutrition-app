import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { addDays, isDate, logDate } from '../lib/dates';
import { HttpError } from '../lib/ids';
import { goalsOn, targetsFromGoals } from '../lib/goals';
import { dailyTotals, intakesForDates } from '../lib/intake';
import { round } from '../lib/nutrients';
import { getSettings } from '../lib/settings';

export const day = new Hono<AppEnv>();

export async function today(db: D1Database, userId: string, tz: string): Promise<string> {
  const s = await getSettings(db, userId);
  return logDate(new Date().toISOString(), tz, s.day_cutoff);
}

/** GET /api/day/:date (or "today") -> meals, totals, targets and remaining. */
day.get('/day/:date', async (c) => {
  const user = c.get('user');
  let date = c.req.param('date');
  if (date === 'today') date = await today(c.env.DB, user.id, user.timezone);
  if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const [meals, goals] = await Promise.all([intakesForDates(c.env.DB, user.id, date, date), goalsOn(c.env.DB, user.id, date)]);
  const totals: Record<string, number> = {};
  for (const m of meals) if (m.status === 'completed') for (const [k, v] of Object.entries(m.totals)) totals[k] = round((totals[k] ?? 0) + v);
  const targets = targetsFromGoals(goals);
  const remaining: Record<string, number> = {};
  for (const [k, t] of Object.entries(targets)) remaining[k] = round(t - (totals[k] ?? 0));
  return c.json({ date, meals, totals, targets, remaining });
});

/** GET /api/range?from=&to= -> daily totals for a range (max 366 days). */
day.get('/range', async (c) => {
  const user = c.get('user');
  const to = c.req.query('to') ?? (await today(c.env.DB, user.id, user.timezone));
  const from = c.req.query('from') ?? addDays(to, -6);
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'from/to must be YYYY-MM-DD with from <= to');
  if (addDays(from, 366) < to) throw new HttpError(400, 'range too long');
  const [days, goals] = await Promise.all([dailyTotals(c.env.DB, user.id, from, to), goalsOn(c.env.DB, user.id, to)]);
  return c.json({ from, to, days, targets: targetsFromGoals(goals) });
});
