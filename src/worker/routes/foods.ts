import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { archiveCustomFood, backfillCategories, createCustomFood, getFood, listCustomFoods, resolveFatSecret, updateCustomFood, getSnapshot, resolveFdc, searchLocal, usdaClient, type CustomFoodInput } from '../lib/foods';
import { HttpError } from '../lib/ids';
import { MEAL_TYPES, type MealType } from '../lib/intake';
import { goesWith, quickFoods } from '../lib/quick';
import { addFavorite, listFavorites, removeFavorite } from '../lib/favorites';
import { coversQuery, searchHistory } from '../lib/history';
import { fatsecretClient } from '../lib/fatsecret';
import { FALLBACK_MODELS, isCapacityError, MAX_PHOTOS, type PhotoInput } from '../lib/ai';
import { LabelReadError, readLabel } from '../lib/label';
import { getSettings } from '../lib/settings';

const MAX_PHOTO = 8 * 1024 * 1024;

export const foods = new Hono<AppEnv>();

/** bge-m3 cosine: a related food you've eaten scores ~0.6+, unrelated ones ~0.4-0.5. */
const HISTORY_MIN_SIMILARITY = 0.6;

/** GET /api/foods?q=  -> foods you've eaten, local (custom + cache) matches, USDA and FatSecret search results. */
foods.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ history: [], local: [], usda: [], fatsecret: [] });
  const user = c.get('user');
  const remote = c.req.query('remote') !== '0';
  const fs = remote ? fatsecretClient(c.env) : null;
  // FatSecret runs alongside everything else.
  const fsHits = fs ? fs.search(q, 15).catch((e) => (console.warn('FatSecret search failed', q, (e as Error).message), [])) : Promise.resolve([]);
  // Foods you've eaten that mean the same thing ("the meatballs I like"): by meaning, kept only
  // when close or when they contain every food word you typed.
  const history = (await searchHistory(c.env, user.id, q, 8))
    .filter((h) => h.similarity >= HISTORY_MIN_SIMILARITY || [h.food.name, ...h.names].some((n) => coversQuery(q, n)))
    .slice(0, 5)
    .map((h) => ({ ...h.food, history: { names: h.names, times: h.times, last_at: h.last_at } }));
  const inHistory = new Set(history.map((f) => f.id));
  const local = (await searchLocal(c.env.DB, user.id, q)).filter((f) => !inHistory.has(f.id));
  let usda: unknown[] = [];
  let usdaError: string | undefined;
  if (remote && c.env.USDA_API_KEY) {
    try {
      const hits = await usdaClient(c.env).searchAll(q);
      const cachedIds = new Set([...history, ...local].filter((f) => f.source === 'usda').map((f) => f.source_id));
      usda = hits.filter((h) => !cachedIds.has(h.sourceId));
      // Older cached foods have no category yet; the search hits carry it.
      c.executionCtx.waitUntil(backfillCategories(c.env.DB, local, hits).catch(() => {}));
    } catch (e) {
      usdaError = (e as Error).message;
    }
  }
  const cachedFs = new Set([...history, ...local].filter((f) => f.source === 'fatsecret').map((f) => f.source_id));
  const fatsecret = (await fsHits).filter((h) => !cachedFs.has(h.sourceId));
  return c.json({ history, local, usda, fatsecret, ...(usdaError ? { usda_error: usdaError } : {}) });
});

/** GET /api/foods/fatsecret/:id -> resolve (and cache) a FatSecret food. */
foods.get('/fatsecret/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'bad FatSecret id');
  return c.json(await resolveFatSecret(c.env, id));
});

/** GET /api/foods/fdc/:fdcId -> resolve (and cache) a USDA food with portions. */
foods.get('/fdc/:fdcId', async (c) => {
  const fdcId = c.req.param('fdcId');
  if (!/^\d+$/.test(fdcId)) throw new HttpError(400, 'bad fdc id');
  return c.json(await resolveFdc(c.env, fdcId));
});

/**
 * GET /api/foods/quick?meal_type=&with= -> starred, recent and frequent foods (frequent ranked for that meal).
 * With `with` (a meal's id, when adding to it): also `goes_with`, what you usually have with what's in it.
 */
