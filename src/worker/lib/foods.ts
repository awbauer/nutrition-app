import type { Env } from '../env';
import { HttpError, newId } from './ids';
import { NUTRIENT_BY_CODE, type NutrientValue } from './nutrients';
import type { Portion } from './units';
import { UsdaClient, type NormalisedFood } from './usda';

export interface FoodRecord {
  id: string;
  source: 'usda' | 'off' | 'custom' | 'recipe' | 'estimate';
  source_id: string | null;
  name: string;
  brand: string | null;
  data_type: string | null;
  default_serving_grams: number | null;
  owner_user_id: string | null;
  portions: Portion[];
  nutrients: NutrientValue[]; // per 100 g
}

export const normName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function usdaClient(env: Env, fetcher?: typeof fetch): UsdaClient {
  if (!env.USDA_API_KEY) throw new HttpError(503, 'USDA_API_KEY is not configured');
  return new UsdaClient(env.USDA_API_KEY, fetcher);
}

interface FoodRow {
  id: string;
  source: FoodRecord['source'];
  source_id: string | null;
  name: string;
  brand: string | null;
  data_type: string | null;
  default_serving_grams: number | null;
  owner_user_id: string | null;
  portions_json: string;
}

async function hydrate(db: D1Database, rows: FoodRow[]): Promise<FoodRecord[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { results } = await db
    .prepare(
      `SELECT food_id, nutrient_code, usda_nutrient_id, value_per_100g, unit FROM food_nutrient
       WHERE food_id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<{ food_id: string; nutrient_code: string; usda_nutrient_id: number | null; value_per_100g: number; unit: string }>();
  const byFood = new Map<string, NutrientValue[]>();
  for (const n of results) {
    const list = byFood.get(n.food_id) ?? [];
    list.push({ code: n.nutrient_code, usdaId: n.usda_nutrient_id, value: n.value_per_100g, unit: n.unit });
    byFood.set(n.food_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    source_id: r.source_id,
    name: r.name,
    brand: r.brand,
    data_type: r.data_type,
    default_serving_grams: r.default_serving_grams,
    owner_user_id: r.owner_user_id,
    portions: JSON.parse(r.portions_json) as Portion[],
    nutrients: byFood.get(r.id) ?? [],
  }));
}

const FOOD_COLS = 'id, source, source_id, name, brand, data_type, default_serving_grams, owner_user_id, portions_json';

/** Load a food visible to the user (shared, or owned by them). */
export async function getFood(db: D1Database, userId: string, id: string): Promise<FoodRecord | null> {
  const row = await db
    .prepare(`SELECT ${FOOD_COLS} FROM food WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)`)
    .bind(id, userId)
    .first<FoodRow>();
  return row ? (await hydrate(db, [row]))[0]! : null;
}

export async function findCachedBySource(db: D1Database, source: string, sourceId: string): Promise<FoodRecord | null> {
  const row = await db
    .prepare(`SELECT ${FOOD_COLS} FROM food WHERE source = ? AND source_id = ? AND owner_user_id IS NULL`)
    .bind(source, sourceId)
    .first<FoodRow>();
  return row ? (await hydrate(db, [row]))[0]! : null;
}

/** Insert or refresh a database food (shared) and its nutrients. Returns the stored record. */
export async function cacheFood(db: D1Database, f: NormalisedFood | ExternalFood): Promise<FoodRecord> {
  const existing = await db
    .prepare('SELECT id FROM food WHERE source = ? AND source_id = ? AND owner_user_id IS NULL')
    .bind(f.source, f.sourceId)
    .first<{ id: string }>();
  const id = existing?.id ?? newId();
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    stmts.push(
      db
        .prepare('UPDATE food SET name = ?, name_norm = ?, brand = ?, data_type = ?, default_serving_grams = ?, portions_json = ? WHERE id = ?')
        .bind(f.name, normName(f.name), f.brand, f.dataType, f.defaultServingGrams, JSON.stringify(f.portions), id),
      db.prepare('DELETE FROM food_nutrient WHERE food_id = ?').bind(id),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO food (id, source, source_id, name, name_norm, brand, data_type, default_serving_grams, portions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, f.source, f.sourceId, f.name, normName(f.name), f.brand, f.dataType, f.defaultServingGrams, JSON.stringify(f.portions)),
    );
  }
  for (const n of f.nutrients) {
    stmts.push(
      db
        .prepare('INSERT INTO food_nutrient (food_id, nutrient_code, usda_nutrient_id, value_per_100g, unit) VALUES (?, ?, ?, ?, ?)')
        .bind(id, n.code, n.usdaId, n.value, n.unit),
    );
  }
  await db.batch(stmts);
  return (await getFood(db, '', id))!;
}

/** Non-USDA external food (Open Food Facts) or a model estimate, same shape as NormalisedFood. */
export interface ExternalFood {
  source: 'off' | 'estimate';
  sourceId: string;
  name: string;
  brand: string | null;
  dataType: string | null;
  defaultServingGrams: number | null;
  portions: Portion[];
  nutrients: NutrientValue[];
}

/** Resolve an FDC id via the cache, fetching full detail (with foodPortions) on a miss. */
export async function resolveFdc(env: Env, fdcId: string, fetcher?: typeof fetch): Promise<FoodRecord> {
  const cached = await findCachedBySource(env.DB, 'usda', fdcId);
  if (cached && cached.portions.length) return cached;
  const detail = await usdaClient(env, fetcher).food(fdcId);
  return cacheFood(env.DB, detail);
}

/** Token-based fuzzy search over the user's custom foods and the shared cache. */
export async function searchLocal(db: D1Database, userId: string, q: string, limit = 10): Promise<FoodRecord[]> {
  const tokens = normName(q).split(' ').filter((t) => t.length > 1).slice(0, 5);
  if (!tokens.length) return [];
  const where = tokens.map(() => 'name_norm LIKE ?').join(' AND ');
  const { results } = await db
    .prepare(
      `SELECT ${FOOD_COLS} FROM food
       WHERE (owner_user_id IS NULL OR owner_user_id = ?) AND ${where}
       ORDER BY (owner_user_id IS NOT NULL) DESC, (source = 'recipe') DESC, length(name) ASC
       LIMIT ?`,
    )
    .bind(userId, ...tokens.map((t) => `%${t}%`), limit)
    .all<FoodRow>();
  return hydrate(db, results);
}

/** Exact (normalised) name match in the user's own custom foods and recipes. */
export async function exactCustom(db: D1Database, userId: string, name: string): Promise<FoodRecord | null> {
  const row = await db
    .prepare(`SELECT ${FOOD_COLS} FROM food WHERE owner_user_id = ? AND name_norm = ? LIMIT 1`)
    .bind(userId, normName(name))
    .first<FoodRow>();
  return row ? (await hydrate(db, [row]))[0]! : null;
}

export interface CustomFoodInput {
  name: string;
  brand?: string | null;
  source?: 'custom' | 'recipe';
  serving_grams?: number | null;
  serving_label?: string | null;
  /** Nutrient values per 100 g, keyed by INFOODS code. */
  per_100g?: Record<string, number>;
  /** Alternative: values per serving (requires serving_grams). */
  per_serving?: Record<string, number>;
}

export async function createCustomFood(db: D1Database, userId: string, input: CustomFoodInput): Promise<FoodRecord> {
  if (!input.name?.trim()) throw new HttpError(400, 'name is required');
  let per100 = input.per_100g;
  if (!per100 && input.per_serving) {
    if (!input.serving_grams || input.serving_grams <= 0) throw new HttpError(400, 'serving_grams is required with per_serving');
    per100 = Object.fromEntries(Object.entries(input.per_serving).map(([k, v]) => [k, (v * 100) / input.serving_grams!]));
  }
  if (!per100) throw new HttpError(400, 'per_100g or per_serving is required');
  const id = newId();
  const portions: Portion[] = input.serving_grams
    ? [{ label: input.serving_label || 'serving', unit: 'serving', amount: 1, grams: input.serving_grams }]
    : [];
  const stmts = [
    db
      .prepare(
        `INSERT INTO food (id, source, name, name_norm, brand, default_serving_grams, portions_json, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.source ?? 'custom', input.name.trim(), normName(input.name), input.brand ?? null, input.serving_grams ?? null, JSON.stringify(portions), userId),
  ];
  for (const [code, value] of Object.entries(per100)) {
    const def = NUTRIENT_BY_CODE.get(code);
    if (!def || !Number.isFinite(value)) continue;
    stmts.push(
      db
        .prepare('INSERT INTO food_nutrient (food_id, nutrient_code, usda_nutrient_id, value_per_100g, unit) VALUES (?, ?, ?, ?, ?)')
        .bind(id, code, def.usdaId, value, def.unit),
    );
  }
  await db.batch(stmts);
  return (await getFood(db, userId, id))!;
}
