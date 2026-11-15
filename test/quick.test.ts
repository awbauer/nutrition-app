import { describe, expect, it } from 'vitest';
import { api } from './helpers';

const U = { DEV_USER_EMAIL: 'quick@example.test' };
const now = Date.now();
const at = (daysAgo: number, h: number) => new Date(now - daysAgo * 86400000).toISOString().slice(0, 11) + `${String(h).padStart(2, '0')}:00:00Z`;

describe('recent and frequent foods', () => {
  it('groups by name, keeps the latest amount, and ranks frequent foods for the meal', async () => {
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } }, U);
    const mk = async (name: string, kcal: number) => (await api('/foods', { method: 'POST', json: { name, per_100g: { ENERC_KCAL: kcal } } }, U)).data.id as string;
    const oats = await mk('Oats', 380);
    const coffee = await mk('Coffee', 2);
    const salad = await mk('Salad', 50);
    const log = (meal: string, food: string, g: number, d: number, h: number, display?: string) =>
      api('/intake', { method: 'POST', json: { meal_type: meal, occurrence_at: at(d, h), items: [{ food_id: food, amount: g, unit: 'g', display_name: display }] } }, U);
    await log('breakfast', oats, 40, 5, 8);
    await log('breakfast', oats, 50, 3, 8); // latest oats amount
    await log('breakfast', coffee, 250, 3, 8);
    await log('breakfast', coffee, 250, 2, 8);
    await log('breakfast', coffee, 250, 1, 8);
    await log('lunch', salad, 200, 1, 12);
    await log('lunch', salad, 220, 0, 12);
    await log('lunch', salad, 220, 0, 13, 'side salad'); // different wording, separate entry
    const old = await log('dinner', oats, 999, 200, 19); // outside the window
    expect(old.status).toBe(201);
    const del = await log('snack', coffee, 100, 0, 15);
    await api(`/intake/${del.data.id}`, { method: 'DELETE' }, U); // deleted meals don't count

    const b = await api('/foods/quick?meal_type=breakfast', {}, U);
    expect(b.data.recent.map((q: any) => q.name)).toEqual(['side salad', 'Salad', 'Coffee', 'Oats']);
    const oatsQ = b.data.recent.find((q: any) => q.name === 'Oats');
    expect(oatsQ).toMatchObject({ amount: 50, unit: 'g', kcal: 190, count: 2, food_id: oats });
    // Frequent at breakfast: breakfast regulars first (coffee 3x, oats 2x), then salad.
    expect(b.data.frequent.map((q: any) => q.name)).toEqual(['Coffee', 'Oats', 'Salad']);
    // At lunch, salad comes first.
    const l = await api('/foods/quick?meal_type=lunch', {}, U);
    expect(l.data.frequent[0].name).toBe('Salad');
    expect(l.data.frequent.find((q: any) => q.name === 'side salad')).toBeUndefined(); // logged once
  });
});
