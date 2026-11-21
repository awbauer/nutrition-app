import { afterEach, describe, expect, it } from 'vitest';
import { amountLabel, fromMass, preferMass, setMassUnit, showsWeight, toMass, weight } from '../web/src/amounts';
import { api } from './helpers';

afterEach(() => setMassUnit('g'));

describe('Food amounts: g or oz', () => {
  it('shows food weights in grams by default', () => {
    expect(weight(170.4)).toBe('170 g');
    expect(amountLabel(170, 'g')).toBe('170 g');
    expect(preferMass(['g', 'oz'])).toEqual(['g', 'oz']);
    expect(preferMass(['g'])).toEqual(['g']);
    expect(preferMass(['ml', 'fl oz'])).toEqual(['ml', 'fl oz']);
  });

  it('shows and takes ounces when set, keeping grams underneath', () => {
    setMassUnit('oz');
    expect(weight(170)).toBe('6 oz');
    expect(weight(100)).toBe('3.5 oz');
    // An item stored in grams reads in ounces.
    expect(amountLabel(170, 'g')).toBe('6 oz');
    expect(amountLabel(2, '[oz_av]')).toBe('2 oz');
    expect(showsWeight('g')).toBe(true);
    expect(showsWeight('[oz_av]')).toBe(true);
    expect(showsWeight('[cup_us]')).toBe(false);
    // Typed ounces go back to grams.
    expect(fromMass(4)).toBeCloseTo(113.4, 1);
    expect(toMass(fromMass(4))).toBe(4);
    // The weight chip leads with ounces; grams stay available.
    expect(preferMass(['g', 'oz'])).toEqual(['oz', 'g']);
    expect(preferMass(['g'])).toEqual(['oz', 'g']);
    expect(preferMass(['ml', 'g'])).toEqual(['ml', 'oz', 'g']);
    expect(preferMass(['ml', 'fl oz'])).toEqual(['ml', 'fl oz']);
  });

  it('is saved as a setting and ignored by the stored amounts', async () => {
    const E = { DEV_USER_EMAIL: 'mass-unit@example.test' };
    expect((await api('/settings', { method: 'PUT', json: { mass_unit: 'oz' } }, E)).data.mass_unit).toBe('oz');
    expect((await api('/me', {}, E)).data.settings.mass_unit).toBe('oz');
    expect((await api('/settings', { method: 'PUT', json: { mass_unit: 'lb' } }, E)).status).toBe(400);
    const food = await api('/foods', { method: 'POST', json: { name: 'Oz test', per_100g: { ENERC_KCAL: 100 } } }, E);
    const meal = await api('/intake', { method: 'POST', json: { items: [{ food_id: food.data.id, amount: 4, unit: 'oz' }] } }, E);
    expect(meal.data.items[0].grams).toBeCloseTo(113.4, 1);
  });
});
