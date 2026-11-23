export interface GoalRow {
  id: string;
  type: 'energy' | 'protein' | 'fat' | 'carbs' | 'fiber' | 'body-weight';
  target_value: number;
  unit: string;
  start_date: string;
  end_date: string | null;
  status: 'active' | 'completed' | 'cancelled';
}

/** Goal type -> nutrient code it is measured against. */
export const GOAL_NUTRIENT: Record<string, string> = {
  energy: 'ENERC_KCAL',
  protein: 'PROCNT',
  fat: 'FAT',
  carbs: 'CHOCDF',
  fiber: 'FIBTG',
};

/** Goals in effect on a given date (latest start wins per type). */
export async function goalsOn(db: D1Database, userId: string, date: string): Promise<Record<string, GoalRow>> {
  const { results } = await db
    .prepare(
      `SELECT id, type, target_value, unit, start_date, end_date, status FROM goal
       WHERE user_id = ? AND status != 'cancelled' AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY start_date ASC, created_at ASC`,
    )
    .bind(userId, date, date)
    .all<GoalRow>();
  const out: Record<string, GoalRow> = {};
  for (const g of results) out[g.type] = g;
  return out;
}

/** Share of energy from fat when no fat target is set (middle of the 20–35% guideline range). */
const DEFAULT_FAT_SHARE = 0.3;
/** Protein's share of energy assumed for the carb default when no protein target is set. */
const DEFAULT_PROTEIN_SHARE = 0.2;
/** Fiber per 1,000 kcal (Dietary Guidelines for Americans). */
const FIBER_PER_1000_KCAL = 14;

/**
 * Fat, carb and fiber targets that follow from the energy (and protein) target, for the ones the user
 * hasn't set: fat at 30% of energy, carbs the energy left after protein and fat, fiber 14 g per 1,000 kcal.
 */
export function defaultMacros(energy: number, protein?: number): Record<'FAT' | 'CHOCDF' | 'FIBTG', number> {
  const fat = (energy * DEFAULT_FAT_SHARE) / 9;
  const proteinKcal = protein != null ? protein * 4 : energy * DEFAULT_PROTEIN_SHARE;
  return {
    FAT: Math.round(fat),
    CHOCDF: Math.max(0, Math.round((energy - proteinKcal - fat * 9) / 4)),
    FIBTG: Math.round((energy / 1000) * FIBER_PER_1000_KCAL),
  };
}

/** Nutrient codes whose target is a default (no goal set) rather than the user's own. */
export function defaultedTargets(goals: Record<string, GoalRow>): string[] {
  if (!goals.energy) return [];
  return (['fat', 'carbs', 'fiber'] as const).filter((t) => !goals[t]).map((t) => GOAL_NUTRIENT[t]!);
}

/** Targets by nutrient code from the user's own goals only (no defaults). */
export function ownTargets(goals: Record<string, GoalRow>): Record<string, number> {
  const t: Record<string, number> = {};
  for (const [type, g] of Object.entries(goals)) if (GOAL_NUTRIENT[type]) t[GOAL_NUTRIENT[type]!] = g.target_value;
  return t;
}

/** Targets by nutrient code: the user's goals, plus defaults for fat, carbs and fiber when an energy goal is set. */
export function targetsFromGoals(goals: Record<string, GoalRow>): Record<string, number> {
  const t = ownTargets(goals);
  if (goals.energy) {
    const d = defaultMacros(goals.energy.target_value, goals.protein?.target_value);
    for (const code of defaultedTargets(goals)) t[code] = d[code as keyof typeof d];
  }
  return t;
}
