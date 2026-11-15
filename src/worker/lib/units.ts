/**
 * Serving-to-gram conversion (spec §12):
 * 1. the matched food's portions (USDA foodPortions),
 * 2. the food's default_serving_grams,
 * 3. a generic unit table.
 */
export interface Portion {
  label: string; // e.g. "cup, chopped", "slice", "medium"
  unit: string; // normalised household unit, e.g. "cup", "slice", "medium"
  amount: number; // how many `unit`s the gramWeight refers to
  grams: number;
}

const MASS: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 };
// Volume converted at water density; acceptable for drinks and most liquids.
const VOLUME_ML: Record<string, number> = {
  ml: 1,
  l: 1000,
  'fl oz': 29.5735,
  floz: 29.5735,
  cup: 240,
  tbsp: 15,
  tsp: 5,
};
const GENERIC_GRAMS: Record<string, number> = {
  slice: 30,
  piece: 50,
  small: 100,
  medium: 150,
  large: 200,
  serving: 100,
  handful: 30,
  bowl: 300,
  can: 355,
  bottle: 500,
  glass: 240,
  scoop: 30,
};

const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gr: 'g',
  kilogram: 'kg', kilograms: 'kg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', ml: 'ml', mL: 'ml',
  liter: 'l', liters: 'l', litre: 'l',
  cups: 'cup', c: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  slices: 'slice', pieces: 'piece', pc: 'piece', pcs: 'piece', each: 'piece', whole: 'piece', item: 'piece',
  servings: 'serving', portion: 'serving',
  sm: 'small', med: 'medium', lg: 'large',
};

export function normaliseUnit(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\.$/, '');
  return ALIASES[u] ?? ALIASES[unit.trim()] ?? u;
}

export function toGrams(
  amount: number,
  rawUnit: string,
  food?: { portions?: Portion[]; default_serving_grams?: number | null },
): { grams: number; method: 'mass' | 'portion' | 'default-serving' | 'volume' | 'generic' } {
  const unit = normaliseUnit(rawUnit);
  if (unit in MASS) return { grams: amount * MASS[unit]!, method: 'mass' };

  const portions = food?.portions ?? [];
  const portion =
    portions.find((p) => p.unit === unit) ??
    portions.find((p) => normaliseUnit(p.label.split(/[ ,(]/)[0] ?? '') === unit) ??
    (unit === 'serving' || unit === 'piece' ? portions[0] : undefined);
  if (portion && portion.amount > 0) return { grams: (amount * portion.grams) / portion.amount, method: 'portion' };

  if ((unit === 'serving' || unit === 'piece') && food?.default_serving_grams)
    return { grams: amount * food.default_serving_grams, method: 'default-serving' };

  if (unit in VOLUME_ML) return { grams: amount * VOLUME_ML[unit]!, method: 'volume' };
  if (unit in GENERIC_GRAMS) return { grams: amount * GENERIC_GRAMS[unit]!, method: 'generic' };
  if (food?.default_serving_grams) return { grams: amount * food.default_serving_grams, method: 'default-serving' };
  return { grams: amount * GENERIC_GRAMS.serving!, method: 'generic' };
}

/** UCUM-ish unit to store on consumed_item.amount_unit. */
export function ucum(rawUnit: string): string {
  const u = normaliseUnit(rawUnit);
  if (u === 'ml') return 'mL';
  if (u === 'l') return 'L';
  if (u === 'fl oz') return '[foz_us]';
  if (u === 'oz') return '[oz_av]';
  if (u === 'lb') return '[lb_av]';
  if (u === 'cup') return '[cup_us]';
  if (u === 'tbsp') return '[tbs_us]';
  if (u === 'tsp') return '[tsp_us]';
  return u;
}
