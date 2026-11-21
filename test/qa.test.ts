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

const questionOutput = {
  meal_type_guess: 'dinner',
  items: [{ name: 'grilled chicken breast', amount: 150, unit: 'g', confidence: 0.5, search_terms: ['chicken breast'] }],
  questions: [
    {
      id: 'q1',
      item_index: 0,
      text: 'How much?',
      options: ['Small', 'Large'],
      default: 'Small',
      effects: { Small: {}, Large: { set_amount: { amount: 400, unit: 'g' } } },
    },
  ],
};
const fakeAi = (out: unknown) => ({ run: async () => ({ response: JSON.stringify(out) }) }) as unknown as Ai;

async function draftWithQuestion(E: Record<string, string>) {
  const f = new FormData();
  f.append('text', 'chicken');
  const r = await api('/intake', { method: 'POST', body: f }, { ...E, AI: fakeAi(questionOutput) });
  expect(r.data.status).toBe('in-progress');
  return r.data;
}

describe('a draft waiting on answers', () => {
  it('refuses item edits that answering would throw away', async () => {
    const E = U('qa-draft@example.test');
    const fid = await food(E);
    const draft = await draftWithQuestion(E);
    const itemId = draft.items[0].id;
    expect((await api(`/intake/${draft.id}/items`, { method: 'POST', json: { food_id: fid, amount: 1, unit: 'serving' } }, E)).status).toBe(409);
    expect((await api(`/item/${itemId}`, { method: 'PATCH', json: { amount: 10 } }, E)).status).toBe(409);
    expect((await api(`/item/${itemId}`, { method: 'DELETE' }, E)).status).toBe(409);
    const done = await api(`/intake/${draft.id}/answers`, { method: 'POST', json: { answers: { q1: 'Large' } } }, E);
    expect(done.data.status).toBe('completed');
    expect(done.data.items).toHaveLength(1);
    expect(done.data.items[0].grams).toBe(400);
    // Once completed, items can be changed.
    const add = await api(`/intake/${draft.id}/items`, { method: 'POST', json: { food_id: fid, amount: 1, unit: 'serving' } }, E);
    expect(add.status).toBe(201);
    expect((await api(`/item/${done.data.items[0].id}`, { method: 'PATCH', json: { amount: 100 } }, E)).status).toBe(200);
  });

  it('does not let a meal be pushed back into the AI states', async () => {
    const E = U('qa-status@example.test');
    const fid = await food(E);
    const m = await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 1, unit: 'serving' }] } }, E);
    for (const status of ['preparation', 'in-progress', 'bogus']) expect((await api(`/intake/${m.data.id}`, { method: 'PATCH', json: { status } }, E)).status).toBe(400);
    expect((await api(`/intake/${m.data.id}/retry`, { method: 'POST' }, E)).status).toBe(409);
    expect((await api(`/intake/${m.data.id}`, {}, E)).data.items).toHaveLength(1);
    // Marking it as an error and back is still allowed.
    expect((await api(`/intake/${m.data.id}`, { method: 'PATCH', json: { status: 'entered-in-error' } }, E)).status).toBe(200);
    expect((await api(`/intake/${m.data.id}`, { method: 'PATCH', json: { status: 'completed' } }, E)).status).toBe(200);
  });
});

describe('many meals', () => {
  it('reads and exports more meals than D1 allows bound parameters in one query', async () => {
    const E = U('qa-many@example.test');
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } }, E);
    const fid = await food(E);
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const at = new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 6), 8 + (i % 6) * 2)).toISOString();
      const r = await api('/intake', { method: 'POST', json: { occurrence_at: at, items: [{ food_id: fid, amount: 1, unit: 'serving' }] } }, E);
      ids.push(r.data.id);
    }
    const exp = await api('/export?from=2026-01-01&to=2026-01-31&format=json', {}, E);
    expect(exp.status).toBe(200);
    expect(exp.data.nutrition_intake).toHaveLength(120);
    expect(exp.data.nutrition_intake.every((i: any) => i.consumed_item.length === 1)).toBe(true);
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
