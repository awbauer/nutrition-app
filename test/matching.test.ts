import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, json, mockFetch } from './helpers';

const U = { DEV_USER_EMAIL: 'matching@example.test' };
const food = (fdcId: number, description: string, dataType: string, kcal: number, protein = 0) => ({
  fdcId,
  description,
  dataType,
  foodNutrients: [
    { nutrientId: 1008, unitName: 'KCAL', value: kcal },
    { nutrientId: 1003, unitName: 'G', value: protein },
  ],
  foodMeasures: [],
});
const SALMON = [
  food(173582, 'Fish oil, salmon', 'SR Legacy', 902),
  food(175167, 'Fish, salmon, Atlantic, farmed, raw', 'SR Legacy', 208, 20),
  food(2684441, 'Fish, salmon, sockeye, raw', 'Foundation', 131, 22),
];
const DETAIL: Record<string, unknown> = {
  '175167': {
    fdcId: 175167,
    description: 'Fish, salmon, Atlantic, farmed, raw',
    dataType: 'SR Legacy',
    foodNutrients: [
      { nutrient: { id: 1008, unitName: 'kcal' }, amount: 208 },
      { nutrient: { id: 1003, unitName: 'g' }, amount: 20.4 },
    ],
    foodPortions: [{ gramWeight: 85, amount: 3, modifier: 'oz', measureUnit: { name: 'undetermined' } }],
  },
  '2684441': {
    fdcId: 2684441,
    description: 'Fish, salmon, sockeye, raw',
    dataType: 'Foundation',
    foodNutrients: [
      { nutrient: { id: 2047, unitName: 'kcal' }, amount: 131 },
      { nutrient: { id: 1003, unitName: 'g' }, amount: 22 },
    ],
    foodPortions: [],
  },
};

const FAIRLIFE = [
  food(170883, 'Milk shakes, thick chocolate', 'SR Legacy', 119, 3),
  { ...food(2345678, 'NUTRITION PLAN CHOCOLATE PROTEIN SHAKE', 'Branded', 44, 8.8), brandName: 'FAIRLIFE', gtinUpc: '811620022118' },
];
let searches = 0;
beforeEach(() => {
  searches = 0;
  mockFetch((url) => {
    if (url.hostname === 'world.openfoodfacts.org') return json({ status: 0 });
    if (url.hostname !== 'api.nal.usda.gov') return undefined;
    if (url.pathname.endsWith('/foods/search')) {
      searches++;
      const q = url.searchParams.get('query') ?? '';
      if (/salmon/i.test(q)) return json({ foods: SALMON });
      if (/811620022118|fairlife/i.test(q)) return json({ foods: FAIRLIFE });
      return json({ foods: [] });
    }
    const m = /\/food\/(\d+)$/.exec(url.pathname);
    return m && DETAIL[m[1]!] ? json(DETAIL[m[1]!]) : json({}, 404);
  });
});
afterEach(() => vi.restoreAllMocks());

const ai = (out: unknown) => ({ run: async () => ({ response: out }) }) as unknown as Ai;
const form = (text: string) => {
  const f = new FormData();
  f.append('text', text);
  return f;
};
const sashimi = {
  items: [{ name: 'salmon sashimi', amount: 85, unit: 'g', confidence: 0.9, search_terms: ['salmon raw'], estimate_per_100g: { kcal: 180, protein: 20 } }],
  questions: [],
};

