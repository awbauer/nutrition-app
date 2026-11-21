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

  it("uses FatSecret's own order only as a light tiebreak", async () => {
    const { popularity } = await import('../src/worker/lib/scoring');
    expect(popularity({ name: 'Bacon', dataType: 'FatSecret', sourceRank: 0 }).bonus).toBeCloseTo(0.06);
    expect(popularity({ name: 'Bacon', dataType: 'FatSecret', sourceRank: 12 }).bonus).toBe(0);
    expect(popularity({ name: 'Bacon', dataType: 'SR Legacy', sourceRank: 0 }).bonus).toBe(0);
    // Survey popularity is capped well below the history bonus (0.3+) for foods you've logged yourself.
    expect(popularity({ name: 'Water, tap', dataType: 'Survey (FNDDS)' }).bonus).toBeLessThanOrEqual(0.2);
  });
});
