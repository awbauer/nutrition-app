/**
 * Daily insights and coaching.
 *
 * Every number comes from the log (coachDigest): intake against targets, macros, top foods,
 * weight trend, and how well the user is logging (days and meals covered, AI estimates, unsure
 * matches, unanswered questions, how long after eating they log). A model then reads the digest
 * and writes the insights and coaching; it interprets the numbers, it doesn't make them up.
 *
 * A report covers one log date and looks back over the day, the week and the month ending then.
 * The cron writes yesterday's report once the user's day has ended (their day cutoff, 04:00 by
 * default); "Update now" writes one for today so far, which the nightly run later replaces.
 */
import type { Env, User } from '../env';
import { extractJson, gatewayOpts, isCapacityError, modelOptions, responseText } from './ai';
import { addDays, localParts, logDate } from './dates';
import { weightTrend } from './energy';
import { goalsOn, targetsFromGoals } from './goals';
import { HttpError, newId } from './ids';
import { dailyTotals, type MealType } from './intake';
import { getSettings } from './settings';

export const COACH_MODEL = '@cf/zai-org/glm-5.3';
export const COACH_FALLBACK_MODEL = '@cf/openai/gpt-oss-120b';
export const COACH_PROMPT_VERSION = 'coach-v1';
/** Failed nightly runs are retried on later cron ticks, this many times. */
const MAX_ATTEMPTS = 3;

const MACROS = ['ENERC_KCAL', 'PROCNT', 'CHOCDF', 'FAT', 'FIBTG', 'SUGAR', 'NA'] as const;
const MAIN_MEALS: MealType[] = ['breakfast', 'lunch', 'dinner'];

export interface PeriodStats {
  from: string;
  to: string;
  days: number;
  days_logged: number;
  /** Logged days under half the calorie target: probably not fully logged. */
  days_probably_incomplete: number;
  /** Average per logged day. */
  avg: Record<string, number>;
  days_within_10pct_kcal: number;
  days_protein_target_met: number;
  meals_per_logged_day: number;
  /** Logged days on which each main meal was logged. */
  meal_days: Record<string, number>;
  items: number;
  pct_items_ai_estimate: number;
  pct_items_unsure: number;
  meals_waiting_on_answers: number;
  /** Median minutes between eating and logging (logged later than 15 min after). */
  median_log_delay_min: number | null;
  sources: Record<string, number>;
}

export interface Digest {
  reviewed_date: string;
  partial: boolean;
  weekday: string;
  targets: Record<string, number>;
  day: PeriodStats & { meals: { meal_type: string; time: string; items: { name: string; kcal: number; protein: number; estimated: boolean }[] }[] };
  week: PeriodStats;
  previous_week: PeriodStats;
  month: PeriodStats;
  previous_month: PeriodStats;
  top_foods_month: { name: string; times: number; kcal_share_pct: number; protein_g_per_time: number }[];
  new_foods_week: string[];
  weight: { unit: 'kg' | 'lb'; entries_month: number; trend_now: number | null; trend_change_week: number | null; trend_change_month: number | null } | null;
  logging_score: number;
}

export interface CoachReport {
  headline: string;
  summary: string;
  periods: { day: string[]; week: string[]; month: string[] };
  wins: string[];
  watch: string[];
  coaching: { title: string; detail: string }[];
  logging: { summary: string; tips: string[] };
}

interface ItemRow {
  intake_id: string;
  log_date: string;
  meal_type: MealType;
  source: string;
  status: string;
  occurrence_at: string;
  recorded_at: string;
  display_name: string | null;
  food_id: string | null;
  estimated: number | null;
  confidence: number | null;
  kcal: number | null;
  protein: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
}

