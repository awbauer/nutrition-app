import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/ids';
import { getIntake, itemStatements, refreshConfidence, resolveRef, validAmount, type ItemRef } from '../lib/intake';
import { getFood } from '../lib/foods';

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
}

/**
 * PATCH /api/item/:id -> swap the food and/or change the amount. Nutrients are recomputed.
 * Body: { food_id?, fdc_id?, amount?, unit?, grams?, display_name? }
 */
items.patch('/:id', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT * FROM consumed_item WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<ItemRow>();
  if (!row) throw new HttpError(404, 'item not found');
  const body = await c.req.json<Partial<ItemRef>>();
  const swapping = body.food_id != null || body.fdc_id != null;
  const food = swapping ? await resolveRef(c.env, user, body as ItemRef) : row.food_id ? await getFood(c.env.DB, user.id, row.food_id) : null;
  if (!food) throw new HttpError(400, 'item has no food; supply food_id or fdc_id');
  const amount = body.amount ?? row.amount_value;
  const unit = body.unit ?? row.amount_unit;
  validAmount({ amount, unit });
  const amountChanged = body.amount !== undefined || body.unit !== undefined;
  const grams = body.grams ?? (amountChanged || swapping ? undefined : row.grams);
  const edited = swapping || amountChanged || body.grams !== undefined;
  const stmts = [
    c.env.DB.prepare('DELETE FROM intake_nutrient WHERE consumed_item_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM consumed_item WHERE id = ?').bind(row.id),
    ...itemStatements(
      c.env.DB,
      user.id,
      row.intake_id,
      {
        food,
        display_name: body.display_name ?? (swapping ? food.name : row.display_name),
        amount,
        unit,
        grams,
        // A user correction is as good as it gets for that item.
        confidence: edited ? 1 : row.confidence,
        method: body.grams !== undefined || /^(g|kg|\[oz_av\]|\[lb_av\]|oz|lb)$/.test(unit) ? 'weighed' : edited ? 'described' : row.estimation_method,
        estimated: swapping ? false : row.estimated === 1,
      },
      row.position,
      row.id,
    ),
    refreshConfidence(c.env.DB, row.intake_id),
  ];
  await c.env.DB.batch(stmts);
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
