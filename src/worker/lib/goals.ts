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

/** Benchmark split of energy between the macros (protein and fat mid-range of the guidelines, carbs the rest). */
export const MACRO_SHARE = { protein: 0.2, fat: 0.3, carbs: 0.5 } as const;
const KCAL_PER_G = { protein: 4, fat: 9, carbs: 4 } as const;
/** Fiber per 1,000 kcal (Dietary Guidelines for Americans). */
const FIBER_PER_1000_KCAL = 14;
const MACROS = ['protein', 'fat', 'carbs'] as const;

export type TargetInput = Partial<Record<'energy' | 'protein' | 'fat' | 'carbs' | 'fiber', number | null>>;

/**
 * Fill in the targets left blank, keeping the given ones as anchors.
 * - No energy: it follows from the given macros at their benchmark shares (with all three given, simply their calories).
 * - Blank macros split the energy the given ones leave, in proportion to their benchmark shares.
 * - Blank fiber: 14 g per 1,000 kcal.
 * Values come back rounded; a macro the others leave no room for comes back 0. With nothing to anchor on, nothing is filled.
 */
export function balanceTargets(input: TargetInput): Record<'energy' | 'protein' | 'fat' | 'carbs' | 'fiber', number | null> {
  const given = (v: number | null | undefined): v is number => typeof v === 'number' && v > 0;
  const known = MACROS.filter((m) => given(input[m]));
  const knownKcal = known.reduce((s, m) => s + input[m]! * KCAL_PER_G[m], 0);
  let energy = given(input.energy) ? input.energy : null;
  if (energy == null && known.length) energy = knownKcal / known.reduce((s, m) => s + MACRO_SHARE[m], 0);
  const out = { energy: energy != null ? Math.round(energy) : null, protein: null, fat: null, carbs: null, fiber: null } as Record<
    'energy' | 'protein' | 'fat' | 'carbs' | 'fiber',
    number | null
  >;
  const blank = MACROS.filter((m) => !given(input[m]));
  const left = energy != null ? Math.max(0, energy - knownKcal) : 0;
  const blankShare = blank.reduce((s, m) => s + MACRO_SHARE[m], 0);
  for (const m of MACROS) {
    if (given(input[m])) out[m] = input[m];
    else if (energy != null) out[m] = Math.round((left * MACRO_SHARE[m]) / blankShare / KCAL_PER_G[m]);
  }
  out.fiber = given(input.fiber) ? input.fiber : energy != null ? Math.round((energy / 1000) * FIBER_PER_1000_KCAL) : null;
  return out;
}

/** Fat, carb and fiber targets that follow from the energy and protein targets (see balanceTargets). */
export function defaultMacros(energy: number, protein?: number): Record<'FAT' | 'CHOCDF' | 'FIBTG', number> {
  const b = balanceTargets({ energy, protein });
  return { FAT: b.fat!, CHOCDF: b.carbs!, FIBTG: b.fiber! };
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

/** Targets by nutrient code: the user's goals, plus fat, carbs and fiber balanced around them when an energy goal is set. */
export function targetsFromGoals(goals: Record<string, GoalRow>): Record<string, number> {
  const t = ownTargets(goals);
  if (goals.energy) {
    const v = (k: string) => goals[k]?.target_value;
    const b = balanceTargets({ energy: v('energy'), protein: v('protein'), fat: v('fat'), carbs: v('carbs'), fiber: v('fiber') });
    for (const code of defaultedTargets(goals)) {
      const type = Object.keys(GOAL_NUTRIENT).find((k) => GOAL_NUTRIENT[k] === code) as keyof typeof b;
      t[code] = b[type]!;
    }
  }
  return t;
}
