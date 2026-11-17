import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/ids';
import { archiveRecipe, getRecipe, listRecipes, saveRecipe, type RecipeInput } from '../lib/recipes';

export const recipes = new Hono<AppEnv>();

/** GET /api/recipes -> the user's recipes with per-serving nutrition and ingredients. */
recipes.get('/', async (c) => c.json(await listRecipes(c.env.DB, c.get('user').id)));

recipes.get('/:id', async (c) => {
  const r = await getRecipe(c.env.DB, c.get('user').id, c.req.param('id'));
  if (!r) throw new HttpError(404, 'recipe not found');
  return c.json(r);
});

/**
 * POST /api/recipes -> create a recipe.
 * Body: { name, servings, yield_grams?, ingredients: [{food_id|fdc_id, amount, unit, grams?, display_name?}] }
 *   or  { name, servings, yield_grams?, from_intake, remove_intake? } to turn a logged batch into a recipe.
 */
recipes.post('/', async (c) => c.json(await saveRecipe(c.env, c.get('user'), await c.req.json<RecipeInput>()), 201));

/** PUT /api/recipes/:id -> replace name, size and ingredients. Past logs keep their numbers. */
recipes.put('/:id', async (c) => c.json(await saveRecipe(c.env, c.get('user'), await c.req.json<RecipeInput>(), c.req.param('id'))));

recipes.delete('/:id', async (c) => {
  await archiveRecipe(c.env.DB, c.get('user').id, c.req.param('id'));
  return c.body(null, 204);
});
