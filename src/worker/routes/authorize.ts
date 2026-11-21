/**
 * OAuth /authorize for the MCP server: Cloudflare Access (in front of this path) signs the user in;
 * this page asks whether the app may use their Clem log, then completes the grant.
 * See https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { upsertUser, verifyAccess } from '../auth';
import type { AppEnv } from '../env';
import type { McpProps } from '../mcp';

export const authorize = new Hono<AppEnv>();

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const SCOPE_TEXT: Record<string, string> = {
  clem: 'Read and change your food log, foods, targets, weight and coach reports',
  offline_access: 'Stay connected without asking again',
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --paper:#f6f1e7; --card:#fffdf8; --ink:#1e211d; --ink2:#555b52; --line:#e4dccb; --accent:#d9560b; }
  @media (prefers-color-scheme: dark) { :root { --paper:#121411; --card:#1b1e1a; --ink:#efe9dd; --ink2:#b2b2a6; --line:#2e322b; --accent:#f57c2a; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--paper); color:var(--ink); font:16px/1.5 -apple-system, system-ui, sans-serif; padding:16px; box-sizing:border-box }
  main { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:28px; max-width:26rem; width:100% }
  h1 { font:600 1.5rem/1.2 Georgia, serif; margin:.75rem 0 .5rem }
  p { color:var(--ink2); margin:.5rem 0 }
  strong { color:var(--ink) }
  label { display:flex; gap:.6rem; align-items:flex-start; padding:.4rem 0; color:var(--ink) }
  .warn { background:#f5e9c8; color:#5a4200; border-radius:12px; padding:.6rem .8rem }
  .row { display:flex; gap:.75rem; margin-top:1.25rem }
  button { flex:1; font:600 1rem system-ui; border-radius:999px; padding:.75rem 1rem; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer }
  button.allow { background:var(--accent); border-color:var(--accent); color:#fff }
</style></head><body><main>
<svg width="40" height="40" viewBox="96 56 312 340" aria-hidden="true"><circle cx="236" cy="262" r="128" fill="#f08a24"/><path d="M258 108 C 290 62, 362 52, 392 78 C 370 122, 302 140, 258 108 Z" fill="#3f9e5a"/><path d="M254 110 C 222 72, 170 70, 150 92 C 172 124, 222 132, 254 110 Z" fill="#2f8a4d"/></svg>
${body}</main></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string, email: string | null): string {
  const name = escape(d.clientName);
  const who = d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : 'This app registered itself, so its name isn’t verified.';
  const scopes = (d.scope.length ? d.scope : ['clem'])
    .map((s) => `<label><input type="checkbox" name="scope" value="${escape(s)}" checked> <span>${escape(SCOPE_TEXT[s] ?? s)}</span></label>`)
    .join('');
  return page(
    `Allow ${name} to use Clem?`,
    `<h1>Allow ${name} to use your Clem log?</h1>
<p>${who} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
${email ? `<p>Signed in as <strong>${escape(email)}</strong>.</p>` : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  ${scopes}
  <div class="row"><button name="decision" value="deny">Deny</button><button class="allow" name="decision" value="approve">Allow</button></div>
</form>`,
  );
}

const html = (body: string, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { ...init, headers });
};

/** Who is signed in (Cloudflare Access protects /authorize), or a page saying they aren't. */
async function signedIn(c: { req: { raw: Request }; env: AppEnv['Bindings'] }) {
  try {
    const id = await verifyAccess(c.req.raw, c.env);
    return await upsertUser(c.env.DB, id.sub, id.email);
  } catch {
    return null;
  }
}

function errorPage(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
    const msg = e instanceof AuthorizationError ? e.description : 'This app could not be verified.';
    return html(page('Can’t connect', `<h1>Can’t connect</h1><p>${escape(msg ?? 'The request was not valid.')}</p><p>Start connecting again from the app.</p>`), { status: 400 });
  }
  throw e;
}

authorize.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  const user = await signedIn(c);
  if (!user) return html(page('Sign in first', '<h1>Sign in to Clem first</h1><p>Open Clem, sign in, then start connecting again.</p>'), { status: 401 });
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    return html(consentPage(details, consent.handle, user.email), { headers: consent.headers });
  } catch (e) {
    return errorPage(e);
  }
});

authorize.post('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!;
  const user = await signedIn(c);
  if (!user) return html(page('Sign in first', '<h1>Sign in to Clem first</h1>'), { status: 401 });
  try {
    const form = await c.req.raw.clone().formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const scope = form.getAll('scope').map(String);
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: scope.length ? scope : ['clem'] });
    const props: McpProps = { userId: user.id };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user.id,
      metadata: {},
      scope: approved.request.scope,
      props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return errorPage(e);
  }
});
