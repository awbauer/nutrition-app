import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/ids';
import { round } from '../lib/nutrients';
import { getIntake, itemStatements, refreshConfidence, resolveRef, validAmount, type ItemRef } from '../lib/intake';
import { getFood, searchLocal } from '../lib/foods';
import { localCandidate, rankedUsda, rememberChoice, fatsecretCandidate, rankedFatSecret, usdaCandidate, type MatchInfo } from '../lib/matcher';
import { rankCandidates } from '../lib/scoring';
import { toGrams } from '../lib/units';

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
}

const loadRow = (db: D1Database, id: string, userId: string) =>
  db.prepare('SELECT * FROM consumed_item WHERE id = ? AND user_id = ?').bind(id, userId).first<ItemRow>();

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
  const conv = food ? toGrams(row.amount_value, row.amount_unit, food) : null;
  return c.json({
    item,
    intake_id: row.intake_id,
    food: food && {
      ...food,
      fdc_url: food.source === 'usda' && food.source_id ? `https://fdc.nal.usda.gov/food-details/${food.source_id}/nutrients` : null,
    },
    conversion: conv && {
      // Stored grams differ from the generic table when the AI's weight estimate was used.
      method: conv.method === 'generic' && Math.abs(conv.grams - row.grams) > 0.5 ? 'ai-estimate' : conv.method,
      grams_per_unit: row.grams / row.amount_value,
      stored_grams: row.grams,
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
  const local = (await searchLocal(c.env.DB, user.id, q, 10)).filter((f) => f.source !== 'estimate');
  const per100 = (f: { nutrients: { code: string; value: number }[] }) => f.nutrients.find((n) => n.code === 'ENERC_KCAL')?.value ?? null;
  const rankedLocal = rankCandidates(q, local.map((f) => ({ ...f, dataType: f.data_type, kcal100: per100(f) })), est).map((r) =>
    localCandidate(r.candidate, r.score, r.reasons),
  );
  let remote: ReturnType<typeof usdaCandidate>[] = [];
  let error: string | undefined;
  const seenUsda = new Set(rankedLocal.map((r) => r.fdc_id).filter(Boolean));
  const seenFs = new Set(rankedLocal.map((r) => r.fatsecret_id).filter(Boolean));
  const [usda, fs] = await Promise.allSettled([c.env.USDA_API_KEY ? rankedUsda(c.env, q, est, 25) : Promise.resolve([]), rankedFatSecret(c.env, q, est, 20)]);
  if (usda.status === 'fulfilled') remote.push(...usda.value.filter((r) => !seenUsda.has(r.candidate.sourceId)).map((r) => usdaCandidate(r.candidate, r.score, r.reasons)));
  else error = (usda.reason as Error).message;
  if (fs.status === 'fulfilled') remote.push(...fs.value.filter((r) => !seenFs.has(r.candidate.sourceId)).map((r) => fatsecretCandidate(r.candidate, r.score, r.reasons)));
  else console.warn('FatSecret search failed', q, (fs.reason as Error).message);
  return c.json({ query: q, estimate_kcal_100g: est, candidates: [...rankedLocal, ...remote].sort((a, b) => b.score - a.score).slice(0, 20), ...(error ? { error } : {}) });
});

/**
 * PATCH /api/item/:id -> swap the food and/or change the amount. Nutrients are recomputed.
 * Body: { food_id?, fdc_id?, fatsecret_id?, amount?, unit?, grams?, display_name? }
 */
items.patch('/:id', async (c) => {
  const user = c.get('user');
  const row = await loadRow(c.env.DB, c.req.param('id'), user.id);
  if (!row) throw new HttpError(404, 'item not found');
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
  validAmount({ amount, unit });
  const amountChanged = body.amount !== undefined || body.unit !== undefined;
  const grams = body.grams ?? (amountChanged || swapping ? undefined : row.grams);
  const edited = swapping || amountChanged || body.grams !== undefined;
  // AI-logged items keep the user's words as the label; the matched food is shown separately.
  const match = parseMatch(row.match_json);
  if (swapping && match) match.chosen = (food.source === 'usda' || food.source === 'fatsecret') && food.source_id ? food.source_id : food.id;
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
  const row = await c.env.DB.prepare('SELECT id, intake_id FROM consumed_item WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<{ id: string; intake_id: string }>();
  if (!row) throw new HttpError(404, 'item not found');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM intake_nutrient WHERE consumed_item_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM consumed_item WHERE id = ?').bind(row.id),
    refreshConfidence(c.env.DB, row.intake_id),
  ]);
  return c.json(await getIntake(c.env.DB, user.id, row.intake_id));
});
