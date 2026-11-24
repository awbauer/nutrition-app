import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { suggestTargets, weightTrend } from '../src/worker/lib/energy';
import { balanceTargets, defaultMacros } from '../src/worker/lib/goals';
import { addDays } from '../src/worker/lib/dates';
import { api } from './helpers';

const USER = { DEV_USER_EMAIL: 'progress@example.test' };

describe('energy and trend maths', () => {
  it('Mifflin-St Jeor with activity factor and goal rate', () => {
    const s = suggestTargets({ height_cm: 180, weight_kg: 90, age: 40, sex: 'male', activity: 'moderate', goal_rate_kg_per_week: -0.5 });
    // BMR = 900 + 1125 - 200 + 5 = 1830; TDEE = 2836.5; -550/day
    expect(s.bmr).toBe(1830);
    expect(s.tdee).toBe(2837);
    expect(s.energy).toBe(2290);
    expect(s.protein).toBe(144);
  });
  it('never suggests below a safe floor', () => {
    const s = suggestTargets({ height_cm: 150, weight_kg: 45, age: 70, sex: 'female', activity: 'sedentary', goal_rate_kg_per_week: -1 });
    expect(s.energy).toBe(1200);
    expect(s.floored).toBe(true);
  });
  it('EMA smooths daily swings and carries across gaps', () => {
    const t = weightTrend([
      { date: '2026-11-01', kg: 80 },
      { date: '2026-11-02', kg: 82 },
      { date: '2026-11-02', kg: 81 },
      { date: '2026-11-05', kg: 79 },
    ]);
    expect(t).toHaveLength(3);
    expect(t[0]!.trend).toBe(80);
    expect(t[1]).toMatchObject({ kg: 81.5, trend: 80.38 });
    // 3-day gap: weight 1-(0.75^3)=0.578 toward 79
    expect(t[2]!.trend).toBeCloseTo(79.58, 1);
  });
});

describe('goals', () => {
  it('derives default fat, carb and fiber targets from energy and protein', () => {
    // 1,800 kcal with 150 g protein leaves 1,200 kcal, split fat:carbs 30:50 -> 450 kcal fat (50 g), 750 kcal carbs (188 g).
    expect(defaultMacros(1800, 150)).toEqual({ FAT: 50, CHOCDF: 188, FIBTG: 25 });
    // Protein using up all the calories leaves the others at 0, never negative.
    expect(defaultMacros(1500, 400)).toMatchObject({ FAT: 0, CHOCDF: 0 });
  });

  it('balances blank targets around the ones given', () => {
    // Energy and one macro: the rest split what's left by benchmark share.
    expect(balanceTargets({ energy: 2000, fat: 80 })).toEqual({ energy: 2000, protein: 91, fat: 80, carbs: 229, fiber: 28 });
    // All macros, no energy: energy is their calories.
    expect(balanceTargets({ protein: 150, fat: 60, carbs: 200, fiber: 30 })).toEqual({ energy: 1940, protein: 150, fat: 60, carbs: 200, fiber: 30 });
    // One macro, no energy: it sets the scale at its benchmark share (150 g protein = 600 kcal = 20%).
    expect(balanceTargets({ protein: 150 })).toEqual({ energy: 3000, protein: 150, fat: 100, carbs: 375, fiber: 42 });
    // Two macros: energy from their combined share (600 + 540 kcal over 50%), carbs the remainder.
    expect(balanceTargets({ protein: 150, fat: 60 })).toEqual({ energy: 2280, protein: 150, fat: 60, carbs: 285, fiber: 32 });
    // Everything given is kept as is, even if it doesn't add up.
    expect(balanceTargets({ energy: 1800, protein: 150, fat: 60, carbs: 200, fiber: 30 })).toEqual({ energy: 1800, protein: 150, fat: 60, carbs: 200, fiber: 30 });
    // Fiber alone anchors nothing.
    expect(balanceTargets({ fiber: 30 })).toEqual({ energy: null, protein: null, fat: null, carbs: null, fiber: 30 });
  });

  it('suggests, applies, and replaces targets', async () => {
    const profile = { height_cm: 170, weight_kg: 70, age: 35, sex: 'female', activity: 'light', goal_rate_kg_per_week: 0 };
    const sug = await api('/goals/suggest', { method: 'POST', json: { profile } }, USER);
    expect(sug.status).toBe(200);
    const none = await api('/goals', {}, USER);
    expect(none.data.targets).toEqual({});

    await api('/goals/suggest', { method: 'POST', json: { profile, apply: true } }, USER);
    const g = await api('/goals', {}, USER);
    expect(g.data.profile).toEqual(profile);
    // Fat, carbs and fiber weren't set: they follow from energy and protein.
    const e = sug.data.energy as number;
    expect(g.data.targets).toEqual({
      ENERC_KCAL: e,
      PROCNT: 112,
      FAT: Math.round(((e - 448) * 0.375) / 9),
      CHOCDF: Math.round(((e - 448) * 0.625) / 4),
      FIBTG: Math.round((e / 1000) * 14),
    });
    expect(g.data.default_targets).toEqual(['FAT', 'CHOCDF', 'FIBTG']);

    // A set fiber target replaces its default; without a protein target, fat and carbs keep their benchmark shares.
    const upd = await api('/goals', { method: 'PUT', json: { energy: 1900, fiber: 30, protein: null } }, USER);
    expect(upd.data.targets).toEqual({ ENERC_KCAL: 1900, FIBTG: 30, FAT: 63, CHOCDF: 238 });
    expect(upd.data.default_targets).toEqual(['FAT', 'CHOCDF']);

    const day = await api(`/day/${g.data.date}`, {}, USER);
    expect(day.data.targets.ENERC_KCAL).toBe(1900);
    expect(day.data.remaining.ENERC_KCAL).toBe(1900);
    expect(day.data.targets).toMatchObject({ FAT: 63, CHOCDF: 238, FIBTG: 30 });
    expect(day.data.default_targets).toEqual(['FAT', 'CHOCDF']);
    expect(day.data.remaining.FAT).toBe(63);

    // Fill: the given targets anchor, the blank ones are calculated and saved as the user's own.
    const fill = await api('/goals', { method: 'PUT', json: { fill: true, energy: 2000, protein: 150, fat: null, carbs: null, fiber: null } }, USER);
    expect(fill.status).toBe(200);
    expect(fill.data.targets).toEqual({ ENERC_KCAL: 2000, PROCNT: 150, FAT: 58, CHOCDF: 219, FIBTG: 28 });
    expect(fill.data.filled).toEqual(['fat', 'carbs', 'fiber']);
    expect(fill.data.default_targets).toEqual([]);
    // No energy: it's added up from the macros.
    const sum = await api('/goals', { method: 'PUT', json: { fill: true, protein: 150, fat: 60, carbs: 200 } }, USER);
    expect(sum.data.targets).toMatchObject({ ENERC_KCAL: 1940, PROCNT: 150, FAT: 60, CHOCDF: 200 });
    expect(sum.data.filled).toEqual(['energy', 'fiber']);
    expect((await api('/goals', { method: 'PUT', json: { fill: true, energy: -5 } }, USER)).status).toBe(400);

    expect((await api('/goals', { method: 'PUT', json: { calories: 2000 } }, USER)).status).toBe(400);
    expect((await api('/goals/suggest', { method: 'POST', json: { profile: { height_cm: 170 } } }, USER)).status).toBe(400);
  });
});

