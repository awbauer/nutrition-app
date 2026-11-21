/**
 * A graph of what the user eats, built from their log for a time window:
 * - food:   each food eaten (named the way the user usually names it), sized by how often
 * - meal:   breakfast / lunch / dinner / snack
 * - brand:  brands and restaurants of the foods
 * - recipe: the user's recipes (also foods), linked to their ingredients
 * Edges: food–meal (eaten at), food–food (eaten in the same meal), food–brand (made by),
 * recipe–food (ingredient of).
 */
import { normName } from './foods';
import { MEAL_TYPES, type MealType } from './intake';

export type NodeType = 'food' | 'meal' | 'brand' | 'recipe';
export type EdgeType = 'eaten_at' | 'eaten_with' | 'made_by' | 'ingredient';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** Times eaten (foods, recipes), items logged (meals), times eaten across foods (brands). */
  weight: number;
  food_id?: string;
  /** Food's database name when the user calls it something else. */
  food_name?: string;
  kcal_avg?: number;
  protein_avg?: number;
  last_at?: string;
  /** For foods: the meal they're most often eaten at. */
  top_meal?: MealType;
  source?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

export interface Graph {
  days: number;
  since: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Foods in the window that were left out to keep the graph readable. */
  omitted_foods: number;
}

/** Most foods shown; the rest are the least eaten. */
export const MAX_FOODS = 60;
/** Most food–food links kept (strongest first). */
const MAX_PAIRS = 150;

interface Row {
  intake_id: string;
  meal_type: MealType;
  occurrence_at: string;
  food_id: string;
  display_name: string;
  food_name: string;
  brand: string | null;
  source: string;
  kcal: number | null;
  protein: number | null;
}

