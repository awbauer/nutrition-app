import type { Env, User } from '../env';
import { localParts, logDate, mealTypeForTime } from './dates';
import { sourceSql, getFood, resolveFatSecret, resolveFdc, type FoodRecord } from './foods';
import { HttpError, newId, nowIso } from './ids';
import { round, sumNutrients } from './nutrients';
import { getSettings } from './settings';
import type { MatchInfo } from './matcher';
import { toGrams, ucum } from './units';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type Source = 'photo' | 'voice' | 'text' | 'manual' | 'copy';
export type Status = 'preparation' | 'in-progress' | 'completed' | 'entered-in-error';
export type EstimationMethod = 'photo-estimate' | 'described' | 'weighed' | 'label';

export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const STATUSES: Status[] = ['preparation', 'in-progress', 'completed', 'entered-in-error'];

/** An item ready to persist: a resolved food plus amount. */
export interface ResolvedItem {
  food: FoodRecord;
  display_name?: string;
  amount: number;
  unit: string;
  grams?: number; // explicit grams override conversion
  confidence: number;
  method: EstimationMethod;
  estimated?: boolean;
  /** How the food was matched (AI-logged items); shown and editable in the item sheet. */
  match?: MatchInfo | null;
}

/** Item reference as sent by clients. */
export interface ItemRef {
  food_id?: string;
  fdc_id?: string | number;
  /** A FatSecret food id (from a search result or match candidate). */
  fatsecret_id?: string | number;
  amount: number;
  unit: string;
  grams?: number;
  display_name?: string;
  estimation_method?: EstimationMethod;
}

export async function resolveRef(env: Env, user: User, ref: ItemRef): Promise<FoodRecord> {
  if (ref.food_id) {
    const f = await getFood(env.DB, user.id, ref.food_id);
    if (!f) throw new HttpError(404, `food ${ref.food_id} not found`);
    return f;
  }
  if (ref.fdc_id != null) return resolveFdc(env, String(ref.fdc_id));
  if (ref.fatsecret_id != null) return resolveFatSecret(env, String(ref.fatsecret_id));
  throw new HttpError(400, 'item needs food_id, fdc_id or fatsecret_id');
}

export function validAmount(ref: { amount: unknown; unit: unknown; grams?: unknown }): void {
  if (typeof ref.amount !== 'number' || !(ref.amount > 0) || ref.amount > 100000) throw new HttpError(400, 'amount must be a positive number');
  if (typeof ref.unit !== 'string' || !ref.unit.trim()) throw new HttpError(400, 'unit is required');
  // Explicit grams override the conversion, so they need the same checks (negative grams made negative kcal).
  if (ref.grams != null && (typeof ref.grams !== 'number' || !(ref.grams > 0) || ref.grams > 100000)) throw new HttpError(400, 'grams must be a positive number');
}