function periodStats(
  from: string,
  to: string,
  days: { date: string; meals: number; totals: Record<string, number> }[],
  rows: ItemRow[],
  targets: Record<string, number>,
): PeriodStats {
  const inRange = (d: string) => d >= from && d <= to;
  const ds = days.filter((d) => inRange(d.date) && d.meals > 0);
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const avg: Record<string, number> = {};
  for (const c of MACROS) avg[c] = ds.length ? r1(ds.reduce((a, d) => a + (d.totals[c] ?? 0), 0) / ds.length) : 0;
  const kT = targets.ENERC_KCAL;
  const pT = targets.PROCNT;
  const rs = rows.filter((r) => inRange(r.log_date));
  const meals = new Map<string, ItemRow>();
  for (const r of rs) meals.set(r.intake_id, r);
  const completed = [...meals.values()].filter((m) => m.status === 'completed');
  const items = rs.filter((r) => r.food_id && r.status === 'completed');
  const mealDays: Record<string, number> = {};
  for (const mt of MAIN_MEALS) mealDays[mt] = new Set(completed.filter((m) => m.meal_type === mt).map((m) => m.log_date)).size;
  const delays = completed
    .filter((m) => m.source !== 'copy')
    .map((m) => (Date.parse(m.recorded_at) - Date.parse(m.occurrence_at)) / 60000)
    .filter((x) => x >= 0);
  const sources: Record<string, number> = {};
  for (const m of completed) sources[m.source] = (sources[m.source] ?? 0) + 1;
  return {
    from,
    to,
    days: n,
    days_logged: ds.length,
    days_probably_incomplete: kT ? ds.filter((d) => (d.totals.ENERC_KCAL ?? 0) < kT * 0.5).length : 0,
    avg,
    days_within_10pct_kcal: kT ? ds.filter((d) => Math.abs((d.totals.ENERC_KCAL ?? 0) - kT) <= kT * 0.1).length : 0,
    days_protein_target_met: pT ? ds.filter((d) => (d.totals.PROCNT ?? 0) >= pT * 0.95).length : 0,
    meals_per_logged_day: ds.length ? r1(completed.length / ds.length) : 0,
    meal_days: mealDays,
    items: items.length,
    pct_items_ai_estimate: pct(items.filter((i) => i.estimated).length, items.length),
    pct_items_unsure: pct(items.filter((i) => (i.confidence ?? 1) < 0.5).length, items.length),
    meals_waiting_on_answers: [...meals.values()].filter((m) => m.status === 'in-progress').length,
    median_log_delay_min: median(delays.filter((x) => x > 15)) ?? (delays.length ? 0 : null),
    sources,
  };
}

/**
 * 0-100 for the week: days logged (40), main meals covered on logged days (25), items matched to
 * real foods rather than AI estimates (15), questions answered (10), logged within the hour (10).
 */
export function loggingScore(w: PeriodStats): number {
  if (!w.days_logged) return 0;
  const days = w.days_logged / w.days;
  const meals = (MAIN_MEALS.reduce((a, m) => a + (w.meal_days[m] ?? 0), 0) / (w.days_logged * 3)) || 0;
  const matched = 1 - w.pct_items_ai_estimate / 100;
  const answered = w.meals_waiting_on_answers ? Math.max(0, 1 - w.meals_waiting_on_answers / 3) : 1;
  const prompt = w.median_log_delay_min == null ? 1 : w.median_log_delay_min <= 60 ? 1 : w.median_log_delay_min <= 240 ? 0.5 : 0.2;
  return Math.round(40 * days + 25 * Math.min(1, meals) + 15 * matched + 10 * answered + 10 * prompt);
}

