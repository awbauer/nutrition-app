import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import { mcpApiHandler } from './mcp';
import type { Env } from './env';
import { consume, failStaleJobs, type JobMessage } from './lib/jobs';
import { runDueReports } from './lib/coach';
import { refreshHistory } from './lib/history';
import { dispatchReminders } from './lib/reminders';

/** Must match max_retries on the queue consumer in wrangler.jsonc. */
const JOB_MAX_RETRIES = 2;

/**
 * OAuth 2.1 for the MCP server at /mcp. Tokens are checked here; everything else (the app, /api,
 * /authorize) goes to the Hono app. The resource URL is this Worker's own origin, taken from the
 * request so the hostname isn't committed. Built once per origin.
 */
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler,
      defaultHandler: { fetch: (req, env, ctx) => app.fetch(req, env, ctx) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['clem', 'offline_access'],
      requiredScopes: ['clem'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Clem' },
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    await consume(batch, env, JOB_MAX_RETRIES);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      dispatchReminders(env, new Date(controller.scheduledTime)).then((r) => {
        if (r.sent || r.skipped || r.removed) console.log('reminders', r);
      }),
    );
    // Meals whose AI job died without recording an error get one, so the app offers "Try again".
    ctx.waitUntil(
      failStaleJobs(env, new Date(controller.scheduledTime)).then(
        (n) => n && console.log('stale intake jobs failed', n),
        (e) => console.error('stale intake jobs check failed', e),
      ),
    );
    // Daily insights: each user's report for the day that just ended (after their day cutoff, 04:00 by default).
    ctx.waitUntil(
      runDueReports(env, new Date(controller.scheduledTime)).then(
        (r) => (r.written || r.failed) && console.log('coach reports', r),
        (e) => console.error('coach reports failed', e),
      ),
    );
    // Keeps the "foods you've eaten" index current, and backfills it the first time.
    ctx.waitUntil(
      refreshHistory(env).then(
        (r) => (r.embedded || r.removed) && console.log('history', r),
        (e) => console.warn('history refresh failed', (e as Error).message),
      ),
    );
  },
} satisfies ExportedHandler<Env, JobMessage>;
