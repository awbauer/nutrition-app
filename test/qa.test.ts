import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, json, mockFetch } from './helpers';
import { DETAILS, searchResults } from './fixtures/usda';

beforeEach(() => {
  mockFetch((url) => {
    if (url.hostname !== 'api.nal.usda.gov') return undefined;
    if (url.pathname.endsWith('/foods/search')) {
      const dt = url.searchParams.get('dataType') ?? '';
      return json(dt.includes('SR Legacy') ? searchResults : { foods: [] });
    }
    const m = /\/food\/(\d+)$/.exec(url.pathname);
    if (m && DETAILS[m[1]!]) return json(DETAILS[m[1]!]);
    return json({ error: 'not found' }, 404);
  });
});
afterEach(() => vi.restoreAllMocks());

const U = (email: string) => ({ DEV_USER_EMAIL: email });

async function food(e: Record<string, string>) {
  const r = await api('/foods', { method: 'POST', json: { name: 'QA bar', serving_grams: 50, per_serving: { ENERC_KCAL: 200 } } }, e);
  expect(r.status).toBe(201);
  return r.data.id as string;
}

describe('explicit grams', () => {
  it('rejects negative, zero or non-numeric grams on every write', async () => {
    const E = U('qa-grams@example.test');
    const fid = await food(E);
    for (const grams of [-100, 0, 'abc', 1e9]) {
      const r = await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 1, unit: 'serving', grams }] } }, E);
      expect(r.status, `create with grams ${grams}`).toBe(400);
    }
    const ok = await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 1, unit: 'serving' }] } }, E);
    expect(ok.status).toBe(201);
    const add = await api(`/intake/${ok.data.id}/items`, { method: 'POST', json: { food_id: fid, amount: 1, unit: 'serving', grams: -5 } }, E);
    expect(add.status).toBe(400);
    const patch = await api(`/item/${ok.data.items[0].id}`, { method: 'PATCH', json: { grams: -50 } }, E);
    expect(patch.status).toBe(400);
    const day = await api(`/day/${ok.data.log_date}`, {}, E);
    expect(day.data.totals.ENERC_KCAL).toBe(200);
  });
});

describe('settings', () => {
  it('changes nothing when part of an update is invalid', async () => {
    const E = U('qa-settings@example.test');
    await api('/settings', { method: 'PUT', json: { timezone: 'Europe/London' } }, E);
    const bad = await api('/settings', { method: 'PUT', json: { timezone: 'Asia/Tokyo', day_cutoff: '25:00' } }, E);
    expect(bad.status).toBe(400);
    expect((await api('/settings', {}, E)).data.timezone).toBe('Europe/London');
  });
});
