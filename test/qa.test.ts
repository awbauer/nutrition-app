import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FatSecretClient } from '../src/worker/lib/fatsecret';
import { cacheFood } from '../src/worker/lib/foods';
import { offByBarcode } from '../src/worker/lib/off';
import { UsdaClient } from '../src/worker/lib/usda';
import { failStaleJobs } from '../src/worker/lib/jobs';
import { finishDraft } from '../src/worker/lib/pipeline';
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

describe('AI job and answers run once', () => {
  it('takes only the first of two simultaneous sets of answers', async () => {
    const E = U('qa-twice@example.test');
    const draft = await draftWithQuestion(E);
    const [a, b] = await Promise.all([
      api(`/intake/${draft.id}/answers`, { method: 'POST', json: { answers: { q1: 'Large' } } }, E),
      api(`/intake/${draft.id}/answers`, { method: 'POST', json: { answers: { q1: 'Small' } } }, E),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const now = await api(`/intake/${draft.id}`, {}, E);
    expect(now.data.items).toHaveLength(1);
    expect(now.data.items[0].grams).toBe(winner.data.items[0].grams);
  });

  it('does not let a late job run replace a finished meal', async () => {
    const E = U('qa-late@example.test');
    const draft = await draftWithQuestion(E);
    const done = await api(`/intake/${draft.id}/answers`, { method: 'POST', json: { answers: { q1: 'Large' } } }, E);
    const user = await testEnv.DB.prepare('SELECT id, access_sub, email, timezone FROM users WHERE email = ?').bind(E.DEV_USER_EMAIL).first<any>();
    const pending = {
      base: [{ name: 'late', food_id: done.data.items[0].food_id, via: 'search', amount: 5, unit: 'g', confidence: 1, method: 'described' as const, estimated: false }],
      questions: [],
    };
    expect(await finishDraft(testEnv, user, draft.id, { model_id: 'm', raw_input_text: 'late' }, pending)).toBe(false);
    const now = await api(`/intake/${draft.id}`, {}, E);
    expect(now.data.status).toBe('completed');
    expect(now.data.items.map((i: any) => i.grams)).toEqual([400]);
  });

  it('retries only a failed job, and fails jobs that died silently', async () => {
    const E = U('qa-retry@example.test');
    const f = new FormData();
    f.append('text', 'chicken');
    // A queue is bound: the job waits there, so the meal stays in preparation.
    const sent: unknown[] = [];
    const r = await api('/intake', { method: 'POST', body: f }, { ...E, JOBS: { send: async (m: unknown) => void sent.push(m) } as unknown as Queue });
    expect(r.data.status).toBe('preparation');
    expect((await api(`/intake/${r.data.id}/retry`, { method: 'POST' }, E)).status).toBe(409);

    expect(await failStaleJobs(testEnv)).toBe(0);
    await testEnv.DB.prepare("UPDATE nutrition_intake SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(r.data.id).run();
    expect(await failStaleJobs(testEnv)).toBeGreaterThanOrEqual(1);
    const failed = await api(`/intake/${r.data.id}`, {}, E);
    expect(failed.data.pending.error).toMatch(/too long/);
    const again = await api(`/intake/${r.data.id}/retry`, { method: 'POST' }, { ...E, AI: fakeAi(questionOutput) });
    expect(again.status).toBe(202);
    expect(again.data.status).toBe('in-progress');
  });
});

describe('meal media', () => {
  it('accepts only stored image formats, serves them unsniffed and only to the owner', async () => {
    const E = U('qa-media@example.test');
    const svg = new FormData();
    svg.append('photo', new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], 'x.svg', { type: 'image/svg+xml' }));
    expect((await api('/intake', { method: 'POST', body: svg }, E)).status).toBe(415);

    const ok = new FormData();
    ok.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' }));
    const sent: unknown[] = [];
    const r = await api('/intake', { method: 'POST', body: ok }, { ...E, JOBS: { send: async (m: unknown) => void sent.push(m) } as unknown as Queue });
    expect(r.status).toBe(202);
    const img = await api(`/intake/${r.data.id}/photos/0`, {}, E);
    expect(img.status).toBe(200);
    expect(img.res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(img.res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // Another user can't see the meal, its photo or its media, or change it.
    const B = U('qa-media-other@example.test');
    expect((await api(`/intake/${r.data.id}/photos/0`, {}, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}/media`, {}, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}`, {}, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}/history`, {}, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}`, { method: 'PATCH', json: { note: 'x' } }, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}`, { method: 'DELETE' }, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}/retry`, { method: 'POST' }, B)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}/copy`, { method: 'POST', json: {} }, B)).status).toBe(404);
  });

  it('keeps items and foods private to their owner', async () => {
    const A = U('qa-owner-a@example.test');
    const B = U('qa-owner-b@example.test');
    const fid = await food(A);
    const m = await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 1, unit: 'serving' }] } }, A);
    const itemId = m.data.items[0].id;
    expect((await api(`/item/${itemId}`, {}, B)).status).toBe(404);
    expect((await api(`/item/${itemId}`, { method: 'DELETE' }, B)).status).toBe(404);
    expect((await api(`/item/${itemId}/search?q=bar`, {}, B)).status).toBe(404);
    expect((await api(`/foods/${fid}`, {}, B)).status).toBe(404);
    // B can't log A's custom food, or add to A's meal.
    expect((await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 1, unit: 'serving' }] } }, B)).status).toBe(404);
    const bf = await food(B);
    expect((await api(`/intake/${m.data.id}/items`, { method: 'POST', json: { food_id: bf, amount: 1, unit: 'serving' } }, B)).status).toBe(404);
    expect((await api('/intake', { method: 'POST', json: { append_to: m.data.id, items: [{ food_id: bf, amount: 1, unit: 'serving' }] } }, B)).status).toBe(404);
    expect((await api(`/intake/${m.data.id}`, {}, A)).data.items).toHaveLength(1);
  });
});

describe('stored units', () => {
  it('weighs a favorite starred from an item in ounces, and labels the conversion honestly', async () => {
    const E = U('qa-ucum@example.test');
    const fid = await food(E);
    const m = await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 2, unit: 'oz' }] } }, E);
    const it = m.data.items[0];
    expect(it.amount_unit).toBe('[oz_av]');
    const fav = await api('/foods/favorites', { method: 'POST', json: { name: 'qa bar', food_id: fid, amount: it.amount_value, unit: it.amount_unit } }, E);
    expect(fav.data.grams).toBeCloseTo(56.7, 1);
    const detail = await api(`/item/${it.id}`, {}, E);
    expect(detail.data.conversion.method).toBe('mass');
  });
});

describe('errors', () => {
  it('answers 400 only for a bad request body, not for corrupt stored JSON', async () => {
    const E = U('qa-errors@example.test');
    const fid = await food(E);
    const m = await api('/intake', { method: 'POST', json: { items: [{ food_id: fid, amount: 1, unit: 'serving' }] } }, E);
    const bad = await api(`/intake/${m.data.id}`, { method: 'PATCH', body: '{nope', headers: { 'Content-Type': 'application/json' } }, E);
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe('invalid JSON body');
    await testEnv.DB.prepare("UPDATE nutrition_intake SET status = 'preparation', pending_json = '{broken' WHERE id = ?").bind(m.data.id).run();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await api(`/intake/${m.data.id}/retry`, { method: 'POST' }, E)).status).toBe(500);
    expect(spy).toHaveBeenCalled();
  });
});

describe('outside food databases', () => {
  it('give every request a deadline', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const capture = async (_: RequestInfo | URL, init?: RequestInit) => (signals.push(init?.signal), json({ foods: [], status: 0 }));
    await new UsdaClient('k', capture as typeof fetch).search('pasta', ['SR Legacy']);
    await offByBarcode('01234567', capture as typeof fetch);
    await new FatSecretClient('k', 's', capture as typeof fetch).food('1').catch(() => {});
    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });
  it('signs a FatSecret call again once after an expired-timestamp error', async () => {
    let calls = 0;
    const c = new FatSecretClient('k', 's', (async () => (++calls === 1 ? json({ error: { code: 6, message: 'Invalid timestamp' } }) : json({}))) as unknown as typeof fetch);
    expect(await c.food('1')).toBeNull();
    expect(calls).toBe(2);
    let always = 0;
    const d = new FatSecretClient('k', 's', (async () => (always++, json({ error: { code: 6, message: 'Invalid timestamp' } }))) as unknown as typeof fetch);
    await expect(d.food('1')).rejects.toThrow(/6/);
    expect(always).toBe(2);
  });
});

describe('food cache', () => {
  it('caches the same new food twice at once without failing', async () => {
    const f = { source: 'estimate' as const, sourceId: `qa-race-${Date.now()}`, name: 'Race food', brand: null, dataType: null, category: null, defaultServingGrams: null, portions: [], nutrients: [{ code: 'ENERC_KCAL', usdaId: 1008, value: 100, unit: 'kcal' }] };
    const [a, b] = await Promise.all([cacheFood(testEnv.DB, f), cacheFood(testEnv.DB, f)]);
    expect(a.id).toBe(b.id);
    expect(a.nutrients).toHaveLength(1);
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
