import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import { mcpApiHandler } from '../src/worker/mcp';
import { api } from './helpers';

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
  const json = text.trim().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5);
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
    expect(names).toEqual(expect.arrayContaining(['get_day', 'log_meal', 'log_food', 'search_foods', 'edit_item', 'get_targets', 'set_targets', 'log_weight', 'get_coach_report', 'create_food']));

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

  it("keeps each user's data separate", async () => {
    const a = await userId('mcp-a@example.test');
    const b = await userId('mcp-b@example.test');
    const food = await call(a, 'create_food', { name: 'Secret sauce', serving_grams: 10, per_serving: { ENERC_KCAL: 50 } });
    expect((await call(b, 'list_my_foods')).data).toEqual([]);
    const meal = await call(a, 'log_food', { food_id: food.data.id, amount: 1, unit: 'serving' });
    expect(await call(b, 'get_meal', { meal_id: meal.data.id })).toMatchObject({ isError: true });
    expect(await call(b, 'delete_meal', { meal_id: meal.data.id })).toMatchObject({ isError: true });
  });

  it('rejects an unknown user', async () => {
    const res = await mcpApiHandler.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }), E, { ...ctx(), props: { userId: 'nobody' } } as unknown as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
