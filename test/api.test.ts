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

describe('auth', () => {
  it('rejects requests when Access is not configured and dev auth is off', async () => {
    const r = await api('/me', {}, { DEV_AUTH: '0' });
    expect(r.status).toBe(401);
  });
  it('provisions the dev user', async () => {
    const r = await api('/me');
    expect(r.status).toBe(200);
    expect(r.data.email).toBe('test@example.test');
    expect(r.data.settings.day_cutoff).toBe('04:00');
  });
});

describe('settings', () => {
  it('updates timezone and validates values', async () => {
    const ok = await api('/settings', { method: 'PUT', json: { timezone: 'America/Chicago', weight_unit: 'lb' } });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ timezone: 'America/Chicago', weight_unit: 'lb' });
    const bad = await api('/settings', { method: 'PUT', json: { max_questions: 9 } });
    expect(bad.status).toBe(400);
    const badTz = await api('/settings', { method: 'PUT', json: { timezone: 'Mars/Base' } });
    expect(badTz.status).toBe(400);
  });
});

describe('foods', () => {
  it('searches USDA and caches resolved foods', async () => {
    const s = await api('/foods?q=chicken breast');
    expect(s.status).toBe(200);
    expect(s.data.usda[0]).toMatchObject({ sourceId: '171477', source: 'usda' });
    const f = await api('/foods/fdc/171477');
    expect(f.data.portions.length).toBe(2);
    const again = await api('/foods?q=chicken breast');
    expect(again.data.local[0].source_id).toBe('171477');
    expect(again.data.usda.find((u: any) => u.sourceId === '171477')).toBeUndefined();
  });
  it('creates custom foods from per-serving values', async () => {
    const r = await api('/foods', {
      method: 'POST',
      json: { name: 'Protein bar', serving_grams: 60, per_serving: { ENERC_KCAL: 240, PROCNT: 20 } },
    });
    expect(r.status).toBe(201);
    expect(r.data.nutrients.find((n: any) => n.code === 'ENERC_KCAL').value).toBe(400);
    const s = await api('/foods?q=protein bar&remote=0');
    expect(s.data.local[0].name).toBe('Protein bar');
  });
});

