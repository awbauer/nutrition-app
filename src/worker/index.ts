import { app } from './app';
import type { Env } from './env';
import { consume, type JobMessage } from './lib/jobs';
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
  },
} satisfies ExportedHandler<Env, JobMessage>;
