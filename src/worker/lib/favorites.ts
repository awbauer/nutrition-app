/**
 * Starred foods: something you log often, saved with the name and amount you log it by,
 * so it's one tap from Quick add. Keyed by name, like the quick list.
 */
import type { ModelItem } from './ai';
import { getFood, normName, type FoodRecord } from './foods';
import { localCandidate, type MatchResult } from './matcher';
import { HttpError, newId } from './ids';
import { normaliseUnit, toGrams } from './units';

export interface Favorite {
  id: string;
  name: string;
  food_id: string;
  amount: number;
  unit: string;
  grams: number;
  kcal: number | null; // for that amount
}

const norm = (s: string) => s.trim().toLowerCase();

export async function listFavorites(db: D1Database, userId: string): Promise<Favorite[]> {
  const { results } = await db
    .prepare(
      `SELECT fv.id, fv.name, fv.food_id, fv.amount, fv.unit, f.name AS food_name, f.category, f.portions_json, f.default_serving_grams,
         (SELECT value_per_100g FROM food_nutrient n WHERE n.food_id = f.id AND n.nutrient_code = 'ENERC_KCAL') AS kcal100
       FROM favorite_food fv JOIN food f ON f.id = fv.food_id
       WHERE fv.user_id = ? AND f.archived_at IS NULL
       ORDER BY fv.created_at`,
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      food_id: string;
      amount: number;
      unit: string;
      food_name: string;
      category: string | null;
      portions_json: string;
      default_serving_grams: number | null;
      kcal100: number | null;
    }>();
  return results.map((r) => {
    const grams = toGrams(r.amount, r.unit, {
      name: [r.name, r.food_name],
      category: r.category,
      portions: JSON.parse(r.portions_json),
      default_serving_grams: r.default_serving_grams,
    }).grams;
    return {
      id: r.id,
      name: r.name,
      food_id: r.food_id,
      amount: r.amount,
      unit: r.unit,
      grams: Math.round(grams * 10) / 10,
      kcal: r.kcal100 == null ? null : Math.round((r.kcal100 * grams) / 100),
    };
  });
}

/** Star a food; starring the same name again replaces its food and amount. */
export async function addFavorite(db: D1Database, userId: string, input: { name?: unknown; food_id?: unknown; amount?: unknown; unit?: unknown }): Promise<Favorite> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const amount = Number(input.amount);
  const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
  if (!name || name.length > 200) throw new HttpError(400, 'name is required');
  if (typeof input.food_id !== 'string' || !(await getFood(db, userId, input.food_id))) throw new HttpError(400, 'unknown food');
  if (!(amount > 0) || !unit) throw new HttpError(400, 'amount and unit are required');
  await db
    .prepare(
      `INSERT INTO favorite_food (id, user_id, name, name_norm, food_id, amount, unit) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, name_norm) DO UPDATE SET name = excluded.name, food_id = excluded.food_id, amount = excluded.amount, unit = excluded.unit`,
    )
    .bind(newId(), userId, name, norm(name), input.food_id, amount, unit)
    .run();
  const fav = (await listFavorites(db, userId)).find((f) => norm(f.name) === norm(name));
  if (!fav) throw new HttpError(500, 'favorite was not saved');
  return fav;
}

export async function removeFavorite(db: D1Database, userId: string, id: string): Promise<void> {
  const r = await db.prepare('DELETE FROM favorite_food WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'favorite not found');
}

/** Units that state an exact amount: "40 g of usual nuts" keeps its 40 g. Anything else counts portions. */
const EXPLICIT = new Set(['g', 'kg', 'mg', 'oz', 'lb', 'ml', 'l', 'fl oz', 'cup', 'tbsp', 'tsp']);

/**
 * Items the model named after a favorite ("usual nuts", unit "favorite") become that favorite: its
 * food, and its saved amount times the number of portions. An explicit weight or volume is kept.
 */
export async function applyFavorites(db: D1Database, userId: string, items: ModelItem[]): Promise<ModelItem[]> {
  if (!items.length) return items;
  const favs = await listFavorites(db, userId);
  if (!favs.length) return items;
  const byName = new Map(favs.map((f) => [normName(f.name), f]));
  return Promise.all(
    items.map(async (it) => {
      const fav = byName.get(normName(it.name));
      if (!fav) return it;
      const food = await getFood(db, userId, fav.food_id);
      if (!food) return it;
      const explicit = EXPLICIT.has(normaliseUnit(it.unit));
      const { grams: _g, ...rest } = it; // the saved portion sets the weight, not the model's guess
      return {
        ...(explicit ? it : rest),
        name: fav.name,
        ...(explicit ? {} : { amount: Math.round(fav.amount * (it.amount > 0 ? it.amount : 1) * 1000) / 1000, unit: fav.unit }),
        confidence: Math.max(it.confidence, explicit ? it.confidence : 0.95),
        favorite: { food, name: fav.name },
      };
    }),
  );
}

/** The match for a favorite: no search, the saved food. */
export function favoriteMatch(f: { food: FoodRecord; name: string }): MatchResult {
  return {
    food: f.food,
    via: 'favorite',
    match: { query: f.name, via: 'favorite', estimate_kcal_100g: null, candidates: [localCandidate(f.food, 9, ['your favorite'])], chosen: f.food.id },
    matchConfidence: 1,
  };
}
