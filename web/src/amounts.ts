/**
 * Amounts as the user reads and types them: unit labels, plurals, and food weights in their
 * unit (Settings > Food amounts; the database always keeps grams). No app imports, so the worker's
 * tests can use it too.
 */

export type MassUnit = 'g' | 'oz';
export const G_PER_OZ = 28.3495;
let massUnit: MassUnit = 'g';
/** Set by App from the user's settings before it renders; every weight shown or typed follows it. */
export const setMassUnit = (u: MassUnit | undefined) => void (massUnit = u === 'oz' ? 'oz' : 'g');
export const getMassUnit = () => massUnit;
/** Grams as a number in the user's unit: whole grams, or ounces to a tenth. */
export const toMass = (g: number) => (massUnit === 'oz' ? Math.round((g / G_PER_OZ) * 10) / 10 : Math.round(g));
/** A number typed in the user's unit, back to grams. */
export const fromMass = (v: number) => (massUnit === 'oz' ? v * G_PER_OZ : v);
/** A food weight for display: "170 g" or "6 oz". */
export const weight = (g: number | undefined) => `${toMass(g ?? 0).toLocaleString()} ${massUnit}`;
/**
 * Exact units for a food with the user's weight unit first: ["g", "oz"] becomes ["oz", "g"] for an
 * ounces user, and a grams-only list (powders, spreads) gains ounces ahead of grams.
 */
export function preferMass(exact: string[]): string[] {
  const at = exact.findIndex((u) => u === 'g' || u === 'oz');
  if (at < 0) return exact;
  const other = massUnit === 'g' ? 'oz' : 'g';
  const rest = exact.filter((u) => u !== 'g' && u !== 'oz');
  rest.splice(at, 0, massUnit, ...(exact.includes(other) || massUnit === 'oz' ? [other] : []));
  return rest;
}

/** Whether amountLabel already shows this amount as a weight in the user's unit (then "· 170 g" after it says nothing new). */
export const showsWeight = (unit: string) => unit === 'g' || (massUnit === 'oz' && (unit === 'oz' || unit === '[oz_av]'));

const UNIT_LABEL: Record<string, string> = {
  '[cup_us]': 'cup',
  '[tbs_us]': 'tbsp',
  '[tsp_us]': 'tsp',
  '[oz_av]': 'oz',
  '[lb_av]': 'lb',
  '[foz_us]': 'fl oz',
  '[pt_us]': 'pint',
  '[qt_us]': 'quart',
  '[gal_us]': 'gallon',
  cL: 'cl',
  dL: 'dl',
};
export const unitLabel = (u: string) => UNIT_LABEL[u] ?? u;

const NO_PLURAL = new Set(['g', 'mL', 'kg', 'oz', 'lb', 'tbsp', 'tsp', 'fl oz', 'small', 'medium', 'large', 'L', 'ml', 'cl', 'dl']);
const PLURAL: Record<string, string> = {
  glass: 'glasses',
  piece: 'pieces',
  slice: 'slices',
  serving: 'servings',
  handful: 'handfuls',
  bowl: 'bowls',
  cup: 'cups',
  mug: 'mugs',
  plate: 'plates',
  scoop: 'scoops',
  can: 'cans',
  bottle: 'bottles',
  batch: 'batches',
  pint: 'pints',
  quart: 'quarts',
  gallon: 'gallons',
};

/** "1½ bowls", "2 handfuls", "170 g" (or "6 oz", per Food amounts), "1 medium". */
export function amountLabel(amount: number, unit: string): string {
  if (unit === 'g') return weight(amount);
  const u = unitLabel(unit);
  const whole = Math.floor(amount);
  const frac = amount - whole;
  const count = Math.abs(frac - 0.5) < 0.01 ? `${whole || ''}½` : Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100);
  // The food's own words ("cookie", "nugget") take a plain plural.
  const plural = PLURAL[u] ?? (/^[a-z]+$/.test(u) ? (/[^aeiou]y$/.test(u) ? u.slice(0, -1) + 'ies' : /(s|x|ch|sh)$/.test(u) ? u + 'es' : u + 's') : u);
  const word = amount > 1 && !NO_PLURAL.has(u) ? plural : u;
  return `${count} ${word}`;
}
