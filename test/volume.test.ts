import { describe, expect, it } from 'vitest';
import { cupWeight, fromUcum, normaliseUnit, parsePortionText, toGrams, ucum } from '../src/worker/lib/units';
import { api } from './helpers';

describe('cups of foods lighter or heavier than water', () => {
  it('weighs a cup by the kind of food when it has no cup portion of its own', () => {
    // Before: 2 cups of lettuce were 480 g, a cup of popcorn 240 g.
    expect(toGrams(2, 'cups', { name: 'Lettuce, iceberg (includes crisphead types), raw' })).toEqual({
      grams: 144,
      method: 'density',
      per_cup: { what: 'iceberg lettuce', grams: 72 },
    });
    expect(toGrams(2, 'cup', { name: 'romaine lettuce' }).grams).toBe(94);
    expect(toGrams(1, 'cup', { name: 'Snacks, popcorn, air-popped' })).toMatchObject({ grams: 9, method: 'density' });
    expect(toGrams(1, 'cup', { name: 'Cereals ready-to-eat, corn flakes' })).toMatchObject({ grams: 35, method: 'density' });
    expect(toGrams(1, 'cup', { name: 'Rice, white, long-grain, regular, enriched, cooked' })).toMatchObject({ grams: 160, method: 'density' });
    expect(toGrams(1, 'cup', { name: 'Rice, white, long-grain, regular, raw, enriched' }).grams).toBe(185);
    // Liquids weigh the same however they're poured: a volume, not an estimate.
    expect(toGrams(1, 'cup', { name: 'Milk, whole, 3.25% milkfat' })).toMatchObject({ grams: 240, method: 'volume' });
    expect(toGrams(1, 'tbsp', { name: 'Oil, olive, salad or cooking' }).grams).toBeCloseTo(13.6, 1);
    expect(toGrams(1, 'tsp', { name: 'sugar' }).grams).toBeCloseTo(4.2, 1);
    // Unknown foods still convert at water density.
    expect(toGrams(1, 'cup', { name: 'mystery thing' })).toEqual({ grams: 240, method: 'volume' });
  });

  it('reads the user’s words, the head of a name and the category', () => {
    expect(cupWeight({ name: ['cereal with milk', 'Cereals ready-to-eat'] })?.what).toBe('dry cereal');
    expect(cupWeight({ name: 'Honey Nut Cheerios' })?.what).toBe('dry cereal');
    expect(cupWeight({ name: 'Almond milk, unsweetened' })?.what).toBe('milk, juice or water');
    expect(cupWeight({ name: 'Peanut butter, smooth' })?.what).toBe('nut butter');
    expect(cupWeight({ name: 'Spinach, cooked, boiled, drained' })?.grams).toBe(165);
    expect(cupWeight({ name: 'Spinach, raw' })?.grams).toBe(30);
    expect(cupWeight({ name: 'shredded cheddar' })?.grams).toBe(110);
    expect(cupWeight({ name: 'Blueberries, raw' })?.grams).toBe(145);
    expect(cupWeight({ name: 'Romaine', category: 'Lettuce and lettuce salads' })?.what).toBe('leafy greens');
    expect(cupWeight({ name: 'butter chicken' })).toBeNull();
  });

  it("prefers the food's own volume portions, for every measure", () => {
    const chicken = { name: 'chicken', portions: [{ label: '1 cup, chopped', unit: 'cup', amount: 1, grams: 140 }] };
    expect(toGrams(1, 'cup', chicken)).toEqual({ grams: 140, method: 'portion' });
    expect(toGrams(2, 'tbsp', chicken)).toEqual({ grams: 17.5, method: 'portion' });
    expect(toGrams(1, 'bowl', chicken).grams).toBe(210);
    // A bowl of a food with no known density stays the generic bowl.
    expect(toGrams(1, 'bowl', { name: 'mystery thing' })).toEqual({ grams: 300, method: 'generic' });
    expect(toGrams(1, 'bowl', { name: 'Cereals ready-to-eat' }).grams).toBe(52.5);
  });
});

