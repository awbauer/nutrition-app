/**
 * Background AI processing. POST /api/intake saves the meal as `preparation` and returns at once;
 * this job (run from a Cloudflare Queue, or waitUntil as a fallback) reads the media, calls the
 * models, matches foods and fills the meal in.
 */
import { refreshHistory } from './history';
import type { Env, User } from '../env';
import { FALLBACK_MODELS, isCapacityError, parsePhotos, parseText, transcribe, withCapacityFallback, type ModelOutput, type PhotoInput } from './ai';
import { localParts } from './dates';
import { HttpError } from './ids';
import type { MealType } from './intake';
import { mergeDraft, resolveTarget, type MergeSpec } from './merge';
import { buildPending, finishDraft, materialise } from './pipeline';
import { listFavorites } from './favorites';
import { recipeNames, saveRecipe } from './recipes';
import { getSettings, type Settings } from './settings';

export interface JobMessage {
  intakeId: string;
  userId: string;
}

/** Stored in pending_json while the meal is in `preparation`. */
export interface JobState {
  job: {
    meal_explicit: boolean;
    hint: string | null;
    merge?: MergeSpec | null;
    /** The input is a batch being cooked: save the items as this recipe instead of logging them. */
    recipe?: { name: string; servings: number; yield_grams?: number | null };
  };
  error?: string;
  attempts?: number;
}

export async function enqueue(env: Env, msg: JobMessage, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
  if (env.JOBS) {
    await env.JOBS.send(msg);
    return;
  }
  // No queue bound (e.g. a dev setup without queues): run in the background of this request.
  const p = processIntake(env, msg, true).catch((e) => console.error('intake job failed', e));
  if (waitUntil) waitUntil(p);
  else await p;
}

/**
 * Process one queued meal. Idempotent: does nothing unless the meal is still in `preparation`
 * without a recorded error. On failure records the error when `final` (no more retries) and rethrows.
 */
export async function processIntake(env: Env, msg: JobMessage, final: boolean): Promise<'done' | 'skipped'> {
  const row = await env.DB.prepare(
    `SELECT i.status, i.source, i.occurrence_at, i.media_r2_key, i.raw_input_text, i.pending_json, u.id AS uid, u.access_sub, u.email, u.timezone
     FROM nutrition_intake i JOIN users u ON u.id = i.user_id WHERE i.id = ? AND i.user_id = ?`,
  )
    .bind(msg.intakeId, msg.userId)
    .first<{
      status: string;
      source: string;
      occurrence_at: string;
      media_r2_key: string | null;
      raw_input_text: string | null;
      pending_json: string | null;
      uid: string;
      access_sub: string;
      email: string | null;
      timezone: string;
    }>();
  if (!row || row.status !== 'preparation') return 'skipped';
  const state: JobState = row.pending_json ? JSON.parse(row.pending_json) : { job: { meal_explicit: false, hint: null } };
  if (state.error) return 'skipped';
  const user: User = { id: row.uid, access_sub: row.access_sub, email: row.email, timezone: row.timezone };

  try {
    const settings = await getSettings(env.DB, user.id);
    const lp = localParts(new Date(row.occurrence_at), user.timezone);
    const localTime = `${lp.date} ${lp.time} (${user.timezone})`;
    let out: ModelOutput;
    let model: string;
    let rawText = row.raw_input_text;
    const [recipes, favorites] = await Promise.all([recipeNames(env.DB, user.id), listFavorites(env.DB, user.id)]);
    const ctx = { recipes, batch: !!state.job.recipe, favorites: favorites.map((f) => ({ name: f.name, portion: `${f.amount} ${f.unit}, ${f.grams} g` })) };

    if (row.source === 'photo') {
      const photos = await loadPhotos(env, msg.intakeId);
      if (!photos.length) throw new HttpError(410, 'the uploaded photos are missing');
      ({ out, model } = await withCapacityFallback(settings.model_vision, FALLBACK_MODELS.vision, (m) => parsePhotos(env, m, photos, localTime, state.job.hint ?? undefined, ctx)));
    } else if (row.source === 'voice') {
      const obj = row.media_r2_key ? await env.MEDIA.get(row.media_r2_key) : null;
      if (!obj) throw new HttpError(410, 'the uploaded media is missing');
      rawText = await transcribe(env, settings.model_speech, new Uint8Array(await obj.arrayBuffer()));
      if (!rawText) throw new HttpError(422, "couldn't hear any speech in that clip");
      const text = rawText;
      ({ out, model } = await withCapacityFallback(settings.model_parser, FALLBACK_MODELS.parser, (m) => parseText(env, m, text, localTime, ctx)));
    } else {
      if (!rawText) throw new HttpError(400, 'nothing to read');
      const text = rawText;
      ({ out, model } = await withCapacityFallback(settings.model_parser, FALLBACK_MODELS.parser, (m) => parseText(env, m, text, localTime, ctx)));
    }
    if (!out.items.length) throw new HttpError(422, "couldn't find any food in that");

    if (state.job.recipe) {
      await saveBatchAsRecipe(env, user, msg.intakeId, state.job.recipe, out, settings, model, rawText);
      return 'done';
    }

    const pending = await buildPending(env, user, out, settings, row.source === 'photo' ? 'photo-estimate' : 'described');
    const mealGuess: MealType | undefined = state.job.meal_explicit ? undefined : (out.meal_type_guess ?? undefined);
    pending.merge = state.job.merge ?? null;
    // Another run of this job finished first (a redelivered message, or a retry): leave its result alone.
    if (!(await finishDraft(env, user, msg.intakeId, { model_id: model, raw_input_text: rawText, meal_type: mealGuess }, pending))) return 'skipped';
    // No questions: it's complete, so add it to the meal it belongs to now (meal type is final).
    if (!pending.questions.length) {
      const target = await resolveTarget(env, user.id, msg.intakeId, state.job.merge);
      if (target) await mergeDraft(env, user.id, msg.intakeId, target);
    }
    return 'done';
  } catch (e) {
    // Input problems won't fix themselves on retry; record them right away.
    const permanent = e instanceof HttpError && e.status < 500;
    if (final || permanent) {
      const message =
        e instanceof HttpError
          ? e.message
          : isCapacityError(e)
            ? 'the AI service is busy right now, try again in a minute'
            : // An internal exception's text means nothing to the user; it's rethrown below and logged by the caller.
              `couldn't read that ${state.job.recipe ? 'recipe' : 'meal'}, try again`;
      await env.DB.prepare(`UPDATE nutrition_intake SET pending_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'preparation'`)
        .bind(JSON.stringify({ ...state, error: message, attempts: (state.attempts ?? 0) + 1 } satisfies JobState), msg.intakeId)
        .run();
      if (permanent) return 'done';
    }
    throw e;
  }
}

