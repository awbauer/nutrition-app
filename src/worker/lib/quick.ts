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
