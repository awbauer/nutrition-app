import { Hono, type Context } from 'hono';
import { requireUser } from './auth';
import type { AppEnv } from './env';
import { diffMeal, recordEvents, snapshotMeal, type MealEvent } from './lib/events';
import { refreshHistory } from './lib/history';
import { HttpError } from './lib/ids';
import { authorize } from './routes/authorize';
import { coach } from './routes/coach';
import { day } from './routes/day';
import { exporter } from './routes/export';
import { foods } from './routes/foods';
import { graph } from './routes/graph';
import { intake } from './routes/intake';
import { items } from './routes/items';
import { progress } from './routes/progress';
import { push } from './routes/push';
import { recipes } from './routes/recipes';
import { settings } from './routes/settings';

export const app = new Hono<AppEnv>();

/** The request body isn't JSON (a SyntaxError from a server-side JSON.parse is our fault, not the client's). */
async function badJsonBody(c: Context): Promise<boolean> {
  // c.req.json() reads the body as text (cached) and parses it; a route that never read its body can't have a bad one.
  const read = c.req.bodyCache.text;
  if (!read) return false;
  try {
    JSON.parse(await read);
    return false;
  } catch {
    return true;
  }
}

app.onError(async (err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof SyntaxError && (await badJsonBody(c))) return c.json({ error: 'invalid JSON body' }, 400);
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

const api = new Hono<AppEnv>();
api.use('*', requireUser);
// Logging, editing or deleting food changes what "foods you've eaten" search can find.
const CHANGES_HISTORY = /^\/api\/(intake|item|recipes|foods)(\/|$)/;
api.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.res.status >= 400 || !CHANGES_HISTORY.test(c.req.path)) return;
  const run = refreshHistory(c.env, c.get('user').id).catch((e) => console.warn('history refresh failed', (e as Error).message));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    await run; // no execution context (tests): finish before responding
  }
});
// The meal change log: snapshot the meal before a change and diff it after (lib/events.ts). AI parses,
// answers and searches are recorded where they happen; /answers and /retry are left to them.
const CHANGES_MEAL = /^\/api\/(intake|item)(\/|$)/;
const SELF_RECORDED = /\/(answers|retry)$/;
api.use('*', async (c, next) => {
  if (c.req.method === 'GET' || !CHANGES_MEAL.test(c.req.path) || SELF_RECORDED.test(c.req.path)) return next();
  const db = c.env.DB;
  const user = c.get('user');
  const actor = c.env.MCP_USER ? 'mcp' : 'app';
  const started = new Date().toISOString();
  let target: string | null = null;
  let before = null;
  let marks = { ci: 0, ni: 0 };
  try {
    const m = /^\/api\/(intake|item)\/([^/]+)/.exec(c.req.path);
    if (m?.[1] === 'intake') target = m[2]!;
    else if (m?.[1] === 'item')
      target = (await db.prepare('SELECT intake_id FROM consumed_item WHERE id = ? AND user_id = ?').bind(m[2], user.id).first<{ intake_id: string }>())?.intake_id ?? null;
    before = target ? await snapshotMeal(db, user.id, target) : null;
    marks =
      (await db
        .prepare('SELECT (SELECT COALESCE(MAX(rowid), 0) FROM consumed_item) AS ci, (SELECT COALESCE(MAX(rowid), 0) FROM nutrition_intake) AS ni')
        .first<{ ci: number; ni: number }>()) ?? marks;
  } catch (e) {
    console.warn('meal log: before snapshot failed', (e as Error).message);
  }
  await next();
  if (c.res.status >= 400) return;
  const record = (async () => {
    let afterId = target;
    try {
      const body = (await c.res.clone().json()) as { id?: string } | null;
      if (body?.id) afterId = body.id;
    } catch {}
    if (!afterId) return;
    const after = await snapshotMeal(db, user.id, afterId);
    const detail = { route: `${c.req.method} ${c.req.routePath}` };
    let events: MealEvent[];
    if (before && afterId === target) events = diffMeal(before, after, actor, detail);
    else if (after) {
      // A new meal, or items added to another one (merge): what's newer than before the request.
      const row = await db
        .prepare('SELECT rowid AS rid, source, raw_input_text FROM nutrition_intake WHERE id = ?')
        .bind(afterId)
        .first<{ rid: number; source: string; raw_input_text: string | null }>();
      const { results: fresh } = await db.prepare('SELECT id FROM consumed_item WHERE intake_id = ? AND rowid > ?').bind(afterId, marks.ci).all<{ id: string }>();
      const freshIds = new Set(fresh.map((f) => f.id));
      // A photo, voice or text meal goes to the AI (multipart); its items are logged as ai_logged there.
      const toAi = (c.req.header('Content-Type') ?? '').includes('multipart/form-data');
      if (toAi) events = [{ intake_id: afterId, actor, kind: 'meal_submitted', at: started, detail: { ...detail, source: row?.source, text: row?.raw_input_text } }];
      else
        events = [
          ...((row?.rid ?? 0) > marks.ni ? [{ intake_id: afterId, actor, kind: 'meal_created', after: { ...after, items: undefined }, detail } as MealEvent] : []),
          ...after.items.filter((i) => freshIds.has(i.id)).map((i) => ({ intake_id: afterId!, item_id: i.id, actor, kind: 'item_added', after: i, detail }) as MealEvent),
        ];
    } else events = [];
    await recordEvents(db, user.id, events);
  })().catch((e) => console.warn('meal log failed', (e as Error).message));
  try {
    c.executionCtx.waitUntil(record);
  } catch {
    await record; // no execution context (tests)
  }
});
api.route('/', settings);
api.route('/', day);
api.route('/', progress);
api.route('/', push);
api.route('/', exporter);
api.route('/foods', foods);
api.route('/graph', graph);
api.route('/coach', coach);
api.route('/intake', intake);
api.route('/item', items);
api.route('/recipes', recipes);
api.notFound((c) => c.json({ error: 'not found' }, 404));

app.route('/api', api);
// OAuth consent for MCP clients (Claude etc.); the rest of OAuth is served by OAuthProvider in index.ts.
app.route('/', authorize);
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
