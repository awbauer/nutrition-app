/** AI logging routes: photo / voice / text intake (processed in the background), clarifying answers, media access. */
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { HttpError, newId } from '../lib/ids';
import { MAX_PHOTOS } from '../lib/ai';
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

const mimeOf = (file: File, fallback: string) => (file.type || fallback).split(';')[0]!.trim().toLowerCase();

/**
 * POST /api/intake with multipart form: one or more `photo` fields (up to MAX_PHOTOS, read together as one meal),
 * or audio, or text; plus meal_type?, occurrence_at?, note?. With photos, text is a hint for the model.
 * Saves the meal right away as `preparation` (202) and hands the AI work to a background job.
 */
export async function createFromMedia(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const form = await c.req.formData();
  const photos = form.getAll('photo').filter((p): p is File => p instanceof File);
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
  let clip: File | null = null;
  if (photos.length) {
    if (photos.length > MAX_PHOTOS) throw new HttpError(413, `up to ${MAX_PHOTOS} photos per meal`);
    for (const p of photos) {
      if (p.size > MAX_PHOTO) throw new HttpError(413, 'photo is too large (max 8 MB)');
      // Only the formats we store and serve back: an SVG (also image/*) can carry script.
      const mime = mimeOf(p, 'image/jpeg');
      if (!mime.startsWith('image/') || !EXT[mime]) throw new HttpError(415, 'photo must be a JPEG, PNG, WebP or HEIC image');
    }
    source = 'photo';
  } else if (audio instanceof File) {
    if (audio.size > MAX_AUDIO) throw new HttpError(413, 'audio is too large (max 10 MB)');
    const mime = mimeOf(audio, 'audio/mp4');
    if (!mime.startsWith('audio/') || !EXT[mime]) throw new HttpError(415, 'unsupported audio format');
    source = 'voice';
    clip = audio;
  } else if (text) {
    source = 'text';
  } else {
    throw new HttpError(400, 'send a photo, audio or text');
  }

  const store = async (file: File, fallbackMime: string) => {
    const mime = mimeOf(file, fallbackMime);
    const key = `media/${user.id}/${newId()}.${EXT[mime] ?? 'bin'}`;
    await c.env.MEDIA.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mime } });
    return key;
  };
  const photoKeys = await Promise.all(photos.map((p) => store(p, 'image/jpeg')));
  const mediaKey = clip ? await store(clip, 'audio/mp4') : null;

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
      photo_keys: photoKeys,
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
  // Only a failed job: retrying one still running would run the AI twice on the same meal.
  if (!state.error) throw new HttpError(409, 'this meal is still being read');
  const { error: _drop, ...rest } = state;
  await c.env.DB.prepare(`UPDATE nutrition_intake SET pending_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`)
    .bind(JSON.stringify(rest), id, user.id)
    .run();
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

/** GET /api/intake/:id/media -> the meal's voice clip, or its first photo (older clients), only to its owner. */
export async function media(c: Context<AppEnv>): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(i.media_r2_key, (SELECT r2_key FROM intake_photo p WHERE p.intake_id = i.id ORDER BY position LIMIT 1)) AS r2_key
     FROM nutrition_intake i WHERE i.id = ? AND i.user_id = ?`,
  )
    .bind(c.req.param('id'), c.get('user').id)
    .first<{ r2_key: string | null }>();
  return serve(c, row?.r2_key);
}

/** GET /api/intake/:id/photos/:n -> the meal's n-th photo (0-based), only to its owner. */
export async function photo(c: Context<AppEnv>): Promise<Response> {
  const n = Number(c.req.param('n'));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(404, 'no such photo');
  const row = await c.env.DB.prepare(
    `SELECT p.r2_key FROM intake_photo p JOIN nutrition_intake i ON i.id = p.intake_id
     WHERE p.intake_id = ? AND i.user_id = ? ORDER BY p.position LIMIT 1 OFFSET ?`,
  )
    .bind(c.req.param('id'), c.get('user').id, n)
    .first<{ r2_key: string }>();
  return serve(c, row?.r2_key);
}

async function serve(c: Context<AppEnv>, key: string | null | undefined): Promise<Response> {
  const obj = key ? await c.env.MEDIA.get(key) : null;
  if (!obj) throw new HttpError(404, 'no media');
  const type = obj.httpMetadata?.contentType ?? '';
  return new Response(obj.body, {
    headers: {
      // Never a type outside the allowlist (older uploads kept whatever the client sent), and never sniffed.
      'Content-Type': EXT[type] ? type : 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
