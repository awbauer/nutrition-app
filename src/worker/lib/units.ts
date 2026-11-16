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
  mug: 300,
  plate: 350,
  shot: 44,
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
  handfuls: 'handful', bowls: 'bowl', bowlful: 'bowl', glasses: 'glass', mugs: 'mug', plates: 'plate', scoops: 'scoop', cans: 'can', bottles: 'bottle', shots: 'shot',
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

/**
 * Units typed as an exact number in the amount editor, with grams per unit
 * (volume at water density, same as toGrams). Everything else is a counted size.
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

export type FoodKind = 'drink' | 'soup' | 'protein' | 'spread' | 'bits' | 'bowl' | 'sliced' | 'whole' | 'other';

// Whole words, plural allowed (USDA says "Cereals", "Beverages").
const words = (list: string) => new RegExp(`\\b(?:${list})s?\\b`);
// First match wins, so whole dishes come before the ingredients in their names
// ("toast with butter" is sliced, "butter chicken" isn't a spread, "cream cheese" is).
const KIND_WORDS: [FoodKind, RegExp][] = [
  ['soup', words('soup|broth|bisque|chowder|stock|gazpacho|ramen|pho')],
  ['whole', words('sandwich|burger|hamburger|cheeseburger|burrito|taco|wrap|hot dog|bagel|muffin|croissant|donut|doughnut|pancake|waffle|cookie|scone|sub|hoagie')],
  // Saucy dishes are eaten by the bowl, whatever meat is in them.
  ['bowl', words('curry|stew|chili|masala|korma|vindaloo|butter chicken|stir.fry|casserole|risotto|fried rice|pad thai')],
  ['sliced', words('pizza|lasagna|quiche|cake|cheesecake|pie|bread|toast|loaf|meatloaf|brownie|banana bread')],
  ['protein', words('chicken|beef|pork|lamb|steak|fish|salmon|tuna|cod|shrimp|prawns|tofu|tempeh|turkey|meatballs?')],
  ['spread', words('butter|margarine|oil|jam|jelly|marmalade|honey|syrup|sauce|dressing|mayo|mayonnaise|ketchup|mustard|salsa|hummus|guacamole|cream cheese|sour cream|whipped cream|heavy cream|cream|sugar|salt|spread|nutella|pesto|gravy|vinegar|dip|creamer|seeds|tahini')],
  ['bits', words('nuts?|almonds?|cashews?|peanuts?|walnuts?|pecans?|pistachios?|hazelnuts?|macadamias?|chips|crisps|popcorn|pretzels|berries|blueberries|raspberries|strawberries|blackberries|grapes|raisins|cherries|trail mix|crackers?|candy|candies|gummies|olives|edamame|dates|dried fruit')],
  ['bowl', words('cereal|oatmeal|porridge|oats|granola|muesli|rice|pasta|spaghetti|macaroni|noodles|salad|stew|chili|curry|yogh?urt|ice cream|gelato|quinoa|couscous|beans|lentils|chickpeas|mashed|stir.fry|risotto|cottage cheese|pudding|poke')],
  ['sliced', words('cheese|ham|bacon|salami|pepperoni|prosciutto|deli|watermelon|cantaloupe|melon|pineapple')],
  ['whole', words('apple|banana|orange|pear|peach|plum|nectarine|mango|kiwi|tangerine|clementine|mandarin|eggs?|avocado|potato|potatoes|sweet potato|tomato|tomatoes|onion|carrot|cucumber|pepper|biscuit|sausage|bar|tortilla|roll|bun|pretzel')],
];
const DRINK = words('water|milk|juice|coffee|espresso|latte|cappuccino|americano|macchiato|mocha|flat white|cortado|tea|chai|matcha|cocoa|hot chocolate|soda|cola|soft drink|lemonade|smoothie|shake|milkshake|protein shake|kombucha|kefir|beer|ale|lager|stout|ipa|wine|cider|champagne|prosecco|cocktail|margarita|vodka|whiske?y|gin|rum|tequila|bourbon|drink|beverage|seltzer|tonic|sparkling|nectar|eggnog|horchata|lassi');
// "Milk chocolate", "tuna canned in water", "rum cake", "tea biscuit": the drink word isn't the food.
const NOT_DRINK = words('milk chocolate|in water|packed in|powder|powdered|dry|condensed|evaporated|cake|ice cream|frozen|bar|bread|biscuit|cookie|vinegar|chestnuts?|pudding|cheese|sauce|cereal|tart');
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

/**
 * What sort of food this is, to choose sensible amount chips. Tries the user's own wording first,
 * then the database name, looking at the head of each name before the whole of it
 * ("Pasta, cooked, with added salt" is pasta, not salt); USDA portions in fluid ounces mark a drink.
 */
