import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import { dispatchReminders, dueOn } from '../src/worker/lib/reminders';
import { b64urlDecode, b64urlEncode, encryptPayload, vapidAuthorization } from '../src/worker/lib/webpush';
import { api } from './helpers';

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/** Browser-side decryption per RFC 8291, to prove the server output is readable. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as never, ua.privateKey, 256));
  const ikm = await hkdf(auth, secret, new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function makeSubscriber() {
  const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64urlEncode((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer);
  return { ua, auth, sub: { p256dh, auth: b64urlEncode(auth) } };
}

async function makeVapid() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = b64urlEncode((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { kp, keys: { publicKey: pub, privateKey: jwk.d!, subject: 'mailto:test@example.test' } };
}

describe('web push crypto', () => {
  it('encrypts payloads a browser can decrypt (RFC 8291)', async () => {
    const s = await makeSubscriber();
    const body = await encryptPayload(s.sub, enc.encode('{"title":"hi"}'));
    expect(await decrypt(body, s.ua, s.auth)).toBe('{"title":"hi"}');
  });

  it('signs a valid VAPID JWT', async () => {
    const v = await makeVapid();
    const header = await vapidAuthorization('https://web.push.apple.com/abc', v.keys);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(v.keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2]!)));
    expect(claims).toMatchObject({ aud: 'https://web.push.apple.com', sub: 'mailto:test@example.test' });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.kp.publicKey, b64urlDecode(m[3]!), enc.encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });
});

describe('reminder timing', () => {
  const r = { local_time: '12:30', days_of_week: '12345', enabled: 1, last_sent_on: null };
  it('fires within the grace window on matching weekdays in the user zone', () => {
    // Mon 16 Nov 2026 12:40 in Chicago = 18:40Z
    expect(dueOn(r, new Date('2026-11-16T18:40:00Z'), 'America/Chicago')).toBe('2026-11-16');
    expect(dueOn(r, new Date('2026-11-16T18:20:00Z'), 'America/Chicago')).toBeNull(); // too early
    expect(dueOn(r, new Date('2026-11-16T19:45:00Z'), 'America/Chicago')).toBeNull(); // past grace
    expect(dueOn(r, new Date('2026-11-15T18:40:00Z'), 'America/Chicago')).toBeNull(); // Sunday
    expect(dueOn({ ...r, last_sent_on: '2026-11-16' }, new Date('2026-11-16T18:40:00Z'), 'America/Chicago')).toBeNull();
    expect(dueOn({ ...r, enabled: 0 }, new Date('2026-11-16T18:40:00Z'), 'America/Chicago')).toBeNull();
  });
});

describe('reminders API and dispatch', () => {
  it('manages reminders, sends due pushes once, skips logged meals and prunes dead subscriptions', async () => {
    const U = { DEV_USER_EMAIL: 'push@example.test' };
    const v = await makeVapid();
    const E: Partial<Env> = { ...U, VAPID_PUBLIC_KEY: v.keys.publicKey, VAPID_PRIVATE_KEY: v.keys.privateKey, VAPID_SUBJECT: v.keys.subject };
    await api('/settings', { method: 'PUT', json: { timezone: 'UTC', day_cutoff: '04:00' } }, E);

    expect((await api('/push/key', {}, E)).data.publicKey).toBe(v.keys.publicKey);
    expect((await api('/push/key', {}, U)).status).toBe(503);

    const s1 = await makeSubscriber();
    const s2 = await makeSubscriber();
    const sub = (endpoint: string, s: typeof s1) => api('/push/subscribe', { method: 'POST', json: { endpoint, keys: s.sub } }, E);
    expect((await sub('https://push.example.test/live', s1)).status).toBe(201);
    expect((await sub('https://push.example.test/gone', s2)).status).toBe(201);
    expect((await api('/push/subscribe', { method: 'POST', json: { endpoint: 'http://x', keys: s1.sub } }, E)).status).toBe(400);

    const bad = await api('/reminders', { method: 'PUT', json: [{ label: 'x', local_time: '25:00' }] }, E);
    expect(bad.status).toBe(400);
    const list = await api(
      '/reminders',
      {
        method: 'PUT',
        json: [
          { label: 'Lunch', meal_type: 'lunch', local_time: '12:30' },
          { label: 'Breakfast', meal_type: 'breakfast', local_time: '08:00' },
          { label: 'Wrap up the day', kind: 'end-of-day', local_time: '21:00', days_of_week: '6543210' },
        ],
      },
      E,
    );
    expect(list.data.map((r: any) => r.label)).toEqual(['Breakfast', 'Lunch', 'Wrap up the day']);
    expect(list.data[2].days_of_week).toBe('0123456');

    // Breakfast already logged today -> skipped; lunch -> sent.
    const food = await api('/foods', { method: 'POST', json: { name: 'Oats', per_100g: { ENERC_KCAL: 380, PROCNT: 13 } } }, E);
    await api(
      '/intake',
      { method: 'POST', json: { meal_type: 'breakfast', occurrence_at: '2026-11-16T07:30:00Z', items: [{ food_id: food.data.id, amount: 100, unit: 'g' }] } },
      E,
    );
    await api('/goals', { method: 'PUT', json: { energy: 2000, protein: 120 } }, E);
    // Goals start on the real "today"; the reminders below run on 16 Nov 2026, so start them before that.
    await (env as unknown as Env).DB.prepare(`UPDATE goal SET start_date = '2026-11-01' WHERE user_id = (SELECT id FROM users WHERE email = ?)`).bind(E.DEV_USER_EMAIL).run();

    const sent: { endpoint: string; body: string }[] = [];
    const fakeSend = async (s: { endpoint: string; p256dh: string; auth: string }, msg: unknown) => {
      sent.push({ endpoint: s.endpoint, body: JSON.stringify(msg) });
      return s.endpoint.endsWith('/gone') ? 410 : 201;
    };
    const runEnv = { ...(env as unknown as Env), ...E } as Env;

    const breakfast = await dispatchReminders(runEnv, new Date('2026-11-16T08:05:00Z'), fakeSend);
    expect(breakfast).toEqual({ sent: 0, skipped: 1, removed: 0 });

    const lunch = await dispatchReminders(runEnv, new Date('2026-11-16T12:35:00Z'), fakeSend);
    expect(lunch).toEqual({ sent: 1, skipped: 0, removed: 1 });
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ title: 'Lunch', url: '/#today' });

    const again = await dispatchReminders(runEnv, new Date('2026-11-16T12:50:00Z'), fakeSend);
    expect(again.sent).toBe(0);

    sent.length = 0;
    await dispatchReminders(runEnv, new Date('2026-11-16T21:00:00Z'), fakeSend);
    expect(JSON.parse(sent[0]!.body).body).toBe('You have 1,620 kcal and 107 g protein left.');

    // A push that fails doesn't use up the reminder: the next tick, within the grace period, sends it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = async () => {
      throw new Error('push service down');
    };
    expect((await dispatchReminders(runEnv, new Date('2026-11-17T12:35:00Z'), down)).sent).toBe(0);
    sent.length = 0;
    expect((await dispatchReminders(runEnv, new Date('2026-11-17T12:50:00Z'), fakeSend)).sent).toBe(1);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ title: 'Lunch' });
    warn.mockRestore();
  });
});
