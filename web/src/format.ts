import type { MealType } from './api';

export const MEALS: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const MEAL_LABEL: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

/** The meal the current time of day suggests. */
export function guessMeal(): MealType {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h >= 4 && h < 10.5) return 'breakfast';
  if (h >= 11 && h < 14.5) return 'lunch';
  if (h >= 17 && h < 21.5) return 'dinner';
  return 'snack';
}

export const kcal = (v: number | undefined) => Math.round(v ?? 0).toLocaleString();

// Amounts and food weights live in amounts.ts; re-exported so components import from one place.
export * from './amounts';

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
  low: { dot: 'bg-berry', text: 'text-berry' },
  medium: { dot: 'bg-mustard', text: 'text-mustard' },
  high: { dot: 'bg-sage', text: 'text-sage' },
  exact: { dot: 'bg-plum', text: 'text-plum' },
};

export function confidenceTone(c: number | null | undefined): { label: string; cls: string; dot: string } {
  const l = confidenceLevel(c);
  if (!l) return { label: '', cls: '', dot: '' };
  return { label: l.label, cls: TONE[l.key]!.text, dot: TONE[l.key]!.dot };
}
