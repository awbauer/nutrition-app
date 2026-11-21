import { describe, expect, it } from 'vitest';
import { api } from './helpers';

const U = { DEV_USER_EMAIL: 'fav@example.test' };
const OTHER = { DEV_USER_EMAIL: 'fav-other@example.test' };

describe('favorite foods', () => {
  it('stars, lists with kcal, updates by name, shows in quick add and unstars', async () => {
    const oreo = (await api('/foods', { method: 'POST', json: { name: 'Oreo', per_100g: { ENERC_KCAL: 500 }, serving_grams: 36, serving_label: '2 cookies (36g)' } }, U)).data
      .id as string;
    const yogurt = (await api('/foods', { method: 'POST', json: { name: 'Greek yogurt', per_100g: { ENERC_KCAL: 60 } } }, U)).data.id as string;

    const a = await api('/foods/favorites', { method: 'POST', json: { name: 'oreos', food_id: oreo, amount: 3, unit: 'cookie' } }, U);
    expect(a.status).toBe(201);
    expect(a.data).toMatchObject({ name: 'oreos', amount: 3, unit: 'cookie', grams: 54, kcal: 270 });
    await api('/foods/favorites', { method: 'POST', json: { name: 'Yogurt', food_id: yogurt, amount: 170, unit: 'g' } }, U);

    // Same name again (any case) replaces the amount instead of adding a second star.
    const again = await api('/foods/favorites', { method: 'POST', json: { name: 'Oreos', food_id: oreo, amount: 2, unit: 'cookie' } }, U);
    expect(again.data).toMatchObject({ id: a.data.id, name: 'Oreos', amount: 2, kcal: 180 });

    const list = await api('/foods/favorites', {}, U);
    expect(list.data.map((f: any) => f.name)).toEqual(['Oreos', 'Yogurt']);
    const quick = await api('/foods/quick?meal_type=snack', {}, U);
    expect(quick.data.favorites.map((f: any) => f.name)).toEqual(['Oreos', 'Yogurt']);

    // Other people don't see them and can't remove them.
    expect((await api('/foods/favorites', {}, OTHER)).data).toEqual([]);
    expect((await api(`/foods/favorites/${a.data.id}`, { method: 'DELETE' }, OTHER)).status).toBe(404);

    expect((await api(`/foods/favorites/${a.data.id}`, { method: 'DELETE' }, U)).status).toBe(204);
    expect((await api('/foods/favorites', {}, U)).data.map((f: any) => f.name)).toEqual(['Yogurt']);
  });

  it('rejects bad input and foods you cannot see', async () => {
    const mine = (await api('/foods', { method: 'POST', json: { name: 'Secret bar', per_100g: { ENERC_KCAL: 400 } } }, U)).data.id as string;
    const post = (json: unknown, who = U) => api('/foods/favorites', { method: 'POST', json }, who);
    expect((await post({ name: 'bar', food_id: mine, amount: 1, unit: 'piece' }, OTHER)).status).toBe(400);
    expect((await post({ name: '', food_id: mine, amount: 1, unit: 'piece' })).status).toBe(400);
    expect((await post({ name: 'bar', food_id: mine, amount: 0, unit: 'piece' })).status).toBe(400);
    expect((await post({ name: 'bar', food_id: 'nope', amount: 1, unit: 'piece' })).status).toBe(400);
  });

  it('drops a favorite whose custom food was deleted', async () => {
    const f = (await api('/foods', { method: 'POST', json: { name: 'Gone soon', per_100g: { ENERC_KCAL: 100 } } }, U)).data.id as string;
    await api('/foods/favorites', { method: 'POST', json: { name: 'Gone soon', food_id: f, amount: 1, unit: 'serving' } }, U);
    await api(`/foods/${f}`, { method: 'DELETE' }, U);
    expect((await api('/foods/favorites', {}, U)).data.map((x: any) => x.name)).not.toContain('Gone soon');
  });
});
