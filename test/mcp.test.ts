import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import { mcpApiHandler } from '../src/worker/mcp';
import { afterEach, vi } from 'vitest';
import { api, json, mockFetch } from './helpers';

const E = env as unknown as Env;
const ORIGIN = 'https://clem.example.test';
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

async function userId(email: string) {
  await api('/me', {}, { DEV_USER_EMAIL: email });
  return (await E.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id;
}

/** One JSON-RPC call to the MCP handler as `uid` (what OAuthProvider does after checking the token). */
async function rpc(uid: string, method: string, params: unknown = {}, envOver: Partial<Env> = {}) {
  const c = { ...ctx(), props: { userId: uid } } as unknown as ExecutionContext;
  const res = await mcpApiHandler.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    { ...E, HISTORY: undefined, FATSECRET_CONSUMER_KEY: undefined, FATSECRET_CONSUMER_SECRET: undefined, ...envOver } as Env,
    c,
  );
  const text = await res.text();
  // Either plain JSON or one SSE "data:" event.
  const json = text.trim().startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data:'))!
        .slice(5);
  return JSON.parse(json);
}
const call = async (uid: string, name: string, args: unknown = {}, envOver: Partial<Env> = {}) => {
  const r = await rpc(uid, 'tools/call', { name, arguments: args }, envOver);
  const text = r.result.content[0].text as string;
  return { isError: !!r.result.isError, text, data: r.result.isError ? null : JSON.parse(text) };
};

