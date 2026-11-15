import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { addDays, isDate, localParts } from '../lib/dates';
import { weightTrend } from '../lib/energy';
import type { GoalRow } from '../lib/goals';
import { HttpError } from '../lib/ids';
import { dailyTotals, intakesForDates } from '../lib/intake';
import { today } from './day';

export const exporter = new Hono<AppEnv>();

const MAX_DAYS = 731;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection from free-text fields.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');

const n = (v: number | undefined, dp = 1) => (v == null ? '' : Math.round(v * 10 ** dp) / 10 ** dp);

/** GET /api/export?format=csv|json&kind=items|daily&from=&to= */
exporter.get('/export', async (c) => {
  const user = c.get('user');
  const format = c.req.query('format') ?? 'csv';
  const kind = c.req.query('kind') ?? 'items';
  const to = c.req.query('to') ?? (await today(c.env.DB, user.id, user.timezone));
  const from = c.req.query('from') ?? addDays(to, -89);
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'from/to must be YYYY-MM-DD with from <= to');
  if (addDays(from, MAX_DAYS) < to) throw new HttpError(400, 'range is limited to two years per export');
  if (format !== 'csv' && format !== 'json') throw new HttpError(400, 'format must be csv or json');
  if (kind !== 'items' && kind !== 'daily') throw new HttpError(400, 'kind must be items or daily');

  const db = c.env.DB;
  const [goals, weights] = await Promise.all([
    db.prepare('SELECT id, type, target_value, unit, start_date, end_date, status FROM goal WHERE user_id = ? ORDER BY start_date').bind(user.id).all<GoalRow>(),
    db
      .prepare(`SELECT id, code, value, unit, effective_at, log_date FROM observation WHERE user_id = ? AND log_date BETWEEN ? AND ? ORDER BY effective_at`)
      .bind(user.id, addDays(from, -60), to)
      .all<{ id: string; code: string; value: number; unit: string; effective_at: string; log_date: string }>(),
  ]);

  if (format === 'json') {
    const intakes = await intakesForDates(db, user.id, from, to, true);
    const body = {
      exported_at: new Date().toISOString(),
      range: { from, to },
      patient: { id: user.id, timezone: user.timezone },
      nutrition_intake: intakes.map((i) => ({
        id: i.id,
        status: i.status,
        code: i.meal_type,
        occurrence_date_time: i.occurrence_at,
        occurrence_time_zone: i.occurrence_tz,
        log_date: i.log_date,
        recorded: i.recorded_at,
        source: i.source,
        note: i.note,
        raw_input_text: i.raw_input_text,
        confidence: i.confidence,
        estimator: { model_id: i.model_id, prompt_version: i.prompt_version, pipeline_version: i.pipeline_version },
        consumed_item: i.items.map((it) => ({
          id: it.id,
          nutrition_product: { id: it.food_id, source: it.food_source, fdc_id: it.fdc_id, display: it.display_name },
          amount: { value: it.amount_value, unit: it.amount_unit },
          grams: it.grams,
          confidence: it.confidence,
          estimation_method: it.estimation_method,
          estimated: it.estimated,
          total_intake: Object.entries(it.nutrients).map(([code, value]) => ({ nutrient: code, value })),
        })),
      })),
      goal: goals.results,
      observation: weights.results
        .filter((w) => w.log_date >= from)
        .map((w) => ({ id: w.id, code: { system: 'http://loinc.org', code: w.code }, value_quantity: { value: w.value, unit: w.unit }, effective_date_time: w.effective_at })),
    };
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="meals-${from}-to-${to}.json"` },
    });
  }

  let lines: string[];
  if (kind === 'items') {
    const intakes = await intakesForDates(db, user.id, from, to);
    lines = [csvRow(['date', 'time', 'meal_type', 'food', 'fdc_id', 'grams', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'confidence', 'source', 'status'])];
    for (const i of intakes) {
      const t = localParts(new Date(i.occurrence_at), i.occurrence_tz).time;
      for (const it of i.items)
        lines.push(
          csvRow([
            i.log_date,
            t,
            i.meal_type,
            it.display_name,
            it.fdc_id,
            n(it.grams),
            n(it.nutrients.ENERC_KCAL, 0),
            n(it.nutrients.PROCNT),
            n(it.nutrients.FAT),
            n(it.nutrients.CHOCDF),
            n(it.nutrients.FIBTG),
            n(it.confidence, 2),
            i.source,
            i.status,
          ]),
        );
    }
  } else {
    const days = await dailyTotals(db, user.id, from, to);
    const trend = new Map(weightTrend(weights.results.map((w) => ({ date: w.log_date, kg: w.value }))).map((t) => [t.date, t]));
    const goalOn = (type: string, d: string) =>
      goals.results.filter((g) => g.type === type && g.status !== 'cancelled' && g.start_date <= d && (!g.end_date || g.end_date >= d)).pop()?.target_value;
    lines = [csvRow(['date', 'meals', 'kcal', 'kcal_target', 'protein_g', 'protein_target_g', 'fat_g', 'carbs_g', 'fiber_g', 'weight_kg', 'weight_trend_kg'])];
    const byDate = new Map(days.map((d) => [d.date, d]));
    let lastTrend: number | undefined;
    for (const [d, t] of trend) if (d < from) lastTrend = t.trend;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const day = byDate.get(d);
      const w = trend.get(d);
      if (w) lastTrend = w.trend;
      lines.push(
        csvRow([
          d,
          day?.meals ?? 0,
          n(day?.totals.ENERC_KCAL, 0),
          goalOn('energy', d),
          n(day?.totals.PROCNT),
          goalOn('protein', d),
          n(day?.totals.FAT),
          n(day?.totals.CHOCDF),
          n(day?.totals.FIBTG),
          w?.kg,
          lastTrend,
        ]),
      );
    }
  }
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="meals-${kind}-${from}-to-${to}.csv"` },
  });
});
