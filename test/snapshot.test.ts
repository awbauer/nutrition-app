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

    const detail = { ...chickenDetail, fdcId: 990001, someNewUsdaField: { kept: true } };
    await cacheFood(db, normaliseDetailFood(detail));
    expect(await getSnapshot(db, first.id)).toMatchObject({ kind: 'detail', data: { someNewUsdaField: { kept: true } } });

    await cacheFood(db, normaliseSearchFood(hit));
    expect((await getSnapshot(db, first.id))!.kind).toBe('detail');
  });
});
