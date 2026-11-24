import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { addDays, isDate, logDate } from '../lib/dates';
import { suggestTargets, validProfile, weightTrend, type Profile } from '../lib/energy';
import { balanceTargets, defaultedTargets, goalsOn, targetsFromGoals, type GoalRow } from '../lib/goals';
import { HttpError, newId } from '../lib/ids';
import { COUNTED_STATUSES, dailyTotals } from '../lib/intake';
import { round } from '../lib/nutrients';
import { getSettings } from '../lib/settings';
import { today } from './day';

export const progress = new Hono<AppEnv>();

const GOAL_TYPES = ['energy', 'protein', 'fat', 'carbs', 'fiber', 'body-weight'] as const;
const GOAL_UNITS: Record<string, string> = { energy: 'kcal', protein: 'g', fat: 'g', carbs: 'g', fiber: 'g', 'body-weight': 'kg' };
const LB = 0.45359237;

async function getProfile(db: D1Database, userId: string): Promise<Profile | null> {
  const r = await db.prepare(`SELECT value FROM settings WHERE user_id = ? AND key = 'profile'`).bind(userId).first<{ value: string }>();
  if (!r) return null;
  const p = JSON.parse(r.value);
  return validProfile(p) ? p : null;
}

/** GET /api/goals -> goals in effect today plus the saved setup profile. */
progress.get('/goals', async (c) => {
  const user = c.get('user');
  const date = await today(c.env.DB, user.id, user.timezone);
  const [goals, profile] = await Promise.all([goalsOn(c.env.DB, user.id, date), getProfile(c.env.DB, user.id)]);
  return c.json({ date, goals, targets: targetsFromGoals(goals), default_targets: defaultedTargets(goals), profile });
});

/**
 * PUT /api/goals { energy?: number|null, protein?: ..., 'body-weight'?: ..., fill?: boolean }
 * A new value starts today and closes the previous goal; null cancels.
 * With `fill`, the body is the whole set of nutrition targets: the ones given are anchors and the blank ones
 * (null or missing) are calculated around them (see balanceTargets) and saved too; `filled` lists those.
 */
progress.put('/goals', async (c) => {
  const user = c.get('user');
  const date = await today(c.env.DB, user.id, user.timezone);
  const { fill, ...body } = await c.req.json<Record<string, number | null> & { fill?: boolean }>();
  let filled: string[] = [];
  if (fill) {
    const types = ['energy', 'protein', 'fat', 'carbs', 'fiber'] as const;
    for (const t of types) if (body[t] != null && !(typeof body[t] === 'number' && body[t]! > 0)) throw new HttpError(400, `invalid ${t} target`);
    const b = balanceTargets(body);
    filled = types.filter((t) => body[t] == null && b[t] != null && b[t]! > 0);
    for (const t of types) body[t] = b[t] != null && b[t]! > 0 ? b[t] : null;
  }
  await setGoals(c.env.DB, user.id, date, body);
  const goals = await goalsOn(c.env.DB, user.id, date);
  return c.json({ date, goals, targets: targetsFromGoals(goals), default_targets: defaultedTargets(goals), ...(fill ? { filled } : {}) });
});

async function setGoals(db: D1Database, userId: string, date: string, body: Record<string, number | null>): Promise<void> {
  const current = await goalsOn(db, userId, date);
  const stmts: D1PreparedStatement[] = [];
  for (const [type, value] of Object.entries(body)) {
    if (!(GOAL_TYPES as readonly string[]).includes(type)) throw new HttpError(400, `unknown goal type ${type}`);
    if (value !== null && !(typeof value === 'number' && value > 0 && value < 20000)) throw new HttpError(400, `invalid ${type} target`);
    const existing: GoalRow | undefined = current[type];
    if (existing) {
      if (existing.start_date === date) stmts.push(db.prepare(`UPDATE goal SET status = 'cancelled' WHERE id = ?`).bind(existing.id));
      else stmts.push(db.prepare(`UPDATE goal SET end_date = ?, status = 'completed' WHERE id = ?`).bind(addDays(date, -1), existing.id));
    }
    if (value !== null)
      stmts.push(
        db
          .prepare(`INSERT INTO goal (id, user_id, type, target_value, unit, start_date, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`)
          .bind(newId(), userId, type, round(value, 1), GOAL_UNITS[type]!, date),
      );
  }
  if (stmts.length) await db.batch(stmts);
}