/** Statements inserting one consumed_item and its nutrient totals. */
export function itemStatements(db: D1Database, userId: string, intakeId: string, item: ResolvedItem, position: number, id = newId()) {
  const grams = item.grams ?? toGrams(item.amount, item.unit, item.food).grams;
  const stmts = [
    db
      .prepare(
        `INSERT INTO consumed_item (id, intake_id, user_id, position, food_id, display_name, amount_value, amount_unit, grams, confidence, estimation_method, estimated, match_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        intakeId,
        userId,
        position,
        item.food.id,
        item.display_name || item.food.name,
        item.amount,
        ucum(item.unit),
        round(grams, 1),
        round(item.confidence, 2),
        item.method,
        item.estimated || item.food.source === 'estimate' ? 1 : 0,
        item.match ? JSON.stringify(item.match) : null,
      ),
  ];
  for (const n of item.food.nutrients) {
    stmts.push(
      db
        .prepare('INSERT INTO intake_nutrient (consumed_item_id, nutrient_code, usda_nutrient_id, value, unit) VALUES (?, ?, ?, ?, ?)')
        .bind(id, n.code, n.usdaId, round((n.value * grams) / 100, 3), n.unit),
    );
  }
  return stmts;
}

export const refreshConfidence = (db: D1Database, intakeId: string) =>
  db
    .prepare(
      `UPDATE nutrition_intake SET confidence = (SELECT MIN(confidence) FROM consumed_item WHERE intake_id = ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .bind(intakeId, intakeId);

export interface NewIntake {
  meal_type?: MealType;
  occurrence_at?: string;
  source: Source;
  status?: Status;
  note?: string | null;
  raw_input_text?: string | null;
  media_r2_key?: string | null;
  /** Photos, in order (see intake_photo). */
  photo_keys?: string[];
  model_id?: string | null;
  prompt_version?: string | null;
  pipeline_version?: string | null;
  pending_json?: string | null;
}

export async function intakeTiming(db: D1Database, user: User, occurrenceAt?: string, mealType?: MealType) {
  const settings = await getSettings(db, user.id);
  const at = occurrenceAt ? new Date(occurrenceAt) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'occurrence_at is not a valid date');
  if (mealType && !MEAL_TYPES.includes(mealType)) throw new HttpError(400, 'invalid meal_type');
  const iso = at.toISOString();
  return {
    occurrence_at: iso,
    occurrence_tz: user.timezone,
    log_date: logDate(iso, user.timezone, settings.day_cutoff),
    meal_type: mealType ?? mealTypeForTime(localParts(at, user.timezone).minutes),
  };
}

/** Create an intake with already-resolved items in one batch. Returns the intake id. */
export async function createIntake(env: Env, user: User, data: NewIntake, items: ResolvedItem[]): Promise<string> {
  const id = newId();
  const t = await intakeTiming(env.DB, user, data.occurrence_at, data.meal_type);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO nutrition_intake (id, user_id, status, meal_type, occurrence_at, occurrence_tz, log_date, recorded_at, source,
        media_r2_key, raw_input_text, note, model_id, prompt_version, pipeline_version, pending_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      user.id,
      data.status ?? 'completed',
      t.meal_type,
      t.occurrence_at,
      t.occurrence_tz,
      t.log_date,
      nowIso(),
      data.source,
      data.media_r2_key ?? null,
      data.raw_input_text ?? null,
      data.note ?? null,
      data.model_id ?? null,
      data.prompt_version ?? null,
      data.pipeline_version ?? null,
      data.pending_json ?? null,
    ),
  ];
  (data.photo_keys ?? []).forEach((k, i) => stmts.push(env.DB.prepare('INSERT INTO intake_photo (intake_id, position, r2_key) VALUES (?, ?, ?)').bind(id, i, k)));
  items.forEach((it, i) => stmts.push(...itemStatements(env.DB, user.id, id, it, i)));
  stmts.push(refreshConfidence(env.DB, id));
  await env.DB.batch(stmts);
  return id;
}

// ---------- reads ----------

export interface ItemView {
  id: string;
  food_id: string | null;
  display_name: string;
  amount_value: number;
  amount_unit: string;
  grams: number;
  confidence: number;
  estimation_method: EstimationMethod;
  estimated: boolean;
  fdc_id: string | null;
  food_source: string | null;
  food_name: string | null;
  food_data_type: string | null;
  /** Candidates exist: the item sheet can offer other matches. */
  has_match_details: boolean;
  /** kcal/100 g of the chosen food is far from the model's estimate: worth checking. */
  check_match: boolean;
  nutrients: Record<string, number>;
}

export interface IntakeView {
  id: string;
  status: Status;
  meal_type: MealType;
  occurrence_at: string;
  occurrence_tz: string;
  log_date: string;
  recorded_at: string;
  source: Source;
  note: string | null;
  raw_input_text: string | null;
  has_media: boolean;
  /** Number of photos (GET /api/intake/:id/photos/:n). */
  photo_count: number;
  confidence: number | null;
  model_id: string | null;
  prompt_version: string | null;
  pipeline_version: string | null;
  items: ItemView[];
  totals: Record<string, number>;
  pending?: unknown;
}

interface IntakeRow extends Omit<IntakeView, 'items' | 'totals' | 'has_media' | 'photo_count' | 'pending'> {
  media_r2_key: string | null;
  photo_count: number;
  pending_json: string | null;
}

export async function loadIntakes(db: D1Database, rows: IntakeRow[]): Promise<IntakeView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const [items, nutrients] = await db.batch([
    db
      .prepare(
        `SELECT ci.*, f.source_id AS fdc_source_id, ${sourceSql('f')} AS food_source, f.name AS food_name, f.data_type AS food_data_type,
           (SELECT value_per_100g FROM food_nutrient fn WHERE fn.food_id = ci.food_id AND fn.nutrient_code = 'ENERC_KCAL') AS food_kcal100
         FROM consumed_item ci
         LEFT JOIN food f ON f.id = ci.food_id WHERE ci.intake_id IN (${ph}) ORDER BY ci.position`,
      )
      .bind(...ids),
    db
      .prepare(
        `SELECT n.consumed_item_id, n.nutrient_code, n.value FROM intake_nutrient n
         JOIN consumed_item ci ON ci.id = n.consumed_item_id WHERE ci.intake_id IN (${ph})`,
      )
      .bind(...ids),
  ]);
  const nByItem = new Map<string, { nutrient_code: string; value: number }[]>();
  for (const n of nutrients!.results as { consumed_item_id: string; nutrient_code: string; value: number }[]) {
    const l = nByItem.get(n.consumed_item_id) ?? [];
    l.push(n);
    nByItem.set(n.consumed_item_id, l);
  }
  const iByIntake = new Map<string, ItemView[]>();
  for (const r of items!.results as Record<string, unknown>[]) {
    const view: ItemView = {
      id: r.id as string,
      food_id: r.food_id as string | null,
      display_name: r.display_name as string,
      amount_value: r.amount_value as number,
      amount_unit: r.amount_unit as string,
      grams: r.grams as number,
      confidence: r.confidence as number,
      estimation_method: r.estimation_method as EstimationMethod,
      estimated: r.estimated === 1,
      fdc_id: r.food_source === 'usda' ? (r.fdc_source_id as string) : null,
      food_source: (r.food_source as string) ?? null,
      food_name: (r.food_name as string) ?? null,
      food_data_type: (r.food_data_type as string) ?? null,
      has_match_details: !!r.match_json,
      check_match: needsCheck(r.match_json as string | null, r.food_kcal100 as number | null),
      nutrients: sumNutrients(nByItem.get(r.id as string) ?? []),
    };
    const l = iByIntake.get(r.intake_id as string) ?? [];
    l.push(view);
    iByIntake.set(r.intake_id as string, l);
  }
  return rows.map(({ media_r2_key, pending_json, photo_count, ...r }) => {
    const its = iByIntake.get(r.id) ?? [];
    const totals: Record<string, number> = {};
    for (const it of its) for (const [k, v] of Object.entries(it.nutrients)) totals[k] = round((totals[k] ?? 0) + v);
    return {
      ...r,
      has_media: !!media_r2_key || photo_count > 0,
      photo_count,
      items: its,
      totals,
      ...(pending_json ? { pending: publicPending(pending_json) } : {}),
    };
  });
}

/** Clarifying questions as the client sees them (option effects stay server-side). */
function publicPending(json: string) {
  const p = JSON.parse(json) as {
    questions?: { id: string; item_index: number; text: string; options: string[]; default: string }[];
    error?: string;
    merge?: unknown;
    job?: { merge?: unknown; recipe?: { name: string } };
    recipe_saved?: { id: string; name: string };
  };
  return {
    questions: (p.questions ?? []).map(({ id, item_index, text, options, default: d }) => ({ id, item_index, text, options, default: d })),
    ...(p.error ? { error: p.error } : {}),
    // This entry will join an existing meal once it's finished (see merge.ts).
    ...(p.merge || p.job?.merge ? { adding_to_meal: true } : {}),
    // A batch being saved as a recipe: its name while it's read, then the saved recipe.
    ...(p.job?.recipe ? { recipe: p.job.recipe.name } : {}),
    ...(p.recipe_saved ? { recipe_saved: p.recipe_saved } : {}),
  };
}

/** Flag items whose matched food is far (2x either way) from the model's own kcal estimate. */
function needsCheck(matchJson: string | null, kcal100: number | null): boolean {
  if (!matchJson || kcal100 == null) return false;
  try {
    const m = JSON.parse(matchJson) as MatchInfo;
    if (m.via === 'alias' || m.via === 'custom' || m.estimate_kcal_100g == null || m.estimate_kcal_100g <= 0) return false;
    const ratio = (kcal100 + 10) / (m.estimate_kcal_100g + 10);
    return ratio > 2 || ratio < 0.5;
  } catch {
    return false;
  }
}

const INTAKE_COLS = `id, status, meal_type, occurrence_at, occurrence_tz, log_date, recorded_at, source, note, raw_input_text,
  media_r2_key, confidence, model_id, prompt_version, pipeline_version, pending_json,
  (SELECT COUNT(*) FROM intake_photo p WHERE p.intake_id = nutrition_intake.id) AS photo_count`;

export async function getIntake(db: D1Database, userId: string, id: string): Promise<IntakeView | null> {
  const row = await db.prepare(`SELECT ${INTAKE_COLS} FROM nutrition_intake WHERE id = ? AND user_id = ?`).bind(id, userId).first<IntakeRow>();
  return row ? (await loadIntakes(db, [row]))[0]! : null;
}

export async function intakesForDates(db: D1Database, userId: string, from: string, to: string, includeErrors = false) {
  const { results } = await db
    .prepare(
      `SELECT ${INTAKE_COLS} FROM nutrition_intake WHERE user_id = ? AND log_date BETWEEN ? AND ?
       ${includeErrors ? '' : "AND status != 'entered-in-error'"} ORDER BY occurrence_at`,
    )
    .bind(userId, from, to)
    .all<IntakeRow>();
  return loadIntakes(db, results);
}

/** Per-day completed totals for a date range. */
export async function dailyTotals(db: D1Database, userId: string, from: string, to: string) {
  const { results } = await db
    .prepare(
      `SELECT i.log_date, n.nutrient_code, SUM(n.value) AS value, COUNT(DISTINCT i.id) AS meals
       FROM nutrition_intake i
       JOIN consumed_item ci ON ci.intake_id = i.id
       JOIN intake_nutrient n ON n.consumed_item_id = ci.id
       WHERE i.user_id = ? AND i.status = 'completed' AND i.log_date BETWEEN ? AND ?
       GROUP BY i.log_date, n.nutrient_code`,
    )
    .bind(userId, from, to)
    .all<{ log_date: string; nutrient_code: string; value: number }>();
  const counts = await db
    .prepare(
      `SELECT log_date, COUNT(*) AS meals FROM nutrition_intake
       WHERE user_id = ? AND status = 'completed' AND log_date BETWEEN ? AND ? GROUP BY log_date`,
    )
    .bind(userId, from, to)
    .all<{ log_date: string; meals: number }>();
  const days = new Map<string, { date: string; meals: number; totals: Record<string, number> }>();
  for (const c of counts.results) days.set(c.log_date, { date: c.log_date, meals: c.meals, totals: {} });
  for (const r of results) {
    const d = days.get(r.log_date) ?? { date: r.log_date, meals: 0, totals: {} };
    d.totals[r.nutrient_code] = round(r.value);
    days.set(r.log_date, d);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
