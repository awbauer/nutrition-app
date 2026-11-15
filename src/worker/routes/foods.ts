import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { createCustomFood, getFood, resolveFdc, searchLocal, usdaClient, type CustomFoodInput } from '../lib/foods';
import { HttpError } from '../lib/ids';

export const foods = new Hono<AppEnv>();

/** GET /api/foods?q=  -> local (custom + cache) matches and USDA search results. */
foods.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ local: [], usda: [] });
  const user = c.get('user');
  const local = await searchLocal(c.env.DB, user.id, q);
  let usda: unknown[] = [];
  let usdaError: string | undefined;
  if (c.req.query('remote') !== '0' && c.env.USDA_API_KEY) {
    try {
      const hits = await usdaClient(c.env).searchAll(q);
      const cachedIds = new Set(local.filter((f) => f.source === 'usda').map((f) => f.source_id));
      usda = hits.filter((h) => !cachedIds.has(h.sourceId));
    } catch (e) {
      usdaError = (e as Error).message;
    }
  }
  return c.json({ local, usda, ...(usdaError ? { usda_error: usdaError } : {}) });
});

/** GET /api/foods/fdc/:fdcId -> resolve (and cache) a USDA food with portions. */
foods.get('/fdc/:fdcId', async (c) => {
  const fdcId = c.req.param('fdcId');
  if (!/^\d+$/.test(fdcId)) throw new HttpError(400, 'bad fdc id');
  return c.json(await resolveFdc(c.env, fdcId));
});

foods.get('/:id', async (c) => {
  const f = await getFood(c.env.DB, c.get('user').id, c.req.param('id'));
  if (!f) throw new HttpError(404, 'food not found');
  return c.json(f);
});

/** POST /api/foods -> create a custom food or recipe owned by the user. */
foods.post('/', async (c) => {
  const body = await c.req.json<CustomFoodInput>();
  return c.json(await createCustomFood(c.env.DB, c.get('user').id, body), 201);
});