describe('weight', () => {
  it('stores kg, converts lb, and returns a trend', async () => {
    const r = await api('/weight', { method: 'POST', json: { value: 176.37, unit: 'lb', effective_at: '2026-11-01T13:00:00Z' } }, USER);
    expect(r.status).toBe(201);
    expect(r.data.value).toBeCloseTo(80, 1);
    await api('/weight', { method: 'POST', json: { value: 79, effective_at: '2026-11-03T13:00:00Z' } }, USER);
    const w = await api('/weight?from=2026-11-01&to=2026-11-10', {}, USER);
    expect(w.data.entries).toHaveLength(2);
    expect(w.data.trend[1].trend).toBeLessThan(80);
    expect(w.data.trend[1].trend).toBeGreaterThan(79);
    expect((await api(`/weight/${r.data.id}`, { method: 'DELETE' }, USER)).status).toBe(204);
    expect((await api('/weight', { method: 'POST', json: { value: 5 } }, USER)).status).toBe(400);
  });
});

describe('week summary', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 500 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('averages completed logged days only and counts the streak', async () => {
    const U = { DEV_USER_EMAIL: 'week@example.test' };
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC', day_cutoff: '00:00' } }, U);
    const food = await api('/foods', { method: 'POST', json: { name: 'Test meal', per_100g: { ENERC_KCAL: 100, PROCNT: 10 } } }, U);
    const today = (await api('/goals', {}, U)).data.date as string;
    // Logged today, yesterday, and 2 days ago at 1000 / 2000 / 1500 kcal; 4 days ago too (streak breaks at day 3).
    const log = (d: string, g: number) =>
      api('/intake', { method: 'POST', json: { occurrence_at: `${d}T12:00:00Z`, items: [{ food_id: food.data.id, amount: g, unit: 'g' }] } }, U);
    await log(today, 1000);
    await log(addDays(today, -1), 2000);
    await log(addDays(today, -2), 1500);
    await log(addDays(today, -4), 500);
    await api('/goals', { method: 'PUT', json: { energy: 1800 } }, U);

    const s = await api('/summary', {}, U);
    expect(s.data.days).toHaveLength(7);
    expect(s.data.days_logged).toBe(4);
    // Today is still in progress: only the three earlier days count (2000 + 1500 + 500) / 3.
    expect(s.data.days_counted).toBe(3);
    expect(s.data.average.ENERC_KCAL).toBe(1333.3);
    expect(s.data.targets.ENERC_KCAL).toBe(1800);
    expect(s.data.streak).toBe(3);
  });
});
