import { describe, expect, it } from 'vitest';
import { api } from './helpers';

const U = { DEV_USER_EMAIL: 'ai-weight@example.test' };

describe('an amount saved from the AI weight estimate', () => {
  it('keeps that weight per unit when the count changes', async () => {
    // No portions, so "small" would be the generic 100 g; the AI said this small banana is 80 g.
    const banana = (await api('/foods', { method: 'POST', json: { name: 'Banana test', per_100g: { ENERC_KCAL: 89 } } }, U)).data.id as string;
    const meal = await api('/intake', { method: 'POST', json: { meal_type: 'snack', items: [{ food_id: banana, amount: 1, unit: 'small', grams: 80 }] } }, U);
    const id = meal.data.items[0].id as string;

    const detail = await api(`/item/${id}`, {}, U);
    expect(detail.data.conversion).toMatchObject({ method: 'ai-estimate', grams_per_unit: 80, stored_grams: 80 });

    const two = await api(`/item/${id}`, { method: 'PATCH', json: { amount: 2, unit: 'small' } }, U);
    expect(two.data.items[0]).toMatchObject({ amount_value: 2, grams: 160 });
    expect(Math.round(two.data.items[0].nutrients.ENERC_KCAL)).toBe(142);

    // A different size has no estimate behind it: the size table decides.
    const big = await api(`/item/${two.data.items[0].id}`, { method: 'PATCH', json: { amount: 1, unit: 'large' } }, U);
    expect(big.data.items[0].grams).toBe(200);
  });
});
