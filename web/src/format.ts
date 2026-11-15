import type { MealType } from './api';

export const MEALS: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const MEAL_LABEL: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

export const kcal = (v: number | undefined) => Math.round(v ?? 0).toLocaleString();
export const grams = (v: number | undefined) => `${Math.round(v ?? 0)} g`;

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  const d = new Date(`${date}T12:00:00`);
  const t = new Date(`${today}T12:00:00`);
  const diff = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const UNIT_LABEL: Record<string, string> = {
  '[cup_us]': 'cup',
  '[tbs_us]': 'tbsp',
  '[tsp_us]': 'tsp',
  '[oz_av]': 'oz',
  '[lb_av]': 'lb',
  '[foz_us]': 'fl oz',
};
export const unitLabel = (u: string) => UNIT_LABEL[u] ?? u;

export function amountLabel(amount: number, unit: string): string {
  const u = unitLabel(unit);
  const a = Number.isInteger(amount) ? amount : Math.round(amount * 100) / 100;
  return u === 'g' || u === 'mL' ? `${a} ${u}` : `${a} ${u}`;
}

export function confidenceTone(c: number | null): { label: string; cls: string } {
  if (c == null) return { label: '', cls: '' };
  if (c >= 0.8) return { label: 'High', cls: 'text-emerald-600 dark:text-emerald-400' };
  if (c >= 0.5) return { label: 'Medium', cls: 'text-amber-600 dark:text-amber-400' };
  return { label: 'Low', cls: 'text-rose-600 dark:text-rose-400' };
}