/** POST /api/goals/suggest { profile, apply? } -> Mifflin-St Jeor starting targets; `apply` saves profile and goals. */
progress.post('/goals/suggest', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ profile: Profile; apply?: boolean }>();
  if (!validProfile(body.profile)) throw new HttpError(400, 'profile needs height_cm, weight_kg, age, sex, activity, goal_rate_kg_per_week');
  const s = suggestTargets(body.profile);
  if (body.apply) {
    await c.env.DB.prepare(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'profile', ?)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
      .bind(user.id, JSON.stringify(body.profile))
      .run();
    await setGoals(c.env.DB, user.id, await today(c.env.DB, user.id, user.timezone), { energy: s.energy, protein: s.protein });
  }
  return c.json(s);
});

/** POST /api/weight { value, unit: 'kg'|'lb', effective_at? } -> Observation (LOINC 29463-7, stored in kg). */
progress.post('/weight', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ value: number; unit?: 'kg' | 'lb'; effective_at?: string }>();
  const unit = body.unit ?? 'kg';
  if (unit !== 'kg' && unit !== 'lb') throw new HttpError(400, 'unit must be kg or lb');
  if (typeof body.value !== 'number' || !(body.value > 0)) throw new HttpError(400, 'value must be a positive number');
  const kg = unit === 'lb' ? body.value * LB : body.value;
  if (kg < 20 || kg > 400) throw new HttpError(400, 'weight out of range');
  const at = body.effective_at ? new Date(body.effective_at) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'invalid effective_at');
  const settings = await getSettings(c.env.DB, user.id);
  const id = newId();
  const date = logDate(at.toISOString(), user.timezone, settings.day_cutoff);
  await c.env.DB.prepare(`INSERT INTO observation (id, user_id, value, effective_at, log_date) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, user.id, round(kg, 2), at.toISOString(), date)
    .run();
  return c.json({ id, value: round(kg, 2), unit: 'kg', effective_at: at.toISOString(), log_date: date }, 201);
});

/** GET /api/weight?from=&to= -> weigh-ins and 7-day EMA trend (kg). The trend warms up from 60 days before `from`. */
progress.get('/weight', async (c) => {
  const user = c.get('user');
  const to = c.req.query('to') ?? (await today(c.env.DB, user.id, user.timezone));
  const from = c.req.query('from') ?? addDays(to, -89);
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'invalid range');
  const { results } = await c.env.DB.prepare(
    `SELECT id, value, effective_at, log_date FROM observation WHERE user_id = ? AND code = '29463-7' AND log_date BETWEEN ? AND ? ORDER BY effective_at`,
  )
    .bind(user.id, addDays(from, -60), to)
    .all<{ id: string; value: number; effective_at: string; log_date: string }>();
  const trend = weightTrend(results.map((r) => ({ date: r.log_date, kg: r.value }))).filter((t) => t.date >= from);
  return c.json({ from, to, entries: results.filter((r) => r.log_date >= from), trend });
});

progress.delete('/weight/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM observation WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  if (!r.meta.changes) throw new HttpError(404, 'not found');
  return c.body(null, 204);
});

/** GET /api/summary?end= -> week view: daily totals, weekly averages vs targets, logging streak. */
progress.get('/summary', async (c) => {
  const user = c.get('user');
  const t = await today(c.env.DB, user.id, user.timezone);
  const end = c.req.query('end') ?? t;
  if (!isDate(end)) throw new HttpError(400, 'invalid end date');
  const start = addDays(end, -6);
  const [days, goals, logged] = await Promise.all([
    dailyTotals(c.env.DB, user.id, start, end),
    goalsOn(c.env.DB, user.id, end),
    // Same days as the totals: a day whose only meal still has a question open was still logged.
    c.env.DB.prepare(`SELECT DISTINCT log_date FROM nutrition_intake WHERE user_id = ? AND status IN ${COUNTED_STATUSES} AND log_date <= ? ORDER BY log_date DESC LIMIT 400`)
      .bind(user.id, t)
      .all<{ log_date: string }>(),
  ]);
  const targets = targetsFromGoals(goals);
  // Average over completed days with food logged: an unlogged day doesn't read as fasting,
  // and today (still in progress) doesn't drag the average down until it's over.
  const loggedDays = days.filter((d) => d.meals > 0);
  const counted = loggedDays.filter((d) => d.date < t);
  const average: Record<string, number> = {};
  for (const code of ['ENERC_KCAL', 'PROCNT', 'FAT', 'CHOCDF', 'FIBTG']) {
    if (counted.length) average[code] = round(counted.reduce((s, d) => s + (d.totals[code] ?? 0), 0) / counted.length);
  }
  const set = new Set(logged.results.map((r) => r.log_date));
  let streak = 0;
  let cursor = set.has(t) ? t : addDays(t, -1); // today not logged yet doesn't break the streak
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  const series = Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => days.find((x) => x.date === d) ?? { date: d, meals: 0, unconfirmed: 0, totals: {} });
  return c.json({ start, end, days: series, days_logged: loggedDays.length, days_counted: counted.length, average, targets, streak });
});
