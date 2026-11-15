import { Hono } from 'hono';
import { requireUser } from './auth';
import type { AppEnv } from './env';
import { HttpError } from './lib/ids';
import { day } from './routes/day';
import { foods } from './routes/foods';
import { intake } from './routes/intake';
import { items } from './routes/items';
import { progress } from './routes/progress';
import { push } from './routes/push';
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
api.route('/', settings);
api.route('/', day);
api.route('/', progress);
api.route('/', push);
api.route('/foods', foods);
api.route('/intake', intake);
api.route('/item', items);
api.notFound((c) => c.json({ error: 'not found' }, 404));

app.route('/api', api);
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
