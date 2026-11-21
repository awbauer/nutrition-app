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

  it('suggests what you usually have with the foods already in a meal', async () => {
    const W = { DEV_USER_EMAIL: 'goes-with@example.test' };
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } }, W);
    const mk = async (name: string) => (await api('/foods', { method: 'POST', json: { name, per_100g: { ENERC_KCAL: 100 } } }, W)).data.id as string;
    const [pasta, parm, sauce, salad, oats] = [await mk('Pasta'), await mk('Parmesan'), await mk('Marinara'), await mk('Salad'), await mk('Oats')];
    const meal = (d: number, items: [string, number, string?][]) =>
      api(
        '/intake',
        {
          method: 'POST',
          json: { meal_type: 'dinner', occurrence_at: at(d, 19), items: items.map(([food_id, g, display_name]) => ({ food_id, amount: g, unit: 'g', display_name })) },
        },
        W,
      );
    await meal(10, [
      [pasta, 200],
      [parm, 10],
      [sauce, 120],
    ]);
    await meal(6, [
      [pasta, 180, 'spaghetti'],
      [parm, 15],
    ]); // other wording, same food: still pasta
    await meal(3, [
      [pasta, 200],
      [parm, 20],
      [salad, 100],
      [parm, 5],
    ]); // parmesan twice counts once
    await meal(2, [
      [oats, 50],
      [salad, 80],
    ]); // nothing in common with pasta
    const now = await meal(0, [[pasta, 200]]);

    const r = await api(`/foods/quick?meal_type=dinner&with=${now.data.id}`, {}, W);
    expect(r.status).toBe(200);
    const g = r.data.goes_with;
    expect(g.map((x: any) => [x.name, x.count])).toEqual([
      ['Parmesan', 3],
      ['Salad', 1],
      ['Marinara', 1],
    ]);
    // Latest amount, and what it went with in this meal's words.
    expect(g[0]).toMatchObject({ food_id: parm, unit: 'g', with: 'Pasta' });
    expect([5, 20]).toContain(g[0].amount); // from the latest meal

    // Once the parmesan is in, it's not suggested again.
    await api('/intake', { method: 'POST', json: { append_to: now.data.id, items: [{ food_id: parm, amount: 10, unit: 'g' }] } }, W);
    const after = await api(`/foods/quick?meal_type=dinner&with=${now.data.id}`, {}, W);
    expect(after.data.goes_with.map((x: any) => x.name)).toEqual(['Salad', 'Marinara']);

    // Someone else's meal id gives nothing; without `with` there's no list.
    expect((await api(`/foods/quick?with=${now.data.id}`, {}, { DEV_USER_EMAIL: 'goes-with-other@example.test' })).data.goes_with).toEqual([]);
    expect((await api('/foods/quick', {}, W)).data.goes_with).toBeUndefined();
  });
});