/** Everything the coach looks at for one reviewed log date (and the 59 days before it). */
export async function coachDigest(db: D1Database, user: User, reviewed: string, partial = false): Promise<Digest> {
  const settings = await getSettings(db, user.id);
  const from60 = addDays(reviewed, -59);
  const [goals, days, rowsRes, weightRes, firstSeen] = await Promise.all([
    goalsOn(db, user.id, reviewed),
    dailyTotals(db, user.id, from60, reviewed),
    db
      .prepare(
        `SELECT i.id AS intake_id, i.log_date, i.meal_type, i.source, i.status, i.occurrence_at, i.recorded_at,
           ci.display_name, ci.food_id, ci.estimated, ci.confidence,
           (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'ENERC_KCAL') AS kcal,
           (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'PROCNT') AS protein
         FROM nutrition_intake i LEFT JOIN consumed_item ci ON ci.intake_id = i.id
         WHERE i.user_id = ? AND i.status != 'entered-in-error' AND i.log_date BETWEEN ? AND ?
         ORDER BY i.occurrence_at, ci.position`,
      )
      .bind(user.id, from60, reviewed)
      .all<ItemRow>(),
    db
      .prepare(`SELECT value, log_date FROM observation WHERE user_id = ? AND code = '29463-7' AND log_date BETWEEN ? AND ? ORDER BY effective_at`)
      .bind(user.id, addDays(reviewed, -89), reviewed)
      .all<{ value: number; log_date: string }>(),
    // Foods eaten in the last week that the user hadn't logged before it.
    db
      .prepare(
        `SELECT ci.display_name FROM consumed_item ci JOIN nutrition_intake i ON i.id = ci.intake_id
         WHERE ci.user_id = ? AND i.status = 'completed' AND i.log_date BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM consumed_item c2 JOIN nutrition_intake i2 ON i2.id = c2.intake_id
             WHERE c2.user_id = ci.user_id AND c2.food_id = ci.food_id AND i2.status = 'completed' AND i2.log_date < ?)
         GROUP BY ci.food_id LIMIT 12`,
      )
      .bind(user.id, addDays(reviewed, -6), reviewed, addDays(reviewed, -6))
      .all<{ display_name: string }>(),
  ]);
  const rows = rowsRes.results;
  const targets = targetsFromGoals(goals);
  const stats = (back: number, len: number) => periodStats(addDays(reviewed, -(back + len - 1)), addDays(reviewed, -back), days, rows, targets);

  const day = stats(0, 1);
  const dayMeals = new Map<string, Digest['day']['meals'][number]>();
  for (const r of rows.filter((r) => r.log_date === reviewed && r.status === 'completed' && r.food_id)) {
    let m = dayMeals.get(r.intake_id);
    if (!m) {
      m = { meal_type: r.meal_type, time: localParts(new Date(r.occurrence_at), user.timezone).time, items: [] };
      dayMeals.set(r.intake_id, m);
    }
    m.items.push({ name: r.display_name ?? '', kcal: Math.round(r.kcal ?? 0), protein: r1(r.protein ?? 0), estimated: !!r.estimated });
  }

  // Top foods this month, by times eaten, with their share of the month's calories.
  const month = stats(0, 30);
  const monthItems = rows.filter((r) => r.log_date >= month.from && r.status === 'completed' && r.food_id);
  const monthKcal = monthItems.reduce((a, r) => a + (r.kcal ?? 0), 0);
  const byName = new Map<string, { times: number; kcal: number; protein: number }>();
  for (const r of monthItems) {
    const k = (r.display_name ?? '').toLowerCase().trim();
    const f = byName.get(k) ?? { times: 0, kcal: 0, protein: 0 };
    f.times += 1;
    f.kcal += r.kcal ?? 0;
    f.protein += r.protein ?? 0;
    byName.set(k, f);
  }
  const top = [...byName.entries()]
    .sort((a, b) => b[1].times - a[1].times || b[1].kcal - a[1].kcal)
    .slice(0, 12)
    .map(([name, f]) => ({ name, times: f.times, kcal_share_pct: pct(f.kcal, monthKcal), protein_g_per_time: r1(f.protein / f.times) }));

  // Weight: 7-day trend now, a week ago and a month ago, in the user's unit.
  let weight: Digest['weight'] = null;
  if (weightRes.results.length) {
    const trend = weightTrend(weightRes.results.map((w) => ({ date: w.log_date, kg: w.value })));
    const at = (d: string) => [...trend].reverse().find((t) => t.date <= d)?.trend ?? null;
    const f = settings.weight_unit === 'lb' ? 2.20462 : 1;
    const now = at(reviewed);
    const wk = at(addDays(reviewed, -7));
    const mo = at(addDays(reviewed, -30));
    weight = {
      unit: settings.weight_unit,
      entries_month: weightRes.results.filter((w) => w.log_date >= month.from).length,
      trend_now: now == null ? null : r1(now * f),
      trend_change_week: now == null || wk == null ? null : r1((now - wk) * f),
      trend_change_month: now == null || mo == null ? null : r1((now - mo) * f),
    };
  }

  const week = stats(0, 7);
  return {
    reviewed_date: reviewed,
    partial,
    weekday: new Date(`${reviewed}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    targets,
    day: { ...day, meals: [...dayMeals.values()] },
    week,
    previous_week: stats(7, 7),
    month,
    previous_month: stats(30, 30),
    top_foods_month: top,
    new_foods_week: firstSeen.results.map((r) => r.display_name),
    weight,
    logging_score: loggingScore(week),
  };
}

// ---------- the model ----------

const SYSTEM = `You are a warm, direct nutrition coach inside a personal food-logging app. You get a JSON digest of one
person's log: their targets, the reviewed day, the last 7 and 30 days (each with the period before for comparison),
their most-eaten foods, new foods, weight trend and how well they are logging. Nutrient codes: ENERC_KCAL kcal,
PROCNT protein g, CHOCDF carbs g, FAT fat g, FIBTG fiber g, SUGAR sugars g, NA sodium mg. Averages are per LOGGED day.

Look at the whole picture: what they eat, how it compares with their targets, trends between periods, patterns in
foods and meals, weight, and how complete and accurate their logging is. Incomplete logging changes how much the
intake numbers can be trusted; say so when it matters, and don't praise a "low" calorie day that was just not logged.

Rules:
- Use only numbers in the digest; quote them (rounded) to be concrete. Never invent foods, days or values.
- Be specific and kind, not generic. No medical advice or diagnoses; no shaming. Plain words, short sentences.
- If "partial" is true, the reviewed day is still in progress: talk about it as "so far today".
- Coaching items are concrete next steps for the coming days (e.g. a specific swap or addition using foods they
  already eat, a logging habit), each with the reason from their data. 1 to 3 of them.

Return ONLY a JSON object:
{
  "headline": "one line, under 80 characters, the most useful takeaway",
  "summary": "2-3 sentences on the whole picture",
  "periods": {
    "day":   ["2-4 short observations about the reviewed day"],
    "week":  ["2-4 short observations about the last 7 days, compared with the 7 before"],
    "month": ["2-4 short observations about the last 30 days, compared with the 30 before"]
  },
  "wins":  ["1-3 things going well"],
  "watch": ["0-3 things to keep an eye on"],
  "coaching": [{"title": "short imperative", "detail": "1-2 sentences: what to do and why, from their data"}],
  "logging": {"summary": "1-2 sentences on how complete and accurate their logging is", "tips": ["0-2 specific tips"]}
}`;

const strs = (x: unknown, max: number): string[] =>
  (Array.isArray(x) ? x : [])
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .map((s) => s.trim().slice(0, 400))
    .slice(0, max);

export class CoachOutputError extends Error {}

export function validateReport(raw: unknown): CoachReport {
  const o = extractJson(raw) as Record<string, any> | null;
  if (!o || typeof o.headline !== 'string' || !o.headline.trim() || typeof o.summary !== 'string') throw new CoachOutputError('headline and summary are required');
  const p = (o.periods ?? {}) as Record<string, unknown>;
  return {
    headline: o.headline.trim().slice(0, 140),
    summary: o.summary.trim().slice(0, 800),
    periods: { day: strs(p.day, 5), week: strs(p.week, 5), month: strs(p.month, 5) },
    wins: strs(o.wins, 4),
    watch: strs(o.watch, 4),
    coaching: (Array.isArray(o.coaching) ? o.coaching : [])
      .filter((c: any) => c && typeof c.title === 'string' && typeof c.detail === 'string')
      .slice(0, 3)
      .map((c: any) => ({ title: c.title.trim().slice(0, 120), detail: c.detail.trim().slice(0, 500) })),
    logging: {
      summary: typeof o.logging?.summary === 'string' ? o.logging.summary.trim().slice(0, 500) : '',
      tips: strs(o.logging?.tips, 3),
    },
  };
}

async function writeReport(env: Env, model: string, digest: Digest): Promise<CoachReport> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(digest) },
      ...(attempt ? [{ role: 'user', content: 'Your previous answer was not valid JSON matching the schema. Reply with the JSON object only.' }] : []),
    ];
    const r = await env.AI.run(model as Parameters<Ai['run']>[0], { messages, temperature: 0.4, response_format: { type: 'json_object' }, ...modelOptions(model) } as never, gatewayOpts(env) as never);
    try {
      return validateReport(responseText(r));
    } catch (e) {
      last = e;
      if (!(e instanceof CoachOutputError) && !(e instanceof SyntaxError)) throw e;
    }
  }
  throw last;
}

// ---------- storage ----------

export interface StoredReport {
  log_date: string;
  partial: boolean;
  status: 'pending' | 'ready' | 'failed';
  created_at: string;
  model: string | null;
  digest: Digest | null;
  report: CoachReport | null;
  error: string | null;
}

interface ReportRow {
  log_date: string;
  partial: number;
  status: StoredReport['status'];
  created_at: string;
  model: string | null;
  digest_json: string | null;
  report_json: string | null;
  error: string | null;
  attempts: number;
}

const toStored = (r: ReportRow): StoredReport => ({
  log_date: r.log_date,
  partial: !!r.partial,
  status: r.status,
  created_at: r.created_at,
  model: r.model,
  digest: r.digest_json ? (JSON.parse(r.digest_json) as Digest) : null,
  report: r.report_json ? (JSON.parse(r.report_json) as CoachReport) : null,
  error: r.error,
});

export async function getReport(db: D1Database, userId: string, date: string): Promise<StoredReport | null> {
  const r = await db.prepare('SELECT * FROM coach_report WHERE user_id = ? AND log_date = ?').bind(userId, date).first<ReportRow>();
  return r ? toStored(r) : null;
}

export async function listReports(db: D1Database, userId: string, limit = 30) {
  const { results } = await db
    .prepare(`SELECT log_date, partial, status, created_at, report_json FROM coach_report WHERE user_id = ? ORDER BY log_date DESC LIMIT ?`)
    .bind(userId, limit)
    .all<{ log_date: string; partial: number; status: string; created_at: string; report_json: string | null }>();
  return results.map((r) => ({
    log_date: r.log_date,
    partial: !!r.partial,
    status: r.status,
    created_at: r.created_at,
    headline: r.report_json ? (JSON.parse(r.report_json) as CoachReport).headline : null,
  }));
}

/**
 * Build and store the report for one log date. Claims the row first so two runs never write the same
 * report; a claim older than 10 minutes counts as abandoned.
 */
export async function generateReport(env: Env, user: User, date: string, partial: boolean): Promise<StoredReport> {
  const db = env.DB;
  const claim = await db
    .prepare(
      `INSERT INTO coach_report (id, user_id, log_date, partial, status, attempts) VALUES (?, ?, ?, ?, 'pending', 1)
       ON CONFLICT (user_id, log_date) DO UPDATE SET status = 'pending', partial = excluded.partial, attempts = coach_report.attempts + 1,
         error = NULL, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE coach_report.status != 'pending' OR coach_report.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')`,
    )
    .bind(newId(), user.id, date, partial ? 1 : 0)
    .run();
  if (!claim.meta.changes) throw new HttpError(409, 'a report is already being written');
  try {
    const digest = await coachDigest(db, user, date, partial);
    let model = COACH_MODEL;
    let report: CoachReport;
    try {
      report = await writeReport(env, model, digest);
    } catch (e) {
      if (!isCapacityError(e) && !(e instanceof CoachOutputError)) throw e;
      console.warn('coach model failed, falling back', (e as Error).message);
      model = COACH_FALLBACK_MODEL;
      report = await writeReport(env, model, digest);
    }
    await db
      .prepare(
        `UPDATE coach_report SET status = 'ready', model = ?, prompt_version = ?, digest_json = ?, report_json = ?, error = NULL,
           created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND log_date = ?`,
      )
      .bind(model, COACH_PROMPT_VERSION, JSON.stringify(digest), JSON.stringify(report), user.id, date)
      .run();
  } catch (e) {
    console.error('coach report failed', date, e);
    await db
      .prepare(`UPDATE coach_report SET status = 'failed', error = ? WHERE user_id = ? AND log_date = ?`)
      .bind(String((e as Error).message ?? e).slice(0, 300), user.id, date)
      .run();
  }
  return (await getReport(db, user.id, date))!;
}

/**
 * Cron: for each user who has logged in the last 30 days, write the report for the day that just
 * ended (their log date flips at their day cutoff, 04:00 by default). Skips days already reported
 * (a "so far today" report made by hand is replaced), and retries failures a few times.
 */
export async function runDueReports(env: Env, now: Date): Promise<{ written: number; failed: number }> {
  const { results: users } = await env.DB.prepare(
    `SELECT u.id, u.access_sub, u.email, u.timezone FROM users u
     WHERE EXISTS (SELECT 1 FROM nutrition_intake i WHERE i.user_id = u.id AND i.recorded_at >= ?)`,
  )
    .bind(new Date(now.getTime() - 30 * 86400000).toISOString())
    .all<User>();
  let written = 0;
  let failed = 0;
  for (const user of users) {
    const s = await getSettings(env.DB, user.id);
    const yesterday = addDays(logDate(now.toISOString(), user.timezone, s.day_cutoff), -1);
    const existing = await env.DB.prepare('SELECT status, partial, attempts FROM coach_report WHERE user_id = ? AND log_date = ?')
      .bind(user.id, yesterday)
      .first<{ status: string; partial: number; attempts: number }>();
    if (existing && existing.status === 'ready' && !existing.partial) continue;
    if (existing && existing.status === 'failed' && !existing.partial && existing.attempts >= MAX_ATTEMPTS) continue;
    // Nothing logged that day or the six before: no report.
    const any = await env.DB.prepare(`SELECT 1 FROM nutrition_intake WHERE user_id = ? AND status = 'completed' AND log_date BETWEEN ? AND ? LIMIT 1`)
      .bind(user.id, addDays(yesterday, -6), yesterday)
      .first();
    if (!any) continue;
    const r = await generateReport(env, user, yesterday, false).catch(() => null);
    if (r?.status === 'ready') written++;
    else failed++;
  }
  return { written, failed };
}
