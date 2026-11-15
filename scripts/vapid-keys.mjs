// Generate a VAPID key pair for Web Push. Store both as Worker secrets:
//   node scripts/vapid-keys.mjs
//   npx wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto:you@example.com)
const { subtle } = globalThis.crypto;
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
const jwk = await subtle.exportKey('jwk', kp.privateKey);
const b64url = (u) => Buffer.from(u).toString('base64url');
console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
