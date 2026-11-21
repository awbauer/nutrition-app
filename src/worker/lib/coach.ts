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
export const COACH_PROMPT_VERSION = 'coach-v2';
/** Failed nightly runs are retried on later cron ticks, this many times. */
const MAX_ATTEMPTS = 3;

const MACROS = ['ENERC_KCAL', 'PROCNT', 'CHOCDF', 'FAT', 'FIBTG', 'SUGAR', 'NA'] as const;
const MAIN_MEALS: MealType[] = ['breakfast', 'lunch', 'dinner'];
/** Meals bigger than this are outliers for "a typical breakfast" and for plans to repeat. */
const BIG_MEAL_KCAL = 1000;

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
  /** Share of calories from protein, fat and carbs (from grams: 4/9/4 kcal per g), per logged-day average. */
  macro_split: { day: MacroSplit | null; week: MacroSplit | null; previous_week: MacroSplit | null; month: MacroSplit | null };
  /** What the split is judged against: the user's own fat/carb targets when set, else the healthy ranges (AMDR). */
  macro_reference: {
    source: 'your targets' | 'derived from your calorie and protein targets' | 'healthy ranges';
    protein_pct: [number, number];
    fat_pct: [number, number];
    carbs_pct: [number, number];
    fat_g?: [number, number];
    carbs_g?: [number, number];
  };
  /** Problems and how many logged days in a row (ending on the reviewed day) they've held. */
  streaks: { issue: string; days_running: number; days_in_last_7_logged: number; detail: string }[];
  /** What moved: this week vs the week before, and the reviewed day vs this week. Only notable moves. */
  changes: { what: string; from: number; to: number; unit: string; compared: 'week vs previous week' | 'day vs this week' }[];
  /** Material for concrete plans, from the user's own log. */
  plans: {
    /** Typical protein per meal: the median, leaving out meals over BIG_MEAL_KCAL (brunches, feasts). */
    protein_per_meal_30d: Record<string, { median_g: number; meals: number; big_meals_left_out: number }>;
    /** Past meals that hit the protein bar, by meal type, best first (distinct item sets). */
    high_protein_meals: Record<string, { date: string; items: string[]; protein_g: number; kcal: number }[]>;
    protein_bar_g: number;
    top_fat_sources_week: { name: string; fat_g: number; times: number; fat_share_pct_of_week: number }[];
  };
  /** The last few reports' headlines and coaching, so the coach doesn't repeat itself. */
  previous_reports: { date: string; headline: string; coaching: string[] }[];
}

export interface MacroSplit {
  protein_pct: number;
  fat_pct: number;
  carbs_pct: number;
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
  fat: number | null;
  carbs: number | null;
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
  const meals = MAIN_MEALS.reduce((a, m) => a + (w.meal_days[m] ?? 0), 0) / (w.days_logged * 3) || 0;
  const matched = 1 - w.pct_items_ai_estimate / 100;
  const answered = w.meals_waiting_on_answers ? Math.max(0, 1 - w.meals_waiting_on_answers / 3) : 1;
  const prompt = w.median_log_delay_min == null ? 1 : w.median_log_delay_min <= 60 ? 1 : w.median_log_delay_min <= 240 ? 0.5 : 0.2;
  return Math.round(40 * days + 25 * Math.min(1, meals) + 15 * matched + 10 * answered + 10 * prompt);
}

/** Acceptable Macronutrient Distribution Ranges (US National Academies), % of calories. */
export const AMDR = { protein_pct: [10, 35] as [number, number], fat_pct: [20, 35] as [number, number], carbs_pct: [45, 65] as [number, number] };

export function macroSplit(t: Record<string, number | undefined>): MacroSplit | null {
  const p = (t.PROCNT ?? 0) * 4;
  const f = (t.FAT ?? 0) * 9;
  const c = (t.CHOCDF ?? 0) * 4;
  const sum = p + f + c;
  if (sum < 200) return null; // too little logged to mean anything
  return { protein_pct: Math.round((p / sum) * 100), fat_pct: Math.round((f / sum) * 100), carbs_pct: Math.round((c / sum) * 100) };
}

