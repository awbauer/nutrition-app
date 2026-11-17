/** AI logging routes: photo / voice / text intake (processed in the background), clarifying answers, media access. */
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { HttpError, newId } from '../lib/ids';
import { createIntake, getIntake, MEAL_TYPES, type MealType, type Source } from '../lib/intake';
import { enqueue, type JobState } from '../lib/jobs';
import { applyAnswers } from '../lib/pipeline';
import { assertAppendable, mergedInto, parseMergeSpec } from '../lib/merge';
import { assertRecipeNameFree, validateRecipe } from '../lib/recipes';

const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_AUDIO = 10 * 1024 * 1024;
const MAX_TEXT = 2000;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/**
 * POST /api/intake with multipart form: one of photo | audio | text, plus meal_type?, occurrence_at?, note?.
 * Saves the meal right away as `preparation` (202) and hands the AI work to a background job.
 */
export async function createFromMedia(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const form = await c.req.formData();
  const photo = form.get('photo');
  const audio = form.get('audio');
  const textField = form.get('text');
  const text = typeof textField === 'string' ? textField.trim() : '';
  const mealRaw = form.get('meal_type');
  const meal_type = typeof mealRaw === 'string' && mealRaw ? (mealRaw as MealType) : undefined;
  if (meal_type && !MEAL_TYPES.includes(meal_type)) throw new HttpError(400, 'invalid meal_type');
  const occRaw = form.get('occurrence_at');
  const occurrence_at = typeof occRaw === 'string' && occRaw ? occRaw : undefined;
  const noteRaw = form.get('note');
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 500) : null;
  if (text.length > MAX_TEXT) throw new HttpError(413, 'text is too long');

  let source: Source;
  let file: File | null = null;
  if (photo instanceof File) {
    if (photo.size > MAX_PHOTO) throw new HttpError(413, 'photo is too large (max 8 MB)');
    if (!(photo.type || 'image/jpeg').startsWith('image/')) throw new HttpError(415, 'photo must be an image');
    source = 'photo';
    file = photo;
  } else if (audio instanceof File) {
    if (audio.size > MAX_AUDIO) throw new HttpError(413, 'audio is too large (max 10 MB)');
    source = 'voice';
    file = audio;
  } else if (text) {
    source = 'text';
  } else {
    throw new HttpError(400, 'send a photo, audio or text');
  }

  let mediaKey: string | null = null;
  if (file) {
    const mime = (file.type || (source === 'photo' ? 'image/jpeg' : 'audio/mp4')).split(';')[0]!;
    mediaKey = `media/${user.id}/${newId()}.${EXT[mime] ?? 'bin'}`;
    await c.env.MEDIA.put(mediaKey, await file.arrayBuffer(), { httpMetadata: { contentType: mime } });
  }

  // A batch being cooked: the items become a recipe, not a meal (see saveBatchAsRecipe).
  const recipe = await parseRecipeField(c.env.DB, user.id, form.get('recipe'));
  // append_to: from a meal's "Add item"; merge: from the main button (breakfast/lunch/dinner join the day's meal).
  const merge = recipe ? null : parseMergeSpec(form.get('append_to'), form.get('merge'));
  // Adding to a specific meal: the draft takes that meal's type and time, so progress and
  // any questions are shown for the right meal and day.
  const into = merge?.mode === 'into' ? await assertAppendable(c.env.DB, user.id, merge.id) : null;
  const state: JobState = {
    job: { meal_explicit: !!(meal_type || into || recipe), hint: source === 'photo' && text ? text : null, merge, ...(recipe ? { recipe } : {}) },
  };
  const id = await createIntake(
    c.env,
    user,
    {
      source,
      status: 'preparation',
      meal_type: into?.meal_type ?? meal_type,
      occurrence_at: into?.occurrence_at ?? occurrence_at,
      note,
      raw_input_text: source === 'text' ? text : null,
      media_r2_key: mediaKey,
      pending_json: JSON.stringify(state),
    },
    [],
  );
  await enqueue(c.env, { intakeId: id, userId: user.id }, waitUntil(c));
  return c.json(await currentView(c.env.DB, user.id, id), 202);
}

/** `recipe` form field: JSON {name, servings, yield_grams?}. Checked now so a bad name fails before the AI runs. */
async function parseRecipeField(db: D1Database, userId: string, raw: unknown) {
  if (typeof raw !== 'string' || !raw) return null;
  let r: { name?: unknown; servings?: unknown; yield_grams?: unknown };
  try {
    r = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'recipe must be JSON');
  }
  const input = { name: r.name as string, servings: r.servings as number, yield_grams: (r.yield_grams as number | null | undefined) ?? null };
  validateRecipe(input);
  await assertRecipeNameFree(db, userId, input.name.trim());
  return { ...input, name: input.name.trim() };
}

/** The entry, or the meal it was already merged into (when the job ran inline). */
async function currentView(db: D1Database, userId: string, id: string) {
  const v = await getIntake(db, userId, id);
  if (v) return v;
  const to = await mergedInto(db, userId, id);
  const target = to && (await getIntake(db, userId, to));
  return target ? { ...target, merged_from: id } : null;
}

/** The request's waitUntil, when running inside a real request context. */
function waitUntil(c: Context<AppEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}

/** POST /api/intake/:id/retry -> run the AI step again for a meal whose processing failed. */
export async function retry(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const row = await c.env.DB.prepare('SELECT status, pending_json FROM nutrition_intake WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ status: string; pending_json: string | null }>();
  if (!row) throw new HttpError(404, 'intake not found');
  if (row.status !== 'preparation') throw new HttpError(409, 'this meal is not waiting on the AI');
  const state = (row.pending_json ? JSON.parse(row.pending_json) : { job: { meal_explicit: false, hint: null } }) as JobState;
  const { error: _drop, ...rest } = state;
  await c.env.DB.prepare('UPDATE nutrition_intake SET pending_json = ? WHERE id = ?').bind(JSON.stringify(rest), id).run();
  await enqueue(c.env, { intakeId: id, userId: user.id }, waitUntil(c));
  return c.json(await currentView(c.env.DB, user.id, id), 202);
}

/** POST /api/intake/:id/answers  { answers: { q1: "1 tbsp oil" } }  — unanswered questions take the default. */
export async function answer(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const body = await c.req.json<{ answers?: Record<string, string> }>();
  const id = await applyAnswers(c.env, user, c.req.param('id')!, body.answers ?? {});
  return c.json(await getIntake(c.env.DB, user.id, id));
}

/** GET /api/intake/:id/media -> the meal's photo or clip, only to its owner. */
export async function media(c: Context<AppEnv>): Promise<Response> {
  const row = await c.env.DB.prepare('SELECT media_r2_key FROM nutrition_intake WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.get('user').id)
    .first<{ media_r2_key: string | null }>();
  if (!row?.media_r2_key) throw new HttpError(404, 'no media');
  const obj = await c.env.MEDIA.get(row.media_r2_key);
  if (!obj) throw new HttpError(404, 'no media');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
