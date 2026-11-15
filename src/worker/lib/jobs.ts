/**
 * Background AI processing. POST /api/intake saves the meal as `preparation` and returns at once;
 * this job (run from a Cloudflare Queue, or waitUntil as a fallback) reads the media, calls the
 * models, matches foods and fills the meal in.
 */
import type { Env, User } from '../env';
import { parsePhoto, parseText, transcribe, type ModelOutput } from './ai';
import { localParts } from './dates';
import { HttpError } from './ids';
import type { MealType } from './intake';
import { mergeDraft, resolveTarget, type MergeSpec } from './merge';
import { buildPending, finishDraft } from './pipeline';
import { getSettings } from './settings';

export interface JobMessage {
  intakeId: string;
  userId: string;
}

/** Stored in pending_json while the meal is in `preparation`. */
export interface JobState {
  job: { meal_explicit: boolean; hint: string | null; merge?: MergeSpec | null };
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

    if (row.source === 'photo' || row.source === 'voice') {
      const obj = row.media_r2_key ? await env.MEDIA.get(row.media_r2_key) : null;
      if (!obj) throw new HttpError(410, 'the uploaded media is missing');
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (row.source === 'photo') {
        model = settings.model_vision;
        out = await parsePhoto(env, model, bytes, obj.httpMetadata?.contentType ?? 'image/jpeg', localTime, state.job.hint ?? undefined);
      } else {
        rawText = await transcribe(env, settings.model_speech, bytes);
        if (!rawText) throw new HttpError(422, "couldn't hear any speech in that clip");
        model = settings.model_parser;
        out = await parseText(env, model, rawText, localTime);
      }
    } else {
      if (!rawText) throw new HttpError(400, 'nothing to read');
      model = settings.model_parser;
      out = await parseText(env, model, rawText, localTime);
    }
    if (!out.items.length) throw new HttpError(422, "couldn't find any food in that");

    const pending = await buildPending(env, user, out, settings, row.source === 'photo' ? 'photo-estimate' : 'described');
    const mealGuess: MealType | undefined = state.job.meal_explicit ? undefined : (out.meal_type_guess ?? undefined);
    pending.merge = state.job.merge ?? null;
    await finishDraft(env, user, msg.intakeId, { model_id: model, raw_input_text: rawText, meal_type: mealGuess }, pending);
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
      const message = e instanceof HttpError ? e.message : `couldn't read that meal (${(e as Error).message})`;
      await env.DB.prepare(`UPDATE nutrition_intake SET pending_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'preparation'`)
        .bind(JSON.stringify({ ...state, error: message, attempts: (state.attempts ?? 0) + 1 } satisfies JobState), msg.intakeId)
        .run();
      if (permanent) return 'done';
    }
    throw e;
  }
}

/** Queue consumer: one message per meal; retried by the queue, error recorded on the last attempt. */
export async function consume(batch: MessageBatch<JobMessage>, env: Env, maxRetries: number): Promise<void> {
  await Promise.all(
    batch.messages.map(async (m) => {
      try {
        await processIntake(env, m.body, m.attempts > maxRetries);
        m.ack();
      } catch (e) {
        console.error('intake job error', m.body.intakeId, e);
        if (m.attempts > maxRetries) m.ack();
        else m.retry({ delaySeconds: 5 * m.attempts });
      }
    }),
  );
}
