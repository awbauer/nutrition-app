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

/** Confidence levels shown to the user; values are what gets stored (0 to 1). */
export const CONFIDENCE_LEVELS = [
  { key: 'low', label: 'Low', value: 0.3, hint: 'A rough guess' },
  { key: 'medium', label: 'Medium', value: 0.6, hint: 'About right' },
  { key: 'high', label: 'High', value: 0.85, hint: 'Close' },
  { key: 'exact', label: 'Exact', value: 1, hint: 'Weighed or from the label' },
] as const;

export function confidenceLevel(c: number | null | undefined) {
  if (c == null) return null;
  return c >= 0.95 ? CONFIDENCE_LEVELS[3] : c >= 0.8 ? CONFIDENCE_LEVELS[2] : c >= 0.5 ? CONFIDENCE_LEVELS[1] : CONFIDENCE_LEVELS[0];
}

const TONE: Record<string, { dot: string; text: string }> = {
  low: { dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
  medium: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  high: { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  exact: { dot: 'bg-brand-600', text: 'text-brand-700 dark:text-brand-500' },
};

export function confidenceTone(c: number | null | undefined): { label: string; cls: string; dot: string } {
  const l = confidenceLevel(c);
  if (!l) return { label: '', cls: '', dot: '' };
  return { label: l.label, cls: TONE[l.key]!.text, dot: TONE[l.key]!.dot };
}
