import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppEnv, Env, User } from './env';
import { newId } from './lib/ids';

const jwksCache = new Map<string, JWTVerifyGetKey>();

function teamOrigin(domain: string): string {
  const host = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host.includes('.') ? host : `${host}.cloudflareaccess.com`}`;
}

/** Validate the Cloudflare Access JWT and return {sub, email}. Throws on failure. */
export async function verifyAccess(req: Request, env: Env): Promise<{ sub: string; email: string | null }> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    if (env.DEV_AUTH === '1') {
      const email = env.DEV_USER_EMAIL || 'dev@example.test';
      return { sub: `dev:${email}`, email };
    }
    throw new Error('Access is not configured');
  }
  const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(req, 'CF_Authorization');
  if (!token) throw new Error('missing Access token');
  const issuer = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
  if (!payload.sub) throw new Error('token has no sub');
  return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie') ?? '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export async function upsertUser(db: D1Database, sub: string, email: string | null): Promise<User> {
  const existing = await db.prepare('SELECT id, access_sub, email, timezone FROM users WHERE access_sub = ?').bind(sub).first<User>();
  if (existing) {
    if (email && existing.email !== email) {
      await db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, existing.id).run();
      existing.email = email;
    }
    return existing;
  }
  const id = newId();
  await db.prepare('INSERT INTO users (id, access_sub, email) VALUES (?, ?, ?) ON CONFLICT (access_sub) DO NOTHING').bind(id, sub, email).run();
  return (await db.prepare('SELECT id, access_sub, email, timezone FROM users WHERE access_sub = ?').bind(sub).first<User>())!;
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  // MCP tool calls: the OAuth layer has already identified the user (see mcp.ts).
  if (c.env.MCP_USER) {
    c.set('user', c.env.MCP_USER);
    return next();
  }
  let identity;
  try {
    identity = await verifyAccess(c.req.raw, c.env);
  } catch (e) {
    return c.json({ error: 'unauthorized', detail: (e as Error).message }, 401);
  }
  c.set('user', await upsertUser(c.env.DB, identity.sub, identity.email));
  await next();
});
