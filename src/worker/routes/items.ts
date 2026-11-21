import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/ids';
import { round } from '../lib/nutrients';
import { assertItemsEditable, getIntake, itemStatements, refreshConfidence, resolveRef, validAmount, type ItemRef } from '../lib/intake';
import { recordEvents } from '../lib/events';
import { getFood, type FoodRecord } from '../lib/foods';
import { gatherLocal, gatherRemote, rememberChoice, toMatchCandidate, type MatchInfo } from '../lib/matcher';
import { decide } from '../lib/decide';
import { toGrams, ucum, type Conversion } from '../lib/units';

export const items = new Hono<AppEnv>();

interface ItemRow {
  id: string;
  intake_id: string;
  position: number;
  food_id: string | null;
  display_name: string;
  amount_value: number;
  amount_unit: string;
  grams: number;
  confidence: number;
  estimation_method: 'photo-estimate' | 'described' | 'weighed' | 'label';
  estimated: number;
  match_json: string | null;
  intake_status: string;
}

const loadRow = (db: D1Database, id: string, userId: string) =>
  db
    .prepare('SELECT ci.*, i.status AS intake_status FROM consumed_item ci JOIN nutrition_intake i ON i.id = ci.intake_id WHERE ci.id = ? AND ci.user_id = ?')
    .bind(id, userId)
    .first<ItemRow>();

/** How the saved grams were reached for this item's amount, with the user's words helping pick the cup weight. */
const convert = (row: ItemRow, food: FoodRecord, amount = row.amount_value, unit = row.amount_unit) => toGrams(amount, unit, { ...food, name: [row.display_name, food.name] });

/**
 * The grams were the AI's own estimate: the stored weight differs from what the size table gives for
 * the amount (pipeline.ts keeps the model's weight when the table has nothing better). For volumes
 * only AI-logged items (with match details) count: manual cups saved before the cup-weight table
 * were weighed as water, and that's not an estimate to keep.
 */
const usedAiWeight = (row: ItemRow, conv: Conversion) =>
  Math.abs(conv.grams - row.grams) > 0.5 && (conv.method === 'generic' || ((conv.method === 'volume' || conv.method === 'density') && row.match_json != null));

const parseMatch = (j: string | null): MatchInfo | null => {
  try {
    return j ? (JSON.parse(j) as MatchInfo) : null;
  } catch {
    return null;
  }
};

/**
 * GET /api/item/:id -> everything behind an item's numbers: the matched food (per-100 g
 * nutrients, portions, USDA link), how the amount became grams, and the candidates considered.
 */
items.get('/:id', async (c) => {
  const user = c.get('user');
  const row = await loadRow(c.env.DB, c.req.param('id'), user.id);
  if (!row) throw new HttpError(404, 'item not found');
  const food = row.food_id ? await getFood(c.env.DB, user.id, row.food_id) : null;
  const intake = await getIntake(c.env.DB, user.id, row.intake_id);
  const item = intake?.items.find((i) => i.id === row.id);
  const conv = food ? convert(row, food) : null;
  const aiWeight = conv ? usedAiWeight(row, conv) : false;
  return c.json({
    item,
    intake_id: row.intake_id,
    food: food && {
      ...food,
      fdc_url: food.source === 'usda' && food.source_id ? `https://fdc.nal.usda.gov/food-details/${food.source_id}/nutrients` : null,
    },
    conversion: conv && {
      method: aiWeight ? 'ai-estimate' : conv.method,
      grams_per_unit: row.grams / row.amount_value,
      stored_grams: row.grams,
      // The typical cup the weight came from ("leafy greens, 47 g"), for a volume of a food with no cup portion.
      per_cup: aiWeight ? null : (conv.per_cup ?? null),
    },
    match: parseMatch(row.match_json),
  });
});

/** GET /api/item/:id/search?q= -> ranked alternatives for this item (local foods, USDA, FatSecret). */
items.get('/:id/search', async (c) => {
  const user = c.get('user');
  const row = await loadRow(c.env.DB, c.req.param('id'), user.id);
  if (!row) throw new HttpError(404, 'item not found');
  const match = parseMatch(row.match_json);
  const q = (c.req.query('q') ?? match?.query ?? row.display_name).trim();
  if (q.length < 2) throw new HttpError(400, 'search needs at least 2 characters');
  const est = match?.estimate_kcal_100g ?? null;
  // The same gathering and ranking as matching, without history (this is a search, not a description).
  const local = await gatherLocal(c.env, user.id, { name: q, query: q, history: false, localMax: 10 });
  const remote = await gatherRemote(c.env, q, local, { usdaPageSize: 25, fatsecretMax: 20 });
  const error = remote.lookupError;
  const ranked = decide({ name: q, query: q, estimateKcal100: est }, [...local, ...remote.options]).ranked;
  const candidates = ranked.slice(0, 20).map(toMatchCandidate);
  // The change log: a search for a different food usually means the match was wrong.
  const logged = recordEvents(c.env.DB, user.id, [
    {
      intake_id: row.intake_id,
      item_id: row.id,
      actor: c.env.MCP_USER ? 'mcp' : 'app',
      kind: 'searched',
      detail: { query: q, item_name: row.display_name, results: candidates.slice(0, 5).map((x) => x.name) },
    },
  ]).catch((e) => console.warn('meal log: search failed', (e as Error).message));
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    await logged;
  }
  return c.json({ query: q, estimate_kcal_100g: est, candidates, ...(error ? { error } : {}) });
});

