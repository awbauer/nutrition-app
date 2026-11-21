import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError, newId } from '../lib/ids';
import { vapidKeys, type ReminderRow } from '../lib/reminders';
import { b64urlDecode, sendPush } from '../lib/webpush';

export const push = new Hono<AppEnv>();

/** GET /api/push/key -> VAPID public key for PushManager.subscribe. */
push.get('/push/key', (c) => {
  const keys = vapidKeys(c.env);
  if (!keys) throw new HttpError(503, 'push is not configured (VAPID keys missing)');
  return c.json({ publicKey: keys.publicKey });
});

/** POST /api/push/subscribe  (body: PushSubscription.toJSON()) */
push.post('/push/subscribe', async (c) => {
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
  const { endpoint } = body;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!endpoint || !/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new HttpError(400, 'invalid subscription');
  try {
    if (b64urlDecode(p256dh).length !== 65 || b64urlDecode(auth).length !== 16) throw new Error();
  } catch {
    throw new HttpError(400, 'invalid subscription keys');
  }
  const user = c.get('user');
  await c.env.DB.prepare(
    `INSERT INTO push_subscription (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(newId(), user.id, endpoint, p256dh, auth)
    .run();
  return c.json({ ok: true }, 201);
});

push.delete('/push/subscribe', async (c) => {
  const { endpoint } = await c.req.json<{ endpoint: string }>();
  await c.env.DB.prepare('DELETE FROM push_subscription WHERE endpoint = ? AND user_id = ?').bind(endpoint, c.get('user').id).run();
  return c.body(null, 204);
});

/** POST /api/push/test -> send a test notification to all of the user's devices. */
push.post('/push/test', async (c) => {
  const keys = vapidKeys(c.env);
  if (!keys) throw new HttpError(503, 'push is not configured');
  const { results } = await c.env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = ?')
    .bind(c.get('user').id)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  if (!results.length) throw new HttpError(404, 'no devices subscribed');
  const statuses = await Promise.all(results.map((s) => sendPush(s, { title: 'Meal reminders are on', body: 'This is what a reminder looks like.', url: '/#today' }, keys)));
  return c.json({ statuses });
});

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

/** GET /api/reminders */
push.get('/reminders', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, label, meal_type, kind, local_time, days_of_week, enabled FROM reminder WHERE user_id = ? ORDER BY local_time')
    .bind(c.get('user').id)
    .all<ReminderRow>();
  return c.json(results.map((r) => ({ ...r, enabled: !!r.enabled })));
});

/** PUT /api/reminders -> replace the user's reminder list. */
push.put('/reminders', async (c) => {
  const user = c.get('user');
  const list = await c.req.json<{ id?: string; label: string; meal_type?: string | null; kind?: string; local_time: string; days_of_week?: string; enabled?: boolean }[]>();
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'expected an array of up to 20 reminders');
  const existing = await c.env.DB.prepare('SELECT id, local_time, last_sent_on FROM reminder WHERE user_id = ?')
    .bind(user.id)
    .all<{ id: string; local_time: string; last_sent_on: string | null }>();
  const prev = new Map(existing.results.map((r) => [r.id, r]));
  const stmts: D1PreparedStatement[] = [c.env.DB.prepare('DELETE FROM reminder WHERE user_id = ?').bind(user.id)];
  for (const r of list) {
    const kind = r.kind ?? 'meal';
    if (kind !== 'meal' && kind !== 'end-of-day') throw new HttpError(400, 'invalid kind');
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 60) throw new HttpError(400, 'label is required');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.local_time)) throw new HttpError(400, 'local_time must be HH:MM');
    const days = r.days_of_week ?? '0123456';
    if (!/^[0-6]{1,7}$/.test(days)) throw new HttpError(400, 'days_of_week must use digits 0-6');
    const meal = r.meal_type ?? null;
    if (meal !== null && !MEALS.includes(meal)) throw new HttpError(400, 'invalid meal_type');
    const old = r.id ? prev.get(r.id) : undefined;
    // Keep the sent marker unless the time moved, so editing a label doesn't re-send today.
    const lastSent = old && old.local_time === r.local_time ? old.last_sent_on : null;
    stmts.push(
      c.env.DB.prepare('INSERT INTO reminder (id, user_id, label, meal_type, kind, local_time, days_of_week, enabled, last_sent_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        old ? r.id : newId(),
        user.id,
        r.label.trim(),
        kind === 'meal' ? meal : null,
        kind,
        r.local_time,
        [...new Set(days)].sort().join(''),
        r.enabled === false ? 0 : 1,
        lastSent,
      ),
    );
  }
  await c.env.DB.batch(stmts);
  const { results } = await c.env.DB.prepare('SELECT id, label, meal_type, kind, local_time, days_of_week, enabled FROM reminder WHERE user_id = ? ORDER BY local_time')
    .bind(user.id)
    .all<ReminderRow>();
  return c.json(results.map((r) => ({ ...r, enabled: !!r.enabled })));
});
