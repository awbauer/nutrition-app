import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coachDigest } from '../src/worker/lib/coach';
import { api, json, mockFetch, testEnv } from './helpers';
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
const fakeAi = { run: async () => ({ response: JSON.stringify(questionOutput) }) } as unknown as Ai;

async function setup(email: string) {
  const E = { DEV_USER_EMAIL: email };
  const food = await api('/foods', { method: 'POST', json: { name: 'Test bar', serving_grams: 50, per_serving: { ENERC_KCAL: 200, PROCNT: 10 } } }, E);
  const bar = await api('/intake', { method: 'POST', json: { meal_type: 'snack', merge: false, items: [{ food_id: food.data.id, amount: 1, unit: 'serving' }] } }, E);
  const f = new FormData();
  f.append('text', 'chicken');
  const draft = await api('/intake', { method: 'POST', body: f }, { ...E, AI: fakeAi });
  expect(draft.data.status).toBe('in-progress');
  return { E, bar: bar.data, draft: draft.data };
}

describe('meals waiting on answers', () => {
  it('count toward the day at their default answers, and the day says how many', async () => {
    const { E, bar, draft } = await setup('unconfirmed-day@example.test');
    const draftKcal = draft.totals.ENERC_KCAL as number;
    expect(draftKcal).toBeGreaterThan(0);
    const day = await api(`/day/${draft.log_date}`, {}, E);
    expect(day.data.totals.ENERC_KCAL).toBeCloseTo(200 + draftKcal, 0);
    expect(day.data.unconfirmed).toBe(1);

    const range = await api(`/range?from=${draft.log_date}&to=${draft.log_date}`, {}, E);
    expect(range.data.days[0]).toMatchObject({ meals: 2, unconfirmed: 1 });
    expect(range.data.days[0].totals.ENERC_KCAL).toBeCloseTo(200 + draftKcal, 0);

    const week = await api(`/summary?end=${draft.log_date}`, {}, E);
    expect(week.data.days.at(-1)).toMatchObject({ meals: 2, unconfirmed: 1 });
    expect(week.data.streak).toBeGreaterThanOrEqual(1);

    // Answering confirms it: same meal, new amount, nothing unconfirmed.
    const done = await api(`/intake/${draft.id}/answers`, { method: 'POST', json: { answers: { q1: 'Large' } } }, E);
    expect(done.data.status).toBe('completed');
    const after = await api(`/day/${draft.log_date}`, {}, E);
    expect(after.data.unconfirmed).toBe(0);
    expect(after.data.totals.ENERC_KCAL).toBeCloseTo(200 + (done.data.totals.ENERC_KCAL as number), 0);
    expect(bar.status).toBe('completed');
  });

  it('do not count once deleted', async () => {
    const { E, draft } = await setup('unconfirmed-deleted@example.test');
    expect((await api(`/intake/${draft.id}`, { method: 'DELETE' }, E)).status).toBe(204);
    const day = await api(`/day/${draft.log_date}`, {}, E);
    expect(day.data).toMatchObject({ unconfirmed: 0, totals: { ENERC_KCAL: 200 } });
    const range = await api(`/range?from=${draft.log_date}&to=${draft.log_date}`, {}, E);
    expect(range.data.days[0]).toMatchObject({ meals: 1, unconfirmed: 0, totals: { ENERC_KCAL: 200 } });
  });

  it('show up in the coach digest, marked, but not in plans to repeat', async () => {
    const email = 'unconfirmed-coach@example.test';
    const { draft } = await setup(email);
    const user = await testEnv.DB.prepare('SELECT id, access_sub, email, timezone FROM users WHERE email = ?').bind(email).first<any>();
    const d = await coachDigest(testEnv.DB, user, draft.log_date);
    expect(d.day.avg.ENERC_KCAL).toBeCloseTo(200 + (draft.totals.ENERC_KCAL as number), 0);
    expect(d.day.meals).toHaveLength(2);
    expect(d.day.meals.find((m) => m.meal_type === 'dinner')?.unconfirmed).toBe(true);
    expect(d.day.meals.find((m) => m.meal_type === 'snack')?.unconfirmed).toBeUndefined();
    expect(d.day.meals_waiting_on_answers).toBe(1);
    expect(d.day.meals_per_logged_day).toBe(2);
    expect(Object.values(d.plans.high_protein_meals).flat()).toEqual([]);
  });
});