describe('MCP server', () => {
  it('refuses /mcp without a token and points clients at the OAuth metadata', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }), E, ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await (await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), E, ctx())).json<any>();
    expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const asm = await (await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), E, ctx())).json<any>();
    expect(asm).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register` });
    // The app itself is untouched.
    expect((await worker.fetch(new Request(`${ORIGIN}/api/me`), E, ctx())).status).not.toBe(404);
  });

  it('asks a signed-out browser to sign in before showing consent', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/authorize?response_type=code&client_id=x`), { ...E, ACCESS_TEAM_DOMAIN: 'team', ACCESS_AUD: 'aud' } as Env, ctx());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign in to Clem first');
  });

  it('lists tools and works as the granted user', async () => {
    const uid = await userId('mcp-user@example.test');
    const tools = await rpc(uid, 'tools/list');
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_day', 'log_meal', 'log_food', 'search_foods', 'edit_item', 'get_targets', 'set_targets', 'log_weight', 'get_coach_report', 'create_food']),
    );

    const targets = await call(uid, 'set_targets', { energy: 2100, protein: 140 });
    expect(targets.data.targets).toMatchObject({ ENERC_KCAL: 2100, PROCNT: 140 });

    const food = await call(uid, 'create_food', { name: 'Overnight oats', serving_grams: 250, per_serving: { ENERC_KCAL: 400, PROCNT: 20 } });
    const logged = await call(uid, 'log_food', { food_id: food.data.id, amount: 1, unit: 'serving', meal_type: 'breakfast' });
    expect(logged.data.items[0]).toMatchObject({ grams: 250 });
    expect(logged.data.items[0].nutrients.ENERC_KCAL).toBe(400);

    const day = await call(uid, 'get_day', { date: logged.data.log_date });
    expect(day.data.totals.ENERC_KCAL).toBe(400);

    const weight = await call(uid, 'log_weight', { value: 180, unit: 'lb' });
    expect(weight.data.value).toBeCloseTo(81.65, 1);

    // Errors come back as tool errors, not crashes.
    const bad = await call(uid, 'log_food', { amount: 1, unit: 'g' });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/food_id, fdc_id or fatsecret_id/);
  });

  it('logs a described meal with the AI and waits for it', { timeout: 60_000 }, async () => {
    const uid = await userId('mcp-ai@example.test');
    const food = await api('/foods', { method: 'POST', json: { name: 'banana', serving_grams: 118, per_serving: { ENERC_KCAL: 105 } } }, { DEV_USER_EMAIL: 'mcp-ai@example.test' });
    expect(food.status).toBe(201);
    const out = { items: [{ name: 'banana', amount: 1, unit: 'serving', grams: 118, confidence: 0.9, search_terms: ['banana'], estimate_per_100g: { kcal: 89 } }], questions: [] };
    const AI = { run: async () => ({ response: out }) } as unknown as Ai;
    // No queue in the test: the job runs in this request's waitUntil, with the fake model.
    const r = await call(uid, 'log_meal', { description: 'a banana', meal_type: 'snack' }, { AI, JOBS: undefined });
    expect(r.data).toMatchObject({ status: 'completed', meal_type: 'snack' });
    expect(r.data.items[0]).toMatchObject({ food_id: food.data.id });
  });

  it('serves the Clem card as an MCP App and gives it each result as structured content', async () => {
    const uid = await userId('mcp-card@example.test');
    const tools = (await rpc(uid, 'tools/list')).result.tools;
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
    for (const n of ['get_day', 'get_range', 'get_meal', 'log_meal', 'log_food', 'answer_meal_questions', 'get_coach_report', 'run_coach'])
      expect(byName[n]._meta.ui.resourceUri).toBe('ui://clem/card.html');
    expect(byName.search_foods._meta?.ui).toBeUndefined();

    const res = await rpc(uid, 'resources/read', { uri: 'ui://clem/card.html' });
    expect(res.result.contents[0]).toMatchObject({ uri: 'ui://clem/card.html', mimeType: 'text/html;profile=mcp-app' });
    expect(res.result.contents[0].text).toMatch(/^<!doctype html>/);
    expect(res.result.contents[0].text).not.toMatch(/<script[^>]+src=/); // self-contained

    const day = await rpc(uid, 'tools/call', { name: 'get_day', arguments: { date: 'today' } });
    expect(day.result.structuredContent).toMatchObject({ card: 'day', app_url: ORIGIN, meals: [] });
    const range = await rpc(uid, 'tools/call', { name: 'get_range', arguments: {} });
    expect(range.result.structuredContent).toMatchObject({ card: 'range' });
    // Errors carry no card data.
    const bad = await rpc(uid, 'tools/call', { name: 'get_meal', arguments: { meal_id: 'nope' } });
    expect(bad.result).toMatchObject({ isError: true });
    expect(bad.result.structuredContent).toBeUndefined();
  });

  it('search_foods returns compact rows, favorites and history first, capped', async () => {
    const uid = await userId('mcp-search@example.test');
    // USDA answers with 40 full records: every nutrient, lots of portions.
    const big = (i: number) => ({
      fdcId: 1000 + i,
      description: `Milk, reduced fat, 2% milkfat, variant ${i}`,
      dataType: 'Survey (FNDDS)',
      foodNutrients: Array.from({ length: 60 }, (_, k) => ({ nutrientId: k === 0 ? 1008 : 1003 + k, unitName: k === 0 ? 'KCAL' : 'G', value: k === 0 ? 50 : 1 })),
      foodMeasures: Array.from({ length: 12 }, (_, k) => ({ disseminationText: `${k + 1} cup`, gramWeight: 244 * (k + 1), rank: k })),
    });
    const spy = mockFetch((url) => (url.hostname === 'api.nal.usda.gov' ? json({ foods: Array.from({ length: 40 }, (_, i) => big(i)) }) : undefined));
    try {
      const mine = await call(uid, 'create_food', { name: 'Milk 2% (my carton)', serving_grams: 240, serving_label: '1 cup', per_serving: { ENERC_KCAL: 122, PROCNT: 8 } });
      await call(uid, 'save_favorite', { name: 'milk 2% splash', food_id: mine.data.id, amount: 0.25, unit: 'serving' });
      const r = await rpc(uid, 'tools/call', { name: 'search_foods', arguments: { query: 'milk 2%' } }, { USDA_API_KEY: 'k' });
      const text = r.result.content[0].text as string;
      expect(text.length).toBeLessThan(6000);
      const out = JSON.parse(text);
      expect(out.results).toHaveLength(10);
      expect(out.results[0]).toMatchObject({ kind: 'favorite', name: 'milk 2% splash', amount: 0.25, unit: 'serving' });
      expect(out.results[1]).toMatchObject({ kind: 'your food', food_id: mine.data.id, kcal_100g: 50.8, serving: '1 cup = 240 g' });
      expect(out.results[2]).toMatchObject({ kind: 'database', fdc_id: '1000', kcal_100g: 50 });
      expect(out.results.every((row: any) => !('nutrients' in row) && !('portions' in row))).toBe(true);
      const few = JSON.parse((await rpc(uid, 'tools/call', { name: 'search_foods', arguments: { query: 'milk', limit: 3 } }, { USDA_API_KEY: 'k' })).result.content[0].text);
      expect(few.results).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('saves favorite portions and logs them at the saved amount', async () => {
    const uid = await userId('mcp-fav@example.test');
    const almonds = await call(uid, 'create_food', { name: 'Almonds', serving_grams: 28.35, serving_label: '1 oz', per_serving: { ENERC_KCAL: 164, PROCNT: 6 } });
    const fav = await call(uid, 'save_favorite', { name: 'Usual nuts', food_id: almonds.data.id, amount: 28.35, unit: 'g' });
    expect(fav.data).toMatchObject({ name: 'Usual nuts', grams: 28.4, kcal: 164 });
    expect((await call(uid, 'list_favorites')).data.map((f: any) => f.name)).toEqual(['Usual nuts']);

    const one = await call(uid, 'log_favorite', { name: 'usual nuts' });
    expect(one.data.items[0]).toMatchObject({ display_name: 'Usual nuts' });
    expect(one.data.items[0].grams).toBeCloseTo(28.35, 0);
    const two = await call(uid, 'log_favorite', { name: 'Usual nuts', times: 2 });
    expect(two.data.items.at(-1).nutrients.ENERC_KCAL).toBe(328);
    expect(await call(uid, 'log_favorite', { name: 'usual chips' })).toMatchObject({ isError: true });

    // Named in a description, a favorite logs at its saved portion: the model's guess is ignored.
    const say = (items: unknown[]) => ({ run: async () => ({ response: { items, questions: [] } }) }) as unknown as Ai;
    const r = await call(
      uid,
      'log_meal',
      { description: '2 usual nuts' },
      { JOBS: undefined, AI: say([{ name: 'usual nuts', amount: 2, unit: 'favorite', grams: 90, confidence: 0.6, search_terms: ['nuts'] }]) },
    );
    expect(r.data.items[0]).toMatchObject({ food_id: almonds.data.id, grams: 56.7 });
    expect(r.data.items[0].nutrients.ENERC_KCAL).toBe(328);
    // An explicit weight keeps its weight, with the favorite's food.
    const g = await call(
      uid,
      'log_meal',
      { description: '40 g of usual nuts' },
      { JOBS: undefined, AI: say([{ name: 'Usual nuts', amount: 40, unit: 'g', confidence: 0.9, search_terms: ['nuts'] }]) },
    );
    expect(g.data.items[0]).toMatchObject({ food_id: almonds.data.id, grams: 40 });

    expect((await call(uid, 'remove_favorite', { favorite_id: fav.data.id })).isError).toBe(false);
    expect((await call(uid, 'list_favorites')).data).toEqual([]);
  });

  it("keeps each user's data separate", async () => {
    const a = await userId('mcp-a@example.test');
    const b = await userId('mcp-b@example.test');
    const food = await call(a, 'create_food', { name: 'Secret sauce', serving_grams: 10, per_serving: { ENERC_KCAL: 50 } });
    expect((await call(b, 'list_my_foods')).data).toEqual([]);
    const meal = await call(a, 'log_food', { food_id: food.data.id, amount: 1, unit: 'serving' });
    expect(await call(b, 'get_meal', { meal_id: meal.data.id })).toMatchObject({ isError: true });
    expect(await call(b, 'delete_meal', { meal_id: meal.data.id })).toMatchObject({ isError: true });
  });

  it('answers every request with a response that ends (2026-07-28 clients like Claude, and 2025 ones)', async () => {
    const uid = await userId('mcp-transport@example.test');
    const c = { ...ctx(), props: { userId: uid } } as unknown as ExecutionContext;
    const META = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    };
    const send = (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) =>
      mcpApiHandler.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: META } }),
        }),
        E,
        c,
      );
    /** The whole body, or a failure if it is still open after a second (it used to stay open for minutes). */
    const whole = async (res: Response) => {
      const reader = res.body!.getReader();
      let text = '';
      for (;;) {
        const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 1000))]);
        if (!r) {
          await reader.cancel();
          throw new Error(`response still open after 1 s: ${text}`);
        }
        if (r.done) return text;
        text += new TextDecoder().decode(r.value);
      }
    };

    const discover = await send('server/discover', {});
    // Nothing is ever pushed: the lists are fixed and each request gets a fresh server.
    expect((await discover.json<any>()).result.capabilities).toMatchObject({ tools: { listChanged: false }, resources: { listChanged: false } });

    const tool = await send('tools/call', { name: 'get_day', arguments: {} }, { 'Mcp-Name': 'get_day' });
    expect(tool.status).toBe(200);
    expect(tool.headers.get('content-type')).toMatch(/^application\/json/);
    expect(JSON.parse(await whole(tool)).result.structuredContent).toMatchObject({ card: 'day' });

    // Claude opens subscriptions/listen after connecting; it is acknowledged with nothing to send and closed.
    const listen = await send('subscriptions/listen', { notifications: { toolsListChanged: true, resourcesListChanged: true } });
    expect(listen.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events = (await whole(listen))
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)));
    expect(events[0]).toMatchObject({ method: 'notifications/subscriptions/acknowledged', params: { notifications: {} } });
    expect(events.at(-1)).toMatchObject({ id: 7, result: { resultType: 'complete' } });

    // 2025-era clients: a POST's SSE stream ends with its response; there is no GET stream.
    const old = await mcpApiHandler.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_day', arguments: {} } }),
      }),
      E,
      c,
    );
    expect(await whole(old)).toMatch(/"card":"day"/);
    const get = await mcpApiHandler.fetch(new Request(`${ORIGIN}/mcp`, { headers: { Accept: 'text/event-stream' } }), E, c);
    expect(get.status).toBe(405);
  });

  it('rejects an unknown user', async () => {
    const res = await mcpApiHandler.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }), E, {
      ...ctx(),
      props: { userId: 'nobody' },
    } as unknown as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
