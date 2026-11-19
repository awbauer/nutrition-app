/**
 * Recent and frequent foods for one-tap logging.
 * Items are grouped by what the user called them ("salmon sashimi"), so repeat logs of the
 * same thing count together even when each AI estimate created its own food row. Each entry
 * carries the latest food, amount and unit used for that name.
 */
import type { MealType } from './intake';

export interface QuickFood {
  name: string; // the user's wording
  food_id: string;
  food_name: string;
  amount: number;
  unit: string;
  grams: number;
  kcal: number | null; // for that amount
  count: number; // times logged in the window
  last_at: string;
}

const WINDOW_DAYS = 90;
const LIMIT = 10;

export async function quickFoods(db: D1Database, userId: string, mealType: MealType | null, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT ci.display_name, ci.food_id, ci.amount_value, ci.amount_unit, ci.grams, i.occurrence_at, i.meal_type, f.name AS food_name,
         (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'ENERC_KCAL') AS kcal
       FROM consumed_item ci
       JOIN nutrition_intake i ON i.id = ci.intake_id
       JOIN food f ON f.id = ci.food_id
       WHERE ci.user_id = ? AND i.status = 'completed' AND i.occurrence_at >= ?
         AND f.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipe r WHERE r.food_id = f.id AND r.archived = 1)
       ORDER BY i.occurrence_at DESC
       LIMIT 1000`,
    )
    .bind(userId, since)
    .all<{
      display_name: string;
      food_id: string;
      amount_value: number;
      amount_unit: string;
      grams: number;
      occurrence_at: string;
      meal_type: MealType;
      food_name: string;
      kcal: number | null;
    }>();

  const byName = new Map<string, QuickFood & { forMeal: number }>();
  for (const r of results) {
    const key = r.display_name.trim().toLowerCase();
    const hit = byName.get(key);
    if (hit) {
      hit.count++;
      if (r.meal_type === mealType) hit.forMeal++;
      continue;
    }
    // Rows are newest first, so the first one per name holds the latest food and amount.
    byName.set(key, {
      name: r.display_name,
      food_id: r.food_id,
      food_name: r.food_name,
      amount: r.amount_value,
      unit: r.amount_unit,
      grams: r.grams,
      kcal: r.kcal == null ? null : Math.round(r.kcal),
      count: 1,
      last_at: r.occurrence_at,
      forMeal: r.meal_type === mealType ? 1 : 0,
    });
  }
  const all = [...byName.values()];
  const strip = ({ forMeal: _f, ...q }: QuickFood & { forMeal: number }): QuickFood => q;
  const recent = all.slice(0, LIMIT).map(strip);
  const frequent = all
    .filter((q) => q.count >= 2)
    .sort((a, b) => b.forMeal - a.forMeal || b.count - a.count || b.last_at.localeCompare(a.last_at))
    .slice(0, LIMIT)
    .map(strip);
  return { recent, frequent };
}

/** Foods eaten alongside, with the past meals they shared and what they went with. */
export interface GoesWith extends QuickFood {
  /** The item in this meal it was most often eaten with, in the user's words. */
  with: string;
}

const GOES_WITH_DAYS = 365;
const GOES_WITH_LIMIT = 8;
const norm = (s: string) => s.trim().toLowerCase();

/**
 * What you usually have with the foods already in a meal: forgot the parmesan on the pasta?
 * Looks at past meals that had any of this meal's foods (same name, or same food) and counts
 * the other things in them, one vote per meal. Things already in this meal are left out.
 * `count` is how many of those meals had it.
 */
export async function goesWith(db: D1Database, userId: string, intakeId: string, now = new Date()): Promise<GoesWith[]> {
  const { results: here } = await db
    .prepare('SELECT display_name, food_id FROM consumed_item WHERE intake_id = ? AND user_id = ?')
    .bind(intakeId, userId)
    .all<{ display_name: string; food_id: string | null }>();
  if (!here.length) return [];
  const names = new Set(here.map((h) => norm(h.display_name)));
  const foods = new Set(here.map((h) => h.food_id).filter((f): f is string => !!f));
  const inMeal = (name: string, food: string | null) => names.has(norm(name)) || (!!food && foods.has(food));

  const since = new Date(now.getTime() - GOES_WITH_DAYS * 86400000).toISOString();
  const nameList = [...names];
  const foodList = [...foods];
  const ph = (n: number) => (n ? Array(n).fill('?').join(',') : 'NULL');
  // Every item of each past meal that shared a food with this one, newest first.
  const { results } = await db
    .prepare(
      `WITH past AS (
         SELECT DISTINCT ci.intake_id FROM consumed_item ci JOIN nutrition_intake i ON i.id = ci.intake_id
         WHERE ci.user_id = ? AND i.id != ? AND i.status = 'completed' AND i.occurrence_at >= ?
           AND (lower(trim(ci.display_name)) IN (${ph(nameList.length)}) OR ci.food_id IN (${ph(foodList.length)}))
       )
       SELECT ci.intake_id, ci.display_name, ci.food_id, ci.amount_value, ci.amount_unit, ci.grams, i.occurrence_at, f.name AS food_name,
         f.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipe r WHERE r.food_id = f.id AND r.archived = 1) AS usable,
         (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'ENERC_KCAL') AS kcal
       FROM consumed_item ci
       JOIN past p ON p.intake_id = ci.intake_id
       JOIN nutrition_intake i ON i.id = ci.intake_id
       LEFT JOIN food f ON f.id = ci.food_id
       ORDER BY i.occurrence_at DESC
       LIMIT 3000`,
    )
    .bind(userId, intakeId, since, ...nameList, ...foodList)
    .all<{
      intake_id: string;
      display_name: string;
      food_id: string | null;
      amount_value: number;
      amount_unit: string;
      grams: number;
      occurrence_at: string;
      food_name: string | null;
      usable: number | null;
      kcal: number | null;
    }>();

  // Group each past meal's items: which of ours it had (anchors), and the rest (candidates).
  const meals = new Map<string, typeof results>();
  for (const r of results) {
    const m = meals.get(r.intake_id);
    if (m) m.push(r);
    else meals.set(r.intake_id, [r]);
  }
  const ourName = (r: { display_name: string; food_id: string | null }) =>
    here.find((h) => norm(h.display_name) === norm(r.display_name) || (!!r.food_id && h.food_id === r.food_id))!.display_name;

  const byName = new Map<string, GoesWith & { anchors: Map<string, number>; meals: Set<string> }>();
  for (const [intake, items] of meals) {
    const anchors = [...new Set(items.filter((r) => inMeal(r.display_name, r.food_id)).map(ourName))];
    for (const r of items) {
      if (inMeal(r.display_name, r.food_id) || !r.food_id || !r.usable) continue;
      const key = norm(r.display_name);
      let hit = byName.get(key);
      if (!hit) {
        // Meals come newest first, so the first row per name holds the latest food and amount.
        hit = {
          name: r.display_name,
          food_id: r.food_id,
          food_name: r.food_name ?? r.display_name,
          amount: r.amount_value,
          unit: r.amount_unit,
          grams: r.grams,
          kcal: r.kcal == null ? null : Math.round(r.kcal),
          count: 0,
          last_at: r.occurrence_at,
          with: anchors[0] ?? '',
          anchors: new Map(),
          meals: new Set(),
        };
        byName.set(key, hit);
      }
      if (hit.meals.has(intake)) continue; // twice in one meal is still one meal
      hit.meals.add(intake);
      hit.count++;
      for (const a of anchors) hit.anchors.set(a, (hit.anchors.get(a) ?? 0) + 1);
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.count - a.count || b.last_at.localeCompare(a.last_at))
    .slice(0, GOES_WITH_LIMIT)
    .map(({ anchors, meals: _m, ...g }) => ({ ...g, with: [...anchors].sort((a, b) => b[1] - a[1])[0]?.[0] ?? g.with }));
}
