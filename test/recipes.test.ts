import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, mockFetch } from './helpers';

// No outbound lookups in these tests: every food is a custom food with known values.
beforeEach(() => {
  mockFetch((url) => (url.hostname === 'api.nal.usda.gov' || url.hostname === 'world.openfoodfacts.org' ? new Response('{}', { status: 503 }) : undefined));
});
afterEach(() => vi.restoreAllMocks());

const food = async (name: string, kcal: number, protein: number) =>
  (await api('/foods', { method: 'POST', json: { name, per_100g: { ENERC_KCAL: kcal, PROCNT: protein } } })).data.id as string;

const kcalOf = (n: { code: string; value: number }[]) => n.find((x) => x.code === 'ENERC_KCAL')?.value;

function fakeAI(response: unknown) {
  const calls: { model: string; inputs: any }[] = [];
  return {
    calls,
    AI: { run: async (model: string, inputs: any) => (calls.push({ model, inputs }), { response }) } as unknown as Ai,
  };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('recipes', () => {
  it('builds per-serving and per-100 g values from the ingredients, using the weighed batch', async () => {
    const beef = await food('Recipe test beef', 250, 26); // 1000 g -> 2500 kcal, 260 g protein
    const beans = await food('Recipe test beans', 100, 7); // 500 g -> 500 kcal, 35 g protein
    const r = await api('/recipes', {
      method: 'POST',
      json: {
        name: 'Big pot of chili',
        servings: 6,
        yield_grams: 1200, // water cooked off: 1500 g raw became 1200 g
        ingredients: [
          { food_id: beef, amount: 1, unit: 'kg' },
          { food_id: beans, amount: 500, unit: 'g' },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ name: 'Big pot of chili', servings: 6, batch_grams: 1200, serving_grams: 200 });
    expect(r.data.totals.ENERC_KCAL).toBe(3000);
    expect(r.data.per_serving).toMatchObject({ ENERC_KCAL: 500, PROCNT: 49.2 });
    expect(r.data.per_100g.ENERC_KCAL).toBe(250);
    expect(r.data.ingredients.map((i: any) => [i.display_name, i.grams, i.kcal])).toEqual([
      ['Recipe test beef', 1000, 2500],
      ['Recipe test beans', 500, 500],
    ]);

    // The recipe is a food: log a serving, a quarter of the batch, and a weighed bowl.
    const meal = await api('/intake', {
      method: 'POST',
      json: {
        occurrence_at: '2026-11-10T19:00:00Z',
        items: [
          { food_id: r.data.id, amount: 1, unit: 'serving' },
          { food_id: r.data.id, amount: 0.25, unit: 'batch' },
          { food_id: r.data.id, amount: 150, unit: 'g' },
        ],
      },
    });
    expect(meal.status).toBe(201);
    expect(meal.data.items.map((i: any) => [i.grams, i.nutrients.ENERC_KCAL])).toEqual([
      [200, 500],
      [300, 750],
      [150, 375],
    ]);

    const list = await api('/recipes');
    expect(list.data.find((x: any) => x.id === r.data.id)).toMatchObject({ times_logged: 3, last_logged_at: '2026-11-10T19:00:00.000Z' });
  });

  it('falls back to the raw ingredient weight when the batch was not weighed', async () => {
    const oats = await food('Recipe test oats', 380, 13);
    const milk = await food('Recipe test milk', 60, 3.3);
    const r = await api('/recipes', {
      method: 'POST',
      json: {
        name: 'Overnight oats',
        servings: 4,
        ingredients: [
          { food_id: oats, amount: 200, unit: 'g' },
          { food_id: milk, amount: 600, unit: 'g' },
        ],
      },
    });
    expect(r.data).toMatchObject({ yield_grams: null, batch_grams: 800, serving_grams: 200 });
    expect(r.data.per_serving.ENERC_KCAL).toBe(280);
  });

  it('turns a logged batch into a recipe and removes it from the day', async () => {
    const rice = await food('Recipe test rice', 130, 2.7);
    const chicken = await food('Recipe test chicken', 165, 31);
    const batch = await api('/intake', {
      method: 'POST',
      json: {
        occurrence_at: '2026-11-11T18:00:00Z',
        items: [
          { food_id: rice, amount: 900, unit: 'g', display_name: 'cooked rice' },
          { food_id: chicken, amount: 600, unit: 'g', display_name: 'chicken thighs' },
        ],
      },
    });
    const r = await api('/recipes', { method: 'POST', json: { name: 'Meal prep bowls', servings: 5, from_intake: batch.data.id } });
    expect(r.status).toBe(201);
    expect(r.data.ingredients.map((i: any) => i.display_name)).toEqual(['cooked rice', 'chicken thighs']);
    expect(r.data.per_serving.ENERC_KCAL).toBe(Math.round(((1170 + 990) / 5) * 10) / 10);
    expect((await api(`/intake/${batch.data.id}`)).data.status).toBe('entered-in-error');
    const day = await api('/day/2026-11-11');
    expect(day.data.meals.find((m: any) => m.id === batch.data.id)).toBeUndefined();
  });

  it('edits change new logs only; deleting hides the recipe but keeps past logs', async () => {
    const pasta = await food('Recipe test pasta', 160, 6);
    const r = await api('/recipes', { method: 'POST', json: { name: 'Baked ziti', servings: 4, ingredients: [{ food_id: pasta, amount: 1000, unit: 'g' }] } });
    const logged = await api('/intake', { method: 'POST', json: { occurrence_at: '2026-11-12T19:00:00Z', items: [{ food_id: r.data.id, amount: 1, unit: 'serving' }] } });
    expect(logged.data.items[0].nutrients.ENERC_KCAL).toBe(400);

    const edited = await api(`/recipes/${r.data.id}`, { method: 'PUT', json: { name: 'Baked ziti', servings: 8, ingredients: [{ food_id: pasta, amount: 1000, unit: 'g' }] } });
    expect(edited.status).toBe(200);
    expect(edited.data.per_serving.ENERC_KCAL).toBe(200);
    expect((await api(`/foods/${r.data.id}`)).data.portions[0]).toMatchObject({ unit: 'serving', grams: 125 });
    expect((await api(`/intake/${logged.data.id}`)).data.items[0].nutrients.ENERC_KCAL).toBe(400);

    expect((await api(`/recipes/${r.data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/recipes/${r.data.id}`)).status).toBe(404);
    expect((await api('/recipes')).data.find((x: any) => x.id === r.data.id)).toBeUndefined();
    expect((await api('/foods?q=baked ziti&remote=0')).data.local.find((f: any) => f.id === r.data.id)).toBeUndefined();
    expect((await api(`/intake/${logged.data.id}`)).data.items[0]).toMatchObject({ food_id: r.data.id, nutrients: { ENERC_KCAL: 400 } });
    // The name is free again.
    expect((await api('/recipes', { method: 'POST', json: { name: 'Baked ziti', servings: 4, ingredients: [{ food_id: pasta, amount: 500, unit: 'g' }] } })).status).toBe(201);
  });

  it('validates input and rejects duplicate names', async () => {
    const egg = await food('Recipe test egg', 143, 12.6);
    const ok = { name: 'Egg bites', servings: 6, ingredients: [{ food_id: egg, amount: 600, unit: 'g' }] };
    expect((await api('/recipes', { method: 'POST', json: ok })).status).toBe(201);
    expect((await api('/recipes', { method: 'POST', json: { ...ok, name: 'egg  BITES' } })).status).toBe(409);
    expect((await api('/recipes', { method: 'POST', json: { ...ok, name: 'Other', servings: 0 } })).status).toBe(400);
    expect((await api('/recipes', { method: 'POST', json: { ...ok, name: 'Other', ingredients: [] } })).status).toBe(400);
    expect((await api('/recipes', { method: 'POST', json: { ...ok, name: 'Other', yield_grams: -5 } })).status).toBe(400);
    expect((await api('/recipes', { method: 'POST', json: { ...ok, name: 'Other', ingredients: [{ food_id: 'nope', amount: 1, unit: 'g' }] } })).status).toBe(404);
  });

  it('tells the AI about saved recipes and logs a described portion as the recipe', async () => {
    const lentils = await food('Recipe test lentils', 116, 9);
    const r = await api('/recipes', { method: 'POST', json: { name: 'Red lentil soup', servings: 5, ingredients: [{ food_id: lentils, amount: 1500, unit: 'g' }] } });
    const ai = fakeAI({
      meal_type_guess: 'lunch',
      items: [{ name: 'Red lentil soup', amount: 1, unit: 'serving', grams: 300, confidence: 0.9, search_terms: ['lentil soup'] }],
      questions: [],
    });
    const m = await api('/intake', { method: 'POST', body: form({ text: 'a bowl of my lentil soup' }) }, { AI: ai.AI });
    expect(ai.calls[0]!.inputs.messages[0].content).toContain('"Red lentil soup"');
    expect(m.data.status).toBe('completed');
    expect(m.data.items[0]).toMatchObject({ food_id: r.data.id, food_source: 'recipe', grams: 300, nutrients: { ENERC_KCAL: 348 } });
  });
});

describe('recipes from a description', () => {
  it('reads a described batch as ingredients and saves it as a recipe instead of a meal', async () => {
    await food('Recipe test ground turkey', 150, 20);
    await food('Recipe test black beans', 130, 9);
    const ai = fakeAI({
      meal_type_guess: null,
      items: [
        { name: 'Recipe test ground turkey', amount: 2, unit: 'lb', grams: 907, confidence: 0.9, search_terms: ['ground turkey'] },
        { name: 'Recipe test black beans', amount: 800, unit: 'g', confidence: 0.9, search_terms: ['black beans'] },
      ],
      // Ignored for a batch: nobody wants a quiz about a pot of chili.
      questions: [{ id: 'q1', item_index: 0, text: 'Oil?', options: ['None', 'Some'], default: 'None', effects: { None: {}, Some: {} } }],
    });
    const m = await api(
      '/intake',
      {
        method: 'POST',
        body: form({ text: '2 lb ground turkey, 800 g black beans', recipe: JSON.stringify({ name: 'Turkey chili', servings: 8 }), merge: '1', meal_type: 'dinner' }),
      },
      { AI: ai.AI },
    );
    expect(m.status).toBe(202);
    expect(ai.calls[0]!.inputs.messages[0].content).toContain('NOT a meal');
    expect(m.data.status).toBe('entered-in-error');
    expect(m.data.pending.recipe_saved.name).toBe('Turkey chili');

    const r = await api(`/recipes/${m.data.pending.recipe_saved.id}`);
    expect(r.data.ingredients.map((i: any) => [i.display_name, i.amount_value, i.amount_unit, i.grams])).toEqual([
      ['Recipe test ground turkey', 2, '[lb_av]', 907.2],
      ['Recipe test black beans', 800, 'g', 800],
    ]);
    expect(r.data.per_serving.ENERC_KCAL).toBe(Math.round(((1360.8 + 1040) / 8) * 10) / 10);
    // Nothing was logged for the day.
    const day = await api(`/day/${m.data.log_date}`);
    expect(day.data.meals.find((x: any) => x.id === m.data.id)).toBeUndefined();
  });

  it('rejects a taken recipe name before running the AI', async () => {
    const tofu = await food('Recipe test tofu', 76, 8);
    await api('/recipes', { method: 'POST', json: { name: 'Tofu scramble', servings: 2, ingredients: [{ food_id: tofu, amount: 400, unit: 'g' }] } });
    const ai = fakeAI({ items: [], questions: [] });
    const m = await api('/intake', { method: 'POST', body: form({ text: 'tofu', recipe: JSON.stringify({ name: 'tofu scramble', servings: 2 }) }) }, { AI: ai.AI });
    expect(m.status).toBe(409);
    expect(ai.calls).toHaveLength(0);
  });
});
