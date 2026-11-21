import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractJson, validateOutput } from '../src/worker/lib/ai';
import { api, json, mockFetch, testEnv } from './helpers';
import { DETAILS } from './fixtures/usda';

const oilSearch = {
  foods: [
    {
      fdcId: 171413,
      description: 'Oil, olive, salad or cooking',
      dataType: 'SR Legacy',
      foodNutrients: [
        { nutrientId: 1008, unitName: 'KCAL', value: 884 },
        { nutrientId: 1004, unitName: 'G', value: 100 },
      ],
      foodMeasures: [
        { disseminationText: '1 tbsp', gramWeight: 13.5, rank: 1 },
        { disseminationText: '1 tsp', gramWeight: 4.5, rank: 2 },
      ],
    },
  ],
};
const chickenSearch = {
  foods: [
    {
      fdcId: 171477,
      description: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
      dataType: 'SR Legacy',
      foodNutrients: [
        { nutrientId: 1008, unitName: 'KCAL', value: 165 },
        { nutrientId: 1003, unitName: 'G', value: 31 },
      ],
      foodMeasures: [],
    },
  ],
};

let usdaCalls = 0;
beforeEach(() => {
  usdaCalls = 0;
  mockFetch((url) => {
    if (url.hostname === 'world.openfoodfacts.org') {
      // A crowd-sourced entry with per-serving numbers in its per-100 g fields.
      if (url.pathname.includes('022224200714'))
        return json({
          status: 1,
          product: {
            product_name: 'Black Licorice',
            brands: 'Candy Co',
            serving_quantity: 38,
            nutriments: { 'energy-kcal_100g': 866, carbohydrates_100g: 194, proteins_100g: 7, fat_100g: 7 },
          },
        });
      return json({
        status: 1,
        product: {
          product_name: 'Sparkling Water Lime',
          brands: 'Fizz Co',
          serving_quantity: 355,
          serving_size: '1 can',
          nutriments: { 'energy-kcal_100g': 0, sodium_100g: 0.01 },
        },
      });
    }
    if (url.hostname !== 'api.nal.usda.gov') return undefined;
    usdaCalls++;
    if (url.pathname.endsWith('/foods/search')) {
      const q = url.searchParams.get('query') ?? '';
      const dt = url.searchParams.get('dataType') ?? '';
      if (!dt.includes('SR Legacy')) return json({ foods: [] });
      if (/oil/.test(q)) return json(oilSearch);
      if (/chicken/.test(q)) return json(chickenSearch);
      return json({ foods: [] });
    }
    const m = /\/food\/(\d+)$/.exec(url.pathname);
    if (m && DETAILS[m[1]!]) return json(DETAILS[m[1]!]);
    return json({}, 404);
  });
});
afterEach(() => vi.restoreAllMocks());

