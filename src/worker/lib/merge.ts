/**
 * Adding to an existing meal.
 *
 * - From a meal's own "Add item": the new items go into that meal (`into`).
 * - From the main log button: breakfast, lunch and dinner join the day's existing meal of
 *   that type (`auto`); snacks always start a new entry.
 *
 * AI entries are analyzed as their own draft first (the meal type can change and questions
 * may be pending), then merged once complete. Only `completed` meals are merge targets:
 * answering a meal's questions rebuilds its items, which would drop anything merged in.
 */
import type { Env } from '../env';
import { HttpError } from './ids';
import { refreshConfidence, type MealType } from './intake';

export type MergeSpec = { mode: 'auto' } | { mode: 'into'; id: string };

export function parseMergeSpec(appendTo: unknown, merge: unknown): MergeSpec | null {
  if (typeof appendTo === 'string' && appendTo) return { mode: 'into', id: appendTo };
  if (merge === true || merge === '1' || merge === 'true') return { mode: 'auto' };
  return null;
}

/** The day's meal of the same type to add to, or null for snacks / no such meal. */
export async function findMergeTarget(db: D1Database, userId: string, logDate: string, mealType: MealType, excludeId = ''): Promise<string | null> {
  if (mealType === 'snack') return null;
  const row = await db
    .prepare(
      `SELECT id FROM nutrition_intake WHERE user_id = ? AND log_date = ? AND meal_type = ? AND status = 'completed' AND id != ?
       ORDER BY occurrence_at ASC LIMIT 1`,
    )
    .bind(userId, logDate, mealType, excludeId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Check an explicit target before accepting new items for it; returns its type and time. */
export async function assertAppendable(db: D1Database, userId: string, id: string): Promise<{ meal_type: MealType; occurrence_at: string }> {
  const row = await db
    .prepare('SELECT status, meal_type, occurrence_at FROM nutrition_intake WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ status: string; meal_type: MealType; occurrence_at: string }>();
  if (!row || row.status === 'entered-in-error') throw new HttpError(404, 'meal not found');
  if (row.status !== 'completed') throw new HttpError(409, 'finish this meal (answer its questions) before adding to it');
  return { meal_type: row.meal_type, occurrence_at: row.occurrence_at };
}

/** Resolve where a finished draft should go: an explicit meal, the day's meal of its type, or nowhere. */
export async function resolveTarget(env: Env, userId: string, draftId: string, spec: MergeSpec | null | undefined): Promise<string | null> {
  if (!spec) return null;
  if (spec.mode === 'into') return spec.id === draftId ? null : spec.id;
  const d = await env.DB.prepare('SELECT log_date, meal_type FROM nutrition_intake WHERE id = ? AND user_id = ?')
    .bind(draftId, userId)
    .first<{ log_date: string; meal_type: MealType }>();
  return d ? findMergeTarget(env.DB, userId, d.log_date, d.meal_type, draftId) : null;
}

/**
 * Move a completed draft's items into the target meal and remove the (now empty) draft.
 * Returns the id of the meal that holds the items: the target, or the draft if the target
 * is gone or not completed (then the draft simply stays its own meal).
 */
export async function mergeDraft(env: Env, userId: string, draftId: string, targetId: string): Promise<string> {
  const [target, draft] = await Promise.all([
    env.DB.prepare('SELECT id, status, media_r2_key, raw_input_text FROM nutrition_intake WHERE id = ? AND user_id = ?')
      .bind(targetId, userId)
      .first<{ id: string; status: string; media_r2_key: string | null; raw_input_text: string | null }>(),
    env.DB.prepare('SELECT id, status, media_r2_key, raw_input_text FROM nutrition_intake WHERE id = ? AND user_id = ?')
      .bind(draftId, userId)
      .first<{ id: string; status: string; media_r2_key: string | null; raw_input_text: string | null }>(),
  ]);
  if (!draft || draft.status !== 'completed') return draftId;
  if (!target || target.status !== 'completed') return draftId;

  const [pos, photoPos] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM consumed_item WHERE intake_id = ?').bind(targetId).first<{ next: number }>(),
    env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM intake_photo WHERE intake_id = ?').bind(targetId).first<{ next: number }>(),
  ]);
  const keepMedia = !target.media_r2_key && draft.media_r2_key ? draft.media_r2_key : null;
  const text = [target.raw_input_text, draft.raw_input_text].filter(Boolean).join('\n') || null;

  await env.DB.batch([
    env.DB.prepare('UPDATE consumed_item SET intake_id = ?, position = position + ? WHERE intake_id = ? AND user_id = ?').bind(targetId, pos?.next ?? 0, draftId, userId),
    // The draft's photos join the meal's, after the ones it already has.
    env.DB.prepare('UPDATE intake_photo SET intake_id = ?, position = position + ? WHERE intake_id = ?').bind(targetId, photoPos?.next ?? 0, draftId),
    // Remember where it went, so a client still holding the draft's id can follow it.
    env.DB.prepare('INSERT OR REPLACE INTO intake_redirect (user_id, from_id, to_id) VALUES (?, ?, ?)').bind(userId, draftId, targetId),
    env.DB.prepare(
      `UPDATE nutrition_intake SET media_r2_key = COALESCE(media_r2_key, ?), raw_input_text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND user_id = ?`,
    ).bind(keepMedia, text, targetId, userId),
    env.DB.prepare('DELETE FROM nutrition_intake WHERE id = ? AND user_id = ?').bind(draftId, userId),
    refreshConfidence(env.DB, targetId),
  ]);
  // A second voice clip for a meal that already has one isn't played anywhere; don't keep it.
  if (draft.media_r2_key && !keepMedia) await env.MEDIA.delete(draft.media_r2_key).catch(() => {});
  return targetId;
}

/** Where a merged draft's items went, if it was merged. */
export async function mergedInto(db: D1Database, userId: string, draftId: string): Promise<string | null> {
  const r = await db.prepare('SELECT to_id FROM intake_redirect WHERE user_id = ? AND from_id = ?').bind(userId, draftId).first<{ to_id: string }>();
  return r?.to_id ?? null;
}
