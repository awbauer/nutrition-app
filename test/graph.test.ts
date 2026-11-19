import { describe, expect, it } from 'vitest';
import { api } from './helpers';

const E = { DEV_USER_EMAIL: 'graph@example.test' };

async function food(name: string, kcal: number, brand?: string) {
  const r = await api('/foods', { method: 'POST', json: { name, brand, serving_grams: 100, per_serving: { ENERC_KCAL: kcal, PROCNT: 10 } } }, E);
  return r.data.id as string;
}
async function meal(meal_type: string, at: string, items: [string, string][]) {
  const r = await api(
    '/intake',
    { method: 'POST', json: { meal_type, occurrence_at: at, merge: false, items: items.map(([food_id, display_name]) => ({ food_id, display_name, amount: 1, unit: 'serving' })) } },
    E,
  );
  expect(r.status).toBe(201);
}

describe('food graph', () => {
  it('links foods to their meals, brands and the foods they are eaten with', async () => {
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
    const meatballs = await food('Chicken meatballs', 180, 'Kirkland');
    const rice = await food('Rice, white, cooked', 130);
    const oats = await food('Oats', 150);
    await meal('dinner', ago(1), [[meatballs, 'chicken meatballs'], [rice, 'rice']]);
    await meal('dinner', ago(3), [[meatballs, 'chicken meatballs'], [rice, 'rice']]);
    await meal('lunch', ago(5), [[meatballs, 'chicken meatballs']]);
    await meal('breakfast', ago(2), [[oats, 'oatmeal']]);
    await meal('breakfast', ago(200), [[oats, 'oatmeal']]); // outside 90 days

    const g = (await api('/graph?days=90', {}, E)).data;
    const node = (id: string) => g.nodes.find((n: any) => n.id === id);
    const edge = (a: string, b: string, type: string) => g.edges.find((e: any) => e.type === type && ((e.source === a && e.target === b) || (e.source === b && e.target === a)));

    const mb = node(`food:${meatballs}`);
    expect(mb).toMatchObject({ type: 'food', label: 'chicken meatballs', weight: 3, top_meal: 'dinner', kcal_avg: 180 });
    expect(node(`food:${oats}`)).toMatchObject({ label: 'oatmeal', weight: 1, food_name: 'Oats' });
    expect(node('meal:dinner')).toMatchObject({ type: 'meal', weight: 4 });
    expect(node('brand:kirkland')).toMatchObject({ type: 'brand', label: 'Kirkland', weight: 3 });

    expect(edge(`food:${meatballs}`, `food:${rice}`, 'eaten_with')).toMatchObject({ weight: 2 });
    expect(edge(`food:${meatballs}`, 'meal:dinner', 'eaten_at')).toMatchObject({ weight: 2 });
    expect(edge(`food:${meatballs}`, 'meal:lunch', 'eaten_at')).toMatchObject({ weight: 1 });
    expect(edge(`food:${meatballs}`, 'brand:kirkland', 'made_by')).toBeTruthy();
    expect(edge(`food:${oats}`, `food:${rice}`, 'eaten_with')).toBeUndefined();

    const year = (await api('/graph?days=365', {}, E)).data;
    expect(year.nodes.find((n: any) => n.id === `food:${oats}`).weight).toBe(2);
    // Every edge points at a node that exists.
    const ids = new Set(g.nodes.map((n: any) => n.id));
    for (const e of g.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
  });

  it("is empty for someone else's log", async () => {
    const g = (await api('/graph', {}, { DEV_USER_EMAIL: 'graph-other@example.test' })).data;
    expect(g).toMatchObject({ days: 90, nodes: [], edges: [] });
  });
});