function fakeAI(responses: unknown[]) {
  const calls: { model: string; inputs: any; opts: any }[] = [];
  return {
    calls,
    AI: {
      run: async (model: string, inputs: any, opts: any) => {
        calls.push({ model, inputs, opts });
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    } as unknown as Ai,
  };
}

const chickenOutput = {
  meal_type_guess: 'dinner',
  items: [
    { name: 'grilled chicken breast', amount: 150, unit: 'g', confidence: 0.7, search_terms: ['chicken breast roasted'], barcode: null },
    { name: 'mystery sauce', amount: 30, unit: 'g', confidence: 0.6, search_terms: [], barcode: null, estimate_per_100g: { kcal: 200, protein: 1 } },
  ],
  questions: [
    {
      id: 'q1',
      item_index: 0,
      text: 'Cooked in oil?',
      options: ['None', '1 tsp oil', '1 tbsp oil'],
      default: '1 tsp oil',
      effects: {
        None: {},
        '1 tsp oil': { add_item: { name: 'olive oil', amount: 1, unit: 'tsp', search_terms: ['olive oil'] } },
        '1 tbsp oil': { add_item: { name: 'olive oil', amount: 1, unit: 'tbsp', search_terms: ['olive oil'] } },
      },
    },
    {
      id: 'q2',
      item_index: 0,
      text: 'Skin on?',
      options: ['No', 'Yes'],
      default: 'No',
      effects: { No: {}, Yes: { set_amount: { amount: 155, unit: 'g' } } },
    },
  ],
};

function form(fields: Record<string, string | Blob>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe('model output validation', () => {
  it('extracts JSON from fenced or chatty text', () => {
    expect(extractJson('Sure!\n```json\n{"items":[]}\n```')).toEqual({ items: [] });
  });
  it('tolerates comments and trailing commas copied from the example', () => {
    const raw = '{\n "items": [{"name": "a // b", "grams": 454, // 16 fl oz\n "x": "http://y" /* note */,}],\n}';
    expect(extractJson(raw)).toEqual({ items: [{ name: 'a // b', grams: 454, x: 'http://y' }] });
  });
  it('normalises fields and drops bad questions', () => {
    const v = validateOutput({
      meal_type_guess: 'brunch',
      items: [{ name: 'toast', amount: '2', unit: 'slice', confidence: 3 }],
      questions: [
        { text: 'one option only', options: ['a'], default: 'a', effects: {} },
        { text: 'Butter?', options: ['No', 'Yes'], default: 'maybe', effects: { Yes: { add_item: { name: 'butter', amount: 1, unit: 'tsp' } } } },
      ],
    });
    expect(v.meal_type_guess).toBeNull();
    expect(v.items[0]).toMatchObject({ amount: 2, confidence: 1, search_terms: [] });
    expect(v.questions).toHaveLength(1);
    expect(v.questions[0]).toMatchObject({ default: 'No', id: 'q2' });
    expect(v.questions[0]!.effects.Yes!.add_item!.search_terms).toEqual(['butter']);
  });
  it('reads OpenAI-style responses and gives reasoning models room to answer', async () => {
    const { modelOptions } = await import('../src/worker/lib/ai');
    expect(modelOptions('@cf/thinkingmachines/inkling-2-small')).toMatchObject({ reasoning_effort: 'low', max_tokens: 8000 });
    expect(modelOptions('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toEqual({ max_tokens: 1500 });
    const choices = { choices: [{ message: { content: '{"items":[{"name":"apple","amount":1,"unit":"medium","confidence":0.9}]}' } }] };
    const r = await api('/intake', { method: 'POST', body: form({ text: 'apple' }) }, { AI: fakeAI([choices]).AI });
    expect(r.data.items[0].display_name).toBe('apple');
  });
  it('normalises barcodes and validates printed label values', () => {
    const v = validateOutput({
      items: [
        { name: 'x', amount: 1, unit: 'bottle', barcode: '8 11620 02211 8', brand: ' fairlife ', label: { serving_amount: '340', serving_unit: 'mL', kcal: 150, protein: 30 } },
      ],
    });
    expect(v.items[0]).toMatchObject({ barcode: '811620022118', brand: 'fairlife', label: { serving_amount: 340, serving_unit: 'ml', kcal: 150, protein: 30 } });
    const bad = validateOutput({ items: [{ name: 'x', amount: 1, unit: 'g', label: { kcal: 150 } }] });
    expect(bad.items[0]!.label).toBeNull();
  });
  it('drops barcodes that fail the check digit', async () => {
    const { validGtin } = await import('../src/worker/lib/ai');
    expect(validGtin('811620022118')).toBe(true); // the fairlife bottle
    expect(validGtin('011620022118')).toBe(false); // same barcode with the first digit misread
    expect(validGtin('4006381333931')).toBe(true); // EAN-13
    expect(validGtin('12345')).toBe(false);
    expect(validateOutput({ items: [{ name: 'x', amount: 1, unit: 'g', barcode: '011620022118' }] }).items[0]!.barcode).toBeNull();
  });
  it('rejects outputs without items', () => {
    expect(() => validateOutput('{"foo":1}')).toThrow();
  });
});

describe('text logging', () => {
  it('parses, matches foods, asks only questions that matter, and completes on answers', async () => {
    const ai = fakeAI([{ response: JSON.stringify(chickenOutput) }]);
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } });
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken breast with some sauce', occurrence_at: '2026-11-14T19:00:00Z' }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(ai.calls[0]!.opts).toEqual({ gateway: { id: 'nutrition' } });
    expect(r.data).toMatchObject({ source: 'text', status: 'in-progress', meal_type: 'dinner', prompt_version: 'parse-v8', pipeline_version: '2.0' });
    expect(r.data.model_id).toMatch(/llama/);

    // q2 (5 g difference) is not worth asking; the oil question is.
    expect(r.data.pending.questions).toHaveLength(1);
    expect(r.data.pending.questions[0]).toEqual({ id: 'q1', item_index: 0, text: 'Cooked in oil?', options: ['None', '1 tsp oil', '1 tbsp oil'], default: '1 tsp oil' });
    expect(r.data.pending.questions[0].effects).toBeUndefined();

    // Defaults are applied to the draft: chicken, sauce estimate, 1 tsp oil.
    const names = r.data.items.map((i: any) => i.display_name);
    expect(names).toEqual(['grilled chicken breast', 'mystery sauce', 'olive oil']);
    const sauce = r.data.items[1];
    expect(sauce).toMatchObject({ estimated: true, food_source: 'estimate' });
    expect(sauce.confidence).toBeLessThanOrEqual(0.4);
    expect(sauce.nutrients.ENERC_KCAL).toBe(60);
    expect(r.data.items[0].nutrients.ENERC_KCAL).toBeCloseTo(247.5);

    // The draft counts in the day at its default answers, flagged as unconfirmed.
    const before = await api('/day/2026-11-14');
    expect(before.data.totals.ENERC_KCAL).toBeCloseTo(r.data.totals.ENERC_KCAL, 0);
    expect(before.data.unconfirmed).toBe(1);

    const done = await api(`/intake/${r.data.id}/answers`, { method: 'POST', json: { answers: { q1: '1 tbsp oil' } } });
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('completed');
    expect(done.data.pending).toBeUndefined();
    const oil = done.data.items.find((i: any) => i.display_name === 'olive oil');
    expect(oil.grams).toBe(13.5);
    expect(oil.nutrients.ENERC_KCAL).toBeCloseTo(119.3, 1);
    expect(done.data.confidence).toBeLessThanOrEqual(0.4);
    for (const it of done.data.items) if (it.estimated) expect(it.confidence).toBeLessThanOrEqual(0.4);

    const after = await api('/day/2026-11-14');
    expect(after.data.totals.ENERC_KCAL).toBeCloseTo(247.5 + 60 + 119.3, 0);

    // Answering again is rejected.
    expect((await api(`/intake/${r.data.id}/answers`, { method: 'POST', json: { answers: {} } })).status).toBe(409);
  });

  it('skipping a question accepts the default and lowers confidence', async () => {
    const ai = fakeAI([{ response: chickenOutput }]);
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI: ai.AI });
    const done = await api(`/intake/${r.data.id}/answers`, { method: 'POST', json: { answers: {} } });
    const chicken = done.data.items[0];
    expect(chicken.confidence).toBeCloseTo(0.55);
    expect(done.data.items.find((i: any) => i.display_name === 'olive oil').grams).toBe(4.5);
  });

  it('reuses cached foods on repeat meals instead of calling USDA', async () => {
    const out = { items: [{ name: 'chicken breast', amount: 100, unit: 'g', confidence: 0.9, search_terms: ['chicken breast roasted'] }], questions: [] };
    await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI: fakeAI([{ response: out }]).AI });
    usdaCalls = 0;
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken again' }) }, { AI: fakeAI([{ response: out }]).AI });
    expect(r.data.status).toBe('completed');
    expect(usdaCalls).toBe(0);
  });

  it('retries once on invalid model output', async () => {
    const out = { items: [{ name: 'chicken breast', amount: 100, unit: 'g', confidence: 0.9 }], questions: [] };
    const ai = fakeAI([{ response: 'I think it is chicken' }, { response: out }]);
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(ai.calls).toHaveLength(2);
  });

  it('records a readable error on the meal after two bad outputs, and can retry', async () => {
    const ai = fakeAI([{ response: 'nope' }, { response: '{"items": "x"}' }]);
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(ai.calls).toHaveLength(2);
    expect(r.data.status).toBe('preparation');
    expect(r.data.pending.error).toMatch(/couldn't read that meal/);

    const out = { items: [{ name: 'chicken breast', amount: 100, unit: 'g', confidence: 0.9 }], questions: [] };
    const again = await api(`/intake/${r.data.id}/retry`, { method: 'POST' }, { AI: fakeAI([{ response: out }]).AI });
    expect(again.status).toBe(202);
    expect(again.data.status).toBe('completed');
    expect(again.data.pending).toBeUndefined();
    expect((await api(`/intake/${r.data.id}/retry`, { method: 'POST' })).status).toBe(409);
  });

  it('falls back to a second model when the configured one is out of capacity', async () => {
    const out = { items: [{ name: 'chicken breast', amount: 100, unit: 'g', confidence: 0.9 }], questions: [] };
    const ai = fakeAI([new Error('3040: Capacity temporarily exceeded, please try again.'), { response: out }]);
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI: ai.AI });
    expect(r.data.status).toBe('completed');
    expect(ai.calls.map((c) => c.model)).toEqual(['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct']);
  });

  it('records a plain "busy" error when every model is out of capacity', async () => {
    const ai = fakeAI([new Error('3040: Capacity temporarily exceeded, please try again.')]);
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI: ai.AI });
    expect(r.data.status).toBe('preparation');
    expect(r.data.pending.error).toBe('the AI service is busy right now, try again in a minute');
  });

  it('matches barcodes through Open Food Facts', async () => {
    const out = { items: [{ name: 'lime sparkling water', amount: 1, unit: 'can', confidence: 0.9, barcode: '012345678905' }], questions: [] };
    const r = await api('/intake', { method: 'POST', body: form({ text: 'a can of lime fizz 012345678905' }) }, { AI: fakeAI([{ response: out }]).AI });
    expect(r.data.items[0]).toMatchObject({ food_source: 'off', grams: 355 });
  });

  it('skips a barcode product whose nutrition data is impossible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = {
      items: [{ name: 'black licorice', amount: 40, unit: 'g', confidence: 0.8, barcode: '022224200714', estimate_per_100g: { kcal: 350, carbs: 80 } }],
      questions: [],
    };
    const r = await api('/intake', { method: 'POST', body: form({ text: 'black licorice 022224200714' }) }, { AI: fakeAI([{ response: out }]).AI });
    const item = r.data.items[0];
    expect(item.food_source).not.toBe('off');
    // 40 g at about 350 kcal/100 g, not 40 g at 866.
    expect(item.nutrients.ENERC_KCAL).toBeLessThan(200);
    expect(warn).toHaveBeenCalledWith('barcode product skipped, impossible nutrition data', expect.objectContaining({ why: 'CHOCDF 194 g per 100 g' }));
  });
});

