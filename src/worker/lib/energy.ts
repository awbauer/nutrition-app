/** Starting targets (spec §5): Mifflin-St Jeor BMR × activity factor, adjusted for goal rate. */

export const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 } as const;
export type Activity = keyof typeof ACTIVITY;
export const KCAL_PER_KG = 7700;

export interface Profile {
  height_cm: number;
  weight_kg: number;
  age: number;
  sex: 'male' | 'female';
  activity: Activity;
  /** Negative to lose, positive to gain (kg per week). */
  goal_rate_kg_per_week: number;
}

export function validProfile(p: unknown): p is Profile {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi;
  return (
    num(o.height_cm, 100, 250) &&
    num(o.weight_kg, 30, 350) &&
    num(o.age, 14, 110) &&
    (o.sex === 'male' || o.sex === 'female') &&
    typeof o.activity === 'string' &&
    o.activity in ACTIVITY &&
    num(o.goal_rate_kg_per_week, -1.5, 1)
  );
}

export function bmr(p: Profile): number {
  return 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
}

export function suggestTargets(p: Profile) {
  const b = bmr(p);
  const tdee = b * ACTIVITY[p.activity];
  const delta = (p.goal_rate_kg_per_week * KCAL_PER_KG) / 7;
  const floor = p.sex === 'male' ? 1500 : 1200;
  const energy = Math.max(floor, Math.round((tdee + delta) / 10) * 10);
  // 1.6 g/kg supports muscle retention in a deficit and growth in a surplus.
  const protein = Math.round(1.6 * p.weight_kg);
  return { bmr: Math.round(b), tdee: Math.round(tdee), energy, protein, floored: energy === floor && tdee + delta < floor };
}

/**
 * Exponential moving average over daily weights (spec: 7-day EMA).
 * Days without a weigh-in carry the trend forward; multiple weigh-ins in a day are averaged.
 */
export function weightTrend(points: { date: string; kg: number }[], span = 7): { date: string; kg: number; trend: number }[] {
  const alpha = 2 / (span + 1);
  const byDay = new Map<string, number[]>();
  for (const p of points) byDay.set(p.date, [...(byDay.get(p.date) ?? []), p.kg]);
  const days = [...byDay.keys()].sort();
  const out: { date: string; kg: number; trend: number }[] = [];
  let trend: number | null = null;
  let prev: string | null = null;
  for (const d of days) {
    const vals = byDay.get(d)!;
    const kg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (trend === null) trend = kg;
    else {
      // Treat a gap of n days as n steps with the same reading, so sparse logs still converge.
      const gap = Math.max(1, Math.round((Date.parse(d) - Date.parse(prev!)) / 86400000));
      trend = trend + (1 - (1 - alpha) ** gap) * (kg - trend);
    }
    prev = d;
    out.push({ date: d, kg: Math.round(kg * 100) / 100, trend: Math.round(trend * 100) / 100 });
  }
  return out;
}