foods.get('/quick', async (c) => {
  const mt = c.req.query('meal_type');
  const mealType = mt && MEAL_TYPES.includes(mt as MealType) ? (mt as MealType) : null;
  const withId = c.req.query('with');
  const user = c.get('user');
  const [quick, favorites, goes_with] = await Promise.all([
    quickFoods(c.env.DB, user.id, mealType),
    listFavorites(c.env.DB, user.id),
    withId ? goesWith(c.env.DB, user.id, withId) : Promise.resolve(undefined),
  ]);
  return c.json({ favorites, ...quick, ...(goes_with ? { goes_with } : {}) });
});

/** GET /api/foods/favorites -> starred foods, oldest first, with kcal for their amount. */
foods.get('/favorites', async (c) => c.json(await listFavorites(c.env.DB, c.get('user').id)));

/** POST /api/foods/favorites {name, food_id, amount, unit} -> star a food (same name again updates it). */
foods.post('/favorites', async (c) => c.json(await addFavorite(c.env.DB, c.get('user').id, await c.req.json()), 201));

/** DELETE /api/foods/favorites/:id -> unstar. */
foods.delete('/favorites/:id', async (c) => {
  await removeFavorite(c.env.DB, c.get('user').id, c.req.param('id'));
  return c.body(null, 204);
});

/** GET /api/foods/mine -> the user's custom foods (not recipes). */
foods.get('/mine', async (c) => c.json(await listCustomFoods(c.env.DB, c.get('user').id)));

/**
 * POST /api/foods/label (multipart: `photo` x1-MAX_PHOTOS, optional `name`) -> a draft custom food read
 * from a nutrition label or a restaurant app screenshot. Not saved: the client shows it for editing.
 */
foods.post('/label', async (c) => {
  const form = await c.req.formData();
  const files = form.getAll('photo').filter((p): p is File => p instanceof File);
  if (!files.length) throw new HttpError(400, 'send a photo of the label');
  if (files.length > MAX_PHOTOS) throw new HttpError(413, `up to ${MAX_PHOTOS} photos`);
  const photos: PhotoInput[] = [];
  for (const f of files) {
    if (f.size > MAX_PHOTO) throw new HttpError(413, 'photo is too large (max 8 MB)');
    if (!(f.type || 'image/jpeg').startsWith('image/')) throw new HttpError(415, 'photo must be an image');
    photos.push({ bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type || 'image/jpeg' });
  }
  const hint = typeof form.get('name') === 'string' ? (form.get('name') as string).trim() || undefined : undefined;
  const configured = (await getSettings(c.env.DB, c.get('user').id)).model_vision;
  // Label reading sends chat-style image messages; a single-image model can't take them.
  const model = /llama-3\.2-11b-vision/.test(configured) ? FALLBACK_MODELS.vision : configured;
  try {
    try {
      return c.json(await readLabel(c.env, model, photos, hint));
    } catch (e) {
      if (!isCapacityError(e) || model === FALLBACK_MODELS.vision) throw e;
      return c.json(await readLabel(c.env, FALLBACK_MODELS.vision, photos, hint));
    }
  } catch (e) {
    if (e instanceof LabelReadError) throw new HttpError(422, e.message);
    throw e;
  }
});

/** GET /api/foods/:id/source -> the source database's full record for the food, as received. */
foods.get('/:id/source', async (c) => {
  const f = await getFood(c.env.DB, c.get('user').id, c.req.param('id'));
  if (!f) throw new HttpError(404, 'food not found');
  const snap = await getSnapshot(c.env.DB, f.id);
  if (!snap) throw new HttpError(404, 'no source record for this food');
  return c.json(snap);
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

/** PUT /api/foods/:id -> edit a custom food (future logs use the new values). */
foods.put('/:id', async (c) => {
  const body = await c.req.json<CustomFoodInput>();
  return c.json(await updateCustomFood(c.env.DB, c.get('user').id, c.req.param('id'), body));
});

/** DELETE /api/foods/:id -> delete (archive) a custom food. */
foods.delete('/:id', async (c) => {
  await archiveCustomFood(c.env.DB, c.get('user').id, c.req.param('id'));
  return c.body(null, 204);
});
