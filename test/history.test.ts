import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coversQuery, foodWords } from '../src/worker/lib/history';
import { api, json, mockFetch } from './helpers';

/** Bag-of-words embedding: texts sharing words point the same way (enough to exercise the plumbing). */
function embedText(t: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of t.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    let h = 0;
    for (const ch of w.replace(/s$/, '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
}
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) (d += a[i]! * b[i]!), (na += a[i]! ** 2), (nb += b[i]! ** 2);
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/** In-memory Vectorize with the bits the app uses: upsert, deleteByIds, query with a user filter. */
function fakeIndex() {
  const store = new Map<string, { values: number[]; metadata: Record<string, string> }>();
  const index = {
    store,
    upserts: 0,
    async upsert(vs: { id: string; values: number[]; metadata: Record<string, string> }[]) {
      index.upserts += vs.length;
      for (const v of vs) store.set(v.id, { values: v.values, metadata: v.metadata });
      return { mutationId: 'm' };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) store.delete(id);
      return { mutationId: 'm' };
    },
    async query(vec: number[], opts: { topK: number; filter: { user_id: string } }) {
      const matches = [...store.entries()]
        .filter(([, v]) => v.metadata.user_id === opts.filter.user_id)
        .map(([id, v]) => ({ id, score: cos(vec, v.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.topK);
      return { matches, count: matches.length };
    },
  };
  return index;
}

/** Workers AI fake: embeddings for {text}, otherwise the given parser output. */
const ai = (out: unknown = { items: [], questions: [] }) =>
  ({
    run: async (_model: string, input: { text?: string[] }) => (input.text ? { data: input.text.map(embedText), shape: [input.text.length, 64] } : { response: out }),
  }) as unknown as Ai;

let index: ReturnType<typeof fakeIndex>;
beforeEach(() => {
  index = fakeIndex();
  // USDA only knows chicken wings: the wrong answer for "chicken meatballs".
  mockFetch((url) =>
    url.hostname === 'api.nal.usda.gov'
      ? json({
          foods: [
            {
              fdcId: 999001,
              description: 'Chicken wing, baked, coated',
              dataType: 'Survey (FNDDS)',
              foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 290 }],
              foodMeasures: [],
            },
          ],
        })
      : undefined,
  );
});
afterEach(() => vi.restoreAllMocks());

async function custom(E: object, name: string, kcal: number) {
  const r = await api('/foods', { method: 'POST', json: { name, serving_grams: 100, per_serving: { ENERC_KCAL: kcal, PROCNT: 15 } } }, E);
  return r.data.id as string;
}
async function eat(E: object, foodId: string, displayName: string, at: string) {
  const r = await api('/intake', { method: 'POST', json: { meal_type: 'dinner', occurrence_at: at, items: [{ food_id: foodId, amount: 1, unit: 'serving', display_name: displayName }] } }, E);
  expect(r.status).toBe(201);
  return r.data.id as string;
}

describe('history helpers', () => {
  it('drops the words that point at the past', () => {
    expect(foodWords('those chicken meatballs I like')).toBe('chicken meatballs');
    expect(foodWords('my usual oatmeal')).toBe('oatmeal');
    expect(foodWords('the usual')).toBe('the usual');
  });
  it('requires every food word', () => {
    expect(coversQuery('those chicken meatballs I like', 'Chicken meatballs, Kirkland')).toBe(true);
    expect(coversQuery('chicken meatballs', 'Turkey meatballs')).toBe(false);
    expect(coversQuery('chicken meatballs', 'Chicken wing, baked')).toBe(false);
  });
});

describe('foods you have eaten', () => {
  it('indexes what you eat, re-embeds only what changed, and drops deleted meals', async () => {
    const E = { DEV_USER_EMAIL: 'history-index@example.test', AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const meatballs = await custom(E, 'Chicken meatballs, Kirkland', 180);
    const first = await eat(E, meatballs, 'chicken meatballs', '2026-11-10T19:00:00Z');
    expect(index.store.size).toBe(1);
    expect([...index.store.values()][0]!.metadata).toMatchObject({ food_id: meatballs });

    // Same food, same wording: count goes up, nothing re-embedded.
    const before = index.upserts;
    const second = await eat(E, meatballs, 'chicken meatballs', '2026-11-12T19:00:00Z');
    expect(index.upserts).toBe(before);

    const s = await api('/foods?q=those%20chicken%20meatballs%20I%20like&remote=0', {}, E);
    expect(s.data.history).toHaveLength(1);
    expect(s.data.history[0]).toMatchObject({ id: meatballs, history: { names: ['chicken meatballs'], times: 2, last_at: '2026-11-12T19:00:00.000Z' } });

    // Delete both meals: the entry and its vector go.
    await api(`/intake/${first}`, { method: 'DELETE' }, E);
    expect(index.store.size).toBe(1);
    await api(`/intake/${second}`, { method: 'DELETE' }, E);
    expect(index.store.size).toBe(0);
    expect((await api('/foods?q=chicken%20meatballs&remote=0', {}, E)).data.history).toEqual([]);
  });

  it("matches \"those chicken meatballs I like\" to the meatballs you've had, not USDA's chicken wing or your turkey meatballs", async () => {
    const E = { DEV_USER_EMAIL: 'history-match@example.test', AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const chicken = await custom(E, 'Chicken meatballs, Kirkland', 180);
    const turkey = await custom(E, 'Turkey meatballs', 160);
    for (const d of ['01', '03', '05']) await eat(E, chicken, 'chicken meatballs', `2026-11-${d}T19:00:00Z`);
    await eat(E, turkey, 'turkey meatballs', '2026-11-07T19:00:00Z');

    const out = {
      items: [{ name: 'chicken meatballs', from_history: true, amount: 4, unit: 'piece', grams: 120, confidence: 0.8, search_terms: ['chicken meatballs'], estimate_per_100g: { kcal: 200 } }],
      questions: [],
    };
    const f = new FormData();
    f.append('text', 'those chicken meatballs I like');
    const r = await api('/intake', { method: 'POST', body: f }, { ...E, AI: ai(out) });
    const item = r.data.items[0];
    expect(item.food_id).toBe(chicken);
    const d = await api(`/item/${item.id}`, {}, E);
    expect(d.data.match.via).toBe('history');
    expect(d.data.match.candidates[0].notes.join(' ')).toMatch(/you've had it 3×/);

    // Without the history index the same request falls through to the database search.
    const r2 = await api('/intake', { method: 'POST', body: f }, { DEV_USER_EMAIL: 'history-none@example.test', AI: ai(out) });
    expect(r2.data.items[0].food_id).not.toBe(chicken);
  });

  it('forgets a custom food once you delete it', async () => {
    const E = { DEV_USER_EMAIL: 'history-archive@example.test', AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const food = await custom(E, 'Chicken meatballs, Kirkland', 180);
    await eat(E, food, 'chicken meatballs', '2026-11-10T19:00:00Z');
    expect(index.store.size).toBe(1);
    expect((await api(`/foods/${food}`, { method: 'DELETE' }, E)).status).toBe(204);
    expect(index.store.size).toBe(0);
  });

  it('keeps each user to their own history', async () => {
    const A = { DEV_USER_EMAIL: 'history-a@example.test', AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const B = { DEV_USER_EMAIL: 'history-b@example.test', AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const food = await custom(A, 'Chicken meatballs, Kirkland', 180);
    await eat(A, food, 'chicken meatballs', '2026-11-10T19:00:00Z');
    expect((await api('/foods?q=chicken%20meatballs&remote=0', {}, B)).data.history).toEqual([]);
  });
});
