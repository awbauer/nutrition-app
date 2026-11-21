import { describe, expect, it } from 'vitest';
import { rankCandidates } from '../src/worker/lib/scoring';

const top = (q: string, cs: { name: string; dataType?: string; brand?: string; kcal100?: number; sourceRank?: number }[], est?: number) =>
  rankCandidates(q, cs, est)[0]!.candidate.name;

describe('candidate ranking (real mismatches from production)', () => {
  it('salmon sashimi is raw salmon, not fish oil', () => {
    const cs = [
      { name: 'Fish oil, salmon', dataType: 'SR Legacy', kcal100: 902 },
      { name: 'Fish, salmon, Atlantic, farmed, raw', dataType: 'SR Legacy', kcal100: 208 },
      { name: 'Fish, salmon, sockeye, raw', dataType: 'Foundation', kcal100: 131 },
      { name: 'Sushi, salmon, sashimi', dataType: 'Survey (FNDDS)', kcal100: 179 },
    ];
    expect(top('salmon sashimi', cs, 180)).toBe('Sushi, salmon, sashimi');
    expect(top('salmon sashimi', cs)).not.toBe('Fish oil, salmon');
  });

  it('berries are not baby food', () => {
    const cs = [
      { name: 'Babyfood, banana with mixed berries, strained', dataType: 'SR Legacy', kcal100: 92 },
      { name: 'Blueberries, raw', dataType: 'SR Legacy', kcal100: 57 },
      { name: 'Berries, mixed, frozen', dataType: 'Survey (FNDDS)', kcal100: 48 },
    ];
    expect(top('berries', cs, 50)).toBe('Berries, mixed, frozen');
  });

  it('a plain croissant beats an apple one', () => {
    const cs = [
      { name: 'Croissants, apple', dataType: 'SR Legacy', kcal100: 254 },
      { name: 'Croissants, butter', dataType: 'SR Legacy', kcal100: 406 },
      { name: 'Croissant', dataType: 'Survey (FNDDS)', kcal100: 406 },
    ];
    expect(top('croissant', cs, 400)).toMatch(/^Croissant(s, butter)?$/);
  });

  it('chocolate milk is milk, not a milkshake', () => {
    const cs = [
      { name: 'Milk shakes, thick chocolate', dataType: 'SR Legacy', kcal100: 119 },
      { name: 'Milk, chocolate, fluid, commercial, whole', dataType: 'SR Legacy', kcal100: 83 },
      { name: 'Milk, chocolate, reduced fat', dataType: 'Survey (FNDDS)', kcal100: 76 },
    ];
    expect(top('chocolate milk', cs, 80)).toMatch(/^Milk, chocolate/);
  });

  it('prefers generic foods over branded unless the brand is named', () => {
    const cs = [
      { name: 'Yogurt, Greek, Blueberry', brand: 'CHOBANI', dataType: 'Branded', kcal100: 82 },
      { name: 'Yogurt, Greek, plain, whole milk', dataType: 'Foundation', kcal100: 97 },
    ];
    expect(top('greek yogurt', cs, 90)).toBe('Yogurt, Greek, plain, whole milk');
    expect(top('chobani blueberry greek yogurt', cs, 90)).toBe('Yogurt, Greek, Blueberry');
  });

  it('egg is a whole egg, not creamed or deviled', () => {
    const cs = [
      { name: 'Egg, creamed', dataType: 'Survey (FNDDS)', kcal100: 148 },
      { name: 'Egg, deviled', dataType: 'Survey (FNDDS)', kcal100: 198 },
      { name: 'Eggs, Grade A, Large, egg whole', dataType: 'Foundation', kcal100: 148 },
      { name: 'Egg omelet or scrambled egg, made with butter', dataType: 'Survey (FNDDS)', kcal100: 182 },
      { name: 'Egg omelet or scrambled egg, no added fat', dataType: 'Survey (FNDDS)', kcal100: 143 },
    ];
    expect(top('egg', cs, 155)).toBe('Eggs, Grade A, Large, egg whole');
    expect(top('deviled egg', cs, 200)).toBe('Egg, deviled');
  });

  it('bacon is bacon, not bits, sticks or a recipe ingredient', () => {
    const cs = [
      { name: 'Bacon bits', dataType: 'Survey (FNDDS)', kcal100: 476 },
      { name: 'Bacon and beef sticks', dataType: 'SR Legacy', kcal100: 517 },
      { name: 'Bacon bits, meatless', dataType: 'SR Legacy', kcal100: 476 },
      { name: 'Bacon, for use on a sandwich', dataType: 'Survey (FNDDS)', kcal100: 494 },
      { name: 'Bacon, for use with vegetables', dataType: 'Survey (FNDDS)', kcal100: 468 },
      { name: 'Bacon', dataType: 'FatSecret', kcal100: 540 },
      { name: 'Bacon, turkey, microwaved', dataType: 'SR Legacy', kcal100: 368 },
    ];
    expect(top('bacon', cs, 548)).toBe('Bacon');
    expect(top('bacon bits', cs, 476)).toMatch(/^Bacon bits/);
  });

  it('prefers foods people actually eat (NHANES survey days)', () => {
    const cs = [
      { name: 'Ham stroganoff', dataType: 'Survey (FNDDS)', kcal100: 131 },
      { name: 'Ham croquette', dataType: 'Survey (FNDDS)', kcal100: 251 },
      { name: 'Ham', dataType: 'Survey (FNDDS)', kcal100: 140 },
    ];
    expect(top('ham', cs)).toBe('Ham');
    const r = rankCandidates('ham', cs);
    expect(r[0]!.reasons).toContain('eaten on 153 survey days');
    expect(r.find((x) => x.candidate.name === 'Ham stroganoff')!.reasons).toContain('rarely eaten');
  });

  it('Chick-fil-A Polynesian Sauce is the Polynesian packet, not a bottle of Chick-fil-A Sauce', () => {
    // USDA (all tiers) and FatSecret results for "Chick-fil-A Polynesian Sauce", as returned live; the
    // model's estimate was 590 kcal/100 g. The bottle won 1.56 to 1.10: its name spells the brand, so the
    // brand counted twice (as covered words and as the brand bonus), and "polynesian" was worth only 1/4.
    const cs = [
      { name: 'CHICK-FIL-A, Chick-n-Strips', dataType: 'SR Legacy', kcal100: 228 },
      { name: 'CHICK-FIL-A, chicken sandwich', dataType: 'SR Legacy', kcal100: 249 },
      { name: 'CHICK-FIL-A, hash browns', dataType: 'SR Legacy', kcal100: 301 },
      { name: 'Sauce, cheese sauce mix, dry', dataType: 'SR Legacy', kcal100: 438 },
      { name: 'Teriyaki sauce', dataType: 'Survey (FNDDS)', kcal100: 89 },
      { name: 'Barbecue sauce', dataType: 'Survey (FNDDS)', kcal100: 172 },
      { name: 'Duck sauce', dataType: 'Survey (FNDDS)', kcal100: 245 },
      { name: 'CHICK-FIL-A SAUCE, 16 FL OZ', brand: 'CHICK-FIL-A', dataType: 'Branded', kcal100: 516 },
      { name: 'CHICK-FIL-A SAUCE, 24 FL OZ', brand: 'CHICK-FIL-A', dataType: 'Branded', kcal100: 516 },
      { name: 'POLYNESIAN DIPPING SAUCE, POLYNESIAN', brand: 'TATTOO', dataType: 'Branded', kcal100: 306 },
      { name: 'POLYNESIAN SAUCE', brand: 'CHICK-FIL-A', dataType: 'Branded', kcal100: 389 },
      { name: 'THE ORIGINAL POLYNESIAN SAUCE', brand: 'WINGMAN', dataType: 'Branded', kcal100: 176 },
      { name: 'Polynesian Sauce', brand: 'Chick-fil-A', dataType: 'FatSecret Brand', kcal100: 388.9, sourceRank: 0 },
      { name: 'Sauce', brand: 'Chick-Fil-A', dataType: 'FatSecret Brand', kcal100: 500, sourceRank: 1 },
      { name: 'Barbeque Sauce', brand: 'Chick-fil-A', dataType: 'FatSecret Brand', kcal100: 166.7, sourceRank: 2 },
      { name: 'Honey Roasted BBQ Sauce', brand: 'Chick-fil-A', dataType: 'FatSecret Brand', kcal100: 500, sourceRank: 5 },
    ];
    for (const est of [590, 516, 390, undefined]) expect(top('Chick-fil-A Polynesian Sauce', cs, est)).toMatch(/^polynesian sauce$/i);
    const r = rankCandidates('Chick-fil-A Polynesian Sauce', cs, 590);
    const bottle = r.find((x) => x.candidate.name === 'CHICK-FIL-A SAUCE, 16 FL OZ')!;
    expect(bottle.reasons).toContain('missing: polynesian');
    // The brand alone isn't what a restaurant item is about: "CHICK-FIL-A, hash browns" is hash browns.
    expect(r.find((x) => x.candidate.name === 'CHICK-FIL-A, hash browns')!.reasons).toContain('main word differs');
  });

  it("a food word in a brand's name doesn't mention the brand", () => {
    // "Meatballs by Amylu" isn't named by "chicken meatballs", nor ORIGINAL HERKIMER CHEESE by "cheddar cheese".
    const meatballs = [
      { name: 'Chicken Meatballs with Basil and Parmesan', brand: 'Meatballs by Amylu', dataType: 'FatSecret Brand', kcal100: 183.9, sourceRank: 2 },
      { name: 'Chicken Meatballs', dataType: 'FatSecret', kcal100: 160.7, sourceRank: 0 },
    ];
    expect(top('chicken meatballs', meatballs, 220)).toBe('Chicken Meatballs');
    const cheddar = [
      { name: 'CHEDDAR CHEESE', brand: 'ORIGINAL HERKIMER CHEESE', dataType: 'Branded', kcal100: 357 },
      { name: 'Cheddar Cheese', dataType: 'FatSecret', kcal100: 403.6, sourceRank: 0 },
    ];
    expect(top('cheddar cheese', cheddar)).toBe('Cheddar Cheese');
    // The whole brand still counts, even when the name spells it too.
    const ketchup = [
      { name: 'HEINZ, TOMATO KETCHUP', brand: 'HEINZ', dataType: 'Branded', kcal100: 118 },
      { name: 'Ketchup', dataType: 'Survey (FNDDS)', kcal100: 109 },
    ];
    expect(top('heinz ketchup', ketchup, 110)).toBe('HEINZ, TOMATO KETCHUP');
  });

  it("uses FatSecret's own order only as a light tiebreak", async () => {
    const { popularity } = await import('../src/worker/lib/scoring');
    expect(popularity({ name: 'Bacon', dataType: 'FatSecret', sourceRank: 0 }).bonus).toBeCloseTo(0.06);
    expect(popularity({ name: 'Bacon', dataType: 'FatSecret', sourceRank: 12 }).bonus).toBe(0);
    expect(popularity({ name: 'Bacon', dataType: 'SR Legacy', sourceRank: 0 }).bonus).toBe(0);
    // Survey popularity is capped well below the history bonus (0.3+) for foods you've logged yourself.
    expect(popularity({ name: 'Water, tap', dataType: 'Survey (FNDDS)' }).bonus).toBeLessThanOrEqual(0.2);
  });
});
