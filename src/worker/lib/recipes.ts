/**
 * Recipes: a batch cooked once and eaten in portions over the week.
 *
 * A recipe is a `food` row (source 'recipe', owned by the user) plus its ingredients. Its
 * per-100 g nutrients are the ingredients' totals divided by the batch weight: the weighed
 * finished batch when known (cooking loses or gains water), otherwise the raw ingredients' weight.
 * Portions: "serving" (1/servings of the batch) and "batch" (the whole thing), so "a bowl of
 * chili", "1 serving" and "1/4 of the batch" all convert to grams.
 *
 * Logged portions copy the nutrients at log time (like every item), so editing a recipe changes
 * future logs only.
 */
import type { Env, User } from '../env';
import { getFood, normName, type FoodRecord } from './foods';
import { chunks, HttpError, newId } from './ids';
import { round } from './nutrients';
import { getIntake, resolveRef, validAmount, type ItemRef } from './intake';
import { toGrams, ucum, type Portion } from './units';

export interface RecipeInput {
  name: string;
  servings: number;
  /** Weight of the finished batch in grams, if weighed. */
  yield_grams?: number | null;
  /** Ingredients as food references, or `from_intake` to take them from a logged meal. */
  ingredients?: ItemRef[];
  /** Use this meal's items as the ingredients. */
  from_intake?: string;
  /** With from_intake: remove that meal from the log (it was the batch, not something eaten). Default true. */
  remove_intake?: boolean;
}

export interface Ingredient {
  id: string;
  food_id: string;
  food_name: string;
  display_name: string;
  amount_value: number;
  amount_unit: string;
  grams: number;
  kcal: number;
  protein: number;
}

export interface Recipe {
  id: string; // the recipe's food id
  name: string;
  servings: number;
  yield_grams: number | null;
  /** Weight the per-100 g values are based on: yield_grams, or the ingredients' total. */
  batch_grams: number;
  serving_grams: number;
  per_serving: Record<string, number>;
  per_100g: Record<string, number>;
  totals: Record<string, number>;
  ingredients: Ingredient[];
  times_logged: number;
  last_logged_at: string | null;
  updated_at: string;
}

interface Resolved {
  food: FoodRecord;
  display_name: string;
  amount: number;
  unit: string;
  grams: number;
}

const MAX_INGREDIENTS = 60;

export function validateRecipe(input: Pick<RecipeInput, 'name' | 'servings' | 'yield_grams'>) {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new HttpError(400, 'name is required');
  if (input.name.trim().length > 120) throw new HttpError(400, 'name is too long');
  if (typeof input.servings !== 'number' || !(input.servings > 0) || input.servings > 1000) throw new HttpError(400, 'servings must be a positive number');
  if (input.yield_grams != null && (typeof input.yield_grams !== 'number' || !(input.yield_grams > 0) || input.yield_grams > 200000))
    throw new HttpError(400, 'yield_grams must be a positive number');
}

async function resolveIngredients(env: Env, user: User, input: RecipeInput): Promise<Resolved[]> {
  if (input.from_intake) {
    const meal = await getIntake(env.DB, user.id, input.from_intake);
    if (!meal) throw new HttpError(404, 'intake not found');
    if (meal.status === 'preparation') throw new HttpError(409, 'that entry is still being read');
    const out: Resolved[] = [];
    for (const it of meal.items) {
      if (!it.food_id) continue;
      const food = await getFood(env.DB, user.id, it.food_id);
      if (food) out.push({ food, display_name: it.display_name, amount: it.amount_value, unit: it.amount_unit, grams: it.grams });
    }
    return out;
  }
  const refs = input.ingredients ?? [];
  if (refs.length > MAX_INGREDIENTS) throw new HttpError(400, `a recipe can have at most ${MAX_INGREDIENTS} ingredients`);
  const out: Resolved[] = [];
  for (const ref of refs) {
    validAmount(ref);
    const food = await resolveRef(env, user, ref);
    const grams = ref.grams ?? toGrams(ref.amount, ref.unit, food).grams;
    out.push({ food, display_name: ref.display_name || food.name, amount: ref.amount, unit: ucum(ref.unit), grams });
  }
  return out;
}

/** Ingredient totals, the batch weight and per-100 g values. */
export function computeRecipe(ingredients: { food: FoodRecord; grams: number }[], servings: number, yieldGrams?: number | null) {
  const totals: Record<string, number> = {};
  const units = new Map<string, { usdaId: number | null; unit: string }>();
  let rawGrams = 0;
  for (const ing of ingredients) {
    rawGrams += ing.grams;
    for (const n of ing.food.nutrients) {
      totals[n.code] = (totals[n.code] ?? 0) + (n.value * ing.grams) / 100;
      if (!units.has(n.code)) units.set(n.code, { usdaId: n.usdaId, unit: n.unit });
    }
  }
  const batchGrams = yieldGrams ?? rawGrams;
  const servingGrams = batchGrams / servings;
  const per100 = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, batchGrams > 0 ? (v * 100) / batchGrams : 0]));
  const portions: Portion[] = [
    { label: `serving (1/${round(servings, 2)} of the batch)`, unit: 'serving', amount: 1, grams: round(servingGrams, 1) },
    { label: 'whole batch', unit: 'batch', amount: 1, grams: round(batchGrams, 1) },
  ];
  return { totals, per100, units, rawGrams, batchGrams, servingGrams, portions };
}

