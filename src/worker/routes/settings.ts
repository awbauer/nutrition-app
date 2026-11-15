import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { isValidTimeZone } from '../lib/dates';
import { HttpError } from '../lib/ids';
import { getSettings, putSettings } from '../lib/settings';

export const settings = new Hono<AppEnv>();

settings.get('/me', async (c) => {
  const user = c.get('user');
  return c.json({ id: user.id, email: user.email, timezone: user.timezone, settings: await getSettings(c.env.DB, user.id) });
});

settings.get('/settings', async (c) => {
  const user = c.get('user');
  return c.json({ timezone: user.timezone, ...(await getSettings(c.env.DB, user.id)) });
});

/** PUT /api/settings -> partial update; `timezone` updates the user row. */
settings.put('/settings', async (c) => {
  const user = c.get('user');
  const { timezone, ...rest } = await c.req.json<Record<string, unknown>>();
  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) throw new HttpError(400, 'invalid timezone');
    await c.env.DB.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind(timezone, user.id).run();
    user.timezone = timezone;
  }
  const rejected = await putSettings(c.env.DB, user.id, rest);
  if (rejected.length) throw new HttpError(400, `invalid settings: ${rejected.join(', ')}`);
  return c.json({ timezone: user.timezone, ...(await getSettings(c.env.DB, user.id)) });
});