export async function buildGraph(db: D1Database, userId: string, days: number, now = new Date()): Promise<Graph> {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT ci.intake_id, i.meal_type, i.occurrence_at, ci.food_id, ci.display_name, f.name AS food_name, f.brand, f.source,
         (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'ENERC_KCAL') AS kcal,
         (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'PROCNT') AS protein
       FROM consumed_item ci
       JOIN nutrition_intake i ON i.id = ci.intake_id
       JOIN food f ON f.id = ci.food_id
       WHERE ci.user_id = ? AND i.status = 'completed' AND i.occurrence_at >= ?
       ORDER BY i.occurrence_at`,
    )
    .bind(userId, since)
    .all<Row>();

  // Foods: one node per food row; AI estimates of the same wording collapse into one node.
  interface FoodAgg {
    key: string;
    food_id: string;
    food_name: string;
    brand: string | null;
    source: string;
    names: Map<string, number>;
    times: number;
    kcal: number;
    protein: number;
    last_at: string;
    meals: Map<MealType, number>;
  }
  const foods = new Map<string, FoodAgg>();
  const keyOf = (r: Row) => (r.source === 'estimate' ? `est:${normName(r.display_name)}` : r.food_id);
  for (const r of results) {
    const key = keyOf(r);
    let f = foods.get(key);
    if (!f) {
      f = {
        key,
        food_id: r.food_id,
        food_name: r.food_name,
        brand: r.brand,
        source: r.source,
        names: new Map(),
        times: 0,
        kcal: 0,
        protein: 0,
        last_at: r.occurrence_at,
        meals: new Map(),
      };
      foods.set(key, f);
    }
    f.times += 1;
    f.kcal += r.kcal ?? 0;
    f.protein += r.protein ?? 0;
    if (r.occurrence_at >= f.last_at) {
      f.last_at = r.occurrence_at;
      f.food_id = r.food_id; // latest row for estimates
    }
    const n = r.display_name.trim();
    if (n) f.names.set(n, (f.names.get(n) ?? 0) + 1);
    f.meals.set(r.meal_type, (f.meals.get(r.meal_type) ?? 0) + 1);
  }

  const ranked = [...foods.values()].sort((a, b) => b.times - a.times || b.last_at.localeCompare(a.last_at));
  const kept = ranked.slice(0, MAX_FOODS);
  const keptKeys = new Set(kept.map((f) => f.key));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const id = (f: FoodAgg) => `food:${f.key}`;

  for (const f of kept) {
    const label = [...f.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? f.food_name;
    const top = [...f.meals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    nodes.push({
      id: id(f),
      type: f.source === 'recipe' ? 'recipe' : 'food',
      label,
      weight: f.times,
      food_id: f.food_id,
      ...(normName(label) !== normName(f.food_name) ? { food_name: f.food_name } : {}),
      kcal_avg: Math.round(f.kcal / f.times),
      protein_avg: Math.round((f.protein / f.times) * 10) / 10,
      last_at: f.last_at,
      ...(top ? { top_meal: top } : {}),
      source: f.source,
    });
  }

  // Meals.
  const mealTotals = new Map<MealType, number>();
  for (const f of kept) {
    for (const [m, n] of f.meals) {
      mealTotals.set(m, (mealTotals.get(m) ?? 0) + n);
      edges.push({ source: id(f), target: `meal:${m}`, type: 'eaten_at', weight: n });
    }
  }
  for (const m of MEAL_TYPES) {
    const n = mealTotals.get(m);
    if (n) nodes.push({ id: `meal:${m}`, type: 'meal', label: m[0]!.toUpperCase() + m.slice(1), weight: n });
  }

  // Brands.
  const brands = new Map<string, { label: string; weight: number }>();
  for (const f of kept) {
    if (!f.brand?.trim()) continue;
    const k = normName(f.brand);
    const b = brands.get(k) ?? { label: f.brand.trim(), weight: 0 };
    b.weight += f.times;
    brands.set(k, b);
    edges.push({ source: id(f), target: `brand:${k}`, type: 'made_by', weight: f.times });
  }
  for (const [k, b] of brands) nodes.push({ id: `brand:${k}`, type: 'brand', label: b.label, weight: b.weight });

  // Eaten together: foods in the same meal.
  const byIntake = new Map<string, Set<string>>();
  for (const r of results) {
    const key = keyOf(r);
    if (!keptKeys.has(key)) continue;
    const s = byIntake.get(r.intake_id) ?? new Set<string>();
    s.add(key);
    byIntake.set(r.intake_id, s);
  }
  const pairs = new Map<string, number>();
  for (const s of byIntake.values()) {
    const ks = [...s].sort();
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) pairs.set(`${ks[i]}\u0000${ks[j]}`, (pairs.get(`${ks[i]}\u0000${ks[j]}`) ?? 0) + 1);
  }
  const byKey = new Map(kept.map((f) => [f.key, f]));
  [...pairs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PAIRS)
    .forEach(([k, n]) => {
      const [a, b] = k.split('\u0000') as [string, string];
      edges.push({ source: id(byKey.get(a)!), target: id(byKey.get(b)!), type: 'eaten_with', weight: n });
    });

  // Recipes and their ingredients (ingredients join the graph even if never eaten on their own).
  const recipeIds = kept.filter((f) => f.source === 'recipe').map((f) => f.food_id);
  if (recipeIds.length) {
    const { results: ings } = await db
      .prepare(
        `SELECT ri.recipe_food_id, ri.food_id, ri.display_name, f.name AS food_name, f.source
         FROM recipe_ingredient ri JOIN food f ON f.id = ri.food_id
         WHERE ri.recipe_food_id IN (${recipeIds.map(() => '?').join(',')})`,
      )
      .bind(...recipeIds)
      .all<{ recipe_food_id: string; food_id: string; display_name: string; food_name: string; source: string }>();
    const have = new Set(nodes.map((n) => n.id));
    for (const ing of ings) {
      const key = ing.source === 'estimate' ? `est:${normName(ing.display_name)}` : ing.food_id;
      const nid = `food:${key}`;
      if (!have.has(nid)) {
        nodes.push({ id: nid, type: 'food', label: ing.display_name, weight: 0, food_id: ing.food_id, source: ing.source });
        have.add(nid);
      }
      edges.push({ source: `food:${ing.recipe_food_id}`, target: nid, type: 'ingredient', weight: 1 });
    }
  }

  return { days, since, nodes, edges, omitted_foods: Math.max(0, ranked.length - kept.length) };
}