describe('matching with candidates', () => {
  it('rejects implausible top hits and records the candidates it considered', async () => {
    const r = await api('/intake', { method: 'POST', body: form('salmon sashimi') }, { ...U, AI: ai(sashimi) });
    expect(r.status).toBe(202);
    const item = r.data.items[0];
    expect(item.food_name).not.toMatch(/oil/i);
    expect(item.food_name).toMatch(/salmon.*raw/i);
    expect(item.display_name).toBe('salmon sashimi');
    expect(item.has_match_details).toBe(true);
    expect(item.check_match).toBe(false);

    const d = await api(`/item/${item.id}`, {}, U);
    expect(d.status).toBe(200);
    expect(d.data.match.query).toBe('salmon raw');
    expect(d.data.match.estimate_kcal_100g).toBe(180);
    const oil = d.data.match.candidates.find((c: any) => c.name === 'Fish oil, salmon');
    expect(oil.notes.join(' ')).toMatch(/kcal 902 vs ~180/);
    expect(d.data.match.candidates[0].score).toBeGreaterThan(oil.score);
    expect(d.data.food.fdc_url).toMatch(/^https:\/\/fdc\.nal\.usda\.gov\/food-details\/\d+\/nutrients$/);
    expect(d.data.conversion).toMatchObject({ method: 'mass', stored_grams: 85 });
  });

  it('searches alternatives, swaps the match, keeps the label and remembers the choice', async () => {
    const r = await api('/intake', { method: 'POST', body: form('salmon sashimi') }, { ...U, AI: ai(sashimi) });
    const itemId = r.data.items[0].id;
    const s = await api(`/item/${itemId}/search?q=sockeye salmon`, {}, U);
    const sockeye = s.data.candidates.find((c: any) => /sockeye/.test(c.name));
    expect(sockeye).toMatchObject({ source: 'usda', fdc_id: '2684441', kcal_100g: 131 });

    const swapped = await api(`/item/${itemId}`, { method: 'PATCH', json: { fdc_id: sockeye.fdc_id } }, U);
    const it2 = swapped.data.items.find((i: any) => i.id === itemId);
    expect(it2).toMatchObject({ display_name: 'salmon sashimi', food_name: 'Fish, salmon, sockeye, raw', grams: 85, has_match_details: true });
    expect(it2.nutrients.ENERC_KCAL).toBeCloseTo(111.4, 1);
    const d = await api(`/item/${itemId}`, {}, U);
    expect(d.data.match.chosen).toBe('2684441');

    // Next time "salmon sashimi" is logged, the remembered choice wins without a search.
    searches = 0;
    const again = await api('/intake', { method: 'POST', body: form('salmon sashimi again') }, { ...U, AI: ai(sashimi) });
    expect(again.data.items[0].food_name).toBe('Fish, salmon, sockeye, raw');
    expect(searches).toBe(0);
    const d2 = await api(`/item/${again.data.items[0].id}`, {}, U);
    expect(d2.data.match.via).toBe('alias');
  });

  it('falls back to the estimate but keeps candidates when nothing is plausible', async () => {
    const out = { items: [{ name: 'salmon oil capsule', amount: 2, unit: 'g', confidence: 0.8, search_terms: ['salmon'], estimate_per_100g: { kcal: 20 } }], questions: [] };
    const r = await api('/intake', { method: 'POST', body: form('x') }, { DEV_USER_EMAIL: 'fallback@example.test', AI: ai(out) });
    const item = r.data.items[0];
    expect(item.estimated).toBe(true);
    const d = await api(`/item/${item.id}`, {}, { DEV_USER_EMAIL: 'fallback@example.test' });
    expect(d.data.match.via).toBe('estimate');
    expect(d.data.match.candidates.length).toBeGreaterThan(0);
  });

  it("isolates item details by user", async () => {
    const r = await api('/intake', { method: 'POST', body: form('salmon sashimi') }, { ...U, AI: ai(sashimi) });
    expect((await api(`/item/${r.data.items[0].id}`, {}, { DEV_USER_EMAIL: 'intruder@example.test' })).status).toBe(404);
    expect((await api(`/item/${r.data.items[0].id}/search?q=salmon`, {}, { DEV_USER_EMAIL: 'intruder@example.test' })).status).toBe(404);
  });

  it("uses the model's weight estimate instead of the generic size table", async () => {
    const out = { items: [{ name: 'salmon sashimi', amount: 1, unit: 'medium', grams: 60, confidence: 0.8, search_terms: ['salmon raw'], estimate_per_100g: { kcal: 180 } }], questions: [] };
    const r = await api('/intake', { method: 'POST', body: form('x') }, { DEV_USER_EMAIL: 'grams@example.test', AI: ai(out) });
    expect(r.data.items[0].grams).toBe(60); // generic "medium" would be 150 g
    const d = await api(`/item/${r.data.items[0].id}`, {}, { DEV_USER_EMAIL: 'grams@example.test' });
    expect(d.data.conversion).toMatchObject({ method: 'ai-estimate', stored_grams: 60 });
  });

  it('reads printed label values and saves the product as your food', async () => {
    const out = {
      items: [{ name: 'fairlife nutrition plan chocolate protein shake', brand: 'fairlife', amount: 340, unit: 'ml', grams: 340, confidence: 0.95,
        label: { serving_amount: 340, serving_unit: 'ml', kcal: 150, protein: 30, fat: 2.5, carbs: 4 }, estimate_per_100g: { kcal: 60 } }],
      questions: [],
    };
    const E = { DEV_USER_EMAIL: 'label@example.test', AI: ai(out) };
    const f = new FormData();
    f.append('photo', new File([new Uint8Array([0xff, 0xd8])], 'p.jpg', { type: 'image/jpeg' }));
    const r = await api('/intake', { method: 'POST', body: f }, E);
    const item = r.data.items[0];
    expect(item).toMatchObject({ estimation_method: 'label', food_source: 'custom', grams: 340 });
    expect(item.nutrients.ENERC_KCAL).toBe(150);
    expect(item.nutrients.PROCNT).toBe(30);
    expect(item.confidence).toBeGreaterThanOrEqual(0.9);
    const d = await api(`/item/${item.id}`, {}, E);
    expect(d.data.match.via).toBe('label');

    // Next time the same product is logged it matches your saved food without a search.
    searches = 0;
    const again = await api('/intake', { method: 'POST', body: form('x') }, { ...E, AI: ai({ ...out, items: [{ ...out.items[0], label: null }] }) });
    expect(again.data.items[0].food_name).toBe('fairlife nutrition plan chocolate protein shake');
    expect(again.data.items[0].nutrients.ENERC_KCAL).toBe(150);
    expect(searches).toBe(0);
  });

  it('matches a barcode to USDA Branded when Open Food Facts has nothing', async () => {
    const out = { items: [{ name: 'fairlife chocolate milk', brand: 'fairlife', amount: 340, unit: 'ml', confidence: 0.8, barcode: '8 11620 02211 8', estimate_per_100g: { kcal: 60 } }], questions: [] };
    const E = { DEV_USER_EMAIL: 'barcode@example.test', AI: ai(out) };
    const r = await api('/intake', { method: 'POST', body: form('x') }, E);
    const item = r.data.items[0];
    expect(item.food_name).toBe('NUTRITION PLAN CHOCOLATE PROTEIN SHAKE');
    expect(item).toMatchObject({ estimation_method: 'label' });
    expect(item.nutrients.PROCNT).toBeCloseTo(29.9, 0);
    expect((await api(`/item/${item.id}`, {}, E)).data.match.via).toBe('barcode');
  });

  it('uses the brand to prefer the branded product over a generic food', async () => {
    const out = { items: [{ name: 'chocolate protein shake', brand: 'fairlife', amount: 340, unit: 'ml', confidence: 0.8, search_terms: ['chocolate protein shake'], estimate_per_100g: { kcal: 50 } }], questions: [] };
    const r = await api('/intake', { method: 'POST', body: form('x') }, { DEV_USER_EMAIL: 'brand@example.test', AI: ai(out) });
    expect(r.data.items[0].food_name).toBe('NUTRITION PLAN CHOCOLATE PROTEIN SHAKE');
  });
});
