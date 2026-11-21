import { describe, expect, it } from 'vitest';
import { addDays, logDate, mealTypeForTime, localParts } from '../src/worker/lib/dates';
import { fromUsda } from '../src/worker/lib/nutrients';
import { countUnit, EXACT_UNITS, foodKind, normaliseUnit, sizesFor, toGrams, ucum, withCounts, type Portion } from '../src/worker/lib/units';
import { normaliseDetailFood, parsePortionText } from '../src/worker/lib/usda';
import { normaliseOff } from '../src/worker/lib/off';
import { chickenDetail, foundationEgg } from './fixtures/usda';
import { logToday, occurrenceFor } from '../web/src/today';

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
  it('compares with the cutoff on the local clock on the days clocks change', () => {
    const tz = 'America/New_York';
    // 04:30 EDT on the spring-forward day is after the cutoff; 03:30 EST on the fall-back day is before it.
    expect(logDate('2026-03-08T08:30:00Z', tz, '04:00')).toBe('2026-03-08');
    expect(logDate('2026-11-01T08:30:00Z', tz, '04:00')).toBe('2026-10-31');
    expect(logDate('2026-06-10T07:59:00Z', tz, '04:00')).toBe('2026-06-09');
    expect(logDate('2026-06-10T08:00:00Z', tz, '04:00')).toBe('2026-06-10');
    // The web app's "today" agrees with the server.
    for (const iso of ['2026-03-08T08:30:00Z', '2026-11-01T08:30:00Z', '2026-06-10T07:59:00Z', '2026-06-10T08:00:00Z', '2026-06-10T04:30:00Z'])
      expect(logToday(tz, '04:00', new Date(iso))).toBe(logDate(iso, tz, '04:00'));
  });
  it('logs entries for today (the log date, even before the cutoff) at the real time', () => {
    // 00:30 before a 04:00 cutoff: the log date is yesterday's calendar date, and it's still "now".
    expect(occurrenceFor('2026-06-09', '2026-06-09')).toBeUndefined();
    expect(occurrenceFor('2026-06-08', '2026-06-09')).toBe(new Date('2026-06-08T12:00:00').toISOString());
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
  it('reads plurals of aliased spellings ("litres" is litres, not 2 generic servings)', () => {
    expect(normaliseUnit('litres')).toBe('l');
    expect(normaliseUnit('millilitres')).toBe('ml');
    expect(toGrams(2, 'litres').grams).toBe(2000);
    expect(toGrams(250, 'millilitres').grams).toBe(250);
  });
  it('converts the UCUM codes items are stored with', () => {
    expect(toGrams(2, '[oz_av]').grams).toBeCloseTo(56.7, 1);
    expect(toGrams(1, '[cup_us]', food)).toEqual({ grams: 140, method: 'portion' });
    expect(toGrams(1, '[tbs_us]').grams).toBe(15);
    expect(toGrams(1, '[foz_us]').grams).toBeCloseTo(29.6, 1);
    for (const u of ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'fl oz', 'ml', 'l', 'slice']) expect(normaliseUnit(ucum(u))).toBe(normaliseUnit(u));
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
  it('counts pieces of a labelled multi-item serving one at a time', () => {
    // Branded Oreos: one serving is "2 cookies (36g)".
    const oreo = { portions: [{ label: '2 cookies (36g)', unit: 'serving', amount: 1, grams: 36 }], default_serving_grams: 36 };
    expect(toGrams(3, 'piece', oreo).grams).toBe(54);
    expect(toGrams(3, 'cookies', oreo).grams).toBe(54);
    expect(toGrams(1.5, 'serving', oreo).grams).toBe(54);
    expect(countUnit(oreo.portions)).toBe('cookie');
    // The model sometimes writes a placeholder for a bare count.
    expect(toGrams(3, 'none', oreo).grams).toBe(54);
    expect(toGrams(3, 'None', oreo).grams).toBe(54);
    expect(toGrams(2, 'count', oreo).grams).toBe(36);
    // Each food's own label sets the size: a different brand's cookie isn't an Oreo's.
    expect(toGrams(3, 'cookies', { portions: [{ label: '1 cookie (85g)', unit: 'serving', amount: 1, grams: 85 }] }).grams).toBe(255);
    expect(countUnit([{ label: '1 medium', unit: 'medium', amount: 1, grams: 118 }])).toBeNull();
    expect(withCounts(oreo.portions)).toContainEqual({ label: 'cookie', unit: 'cookie', amount: 2, grams: 36 });
    // A measure in the label is a portion too; a weight in it adds nothing.
    expect(toGrams(1, 'tbsp', { portions: [{ label: '1/4 cup', unit: 'serving', amount: 1, grams: 58 }] }).grams).toBe(15);
    expect(toGrams(1, 'cup', { portions: [{ label: '1/4 cup', unit: 'serving', amount: 1, grams: 58 }] }).grams).toBe(232);
    expect(withCounts([{ label: '28 g', unit: 'serving', amount: 1, grams: 28 }])).toHaveLength(1);
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
    const n = fromUsda([
      { id: 1008, value: 165, unit: 'kcal' },
      { id: 1003, value: 31, unit: 'g' },
    ]);
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

describe('amount chips by food', () => {
  const kind = (name: string | string[], category: string | null = null, portions: Portion[] = []) => foodKind({ name, category, portions });
  it('goes by the USDA category when it is specific', () => {
    expect(kind('COLA', 'Soda')).toBe('can-drink');
    expect(kind('Coffee, Latte, nonfat', 'Coffee')).toBe('hot-drink');
    expect(kind('Coffee, Iced Latte', 'Coffee')).toBe('drink');
    expect(kind('Wine, red', 'Wine')).toBe('wine');
    expect(kind('Vodka', 'Liquor and cocktails')).toBe('spirit');
    expect(kind('LEMONADE', 'Powdered Drinks')).toBe('powder');
    expect(kind('CHICKEN NOODLE SOUP', 'Canned Soup')).toBe('soup');
    expect(kind('OLIVE OIL', 'Vegetable & Cooking Oils')).toBe('spread');
    expect(kind('ALMONDS', 'Popcorn, Peanuts, Seeds & Related Snacks')).toBe('bits');
    expect(kind('GRANOLA', 'Cereal')).toBe('bowl');
    expect(kind('CHEDDAR CHEESE', 'Cheese')).toBe('sliced');
    expect(kind('Potato, french fries, NFS', 'French fries and other fried white potatoes')).toBe('whole');
    expect(kind('Chicken breast, roasted', 'Chicken, whole pieces')).toBe('protein');
    // The category knows what a flavour-named product is.
    expect(kind('COFFEE', 'Other Frozen Desserts')).toBe('bowl');
    expect(kind('BANANA', 'Nut & Seed Butters')).toBe('spread');
    expect(kind('Peanut butter', 'Nuts and seeds')).toBe('spread');
  });
  it('lets the name decide within broad food groups', () => {
    expect(kind('Milk, whole, 3.25% milkfat', 'Dairy and Egg Products')).toBe('drink');
    expect(kind('Cheese, cheddar', 'Dairy and Egg Products')).toBe('sliced');
    expect(kind('Butter, salted', 'Dairy and Egg Products')).toBe('spread');
    expect(kind('Bananas, raw', 'Fruits and Fruit Juices')).toBe('whole');
    expect(kind("APPLEBEE'S, french fries", 'Restaurant Foods')).toBe('whole');
    expect(kind('Beverages, coffee, brewed', 'Beverages')).toBe('hot-drink');
    expect(kind('Beverages, coffee, instant, powder', 'Beverages')).toBe('powder');
  });
  it('reads Open Food Facts tags from the most specific', () => {
    expect(kind('Fizzy', 'beverages > carbonated drinks > sodas > colas')).toBe('can-drink');
    expect(kind('Crunchy', 'plant based foods > snacks > salty snacks > crisps')).toBe('bits');
  });
  it('falls back to the name without a category', () => {
    expect(kind('oat latte')).toBe('hot-drink');
    expect(kind('Sparkling Lime', null, [{ label: '12 fl oz', unit: 'fl oz', amount: 12, grams: 355 }])).toBe('can-drink');
    expect(kind('Fish, tuna, light, canned in water')).toBe('protein');
    expect(kind('Pasta, cooked, enriched, with added salt')).toBe('bowl');
    expect(kind('toast with butter')).toBe('sliced');
    expect(kind('butter chicken')).toBe('bowl');
    expect(kind('chicken noodle soup')).toBe('soup');
    expect(kind(['my usual', 'Quinoa, cooked'])).toBe('bowl');
  });
  it('offers volume units for drinks and a short list for food', () => {
    expect(sizesFor({ name: 'COFFEE', category: 'Coffee' })).toMatchObject({ exact: ['ml', 'fl oz'], sizes: ['mug', 'cup'] });
    expect(sizesFor({ name: 'COLA', category: 'Soda' }).sizes).toEqual(['can', 'bottle', 'glass']);
    expect(sizesFor({ name: 'Olive oil' })).toMatchObject({ exact: ['g'], sizes: ['tbsp', 'tsp', 'cup'] });
    expect(sizesFor({ name: 'Mystery dish' }).sizes.length).toBeLessThanOrEqual(5);
  });
  it('reads the category from each USDA shape and from Open Food Facts', () => {
    expect(
      normaliseDetailFood({ fdcId: 1, description: 'Coffee, Latte', dataType: 'Survey (FNDDS)', wweiaFoodCategory: { wweiaFoodCategoryDescription: 'Coffee' } }).category,
    ).toBe('Coffee');
    expect(normaliseDetailFood({ fdcId: 2, description: 'COLA', dataType: 'Branded', brandedFoodCategory: 'Soda' }).category).toBe('Soda');
    expect(normaliseDetailFood({ fdcId: 3, description: 'Food', dataType: 'Foundation' }).category).toBeNull();
    const off = normaliseOff('5000112637922', { product_name: 'Cola', categories_hierarchy: ['en:beverages', 'en:carbonated-drinks', 'en:sodas', 'fr:boissons'] });
    expect(off.category).toBe('beverages > carbonated drinks > sodas');
    expect(foodKind({ name: off.name, category: off.category })).toBe('can-drink');
  });
  it('converts exact units the way the editor does', () => {
    expect(toGrams(12, 'fl oz').grams).toBeCloseTo(EXACT_UNITS['fl oz']!.grams * 12, 5);
    expect(toGrams(330, 'ml').grams).toBe(330);
    expect(toGrams(1, 'shot').grams).toBe(44);
  });
});

describe('slice weights by food', () => {
  it('weighs a slice of bacon, cheese or bread differently when the food has no slice portion', async () => {
    const { toGrams } = await import('../src/worker/lib/units');
    const guideline = [{ label: '1 guideline amount per slice of bread', unit: 'guideline', amount: 1, grams: 16 }];
    expect(toGrams(2, 'slices', { name: 'Bacon, for use on a sandwich', portions: guideline as any }).grams).toBe(16);
    expect(toGrams(1, 'slice', { name: 'Cheese, American' }).grams).toBe(21);
    expect(toGrams(1, 'slice', { name: 'Bread, white' }).grams).toBe(30);
    expect(toGrams(1, 'slice', { name: 'Bacon', portions: [{ label: '1 slice', unit: 'slice', amount: 1, grams: 9 }] as any }).grams).toBe(9);
  });
});
