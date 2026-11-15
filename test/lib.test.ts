import { describe, expect, it } from 'vitest';
import { addDays, logDate, mealTypeForTime, localParts } from '../src/worker/lib/dates';
import { fromUsda } from '../src/worker/lib/nutrients';
import { toGrams, ucum } from '../src/worker/lib/units';
import { normaliseDetailFood, parsePortionText } from '../src/worker/lib/usda';
import { chickenDetail, foundationEgg } from './fixtures/usda';

describe('day boundary', () => {
  it('counts meals before the cutoff toward the previous day', () => {
    // 02:30 in New York on 15 Nov = 07:30Z
    expect(logDate('2026-11-15T07:30:00Z', 'America/New_York', '04:00')).toBe('2026-11-14');
    expect(logDate('2026-11-15T09:30:00Z', 'America/New_York', '04:00')).toBe('2026-11-15');
  });
  it('honours a midnight cutoff and other zones', () => {
    expect(logDate('2026-11-15T07:30:00Z', 'America/New_York', '00:00')).toBe('2026-11-15');
    expect(logDate('2026-11-15T23:30:00Z', 'Asia/Tokyo', '04:00')).toBe('2026-11-16');
  });
  it('local parts and helpers', () => {
    expect(localParts(new Date('2026-11-15T17:05:00Z'), 'America/Chicago')).toMatchObject({ date: '2026-11-15', time: '11:05', weekday: 0 });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(mealTypeForTime(8 * 60)).toBe('breakfast');
    expect(mealTypeForTime(12 * 60)).toBe('lunch');
    expect(mealTypeForTime(19 * 60)).toBe('dinner');
    expect(mealTypeForTime(15 * 60)).toBe('snack');
  });
});

describe('serving to grams', () => {
  const food = normaliseDetailFood(chickenDetail);
  it('uses mass units directly', () => {
    expect(toGrams(2, 'oz').grams).toBeCloseTo(56.7, 1);
    expect(toGrams(150, 'grams').grams).toBe(150);
  });
  it('prefers the food portion table', () => {
    expect(toGrams(1, 'cup', food)).toEqual({ grams: 140, method: 'portion' });
    expect(toGrams(0.5, 'cups', food).grams).toBe(70);
  });
  it('falls back to default serving, then generic table', () => {
    expect(toGrams(2, 'serving', { default_serving_grams: 40 })).toEqual({ grams: 80, method: 'default-serving' });
    expect(toGrams(1, 'cup').grams).toBe(240);
    expect(toGrams(1, 'slice').grams).toBe(30);
  });
  it('maps UCUM units', () => {
    expect(ucum('ml')).toBe('mL');
    expect(ucum('cups')).toBe('[cup_us]');
    expect(ucum('g')).toBe('g');
  });
  it('parses portion text', () => {
    expect(parsePortionText('1 cup, chopped')).toEqual({ amount: 1, unit: 'cup' });
    expect(parsePortionText('2 slices')).toEqual({ amount: 2, unit: 'slice' });
    expect(parsePortionText('1/2 cup')).toEqual({ amount: 0.5, unit: 'cup' });
  });
});

describe('USDA nutrient mapping', () => {
  it('maps ids to INFOODS codes', () => {
    const n = fromUsda([{ id: 1008, value: 165, unit: 'kcal' }, { id: 1003, value: 31, unit: 'g' }]);
    expect(n.find((x) => x.code === 'ENERC_KCAL')).toMatchObject({ value: 165, usdaId: 1008 });
    expect(n.find((x) => x.code === 'PROCNT')?.value).toBe(31);
  });
  it('falls back to Atwater energy for Foundation foods', () => {
    const egg = normaliseDetailFood(foundationEgg);
    expect(egg.nutrients.find((x) => x.code === 'ENERC_KCAL')).toMatchObject({ value: 148, usdaId: 2047 });
    expect(egg.portions[0]).toMatchObject({ unit: 'egg', grams: 50 });
  });
  it('converts kJ to kcal', () => {
    expect(fromUsda([{ id: 1008, value: 418.4, unit: 'kJ' }])[0]!.value).toBeCloseTo(100);
  });
});
