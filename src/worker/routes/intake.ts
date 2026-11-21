import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/ids';
import {
  createIntake,
  getIntake,
  intakeTiming,
  itemStatements,
  MEAL_TYPES,
  refreshConfidence,
  resolveRef,
  STATUSES,
  validAmount,
  type ItemRef,
  type MealType,
  type ResolvedItem,
  type Status,
} from '../lib/intake';
import { getFood } from '../lib/foods';
import { mealHistory } from '../lib/events';
import { assertAppendable, findMergeTarget, mergedInto, parseMergeSpec } from '../lib/merge';
import { answer, createFromMedia, media, photo, retry } from './log';

export const intake = new Hono<AppEnv>();

interface ManualBody {
  meal_type?: MealType;
  occurrence_at?: string;
  note?: string;
  items: ItemRef[];
  /** Add to this meal (its "Add item"). */
  append_to?: string;
  /** Main button: join the day's breakfast/lunch/dinner if there is one; snacks stay separate. */
  merge?: boolean;
}

/** Manual entry: items reference a food_id or fdc_id with an amount. */
export async function createManual(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }, body: ManualBody) {
  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'items are required');
  if (body.items.length > 30) throw new HttpError(400, 'too many items');
  const user = c.get('user');
  const resolved: ResolvedItem[] = [];
  for (const ref of body.items) {
    validAmount(ref);
    const food = await resolveRef(c.env, user, ref);
    resolved.push({
      food,
      display_name: ref.display_name,
      amount: ref.amount,
      unit: ref.unit,
      grams: ref.grams,
      confidence: 1,
      method: ref.estimation_method ?? (/^(g|kg|oz|lb)$/i.test(ref.unit) ? 'weighed' : 'described'),
    });
  }
  const spec = parseMergeSpec(body.append_to, body.merge);
  let target: string | null = null;
  if (spec?.mode === 'into') {
    await assertAppendable(c.env.DB, user.id, spec.id);
    target = spec.id;
  } else if (spec?.mode === 'auto') {
    const t = await intakeTiming(c.env.DB, user, body.occurrence_at, body.meal_type);
    target = await findMergeTarget(c.env.DB, user.id, t.log_date, t.meal_type);
  }
  if (target) {
    const pos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM consumed_item WHERE intake_id = ?').bind(target).first<{ next: number }>();
    const stmts: D1PreparedStatement[] = [];
    resolved.forEach((it, i) => stmts.push(...itemStatements(c.env.DB, user.id, target!, it, (pos?.next ?? 0) + i)));
    stmts.push(refreshConfidence(c.env.DB, target));
    await c.env.DB.batch(stmts);
    return target;
  }
  return createIntake(c.env, user, { ...body, source: 'manual' }, resolved);
}

/**
 * POST /api/intake
 * - application/json: manual entry ({items:[{fdc_id|food_id, amount, unit}]})
 * - multipart/form-data: photo / audio / text (AI pipeline)
 */
intake.post('/', async (c) => {
  const ct = c.req.header('Content-Type') ?? '';
  if (ct.includes('application/json')) {
    const body = await c.req.json<ManualBody>();
    const id = await createManual(c, body);
    return c.json(await getIntake(c.env.DB, c.get('user').id, id), 201);
  }
  if (ct.includes('multipart/form-data')) return createFromMedia(c);
  throw new HttpError(415, 'send application/json or multipart/form-data');
});

intake.post('/:id/answers', answer);
intake.post('/:id/retry', retry);
intake.get('/:id/media', media);
intake.get('/:id/photos/:n', photo);

/** GET /api/intake/:id/history -> the meal's change log, oldest first (an entry merged away shows its new meal's). */
intake.get('/:id/history', async (c) => {
  const user = c.get('user');
  let id = c.req.param('id');
  if (!(await getIntake(c.env.DB, user.id, id))) {
    const to = await mergedInto(c.env.DB, user.id, id);
    if (!to) throw new HttpError(404, 'intake not found');
    id = to;
  }
  return c.json({ meal_id: id, events: await mealHistory(c.env.DB, user.id, id) });
});