export function foodKind(food: { name?: string | string[] | null; portions?: Portion[] }): FoodKind {
  const names = [food.name ?? []].flat().filter(Boolean);
  // The head of a name is what the food is: "Pasta, cooked…", "pasta with tomato sauce", "tuna in water".
  const tries = names.flatMap((n) => [n.split(/,|\s(?:with|and|in|on|&)\s/i)[0]!, n]);
  for (const t of tries) {
    const k = kindOf(t);
    if (k !== 'other') return k;
  }
  if ((food.portions ?? []).some((p) => /\bfl\.?\s*oz\b|\bfluid ounce/i.test(p.label) || p.unit === 'fl oz')) return 'drink';
  return 'other';
}

/**
 * The amount chips worth showing for a food: exact units typed as a number (grams/ounces for food,
 * ml/fl oz for drinks) and a short list of counted sizes that make sense for it.
 * The food's own portions are added on top by the editor.
 */
export function sizesFor(food: { name?: string | string[] | null; portions?: Portion[] }): { kind: FoodKind; exact: string[]; sizes: string[] } {
  const kind = foodKind(food);
  const name = [food.name ?? []].flat().join(' ').toLowerCase();
  switch (kind) {
    case 'drink': {
      const sizes = HOT_DRINK.test(name)
        ? ['mug', 'cup']
        : CANNED_DRINK.test(name)
          ? ['can', 'bottle', 'glass']
          : SPIRIT.test(name)
            ? ['shot', 'glass']
            : WINE.test(name)
              ? ['glass', 'bottle']
              : ['glass', 'cup', 'bottle'];
      return { kind, exact: ['ml', 'fl oz'], sizes };
    }
    case 'soup':
      return { kind, exact: ['ml', 'g'], sizes: ['bowl', 'cup', 'mug'] };
    case 'protein':
      return { kind, exact: ['g', 'oz'], sizes: ['piece', 'small', 'medium', 'large'] };
    case 'spread':
      return { kind, exact: ['g'], sizes: ['tbsp', 'tsp', 'cup'] };
    case 'bits':
      return { kind, exact: ['g', 'oz'], sizes: ['handful', 'cup', 'piece'] };
    case 'bowl':
      return { kind, exact: ['g', 'oz'], sizes: ['bowl', 'cup', 'plate', 'tbsp'] };
    case 'sliced':
      return { kind, exact: ['g', 'oz'], sizes: ['slice', 'piece'] };
    case 'whole':
      return { kind, exact: ['g', 'oz'], sizes: ['small', 'medium', 'large', 'piece'] };
    default:
      return { kind, exact: ['g', 'oz'], sizes: ['piece', 'cup', 'bowl', 'plate', 'handful'] };
  }
}

/** Stored UCUM unit back to the editor's unit name. */
export function fromUcum(u: string): string {
  const map: Record<string, string> = { '[cup_us]': 'cup', '[tbs_us]': 'tbsp', '[tsp_us]': 'tsp', '[oz_av]': 'oz', '[lb_av]': 'lb', '[foz_us]': 'fl oz', mL: 'ml', L: 'l' };
  return map[u] ?? normaliseUnit(u);
}