/**
 * PATCH /api/item/:id -> swap the food and/or change the amount. Nutrients are recomputed.
 * Body: { food_id?, fdc_id?, fatsecret_id?, amount?, unit?, grams?, display_name? }
 */
items.patch('/:id', async (c) => {
  const user = c.get('user');
  const row = await loadRow(c.env.DB, c.req.param('id'), user.id);
  if (!row) throw new HttpError(404, 'item not found');
  assertItemsEditable(row.intake_status);
  const body = await c.req.json<Partial<ItemRef> & { remember?: boolean; confidence?: number }>();
  if (body.confidence !== undefined && !(typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1))
    throw new HttpError(400, 'confidence must be between 0 and 1');
  const swapping = body.food_id != null || body.fdc_id != null || body.fatsecret_id != null;
  // Confidence alone: just record how sure the user is about this item.
  if (body.confidence !== undefined && !swapping && body.amount === undefined && body.unit === undefined && body.grams === undefined && body.display_name === undefined) {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE consumed_item SET confidence = ? WHERE id = ? AND user_id = ?').bind(round(body.confidence, 2), row.id, user.id),
      refreshConfidence(c.env.DB, row.intake_id),
    ]);
    return c.json(await getIntake(c.env.DB, user.id, row.intake_id));
  }
  const food = swapping ? await resolveRef(c.env, user, body as ItemRef) : row.food_id ? await getFood(c.env.DB, user.id, row.food_id) : null;
  if (!food) throw new HttpError(400, 'item has no food; supply food_id, fdc_id or fatsecret_id');
  const amount = body.amount ?? row.amount_value;
  const unit = body.unit ?? row.amount_unit;
  validAmount({ amount, unit, grams: body.grams });
  const amountChanged = body.amount !== undefined || body.unit !== undefined;
  // Same household unit, new count, and the saved weight came from the AI's estimate rather than the
  // size or cup tables: keep its weight per unit ("2 small" bananas = 2 × its 80 g, not 2 × 100 g).
  const sameUnit = !swapping && ucum(unit) === row.amount_unit;
  const fromAi = sameUnit && row.amount_value > 0 && usedAiWeight(row, convert(row, food));
  const grams = body.grams ?? (fromAi ? (row.grams / row.amount_value) * amount : amountChanged || swapping ? undefined : row.grams);
  const edited = swapping || amountChanged || body.grams !== undefined;
  // AI-logged items keep the user's words as the label; the matched food is shown separately.
  const match = parseMatch(row.match_json);
  if (swapping && match) {
    match.chosen = (food.source === 'usda' || food.source === 'fatsecret') && food.source_id ? food.source_id : food.id;
    // The user picked this food: words the matcher's pick lacked no longer apply.
    delete match.missing_words;
  }
  const label = body.display_name ?? (swapping && !match ? food.name : row.display_name);
  const stmts = [
    c.env.DB.prepare('DELETE FROM intake_nutrient WHERE consumed_item_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM consumed_item WHERE id = ?').bind(row.id),
    ...itemStatements(
      c.env.DB,
      user.id,
      row.intake_id,
      {
        food,
        display_name: label,
        amount,
        unit,
        grams,
        // A user correction is as good as it gets for that item, unless they say otherwise.
        confidence: body.confidence ?? (edited ? 1 : row.confidence),
        method: body.grams !== undefined || /^(g|kg|\[oz_av\]|\[lb_av\]|oz|lb)$/.test(unit) ? 'weighed' : edited ? 'described' : row.estimation_method,
        estimated: swapping ? food.source === 'estimate' : row.estimated === 1,
        match,
      },
      row.position,
      row.id,
    ),
    refreshConfidence(c.env.DB, row.intake_id),
  ];
  await c.env.DB.batch(stmts);
  // Learn from corrections: next time this food is described the same way, use the new choice.
  if (swapping && match && body.remember !== false && food.source !== 'estimate') await rememberChoice(c.env.DB, user.id, row.display_name, food.id);
  return c.json(await getIntake(c.env.DB, user.id, row.intake_id));
});

/** DELETE /api/item/:id -> remove an item from a meal. */
items.delete('/:id', async (c) => {
  const user = c.get('user');
  const row = await loadRow(c.env.DB, c.req.param('id'), user.id);
  if (!row) throw new HttpError(404, 'item not found');
  assertItemsEditable(row.intake_status);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM intake_nutrient WHERE consumed_item_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM consumed_item WHERE id = ?').bind(row.id),
    refreshConfidence(c.env.DB, row.intake_id),
  ]);
  return c.json(await getIntake(c.env.DB, user.id, row.intake_id));
});
