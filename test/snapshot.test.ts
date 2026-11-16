import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { cacheFood, getSnapshot } from '../src/worker/lib/foods';
import { normaliseDetailFood, normaliseSearchFood } from '../src/worker/lib/usda';
import { chickenDetail, searchResults } from './fixtures/usda';

const db = (env as unknown as { DB: D1Database }).DB;

describe('source snapshots', () => {
  it('keeps the full detail record and never downgrades it to a search hit', async () => {
    const hit = { ...searchResults.foods[0]!, fdcId: 990001, extraField: 'from search' };
    const first = await cacheFood(db, normaliseSearchFood(hit));
    expect(await getSnapshot(db, first.id)).toMatchObject({ kind: 'search', data: { extraField: 'from search' } });

    const detail = {
      ...chickenDetail,
      fdcId: 990001,
      someNewUsdaField: { kept: true },
      foodUpdateLog: [{ fdcId: 1 }],
      foodNutrients: [
        { type: 'FoodNutrient', nutrient: { id: 951, name: 'Proximates', rank: 50, unitName: 'g' } },
        ...chickenDetail.foodNutrients.map((n) => ({
          ...n,
          type: 'FoodNutrient',
          id: 35281873,
          min: 1,
          foodNutrientDerivation: { id: 1, code: 'A', description: 'Analytical', foodNutrientSource: { id: 1, code: '1', description: 'Analytical' } },
          nutrientAnalysisDetails: [{ storeCity: 'Somewhere' }],
        })),
      ],
    };
    await cacheFood(db, normaliseDetailFood(detail));
    const snap = (await getSnapshot(db, first.id)) as { kind: string; data: any };
    expect(snap).toMatchObject({ kind: 'detail', data: { someNewUsdaField: { kept: true } } });
    // Lab sample details and the branded update log are left out; everything else per nutrient stays.
    expect(snap.data.foodUpdateLog).toBeUndefined();
    // Heading rows and row bookkeeping go; values, ranges and how they were derived stay.
    expect(snap.data.foodNutrients).toHaveLength(chickenDetail.foodNutrients.length);
    expect(snap.data.foodNutrients[0]).toEqual({
      nutrient: { id: 1008, unitName: 'kcal' },
      amount: 165,
      min: 1,
      foodNutrientDerivation: { code: 'A', description: 'Analytical', foodNutrientSource: { code: '1', description: 'Analytical' } },
    });

    await cacheFood(db, normaliseSearchFood(hit));
    expect((await getSnapshot(db, first.id))!.kind).toBe('detail');
  });
});
