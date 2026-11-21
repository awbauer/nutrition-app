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
// Volumes in ml. The cup is the 240 ml nutrition-label cup, and the spoons follow it (16 tbsp, 48 tsp),
// so a food's grams per cup (CUP_GRAMS, its own portions) scales cleanly to every other measure.
const VOLUME_ML: Record<string, number> = {
  ml: 1,
  l: 1000,
  'fl oz': 29.5735,
  floz: 29.5735,
  cup: 240,
  tbsp: 15,
  tsp: 5,
};
const CUP_ML = VOLUME_ML.cup!;
/** A bowl, when the food's grams per cup are known: about a cup and a half (cereal, soup, rice). */
const BOWL_CUPS = 1.5;

/**
 * Grams in one cup for foods that weigh very differently from water, from USDA SR Legacy / FNDDS cup
 * portions. Used for any volume (and a bowl) when the food has no volume portion of its own: without
 * it 2 cups of lettuce came out at 480 g. First match wins, so liquids come first ("almond milk",
 * "oat milk") and light dry foods before the words in their names ("honey nut cheerios", "rice
 * krispies"). `and`: must also match. `exact`: it pours or packs the same every time (liquids,
 * yogurt, sugar); the rest depend on how it's cut and packed, so they're estimates.
 */
const COOKED = /\b(cooked|boiled|steamed|sauteed|sautéed|roasted|braised|creamed|frozen)\b/;
interface CupWeight {
  what: string;
  re: RegExp;
  and?: RegExp;
  not?: RegExp;
  g: number;
  exact?: true;
}
const CUP_GRAMS: CupWeight[] = [
  {
    what: 'milk, juice or water',
    re: /\b(milk|juice|water|broth|stock|coffee|tea|soda|beer|wine|kefir|smoothie|shake|lemonade|drink|beverage)s?\b/,
    not: /\b(milk chocolate|powder(ed)?|dry|condensed|evaporated|in water|packed in)\b/,
    g: 240,
    exact: true,
  },
  { what: 'soup or stew', re: /\b(soup|stew|chili|chowder|bisque|curry|dal)s?\b/, g: 245, exact: true },
  { what: 'yogurt', re: /\byogh?urts?\b/, not: /\bfrozen\b/, g: 245, exact: true },
  { what: 'sauce or dip', re: /\b(sauce|applesauce|salsa|gravy|dressing|hummus|guacamole|dip)s?\b/, g: 250, exact: true },
  // Light and dry: a cup weighs a fraction of a cup of water.
  { what: 'popcorn', re: /\bpopcorn\b/, g: 9 },
  { what: 'puffed cereal', re: /\bpuffed\b/, g: 14 },
  { what: 'granola', re: /\bgranola\b/, g: 110 },
  { what: 'muesli', re: /\bmuesli\b/, g: 85 },
  { what: 'cooked oatmeal', re: /\b(oatmeal|porridge|overnight oats)\b/, not: /\b(dry|uncooked|cookies?)\b/, g: 234, exact: true },
  { what: 'rolled oats', re: /\boats\b/, g: 81 },
  { what: 'dry cereal', re: /\b(cereals?|flakes|cheerios|chex|krispies|bran)\b/, g: 35 },
  { what: 'flour', re: /\bflour\b/, g: 125 },
  // Vegetables: leafy ones are mostly air; cooked ones collapse.
  { what: 'cooked greens', re: /\b(spinach|kale|chard|collards?|greens)\b/, and: COOKED, g: 165 },
  { what: 'iceberg lettuce', re: /\biceberg\b/, g: 72 },
  { what: 'leafy greens', re: /\b(lettuce|romaine|greens|spring mix|mesclun|salad mix|green salad|side salad|garden salad)\b/, g: 47 },
  { what: 'raw spinach or kale', re: /\b(spinach|kale|chard|arugula|rocket|watercress)\b/, g: 30 },
  { what: 'mushrooms', re: /\bmushrooms?\b/, g: 70 },
  {
    what: 'cooked vegetables',
    re: /\b(broccoli|cauliflower|cabbage|green beans?|brussels sprouts|carrots?|zucchini|squash|peppers?|asparagus|vegetables|veggies)\b/,
    and: COOKED,
    g: 155,
  },
  {
    what: 'chopped raw vegetables',
    re: /\b(broccoli|cauliflower|cabbage|green beans?|snap peas|brussels sprouts|carrots?|celery|cucumbers?|zucchini|squash|peppers?|radish(es)?|asparagus|vegetables|veggies)\b/,
    g: 110,
  },
  { what: 'chopped onion, tomato, corn or peas', re: /\b(onions?|tomato(es)?|corn|peas)\b/, g: 155 },
  // Fruit.
  { what: 'berries or grapes', re: /\b(berries|blueberries|raspberries|strawberries|blackberries|grapes|cherries)\b/, g: 145 },
  { what: 'raisins or dried fruit', re: /\b(raisins|dried fruit|dates|dried cranberries)\b/, g: 150 },
  { what: 'chopped fruit', re: /\b(fruit salad|fruit|melon|cantaloupe|honeydew|watermelon|pineapple|mango|papaya)\b/, g: 160 },
  // Grains and starches: cooked unless the name says otherwise, as people log them.
  { what: 'uncooked rice', re: /\brice\b/, and: /\b(raw|dry|uncooked)\b/, g: 185 },
  { what: 'cooked brown rice', re: /\b(brown|wild) rice\b/, g: 195 },
  { what: 'cooked rice', re: /\brice\b/, g: 160 },
  { what: 'cooked pasta', re: /\b(pasta|spaghetti|macaroni|penne|fusilli|linguine|noodles?)\b/, g: 140 },
  { what: 'cooked grains', re: /\b(quinoa|couscous|bulgur|barley|farro)\b/, g: 170 },
  { what: 'cooked beans or lentils', re: /\b(beans|lentils|chickpeas|garbanzos?)\b/, g: 175 },
  { what: 'mashed potatoes', re: /\bmashed\b/, g: 210 },
  // Dairy, fats, sweets, nuts.
  { what: 'cottage cheese, ricotta or cream cheese', re: /\b(cottage cheese|ricotta|cream cheese)\b/, g: 230 },
  { what: 'shredded cheese', re: /\b(shredded|grated)\b.*\b(cheese|cheddar|mozzarella|parmesan)\b|\bparmesan\b/, g: 110 },
  { what: 'diced cheese', re: /\b(cheese|cheddar|mozzarella|swiss|feta)\b/, g: 132 },
  { what: 'ice cream', re: /\b(ice cream|gelato|frozen yogh?urt)\b/, g: 132 },
  { what: 'oil', re: /\boils?\b/, not: /\b(in oil|packed)\b/, g: 218, exact: true },
  { what: 'nut butter', re: /\b(peanut|almond|cashew|nut|seed|sunflower) butter\b|\btahini\b/, g: 258 },
  { what: 'butter', re: /\b(butter|margarine|ghee)\b/, not: /\b(chicken|lettuce|beans?|cookies?|cake|croissant)\b/, g: 227, exact: true },
  { what: 'honey or syrup', re: /\b(honey|syrup|molasses|agave)\b/, g: 330, exact: true },
  { what: 'brown sugar', re: /\bbrown sugar\b/, g: 220, exact: true },
  { what: 'powdered sugar', re: /\b(powdered|icing|confectioners'?) sugar\b/, g: 120, exact: true },
  { what: 'sugar', re: /\bsugar\b/, not: /\b(free|substitute|snap)\b/, g: 200, exact: true },
  { what: 'chocolate chips', re: /\bchocolate chips\b/, g: 170 },
  { what: 'walnuts or pecans', re: /\b(walnuts?|pecans?)\b/, g: 110 },
  { what: 'nuts or seeds', re: /\b(nuts?|almonds?|cashews?|peanuts?|pistachios?|hazelnuts?|macadamias?|seeds|trail mix)\b/, g: 140 },
];

/**
 * Grams per cup from the table for a food, by its names (the user's words, then the database name)
 * and source category; the head of each name first ("cereal with milk" is cereal). Null: not in the table.
 */
export function cupWeight(food: { name?: string | string[] | null; category?: string | null }): { what: string; grams: number; exact: boolean } | null {
  const names = [food.name ?? []].flat().filter((n): n is string => !!n);
  const texts = [...names.map((n) => n.split(/\s(?:with|and|in|on|&)\s/i)[0]!), ...names, food.category ?? ''].map((t) => t.toLowerCase().replace(/[,()]/g, ' ')).filter(Boolean);
  for (const t of texts) {
    const hit = CUP_GRAMS.find((e) => e.re.test(t) && (!e.and || e.and.test(t)) && !e.not?.test(t));
    if (hit) return { what: hit.what, grams: hit.g, exact: !!hit.exact };
  }
  return null;
}
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
  mug: 300,
  plate: 350,
  shot: 44,
};

/**
 * A slice weighs very different amounts by food: used when the food has no slice portion of its own
 * (generic 30 g is a slice of bread; a cooked bacon slice is about 8 g). First match wins.
 */
const SLICE_GRAMS: [RegExp, number][] = [
  [/\bturkey bacon\b|\bbacon,? turkey\b/, 15],
  [/\bcanadian bacon\b/, 23],
  [/\bbacon\b/, 8],
  [/\b(pepperoni)\b/, 2],
  [/\b(salami|prosciutto|chorizo)\b/, 10],
  [/\bamerican\b.*\bcheese\b|\bcheese\b.*\bamerican\b|\bprocess(ed)? cheese\b/, 21],
  [/\bcheese\b/, 25],
  [/\b(ham|turkey|chicken|roast beef|bologna|deli|cold cut|luncheon)\b/, 28],
  [/\btomato\b/, 20],
  [/\bonion\b/, 15],
  [/\b(pizza)\b/, 110],
  [/\b(cake|pie|cheesecake|quiche|lasagna)\b/, 110],
  [/\b(watermelon|cantaloupe|melon|pineapple)\b/, 150],
];

/** Grams in one slice of a food without a slice portion (null: use the generic weight). */
export function sliceGrams(name: string | null | undefined): number | null {
  const n = (name ?? '').toLowerCase();
  return SLICE_GRAMS.find(([re]) => re.test(n))?.[1] ?? null;
}

const ALIASES: Record<string, string> = {
  gram: 'g',
  grams: 'g',
  gr: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  ml: 'ml',
  mL: 'ml',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  cups: 'cup',
  c: 'cup',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbs: 'tbsp',
  tbl: 'tbsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  slices: 'slice',
  pieces: 'piece',
  pc: 'piece',
  pcs: 'piece',
  each: 'piece',
  whole: 'piece',
  item: 'piece',
  servings: 'serving',
  portion: 'serving',
  handfuls: 'handful',
  bowls: 'bowl',
  bowlful: 'bowl',
  glasses: 'glass',
  mugs: 'mug',
  plates: 'plate',
  scoops: 'scoop',
  cans: 'can',
  bottles: 'bottle',
  shots: 'shot',
  sm: 'small',
  med: 'medium',
  lg: 'large',
  // Placeholders a model writes for a bare count ("3 oreos" -> unit "none"): it's a number of pieces.
  none: 'piece',
  null: 'piece',
  count: 'piece',
  counts: 'piece',
  unit: 'piece',
  units: 'piece',
  ea: 'piece',
  x: 'piece',
  '': 'piece',
  // The UCUM codes items are stored with (see ucum()), when a stored unit is converted again.
  '[oz_av]': 'oz',
  '[lb_av]': 'lb',
  '[cup_us]': 'cup',
  '[tbs_us]': 'tbsp',
  '[tsp_us]': 'tsp',
  '[foz_us]': 'fl oz',
};

const KNOWN = new Set([...Object.keys(MASS), ...Object.keys(VOLUME_ML), ...Object.keys(GENERIC_GRAMS)]);

export function normaliseUnit(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\.$/, '');
  const alias = ALIASES[u] ?? ALIASES[unit.trim()];
  if (alias || KNOWN.has(u)) return alias ?? u;
  // Counted things in the food's own words: "cookies" -> "cookie", "patties" -> "patty".
  if (/(?:patt|pastr|berr|cand|jell|gumm)ies$/.test(u)) return u.slice(0, -3) + 'y';
  // A plural of a known spelling ("litres", "millilitres") is that unit.
  if (/^[a-z]{3,}[^s]s$/.test(u)) return ALIASES[u.slice(0, -1)] ?? u.slice(0, -1);
  return u;
}