/** The ranges the split is judged against: ±5 points around the user's own fat/carb targets, else AMDR. */
/**
 * The ranges the split is judged against. Own fat/carb targets set the range (±5 points). Otherwise,
 * with calorie and protein targets, protein's share is fixed by them, fat keeps the healthy 20–35%,
 * and carbs are whatever is left: a high-protein plan doesn't get pushed toward carbs it doesn't need.
 * With no targets at all, the general healthy ranges (AMDR).
 */
export function macroReference(targets: Record<string, number>): Digest['macro_reference'] {
  const kcal = targets.ENERC_KCAL;
  const pctOf = (g: number | undefined, perG: number) => (kcal && g ? Math.round((g * perG * 100) / kcal) : null);
  const around = (v: number | null): [number, number] | null => (v == null ? null : [Math.max(0, v - 5), v + 5]);
  const p = pctOf(targets.PROCNT, 4);
  const f = pctOf(targets.FAT, 9);
  const c = pctOf(targets.CHOCDF, 4);
  const clamp = (r: [number, number]): [number, number] => [Math.max(0, Math.min(100, r[0])), Math.max(0, Math.min(100, r[1]))];
  let ref: Digest['macro_reference'];
  if (f != null || c != null) {
    const fat = around(f) ?? (p != null && c != null ? clamp([100 - p - c - 5, 100 - p - c + 5]) : AMDR.fat_pct);
    const carbs = around(c) ?? (p != null && f != null ? clamp([100 - p - f - 5, 100 - p - f + 5]) : AMDR.carbs_pct);
    ref = { source: 'your targets', protein_pct: around(p) ?? AMDR.protein_pct, fat_pct: fat, carbs_pct: carbs };
  } else if (p != null) {
    ref = {
      source: 'derived from your calorie and protein targets',
      protein_pct: around(p)!,
      fat_pct: AMDR.fat_pct,
      carbs_pct: clamp([100 - p - AMDR.fat_pct[1], 100 - p - AMDR.fat_pct[0]]),
    };
  } else {
    ref = { source: 'healthy ranges', protein_pct: AMDR.protein_pct, fat_pct: AMDR.fat_pct, carbs_pct: AMDR.carbs_pct };
  }
  if (kcal) {
    ref.fat_g = targets.FAT
      ? [Math.round(targets.FAT * 0.9), Math.round(targets.FAT * 1.1)]
      : [Math.round((kcal * ref.fat_pct[0]) / 900), Math.round((kcal * ref.fat_pct[1]) / 900)];
    ref.carbs_g = targets.CHOCDF
      ? [Math.round(targets.CHOCDF * 0.9), Math.round(targets.CHOCDF * 1.1)]
      : [Math.round((kcal * ref.carbs_pct[0]) / 400), Math.round((kcal * ref.carbs_pct[1]) / 400)];
  }
  return ref;
}

