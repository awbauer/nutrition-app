/** AI logging routes: photo / voice / text intake, clarifying answers, media access. */
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { parsePhoto, parseText, transcribe, type ModelOutput } from '../lib/ai';
import { localParts } from '../lib/dates';
import { HttpError, newId } from '../lib/ids';
import { getIntake, MEAL_TYPES, type MealType, type Source } from '../lib/intake';
import { applyAnswers, buildPending, saveDraft } from '../lib/pipeline';
import { getSettings } from '../lib/settings';

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

/** POST /api/intake with multipart form: one of photo | audio | text, plus meal_type?, occurrence_at?, note?. */
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

  const settings = await getSettings(c.env.DB, user.id);
  const at = occurrence_at ? new Date(occurrence_at) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'occurrence_at is not a valid date');
  const lp = localParts(at, user.timezone);
  const localTime = `${lp.date} ${lp.time} (${user.timezone})`;

  let source: Source;
  let out: ModelOutput;
  let model: string;
  let mediaKey: string | null = null;
  let rawText: string | null = text || null;

  try {
    if (photo instanceof File) {
      if (photo.size > MAX_PHOTO) throw new HttpError(413, 'photo is too large (max 8 MB)');
      const mime = photo.type || 'image/jpeg';
      if (!mime.startsWith('image/')) throw new HttpError(415, 'photo must be an image');
      const bytes = new Uint8Array(await photo.arrayBuffer());
      mediaKey = `media/${user.id}/${newId()}.${EXT[mime] ?? 'bin'}`;
      await c.env.MEDIA.put(mediaKey, bytes, { httpMetadata: { contentType: mime } });
      source = 'photo';
      model = settings.model_vision;
      out = await parsePhoto(c.env, model, bytes, mime, localTime, text || undefined);
    } else if (audio instanceof File) {
      if (audio.size > MAX_AUDIO) throw new HttpError(413, 'audio is too large (max 10 MB)');
      const mime = (audio.type || 'audio/mp4').split(';')[0]!;
      const bytes = new Uint8Array(await audio.arrayBuffer());
      mediaKey = `media/${user.id}/${newId()}.${EXT[mime] ?? 'bin'}`;
      await c.env.MEDIA.put(mediaKey, bytes, { httpMetadata: { contentType: mime } });
      source = 'voice';
      rawText = await transcribe(c.env, settings.model_speech, bytes);
      if (!rawText) throw new HttpError(422, "couldn't hear any speech in that clip");
      model = settings.model_parser;
      out = await parseText(c.env, model, rawText, localTime);
    } else if (text) {
      if (text.length > MAX_TEXT) throw new HttpError(413, 'text is too long');
      source = 'text';
      model = settings.model_parser;
      out = await parseText(c.env, model, text, localTime);
    } else {
      throw new HttpError(400, 'send a photo, audio or text');
    }
    if (!out.items.length) throw new HttpError(422, "couldn't find any food in that");

    const pending = await buildPending(c.env, user, out, settings, source === 'photo' ? 'photo-estimate' : 'described');
    const id = await saveDraft(c.env, user, { source, meal_type, occurrence_at, note, raw_input_text: rawText, media_r2_key: mediaKey, model_id: model }, out, pending);
    return c.json(await getIntake(c.env.DB, user.id, id), 201);
  } catch (e) {
    if (mediaKey) await c.env.MEDIA.delete(mediaKey).catch(() => {});
    if (e instanceof HttpError) throw e;
    console.error('AI intake failed', e);
    throw new HttpError(502, `couldn't read that meal: ${(e as Error).message}`);
  }
}

/** POST /api/intake/:id/answers  { answers: { q1: "1 tbsp oil" } }  — unanswered questions take the default. */
export async function answer(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const body = await c.req.json<{ answers?: Record<string, string> }>();
  await applyAnswers(c.env, user, c.req.param('id')!, body.answers ?? {});
  return c.json(await getIntake(c.env.DB, user.id, c.req.param('id')!));
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
