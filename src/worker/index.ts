import { app } from './app';
import type { Env } from './env';
import { consume, type JobMessage } from './lib/jobs';
import { runDueReports } from './lib/coach';
import { refreshHistory } from './lib/history';
import { dispatchReminders } from './lib/reminders';

/** Must match max_retries on the queue consumer in wrangler.jsonc. */
const JOB_MAX_RETRIES = 2;

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    await consume(batch, env, JOB_MAX_RETRIES);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      dispatchReminders(env, new Date(controller.scheduledTime)).then((r) => {
        if (r.sent || r.skipped || r.removed) console.log('reminders', r);
      }),
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