describe('manual intake and daily totals', () => {
  it('logs a meal, computes nutrients from database values and totals the day', async () => {
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } });
    const r = await api('/intake', {
      method: 'POST',
      json: {
        meal_type: 'lunch',
        occurrence_at: '2026-11-10T12:30:00Z',
        items: [
          { fdc_id: 171477, amount: 150, unit: 'g' },
          { fdc_id: 168878, amount: 1, unit: 'cup' },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(r.data.status).toBe('completed');
    expect(r.data.log_date).toBe('2026-11-10');
    const [chicken, rice] = r.data.items;
    expect(chicken.grams).toBe(150);
    expect(chicken.estimation_method).toBe('weighed');
    expect(chicken.nutrients.ENERC_KCAL).toBeCloseTo(247.5, 1);
    expect(rice.grams).toBe(158);
    expect(rice.amount_unit).toBe('[cup_us]');
    expect(rice.nutrients.ENERC_KCAL).toBeCloseTo(205.4, 1);

    const day = await api('/day/2026-11-10');
    expect(day.data.meals).toHaveLength(1);
    expect(day.data.totals.ENERC_KCAL).toBeCloseTo(452.9, 1);
    expect(day.data.totals.PROCNT).toBeCloseTo(50.8, 1);

    const range = await api('/range?from=2026-11-09&to=2026-11-11');
    expect(range.data.days).toHaveLength(1);
    expect(range.data.days[0]).toMatchObject({ date: '2026-11-10', meals: 1 });
  });

  it('applies the day cutoff in the user time zone', async () => {
    await api('/settings', { method: 'PUT', json: { timezone: 'America/New_York', day_cutoff: '04:00' } });
    const r = await api('/intake', {
      method: 'POST',
      json: { occurrence_at: '2026-11-12T07:00:00Z', items: [{ fdc_id: 168878, amount: 100, unit: 'g' }] },
    });
    expect(r.data.log_date).toBe('2026-11-11'); // 02:00 local
    expect(r.data.meal_type).toBe('snack');
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } });
  });

  it('edits items, recomputes totals, and soft-deletes meals', async () => {
    const r = await api('/intake', {
      method: 'POST',
      json: { meal_type: 'dinner', occurrence_at: '2026-11-13T19:00:00Z', items: [{ fdc_id: 171477, amount: 100, unit: 'g' }] },
    });
    const itemId = r.data.items[0].id;
    const edited = await api(`/item/${itemId}`, { method: 'PATCH', json: { amount: 200, unit: 'g' } });
    expect(edited.data.items[0].nutrients.ENERC_KCAL).toBe(330);
    expect(edited.data.items[0].id).toBe(itemId);

    const swapped = await api(`/item/${itemId}`, { method: 'PATCH', json: { fdc_id: 168878 } });
    expect(swapped.data.items[0].display_name).toMatch(/^Rice/);
    expect(swapped.data.items[0].nutrients.ENERC_KCAL).toBe(260);

    const added = await api(`/intake/${r.data.id}/items`, { method: 'POST', json: { fdc_id: 171477, amount: 1, unit: 'breast' } });
    expect(added.data.items[1].grams).toBe(172);

    const patched = await api(`/intake/${r.data.id}`, { method: 'PATCH', json: { meal_type: 'lunch', note: 'leftovers' } });
    expect(patched.data).toMatchObject({ meal_type: 'lunch', note: 'leftovers' });

    const del = await api(`/intake/${r.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const day = await api('/day/2026-11-13');
    expect(day.data.meals).toHaveLength(0);
  });

  it('copies a meal to now', async () => {
    const r = await api('/intake', {
      method: 'POST',
      json: { meal_type: 'breakfast', occurrence_at: '2026-11-01T08:00:00Z', items: [{ fdc_id: 748967, amount: 2, unit: 'egg' }] },
    });
    expect(r.data.items[0].grams).toBe(100);
    const copy = await api(`/intake/${r.data.id}/copy`, { method: 'POST', json: { occurrence_at: '2026-11-02T08:00:00Z' } });
    expect(copy.status).toBe(201);
    expect(copy.data).toMatchObject({ source: 'copy', meal_type: 'breakfast', log_date: '2026-11-02' });
    expect(copy.data.totals.ENERC_KCAL).toBe(148);
  });

  it('validates input and isolates users', async () => {
    expect((await api('/intake', { method: 'POST', json: { items: [] } })).status).toBe(400);
    expect((await api('/intake', { method: 'POST', json: { items: [{ fdc_id: 171477, amount: -1, unit: 'g' }] } })).status).toBe(400);
    const r = await api('/intake', {
      method: 'POST',
      json: { occurrence_at: '2026-11-05T12:00:00Z', items: [{ fdc_id: 171477, amount: 100, unit: 'g' }] },
    });
    const other = await api(`/intake/${r.data.id}`, {}, { DEV_USER_EMAIL: 'someone-else@example.test' });
    expect(other.status).toBe(404);
    const otherItem = await api(`/item/${r.data.items[0].id}`, { method: 'PATCH', json: { amount: 1 } }, { DEV_USER_EMAIL: 'someone-else@example.test' });
    expect(otherItem.status).toBe(404);
  });

  it('sets confidence per item without touching the numbers', async () => {
    const r = await api('/intake', {
      method: 'POST',
      json: { occurrence_at: '2026-11-06T12:00:00Z', items: [{ fdc_id: 171477, amount: 100, unit: 'g' }, { fdc_id: 168878, amount: 100, unit: 'g' }] },
    });
    const [a, b] = r.data.items;
    const low = await api(`/item/${a.id}`, { method: 'PATCH', json: { confidence: 0.3 } });
    const items = low.data.items;
    expect(items[0]).toMatchObject({ id: a.id, confidence: 0.3, grams: 100 });
    expect(items[0].nutrients.ENERC_KCAL).toBe(a.nutrients.ENERC_KCAL);
    expect(items[1].confidence).toBe(b.confidence);
    expect(low.data.confidence).toBe(0.3); // meal keeps the lowest item value for export

    // Editing an amount normally means "exact", but an explicit confidence wins.
    const edit = await api(`/item/${b.id}`, { method: 'PATCH', json: { amount: 150, unit: 'g', confidence: 0.6 } });
    expect(edit.data.items[1]).toMatchObject({ grams: 150, confidence: 0.6 });
    expect((await api(`/item/${a.id}`, { method: 'PATCH', json: { confidence: 2 } })).status).toBe(400);
  });

  it('accepts relative sizes: handfuls, bowls, glasses, and the food\'s own portions first', async () => {
    const r = await api('/intake', { method: 'POST', json: { occurrence_at: '2026-11-07T12:00:00Z', items: [{ fdc_id: 171477, amount: 100, unit: 'g' }] } });
    const id = r.data.items[0].id;
    const handful = await api(`/item/${id}`, { method: 'PATCH', json: { amount: 1, unit: 'handful' } });
    expect(handful.data.items[0]).toMatchObject({ grams: 30, amount_unit: 'handful' });
    const bowls = await api(`/item/${id}`, { method: 'PATCH', json: { amount: 1.5, unit: 'bowls' } });
    expect(bowls.data.items[0]).toMatchObject({ grams: 450, amount_value: 1.5, amount_unit: 'bowl' });
    expect(bowls.data.items[0].nutrients.ENERC_KCAL).toBeCloseTo(742.5, 1);
    // The food's own portion beats the generic table: chicken's "1 cup, chopped" is 140 g, not 240.
    const cup = await api(`/item/${id}`, { method: 'PATCH', json: { amount: 1, unit: 'cup' } });
    expect(cup.data.items[0].grams).toBe(140);
    const mug = await api(`/item/${id}`, { method: 'PATCH', json: { amount: 2, unit: 'mugs' } });
    expect(mug.data.items[0].grams).toBe(600);
  });
});