const recipeExists = (db: D1Database, userId: string, nameNorm: string, exceptId?: string) =>
  db
    .prepare(
      `SELECT f.id FROM food f JOIN recipe r ON r.food_id = f.id
       WHERE r.user_id = ? AND r.archived = 0 AND f.name_norm = ? AND f.id != ? LIMIT 1`,
    )
    .bind(userId, nameNorm, exceptId ?? '')
    .first<{ id: string }>();

export async function assertRecipeNameFree(db: D1Database, userId: string, name: string, exceptId?: string) {
  if (await recipeExists(db, userId, normName(name), exceptId)) throw new HttpError(409, `you already have a recipe called "${name}"`);
}

/** Create a recipe, or replace an existing one's name, size and ingredients when `id` is given. */
export async function saveRecipe(env: Env, user: User, input: RecipeInput, id?: string): Promise<Recipe> {
  validateRecipe(input);
  const db = env.DB;
  if (id) {
    const existing = await db.prepare('SELECT food_id FROM recipe WHERE food_id = ? AND user_id = ? AND archived = 0').bind(id, user.id).first();
    if (!existing) throw new HttpError(404, 'recipe not found');
  }
  const name = input.name.trim();
  await assertRecipeNameFree(db, user.id, name, id);
  const ings = await resolveIngredients(env, user, input);
  if (!ings.length) throw new HttpError(400, 'a recipe needs at least one ingredient');
  const c = computeRecipe(ings, input.servings, input.yield_grams);
  if (!(c.batchGrams > 0)) throw new HttpError(400, 'the ingredients weigh nothing');

  const foodId = id ?? newId();
  const stmts: D1PreparedStatement[] = [];
  if (id) {
    stmts.push(
      db
        .prepare('UPDATE food SET name = ?, name_norm = ?, default_serving_grams = ?, portions_json = ? WHERE id = ? AND owner_user_id = ?')
        .bind(name, normName(name), round(c.servingGrams, 1), JSON.stringify(c.portions), foodId, user.id),
      db.prepare('DELETE FROM food_nutrient WHERE food_id = ?').bind(foodId),
      db.prepare('DELETE FROM recipe_ingredient WHERE recipe_food_id = ?').bind(foodId),
      db
        .prepare(`UPDATE recipe SET servings = ?, yield_grams = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE food_id = ?`)
        .bind(input.servings, input.yield_grams ?? null, foodId),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO food (id, source, name, name_norm, default_serving_grams, portions_json, owner_user_id)
           VALUES (?, 'recipe', ?, ?, ?, ?, ?)`,
        )
        .bind(foodId, name, normName(name), round(c.servingGrams, 1), JSON.stringify(c.portions), user.id),
      db.prepare('INSERT INTO recipe (food_id, user_id, servings, yield_grams) VALUES (?, ?, ?, ?)').bind(foodId, user.id, input.servings, input.yield_grams ?? null),
    );
  }
  for (const [code, value] of Object.entries(c.per100)) {
    const u = c.units.get(code)!;
    stmts.push(
      db
        .prepare('INSERT INTO food_nutrient (food_id, nutrient_code, usda_nutrient_id, value_per_100g, unit) VALUES (?, ?, ?, ?, ?)')
        .bind(foodId, code, u.usdaId, round(value, 4), u.unit),
    );
  }
  ings.forEach((ing, i) =>
    stmts.push(
      db
        .prepare(
          `INSERT INTO recipe_ingredient (id, recipe_food_id, position, food_id, display_name, amount_value, amount_unit, grams)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId(), foodId, i, ing.food.id, ing.display_name, ing.amount, ing.unit, round(ing.grams, 1)),
    ),
  );
  // The batch itself wasn't eaten: drop the meal it was logged as.
  if (input.from_intake && input.remove_intake !== false)
    stmts.push(
      db
        .prepare(`UPDATE nutrition_intake SET status = 'entered-in-error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`)
        .bind(input.from_intake, user.id),
    );
  await db.batch(stmts);
  return (await getRecipe(db, user.id, foodId))!;
}

interface RecipeRow {
  food_id: string;
  name: string;
  servings: number;
  yield_grams: number | null;
  updated_at: string;
  times_logged: number;
  last_logged_at: string | null;
}

