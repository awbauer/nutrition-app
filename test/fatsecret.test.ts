import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FatSecretClient, FatSecretError, normaliseFatSecret, oauthSignature, rfc3986, type FsFood } from '../src/worker/lib/fatsecret';
import { api, json, mockFetch, testEnv } from './helpers';

const DRINK: FsFood = {
  food_id: '123456',
  food_name: 'Pistachio Cream Cold Brew (Grande)',
  food_type: 'Brand',
  brand_name: 'Starbucks',
  servings: {
    serving: [
      {
        serving_id: '1',
        serving_description: '1 grande',
        metric_serving_amount: '473.000',
        metric_serving_unit: 'ml',
        number_of_units: '1.000',
        measurement_description: 'grande',
        is_default: '1',
        calories: '250',
        protein: '3.00',
        fat: '12.00',
        carbohydrate: '31.00',
        sugar: '30.00',
        saturated_fat: '8.000',
        sodium: '125',
      },
      {
        serving_id: '2',
        serving_description: '100 ml',
        metric_serving_amount: '100.000',
        metric_serving_unit: 'ml',
        number_of_units: '100.000',
        measurement_description: 'ml',
        calories: '53',
      },
    ],
  },
};

describe('FatSecret client', () => {
  it('signs requests with OAuth 1.0 HMAC-SHA1 and the consumer secret alone', async () => {
    const params = { method: 'foods.search.v3', search_expression: 'cold brew (pistachio)! 50%', oauth_nonce: 'abc', oauth_timestamp: '1700000000' };
    const sig = await oauthSignature('GET', 'https://platform.fatsecret.com/rest/server.api', params, 's3cr3t');
    const normalized = Object.keys(params)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(params[k as keyof typeof params])}`)
      .join('&');
    const base = `GET&${rfc3986('https://platform.fatsecret.com/rest/server.api')}&${rfc3986(normalized)}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cr3t&'), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)))));
    expect(sig).toBe(expected);
    // The base string as the spec builds it: sorted, RFC 3986, then encoded again as a whole.
    expect(base).toContain('search_expression%3Dcold%2520brew%2520%2528pistachio%2529%2521%252050%2525');
    expect(rfc3986("(!'*)")).toBe('%28%21%27%2A%29');
  });

  it("turns a restaurant item's servings into per-100 g nutrients and a named portion", () => {
    const f = normaliseFatSecret(DRINK)!;
    expect(f).toMatchObject({ source: 'fatsecret', sourceId: '123456', brand: 'Starbucks', dataType: 'FatSecret Brand', defaultServingGrams: 473 });
    expect(f.portions).toEqual([{ label: '1 grande', unit: 'grande', amount: 1, grams: 473 }]);
    const v = Object.fromEntries(f.nutrients.map((n) => [n.code, n.value]));
    expect(v.ENERC_KCAL).toBeCloseTo(52.85, 2);
    expect(v.NA).toBeCloseTo(26.43, 2);
    expect(v.FASAT).toBeCloseTo(1.69, 2);
  });

  it('reads "oz" as fluid ounces for drinks and as weight for food', () => {
    const oz = (name: string) =>
      normaliseFatSecret({
        food_id: '9',
        food_name: name,
        servings: {
          serving: {
            serving_description: '1 serving',
            metric_serving_amount: '16.000',
            metric_serving_unit: 'oz',
            number_of_units: '1',
            measurement_description: 'serving',
            calories: '250',
          },
        },
      })!.portions[0]!.grams;
    expect(oz('Pistachio Cream Cold Brew (Grande)')).toBeCloseTo(473.2, 1);
    expect(oz('Iced Brown Sugar Oatmilk Shaken Espresso (Grande)')).toBeCloseTo(473.2, 1);
    expect(oz('Bacon, Gouda & Egg Sandwich')).toBeCloseTo(453.6, 1);
  });

  it('drops foods with no metric serving and accepts a single serving object', () => {
    expect(normaliseFatSecret({ food_id: '1', food_name: 'x', servings: { serving: { serving_description: '1 item', calories: '100' } } })).toBeNull();
    const one = normaliseFatSecret({ ...DRINK, servings: { serving: (DRINK.servings!.serving as any[])[0] } });
    expect(one?.portions).toHaveLength(1);
  });

  it('falls back to the Basic search, fetching servings for each hit, when the key has no Premier', async () => {
    const methods: string[] = [];
    const c = new FatSecretClient('basic-key', 's', async (input) => {
      const m = new URL(String(input)).searchParams.get('method')!;
      methods.push(m);
      if (m === 'foods.search.v3') return json({ error: { code: 10, message: 'Unknown method' } });
      if (m === 'foods.search') return json({ foods: { food: [{ food_id: '123456', food_name: DRINK.food_name, food_description: 'Per 1 serving - Calories: 250kcal' }] } });
      if (m === 'food.get.v4') return json({ food: DRINK });
      return json({ error: { code: 0, message: 'unexpected' } });
    });
    const hits = await c.search('pistachio cold brew');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sourceId: '123456', portions: [{ label: '1 grande', grams: 473 }] });
    expect(methods).toEqual(['foods.search.v3', 'foods.search', 'food.get.v4']);
    // Remembered: the next search goes straight to Basic.
    methods.length = 0;
    await c.search('again');
    expect(methods).toEqual(['foods.search', 'food.get.v4']);
  });

  it('reports errors FatSecret sends in a 200 body', async () => {
    const c = new FatSecretClient('k', 's', async () => json({ error: { code: 21, message: 'Invalid IP address detected' } }));
    await expect(c.search('x')).rejects.toBeInstanceOf(FatSecretError);
    await expect(c.search('x')).rejects.toThrow(/21: Invalid IP/);
  });
});