describe('US liquid measures and metric volumes', () => {
  it('converts pints, quarts, gallons, cl and dl', () => {
    expect(toGrams(1, 'pint').grams).toBeCloseTo(473.2, 1);
    expect(toGrams(2, 'pints').grams).toBeCloseTo(946.4, 1);
    expect(toGrams(1, 'qt').grams).toBeCloseTo(946.4, 1);
    expect(toGrams(1, 'quart').grams).toBeCloseTo(946.4, 1);
    expect(toGrams(0.5, 'gallon').grams).toBeCloseTo(1892.7, 1);
    expect(toGrams(1, 'gal').grams).toBeCloseTo(3785.4, 1);
    expect(toGrams(33, 'cl').grams).toBe(330);
    expect(toGrams(2, 'dl').grams).toBe(200);
    expect(toGrams(5, 'centilitres').grams).toBe(50);
    // Through the same density logic: a pint of ice cream isn't a pint of water.
    expect(toGrams(1, 'pint', { name: 'Ice cream, vanilla' }).grams).toBeCloseTo(260.2, 1);
  });

  it('parses every spelling of fluid ounces', () => {
    for (const u of ['fl oz', 'fl. oz', 'fl.oz', 'fl.oz.', 'Fl. Oz.', 'floz', 'fluid ounce', 'fluid ounces']) expect(normaliseUnit(u), u).toBe('fl oz');
    expect(toGrams(8, 'fl. oz').grams).toBeCloseTo(236.6, 1);
    expect(parsePortionText('8 fl oz (240 ml)')).toEqual({ amount: 8, unit: 'fl oz' });
    expect(parsePortionText('12 fl. oz')).toEqual({ amount: 12, unit: 'fl oz' });
    // A labelled serving in fluid ounces is a volume portion for the other measures.
    const drink = { portions: [{ label: '8 fl oz (240ml)', unit: 'serving', amount: 1, grams: 248 }] };
    expect(toGrams(16, 'fl oz', drink).grams).toBe(496);
  });

  it('stores and reads back the new units', () => {
    for (const u of ['pint', 'quart', 'gallon', 'cl', 'dl']) expect(fromUcum(ucum(u))).toBe(u);
    expect(ucum('pints')).toBe('[pt_us]');
    expect(ucum('dl')).toBe('dL');
  });
});

describe('logging a cup of a light food', () => {
  it('weighs it from the cup table, marks it as an estimate and explains it in Food details', async () => {
    const E = { DEV_USER_EMAIL: 'cups@example.test' };
    const food = await api('/foods', { method: 'POST', json: { name: 'Iceberg lettuce test', per_100g: { ENERC_KCAL: 14 } } }, E);
    const meal = await api('/intake', { method: 'POST', json: { items: [{ food_id: food.data.id, amount: 2, unit: 'cups' }] } }, E);
    expect(meal.status).toBe(201);
    const item = meal.data.items[0];
    expect(item).toMatchObject({ grams: 144, amount_unit: '[cup_us]', confidence: 0.7 });
    const detail = await api(`/item/${item.id}`, {}, E);
    expect(detail.data.conversion).toMatchObject({ method: 'density', stored_grams: 144, per_cup: { what: 'iceberg lettuce', grams: 72 } });
    // Editing the amount in Food details goes through the same table.
    const three = await api(`/item/${item.id}`, { method: 'PATCH', json: { amount: 3, unit: 'cup' } }, E);
    expect(three.data.items[0]).toMatchObject({ grams: 216, confidence: 0.7 });
    // Grams typed in are exact.
    const weighed = await api(`/item/${three.data.items[0].id}`, { method: 'PATCH', json: { amount: 100, unit: 'g' } }, E);
    expect(weighed.data.items[0]).toMatchObject({ grams: 100, confidence: 1 });
    // Milk by the cup is a plain volume: no cap.
    const milk = await api('/foods', { method: 'POST', json: { name: 'Milk test', per_100g: { ENERC_KCAL: 61 } } }, E);
    const glass = await api('/intake', { method: 'POST', json: { items: [{ food_id: milk.data.id, amount: 1, unit: 'pint' }] } }, E);
    expect(glass.data.items[0]).toMatchObject({ amount_unit: '[pt_us]', confidence: 1 });
    expect(glass.data.items[0].grams).toBeCloseTo(473.2, 1);
  });
});