/** Parse "1 cup, chopped" / "2 slices" / "3 cookies (34g)" into {amount, unit}. */
export function parsePortionText(text: string): { amount: number; unit: string } {
  const m = /^\s*(\d+\s+\d\/\d|\d+(?:[./]\d+)?)?\s*(.*)$/.exec(text) ?? [];
  const num = m[1] ? evalFraction(m[1]) : 1;
  const unitWord = (m[2] ?? '').split(/[ ,(]/)[0] ?? '';
  return { amount: num || 1, unit: normaliseUnit(unitWord || 'serving') };
}

function evalFraction(s: string): number {
  return s
    .trim()
    .split(/\s+/)
    .reduce((acc, p) => {
      if (p.includes('/')) {
        const [a, b] = p.split('/').map(Number);
        return acc + (b ? a! / b : 0);
      }
      return acc + Number(p);
    }, 0);
}

/**
 * The food's portions plus the household measure hidden in a labelled serving: branded foods
 * only say "1 serving = 36 g" with the text "2 cookies (36g)", which also means 1 cookie = 18 g.
 */
export function withCounts(portions: Portion[]): Portion[] {
  const out = [...portions];
  for (const p of portions) {
    if (p.unit !== 'serving' || p.amount <= 0) continue;
    const parsed = parsePortionText(p.label);
    if (parsed.unit === 'serving' || parsed.unit in MASS || !/^[a-z][a-z ]*$/.test(parsed.unit)) continue;
    if (out.some((x) => x.unit === parsed.unit)) continue;
    out.push({ label: parsed.unit, unit: parsed.unit, amount: parsed.amount, grams: p.grams / p.amount });
  }
  return out;
}

/** A portion counted in whole things (cookie, breast, medium), not a serving or a measure. */
const isCounted = (p: Portion) => p.unit !== 'serving' && !(p.unit in VOLUME_ML) && !(p.unit in MASS);

/** The food's own word for one of it ("cookie"), for items counted as pieces. */
export function countUnit(portions: Portion[]): string | null {
  // Only a count read from the food's own serving label ("2 cookies"); a "1 medium" portion
  // shouldn't turn "2 pieces" of banana into "2 mediums".
  const derived = withCounts(portions).slice(portions.length);
  const p = derived.find((x) => isCounted(x) && x.unit !== 'piece' && !(x.unit in GENERIC_GRAMS) && /^[a-z]+$/.test(x.unit));
  return p?.unit ?? null;
}

export interface FoodForGrams {
  /** The user's words and/or the database name; used to look up slice weights and grams per cup. */
  name?: string | string[] | null;
  category?: string | null;
  portions?: Portion[];
  default_serving_grams?: number | null;
}

export interface Conversion {
  grams: number;
  /** `volume`: at the density of a liquid (water, or a known one like oil); `density`: a dry or packed food's typical cup, an estimate. */
  method: 'mass' | 'portion' | 'default-serving' | 'volume' | 'density' | 'generic';
  /** The cup-weight table entry used for a volume, to explain it. */
  per_cup?: { what: string; grams: number };
}

export function toGrams(amount: number, rawUnit: string, food?: FoodForGrams): Conversion {
  const unit = normaliseUnit(rawUnit);
  if (unit in MASS) return { grams: amount * MASS[unit]!, method: 'mass' };

  const portions = withCounts(food?.portions ?? []);
  const portion =
    portions.find((p) => p.unit === unit) ??
    portions.find((p) => normaliseUnit(p.label.split(/[ ,(]/)[0] ?? '') === unit) ??
    // A piece is one of the things counted ("3 Oreos" is 3 cookies, not 3 servings of 2 cookies).
    (unit === 'piece' ? portions.find(isCounted) : undefined) ??
    (unit === 'serving' || unit === 'piece' ? portions[0] : undefined);
  if (portion && portion.amount > 0) return { grams: (amount * portion.grams) / portion.amount, method: 'portion' };

  if ((unit === 'serving' || unit === 'piece') && food?.default_serving_grams) return { grams: amount * food.default_serving_grams, method: 'default-serving' };

  // A volume the food has no portion for: its density from another volume portion it has ("1/4 cup =
  // 58 g" makes a tbsp 14.5 g), else a typical cup of that kind of food, else water. A bowl is a
  // volume too once the food's density is known; otherwise it stays the generic bowl below.
  if (unit in VOLUME_ML || unit === 'bowl') {
    const ml = unit === 'bowl' ? BOWL_CUPS * CUP_ML : VOLUME_ML[unit]!;
    const own = portions.find((p) => p.unit in VOLUME_ML && p.amount > 0 && p.grams > 0);
    if (own) return { grams: (amount * ml * own.grams) / (own.amount * VOLUME_ML[own.unit]!), method: 'portion' };
    const cup = cupWeight(food ?? {});
    if (cup) return { grams: (amount * ml * cup.grams) / CUP_ML, method: cup.exact ? 'volume' : 'density', per_cup: { what: cup.what, grams: cup.grams } };
    if (unit !== 'bowl') return { grams: amount * ml, method: 'volume' };
  }
  const perSlice = unit === 'slice' ? sliceGrams([food?.name ?? []].flat().join(' ')) : null;
  if (perSlice) return { grams: amount * perSlice, method: 'generic' };
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

/**
 * Units typed as an exact number in the amount editor, with grams per unit
 * (volume at water density; the editor converts between them with toGrams, which knows the food). Everything else is a counted size.
 */
export const EXACT_UNITS: Record<string, { label: string; suffix: string; grams: number; step: number }> = {
  g: { label: 'Grams', suffix: 'g', grams: 1, step: 1 },
  oz: { label: 'Ounces', suffix: 'oz', grams: MASS.oz!, step: 0.5 },
  ml: { label: 'ml', suffix: 'ml', grams: 1, step: 1 },
  'fl oz': { label: 'Fl oz', suffix: 'fl oz', grams: VOLUME_ML['fl oz']!, step: 0.5 },
};

/** Chip labels for counted sizes; the UI reads this so its preview matches the server's grams. */
export const SIZE_LABEL: Record<string, string> = {
  handful: 'Handful',
  bowl: 'Bowl',
  glass: 'Glass',
  mug: 'Mug',
  plate: 'Plate',
  cup: 'Cup',
  slice: 'Slice',
  piece: 'Piece',
  tbsp: 'Tbsp',
  tsp: 'Tsp',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  can: 'Can',
  bottle: 'Bottle',
  scoop: 'Scoop',
  shot: 'Shot',
  serving: 'Serving',
  l: 'Litre',
  kg: 'kg',
  lb: 'lb',
};

export type FoodKind = 'drink' | 'hot-drink' | 'can-drink' | 'wine' | 'spirit' | 'powder' | 'soup' | 'protein' | 'spread' | 'bits' | 'bowl' | 'sliced' | 'whole' | 'other';

/** Exact units (typed as a number) and counted sizes offered for each kind of food. */
const PRESETS: Record<FoodKind, { exact: string[]; sizes: string[] }> = {
  drink: { exact: ['ml', 'fl oz'], sizes: ['glass', 'cup', 'bottle'] },
  'hot-drink': { exact: ['ml', 'fl oz'], sizes: ['mug', 'cup'] },
  'can-drink': { exact: ['ml', 'fl oz'], sizes: ['can', 'bottle', 'glass'] },
  wine: { exact: ['ml', 'fl oz'], sizes: ['glass', 'bottle'] },
  spirit: { exact: ['ml', 'fl oz'], sizes: ['shot', 'glass'] },
  powder: { exact: ['g'], sizes: ['scoop', 'tbsp', 'tsp'] },
  soup: { exact: ['ml', 'g'], sizes: ['bowl', 'cup', 'mug'] },
  spread: { exact: ['g'], sizes: ['tbsp', 'tsp', 'cup'] },
  bits: { exact: ['g', 'oz'], sizes: ['handful', 'cup', 'piece'] },
  bowl: { exact: ['g', 'oz'], sizes: ['bowl', 'cup', 'plate', 'tbsp'] },
  sliced: { exact: ['g', 'oz'], sizes: ['slice', 'piece'] },
  whole: { exact: ['g', 'oz'], sizes: ['small', 'medium', 'large', 'piece'] },
  protein: { exact: ['g', 'oz'], sizes: ['piece', 'small', 'medium', 'large'] },
  other: { exact: ['g', 'oz'], sizes: ['piece', 'cup', 'bowl', 'plate', 'handful'] },
};

const table = (entries: [FoodKind, string[]][]) => new Map(entries.flatMap(([k, list]) => list.map((c) => [c.toLowerCase(), k] as const)));

/**
 * USDA categories, by name: WWEIA categories (Survey/FNDDS foods), branded food categories, and the
 * SR Legacy / Foundation food groups that say enough on their own.
 */
const CATEGORY_KIND = table([
  [
    'drink',
    [
      // WWEIA
      'Milk, whole',
      'Milk, reduced fat',
      'Milk, lowfat',
      'Milk, nonfat',
      'Flavored milk, whole',
      'Flavored milk, reduced fat',
      'Flavored milk, lowfat',
      'Flavored milk, nonfat',
      'Milk shakes and other dairy drinks',
      'Milk substitutes',
      'Plant-based milk',
      'Citrus juice',
      'Apple juice',
      'Other fruit juice',
      'Vegetable juice',
      'Fruit drinks',
      'Diet fruit drinks',
      'Smoothies and grain drinks',
      'Nutritional beverages',
      'Protein and nutritional powders',
      'Tap water',
      'Bottled water',
      'Flavored or carbonated water',
      'Enhanced or fortified water',
      'Baby juice',
      'Baby water',
      'Sport and energy drinks',
      'Diet sport and energy drinks',
      // Branded
      'Milk',
      'Plant Based Milk',
      'Water',
      'Other Drinks',
      'Fruit & Vegetable Juice, Nectars & Fruit Drinks',
      'Energy, Protein & Muscle Recovery Drinks',
      'Non Alcoholic Beverages - Ready to Drink',
      // SR Legacy / Foundation
      'Beverages',
    ],
  ],
  ['hot-drink', ['Coffee', 'Tea', 'Tea Bags', 'Coffee - Ground', 'Coffee/Tea/Substitutes']],
  ['can-drink', ['Soft drinks', 'Diet soft drinks', 'Beer', 'Soda', 'Iced & Bottle Tea', 'Alcoholic Beverages - Beer']],
  ['wine', ['Wine', 'Alcoholic Beverages - Wine']],
  ['spirit', ['Liquor and cocktails', 'Alcoholic Beverages - Spirits']],
  ['powder', ['Powdered Drinks', 'Protein powders']],
  ['soup', ['Soups', 'Soups, broth-based', 'Soups, cream-based', 'Ramen and Asian broth-based soups', 'Canned Soup', 'Other Soups', 'Soup']],
  [
    'spread',
    [
      'Jams, syrups, toppings',
      'Sugars and honey',
      'Sugar substitutes',
      'Salad dressings and vegetable oils',
      'Butter and animal fats',
      'Margarine',
      'Cream cheese, sour cream, whipped cream',
      'Cream and cream substitutes',
      'Dips, gravies, other sauces',
      'Mustard and other condiments',
      'Tomato-based condiments',
      'Pasta sauces, tomato-based',
      'Soy-based condiments',
      'Butter & Spread',
      'Cream',
      'Dips & Salsa',
      'Honey',
      'Jam, Jelly & Fruit Spreads',
      'Ketchup, Mustard, BBQ & Cheese Sauce',
      'Nut & Seed Butters',
      'Oriental, Mexican & Ethnic Sauces',
      'Prepared Pasta & Pizza Sauces',
      'Salad Dressing & Mayonnaise',
      'Syrups & Molasses',
      'Vegetable & Cooking Oils',
      'Herbs & Spices',
      'Seasoning Mixes, Salts, Marinades & Tenderizers',
      'Granulated, Brown & Powdered Sugar',
      'Fats and Oils',
      'Spices and Herbs',
    ],
  ],
  [
    'bits',
    [
      'Nuts and seeds',
      'Dried fruits',
      'Tortilla, corn, other chips',
      'Potato chips',
      'Pretzels/snack mix',
      'Crackers, excludes saltines',
      'Saltine crackers',
      'Candy containing chocolate',
      'Candy not containing chocolate',
      'Grapes',
      'Berries',
      'Popcorn',
      'Olives, pickles, pepper relish',
      'Candy',
      'Chocolate',
      'Chips, Pretzels & Snacks',
      'Crackers & Biscotti',
      'Flavored Snack Crackers',
      'Popcorn, Peanuts, Seeds & Related Snacks',
      'Other Snacks',
      'Wholesome Snacks',
      'Pickles, Olives, Peppers & Relishes',
      'Frozen Fruit & Fruit Juice Concentrates',
      'Nut and Seed Products',
      'Snacks',
    ],
  ],
  [
    'bowl',
    [
      'Oatmeal',
      'Ready-to-eat cereal, higher sugar (>21.2g/100g)',
      'Ready-to-eat cereal, lower sugar (=<21.2g/100g)',
      'Pasta, noodles, cooked grains',
      'Rice',
      'Yogurt, regular',
      'Yogurt, Greek',
      'Plant-based yogurt',
      'Ice cream and frozen dairy desserts',
      'Pudding',
      'Gelatins, ices, sorbets',
      'Cottage/ricotta cheese',
      'Pasta mixed dishes, excludes macaroni and cheese',
      'Macaroni and cheese',
      'Rice mixed dishes',
      'Fried rice and lo/chow mein',
      'Stir-fry and soy-based sauce mixtures',
      'Meat mixed dishes',
      'Poultry mixed dishes',
      'Seafood mixed dishes',
      'Bean, pea, legume dishes',
      'Beans, peas, legumes',
      'Lettuce and lettuce salads',
      'Coleslaw, non-lettuce salads',
      'Other Mexican mixed dishes',
      'Mashed potatoes and white potato mixtures',
      'Vegetable dishes',
      'Other fruits and fruit salads',
      'Egg rolls, dumplings, sushi' /* by the plate */,
      'All Noodles',
      'Cereal',
      'Chili & Stew',
      'Deli Salads',
      'Entrees, Sides & Small Meals',
      'Flavored Rice Dishes',
      'Frozen Dinners & Entrees',
      'Ice Cream & Frozen Yogurt',
      'Other Frozen Desserts',
      'Pasta by Shape & Type',
      'Pasta Dinners',
      'Vegetable and Lentil Mixes',
      'Yogurt',
      'Mexican Dinner Mixes',
      'Pizza Mixes & Other Dry Dinners',
      'Gelatin, Gels, Pectins & Desserts',
      'Canned Vegetables',
      'Frozen Vegetables',
      'Canned Fruit',
      'Breakfast Cereals',
      'Cereal Grains and Pasta',
      'Legumes and Legume Products',
    ],
  ],
  [
    'sliced',
    [
      'Yeast breads',
      'Cheese',
      'Cold cuts and cured meats',
      'Cakes and pies',
      'Pizza',
      'Bacon',
      'Melons',
      'Breads & Buns',
      'Pepperoni, Salami & Cold Cuts',
      'Cakes, Cupcakes, Snack Cakes',
      'Other Deli',
      'Bacon, Sausages & Ribs',
      'Sausages and Luncheon Meats',
    ],
  ],
  [
    'whole',
    [
      'Apples',
      'Bananas',
      'Citrus fruits',
      'Pears',
      'Peaches and nectarines',
      'Bagels and English muffins',
      'Biscuits, muffins, quick breads',
      'Burgers',
      'Burritos and tacos',
      'Cookies and brownies',
      'Doughnuts, sweet rolls, pastries',
      'Egg/breakfast sandwiches',
      'Eggs and omelets',
      'Frankfurter sandwiches',
      'Frankfurters',
      'Meat and BBQ sandwiches',
      'Chicken/turkey sandwiches',
      'Other sandwiches',
      'Cheese sandwiches',
      'Peanut butter and jelly sandwiches',
      'Seafood sandwiches',
      'Pancakes, waffles, French toast',
      'Rolls and buns',
      'Sausages',
      'Tortillas',
      'Cereal bars',
      'Nutrition bars',
      'Vegetable sandwiches/burgers',
      'Vegetables on a sandwich',
      'Chicken patties, nuggets and tenders',
      'White potatoes, baked or boiled',
      'Tomatoes',
      'Carrots',
      'Other red and orange vegetables',
      'Cookies & Biscuits',
      'Croissants, Sweet Rolls, Muffins & Other Pastries',
      'Eggs & Egg Substitutes',
      'Frozen Breakfast Sandwiches, Biscuits & Meals',
      'Prepared Subs & Sandwiches',
      'Prepared Wraps and Burittos',
      'Sausages, Hotdogs & Brats',
      'Snack, Energy & Granola Bars',
      "Frozen Appetizers & Hors D'oeuvres",
      'Frozen Patties and Burgers',
      // Fries come in small, medium and large.
      'French fries and other fried white potatoes',
      'French Fries, Potatoes & Onion Rings',
    ],
  ],
  [
    'protein',
    [
      'Beef, excludes ground',
      'Ground beef',
      'Chicken, whole pieces',
      'Turkey, duck, other poultry',
      'Pork',
      'Lamb, goat, game',
      'Fish',
      'Shellfish',
      'Liver and organ meats',
      'Soy and meat-alternative products',
      'Canned Meat',
      'Fish & Seafood',
      'Frozen Fish & Seafood',
      'Other Meats',
      'Poultry, Chicken & Turkey',
      'Canned Seafood',
      'Meat/Poultry/Other Animals',
      'Beef Products',
      'Pork Products',
      'Poultry Products',
      'Finfish and Shellfish Products',
      'Lamb, Veal, and Game Products',
    ],
  ],
]);

/**
 * SR Legacy / Foundation groups too broad to choose sizes from ("Dairy and Egg Products" is milk,
 * cheese, eggs and butter); the food's name decides within them.
 */
const BROAD = new Set(
  [
    'Dairy and Egg Products',
    'Fruits and Fruit Juices',
    'Vegetables and Vegetable Products',
    'Baked Products',
    'Sweets',
    'Fast Foods',
    'Restaurant Foods',
    'Meals, Entrees, and Side Dishes',
    'Baby Foods',
    'American Indian/Alaska Native Foods',
    'Soups, Sauces, and Gravies',
    'Not included in a food category',
    'Cooked & Prepared',
    'Pre-Packaged Fruit & Vegetables',
    'Lunch Snacks & Combinations',
  ].map((c) => c.toLowerCase()),
);

// Whole words, plural allowed (USDA says "Cereals", "Beverages").
const words = (list: string) => new RegExp(`\\b(?:${list})s?\\b`);

/** For category names not in the table (new branded categories, Open Food Facts tags); most specific first. */
const CATEGORY_WORDS: [FoodKind, RegExp][] = [
  ['powder', words('powder|powdered drink|drink mix')],
  ['spirit', words('liquor|spirit|vodka|whiske?y|gin|rum|tequila|liqueur')],
  ['wine', words('wine|sparkling wine|champagne')],
  ['can-drink', words('soda|soft drink|cola|beer|cider|carbonated drink|energy drink|iced tea')],
  ['hot-drink', words('coffee|tea|hot chocolate|cocoa drink|herbal tea')],
  ['bits', words('candy|candies|confectioner(?:y|ies)|chocolate|chip|crisp|cracker|nut|seed|popcorn|pretzel|olive|dried fruit|snack')],
  ['bowl', words('ice cream|frozen dessert|yogh?urt|cereal|breakfast cereal|pasta|noodle|rice|grain|porridge|oat|salad|stew|meal|dish|legume|bean')],
  ['soup', words('soup|broth')],
  ['drink', words('beverage|drink|juice|nectar|water|milk|smoothie|shake|plant based milk')],
  ['spread', words('sauce|dressing|condiment|oil|fat|butter|spread|jam|honey|syrup|sugar|dip|mayonnaise|ketchup|mustard|spice|seasoning|cream')],
  ['sliced', words('bread|cheese|cold cut|deli|salami|ham|pizza|cake|bacon')],
  ['whole', words('cookie|biscuit|muffin|pastr(?:y|ie)|bagel|sandwich|wrap|burrito|egg|sausage|hot dog|bar|fruit')],
  ['protein', words('meat|poultry|chicken|turkey|beef|pork|fish|seafood|tofu')],
];

/**
 * Kind of food from its source category: USDA's (one name) or Open Food Facts' tags joined by " > ",
 * broadest first. Null when there's no category or it's too broad to say.
 */
export function kindFromCategory(category?: string | null): FoodKind | null {
  if (!category) return null;
  const exact = CATEGORY_KIND.get(category.trim().toLowerCase());
  if (exact) return exact;
  if (BROAD.has(category.trim().toLowerCase())) return null;
  for (const tag of category.split(' > ').reverse()) {
    const t = tag.trim().toLowerCase();
    const k = CATEGORY_KIND.get(t) ?? CATEGORY_WORDS.find(([, re]) => re.test(t))?.[0];
    if (k) return k;
  }
  return null;
}

// ---- Fallback from the name, for custom foods, model estimates and the broad groups above ----

// First match wins, so whole dishes come before the ingredients in their names
// ("toast with butter" is sliced, "butter chicken" isn't a spread, "cream cheese" is).
const KIND_WORDS: [FoodKind, RegExp][] = [
  ['soup', words('soup|broth|bisque|chowder|stock|gazpacho|ramen|pho')],
  [
    'whole',
    words('fries|french fries|sandwich|burger|hamburger|cheeseburger|burrito|taco|wrap|hot dog|bagel|muffin|croissant|donut|doughnut|pancake|waffle|cookie|scone|sub|hoagie'),
  ],
  // Saucy dishes are eaten by the bowl, whatever meat is in them.
  ['bowl', words('curry|stew|chili|masala|korma|vindaloo|butter chicken|stir.fry|casserole|risotto|fried rice|pad thai')],
  ['sliced', words('pizza|lasagna|quiche|cake|cheesecake|pie|bread|toast|loaf|meatloaf|brownie|banana bread')],
  ['protein', words('chicken|beef|pork|lamb|steak|fish|salmon|tuna|cod|shrimp|prawns|tofu|tempeh|turkey|meatballs?')],
  [
    'spread',
    words(
      'butter|margarine|oil|jam|jelly|marmalade|honey|syrup|sauce|dressing|mayo|mayonnaise|ketchup|mustard|salsa|hummus|guacamole|cream cheese|sour cream|whipped cream|heavy cream|cream|sugar|salt|spread|nutella|pesto|gravy|vinegar|dip|creamer|seeds|tahini',
    ),
  ],
  [
    'bits',
    words(
      'nuts?|almonds?|cashews?|peanuts?|walnuts?|pecans?|pistachios?|hazelnuts?|macadamias?|chips|crisps|popcorn|pretzels|berries|blueberries|raspberries|strawberries|blackberries|grapes|raisins|cherries|trail mix|crackers?|candy|candies|gummies|olives|edamame|dates|dried fruit',
    ),
  ],
  [
    'bowl',
    words(
      'cereal|oatmeal|porridge|oats|granola|muesli|rice|pasta|spaghetti|macaroni|noodles|salad|stew|chili|curry|yogh?urt|ice cream|gelato|quinoa|couscous|beans|lentils|chickpeas|mashed|stir.fry|risotto|cottage cheese|pudding|poke',
    ),
  ],
  ['sliced', words('cheese|ham|bacon|salami|pepperoni|prosciutto|deli|watermelon|cantaloupe|melon|pineapple')],
  [
    'whole',
    words(
      'apple|banana|orange|pear|peach|plum|nectarine|mango|kiwi|tangerine|clementine|mandarin|eggs?|avocado|potato|potatoes|sweet potato|tomato|tomatoes|onion|carrot|cucumber|pepper|biscuit|sausage|bar|tortilla|roll|bun|pretzel',
    ),
  ],
];
const DRINK = words(
  'water|milk|juice|coffee|cold brew|frappuccino|refresher|espresso|latte|cappuccino|americano|macchiato|mocha|flat white|cortado|tea|chai|matcha|cocoa|hot chocolate|soda|cola|soft drink|lemonade|smoothie|shake|milkshake|protein shake|kombucha|kefir|beer|ale|lager|stout|ipa|wine|cider|champagne|prosecco|cocktail|margarita|vodka|whiske?y|gin|rum|tequila|bourbon|drink|beverage|seltzer|tonic|sparkling|nectar|eggnog|horchata|lassi',
);
// "Milk chocolate", "tuna canned in water", "rum cake", "tea biscuit": the drink word isn't the food.
const NOT_DRINK = words(
  'milk chocolate|in water|packed in|powder|powdered|dry|condensed|evaporated|cake|ice cream|frozen|bar|bread|biscuit|cookie|vinegar|chestnuts?|pudding|cheese|sauce|cereal|tart',
);
const NUT_BUTTER = words('(?:peanut|almond|cashew|nut|seed|sunflower|hazelnut) butter|tahini');
const COLD = words('iced|cold brew|frappe|frappuccino|bubble tea|boba');
const POWDER = words('powder|powdered|dry mix|instant');
const HOT_DRINK = words('coffee|espresso|latte|cappuccino|americano|macchiato|mocha|flat white|cortado|tea|chai|matcha|cocoa|hot chocolate');
const CANNED_DRINK = words('soda|cola|soft drink|beer|ale|lager|stout|ipa|cider|seltzer|kombucha|sparkling|tonic|energy drink');
const SPIRIT = words('vodka|whiske?y|gin|rum|tequila|bourbon|liqueur|brandy|cognac|schnapps');
const WINE = words('wine|champagne|prosecco|cocktail|margarita');

const kindOf = (text: string): FoodKind => {
  const t = text.toLowerCase().replace(/[,()]/g, ' ');
  if (DRINK.test(t) && !NOT_DRINK.test(t)) return 'drink';
  for (const [kind, re] of KIND_WORDS) if (re.test(t)) return kind;
  return 'other';
};

/** A plain "drink" (from the name, or a category like "Beverages") made specific by the name. */
function refineDrink(names: string[]): FoodKind {
  const t = names.join(' ').toLowerCase();
  if (POWDER.test(t)) return 'powder';
  if (HOT_DRINK.test(t)) return COLD.test(t) ? 'drink' : 'hot-drink';
  if (CANNED_DRINK.test(t)) return 'can-drink';
  if (SPIRIT.test(t)) return 'spirit';
  if (WINE.test(t)) return 'wine';
  return 'drink';
}

interface FoodLike {
  name?: string | string[] | null;
  /** Source database category (USDA, Open Food Facts). */
  category?: string | null;
  portions?: Portion[];
}

/**
 * What sort of food this is, to choose sensible amount chips. The source database's category
 * decides when there is one specific enough; otherwise (custom foods, model estimates, broad USDA
 * groups) the name does: the user's own wording first, then the database name, the head of each
 * before the whole ("Pasta, cooked, with added salt" is pasta, not salt).
 */
export function foodKind(food: FoodLike): FoodKind {
  const names = [food.name ?? []].flat().filter(Boolean);
  const fromCategory = kindFromCategory(food.category);
  if (fromCategory === 'drink') return refineDrink(names);
  // An iced latte or cold brew comes in a glass, not a mug.
  if (fromCategory === 'hot-drink' && names.some((n) => COLD.test(n.toLowerCase()))) return 'drink';
  // WWEIA files nut butters under "Nuts and seeds"; they're spread by the spoonful.
  if (fromCategory === 'bits' && names.some((n) => NUT_BUTTER.test(n.split(',')[0]!.toLowerCase()))) return 'spread';
  if (fromCategory) return fromCategory;
  // The head of a name is what the food is: "Pasta, cooked…", "pasta with tomato sauce", "tuna in water".
  const tries = names.flatMap((n) => [n.split(/,|\s(?:with|and|in|on|&)\s/i)[0]!, n]);
  for (const t of tries) {
    const k = kindOf(t);
    if (k !== 'other') return k === 'drink' ? refineDrink(names) : k;
  }
  if ((food.portions ?? []).some((p) => /\bfl\.?\s*oz\b|\bfluid ounce/i.test(p.label) || p.unit === 'fl oz')) return refineDrink(names);
  return 'other';
}

/**
 * The amount chips worth showing for a food: exact units typed as a number (grams/ounces for food,
 * ml/fl oz for drinks) and a short list of counted sizes that make sense for it.
 * The food's own portions are added on top by the editor.
 */
export function sizesFor(food: FoodLike): { kind: FoodKind; exact: string[]; sizes: string[] } {
  const kind = foodKind(food);
  return { kind, ...PRESETS[kind] };
}

/** Stored UCUM unit back to the editor's unit name. */
export function fromUcum(u: string): string {
  const map: Record<string, string> = { '[cup_us]': 'cup', '[tbs_us]': 'tbsp', '[tsp_us]': 'tsp', '[oz_av]': 'oz', '[lb_av]': 'lb', '[foz_us]': 'fl oz', mL: 'ml', L: 'l' };
  return map[u] ?? normaliseUnit(u);
}