/** GET /api/intake/:id -> the meal; an entry merged into another meal returns that meal with `merged_from`. */
intake.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const v = await getIntake(c.env.DB, user.id, id);
  if (v) return c.json(v);
  const to = await mergedInto(c.env.DB, user.id, id);
  const target = to && (await getIntake(c.env.DB, user.id, to));
  if (!target) throw new HttpError(404, 'intake not found');
  return c.json({ ...target, merged_from: id });
});

/** PATCH /api/intake/:id -> edit time, meal type, note, status. */
intake.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await getIntake(c.env.DB, user.id, id);
  if (!existing) throw new HttpError(404, 'intake not found');
  const body = await c.req.json<{ occurrence_at?: string; meal_type?: MealType; note?: string | null; status?: Status }>();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.occurrence_at !== undefined) {
    const t = await intakeTiming(c.env.DB, user, body.occurrence_at, existing.meal_type);
    sets.push('occurrence_at = ?', 'occurrence_tz = ?', 'log_date = ?');
    vals.push(t.occurrence_at, t.occurrence_tz, t.log_date);
  }
  if (body.meal_type !== undefined) {
    if (!MEAL_TYPES.includes(body.meal_type)) throw new HttpError(400, 'invalid meal_type');
    sets.push('meal_type = ?');
    vals.push(body.meal_type);
  }
  if (body.note !== undefined) {
    sets.push('note = ?');
    vals.push(body.note);
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'invalid status');
    sets.push('status = ?');
    vals.push(body.status);
  }
  if (!sets.length) throw new HttpError(400, 'nothing to update');
  await c.env.DB.prepare(`UPDATE nutrition_intake SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`)
    .bind(...vals, id, user.id)
    .run();
  return c.json(await getIntake(c.env.DB, user.id, id));
});

/** DELETE /api/intake/:id -> soft delete (status entered-in-error). */
intake.delete('/:id', async (c) => {
  const user = c.get('user');
  const r = await c.env.DB.prepare(`UPDATE nutrition_intake SET status = 'entered-in-error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`)
    .bind(c.req.param('id'), user.id)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'intake not found');
  return c.body(null, 204);
});

/** POST /api/intake/:id/items -> add an item to an existing meal. */
intake.post('/:id/items', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await getIntake(c.env.DB, user.id, id);
  if (!existing) throw new HttpError(404, 'intake not found');
  const ref = await c.req.json<ItemRef>();
  validAmount(ref);
  const food = await resolveRef(c.env, user, ref);
  const item: ResolvedItem = {
    food,
    display_name: ref.display_name,
    amount: ref.amount,
    unit: ref.unit,
    grams: ref.grams,
    confidence: 1,
    method: ref.estimation_method ?? 'described',
  };
  await c.env.DB.batch([...itemStatements(c.env.DB, user.id, id, item, existing.items.length), refreshConfidence(c.env.DB, id)]);
  return c.json(await getIntake(c.env.DB, user.id, id), 201);
});

/** POST /api/intake/:id/copy -> copy a meal to now (or a given time / meal type). */
intake.post('/:id/copy', async (c) => {
  const user = c.get('user');
  const src = await getIntake(c.env.DB, user.id, c.req.param('id'));
  if (!src) throw new HttpError(404, 'intake not found');
  const body = await c.req.json<{ occurrence_at?: string; meal_type?: MealType }>().catch(() => ({}) as Record<string, never>);
  const items: ResolvedItem[] = [];
  for (const it of src.items) {
    if (!it.food_id) continue;
    const food = await getFood(c.env.DB, user.id, it.food_id);
    if (!food) continue;
    items.push({
      food,
      display_name: it.display_name,
      amount: it.amount_value,
      unit: it.amount_unit,
      grams: it.grams,
      confidence: it.confidence,
      method: it.estimation_method,
      estimated: it.estimated,
    });
  }
  if (!items.length) throw new HttpError(400, 'meal has no items to copy');
  const newId = await createIntake(c.env, user, { source: 'copy', meal_type: body.meal_type ?? src.meal_type, occurrence_at: body.occurrence_at, note: src.note }, items);
  return c.json(await getIntake(c.env.DB, user.id, newId), 201);
});
