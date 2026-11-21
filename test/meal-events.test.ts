import { afterEach, describe, expect, it, vi } from 'vitest';
import { loggingQuality } from '../src/worker/lib/events';
import { MATCHER_VERSION } from '../src/worker/lib/match-config';
import { api, testEnv } from './helpers';

afterEach(() => vi.restoreAllMocks());

async function food(name: string, kcal: number) {
  const r = await api('/foods', { method: 'POST', json: { name, serving_grams: 100, per_serving: { ENERC_KCAL: kcal, PROCNT: 10 } } });
  expect(r.status).toBe(201);
  return r.data.id as string;
}

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

const kinds = (h: any) => h.data.events.map((e: any) => `${e.actor}:${e.kind}`);

describe('meal change log', () => {
  it('records each change to a meal as a versioned event', async () => {
    const egg = await food('Egg whole cooked', 150);
    const deviled = await food('Egg deviled', 200);
    const toast = await food('Toast white', 280);
    const r = await api('/intake', { method: 'POST', json: { meal_type: 'breakfast', items: [{ food_id: deviled, amount: 100, unit: 'g', display_name: 'egg' }] } });
    expect(r.status).toBe(201);
    const id = r.data.id;
    const item = r.data.items[0].id;

    expect((await api(`/item/${item}`, { method: 'PATCH', json: { food_id: egg } })).status).toBe(200);
    expect((await api(`/item/${item}`, { method: 'PATCH', json: { amount: 120, unit: 'g' } })).status).toBe(200);
    const added = await api(`/intake/${id}/items`, { method: 'POST', json: { food_id: toast, amount: 30, unit: 'g' } });
    expect(added.status).toBe(201);
    const toastId = added.data.items.find((i: any) => i.food_id === toast).id;
    expect((await api(`/item/${toastId}`, { method: 'DELETE' })).status).toBe(200);
    // Claude (through MCP) changes the meal type.
    const me = await testEnv.DB.prepare('SELECT u.* FROM users u JOIN nutrition_intake i ON i.user_id = u.id WHERE i.id = ?').bind(id).first();
    expect((await api(`/intake/${id}`, { method: 'PATCH', json: { meal_type: 'lunch' } }, { MCP_USER: me } as any)).status).toBeLessThan(400);

    const h = await api(`/intake/${id}/history`);
    expect(h.status).toBe(200);
    expect(kinds(h)).toEqual([
      'app:meal_created',
      'app:item_added',
      'app:food_swapped',
      'app:renamed',
      'app:amount_changed',
      'app:item_added',
      'app:item_removed',
      'mcp:meal_changed',
    ]);
    const swap = h.data.events[2];
    expect(swap.before.food_name).toBe('Egg deviled');
    expect(swap.after.food_name).toBe('Egg whole cooked');
    expect(swap.summary).toBe('You swapped "egg" from Egg deviled to Egg whole cooked: 200 → 150 kcal');
    expect(h.data.events[4].before.grams).toBe(100);
    expect(h.data.events[4].after.grams).toBe(120);
  });

  it('records deleting a meal', async () => {
    const f = await food('Apple test', 52);
    const r = await api('/intake', { method: 'POST', json: { items: [{ food_id: f, amount: 100, unit: 'g' }] } });
    expect((await api(`/intake/${r.data.id}`, { method: 'DELETE' })).status).toBeLessThan(400);
    const { results } = await testEnv.DB.prepare('SELECT kind FROM meal_event WHERE intake_id = ? ORDER BY rowid').bind(r.data.id).all<{ kind: string }>();
    expect(results.map((x) => x.kind)).toContain('meal_deleted');
  });

  it('logs what the AI matched, answers, searches, and scores how often it needed fixing', async () => {
    const bagel = await food('Bagel plain', 250);
    const bits = await food('Bacon bits meatless', 476);
    const bacon = await food('Bacon cooked slices', 541);
    const output = {
      meal_type_guess: 'breakfast',
      items: [
        { name: 'bagel plain', amount: 1, unit: 'g', confidence: 0.8, search_terms: ['bagel plain'], barcode: null },
        { name: 'bacon bits meatless', amount: 20, unit: 'g', confidence: 0.6, search_terms: ['bacon bits meatless'], barcode: null },
      ],
      questions: [],
    };
    const AI = { run: async () => ({ response: JSON.stringify(output) }) } as unknown as Ai;
    const r = await api('/intake', { method: 'POST', body: form({ text: 'bagel and bacon' }) }, { AI, USDA_API_KEY: undefined } as any);
    expect(r.status).toBeLessThan(300);
    const id = r.data.id;
    const items = r.data.items as any[];
    expect(items.map((i) => i.food_id)).toEqual([bagel, bits]);
    const baconItem = items[1].id;

    const s = await api(`/item/${baconItem}/search?q=bacon cooked`, {}, { USDA_API_KEY: undefined } as any);
    expect(s.status).toBe(200);
    await api(`/item/${baconItem}`, { method: 'PATCH', json: { food_id: bacon } });

    const h = await api(`/intake/${id}/history`);
    const k = kinds(h);
    expect(k.slice(0, 3)).toEqual(['app:meal_submitted', 'ai:ai_logged', 'ai:ai_logged']);
    expect(k).toContain('app:searched');
    expect(k.at(-1)).toBe('app:food_swapped');
    const logged = h.data.events[2];
    expect(logged.detail).toMatchObject({ prompt_version: 'parse-v8' });
    expect(logged.summary).toMatch(/^AI logged "bacon bits meatless" as Bacon bits meatless/);
    expect(h.data.events.find((e: any) => e.kind === 'searched').detail.results[0]).toBe('Bacon cooked slices');

    const q = await api('/coach/quality?days=7');
    expect(q.status).toBe(200);
    expect(q.data).toMatchObject({ ai_items: 2, pct_swapped: 50, pct_any_fix: 50, searches: 1 });
    expect(q.data.top_swaps[0]).toMatchObject({ name: 'bacon bits meatless', from: 'Bacon bits meatless', to: 'Bacon cooked slices', times: 1 });
    expect(q.data.by_prompt[0]).toMatchObject({ prompt_version: 'parse-v8', matcher_version: MATCHER_VERSION, items: 2, pct_fixed: 50 });
  });

  it('records answers to the AI’s questions', async () => {
    await food('Chicken grilled test', 165);
    await food('Olive oil test', 884);
    const output = {
      items: [{ name: 'chicken grilled test', amount: 150, unit: 'g', confidence: 0.7, search_terms: ['chicken grilled test'], barcode: null }],
      questions: [
        {
          id: 'q1',
          item_index: 0,
          text: 'Cooked in oil?',
          options: ['None', '1 tbsp oil'],
          default: 'None',
          effects: { None: {}, '1 tbsp oil': { add_item: { name: 'olive oil test', amount: 15, unit: 'g', search_terms: ['olive oil test'] } } },
        },
      ],
    };
    const AI = { run: async () => ({ response: JSON.stringify(output) }) } as unknown as Ai;
    const r = await api('/intake', { method: 'POST', body: form({ text: 'chicken' }) }, { AI, USDA_API_KEY: undefined } as any);
    expect(r.data.status).toBe('in-progress');
    const done = await api(`/intake/${r.data.id}/answers`, { method: 'POST', json: { answers: { q1: '1 tbsp oil' } } }, { USDA_API_KEY: undefined } as any);
    expect(done.data.status).toBe('completed');
    const h = await api(`/intake/${done.data.id}/history`);
    const ans = h.data.events.find((e: any) => e.kind === 'answered');
    expect(ans.detail.answers).toEqual({ 'Cooked in oil?': '1 tbsp oil' });
    expect(ans.summary).toBe('You answered "1 tbsp oil"');
    const after = h.data.events.filter((e: any) => e.kind === 'ai_logged' && e.detail.source === 'after answers');
    expect(after.map((e: any) => e.after.name).sort()).toEqual(['chicken grilled test', 'olive oil test']);
    // Items replaced by answering don't count twice in the quality numbers.
    const user = await testEnv.DB.prepare('SELECT user_id FROM nutrition_intake WHERE id = ?').bind(done.data.id).first<{ user_id: string }>();
    const q = await loggingQuality(testEnv.DB, user!.user_id, 1);
    expect(q.ai_items).toBeGreaterThanOrEqual(2);
  });

  it('404s history for an unknown meal', async () => {
    expect((await api('/intake/nope/history')).status).toBe(404);
  });
});