const RECIPE_SELECT = `SELECT r.food_id, f.name, r.servings, r.yield_grams, r.updated_at,
    (SELECT COUNT(*) FROM consumed_item ci JOIN nutrition_intake i ON i.id = ci.intake_id
      WHERE ci.food_id = r.food_id AND i.status = 'completed') AS times_logged,
    (SELECT MAX(i.occurrence_at) FROM consumed_item ci JOIN nutrition_intake i ON i.id = ci.intake_id
      WHERE ci.food_id = r.food_id AND i.status = 'completed') AS last_logged_at
  FROM recipe r JOIN food f ON f.id = r.food_id`;

async function hydrate(db: D1Database, userId: string, rows: RecipeRow[]): Promise<Recipe[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.food_id);
  // A recipe's ingredients are all in one chunk, so their position order holds.
  const results = (
    await db.batch<{ id: string; recipe_food_id: string; food_id: string; display_name: string; amount_value: number; amount_unit: string; grams: number }>(
      chunks(ids).map((part) => db.prepare(`SELECT * FROM recipe_ingredient WHERE recipe_food_id IN (${part.map(() => '?').join(',')}) ORDER BY position`).bind(...part)),
    )
  ).flatMap((b) => b.results);
  const foods = new Map<string, FoodRecord>();
  for (const fid of new Set([...ids, ...results.map((r) => r.food_id)])) {
    const f = await getFood(db, userId, fid);
    if (f) foods.set(fid, f);
  }
  const per100 = (f: FoodRecord | undefined, code: string) => f?.nutrients.find((n) => n.code === code)?.value ?? 0;
  return rows.map((r) => {
    const ingRows = results.filter((i) => i.recipe_food_id === r.food_id);
    const ingredients: Ingredient[] = ingRows.map((i) => {
      const f = foods.get(i.food_id);
      return {
        id: i.id,
        food_id: i.food_id,
        food_name: f?.name ?? i.display_name,
        display_name: i.display_name,
        amount_value: i.amount_value,
        amount_unit: i.amount_unit,
        grams: i.grams,
        kcal: round((per100(f, 'ENERC_KCAL') * i.grams) / 100),
        protein: round((per100(f, 'PROCNT') * i.grams) / 100),
      };
    });
    const c = computeRecipe(
      ingRows.flatMap((i) => (foods.get(i.food_id) ? [{ food: foods.get(i.food_id)!, grams: i.grams }] : [])),
      r.servings,
      r.yield_grams,
    );
    const rounded = (o: Record<string, number>, k = 1) => Object.fromEntries(Object.entries(o).map(([code, v]) => [code, round(v * k)]));
    return {
      id: r.food_id,
      name: r.name,
      servings: r.servings,
      yield_grams: r.yield_grams,
      batch_grams: round(c.batchGrams, 1),
      serving_grams: round(c.servingGrams, 1),
      per_serving: rounded(c.totals, 1 / r.servings),
      per_100g: rounded(c.per100),
      totals: rounded(c.totals),
      ingredients,
      times_logged: r.times_logged,
      last_logged_at: r.last_logged_at,
      updated_at: r.updated_at,
    };
  });
}

export async function getRecipe(db: D1Database, userId: string, id: string): Promise<Recipe | null> {
  const row = await db.prepare(`${RECIPE_SELECT} WHERE r.food_id = ? AND r.user_id = ? AND r.archived = 0`).bind(id, userId).first<RecipeRow>();
  return row ? (await hydrate(db, userId, [row]))[0]! : null;
}

/** The user's recipes, most recently made or eaten first. */
export async function listRecipes(db: D1Database, userId: string): Promise<Recipe[]> {
  const { results } = await db.prepare(`${RECIPE_SELECT} WHERE r.user_id = ? AND r.archived = 0`).bind(userId).all<RecipeRow>();
  const recency = (r: RecipeRow) => (r.last_logged_at && r.last_logged_at > r.updated_at ? r.last_logged_at : r.updated_at);
  return hydrate(
    db,
    userId,
    results.sort((a, b) => recency(b).localeCompare(recency(a))),
  );
}

/** Names of the user's recipes, for the AI prompt (so "a bowl of my chili" uses the recipe). */
export async function recipeNames(db: D1Database, userId: string, limit = 40): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT f.name FROM recipe r JOIN food f ON f.id = r.food_id WHERE r.user_id = ? AND r.archived = 0 ORDER BY r.updated_at DESC LIMIT ?`)
    .bind(userId, limit)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Delete a recipe. Past logs still point at its food row, so it's archived rather than removed. */
export async function archiveRecipe(db: D1Database, userId: string, id: string): Promise<void> {
  const r = await db
    .prepare(`UPDATE recipe SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE food_id = ? AND user_id = ? AND archived = 0`)
    .bind(id, userId)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'recipe not found');
  await db.prepare('DELETE FROM food_alias WHERE user_id = ? AND food_id = ?').bind(userId, id).run();
}
