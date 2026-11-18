import { Hono } from 'hono';
import { requireUser } from './auth';
import type { AppEnv } from './env';
import { refreshHistory } from './lib/history';
import { HttpError } from './lib/ids';
import { day } from './routes/day';
import { exporter } from './routes/export';
import { foods } from './routes/foods';
import { intake } from './routes/intake';
import { items } from './routes/items';
import { progress } from './routes/progress';
import { push } from './routes/push';
import { recipes } from './routes/recipes';
import { settings } from './routes/settings';

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400);
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
api.route('/', settings);
api.route('/', day);
api.route('/', progress);
api.route('/', push);
api.route('/', exporter);
api.route('/foods', foods);
api.route('/intake', intake);
api.route('/item', items);
api.route('/recipes', recipes);
api.notFound((c) => c.json({ error: 'not found' }, 404));

app.route('/api', api);
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
