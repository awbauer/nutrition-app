import { describe, expect, it } from 'vitest';
import { rankCandidates } from '../src/worker/lib/scoring';

const top = (q: string, cs: { name: string; dataType?: string; brand?: string; kcal100?: number }[], est?: number) => rankCandidates(q, cs, est)[0]!.candidate.name;

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
});