/**
 * A described batch: match the ingredients, save them as the recipe, and retire the entry
 * (nothing was eaten yet). The entry keeps a pointer to the recipe for the client.
 */
async function saveBatchAsRecipe(
  env: Env,
  user: User,
  intakeId: string,
  recipe: NonNullable<JobState['job']['recipe']>,
  out: ModelOutput,
  settings: Settings,
  model: string,
  rawText: string | null,
): Promise<void> {
  const pending = await buildPending(env, user, { ...out, questions: [] }, settings, 'described');
  const items = await materialise(env.DB, user.id, pending, {});
  const saved = await saveRecipe(env, user, {
    ...recipe,
    ingredients: items.map((it) => ({ food_id: it.food.id, amount: it.amount, unit: it.unit, grams: it.grams, display_name: it.display_name })),
  });
  await env.DB.prepare(
    `UPDATE nutrition_intake SET status = 'entered-in-error', pending_json = ?, raw_input_text = ?, model_id = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ? AND status = 'preparation'`,
  )
    .bind(JSON.stringify({ recipe_saved: { id: saved.id, name: saved.name } }), rawText, model, intakeId, user.id)
    .run();
}

/** A meal's photos, in the order they were taken. Any that went missing from storage are skipped. */
async function loadPhotos(env: Env, intakeId: string): Promise<PhotoInput[]> {
  const { results } = await env.DB.prepare('SELECT r2_key FROM intake_photo WHERE intake_id = ? ORDER BY position').bind(intakeId).all<{ r2_key: string }>();
  const objs = await Promise.all(results.map((r) => env.MEDIA.get(r.r2_key)));
  const photos: PhotoInput[] = [];
  for (const obj of objs) if (obj) photos.push({ bytes: new Uint8Array(await obj.arrayBuffer()), mime: obj.httpMetadata?.contentType ?? 'image/jpeg' });
  return photos;
}

/** How long a meal may wait on the AI (queue retries included) before it's shown as failed. */
export const STALE_JOB_MINUTES = 15;

/**
 * Meals still in `preparation` long after they were sent, with no error recorded: the job died before
 * it could record one (worker evicted, last queue attempt lost). Record an error so the app offers
 * "Try again" instead of "Reading" forever. Run from the cron.
 */
export async function failStaleJobs(env: Env, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - STALE_JOB_MINUTES * 60_000).toISOString();
  const r = await env.DB.prepare(
    `UPDATE nutrition_intake SET pending_json = json_set(COALESCE(pending_json, '{"job":{"meal_explicit":false,"hint":null}}'), '$.error', ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'preparation' AND json_extract(COALESCE(pending_json, '{}'), '$.error') IS NULL AND updated_at < ?`,
  )
    .bind('reading this meal took too long, try again', before)
    .run();
  return r.meta.changes ?? 0;
}

/** Queue consumer: one message per meal; retried by the queue, error recorded on the last attempt. */
export async function consume(batch: MessageBatch<JobMessage>, env: Env, maxRetries: number): Promise<void> {
  await Promise.all(
    batch.messages.map(async (m) => {
      try {
        await processIntake(env, m.body, m.attempts > maxRetries);
        m.ack();
        await refreshHistory(env, m.body.userId).catch((e) => console.warn('history refresh failed', (e as Error).message));
      } catch (e) {
        console.error('intake job error', m.body.intakeId, e);
        if (m.attempts > maxRetries) m.ack();
        else m.retry({ delaySeconds: 15 * m.attempts });
      }
    }),
  );
}