/** How many logged days in a row, ending on the reviewed day, `bad` held; and on how many of the last 7 logged days. */
export function streak(days: { date: string; meals: number; totals: Record<string, number> }[], reviewed: string, bad: (t: Record<string, number>) => boolean) {
  const logged = days.filter((d) => d.meals > 0 && d.date <= reviewed).sort((a, b) => b.date.localeCompare(a.date));
  let running = 0;
  for (const d of logged) {
    if (!bad(d.totals)) break;
    running++;
  }
  return { days_running: running, days_in_last_7_logged: logged.slice(0, 7).filter((d) => bad(d.totals)).length };
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
           (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'PROCNT') AS protein,
           (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'FAT') AS fat,
           (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'CHOCDF') AS carbs
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
  const previous_week = stats(7, 7);
  const ref = macroReference(targets);
  const split = {
    day: macroSplit(day.avg),
    week: macroSplit(week.avg),
    previous_week: macroSplit(previous_week.avg),
    month: macroSplit(month.avg),
  };

  // Problems that keep happening, counted over logged days.
  const kT = targets.ENERC_KCAL;
  const pT = targets.PROCNT;
  const fiberT = targets.FIBTG ?? 25;
  const streaks: Digest['streaks'] = [];
  const add = (issue: string, detail: string, bad: (t: Record<string, number>) => boolean) => {
    const s = streak(days, reviewed, bad);
    if (s.days_running >= 2 || s.days_in_last_7_logged >= 4) streaks.push({ issue, detail, ...s });
  };
  if (pT) add('protein short', `under 90% of the ${pT} g target`, (t) => (t.PROCNT ?? 0) < pT * 0.9);
  if (kT) add('calories over', `more than 10% over the ${kT} kcal target`, (t) => (t.ENERC_KCAL ?? 0) > kT * 1.1);
  add('fat-heavy', `fat above ${ref.fat_pct[1]}% of calories`, (t) => (macroSplit(t)?.fat_pct ?? 0) > ref.fat_pct[1]);
  // Carbs are the flexible remainder unless the user set a carbs target: only then is "low" a problem.
  const carbsT = targets.CHOCDF;
  if (carbsT) add('carbs low', `under 80% of the ${carbsT} g carbs target`, (t) => (t.CHOCDF ?? 0) < carbsT * 0.8);
  add('fiber low', `under ${Math.round(fiberT * 0.7)} g fiber`, (t) => (t.FIBTG ?? 0) < fiberT * 0.7);

  // Notable moves.
  const changes: Digest['changes'] = [];
  const moved = (what: string, from: number | undefined, to: number | undefined, unit: string, compared: Digest['changes'][number]['compared'], minAbs: number, minRel = 0.15) => {
    if (from == null || to == null) return;
    const d = to - from;
    if (Math.abs(d) >= minAbs && (from === 0 || Math.abs(d) / Math.abs(from) >= minRel)) changes.push({ what, from: r1(from), to: r1(to), unit, compared });
  };
  if (week.days_logged && previous_week.days_logged) {
    moved('calories per logged day', previous_week.avg.ENERC_KCAL, week.avg.ENERC_KCAL, 'kcal', 'week vs previous week', 150);
    moved('protein per logged day', previous_week.avg.PROCNT, week.avg.PROCNT, 'g', 'week vs previous week', 12);
    moved('fiber per logged day', previous_week.avg.FIBTG, week.avg.FIBTG, 'g', 'week vs previous week', 5);
    moved('fat share of calories', split.previous_week?.fat_pct, split.week?.fat_pct, '%', 'week vs previous week', 5, 0);
    moved('carb share of calories', split.previous_week?.carbs_pct, split.week?.carbs_pct, '%', 'week vs previous week', 5, 0);
  }
  moved('days logged', previous_week.days_logged, week.days_logged, 'days', 'week vs previous week', 2, 0);
  if (!partial && day.days_logged && week.days_logged > 1) {
    moved('protein', week.avg.PROCNT, day.avg.PROCNT, 'g', 'day vs this week', 20, 0.25);
    moved('calories', week.avg.ENERC_KCAL, day.avg.ENERC_KCAL, 'kcal', 'day vs this week', 400, 0.25);
    moved('fat share of calories', split.week?.fat_pct, split.day?.fat_pct, '%', 'day vs this week', 10, 0);
  }

  // Plans: protein per meal, past meals that hit the bar, this week's fat sources.
  const mealsById = new Map<string, { date: string; type: MealType; items: string[]; protein: number; kcal: number }>();
  for (const r of rows.filter((r) => r.status === 'completed' && r.food_id)) {
    const m = mealsById.get(r.intake_id) ?? { date: r.log_date, type: r.meal_type, items: [], protein: 0, kcal: 0 };
    m.items.push((r.display_name ?? '').trim());
    m.protein += r.protein ?? 0;
    m.kcal += r.kcal ?? 0;
    mealsById.set(r.intake_id, m);
  }
  const allMeals = [...mealsById.values()];
  const recent = allMeals.filter((m) => m.date >= month.from);
  const perMeal: Digest['plans']['protein_per_meal_30d'] = {};
  for (const t of [...MAIN_MEALS, 'snack' as MealType]) {
    const all = recent.filter((m) => m.type === t);
    const ms = all.filter((m) => m.kcal <= BIG_MEAL_KCAL);
    const med = median(ms.map((m) => m.protein * 10));
    if (ms.length && med != null) perMeal[t] = { median_g: med / 10, meals: ms.length, big_meals_left_out: all.length - ms.length };
  }
  // A meal that clearly moves the day toward target: a quarter of it (meals plus a snack), at least 25 g.
  const bar = pT ? Math.max(25, Math.round(pT / 4)) : 30;
  const high: Digest['plans']['high_protein_meals'] = {};
  for (const t of [...MAIN_MEALS, 'snack' as MealType]) {
    const seenSet = new Set<string>();
    const best = allMeals
      // Everyday meals to repeat: a 1,500 kcal brunch isn't a breakfast plan.
      .filter((m) => m.type === t && m.kcal <= BIG_MEAL_KCAL && m.protein >= (t === 'snack' ? bar / 2 : bar))
      .sort((a, b) => b.protein - a.protein)
      .filter((m) => {
        const key = [...m.items]
          .map((x) => x.toLowerCase())
          .sort()
          .join('|');
        if (seenSet.has(key)) return false;
        seenSet.add(key);
        return true;
      })
      .slice(0, 4)
      .map((m) => ({ date: m.date, items: m.items, protein_g: Math.round(m.protein), kcal: Math.round(m.kcal) }));
    if (best.length) high[t] = best;
  }
  const weekItems = rows.filter((r) => r.log_date >= week.from && r.status === 'completed' && r.food_id);
  const weekFat = weekItems.reduce((a, r) => a + (r.fat ?? 0), 0);
  const fatBy = new Map<string, { fat: number; times: number }>();
  for (const r of weekItems) {
    const k = (r.display_name ?? '').toLowerCase().trim();
    const f = fatBy.get(k) ?? { fat: 0, times: 0 };
    f.fat += r.fat ?? 0;
    f.times += 1;
    fatBy.set(k, f);
  }
  const fatSources = [...fatBy.entries()]
    .sort((a, b) => b[1].fat - a[1].fat)
    .slice(0, 5)
    .filter(([, f]) => f.fat >= 5)
    .map(([name, f]) => ({ name, fat_g: Math.round(f.fat), times: f.times, fat_share_pct_of_week: pct(f.fat, weekFat) }));

  // What the coach said recently.
  const { results: prev } = await db
    .prepare(
      `SELECT log_date, report_json FROM coach_report WHERE user_id = ? AND status = 'ready' AND partial = 0 AND log_date < ? AND log_date >= ?
       ORDER BY log_date DESC LIMIT 4`,
    )
    .bind(user.id, reviewed, addDays(reviewed, -14))
    .all<{ log_date: string; report_json: string }>();
  const previous_reports = prev.map((p) => {
    const r = JSON.parse(p.report_json) as CoachReport;
    return { date: p.log_date, headline: r.headline, coaching: r.coaching.map((c) => c.title) };
  });

  return {
    reviewed_date: reviewed,
    partial,
    weekday: new Date(`${reviewed}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    targets,
    day: { ...day, meals: [...dayMeals.values()] },
    week,
    previous_week,
    month,
    previous_month: stats(30, 30),
    top_foods_month: top,
    new_foods_week: firstSeen.results.map((r) => r.display_name),
    weight,
    logging_score: loggingScore(week),
    macro_split: split,
    macro_reference: ref,
    streaks,
    changes,
    plans: { protein_per_meal_30d: perMeal, high_protein_meals: high, protein_bar_g: bar, top_fat_sources_week: fatSources },
    previous_reports,
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

What else is in the digest:
- macro_split: % of calories from protein, fat and carbs (day, week, previous_week, month), and macro_reference: the
  ranges to judge them by. They come from the user's own targets (with calorie and protein targets, carbs are simply
  what's left after protein and fat), so judge against them, never against general carb guidelines: don't push carbs
  up unless they're under the user's own carbs target. A fat-heavy split that crowds out protein is often the real
  cause of "protein short": say so, with top_fat_sources_week by name.
- streaks: problems with how many logged days in a row they've held (days_running).
- changes: notable moves, this week vs the week before and the day vs this week.
- plans: typical protein per meal (the median over 30 days, leaving out meals over 1,000 kcal), past meals from THEIR log that hit protein_bar_g (by meal type), and this
  week's biggest fat sources. Use these for concrete plans: real meals they've eaten, by name, with their numbers.
- previous_reports: the headlines and coaching you gave in the last few days.

Choosing the headline, in this order:
1. A notable change (from "changes"; a new pattern; a streak that just ended) is the headline. Name what moved and by how much.
2. Otherwise, the most important ongoing problem, but never as a restatement. If it already appeared in
   previous_reports, or its days_running is 3 or more, escalate it into a plan: the specific meal where the gap is
   ("your breakfasts average 21 g") and 2-3 options from plans.high_protein_meals by name with their grams
   ("these three from your log hit 40 g: …"), or the fat sources to trim.
3. Never reuse the topic or wording of any previous_reports headline. Coaching items must not repeat earlier ones
   either; build on them (next step, a different meal, a different lever).

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

const STOP = new Set('a an and are as at be but by for from has have in is it its of on or so that the this to was were with you your yours today week day still again'.split(' '));
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9% ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

/** A recent headline this one mostly repeats (by shared words), if any. */
export function repeatedHeadline(headline: string, previous: { headline: string }[]): string | null {
  const a = words(headline);
  for (const p of previous) {
    const b = words(p.headline);
    const shared = [...a].filter((w) => b.has(w)).length;
    if (a.size && b.size && shared / Math.min(a.size, b.size) >= 0.5) return p.headline;
  }
  return null;
}

async function writeReport(env: Env, model: string, digest: Digest): Promise<CoachReport> {
  let last: unknown;
  let good: CoachReport | null = null; // a valid report whose headline repeated: better than nothing
  let feedback: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(digest) }, ...(feedback ? [{ role: 'user', content: feedback }] : [])];
    const r = await env.AI.run(
      model as Parameters<Ai['run']>[0],
      { messages, temperature: 0.4, response_format: { type: 'json_object' }, ...modelOptions(model) } as never,
      gatewayOpts(env) as never,
    );
    let report: CoachReport;
    try {
      report = validateReport(responseText(r));
    } catch (e) {
      last = e;
      if (!(e instanceof CoachOutputError) && !(e instanceof SyntaxError)) throw e;
      feedback = 'Your previous answer was not valid JSON matching the schema. Reply with the JSON object only.';
      continue;
    }
    // Saying the same thing every morning is noise: ask once more for a change or an escalated plan.
    const repeat = repeatedHeadline(report.headline, digest.previous_reports);
    if (!repeat || attempt === 2) return report;
    good = report;
    feedback = `Your headline "${report.headline}" repeats a recent one ("${repeat}"). Write the report again with a different headline: lead with a notable change, or turn the ongoing problem into a concrete plan using plans (meals from their own log, by name, with grams). Same JSON format.`;
  }
  if (good) return good;
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