describe('FatSecret in matching and search', () => {
  const FS = { FATSECRET_CONSUMER_KEY: 'key', FATSECRET_CONSUMER_SECRET: 'secret' };
  let fsCalls: URL[] = [];
  beforeEach(() => {
    fsCalls = [];
    mockFetch((url) => {
      if (url.hostname === 'api.nal.usda.gov') {
        // USDA has nothing like it.
        return json({
          foods: [
            { fdcId: 1, description: 'Beverages, coffee, brewed', dataType: 'SR Legacy', foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 1 }], foodMeasures: [] },
          ],
        });
      }
      if (url.hostname === 'platform.fatsecret.com') {
        fsCalls.push(url);
        const method = url.searchParams.get('method');
        if (method === 'foods.search.v3') return json({ foods_search: { results: { food: [DRINK] } } });
        if (method === 'food.get.v4') return json({ food: DRINK });
      }
      return undefined;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('matches a Starbucks drink USDA lacks, and keeps it stored as a shared food', async () => {
    const E = { DEV_USER_EMAIL: 'fatsecret@example.test', ...FS };
    const out = {
      items: [
        {
          name: 'pistachio cream cold brew',
          brand: 'Starbucks',
          amount: 1,
          unit: 'grande',
          grams: 473,
          confidence: 0.8,
          search_terms: ['pistachio cream cold brew'],
          estimate_per_100g: { kcal: 55 },
        },
      ],
      questions: [],
    };
    const f = new FormData();
    f.append('text', 'grande pistachio cream cold brew from starbucks');
    const r = await api('/intake', { method: 'POST', body: f }, { ...E, AI: { run: async () => ({ response: out }) } as unknown as Ai });
    const item = r.data.items[0];
    expect(item).toMatchObject({ food_source: 'fatsecret', food_name: 'Pistachio Cream Cold Brew (Grande)', grams: 473 });
    expect(item.nutrients.ENERC_KCAL).toBeCloseTo(250, 0);
    const d = await api(`/item/${item.id}`, {}, E);
    expect(d.data.match).toMatchObject({ via: 'fatsecret', chosen: '123456' });

    // Signed request: OAuth 1.0 parameters, JSON, the search text.
    const call = fsCalls[0]!;
    expect(call.searchParams.get('oauth_consumer_key')).toBe('key');
    expect(call.searchParams.get('oauth_signature_method')).toBe('HMAC-SHA1');
    expect(call.searchParams.get('oauth_signature')).toBeTruthy();
    expect(call.searchParams.get('format')).toBe('json');
    expect(call.searchParams.get('search_expression')).toBe('Starbucks pistachio cream cold brew');

    // Stored as a shared row the app reads back as FatSecret.
    const row = await testEnv.DB.prepare('SELECT source, source_id, owner_user_id FROM food WHERE id = ?').bind(item.food_id).first();
    expect(row).toEqual({ source: 'custom', source_id: 'fatsecret:123456', owner_user_id: null });
    expect((await api(`/foods/${item.food_id}`, {}, E)).data).toMatchObject({ source: 'fatsecret', source_id: '123456' });
    // It isn't one of the user's own foods.
    expect((await api('/foods/mine', {}, E)).data).toEqual([]);
  });

  it('lists FatSecret hits in search and resolves one by id, from the cache the second time', async () => {
    const E = { DEV_USER_EMAIL: 'fatsecret-search@example.test', ...FS };
    const s = await api('/foods?q=pistachio%20cold%20brew', {}, E);
    // Either fresh from FatSecret or, once someone has logged it, from the shared cache.
    const hit = s.data.fatsecret[0] ?? s.data.local.find((f: any) => f.source === 'fatsecret');
    expect(hit).toMatchObject({ source: 'fatsecret', brand: 'Starbucks' });
    expect(hit.sourceId ?? hit.source_id).toBe('123456');
    const a = await api('/foods/fatsecret/123456', {}, E);
    expect(a.data).toMatchObject({ source: 'fatsecret', name: 'Pistachio Cream Cold Brew (Grande)' });
    const gets = fsCalls.filter((u) => u.searchParams.get('method') === 'food.get.v4').length;
    expect((await api('/foods/fatsecret/123456', {}, E)).data.id).toBe(a.data.id);
    expect(fsCalls.filter((u) => u.searchParams.get('method') === 'food.get.v4').length).toBe(gets);
  });

  it('is skipped entirely without keys', async () => {
    const s = await api('/foods?q=pistachio%20cold%20brew', {}, { DEV_USER_EMAIL: 'fatsecret-off@example.test' });
    expect(s.data.fatsecret).toEqual([]);
    expect(fsCalls).toHaveLength(0);
    expect((await api('/foods/fatsecret/777', {}, { DEV_USER_EMAIL: 'fatsecret-off@example.test' })).status).toBe(503);
  });
});