describe('photo logging', () => {
  it('stores the photo privately, runs the vision model and serves media only to the owner', async () => {
    const out = {
      meal_type_guess: 'lunch',
      items: [{ name: 'roast chicken breast', amount: 120, unit: 'g', confidence: 0.8, search_terms: ['chicken breast roasted'] }],
      questions: [],
    };
    const ai = fakeAI([{ response: JSON.stringify(out) }]);
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' });
    const r = await api('/intake', { method: 'POST', body: form({ photo: new File([jpeg], 'meal.jpg', { type: 'image/jpeg' }) }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(r.data).toMatchObject({ source: 'photo', has_media: true, status: 'completed' });
    expect(r.data.items[0].estimation_method).toBe('photo-estimate');
    const msg = ai.calls[0]!.inputs.messages[0].content;
    expect(msg[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);

    const m = await api(`/intake/${r.data.id}/media`);
    expect(m.status).toBe(200);
    expect(m.res.headers.get('Content-Type')).toBe('image/jpeg');
    const other = await api(`/intake/${r.data.id}/media`, {}, { DEV_USER_EMAIL: 'other@example.test' });
    expect(other.status).toBe(404);
  });

  it('rejects non-image uploads and keeps the photo for a retry when the model fails', async () => {
    const bad = await api('/intake', { method: 'POST', body: form({ photo: new File(['hi'], 'a.txt', { type: 'text/plain' }) }) });
    expect(bad.status).toBe(415);
    const ai = fakeAI([new Error('gateway down')]);
    const r = await api('/intake', { method: 'POST', body: form({ photo: new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }) }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(r.data.pending.error).toBe("couldn't read that meal, try again");
    expect((await api(`/intake/${r.data.id}/media`)).status).toBe(200);
  });
});

describe('several photos of one meal', () => {
  const jpg = (n: number) => new File([new Uint8Array([0xff, 0xd8, 0xff, n])], `p${n}.jpg`, { type: 'image/jpeg' });
  const multi = (files: File[], extra: Record<string, string> = {}) => {
    const f = new FormData();
    for (const file of files) f.append('photo', file);
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    return f;
  };

  it('sends every photo in one request, told they are one meal, and serves each back in order', async () => {
    const out = {
      meal_type_guess: 'lunch',
      items: [
        { name: 'roast chicken breast', amount: 120, unit: 'g', confidence: 0.8, search_terms: ['chicken breast roasted'] },
        { name: 'apple', amount: 1, unit: 'medium', confidence: 0.9, search_terms: ['apple raw'] },
      ],
      questions: [],
    };
    const ai = fakeAI([{ response: JSON.stringify(out) }]);
    const r = await api('/intake', { method: 'POST', body: multi([jpg(1), jpg(2), jpg(3)], { text: 'the apple was small' }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(r.data).toMatchObject({ source: 'photo', photo_count: 3, has_media: true, status: 'completed' });
    expect(r.data.items.map((i: any) => i.display_name)).toHaveLength(2);
    expect(ai.calls).toHaveLength(1);
    const content = ai.calls[0]!.inputs.messages[0].content;
    expect(content.filter((c: any) => c.type === 'image_url')).toHaveLength(3);
    expect(content[0].text).toMatch(/These 3 photos are all of ONE meal/);
    expect(content[0].text).toMatch(/Count each food once/);
    expect(content[0].text).toMatch(/the apple was small/);

    for (const n of [1, 2, 3]) {
      const p = await api(`/intake/${r.data.id}/photos/${n - 1}`);
      expect(p.status).toBe(200);
      expect(p.res.headers.get('Content-Type')).toBe('image/jpeg');
    }
    expect((await api(`/intake/${r.data.id}/photos/3`)).status).toBe(404);
    expect((await api(`/intake/${r.data.id}/photos/0`, {}, { DEV_USER_EMAIL: 'other@example.test' })).status).toBe(404);
    // Older clients still get the first photo.
    expect((await api(`/intake/${r.data.id}/media`)).status).toBe(200);
  });

  it('a single photo keeps the single-photo prompt', async () => {
    const out = { items: [{ name: 'apple', amount: 1, unit: 'medium', confidence: 0.9 }], questions: [] };
    const ai = fakeAI([{ response: out }]);
    await api('/intake', { method: 'POST', body: multi([jpg(1)]) }, { AI: ai.AI });
    expect(ai.calls[0]!.inputs.messages[0].content[0].text).toMatch(/^Identify every food and drink shown in this photo/);
  });

  it('limits the number of photos', async () => {
    const r = await api('/intake', { method: 'POST', body: multi([1, 2, 3, 4, 5, 6, 7].map(jpg)) });
    expect(r.status).toBe(413);
  });

  it('reads photos one at a time with a single-image model and combines the items', async () => {
    await api('/settings', { method: 'PUT', json: { model_vision: '@cf/meta/llama-3.2-11b-vision-instruct' } }, { DEV_USER_EMAIL: 'single-image@example.test' });
    const a = { items: [{ name: 'apple', amount: 1, unit: 'medium', confidence: 0.9 }], questions: [] };
    const b = {
      items: [{ name: 'latte', amount: 350, unit: 'ml', confidence: 0.5, estimate_per_100g: { kcal: 60 } }],
      questions: [
        { id: 'q1', item_index: 0, text: 'Size?', options: ['Regular', 'Large'], default: 'Regular', effects: { Regular: {}, Large: { set_amount: { amount: 700, unit: 'ml' } } } },
      ],
    };
    const ai = fakeAI([{ response: a }, { response: b }]);
    const r = await api('/intake', { method: 'POST', body: multi([jpg(1), jpg(2)]) }, { AI: ai.AI, DEV_USER_EMAIL: 'single-image@example.test' } as any);
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[0]!.inputs.image).toBeTruthy();
    expect(r.data.items).toHaveLength(2);
    expect(r.data.pending.questions[0]).toMatchObject({ item_index: 1, text: 'Size?' });
  });
});

describe('voice logging', () => {
  it('transcribes with Whisper then parses the transcript', async () => {
    const out = { items: [{ name: 'chicken breast', amount: 100, unit: 'g', confidence: 0.8 }], questions: [] };
    const ai = fakeAI([{ text: ' I had a hundred grams of chicken breast ' }, { response: out }]);
    const r = await api('/intake', { method: 'POST', body: form({ audio: new File([new Uint8Array([1, 2, 3])], 'clip.m4a', { type: 'audio/mp4' }) }) }, { AI: ai.AI });
    expect(r.status).toBe(202);
    expect(r.data).toMatchObject({ source: 'voice', raw_input_text: 'I had a hundred grams of chicken breast', has_media: true });
    expect(ai.calls[0]!.model).toBe('@cf/openai/whisper-large-v3-turbo');
    expect(typeof ai.calls[0]!.inputs.audio).toBe('string');
  });

  it('accepts webm clips from non-Safari browsers and rejects silent clips', async () => {
    const out = { items: [{ name: 'apple', amount: 1, unit: 'medium', confidence: 0.9 }], questions: [] };
    const ok = await api(
      '/intake',
      { method: 'POST', body: form({ audio: new File([new Uint8Array([1])], 'v.webm', { type: 'audio/webm;codecs=opus' }) }) },
      { AI: fakeAI([{ text: 'an apple' }, { response: out }]).AI },
    );
    expect(ok.status).toBe(202);
    const silent = await api(
      '/intake',
      { method: 'POST', body: form({ audio: new File([new Uint8Array([1])], 'v.m4a', { type: 'audio/mp4' }) }) },
      { AI: fakeAI([{ text: '   ' }]).AI },
    );
    expect(silent.status).toBe(202);
    expect(silent.data.pending.error).toBe("couldn't hear any speech in that clip");
  });
});

describe('background processing', () => {
  it('returns the saved meal immediately and fills it in from the queue', async () => {
    const sent: any[] = [];
    const JOBS = { send: async (m: unknown) => void sent.push(m) } as unknown as Queue<any>;
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken breast', meal_type: 'lunch' }) }, { JOBS });
    expect(r.status).toBe(202);
    expect(r.data).toMatchObject({ status: 'preparation', meal_type: 'lunch', raw_input_text: 'chicken breast', items: [] });
    expect(sent).toEqual([{ intakeId: r.data.id, userId: expect.any(String) }]);

    // Drafts in preparation don't count toward totals.
    const day = await api(`/day/${r.data.log_date}`);
    expect(day.data.meals.find((m: any) => m.id === r.data.id).status).toBe('preparation');

    const { consume } = await import('../src/worker/lib/jobs');
    const out = {
      meal_type_guess: 'dinner',
      items: [{ name: 'chicken breast', amount: 120, unit: 'g', confidence: 0.9, search_terms: ['chicken breast roasted'] }],
      questions: [],
    };
    const acks: string[] = [];
    const msg = { body: sent[0], attempts: 1, ack: () => acks.push('ack'), retry: () => acks.push('retry') };
    await consume({ messages: [msg] } as never, { ...testEnv, AI: fakeAI([{ response: out }]).AI } as never, 2);
    expect(acks).toEqual(['ack']);
    const done = await api(`/intake/${r.data.id}`);
    expect(done.data.status).toBe('completed');
    expect(done.data.meal_type).toBe('lunch'); // user's choice beats the model's guess
    expect(done.data.items[0].grams).toBe(120);

    // A second delivery of the same message is a no-op.
    await consume({ messages: [{ ...msg }] } as never, { ...testEnv, AI: fakeAI([new Error('should not be called')]).AI } as never, 2);
    expect(acks).toEqual(['ack', 'ack']);
  });

  it('retries transient failures and records the error on the last attempt', async () => {
    const sent: any[] = [];
    const JOBS = { send: async (m: unknown) => void sent.push(m) } as unknown as Queue<any>;
    const r = await api('/intake', { method: 'POST', body: form({ text: 'toast' }) }, { JOBS });
    const { consume } = await import('../src/worker/lib/jobs');
    const env2 = { ...testEnv, AI: fakeAI([new Error('timeout')]).AI } as never;
    const acks: string[] = [];
    const mk = (attempts: number) => ({ body: sent[0], attempts, ack: () => acks.push(`ack${attempts}`), retry: () => acks.push(`retry${attempts}`) });
    await consume({ messages: [mk(1)] } as never, env2, 2);
    expect((await api(`/intake/${r.data.id}`)).data.pending.error).toBeUndefined();
    await consume({ messages: [mk(3)] } as never, env2, 2);
    expect(acks).toEqual(['retry1', 'ack3']);
    expect((await api(`/intake/${r.data.id}`)).data.pending.error).toBe("couldn't read that meal, try again");
  });
});
