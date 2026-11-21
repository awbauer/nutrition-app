import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coversQuery, foodWords, refreshAllHistory, refreshHistory } from '../src/worker/lib/history';
import { api, json, mockFetch, testEnv } from './helpers';

/** Bag-of-words embedding: texts sharing words point the same way (enough to exercise the plumbing). */
function embedText(t: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of t
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)) {
    let h = 0;
    for (const ch of w.replace(/s$/, '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
}
const cos = (a: number[], b: number[]) => {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) ((d += a[i]! * b[i]!), (na += a[i]! ** 2), (nb += b[i]! ** 2));
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
  const r = await api(
    '/intake',
    { method: 'POST', json: { meal_type: 'dinner', occurrence_at: at, items: [{ food_id: foodId, amount: 1, unit: 'serving', display_name: displayName }] } },
    E,
  );
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

  it('matches "those chicken meatballs I like" to the meatballs you\'ve had, not USDA\'s chicken wing or your turkey meatballs', async () => {
    const E = { DEV_USER_EMAIL: 'history-match@example.test', AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const chicken = await custom(E, 'Chicken meatballs, Kirkland', 180);
    const turkey = await custom(E, 'Turkey meatballs', 160);
    for (const d of ['01', '03', '05']) await eat(E, chicken, 'chicken meatballs', `2026-11-${d}T19:00:00Z`);
    await eat(E, turkey, 'turkey meatballs', '2026-11-07T19:00:00Z');

    const out = {
      items: [
        {
          name: 'chicken meatballs',
          from_history: true,
          amount: 4,
          unit: 'piece',
          grams: 120,
          confidence: 0.8,
          search_terms: ['chicken meatballs'],
          estimate_per_100g: { kcal: 200 },
        },
      ],
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

describe('incremental history refresh', () => {
  const db = testEnv.DB;
  const userId = async (email: string) => (await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id;
  const entries = async (uid: string) =>
    (
      await db
        .prepare('SELECT food_id, vector_id, text, names_json, times, last_at FROM history_entry WHERE user_id = ? ORDER BY food_id')
        .bind(uid)
        .all<{ food_id: string; vector_id: string; text: string; names_json: string; times: number; last_at: string }>()
    ).results;
  const vectors = (idx: ReturnType<typeof fakeIndex>, uid: string) =>
    [...idx.store.entries()]
      .filter(([, v]) => v.metadata.user_id === uid)
      .map(([id, v]) => ({ id, food_id: v.metadata.food_id, values: v.values }))
      .sort((a, b) => a.id.localeCompare(b.id));
  const dirty = async (uid: string) => (await db.prepare('SELECT COUNT(*) AS n FROM history_dirty WHERE user_id = ?').bind(uid).first<{ n: number }>())!.n;
  const withIndex = (AI: Ai, idx = index) => ({ ...testEnv, AI, HISTORY: idx as unknown as VectorizeIndex });
  /** Workers AI that records every text it embeds (and can do something while embedding). */
  const recordingAi = (texts: string[], onEmbed?: () => Promise<void>) =>
    ({
      run: async (model: string, input: { text?: string[] }) => {
        if (input.text) {
          texts.push(...input.text);
          await onEmbed?.();
        }
        return ai().run(model as never, input as never);
      },
    }) as unknown as Ai;
  /** Rebuild the user's history from nothing into a fresh index: what incremental refreshes must add up to. */
  async function fromScratch(uid: string) {
    const fresh = fakeIndex();
    await db.batch([db.prepare('DELETE FROM history_entry WHERE user_id = ?').bind(uid), db.prepare('UPDATE history_state SET rebuilt_at = NULL WHERE user_id = ?').bind(uid)]);
    await refreshHistory(withIndex(ai(), fresh), uid);
    return { entries: await entries(uid), vectors: vectors(fresh, uid) };
  }

  it('ends with the same entries and vectors as a full rebuild after adds, edits, swaps, deletes and soft deletes', async () => {
    const email = 'history-incremental@example.test';
    const E = { DEV_USER_EMAIL: email, AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const meatballs = await custom(E, 'Chicken meatballs, Kirkland', 180);
    const oats = await custom(E, 'Rolled oats', 380);
    const shake = await custom(E, 'Protein shake', 120);
    const m1 = await eat(E, meatballs, 'chicken meatballs', '2026-11-01T19:00:00Z');
    const m2 = await eat(E, oats, 'oats', '2026-11-02T08:00:00Z');
    const m3 = (
      await api(
        '/intake',
        {
          method: 'POST',
          json: {
            meal_type: 'lunch',
            occurrence_at: '2026-11-03T12:00:00Z',
            items: [
              { food_id: meatballs, amount: 1, unit: 'serving', display_name: 'meatballs' },
              { food_id: shake, amount: 1, unit: 'serving', display_name: 'shake' },
            ],
          },
        },
        E,
      )
    ).data;
    const firstItem = async (meal: string) => (await api(`/intake/${meal}`, {}, E)).data.items[0].id as string;
    const steps: [string, () => Promise<{ status: number }>][] = [
      ['reword', async () => api(`/item/${await firstItem(m1)}`, { method: 'PATCH', json: { display_name: 'kirkland meatballs' } }, E)],
      ['swap', async () => api(`/item/${await firstItem(m2)}`, { method: 'PATCH', json: { food_id: shake } }, E)],
      ['delete item', async () => api(`/item/${m3.items[1].id}`, { method: 'DELETE' }, E)],
      ['copy', async () => api(`/intake/${m3.id}/copy`, { method: 'POST', json: { occurrence_at: '2026-11-04T12:00:00Z' } }, E)],
      ['soft delete', async () => api(`/intake/${m1}`, { method: 'DELETE' }, E)],
      ['move', async () => api(`/intake/${m2}`, { method: 'PATCH', json: { occurrence_at: '2026-11-05T08:00:00Z' } }, E)],
      ['rename food', async () => api(`/foods/${shake}`, { method: 'PUT', json: { name: 'Vanilla protein shake', serving_grams: 100, per_serving: { ENERC_KCAL: 120 } } }, E)],
      ['undelete', async () => api(`/intake/${m1}`, { method: 'PATCH', json: { status: 'completed' } }, E)],
      ['archive food', async () => api(`/foods/${oats}`, { method: 'DELETE' }, E)],
    ];
    const uid = await userId(email);
    for (const [name, step] of steps) {
      expect((await step()).status, name).toBeLessThan(300);
      expect(await dirty(uid), name).toBe(0);
    }
    const incremental = { entries: await entries(uid), vectors: vectors(index, uid) };
    expect(incremental.entries.map((e) => e.food_id).sort()).toEqual([meatballs, shake].sort());
    expect(incremental).toEqual(await fromScratch(uid));
  });

  it('re-embeds only the foods whose text changed', async () => {
    const email = 'history-dirty-only@example.test';
    const texts: string[] = [];
    const E = { DEV_USER_EMAIL: email, AI: recordingAi(texts), HISTORY: index as unknown as VectorizeIndex };
    const meatballs = await custom(E, 'Chicken meatballs, Kirkland', 180);
    const oats = await custom(E, 'Rolled oats', 380);
    const m1 = await eat(E, meatballs, 'chicken meatballs', '2026-11-01T19:00:00Z');
    await eat(E, oats, 'oats', '2026-11-02T08:00:00Z');
    expect(texts).toEqual(['chicken meatballs; Chicken meatballs, Kirkland', 'oats; Rolled oats']);

    texts.length = 0;
    const itemId = (await api(`/intake/${m1}`, {}, E)).data.items[0].id;
    await api(`/item/${itemId}`, { method: 'PATCH', json: { display_name: 'kirkland meatballs' } }, E);
    expect(texts).toEqual(['kirkland meatballs; Chicken meatballs, Kirkland']);

    // Eating it again changes the count, not the text: nothing embedded.
    texts.length = 0;
    await eat(E, oats, 'oats', '2026-11-03T08:00:00Z');
    expect(texts).toEqual([]);
    const uid = await userId(email);
    expect((await entries(uid)).find((e) => e.food_id === oats)).toMatchObject({ times: 2, last_at: '2026-11-03T08:00:00.000Z' });
  });

  it('keeps marks written during a refresh for its next round, and leaves a claimed user to the refresh holding it', async () => {
    const email = 'history-concurrent@example.test';
    const E = { DEV_USER_EMAIL: email, AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const meatballs = await custom(E, 'Chicken meatballs, Kirkland', 180);
    const oats = await custom(E, 'Rolled oats', 380);
    await eat(E, meatballs, 'chicken meatballs', '2026-11-01T19:00:00Z');
    await eat(E, oats, 'oats', '2026-11-02T08:00:00Z');
    const uid = await userId(email);
    const rename = (food: string, name: string) => db.prepare('UPDATE consumed_item SET display_name = ? WHERE user_id = ? AND food_id = ?').bind(name, uid, food).run();

    // Another meal edit lands while this refresh is embedding: its mark survives and is picked up.
    await rename(meatballs, 'meatballs');
    let wrote = false;
    const texts: string[] = [];
    const midway = async () => {
      if (wrote) return;
      wrote = true;
      await rename(oats, 'porridge');
    };
    await refreshHistory(withIndex(recordingAi(texts, midway)), uid);
    expect(texts).toEqual(['meatballs; Chicken meatballs, Kirkland', 'porridge; Rolled oats']);
    expect(await dirty(uid)).toBe(0);
    expect((await entries(uid)).map((e) => e.text).sort()).toEqual(['meatballs; Chicken meatballs, Kirkland', 'porridge; Rolled oats']);

    // While another refresh holds the user, this one does nothing and the marks wait.
    await db.prepare(`UPDATE history_state SET claim = 'other', claimed_at = ? WHERE user_id = ?`).bind(new Date().toISOString(), uid).run();
    await rename(oats, 'oatmeal');
    expect(await refreshHistory(withIndex(ai()), uid)).toEqual({ embedded: 0, removed: 0 });
    expect(await dirty(uid)).toBe(1);

    // A claim left by a refresh that died expires.
    await db.prepare(`UPDATE history_state SET claimed_at = '2026-01-01T00:00:00Z' WHERE user_id = ?`).bind(uid).run();
    expect(await refreshHistory(withIndex(ai()), uid)).toEqual({ embedded: 1, removed: 0 });
    expect(await dirty(uid)).toBe(0);
    expect(await db.prepare('SELECT claim FROM history_state WHERE user_id = ?').bind(uid).first('claim')).toBeNull();
  });

  it('marks every eater of a renamed food, archived recipes, and items deleted with their meal', async () => {
    const A = { DEV_USER_EMAIL: 'history-trigger-a@example.test' };
    const B = { DEV_USER_EMAIL: 'history-trigger-b@example.test' };
    const food = await custom(A, 'Chicken meatballs, Kirkland', 180);
    const ma = await eat(A, food, 'meatballs', '2026-11-01T19:00:00Z');
    await api('/foods?q=x&remote=0', {}, B);
    const [a, b] = [await userId(A.DEV_USER_EMAIL), await userId(B.DEV_USER_EMAIL)];
    // B's item on the same food (the API keeps custom foods to their owner; the triggers don't care).
    await db
      .prepare(
        `INSERT INTO consumed_item (id, intake_id, user_id, food_id, display_name, amount_value, amount_unit, grams, estimation_method)
         VALUES (?, ?, ?, ?, 'meatballs', 1, 'g', 100, 'weighed')`,
      )
      .bind(crypto.randomUUID(), ma, b, food)
      .run();
    await db.prepare('DELETE FROM history_dirty WHERE user_id IN (?, ?)').bind(a, b).run();

    await db.prepare(`UPDATE food SET name = 'Turkey meatballs' WHERE id = ?`).bind(food).run();
    expect([await dirty(a), await dirty(b)]).toEqual([1, 1]);
    await db.prepare('UPDATE food SET created_at = created_at, name = name WHERE id = ?').bind(food).run(); // nothing tracked changed
    expect(await dirty(a)).toBe(1);

    await db.prepare('INSERT INTO recipe (food_id, user_id, servings) VALUES (?, ?, 1)').bind(food, a).run();
    expect(await dirty(a)).toBe(1);
    await db.prepare('UPDATE recipe SET archived = 1 WHERE food_id = ?').bind(food).run();
    expect([await dirty(a), await dirty(b)]).toEqual([2, 2]);
    await db.prepare('DELETE FROM recipe WHERE food_id = ?').bind(food).run();
    expect([await dirty(a), await dirty(b)]).toEqual([3, 3]);

    // Items go with their meal by ON DELETE CASCADE, and still mark.
    await db.prepare('DELETE FROM nutrition_intake WHERE id = ?').bind(ma).run();
    expect([await dirty(a), await dirty(b)]).toEqual([4, 4]);
  });

  it('recomputes large sets of marked foods in chunks under the bound-parameter limit', async () => {
    const email = 'history-chunks@example.test';
    const texts: string[] = [];
    const E = withIndex(recordingAi(texts));
    await api('/foods?q=x&remote=0', {}, { DEV_USER_EMAIL: email });
    const uid = await userId(email);
    await refreshHistory(E, uid);
    expect(await db.prepare('SELECT rebuilt_at FROM history_state WHERE user_id = ?').bind(uid).first('rebuilt_at')).toBeTruthy();

    const n = 150;
    const meal = crypto.randomUUID();
    const foodIds = Array.from({ length: n }, () => crypto.randomUUID());
    await db.batch([
      ...foodIds.map((id, i) => db.prepare(`INSERT INTO food (id, source, name, name_norm, owner_user_id) VALUES (?, 'custom', ?, ?, ?)`).bind(id, `Food ${i}`, `food ${i}`, uid)),
      db
        .prepare(
          `INSERT INTO nutrition_intake (id, user_id, status, meal_type, occurrence_at, occurrence_tz, log_date, recorded_at, source)
           VALUES (?, ?, 'completed', 'lunch', '2026-11-01T12:00:00.000Z', 'UTC', '2026-11-01', '2026-11-01T12:00:00.000Z', 'manual')`,
        )
        .bind(meal, uid),
      ...foodIds.map((id, i) =>
        db
          .prepare(
            `INSERT INTO consumed_item (id, intake_id, user_id, position, food_id, display_name, amount_value, amount_unit, grams, estimation_method)
             VALUES (?, ?, ?, ?, ?, ?, 1, 'g', 100, 'weighed')`,
          )
          .bind(crypto.randomUUID(), meal, uid, i, id, `food ${i}`),
      ),
    ]);
    expect(await dirty(uid)).toBe(n);

    const prepare = vi.spyOn(db, 'prepare');
    expect(await refreshHistory(E, uid)).toEqual({ embedded: n, removed: 0 });
    const inLists = prepare.mock.calls.map(([sql]) => /IN \(([?,]*)\)/.exec(sql)?.[1]).filter((m): m is string => m !== undefined);
    expect(inLists).toHaveLength(4); // groups and entries, two chunks each
    for (const l of inLists) expect(l.split(',').length).toBeLessThanOrEqual(90);
    expect(texts).toHaveLength(n);
    expect(await entries(uid)).toHaveLength(n);
    expect(await dirty(uid)).toBe(0);
  });

  it('backfills users never rebuilt from the cron, then visits only users with marks until a day passes', async () => {
    const email = 'history-cron@example.test';
    const E = { DEV_USER_EMAIL: email, AI: ai(), HISTORY: index as unknown as VectorizeIndex };
    const food = await custom(E, 'Chicken meatballs, Kirkland', 180);
    await eat(E, food, 'chicken meatballs', '2026-11-01T19:00:00Z');
    const uid = await userId(email);
    const before = await entries(uid);
    // As right after the migration: no refresh state, and (say) no entries yet.
    await db.batch([db.prepare('DELETE FROM history_entry WHERE user_id = ?').bind(uid), db.prepare('DELETE FROM history_state WHERE user_id = ?').bind(uid)]);

    const now = new Date();
    expect((await refreshAllHistory(withIndex(ai()), now)).failed).toBe(0);
    expect(await entries(uid)).toEqual(before);
    expect(await refreshAllHistory(withIndex(ai()), now)).toEqual({ users: 0, embedded: 0, removed: 0, failed: 0 });
    await db.prepare(`UPDATE consumed_item SET display_name = 'meatballs' WHERE user_id = ?`).bind(uid).run();
    expect(await refreshAllHistory(withIndex(ai()), now)).toEqual({ users: 1, embedded: 1, removed: 0, failed: 0 });
    expect((await refreshAllHistory(withIndex(ai()), new Date(now.getTime() + 25 * 3600_000))).users).toBeGreaterThanOrEqual(1);
  });
});
