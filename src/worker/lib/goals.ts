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

export function targetsFromGoals(goals: Record<string, GoalRow>): Record<string, number> {
  const t: Record<string, number> = {};
  for (const [type, g] of Object.entries(goals)) if (GOAL_NUTRIENT[type]) t[GOAL_NUTRIENT[type]!] = g.target_value;
  return t;
}
