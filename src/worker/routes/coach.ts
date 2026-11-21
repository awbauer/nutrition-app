import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { generateReport, getReport, listReports } from '../lib/coach';
import { isDate } from '../lib/dates';
import { loggingQuality } from '../lib/events';
import { HttpError } from '../lib/ids';
import { today } from './day';

export const coach = new Hono<AppEnv>();

/** GET /api/coach -> the latest report and the list of earlier ones. */
coach.get('/', async (c) => {
  const user = c.get('user');
  const list = await listReports(c.env.DB, user.id);
  const latest = list.find((r) => r.status === 'ready') ?? list[0];
  return c.json({ today: await today(c.env.DB, user.id, user.timezone), latest: latest ? await getReport(c.env.DB, user.id, latest.log_date) : null, reports: list });
});

/** GET /api/coach/quality?days= -> how often the AI's items needed fixing. */
coach.get('/quality', async (c) => {
  const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
  return c.json(await loggingQuality(c.env.DB, c.get('user').id, days));
});

/** GET /api/coach/:date -> one report. */
coach.get('/:date', async (c) => {
  const date = c.req.param('date');
  if (!isDate(date)) throw new HttpError(400, 'bad date');
  const r = await getReport(c.env.DB, c.get('user').id, date);
  if (!r) throw new HttpError(404, 'no report for that day');
  return c.json(r);
});

/**
 * POST /api/coach/run -> write a report now, for today so far. The nightly run replaces it with the
 * full day once the day is over. Takes a while (the model reads two months of numbers).
 */
coach.post('/run', async (c) => {
  const user = c.get('user');
  const date = await today(c.env.DB, user.id, user.timezone);
  return c.json(await generateReport(c.env, user, date, true));
});
